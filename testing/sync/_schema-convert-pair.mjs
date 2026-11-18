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
 * - **Four copies of the club.** `joinedClub` is the one place the organiser's club and the member that joins it by invite are built; the
 *   organiser's own yes passes a round at once, so what the organiser converts is finished before the member has heard of the round, which is the
 *   order the tests that need one member to convert first stand on.
 *
 * The networks themselves are not built here for a closed network: `mirroredNetwork` of `helpers.js` is that, and the tests call it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForReading } from '../_shared/wait-for.mjs';
import { INSTANCES, post, patch, get, del, delWithBody, syncUntil, readRecord, readCollection } from './helpers.js';

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
 * A club that A organises over `space`, joined by B through an invite, with the space held by B; answers the network id and the function that
 * removes the network on both instances and the space on B (the space on A is the test's own, removed with its `createTestSpace`).
 *
 * A club's organiser decides a round by its own yes, so a schema change A saves is concluded on A at once and A's conversion starts before B has
 * heard of the round: B hears of it at its next sync, as a member that never saw the round open.
 */
export async function joinedClub({ label, space }) {
  const A = INSTANCES.a, B = INSTANCES.b, tA = tokenOf('a'), tB = tokenOf('b');
  const net = await post(A, tA, '/api/networks', { label, type: 'club', spaces: [space] });
  assert.equal(net.status, 201, `the club on A: ${net.status} ${JSON.stringify(net.body)}`);
  const networkId = net.body.id;
  const inv = await post(A, tA, '/api/invite/generate', { networkId });
  assert.equal(inv.status, 201, `the invite: ${inv.status} ${JSON.stringify(inv.body)}`);
  const join = await post(B, tB, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply', rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId, myUrl: 'http://ythril-b:3200',
  });
  assert.equal(join.status, 200, `B joins the club: ${join.status} ${JSON.stringify(join.body)}`);
  await syncUntil(B, tB, networkId, async () => (await get(B, tB, `/api/spaces/${space}/meta`)).status === 200, `B to hold the space ${space}`, { timeoutMs: 90_000 });
  const remove = async () => {
    await del(B, tB, `/api/networks/${networkId}`).catch(() => {});
    await del(A, tA, `/api/networks/${networkId}`).catch(() => {});
    await delWithBody(B, tB, `/api/spaces/${space}`, { confirm: true }).catch(() => {});
  };
  return { networkId, remove };
}
