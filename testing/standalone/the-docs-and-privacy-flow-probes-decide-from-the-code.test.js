/**
 * The flow-check probes for the export check and the documented-messages check decide from the repository, and a planted copy of each defect fails them.
 *
 * ## The failure this prevents (Q-875, YF-123)
 *
 * `check-i-privacy-export-possible` and `check-i-docs-refusals-and-messages-current` are named by the loop's plan and verify phases. Ythril had
 * no probe for either, so `project-check.mjs` answered "cannot answer" and each was judged by reading, every bundle. A probe now answers each:
 *
 * - export: some route registered under a path that names `export` exists in `server/src` (comments stripped, so a commented-out route is
 *   not one), and a heading naming export, with a body, exists in `docs/userguide`. Neither list is written in the probe: both come from
 *   `git ls-files`.
 * - messages: every `"error"` / `"message"` string a docs page prints in a JSON example has its longest literal piece (a quoted value, a `<placeholder>`
 *   and an ellipsis cut the string into pieces) somewhere in the shipped source. An exception is an entry in the probe's `.allow.json`
 *   with a reason and a reviewBy date; one without either, or past its date, fails the probe.
 *
 * Each rule is proven on a planted copy of the defect taken from the repository's own text (a real route line renamed, a real heading renamed,
 * a real documented message with a character changed), and on the real repository, which must answer without "cannot answer".
 *
 * Run: node --test testing/standalone/the-docs-and-privacy-flow-probes-decide-from-the-code.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { readTrackedSources, REPO_ROOT, SERVER_CODE_ROOTS } from './_sources.mjs';
import { exportRoutes, exportSections, decide as decideExport } from '../../tools/flow-checks/check-i-privacy-export-possible.mjs';
import { documentedStrings, fragmentsOf, decide as decideMessages, readAllow } from '../../tools/flow-checks/check-i-docs-refusals-and-messages-current.mjs';

const probe = (name) => join(REPO_ROOT, 'tools', 'flow-checks', `${name}.mjs`);
const run = (name) => {
  const r = spawnSync(process.execPath, [probe(name)], { encoding: 'utf8', env: testChildEnv({}, process.env), timeout: 120_000 });
  const lines = (r.stdout ?? '').trim().split('\n');
  return { code: r.status, last: lines[lines.length - 1] };
};

const serverSources = readTrackedSources(SERVER_CODE_ROOTS, { ext: ['.ts'], specs: false });
const guide = readTrackedSources(['docs/userguide'], { ext: ['.md'], floor: 3 });
const docs = readTrackedSources(['docs'], { ext: ['.md'], floor: 10 });

describe('check-i-privacy-export-possible', () => {
  it('holds on the repository: an export route and a user-guide section are found', () => {
    const r = run('check-i-privacy-export-possible');
    assert.equal(r.code, 0, r.last);
    assert.match(r.last, /^holds: /);
  });

  it('finds the routes the code registers, not a list: every route its own file registers under an export path is found', () => {
    const found = exportRoutes(serverSources);
    for (const p of ['/:spaceId/export', '/export']) assert.ok(found.some(f => f.path === p), `no route ${p} in ${JSON.stringify(found.map(f => f.path))}`);
  });

  it('is violated when no route is registered under an export path (a real route line renamed)', () => {
    const renamed = serverSources.map(s => ({ ...s, text: s.text.replace(/(\.(?:get|post|put)\(\s*['"`][^'"`]*?)export/g, '$1dump') }));
    const v = decideExport(exportRoutes(renamed), exportSections(guide));
    assert.equal(v.holds, false);
    assert.match(v.reason, /no route/);
  });

  it('is violated when the user guide has no heading about export (the real heading renamed)', () => {
    const renamed = guide.map(s => ({ ...s, text: s.text.replace(/^(#{1,6} .*?)[Ee]xport(ing)?/gm, '$1transfer') }));
    const v = decideExport(exportRoutes(serverSources), exportSections(renamed));
    assert.equal(v.holds, false);
    assert.match(v.reason, /user guide/);
  });

  it('does not count a route written in a comment', () => {
    const only = [{ file: 'server/src/api/x.ts', text: "// router.get('/export', handler);\n/* app.post('/export', h) */\nrouter.get('/health', h);\n" }];
    assert.deepEqual(exportRoutes(only), []);
  });

  it('does not count a heading with no body under it', () => {
    assert.deepEqual(exportSections([{ file: 'docs/userguide/x.md', text: '# Exporting\n\n# Next\ntext\n' }]), []);
  });
});

describe('check-i-docs-refusals-and-messages-current', () => {
  const sourcesText = readTrackedSources([...SERVER_CODE_ROOTS, 'client/src'], { ext: ['.ts'], specs: false });

  it('answers on the repository without "cannot answer"', () => {
    const r = run('check-i-docs-refusals-and-messages-current');
    assert.notEqual(r.code, 2, r.last);
    assert.match(r.last, /^(holds|violated): /);
  });

  it('reads the documented strings from the docs, a real number of them', () => {
    assert.ok(documentedStrings(docs).length >= 10, 'the docs print fewer than ten error strings: the extraction is broken');
  });

  it('cuts a string at its quoted values, placeholders and ellipses and keeps the longest literal piece', () => {
    assert.deepEqual(fragmentsOf("Space '@team' not found. '@team' is a view; write to one of its member spaces"), [' is a view; write to one of its member spaces', ' not found. ', 'Space ']);
    assert.deepEqual(fragmentsOf('Peer runs <version>, below the minimum of <min> this network requires.'), [' this network requires.', ', below the minimum of ', 'Peer runs ']);
    assert.deepEqual(fragmentsOf('Cannot delete: entity still has references - edge e1b2c3d4-... (at its from end)'), ['Cannot delete: entity still has references - edge e1b2c3d4-', ' (at its from end)']);
  });

  it('is violated for a documented message the code no longer emits (a real documented message with a character changed)', () => {
    const real = documentedStrings(docs).find(d => (fragmentsOf(d.text)[0] ?? '').trim().length >= 12);
    assert.ok(real, 'no documented message with a literal piece of 12 characters');
    const planted = [{ ...real, text: `${real.text}ZQX` }];
    const v = decideMessages(planted, sourcesText, [], '2026-11-17');
    assert.equal(v.holds, false);
    assert.ok(v.reason.includes(`${real.file}:${real.line}`), v.reason);
  });

  it('holds for a documented message the code emits', () => {
    const real = documentedStrings(docs).find(d => (fragmentsOf(d.text)[0] ?? '').trim().length >= 12 && sourcesText.some(s => s.text.includes(fragmentsOf(d.text)[0])));
    assert.ok(real, 'no documented message found in the source');
    assert.equal(decideMessages([real], sourcesText, [], '2026-11-17').holds, true);
  });

  it('honours an exception that has a reason and a future reviewBy, and fails one without a reason or past its date', () => {
    const planted = [{ file: 'docs/x.md', line: 3, text: 'A message nobody emits any more, anywhere' }];
    const ok = { text: planted[0].text, reason: 'the page documents the 5.x wording on purpose', reviewBy: '2027-01-01' };
    assert.equal(decideMessages(planted, sourcesText, [ok], '2026-11-17').holds, true);
    assert.match(decideMessages(planted, sourcesText, [{ ...ok, reason: '' }], '2026-11-17').reason, /reason/);
    assert.match(decideMessages(planted, sourcesText, [{ ...ok, reviewBy: '2026-01-01' }], '2026-11-17').reason, /reviewBy|review/);
  });

  it('reports its exception count in the verdict line', () => {
    const real = documentedStrings(docs).find(d => (fragmentsOf(d.text)[0] ?? '').trim().length >= 12 && sourcesText.some(s => s.text.includes(fragmentsOf(d.text)[0])));
    assert.match(decideMessages([real], sourcesText, [], '2026-11-17').reason, /0 exception/);
  });

  it('keeps its allowlist well-formed: every entry names its text, its reason and a reviewBy date', () => {
    for (const e of readAllow()) {
      assert.ok(e.text && e.reason && /^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy), JSON.stringify(e));
    }
    assert.ok(readFileSync(join(REPO_ROOT, 'tools', 'flow-checks', 'check-i-docs-refusals-and-messages-current.allow.json'), 'utf8').length > 0);
  });
});
