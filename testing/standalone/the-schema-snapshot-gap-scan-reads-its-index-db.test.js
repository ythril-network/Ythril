/**
 * The owed-snapshot gap scan (`scanOwedSchemaSnapshots`, `sync/schema-snapshot-owed.ts`) runs over the four record collections of every space every
 * housekeeping cycle. It must read the stamp's partial index `schemaFingerprint_present`, never the collection, and it must not read once per fingerprint
 * it owes (bundle-265 lens sweep P1, P2).
 *
 * ## Why the filter matters
 *
 * A partial index serves a query only when the planner can PROVE the query implies its `partialFilterExpression` (`{ schemaFingerprint: { $exists: true } }`).
 * The scan's `distinct` (`distinctStringsOf`) adds `{ schemaFingerprint: { $type: 'string' } }` to the caller's filter. The lens sweep suspected an empty
 * caller filter left the planner unable to prove it; the explain below showed MongoDB does take `$type: 'string'` as implying it, so that read was index-served
 * already. The scan now passes the index's own filter anyway, so the `$and` contains it verbatim and no planner reasoning is relied on, and this case keeps
 * a later change of either from turning the scan into a collection scan of every record collection per cycle.
 *
 * ## How it is checked
 *
 * The server's own client is opened with command monitoring; the aggregation the scan really sends to the facts collection is captured and explained, and
 * the winning plan must name `schemaFingerprint_present` and hold no `COLLSCAN`. The commands the scan sends to that collection are counted: the distinct
 * stamps, then the deliverers of the owed ones, two commands however many fingerprints are owed.
 *
 * ## Seen red
 *
 * At c244852b the scan sends one `find` per owed fingerprint (1 + 12 commands here: P2). The plan assertion is not red there (see above): it is a guard,
 * and it was seen to read the plan, IXSCAN on `schemaFingerprint_present`, with the old `{}` filter and with the new one.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/the-schema-snapshot-gap-scan-reads-its-index-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mongoSkipReason, openTestMongo, closeTestMongo } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-gap-scan-index-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;

const SPACE = 'gapscanix';
const UNSTAMPED = 400;
const OWED = 12;
const fpOf = (i) => i.toString(16).padStart(64, 'c');

let mongo;
const facts = () => mongo.col(`${SPACE}_facts`);

/** Index names and stage names anywhere in an explain answer, whatever shape the server's version gives an aggregation's explain. */
function walk(node, out = { indexes: [], stages: [] }) {
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out; }
  if (!node || typeof node !== 'object') return out;
  if (typeof node.indexName === 'string') out.indexes.push(node.indexName);
  if (typeof node.stage === 'string') out.stages.push(node.stage);
  for (const [k, v] of Object.entries(node)) if (k !== 'parsedQuery' && k !== 'command' && k !== 'rejectedPlans') walk(v, out);
  return out;
}

describe('the owed-snapshot gap scan reads the stamp index, in two commands per collection (real MongoDB)', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('gapscanix', { query: '&monitorCommands=true' });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'gap-scan-index-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: SPACE, folders: [] }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    const { ensureTtlIndexes } = await import('../../server/dist/spaces/space-indexes.js');
    assert.deepEqual((await ensureTtlIndexes(SPACE)).failed, [], 'the sweep indexes (the stamp index among them) did not build');
    const docs = [];
    for (let i = 0; i < UNSTAMPED; i++) docs.push({ _id: `plain-${i}`, seq: i + 1 });
    for (let i = 0; i < OWED; i++) docs.push({ _id: `stamped-${i}`, seq: UNSTAMPED + i + 1, schemaFingerprint: fpOf(i), deliveredBy: `peer-${i}` });
    await facts().insertMany(docs);
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('every read of the facts collection the scan sends is planned on schemaFingerprint_present, never a collection scan, and there are two of them', async () => {
    const sent = [];
    const listen = (ev) => {
      const coll = ev.command?.[ev.commandName];
      if (coll === `${SPACE}_facts` && ['aggregate', 'find', 'distinct', 'count'].includes(ev.commandName)) sent.push({ name: ev.commandName, command: ev.command });
    };
    const client = mongo.getMongo();
    client.on('commandStarted', listen);
    try {
      const owed = await import('../../server/dist/sync/schema-snapshot-owed.js');
      owed.forgetOwedSchemaSnapshots();
      await owed.scanOwedSchemaSnapshots();
    } finally { client.off('commandStarted', listen); }

    assert.ok(sent.length > 0, 'the scan sent nothing to the facts collection: the client was not monitored, or the scan skipped the space');
    assert.ok(sent.length <= 2, `the scan sent ${sent.length} commands to one collection for ${OWED} owed fingerprints (${sent.map(s => s.name).join(', ')}): one read per fingerprint`);
    await assertIndexServed(sent);
  });

  /*
   * The one reader of "which fingerprints do the stored records carry" (bundle-266, design r2 D4): `fingerprintsCarriedIn(spaceId, collection, among?)`
   * in `spaces/schema-snapshot-carried.ts`. Without `among` it is the gap scan's question (every stamp); with it, the fetch's and the sweep's (which of
   * THESE is still carried). The `among` form filters `{ schemaFingerprint: { $in: among } }`: an `$in` of strings implies the partial filter
   * `$exists: true`, so the planner may use the index for it, and the reader hints the index besides, so a collection whose index is gone FAILS the
   * read instead of scanning the collection (the sweep's fail-closed case relies on that failure). Both forms must plan on the index.
   *
   * Seen red at 82208a6b: `spaces/schema-snapshot-carried.js` does not exist.
   */
  it('fingerprintsCarriedIn, in both forms, answers from the stamp index alone, and the among form answers only among', async () => {
    const carried = await import('../../server/dist/spaces/schema-snapshot-carried.js').catch(err => ({ __missing: err }));
    assert.ok(!carried.__missing, `server/dist/spaces/schema-snapshot-carried.js does not load (${carried.__missing?.code ?? carried.__missing})`);
    assert.equal(typeof carried.fingerprintsCarriedIn, 'function', 'spaces/schema-snapshot-carried.js exports no fingerprintsCarriedIn');
    const among = [fpOf(0), fpOf(3), 'd'.repeat(64)];
    const sent = [];
    const listen = (ev) => {
      const coll = ev.command?.[ev.commandName];
      if (coll === `${SPACE}_facts` && ['aggregate', 'find', 'distinct', 'count'].includes(ev.commandName)) sent.push({ name: ev.commandName, command: ev.command });
    };
    const client = mongo.getMongo();
    client.on('commandStarted', listen);
    let all, some;
    try {
      all = await carried.fingerprintsCarriedIn(SPACE, 'facts');
      some = await carried.fingerprintsCarriedIn(SPACE, 'facts', among);
    } finally { client.off('commandStarted', listen); }
    assert.deepEqual([...all].sort(), Array.from({ length: OWED }, (_, i) => fpOf(i)).sort(), 'the full form does not answer every stamp the collection carries');
    assert.deepEqual([...some].sort(), [fpOf(0), fpOf(3)].sort(), 'the among form answers a fingerprint outside among, or misses one inside it');
    assert.equal(sent.length, 2, `want one command per call: ${sent.map(s => s.name).join(', ')}`);
    await assertIndexServed(sent);
  });
});

/** Every captured read, explained: planned on `schemaFingerprint_present`, never a collection scan. */
async function assertIndexServed(sent) {
  for (const { name, command } of sent) {
    const hint = command.hint !== undefined ? { hint: command.hint } : {};
    const explainOf = name === 'aggregate'
      ? { aggregate: command.aggregate, pipeline: command.pipeline, cursor: {}, ...hint }
      : name === 'distinct'
        ? { distinct: command.distinct, key: command.key, query: command.query, ...hint }
        : { find: command.find, filter: command.filter, projection: command.projection, limit: command.limit, ...hint };
    const shown = JSON.stringify(command.pipeline ?? command.filter ?? command.query);
    const ex = await mongo.getDb().command({ explain: explainOf, verbosity: 'queryPlanner' });
    const { indexes, stages } = walk(ex);
    assert.ok(!stages.includes('COLLSCAN'), `${name} ${shown} is planned as a collection scan (${stages.join(' ')})`);
    assert.ok(indexes.includes('schemaFingerprint_present'), `${name} ${shown} does not read schemaFingerprint_present (${JSON.stringify(indexes)})`);
  }
}
