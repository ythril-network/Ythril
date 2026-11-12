/**
 * The owed-snapshot gap scan (`scanOwedSchemaSnapshots`, `sync/schema-snapshot-owed.ts`) runs over the four record collections of every space every
 * housekeeping cycle. It must read the stamp's partial index `schemaFingerprint_present`, never the collection, and it must not read once per fingerprint
 * it owes (bundle-265 lens sweep P1, P2).
 *
 * ## Why the filter matters
 *
 * A partial index serves a query only when the planner can PROVE the query implies its `partialFilterExpression` (`{ schemaFingerprint: { $exists: true } }`).
 * The scan's `distinct` (`distinctStringsOf`) adds `{ schemaFingerprint: { $type: 'string' } }` to the caller's filter; with an empty filter that is all it
 * asked, and the planner chose a collection scan of every record collection per cycle, growing with the user's data. The scan now passes the index's own
 * filter, so the `$and` contains it verbatim.
 *
 * ## How it is checked
 *
 * The server's own client is opened with command monitoring; the aggregation the scan really sends to the facts collection is captured and explained, and
 * the winning plan must name `schemaFingerprint_present` and hold no `COLLSCAN`. The commands the scan sends to that collection are counted: the distinct
 * stamps, then the deliverers of the owed ones, two commands however many fingerprints are owed.
 *
 * ## Seen red
 *
 * At c244852b the captured aggregation's plan is a `COLLSCAN`, and the scan sends one `find` per owed fingerprint (1 + 12 commands here).
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
    for (const { name, command } of sent) {
      const explainOf = name === 'aggregate'
        ? { aggregate: command.aggregate, pipeline: command.pipeline, cursor: {} }
        : { find: command.find, filter: command.filter, projection: command.projection, limit: command.limit };
      const ex = await mongo.getDb().command({ explain: explainOf, verbosity: 'queryPlanner' });
      const { indexes, stages } = walk(ex);
      assert.ok(!stages.includes('COLLSCAN'), `${name} ${JSON.stringify(command.pipeline ?? command.filter)} is planned as a collection scan (${stages.join(' ')})`);
      assert.ok(indexes.includes('schemaFingerprint_present'), `${name} ${JSON.stringify(command.pipeline ?? command.filter)} does not read schemaFingerprint_present (${JSON.stringify(indexes)})`);
    }
  });
});
