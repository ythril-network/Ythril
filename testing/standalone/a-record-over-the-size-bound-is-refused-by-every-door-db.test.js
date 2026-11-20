/**
 * A record over the size bound is refused by the single-record doors as the bulk door refuses it (bundle-270 review F4).
 *
 * ## The defect
 *
 * `brain/record-checks.ts` held that no door can meet its size bound (`MAX_RECORD_BYTES`, the JSON body bound), so only the bulk import asked
 * it. The claim is false: the body bound counts the raw bytes of the request, and the body parser turns every invalid UTF-8 byte into U+FFFD,
 * which a record holds, and JSON writes, as three bytes. A body of about 3.5 million invalid bytes (well inside the bound) parsed to a property
 * of 10.5 MB. The bulk door refused such an item with the size message while `POST /entities` (and the fact, chrono and edge doors) stored
 * the same record: two doors, two answers.
 *
 * ## What it holds
 *
 *  - the body parser's own conversion of a body within the bound makes a record over the bound (so a single-record door can reach it);
 *  - for each kind, the single-record door's write function refuses a record over the bound with `RequestRefusal` in the words the bulk door
 *    uses ("the record is N bytes as JSON; a record may hold at most M bytes") and stores nothing, and the same record under the bound is
 *    stored (the control).
 *
 * Run: in-docker.sh --own-db node --test testing/standalone/a-record-over-the-size-bound-is-refused-by-every-door-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-record-size-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const SIZE_WORDS = /the record is \d+ bytes as JSON; a record may hold at most \d+ bytes/;

let mongo, MAX_RECORD_BYTES, JSON_BODY_MAX_BYTES, RequestRefusal, ents, facts, chrono, edges;
const coll = (n) => mongo.col(`${SPACE}_${n}`);

describe('a record over the size bound is refused by every door', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('recsize');
    const loader = await import('../../server/dist/config/loader.js');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'record-size-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    ({ MAX_RECORD_BYTES } = await import('../../server/dist/brain/record-checks.js'));
    ({ JSON_BODY_MAX_BYTES } = await import('../../server/dist/config/body-limits.js'));
    ({ RequestRefusal } = await import('../../server/dist/util/errors.js'));
    ents = await import('../../server/dist/brain/entities.js');
    facts = await import('../../server/dist/brain/fact.js');
    chrono = await import('../../server/dist/brain/chrono.js');
    edges = await import('../../server/dist/brain/edges.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['facts', 'entities', 'chrono', 'edges', 'links', 'embed_jobs', 'tombstones']) await coll(c).deleteMany({});
  });

  /** What the body parser makes of a body of `bytes` raw bytes that are not UTF-8: the string a record then holds. */
  const parsedFromInvalidBytes = (bytes) => new TextDecoder('utf-8').decode(Buffer.alloc(bytes, 0xff));

  it('a body within the body bound can parse to a record over the size bound, so a single-record door can reach it', () => {
    const bytes = Math.ceil(MAX_RECORD_BYTES / 3) + 1024;
    assert.ok(bytes < JSON_BODY_MAX_BYTES, `the invalid body (${bytes} bytes) must itself pass the body bound (${JSON_BODY_MAX_BYTES})`);
    const held = parsedFromInvalidBytes(bytes);
    assert.ok(Buffer.byteLength(JSON.stringify({ properties: { k: held } }), 'utf8') > MAX_RECORD_BYTES,
      'the parsed record is not over the size bound: the bound would be unreachable and the doc claim true');
  });

  /** A string that makes a record over the bound, as an ordinary caller of the write function could hand it. */
  const oversize = () => 'x'.repeat(MAX_RECORD_BYTES + 1);

  const DOORS = {
    entity: {
      over: () => ents.upsertEntity(SPACE, 'Ada', 'person', [], { k: oversize() }),
      fits: () => ents.upsertEntity(SPACE, 'Ada', 'person', [], { k: 'small' }),
      stored: 'entities',
    },
    fact: {
      over: () => facts.saveFact(SPACE, 'a fact', [], [], undefined, { k: oversize() }),
      fits: () => facts.saveFact(SPACE, 'a fact', [], [], undefined, { k: 'small' }),
      stored: 'facts',
    },
    chrono: {
      over: () => chrono.createChrono(SPACE, { title: 'T', type: 'event', startsAt: '2026-01-01T00:00:00.000Z', properties: { k: oversize() } }),
      fits: () => chrono.createChrono(SPACE, { title: 'T', type: 'event', startsAt: '2026-01-01T00:00:00.000Z', properties: { k: 'small' } }),
      stored: 'chrono',
    },
    edge: {
      over: async () => {
        const [a, b] = [(await ents.upsertEntity(SPACE, 'A', 'person')).entity, (await ents.upsertEntity(SPACE, 'B', 'person')).entity];
        return edges.upsertEdge(SPACE, a._id, b._id, 'knows', undefined, undefined, undefined, { k: oversize() });
      },
      fits: async () => {
        const [a, b] = [(await ents.upsertEntity(SPACE, 'A', 'person')).entity, (await ents.upsertEntity(SPACE, 'B', 'person')).entity];
        return edges.upsertEdge(SPACE, a._id, b._id, 'knows', undefined, undefined, undefined, { k: 'small' });
      },
      stored: 'edges',
    },
  };

  for (const [kind, door] of Object.entries(DOORS)) {
    it(`${kind}: a record over the bound is refused in the bulk door's words and nothing is stored; the same record under it is stored`, async () => {
      await assert.rejects(door.over(), (err) => err instanceof RequestRefusal && SIZE_WORDS.test(err.message),
        `the ${kind} door did not refuse the oversize record as the bulk door does`);
      assert.equal(await coll(door.stored).countDocuments({}), 0, `the oversize ${kind} was stored`);
      await door.fits();
      assert.ok(await coll(door.stored).countDocuments({}) >= 1, `the control ${kind} under the bound was not stored`);
    });
  }
});
