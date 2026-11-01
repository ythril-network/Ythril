/**
 * A TTL sweep that deletes expired records audits each space it deleted from — one `ttl.expire` row per space per cycle with the count
 * per collection — and its summary line names each space and its count (bundle-40, Q-207).
 *
 * ## The finding
 *
 * The sweep deletes every record past its `_expireAt` and issues a tombstone for each, so the deletion is every instance's. Its only
 * trace was one line, `TTL sweep deleted N expired record(s)`: no space, no collection, and nothing in the audit log, while its sibling
 * steps (the legacy-spill sweep, the sidecar retirement, the stray drain) each write an internal row. "Where did my records go" had no
 * answer an operator could read, and an instance with many spaces could not tell which one the sweep was emptying.
 *
 * ## What is held
 *
 * - A cycle that deletes writes ONE `ttl.expire` row per space that lost something, none for a space that lost nothing: operation, the
 *   space, `ip: 'internal'`, and a change per collection with its count (`{ field: <collection>, to: <count> }`).
 * - The summary line names each space and its count (`<space>` followed by its number), and not a space that lost nothing.
 *
 * ## Seen red
 *
 * On 6c64a7112 the cycle deletes the records, logs `TTL sweep deleted 4 expired record(s)` and writes no `ttl.expire` row.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-ttl-expiry-is-audited-per-space-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();

const A = 'ttlexpirea';
const B = 'ttlexpireb';
const C = 'ttlexpirec';
const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-ttl-audit-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

let server, local, mongo, ttl, fact, entities;
const vectorFor = (text) => Array.from({ length: DIMS }, (_, i) => ((text.length + i) % 10) / 10 + 0.05);
const past = () => new Date(Date.now() - 86_400_000);

/** Make `id` of `space`'s `collection` due: its expiry stamp is a day ago. */
const expire = (space, collection, id) => mongo.col(`${space}_${collection}`).updateOne({ _id: id }, { $set: { _expireAt: past() } });

describe('a TTL sweep that deletes is audited per space (real MongoDB)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: vectorFor(JSON.parse(body).input) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'ttl-audit', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [A, B, C].map(id => ({ id, label: id, folders: [] })),
    }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('ttlexpireaudit');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
    fact = await import('../../server/dist/brain/fact.js');
    entities = await import('../../server/dist/brain/entities.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a cycle writes one ttl.expire row per space that lost records, with its count per collection, and says each space and count in its summary line', async () => {
    const opts = { waitForEmbedding: true };
    const a1 = await fact.saveFact(A, 'the first fact of space a', [], [], undefined, undefined, undefined, opts);
    const a2 = await fact.saveFact(A, 'the second fact of space a, longer', [], [], undefined, undefined, undefined, opts);
    const aEntity = (await entities.upsertEntity(A, 'an entity of space a', 'machine', [], {}, 'an entity', undefined, opts)).entity;
    const b1 = await fact.saveFact(B, 'the only fact of space b', [], [], undefined, undefined, undefined, opts);
    const c1 = await fact.saveFact(C, 'a fact of space c that stays', [], [], undefined, undefined, undefined, opts);
    await expire(A, 'facts', a1._id);
    await expire(A, 'facts', a2._id);
    await expire(A, 'entities', aEntity._id);
    await expire(B, 'facts', b1._id);

    const { lines, result: deleted } = await logLinesDuring(() => ttl.sweepExpired(new Date()));
    assert.equal(deleted, 4, 'fixture: the sweep did not delete the four expired records');
    assert.ok(await mongo.col(`${C}_facts`).findOne({ _id: c1._id }), 'fixture: the sweep took a record that is not expired');

    const rows = await auditRowsOf(mongo, { operation: 'ttl.expire' });
    assert.deepEqual(rows.map(r => r.spaceId).sort(), [A, B], `want one ttl.expire row for each space that lost records and none for the other: ${JSON.stringify(rows.map(r => [r.spaceId, r.changes]))}`);
    for (const row of rows) assert.equal(row.ip, 'internal', 'a sweep row is not an internal one');
    const countsOf = (space) => Object.fromEntries((rows.find(r => r.spaceId === space)?.changes ?? []).map(c => [c.field, c.to]));
    assert.deepEqual(countsOf(A), { facts: 2, entities: 1 }, 'the row of space a does not carry its count per collection');
    assert.deepEqual(countsOf(B), { facts: 1 }, 'the row of space b does not carry its count per collection');

    const summary = lines.filter(l => l.includes('TTL sweep deleted'));
    assert.equal(summary.length, 1, `want one summary line: ${JSON.stringify(lines)}`);
    const countAfter = (space) => new RegExp(`${space}\\D{0,24}?(\\d+)`).exec(summary[0])?.[1];
    assert.equal(countAfter(A), '3', `the summary line does not give space a's count: ${summary[0]}`);
    assert.equal(countAfter(B), '1', `the summary line does not give space b's count: ${summary[0]}`);
    assert.ok(!summary[0].includes(C), `the summary line names a space that lost nothing: ${summary[0]}`);
  });
});
