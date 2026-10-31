/**
 * An edge endpoint of an UNKNOWN kind (a pulled or imported edge whose `fromKind` fails its schema) is answered by every caller that
 * names a collection from a kind, never thrown on (Q-656, bundle-211).
 *
 * ## What it prevents
 *
 * `edge-endpoint-names.ts` guarded one of its four loops against a kind no collection holds; the other callers called
 * `spaceCollection(space, collectionForRefKind(kind))` unguarded, and `collectionForRefKind('zzz')` is `undefined`, which
 * `spaceCollection` refuses by throwing: the name list of a page of edges, the neighbour walk, the traverse bodies and the whole
 * strict-linkage check of a batch (its catch logs and drops every other target of the batch) each failed for one bad edge, and
 * `resolveEndpointName` queried a collection called `<space>_undefined`. One lookup, `collectionForStoredKind` (a kind read from a
 * stored record: `null` for one no collection holds), is what every caller asks.
 *
 * ## What each caller does with one
 *
 * - `resolveEndpointName`, `resolveEndpointNames`, `withEndpointNames`: the raw id as the name;
 * - `endpointRecordsByKind`, `withTraverseBodies`: not found, the endpoint resolves to no record and no body;
 * - the strict-linkage check: a violation `references non-existent zzz '<id>'` (nothing can hold it), and the rest of the batch is
 *   checked as before.
 *
 * Plus a source gate (comments stripped): outside the validated write door, no file calls `collectionForRefKind(`.
 *
 * Run: node --test testing/standalone/an-edge-endpoint-of-an-unknown-kind-fails-no-caller-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-unknown-kind-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, names, traverseBodies, linkage;
const c = (part) => mongo.col(`${SPACE}_${part}`);
const NOW = '2026-01-01T00:00:00.000Z';
const base = { spaceId: SPACE, tags: [], createdAt: NOW, updatedAt: NOW };

const UNKNOWN_ID = randomUUID();
const ENTITY_ID = randomUUID();
const FACT_ID = randomUUID();

describe('an edge endpoint of an unknown kind fails no caller (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'unknown-kind-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [] }],
    }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('unknownkind');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    names = await import('../../server/dist/brain/edge-endpoint-names.js');
    traverseBodies = await import('../../server/dist/brain/traverse-bodies.js');
    linkage = await import('../../server/dist/sync/linkage-check.js');
  });
  after(async () => { await closeTestMongo(); });
  beforeEach(async () => {
    for (const p of ['entities', 'facts', 'edges', 'link_violations']) await c(p).deleteMany({});
    await c('entities').insertOne({ _id: ENTITY_ID, ...base, name: 'Alice', type: 'person' });
    await c('facts').insertOne({ _id: FACT_ID, ...base, fact: 'a fact', entityIds: [] });
  });

  it('the single resolver names it by its raw id and reads no collection called <space>_undefined', async () => {
    assert.equal(await names.resolveEndpointName(SPACE, UNKNOWN_ID, 'zzz'), UNKNOWN_ID);
    assert.deepEqual(await mongo.getDb().listCollections({ name: `${SPACE}_undefined` }).toArray(), []);
  });

  it('the batched resolver names it by its raw id and still names the others', async () => {
    const name = await names.resolveEdgeEndpointNames(SPACE, UNKNOWN_ID, ENTITY_ID, 'zzz', undefined);
    assert.deepEqual(name, [UNKNOWN_ID, 'Alice']);
    const nameOf = await names.resolveEndpointNames(SPACE, [
      { from: UNKNOWN_ID, to: ENTITY_ID, fromKind: 'zzz' },
    ]);
    assert.equal(nameOf('zzz', UNKNOWN_ID), UNKNOWN_ID);
    assert.equal(nameOf('entity', ENTITY_ID), 'Alice');
  });

  it('the page of edges across members names it by its raw id and still names the others', async () => {
    const edges = [{ from: UNKNOWN_ID, to: ENTITY_ID, fromKind: 'zzz' }];
    const [row] = await names.withEndpointNames(edges, (read) => read(SPACE));
    assert.equal(row.fromName, UNKNOWN_ID);
    assert.equal(row.toName, 'Alice');
  });

  it('the endpoint records of a walk find none for it and still find the others', async () => {
    const found = await names.endpointRecordsByKind([SPACE], [
      { id: UNKNOWN_ID, kind: 'zzz' }, { id: FACT_ID, kind: 'fact' },
    ]);
    assert.deepEqual([...found.keys()], [FACT_ID]);
  });

  it('the traverse bodies attach none to a node of it and still attach the others', async () => {
    const result = {
      nodes: [{ _id: UNKNOWN_ID, depth: 1, kind: 'zzz' }, { _id: ENTITY_ID, depth: 0 }],
      edges: [],
    };
    const projection = (await import('../../server/dist/brain/projection.js')).normaliseProjection({ name: 1 });
    const out = await traverseBodies.withTraverseBodies([SPACE], result, projection, false);
    assert.deepEqual(out.nodes.map(n => [n._id, n.name ?? null]), [[UNKNOWN_ID, null], [ENTITY_ID, 'Alice']]);
  });

  it('the strict-linkage check records the end of an unknown kind as missing and still checks the rest of the batch', async () => {
    const [bad, dangling] = [randomUUID(), randomUUID()];
    const check = new linkage.LinkageCheck(SPACE, 'peer');
    check.add('edges', { _id: bad, from: UNKNOWN_ID, to: ENTITY_ID, fromKind: 'zzz', label: 'x' });
    check.add('edges', { _id: dangling, from: ENTITY_ID, to: randomUUID(), label: 'x' });
    await check.run();
    const bads = await c('link_violations').find({ docId: bad }).toArray();
    assert.deepEqual(bads.map(v => `${v.field}: ${v.reason}`), [`from: from references non-existent zzz '${UNKNOWN_ID}'`]);
    assert.deepEqual((await c('link_violations').find({ docId: dangling }).toArray()).map(v => v.field), ['to'],
      'the check of one bad edge dropped the rest of its batch');
  });
});

/** The one door whose kind is validated before it is stored, so the typed lookup is right for it. */
const VALIDATED = new Set(['server/src/brain/entity-refs.ts', 'server/src/brain/write-connections.ts']);
const CALLS_TYPED_LOOKUP = /\bcollectionForRefKind\s*\(/;

describe('a kind read from a stored record is looked up through one guarded function', () => {
  it('the detector flags the typed lookup and leaves the guarded one alone', () => {
    assert.ok(CALLS_TYPED_LOOKUP.test(stripComments('const p = collectionForRefKind(kind);')));
    assert.ok(!CALLS_TYPED_LOOKUP.test(stripComments('const p = collectionForStoredKind(kind);')));
    assert.ok(!CALLS_TYPED_LOOKUP.test(stripComments('// collectionForRefKind(kind)\nconst p = 1;')));
  });

  it('no file outside the validated write door calls collectionForRefKind', async () => {
    const { readFileSync } = await import('node:fs');
    const callers = trackedSources('server/src', { floor: 200 })
      .filter(f => !VALIDATED.has(f) && CALLS_TYPED_LOOKUP.test(stripComments(readFileSync(f, 'utf8'))));
    assert.deepEqual(callers, [], 'a caller names a collection from a stored kind with the lookup that throws on an unknown one');
  });
});
