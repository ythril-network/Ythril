/**
 * An entity the duplicate scanner absorbs into another is audited: one `duplicate.automerge` row, naming the space, the survivor and the
 * absorbed entity (bundle-40, Q-207).
 *
 * ## The finding
 *
 * A space whose dupe rules say `automerge` has its near-duplicate entities merged by the scanner with nobody asking: the absorbed
 * entity is deleted and a tombstone is issued, so every peer deletes it too. An operator's merge is one `entity.merge` row from the
 * route; the scanner's left a log line and nothing in the audit log, so "where did this entity go" had no answer anywhere an operator
 * reads. `every-server-deleter-writes-an-internal-audit` is the gate over every such deletion; this is the behaviour for the first of them.
 *
 * ## What is held
 *
 * - A merge the scanner lands is ONE row: operation `duplicate.automerge`, the space, `ip: 'internal'`, the survivor as the row's
 *   `entryId`, and the absorbed entity's id in the row (its `changes`).
 * - A merge that is not lossless (two different values for one property) lands nothing and is audited as nothing.
 *
 * ## Seen red
 *
 * On 6c64a7112 the pair merges (the survivor is stored, the absorbed entity is gone) and the audit log holds no `duplicate.automerge`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-dupe-automerge-is-audited-db.test.js
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

const skip = await mongoSkipReason();

const SPACE = 'automergeaudit';
const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-automerge-audit-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

let server, local, mongo, entities, scanner;
const vectorFor = (text) => Array.from({ length: DIMS }, (_, i) => ((text.length + i) % 10) / 10 + 0.05);
const entityColl = () => mongo.col(`${SPACE}_entities`);

/** The scanner's own view of a stored entity, as `handlePair` is handed it. */
const asResult = async (id) => {
  const doc = await entityColl().findOne({ _id: id });
  return { type: 'entity', _id: id, name: doc.name, seq: doc.seq, score: 0.99 };
};

describe('an automerge the scanner lands is audited (real MongoDB)', { skip }, () => {
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
      instanceId: 'automerge-audit', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: SPACE, folders: [], dupeRules: [{ minScore: 0.1, action: 'automerge', types: ['entity'] }] }],
    }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('automergeaudit');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    entities = await import('../../server/dist/brain/entities.js');
    scanner = await import('../../server/dist/brain/dupe-scanner.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const save = (name, properties = {}) => entities.upsertEntity(SPACE, name, 'machine', [], properties, `${name} in the rack`, undefined, { waitForEmbedding: true });

  it('a merge the scanner lands is one duplicate.automerge row naming the space, the survivor and the absorbed entity; one it refuses is none', async () => {
    // A pair with two different values for one property is not lossless: the scanner leaves it, and nothing is audited.
    const c1 = (await save('conflict-one', { rack: 'a' })).entity;
    const c2 = (await save('conflict-two', { rack: 'b' })).entity;
    await scanner.handlePair(SPACE, 'entity', await asResult(c1._id), await asResult(c2._id));
    assert.equal(await entityColl().countDocuments({ _id: { $in: [c1._id, c2._id] } }), 2, 'fixture: a pair with a value conflict was merged');
    assert.deepEqual((await auditRowsOf(mongo, { operation: 'duplicate.automerge' })).map(r => r._id), [], 'a merge that did not land was audited');

    // A lossless pair: the older (lower seq) is the survivor under the default `dupeMergeSurvivor`.
    const older = (await save('lossless-one', { rack: 'c' })).entity;
    const newer = (await save('lossless-two')).entity;
    assert.ok((await entityColl().findOne({ _id: older._id })).seq < (await entityColl().findOne({ _id: newer._id })).seq, 'fixture: the first entity is not the older');
    await scanner.handlePair(SPACE, 'entity', await asResult(older._id), await asResult(newer._id));
    assert.ok(await entityColl().findOne({ _id: older._id }), 'fixture: the survivor is gone');
    assert.equal(await entityColl().findOne({ _id: newer._id }), null, 'fixture: the scanner did not merge a lossless pair');

    const rows = await auditRowsOf(mongo, { operation: 'duplicate.automerge' });
    assert.equal(rows.length, 1, `the automerge left ${rows.length} duplicate.automerge audit rows, want exactly one: ${JSON.stringify(rows)}`);
    const [row] = rows;
    assert.equal(row.spaceId, SPACE, 'the row does not name the space');
    assert.equal(row.ip, 'internal', 'the row is not an internal one');
    assert.equal(row.entryId, older._id, 'the row does not name the survivor as its entry');
    assert.ok(JSON.stringify(row.changes ?? []).includes(newer._id), `the row does not name the absorbed entity ${newer._id}: ${JSON.stringify(row)}`);
  });
});
