/**
 * The per-type schema files a 6.5 instance wrote into a space (`schemas/<space>_<kind>_<type>.json`) are removed from it, locally, by the
 * housekeeping cycle, and nothing else is touched (Q-735, bundle-265).
 *
 * ## Why they go, and why by a sweep
 *
 * 6.6.0 keeps every schema version privately (`<space>_schema_snapshots`) and no longer writes the per-type files (`syncSchemaFiles` is gone). A space that
 * held them keeps them for ever unless something removes them: they are no use to anyone (a reader reads `GET /api/spaces/:id/meta` or `space_meta`), they
 * are stale from the first schema change, and they never sync (`isInstanceLocalFile` keeps its old pattern, as `RETIRED_SCHEMA_FILE`, so a leftover never
 * STARTS travelling). They are removed by the same walk as the legacy read spills (`files/retired-local-path-sweep.ts`, extracted from
 * `legacy-spill-sweep.ts`: the second site of one question — "remove what a retired writer left at a local-only path") in every TTL cycle, not once at
 * boot: a 6.5 backup restored later brings them back.
 *
 * - **Locally, with no tombstone and no webhook.** No transport carries the path, so a tombstone would announce a deletion nobody is sent.
 * - **Only what the retired writer wrote.** The 6.5 writer recorded no `files` row for them (`files/files.ts` wrote bytes only), so a file at such a path
 *   WITH a row is an operator's upload and stays, row and bytes. A file that only looks like one (another folder, `schemas/my-notes.json`, a hex name under
 *   `schemas/versions/`) is the user's own.
 * - **Quiet when there is nothing.** One log line and one internal audit entry per space, only when something was removed.
 *
 * ## Seen red
 *
 * On ce37b83a nothing removes them: the files are still on disk after the cycle.
 *
 * Run: `npm run test:up` first, then node --test testing/standalone/a-retired-schema-file-is-swept-db.test.js   (after `npm run build -w @ythril/server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { stripComments } from './_strip-comments.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-retired-schema-sweep-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;

const SPACE = 'general';
const SECOND = 'second';

/** What the 6.5 writer wrote: bytes under `schemas/`, named `<space>_<kind>_<type>.json`, no `files` row. */
const RETIRED = ['schemas/general_entity_person.json', 'schemas/general_fact_note-v2.json', 'schemas/general_chrono_Work-Log.json', 'schemas/general_edge_owns.json'];
/** What is the user's own, each for its own reason. */
const OPERATORS_UPLOAD = 'schemas/general_entity_uploaded.json';     // the retired shape, but WITH a files row: someone uploaded it
const MY_NOTES = 'schemas/my-notes.json';                              // not the retired shape
const HEX_NAME = `schemas/versions/${'ab'.repeat(32)}.json`;           // the name the files-based design would have used: a user's file now
const NESTED = 'notes/schemas/general_entity_person.json';             // the pattern is anchored at the root
const NOTE = 'notes/a.md';
const SECOND_RETIRED = 'schemas/second_entity_task.json';

let mongo, ttl;

const abs = (rel, space = SPACE) => path.join(tmpDir, 'files', space, ...rel.split('/'));
const put = (rel, body, space = SPACE) => { fs.mkdirSync(path.dirname(abs(rel, space)), { recursive: true }); fs.writeFileSync(abs(rel, space), body); };
const row = (rel, space = SPACE) => ({
  _id: rel, spaceId: space, path: rel, description: '', tags: [], author: { instanceId: 'self', instanceLabel: 'Self' },
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', seq: 1,
});
const present = (rel, space = SPACE) => fs.existsSync(abs(rel, space));
const rowIds = async (space = SPACE) => (await mongo.col(`${space}_files`).find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();
const sweeps = (space) => mongo.col('audit_log').countDocuments({ method: 'SWEEP', spaceId: space });

describe('retired per-type schema files are swept from the space', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('retiredschemasweep');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'retired-schema-sweep-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: SPACE, builtIn: true, folders: [] }, { id: SECOND, label: SECOND, folders: [] }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => {
    for (const space of [SPACE, SECOND]) {
      fs.rmSync(path.join(tmpDir, 'files', space), { recursive: true, force: true });
      for (const c of ['files', 'fileTombstones', 'file_hashes', 'embed_jobs']) await mongo.col(`${space}_${c}`).deleteMany({});
    }
    await mongo.col('audit_log').deleteMany({});
    for (const rel of RETIRED) put(rel, '{"propertySchemas":{}}');
    put(OPERATORS_UPLOAD, '{"uploaded":"by a person"}');
    put(MY_NOTES, '{"mine":true}');
    put(HEX_NAME, '{"a":"user file"}');
    put(NESTED, '{"nested":true}');
    put(NOTE, 'a real note');
    put(SECOND_RETIRED, '{"second":true}', SECOND);
    await mongo.col(`${SPACE}_files`).insertMany([row(OPERATORS_UPLOAD), row(MY_NOTES), row(HEX_NAME), row(NESTED), row(NOTE)]);
  });

  it('removes every retired per-type file that has no row, in every space, and nothing else', async () => {
    await ttl.sweepExpired();
    for (const rel of RETIRED) assert.equal(present(rel), false, `${rel} was written by the 6.5 schema writer and is still in the space`);
    assert.equal(present(SECOND_RETIRED, SECOND), false, 'the second space\'s retired file was not swept: the walk stopped at the first space');
    for (const rel of [OPERATORS_UPLOAD, MY_NOTES, HEX_NAME, NESTED, NOTE]) assert.ok(present(rel), `${rel} is the user's own and must stay`);
    assert.deepEqual(await rowIds(), [HEX_NAME, MY_NOTES, NESTED, NOTE, OPERATORS_UPLOAD].sort(), 'a row was removed with a file that is not a retired one, or a retired file\'s row appeared');
  });

  it('a file at the retired shape that has a row is an upload: its bytes and its row stay', async () => {
    await ttl.sweepExpired();
    assert.equal(fs.readFileSync(abs(OPERATORS_UPLOAD), 'utf8'), '{"uploaded":"by a person"}');
    assert.ok((await rowIds()).includes(OPERATORS_UPLOAD));
  });

  it('writes no tombstone, and a second cycle finds nothing, logs nothing and audits nothing', async () => {
    const { lines: first } = await logLinesDuring(() => ttl.sweepExpired());
    assert.equal(await mongo.col(`${SPACE}_fileTombstones`).countDocuments({}), 0,
      'no transport carries the path, so a tombstone would announce a deletion nobody is sent');
    assert.ok(await holdsWithin(async () => (await sweeps(SPACE)) === 1, 10_000, 50), `one internal audit entry for the space that lost files, got ${await sweeps(SPACE)}`);
    assert.ok(first.some(l => /removed/i.test(l) && l.includes(SPACE)), `the first cycle said nothing about what it removed from '${SPACE}': ${first.join(' | ')}`);

    const { lines: second } = await logLinesDuring(() => ttl.sweepExpired());
    assert.deepEqual(second.filter(l => /removed/i.test(l) && /schema/i.test(l)), [], 'a cycle that removed nothing said it removed something');
    assert.equal(await sweeps(SPACE), 1, 'a cycle that removed nothing audited a sweep');
  });

  it('a retired file that arrives later (a 6.5 backup restored) is removed by the next cycle: the sweep is every cycle, not once at boot', async () => {
    await ttl.sweepExpired();
    put('schemas/general_entity_restored.json', '{"from":"a 6.5 backup"}');
    await ttl.sweepExpired();
    assert.equal(present('schemas/general_entity_restored.json'), false);
  });

  it('is one walk with two users: the legacy spill sweep calls the shared module and keeps no copy of the walk', () => {
    const sweep = stripComments(fs.readFileSync('server/src/files/retired-local-path-sweep.ts', 'utf8'));
    assert.match(sweep, /export\s+async\s+function\s+sweepRetiredLocalPaths\s*\(/, 'the shared walk is not exported under its name');
    const spills = stripComments(fs.readFileSync('server/src/files/legacy-spill-sweep.ts', 'utf8'));
    assert.match(spills, /sweepRetiredLocalPaths\s*\(/, 'the legacy spill sweep keeps its own copy of the walk: a second copy is the one that goes stale');
  });
});
