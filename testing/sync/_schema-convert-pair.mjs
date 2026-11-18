/**
 * Two instances of the sync stack that hold one space under a network, and the reads a schema-conversion test makes of each of them: the shared
 * half of `a-conversion-carried-by-a-vote-converges-on-every-member`, `a-member-that-refuses-the-steps-takes-the-schema-and-reviews-its-records`,
 * `steps-a-relayer-adds-are-not-applied` and `a-type-renamed-on-a-network-keeps-the-old-type-and-moves-the-records` (bundle-284, Q-745 and Q-746).
 *
 * ## What it prevents
 *
 * - **A stamp check that passes on a record whose version moved.** `recordOn` answers the version, the change date, the stamp, the type and the
 *   properties of one record read through ONE door, so a test that says "stamped quietly" reads the version it says did not move beside the stamp
 *   it says did.
 * - **A wait on a run that was never started.** `runEnds` accepts a run only when it is `complete` and one of its sources is a passed round, so a
 *   space that has no run yet (`{ state: 'none' }`) or one the test did not expect is a named timeout, never a pass.
 * - **A fork the assertions never look at.** `forksIn` reads the space's fork list on one instance and every test of the set asks it of both.
 * - **An order of events that holds only by timing.** `joinedPubsub` is the one place the network of the tests that need ONE member to convert
 *   first is built: A publishes, B subscribes. A publisher's own yes passes a schema round at once, and its run asks no peer for a first sync
 *   (it pulls from nobody), so A converts before B has heard of the round; B hears of it only when the test syncs B. A club looked the same
 *   but is not: its organiser pulls from the member, so the organiser's own run asked the member for one sync before reading, that sync told
 *   the member of the passed round, and the member converted the copies first (the first run of the stack, 2026-11-18).
 * - **A test that cannot run where the tests run.** The sync tests run in the container runner, which has no `docker` command. `mirroredPair`
 *   builds the closed network two instances both hold (the `mirroredNetwork` of `helpers.js`) by their own doors alone: each instance id is read
 *   from `GET /api/about`, and the peer token each keeps is the one the member add stores. `patchNetworkOnDisk` changes a network in an
 *   instance's `config.json` through the stack's bind mount (`testing/sync/configs/<x>`), where `patchContainerNetwork` used `docker exec`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForReading } from '../_shared/wait-for.mjs';
import { INSTANCES, post, patch, get, del, delWithBody, syncUntil, readRecord, readCollection, pubsubNetwork, reloadConfig } from './helpers.js';

const CONFIGS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'configs');

/** The setup admin token of instance `x` (`a`, `b`): it holds `knowledge: admin` and administers every space, which the Convert act asks. */
export const tokenOf = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();

const string = { type: 'string' };

/** `typeSchemas` for the one entity type `name` with these property declarations: the meta of a save or of an own definition. */
export const entityType = (name, propertySchemas) => ({ typeSchemas: { entity: { [name]: { propertySchemas } } } });

/** A property that is a string, and one that is a string from a list: the two declarations the tests' steps read and write. */
export const text = () => ({ ...string });
export const oneOf = (...values) => ({ type: 'string', enum: values });

/** Set a plain space's own definitions (a space in no network: a save here opens no round). */
export async function setOwnSchema(base, token, space, meta) {
  const r = await patch(base, token, `/api/spaces/${space}`, { meta });
  assert.equal(r.status, 200, `setting the own definitions of ${space} on ${base}: ${r.status} ${JSON.stringify(r.body)}`);
}

/** Write each row as an entity of `space`, asserting every create, and answer the ids in order. */
export async function writeEntities(base, token, space, rows) {
  const ids = [];
  for (const row of rows) {
    const w = await post(base, token, `/api/brain/spaces/${space}/entities`, row);
    assert.equal(w.status, 201, `writing ${JSON.stringify(row)} on ${base}: ${w.status} ${JSON.stringify(w.body)}`);
    ids.push(w.body._id);
  }
  return ids;
}

/**
 * One entity as one instance holds it: its version, change date, stamp, type and properties, in one read. Asserts that the instance holds it.
 * (`schemaFingerprint` is the stamp: absent when the record conformed to nothing, or an instance below the stamp wrote it.)
 */
export async function recordOn(base, token, space, id) {
  const r = await readRecord(base, token, space, 'entities', id);
  assert.equal(r.status, 200, `${base} does not hold the entity ${id}: ${r.status} ${JSON.stringify(r.body)}`);
  const doc = r.body;
  return { seq: doc.seq, updatedAt: doc.updatedAt, stamp: doc.schemaFingerprint, type: doc.type, properties: doc.properties ?? {}, forkOf: doc.forkOf };
}

/** Whether `base` holds every one of `ids` (the condition of a wait for records to arrive). */
export async function holdsAll(base, token, space, ids) {
  for (const id of ids) {
    if ((await readRecord(base, token, space, 'entities', id)).status !== 200) return false;
  }
  return true;
}

/** The entities of `space` on `base` of type `type`, whole (a page of up to a hundred: a test names the ones it expects). */
export async function entitiesOfType(base, token, space, type) {
  const r = await readCollection(base, token, space, 'entities', { filter: { type }, limit: 100 });
  assert.equal(r.status, 200, `reading the ${type} entities of ${space} on ${base}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.results;
}

/** The fingerprint the space on `base` runs on now (its meta's `schemaFingerprint`), asserted to be one. */
export async function fingerprintOn(base, token, space) {
  const m = await metaOn(base, token, space);
  assert.match(String(m.schemaFingerprint), /^[0-9a-f]{64}$/, `the meta of ${space} on ${base} names no fingerprint`);
  return m.schemaFingerprint;
}

/** The effective meta of the space on `base`, asserted to be answered. */
export async function metaOn(base, token, space) {
  const r = await get(base, token, `/api/spaces/${space}/meta`);
  assert.equal(r.status, 200, `GET meta of ${space} on ${base}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** The conversion run of the space on `base` as the status door answers it (`{ state: 'none' }` when it never had one). */
export async function conversionOf(base, token, space) {
  const r = await get(base, token, `/api/spaces/${space}/schema-convert`);
  assert.equal(r.status, 200, `GET schema-convert of ${space} on ${base}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/**
 * Wait, re-triggering the sync of `networkId` from `base`, until the run of `space` on `base` is `complete` and one of its sources is a passed
 * round; answers that status. The timeout names the last status it read.
 */
export async function runEnds({ base, token, networkId, space, who }) {
  let last;
  await syncUntil(base, token, networkId, async () => {
    last = await conversionOf(base, token, space);
    return last.state === 'complete' && (last.sources ?? []).some(s => s.kind === 'round');
  }, `the conversion run of ${space} on ${who} to complete`, {
    timeoutMs: 120_000, onTimeout: () => `the last status on ${who} was ${JSON.stringify(last)}`,
  });
  return last;
}

/** The same wait for an instance that is not to be synced (its round already reached it): a plain poll of the status. */
export async function runEndsHere({ base, token, space, who }) {
  return await waitForReading(() => conversionOf(base, token, space),
    s => s.state === 'complete' && (s.sources ?? []).some(x => x.kind === 'round'), 120_000, 1_000, { what: `the conversion run of ${space} on ${who} to complete` });
}

/** The open (default) or dismissed unconverted items of the space on `base`. */
export async function itemsOf(base, token, space, query = '') {
  const r = await get(base, token, `/api/spaces/${space}/schema-convert/items${query}`);
  assert.equal(r.status, 200, `GET schema-convert/items of ${space} on ${base}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.items;
}

/** How many unresolved versions (forks) of any kind the space holds on `base`. */
export async function forksIn(base, token, space) {
  const r = await get(base, token, `/api/brain/spaces/${space}/forks`);
  assert.equal(r.status, 200, `GET forks of ${space} on ${base}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.total;
}

/** The space's Merkle root on `base` (a hash over the ids and versions it holds, so equal roots are equal versions). */
export async function rootOn(base, token, space) {
  return (await get(base, token, `/api/sync/merkle?spaceId=${encodeURIComponent(space)}`)).body?.root;
}

/**
 * A pub/sub network A publishes over `space`, which B subscribes to by an invite key and adopts; answers the network id and the function that
 * removes the network on both instances and the space on B (the space on A is the test's own, removed with its `createTestSpace`).
 *
 * The order the tests that need one member to convert first stand on: A's own yes passes a schema round at once, and A's run asks no peer for a
 * first sync (a publisher pulls from nobody: `syncedFirst.asked` is 0 on A), so nothing tells B of the round until the test syncs B, and A's
 * conversion is finished by then. B, a subscriber, pulls from A, so B's run asks A for one sync first and reads what A converted.
 */
export async function joinedPubsub({ label, space }) {
  const A = INSTANCES.a, B = INSTANCES.b, tA = tokenOf('a'), tB = tokenOf('b');
  const net = await pubsubNetwork({ label, spaces: [space], publisher: [A, tA, 'ythril-a'], subscriber: [B, tB, 'ythril-b'] });
  await net.adopted(space, 90_000);
  const remove = async () => {
    await net.remove();
    await delWithBody(B, tB, `/api/spaces/${space}`, { confirm: true }).catch(() => {});
  };
  return { networkId: net.networkId, remove };
}

/** The instance id of the instance at `base`, as it answers `GET /api/about`. */
async function instanceIdOf(base, token) {
  const r = await get(base, token, '/api/about');
  assert.equal(r.status, 200, `GET /api/about on ${base}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.instanceId;
}

/**
 * A closed network over `spaces` that A and B BOTH hold, each listing the other, so each instance runs its own conclusion of every round: the
 * `mirroredNetwork` of `helpers.js` built through the instances' own doors, with no `docker exec` (the runner the tests run in has none). Each
 * member add stores the peer token the other instance minted for it, which is the token its sync engine calls the other with. The spaces must
 * already exist on both.
 */
export async function mirroredPair({ label, spaces }) {
  const A = INSTANCES.a, B = INSTANCES.b, tA = tokenOf('a'), tB = tokenOf('b');
  const must = (r, what) => { assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };
  const [idA, idB] = [await instanceIdOf(A, tA), await instanceIdOf(B, tB)];
  const forA = must(await post(B, tB, '/api/tokens', { name: `${label}-a-${Date.now()}`, peerInstanceId: idA }), 'the peer token B mints for A');
  const forB = must(await post(A, tA, '/api/tokens', { name: `${label}-b-${Date.now()}`, peerInstanceId: idB }), 'the peer token A mints for B');
  const net = must(await post(A, tA, '/api/networks', { label, type: 'closed', spaces, votingDeadlineHours: 1 }), 'the network on A');
  const networkId = net.body.id;
  const add = async (base, token, instanceId, memberLabel, url, peerToken) => {
    const r = must(await post(base, token, `/api/networks/${networkId}/members`, { instanceId, label: memberLabel, url, token: peerToken, direction: 'both' }), `member ${memberLabel}`);
    if (r.status === 202) must(await post(base, token, `/api/networks/${networkId}/votes/${r.body.roundId}`, { vote: 'yes' }), `the yes on ${memberLabel}`);
  };
  await add(A, tA, idB, `${label} B`, 'http://ythril-b:3200', forA.body.plaintext);
  const onB = await post(B, tB, '/api/networks', { id: networkId, label, type: 'closed', spaces, votingDeadlineHours: 1 });
  assert.ok(onB.status === 201 || onB.status === 409, `the network on B: ${onB.status} ${JSON.stringify(onB.body)}`);
  await add(B, tB, idA, `${label} A`, 'http://ythril-a:3200', forB.body.plaintext);
  const remove = async () => {
    await del(A, tA, `/api/networks/${networkId}`).catch(() => {});
    await del(B, tB, `/api/networks/${networkId}`).catch(() => {});
  };
  return { networkId, remove };
}

/**
 * Change network `networkId` in the `config.json` of instance `x` (`a`, `b`) through the stack's bind mount: `change(n, cfg)` edits it in place.
 * The caller reloads the instance (`reloadConfig`) for it to take effect. A read that races the instance's own write of the file is tried again.
 */
export async function patchNetworkOnDisk(x, networkId, change) {
  const file = path.join(CONFIGS, x, 'config.json');
  let cfg;
  await waitForReading(() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } },
    v => v !== undefined, 5_000, 100, { what: `a whole read of ${file}` }).then(v => { cfg = v; });
  const n = cfg.networks.find(x2 => x2.id === networkId);
  assert.ok(n, `network ${networkId} is not in ${file}`);
  change(n, cfg);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await reloadConfig(INSTANCES[x], tokenOf(x));
}
