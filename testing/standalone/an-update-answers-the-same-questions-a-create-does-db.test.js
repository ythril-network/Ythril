/**
 * An update says which fields it did not understand, and a `warn` space finally hears about an edit.
 *
 * ## Two findings, and they ship together
 *
 * **1. Unknown fields.** The `PATCH` routes destructure what they know and drop the rest, exactly as the
 * creates did before 3.7. A caller still could not tell an unimplemented parameter from an applied one — the
 * silence that let a dropped `suppressEmbeddings` go unnoticed for two weeks.
 *
 * **2. A `warn`-mode space said nothing on an update.** The create responses carry a `warnings` array for
 * schema violations; the update responses carried **no `warnings` field at all**. The writers compute the
 * classification and hand it back through `onValidation` — the routes simply never took it. So the same edit
 * was described differently depending on whether the record already existed, which is a stranger rule than
 * either behaviour alone.
 *
 * That second one is why this is a response-shape change rather than a copy of the create fix: there was no
 * field to put a row in.
 *
 * ## The key lists differ from the creates
 *
 * `deleteFields` is accepted on an update and not on a create, and `id` is a path parameter rather than a body
 * field. Copying a create's list would produce an "unknown field" warning about a parameter that works, which
 * is the failure the drift check below exists for.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/an-update-answers-the-same-questions-a-create-does-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();

const ROUTES = {
  facts: 'server/src/api/brain/facts.ts',
  entities: 'server/src/api/brain/entities.ts',
  edges: 'server/src/api/brain/edges.ts',
  chrono: 'server/src/api/brain/chrono.ts',
};

const src = (p) => stripComments(readFileSync(p, 'utf8'));

/** The PATCH handler of one route, bounded by the next route registration. */
function updateHandler(name) {
  const body = src(ROUTES[name]);
  const at = body.indexOf(`Router.patch('/spaces/:spaceId/${name}/:id'`);
  assert.ok(at > 0, `could not find the ${name} update route — re-point this gate`);
  const rest = body.slice(at + 20);
  const next = rest.search(/Router\.(post|get|patch|delete|put)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('every update route answers both questions', () => {
  for (const name of Object.keys(ROUTES)) {
    it(`the ${name} update reports the fields it did not understand`, () => {
      assert.match(updateHandler(name), /unknownFieldWarnings\(/,
        `the ${name} update drops an unknown field silently, so a caller cannot tell an unimplemented `
        + 'parameter from an applied one — the same silence the creates carried until 3.7');
    });

    it(`the ${name} update takes the classification the writer hands back`, () => {
      /*
       * `onValidation` is the last parameter of all four update writers and existed the whole time — the
       * routes just never passed it, so a `warn`-mode space's violations were computed and discarded. Without
       * this, there is nothing to put in a `warnings` array even once the array exists.
       */
      /*
       * Asserted on the WARNINGS, not on the word `onValidation`. That parameter is positional, so a handler
       * that takes it correctly — `c => { check = c; }` — never spells the name; the first draft of this case
       * looked for the word and failed against working code.
       *
       * What matters is that the classification reaches the response, which is two things: a callback handed
       * to the writer, and its `warnings` read back out.
       */
      const handler = updateHandler(name);
      assert.match(handler, /c => \{ \w*[Cc]heck = c; \}/,
        `the ${name} update hands the writer no callback, so the classification it computes is discarded`);
      assert.match(handler, /[Cc]heck\?\.warnings/,
        `the ${name} update never reads the warnings it collected, so a warn-mode space is told nothing about `
        + 'an edit while it is told about a create');
    });
  }

  it('and each update declares every body key it reads', () => {
    // set-claim: the collections this case's own fixture writes to, cleaned between runs. A test's own
    // teardown, not a claim about the collection set.
    // The same drift check the creates have, on lists that legitimately DIFFER: `deleteFields` is an update
    // field, `id` is a path parameter. Copying a create's list would warn about a parameter that works.
    const offenders = [];
    for (const name of Object.keys(ROUTES)) {
      const body = src(ROUTES[name]);
      const handler = updateHandler(name);

      const destructure = /const \{((?:[^{}]|\{\})*)\} = req\.body \?\? \{\};/.exec(handler);
      assert.ok(destructure, `no body destructure found in the ${name} update`);
      const read = destructure[1].split(',').map(s => s.split(':')[0].split('=')[0].trim()).filter(Boolean);
      for (const m of handler.matchAll(/req\.body(?:\?\.|\.)?(?:\['(\w+)'\]|(\w+))/g)) {
        const k = m[1] ?? m[2];
        if (k && !read.includes(k)) read.push(k);
      }

      const declared = new RegExp(`const ${name.toUpperCase()}_UPDATE_BODY_KEYS = \\[([^\\]]*)\\]`).exec(body);
      assert.ok(declared, `the ${name} update declares no ${name.toUpperCase()}_UPDATE_BODY_KEYS list`);
      const known = declared[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

      for (const k of read) {
        if (!known.includes(k) && !SHARED.includes(k)) {
          offenders.push(`${name}: reads \`${k}\` but declares it in neither its own list nor the shared one`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      `a field the route reads is missing from its accepted-key list:\n  ${offenders.join('\n  ')}`);
  });
});

let SHARED = [];

// ── the writer half, from a database ───────────────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-update-warn-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
let mongo, mem, loader;

describe('a warn-mode space has something to be told', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('updatewarn');
    loader = await import('../../server/dist/config/loader.js');
    ({ SHARED_WRITE_BODY_KEYS: SHARED } = await import('../../server/dist/api/brain/unknown-fields.js'));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'update-warn-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{
        id: SPACE, label: 'General', builtIn: true, folders: [],
        meta: {
          validationMode: 'warn',
          typeSchemas: { fact: { note: { propertySchemas: { owner: { type: 'string', required: true } } } } },
        },
      }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    mem = await import('../../server/dist/brain/fact.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['facts', 'embed_jobs', 'tombstones']) await mongo.col(`${SPACE}_${c}`).deleteMany({});
  });

  it('the writer hands the classification back, which is what the route now reports', async () => {
    const created = await mem.saveFact(SPACE, 'a fact', [], [], undefined, undefined, 'note');

    let check;
    await mem.updateFact(SPACE, created._id, { description: 'edited' }, undefined, undefined, undefined,
      undefined, c => { check = c; });

    assert.ok(check, 'updateFact called onValidation with nothing');
    assert.ok(check.warnings.length > 0,
      `a warn-mode space produced no warnings for a record missing a required property: ${JSON.stringify(check)}`);
    assert.match(JSON.stringify(check.warnings), /owner/);
  });

  it('and a conformant record produces none', async () => {
    // The control: warnings on every edit would be warnings nobody reads.
    const created = await mem.saveFact(SPACE, 'a fact', [], [], undefined, { owner: 'platform' }, 'note');
    let check;
    await mem.updateFact(SPACE, created._id, { description: 'edited' }, undefined, undefined, undefined,
      undefined, c => { check = c; });
    assert.ok(check, 'updateFact called onValidation with nothing');
    assert.deepEqual(check.warnings, []);
  });
});
