/**
 * The `views` a config file holds are validated when it is loaded, and a reload never drops a view silently (Q-531, bundle-100, plan
 * rev 3.2 "Migration" (the S-10 reload diff guard) and the observability vet "boot-config").
 *
 * ## The rules
 *
 * 1. **Refused at boot with a named error.** `loadConfig()` throws, naming what is wrong, for a `views` entry whose name is outside
 *    `^[a-z0-9-]+$` or longer than 40, two views of one owner with one name, a member that is itself a view, and an owner key of an
 *    unknown kind (`token:`, `oauth:` and `oidc:` are the kinds). Two OWNERS with the same name load (names are unique per owner).
 *    A boot that half-understood its views would serve a view nobody can name or delete.
 * 2. **The reload diff guard keeps views.** A reload of a file that lacks views memory holds (a hand edit, a restored older config)
 *    keeps them and says so in a line naming how many it kept - as S-10 does for spaces. A view is personal data of its owner: a
 *    file edit must not delete it without a word.
 *
 * ## Seen red at 18e8d598
 *
 * `loadConfig()` reads `views` as an unknown key and loads every malformed file; a reload replaces the in-memory config wholesale, so
 * the views are gone after it and nothing says so.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/the-views-in-config-are-refused-at-load-when-malformed-and-kept-by-a-reload-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const QA = 'vl-qa';
const OPS = 'vl-ops';

let d, admin, original;
const file = () => process.env['CONFIG_PATH'];
const view = (name, ownerId, members = [QA]) => ({ id: `@${name}`, name, ownerId, members, createdAt: '2026-10-21T00:00:00.000Z' });

/** Load a config whose `views` are `views`; answers the error it threw, or null. The original file and config are put back. */
function loadWith(views) {
  fs.writeFileSync(file(), JSON.stringify({ ...original, views }, null, 2));
  try { d.loader.loadConfig(); return null; } catch (err) { return err; } finally {
    fs.writeFileSync(file(), JSON.stringify(original, null, 2));
    d.loader.loadConfig();
  }
}

describe('the views in config at load and at reload (Q-531)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'q531-view-config', spaces: [QA, OPS] });
    admin = await d.mint('vl-admin', {}, { admin: true });
    await d.loader.flushConfig();
    original = JSON.parse(fs.readFileSync(file(), 'utf8'));
  });
  after(async () => { await d?.close(); });

  it('two owners may each hold a view of one name (control: a valid file loads)', () => {
    const err = loadWith([view('team', 'token:a'), view('team', 'oauth:client-b'), view('team', 'oidc:https://idp.example#c')]);
    assert.equal(err, null, `a valid views list was refused: ${err?.message}`);
  });

  const malformed = {
    'a name outside [a-z0-9-]': { views: [view('Bad Name', 'token:a')], names: /Bad Name/ },
    'a name longer than 40': { views: [view('n'.repeat(41), 'token:a')], names: new RegExp('n{41}') },
    'two views of one owner with one name': { views: [view('dup', 'token:a'), view('dup', 'token:a', [OPS])], names: /dup/ },
    'a member that is itself a view': { views: [view('inner', 'token:a'), view('outer', 'token:a', [QA, '@inner'])], names: /@inner/ },
    'an owner key of an unknown kind': { views: [view('who', 'peer:somebody')], names: /peer:somebody|peer/ },
  };
  for (const [what, { views, names }] of Object.entries(malformed)) {
    it(`a file with ${what} is refused at load with a named error`, () => {
      const err = loadWith(views);
      assert.ok(err, `loadConfig() accepted a views list with ${what}`);
      assert.match(err.message, /view/i, `the error does not say it is about views: ${err.message}`);
      assert.match(err.message, names, `the error does not name the offending value: ${err.message}`);
    });
  }

  it('a reload of a file without the views memory holds keeps them, and says how many it kept', async () => {
    d.loader.mutateConfig(cfg => { cfg.views = [view('kept-a', 'token:x'), view('kept-b', 'token:y', [OPS])]; });
    await d.loader.flushConfig();
    const onDisk = JSON.parse(fs.readFileSync(file(), 'utf8'));
    delete onDisk.views;
    fs.writeFileSync(file(), JSON.stringify(onDisk, null, 2));
    const lines = [];
    const warn = console.warn;
    console.warn = (...a) => { lines.push(a.join(' ')); };
    let r;
    try { r = await d.rest(admin.key, 'POST', '/api/admin/reload-config'); } finally { console.warn = warn; }
    assert.equal(r.status, 200, `reload: ${r.status} ${r.text.slice(0, 200)}`);
    assert.deepEqual((d.loader.getConfig().views ?? []).map(v => v.id).sort(), ['@kept-a', '@kept-b'], 'the reload dropped views the file did not list');
    assert.ok(lines.some(l => /view/i.test(l) && /\b2\b/.test(l) && /kept|keep/i.test(l)), `no line said that 2 views were kept:\n${lines.join('\n')}`);
  });
});
