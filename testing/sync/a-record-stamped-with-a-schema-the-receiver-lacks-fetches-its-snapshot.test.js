/**
 * A record that reaches B stamped with a schema fingerprint B holds no snapshot of makes B fetch that snapshot from A, verified, and keep it
 * (bundle-265, Q-738: `GET /api/sync/schema-snapshot`, the receiver's owed set, the fetch in the sync turn).
 *
 * A and B share a closed network over a space of this test's own. A defines one type of its own, named for this run, so the fingerprint of A's
 * variation (the stamp of A's records) is a text no other instance holds; B defines none. A writes a conforming entity of that type. Once the
 * record is on B, B's own `GET /api/sync/schema-snapshot?fp=<A's fingerprint>` - asked with B's admin token, which shares by reach - answers 200 with the
 * canonical text A's fingerprint names and the links A stored; before the fetch it answered `404 unknown_fingerprint`.
 *
 * ## What each case holds
 *
 * - the route exists on both instances and answers its own codes: `400 bad_fingerprint` for a name that is not 64 lowercase hex, `404 unknown_fingerprint`
 *   for a fingerprint nobody holds. The 404 is asked with the setup admin token first, so a token whose `schema` rung is below `read` fails HERE with the
 *   403 it earned (`schema_rung`), not in the middle of the fetch case (design S-N4: the setup token, `createToken({ admin: true })`, migrates to an admin
 *   floor and holds `schema: admin`);
 * - A holds its own snapshot (the one its records are stamped with, named by the fingerprint its `GET /meta` answers) and serves it;
 * - the fetch: B's copy of the entity lands, and B's snapshot row appears by polling (`syncUntil` re-triggers B's cycle; nothing sleeps), its text is the text
 *   its fingerprint names (`sha256(text) === fp`), it parses as a snapshot of A's variation (format 1, the run's own type), and its links are A's:
 *   `links.own` is A's own fingerprint, which for a variation with no layer is the fingerprint itself.
 *
 * ## Seen red
 *
 * Run on the local stack at ce37b83a (the code from before this bundle): `GET /api/sync/schema-snapshot` is no route there, so the route case fails on the
 * missing `unknown_fingerprint` code, the A case on the missing meta fingerprint, and the fetch case times out waiting for a snapshot nobody fetches.
 *
 * Run: node --test testing/sync/a-record-stamped-with-a-schema-the-receiver-lacks-fetches-its-snapshot.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, mirroredNetwork, createTestSpace, syncUntil, readRecord } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const token = (x) => fs.readFileSync(path.join(__dirname, 'configs', x, 'token.txt'), 'utf8').trim();
const RUN = Date.now();
const TYPE = `lead${RUN}`;

let tA, tB, space, network, entityId, fp;

const snapshotOn = (base, tok, fingerprint) => get(base, tok, `/api/sync/schema-snapshot?spaceId=${space.id}&networkId=${network.networkId}&fp=${fingerprint}`);

before(async () => {
  [tA, tB] = [token('a'), token('b')];
  space = await createTestSpace('snapfetch', [[INSTANCES.a, tA], [INSTANCES.b, tB]]);
  const m = await patch(INSTANCES.a, tA, `/api/spaces/${space.id}`, { meta: { typeSchemas: { entity: { [TYPE]: { propertySchemas: { score: { type: 'number' } } } } } } });
  assert.ok(m.status < 300, `A's own type was not accepted: ${JSON.stringify(m.body)}`);
  network = await mirroredNetwork({ label: `snapfetch-${RUN}`, spaces: [space.id], a: [INSTANCES.a, tA], b: [INSTANCES.b, tB] });
});

after(async () => {
  await network?.remove();
  await space?.remove();
});

describe('the snapshot route and the fetch between two instances', () => {
  it('the route answers its own codes on both instances: 400 for a bad name, 404 unknown_fingerprint for a fingerprint nobody holds (the setup token holds the schema rung)', async () => {
    for (const [base, tok] of [[INSTANCES.a, tA], [INSTANCES.b, tB]]) {
      const bad = await snapshotOn(base, tok, 'not-a-fingerprint');
      assert.equal(bad.status, 400, `${base}: ${bad.status} ${JSON.stringify(bad.body)}`);
      assert.equal(bad.body.code, 'bad_fingerprint');
      const unknown = await snapshotOn(base, tok, 'f'.repeat(64));
      assert.equal(unknown.status, 404, `${base}: ${unknown.status} ${JSON.stringify(unknown.body)}: a 403 here means the setup token lacks schema: read`);
      assert.equal(unknown.body.code, 'unknown_fingerprint', `${base}: a 404 without the code reads as a missing route to a receiver`);
    }
  });

  /** The fingerprint A's meta answers: the one A's records are stamped with. */
  const fingerprintOfA = async () => {
    const meta = await get(INSTANCES.a, tA, `/api/spaces/${space.id}/meta`);
    assert.equal(meta.status, 200, JSON.stringify(meta.body));
    assert.match(String(meta.body.schemaFingerprint), /^[0-9a-f]{64}$/, 'GET meta carries no schemaFingerprint');
    return meta.body.schemaFingerprint;
  };

  it('A stamps with the fingerprint its meta answers, and serves the snapshot that fingerprint names', async () => {
    fp = await fingerprintOfA();
    const r = await snapshotOn(INSTANCES.a, tA, fp);
    assert.equal(r.status, 200, `A does not serve its own variation's snapshot: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(createHash('sha256').update(Buffer.from(r.body.text, 'utf8')).digest('hex'), fp);
    assert.ok(JSON.parse(r.body.text).typeSchemas?.entity?.[TYPE], 'the snapshot does not hold the type A defined');
  });

  it('a conforming entity written on A reaches B, and B fetches the snapshot its stamp names: verified, kept, with A\'s links', async () => {
    fp = await fingerprintOfA();
    const w = await post(INSTANCES.a, tA, `/api/brain/spaces/${space.id}/entities`, { name: `Lead ${RUN}`, type: TYPE, properties: { score: 3 }, tags: ['snapfetch'] });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    entityId = w.body._id;
    await syncUntil(INSTANCES.b, tB, network.networkId, async () => (await readRecord(INSTANCES.b, tB, space.id, 'entities', entityId)).status === 200, 'the entity written on A to reach B', { label: 'B' });
    let held;
    await syncUntil(INSTANCES.b, tB, network.networkId, async () => {
      const r = await snapshotOn(INSTANCES.b, tB, fp);
      if (r.status !== 200) return false;
      held = r.body;
      return true;
    }, `B to hold the snapshot ${fp.slice(0, 12)} its copy of the entity is stamped with`, { label: 'B', timeoutMs: 60_000 });
    assert.equal(held.fp, fp);
    assert.equal(createHash('sha256').update(Buffer.from(held.text, 'utf8')).digest('hex'), fp, 'B keeps a text its fingerprint does not name');
    const snapshot = JSON.parse(held.text);
    assert.equal(snapshot.format, 1);
    assert.ok(snapshot.typeSchemas?.entity?.[TYPE], 'the snapshot B fetched does not hold the type A defined');
    assert.equal(held.links?.own, fp, 'the links B kept are not the ones A sent (A has no layer, so its own fingerprint is the variation\'s)');
  });
});
