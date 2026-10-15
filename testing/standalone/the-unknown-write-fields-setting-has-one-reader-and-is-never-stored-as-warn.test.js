/**
 * `unknownWriteFields` is read by ONE function, stored only as `'refuse'`, and a stored value that is neither is said once at load
 * (bundle-128, Q-320; design-v3 section 1 table "One read", section 1.1 step 1, section 1.3, section 8.3).
 *
 * ## What it prevents
 *
 * The setting decides whether a write that carries a field it does not take is stored or refused. Three things a hand-written copy
 * of it would get wrong, each a way the answer starts depending on which spelling a caller reached:
 *
 * - **A second reader.** `unknownWriteFieldsMode(space)` returns `refuse` only for the stored value `'refuse'` and `warn` for
 *   everything else (absent, `'warn'`, `'x'`, `1`). The judge, the audit snapshot, the metric label and every projection call it, so
 *   a space whose config was edited by hand to `true` is judged alike by all of them instead of by whichever one tests truthiness.
 * - **A stored `'warn'`.** `updateSpace` takes `'warn'`, `''` and `null` as "clear" and stores nothing for them, with `in` so an
 *   explicit clear removes the key. A literal `'warn'` on disk would make "absent" and "warn" two states, and the audit would then
 *   record a change for a PATCH that changed nothing (section 1.4).
 * - **A silent bad value.** A hand edit to `config.json` that this build cannot read as `refuse` reads as `warn`, and the operator is
 *   told ONCE per space per value, on `loadConfig` and on `reloadConfig` alike (they share `normaliseLoadedConfig`). It never throws
 *   and never rewrites the file.
 *
 * ## Red on the unchanged base
 *
 * `unknownWriteFieldsMode` is not exported by `spaces/spaces.ts`, `updateSpace` has no arm for the key (so `'refuse'` is not stored),
 * and `normaliseLoadedConfig` says nothing of it. Each case below fails for exactly that.
 *
 * Run: node --test testing/standalone/the-unknown-write-fields-setting-has-one-reader-and-is-never-stored-as-warn.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openUnknownWriteFieldsConfig, WARN_SPACE, REFUSE_SPACE } from './_unknown-write-fields-config.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { stripComments } from './_strip-comments.mjs';
import { readTrackedSources } from './_sources.mjs';

let cfg, spaces;

describe('unknownWriteFieldsMode answers refuse for the stored value refuse and warn for everything else', () => {
  before(async () => {
    spaces = await import('../../server/dist/spaces/spaces.js');
  });

  it('is exported, and is a function of the space', () => {
    assert.equal(typeof spaces.unknownWriteFieldsMode, 'function', 'spaces/spaces.ts exports no unknownWriteFieldsMode');
  });

  // One row per stored value. The truth table is the rule: a hand-written `if (space.unknownWriteFields)` would answer refuse for
  // every row below that is not `'refuse'`, and a `=== 'warn'` test would answer wrongly for the absent row.
  const TABLE = [
    ['absent', {}, 'warn'],
    ['the stored value', { unknownWriteFields: 'refuse' }, 'refuse'],
    ['a stored warn (never written by this build, but a hand edit can)', { unknownWriteFields: 'warn' }, 'warn'],
    ['an unknown word', { unknownWriteFields: 'x' }, 'warn'],
    ['a number', { unknownWriteFields: 1 }, 'warn'],
    ['true', { unknownWriteFields: true }, 'warn'],
    ['an object', { unknownWriteFields: { refuse: true } }, 'warn'],
    ['refuse in another case', { unknownWriteFields: 'REFUSE' }, 'warn'],
    ['refuse with a space', { unknownWriteFields: 'refuse ' }, 'warn'],
    ['null', { unknownWriteFields: null }, 'warn'],
    ['an empty string', { unknownWriteFields: '' }, 'warn'],
  ];
  for (const [label, space, expected] of TABLE) {
    it(`${label}: ${expected}`, () => {
      assert.equal(spaces.unknownWriteFieldsMode(space), expected);
    });
  }
});

describe('the mode has one spelling in the server source', () => {
  it('only spaces/spaces.ts compares the stored value to a mode literal, and the judge and the audit snapshot call the reader', () => {
    // Uncommitted files included: the judge is a new module and this runs before it is committed.
    const files = readTrackedSources('server/src', { floor: 400, untracked: true });
    const mentions = [];
    const comparers = [];
    for (const { file: f, text } of files) {
      const code = stripComments(text);
      if (!/\bunknownWriteFields\b/.test(code)) continue;
      mentions.push(f);
      if (/unknownWriteFields\s*(?:===|!==|==|!=)\s*['"](?:refuse|warn)['"]/.test(code)
          || /['"](?:refuse|warn)['"]\s*(?:===|!==|==|!=)\s*[\w.?]*unknownWriteFields\b/.test(code)) comparers.push(f);
    }
    // A floor: the setting is on the type, the body, the rights table, the loader, the judge, the audit snapshot and two projections.
    assert.ok(mentions.length >= 6, `only ${mentions.length} server source file(s) mention unknownWriteFields: ${mentions.join(', ')} — the setting is not wired`);
    assert.deepEqual(comparers.filter(f => !f.endsWith('server/src/spaces/spaces.ts')), [],
      'a second spelling of the test: only unknownWriteFieldsMode may compare the stored value to a mode');
    for (const must of ['server/src/contract/write-accepts.ts', 'server/src/spaces/meta-update.ts']) {
      const f = files.find(x => x.file.endsWith(must));
      assert.ok(f, `${must} is not a source of the checkout: re-anchor`);
      assert.match(stripComments(f.text), /\bunknownWriteFieldsMode\(/,
        `${must} never calls unknownWriteFieldsMode: it reads the setting some other way, or not at all`);
    }
  });
});

describe('updateSpace never stores warn, and an explicit clear removes the key', () => {
  before(async () => {
    cfg = await openUnknownWriteFieldsConfig({ suite: 'b128-update-space' });
    spaces = await import('../../server/dist/spaces/spaces.js');
  });
  after(() => cfg?.close());

  const spaceOf = (id) => cfg.loader.getConfig().spaces.find(s => s.id === id);
  const onDisk = (id) => JSON.parse(fs.readFileSync(cfg.configPath, 'utf8')).spaces.find(s => s.id === id);

  it('refuse is stored as the one stored value, in memory and on disk', () => {
    const updated = spaces.updateSpace(WARN_SPACE, { unknownWriteFields: 'refuse' });
    assert.ok(updated, 'the space was not found');
    assert.equal(spaceOf(WARN_SPACE).unknownWriteFields, 'refuse');
    cfg.loader.saveConfig(cfg.loader.getConfig());
    assert.equal(onDisk(WARN_SPACE).unknownWriteFields, 'refuse');
  });

  for (const clear of ['warn', '', null, undefined]) {
    it(`${JSON.stringify(clear) ?? 'undefined'} clears the key: absent, not falsy, and nothing written to disk`, () => {
      spaces.updateSpace(REFUSE_SPACE, { unknownWriteFields: 'refuse' });
      assert.equal(spaceOf(REFUSE_SPACE).unknownWriteFields, 'refuse', 'fixture: the space must refuse before it is cleared');
      spaces.updateSpace(REFUSE_SPACE, { unknownWriteFields: clear });
      assert.ok(!('unknownWriteFields' in spaceOf(REFUSE_SPACE)),
        `after ${JSON.stringify(clear) ?? 'undefined'} the key is still on the space: ${JSON.stringify(spaceOf(REFUSE_SPACE).unknownWriteFields)} (a stored warn, or a falsy leftover)`);
      cfg.loader.saveConfig(cfg.loader.getConfig());
      assert.ok(!('unknownWriteFields' in onDisk(REFUSE_SPACE)), 'the cleared key reached config.json');
      assert.equal(spaces.unknownWriteFieldsMode(spaceOf(REFUSE_SPACE)), 'warn');
    });
  }

  it('an update that does not name the key leaves it alone (the arm is keyed on `in`, not on truthiness)', () => {
    spaces.updateSpace(WARN_SPACE, { unknownWriteFields: 'refuse' });
    assert.equal(spaceOf(WARN_SPACE).unknownWriteFields, 'refuse', 'fixture: the space must refuse before the label changes');
    spaces.updateSpace(WARN_SPACE, { label: 'Renamed' });
    assert.equal(spaceOf(WARN_SPACE).unknownWriteFields, 'refuse', 'a label change erased the setting');
    spaces.updateSpace(WARN_SPACE, { unknownWriteFields: '' });
  });

  it('a round trip through the file reads back the same mode', () => {
    spaces.updateSpace(WARN_SPACE, { unknownWriteFields: 'refuse' });
    cfg.loader.saveConfig(cfg.loader.getConfig());
    cfg.loader.reloadConfig();
    assert.equal(spaces.unknownWriteFieldsMode(spaceOf(WARN_SPACE)), 'refuse');
    spaces.updateSpace(WARN_SPACE, { unknownWriteFields: '' });
    cfg.loader.saveConfig(cfg.loader.getConfig());
    cfg.loader.reloadConfig();
    assert.equal(spaces.unknownWriteFieldsMode(spaceOf(WARN_SPACE)), 'warn');
    assert.ok(!('unknownWriteFields' in spaceOf(WARN_SPACE)));
  });
});

describe('a stored value this build cannot read as refuse is said once per space per value, on load and on reload', () => {
  /** The log lines that are about one space's setting: they name the space and the setting. */
  const aboutIt = (lines, space) => lines.filter(l => l.includes(space) && l.includes('unknownWriteFields'));

  before(async () => {
    cfg = await openUnknownWriteFieldsConfig({ suite: 'b128-load-warn' });
    spaces = await import('../../server/dist/spaces/spaces.js');
  });
  after(() => cfg?.close());

  // Each case owns a space id of its own: the report is once per space AND value for the life of the process, so a shared id would make
  // a later case depend on what an earlier one already said.
  const spaceEntry = (id, extra) => ({ id, label: id, folders: [], meta: {}, ...extra });

  it('loadConfig names the space and the value once, reads it as warn, and never rewrites the file; the same value on a reload is not said again', async () => {
    const id = 'b128-load-once';
    // The two values that are valid say nothing: refuse is the one stored value, and an absent key is the default.
    cfg.rewrite([spaceEntry(WARN_SPACE), spaceEntry(`${id}-refuse`, { unknownWriteFields: 'refuse' })]);
    const quiet = await logLinesDuring(() => cfg.loader.loadConfig());
    assert.deepEqual(aboutIt(quiet.lines, `${id}-refuse`), [], 'refuse is the one valid stored value and must not be reported');
    assert.deepEqual(aboutIt(quiet.lines, WARN_SPACE), [], 'an absent value is the default and must not be reported');

    cfg.rewrite([spaceEntry(WARN_SPACE), spaceEntry(id, { unknownWriteFields: 'sometimes' })]);
    const bytes = fs.readFileSync(cfg.configPath);
    const { lines } = await logLinesDuring(() => cfg.loader.loadConfig());
    const said = aboutIt(lines, id);
    assert.equal(said.length, 1, `expected one line about ${id}'s unknownWriteFields, got ${said.length}: ${JSON.stringify(lines)}`);
    assert.ok(said[0].includes('sometimes'), `the line does not name the stored value: ${said[0]}`);
    assert.equal(spaces.unknownWriteFieldsMode(cfg.loader.getConfig().spaces.find(s => s.id === id)), 'warn');
    assert.deepEqual(fs.readFileSync(cfg.configPath), bytes, 'loadConfig rewrote config.json for a value it only reads as warn');

    const again = await logLinesDuring(() => cfg.loader.reloadConfig());
    assert.deepEqual(aboutIt(again.lines, id), [], 'the same stored value was reported a second time');
  });

  it('a different bad value on a reload is said again, naming the new value', async () => {
    const id = 'b128-load-changed';
    cfg.rewrite([spaceEntry(WARN_SPACE), spaceEntry(id, { unknownWriteFields: 'first-value' })]);
    cfg.loader.loadConfig();
    cfg.rewrite([spaceEntry(WARN_SPACE), spaceEntry(id, { unknownWriteFields: 7 })]);
    const { lines } = await logLinesDuring(() => cfg.loader.reloadConfig());
    const said = aboutIt(lines, id);
    assert.equal(said.length, 1, `a changed bad value must be reported once: ${JSON.stringify(lines)}`);
    assert.ok(said[0].includes('7'), `the line does not name the new value: ${said[0]}`);
  });

  it('a space first seen on a reload is checked too (both paths call the one normaliser)', async () => {
    const id = 'b128-load-late';
    cfg.rewrite([spaceEntry(WARN_SPACE)]);
    cfg.loader.loadConfig();
    cfg.rewrite([spaceEntry(WARN_SPACE), spaceEntry(id, { unknownWriteFields: true })]);
    const { lines } = await logLinesDuring(() => cfg.loader.reloadConfig());
    assert.equal(aboutIt(lines, id).length, 1, `reloadConfig did not report ${id}'s stored value: ${JSON.stringify(lines)}`);
  });

  it('a hostile stored value is bounded, cannot forge a line, and does not throw', async () => {
    const id = 'b128-load-hostile';
    const hostile = `x\r\nFORGED ${'y'.repeat(100_000)}`;
    cfg.rewrite([spaceEntry(WARN_SPACE), spaceEntry(id, { unknownWriteFields: hostile })]);
    const { lines, emitted } = await logLinesDuring(() => cfg.loader.loadConfig());
    assert.ok(!lines.some(l => l.startsWith('FORGED')), 'a line break in the stored value started a line of its own');
    assert.ok(emitted.every(l => l.length < 5_000), `a log line carried the stored value at ${Math.max(...emitted.map(l => l.length))} characters`);
    assert.equal(aboutIt(lines, id).length, 1, 'the hostile value was not reported at all');
  });
});
