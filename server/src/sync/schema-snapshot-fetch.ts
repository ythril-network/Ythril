/**
 * The receiver's half of the schema snapshot fetch (Q-738, bundle-265): a leg of the member's turn that asks the member for the schema versions this
 * server's records are stamped with and holds no snapshot of, verifies each, and keeps it.
 *
 * ## Where it runs, and why there
 *
 * `fetchOwedSchemaSnapshots` is its OWN leg of `exchangeSpaceWithMember` (`leg = 'schema-snapshot'`, after the push leg and before the files leg, whatever
 * the direction: a schema read is not a data transfer), so a throw is attributed to it and not to the push to the peer. Never per arrival and never
 * awaited by a write: an arrival only notes what it is owed (`sync/schema-snapshot-owed.ts`) and the turn asks for it. Only while the turn may continue.
 *
 * ## What it asks, in order
 *
 * 1. A member that is not known to run {@link SCHEMA_SNAPSHOT_SINCE} (`peerRunsAtLeast`: unknown reads as old) is not asked, nor one that answered "no such
 *    route" or "no such space" at its current version.
 * 2. The fingerprints owed to this member, minus those refused for good at this member and version and those backing off, at most 64 looked at.
 * 3. The held check, first: one `find({ _id: { $in } })` on the snapshot collection. A row that is there (another member's answer, this server's own write)
 *    leaves the owed set, and nothing left means no request.
 * 4. At most {@link SNAPSHOT_FETCHES_PER_TURN} of what is left, one at a time, each as `GET /api/sync/schema-snapshot` with `transferInit(requestInit)`:
 *    the control plane's own ten-second signal would win over the transfer budget and abort a snapshot of up to 10 MiB for ever; the turn's own signal still
 *    ends the request with the turn.
 *
 * ## What each answer becomes
 *
 * - `200`: `keepVerifiedSnapshot` (`sync/schema-snapshot-keep.ts`: `verifySnapshot`, then the row). A refusal (`over_cap`, `refused_hash`, `refused_shape`) is TERMINAL for this member, this version and this fingerprint:
 *   asking again would get the same text. Otherwise the row is kept (`origin: 'fetched'`, `from` the member, `links` as sent and shape-checked), and the
 *   links are read as a HINT of whether this variation is behind the sender's (`behindVerdict`; logged once, counted `behind`, nothing kept because of it).
 * - `404` with code `unknown_fingerprint`: the member holds no such version (`not_held`); when every candidate has said so the fingerprint backs off.
 * - `404` with NO code and any other words: the member has no such route (`route_missing`), remembered per member and version.
 * - `404` with NO code whose sentence is `unknownSpaceSentence` of the id asked about, or `410` `space_retired`: the answers the member's one existence rule gives
 *   for a space it does not have (`sendLostSpace`, as `GET /meta` answers it): the member no longer has the space (`lost_space`); not asked about it again at this version.
 * - `409` `not_shared`: TERMINAL, like a refusal: the version was built from a network this member is not in, and the records keep their stamp.
 * - `403` `schema_rung`: this token may not read the schema there; warned once, counted `refused_rung`, the member is paused for the space and tried later.
 * - anything else: backs off per member, space and fingerprint (`failed`).
 *
 * ## This server's own store
 *
 * A failure of the write is this instance's: reported through `reportSpaceFailure` (the shared throttled reporter), never a bare log line. A store that is
 * not answering (`storeIsNotAnswering`) ends the leg for the turn, since the next fingerprint would wait the driver's timeout again, and is rethrown to the
 * turn, which files it as this instance's own fault and not the member's.
 */
import { getConfig } from '../config/loader.js';
import type { NetworkMember } from '../config/types.js';
import { asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { storeIsNotAnswering } from '../db/store-condition.js';
import { withinWriteBound } from '../db/write-bound.js';
import { isShuttingDown } from '../lifecycle.js';
import { isDirectionalNetwork, isUpstreamPeer, networksSharedWith } from '../networks/network-spaces.js';
import { snapshots, type SnapshotRow } from '../spaces/schema-snapshot-store.js';
import { fingerprintsCarriedIn, STAMPED_COLLECTIONS } from '../spaces/schema-snapshot-carried.js';
import { behindVerdict, SCHEMA_SNAPSHOT_MAX_BYTES, type SharedNetwork, type SnapshotRefusal } from '../spaces/schema-snapshot.js';
import { fpPrefix, knownHeld, variationOf, type SnapshotLinks } from '../spaces/schema-stamp.js';
import { keepVerifiedSnapshot } from './schema-snapshot-keep.js';
import { unknownSpaceSentence } from '../spaces/unknown-space.js';
import { networksHolding } from '../spaces/wipe-vote.js';
import { schemaSnapshotTotal } from '../metrics/schema-snapshot-count.js';
import { boundedJson, ResponseTooLargeError } from '../util/bounded-read.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { LruMap } from '../util/lru-map.js';
import { log, peerText } from '../util/log.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { SAY_ONCE_WINDOW_MS, warnOnce } from '../util/warn-once.js';
import { refusalOf, transferRefusal, turnSignal, type ExchangeTurn } from './held-answer.js';
import { peerSafeFetch, transferInit } from './peer-fetch.js';
import { peerRunsAtLeast, reportedVersion } from './peer-floor.js';
import { BACKOFF_FIRST_MS, dropOwedSchemaSnapshot, forgetOwedSchemaSnapshot, noteNotHeld, owedTo } from './schema-snapshot-owed.js';

/**
 * The version a member must report to be asked; a member not known to run it is never asked. It is the version main reported when the route landed,
 * not the release that ships it: a build reports its package's version, which only the release bumps, so a floor at the coming release would match no
 * member of any network built from main and leave the fetch dormant everywhere until the release (gate a-peer-version-floor-is-not-above-this-build).
 * The released build of this number has no route: it answers 404 without a code, which is remembered per member and version, so it costs one request.
 */
export const SCHEMA_SNAPSHOT_SINCE = '6.5.5';

/** The most snapshots asked of one member for one space in one turn; the rest wait for the next. */
export const SNAPSHOT_FETCHES_PER_TURN = 4;

/** The step a failure of the fetch is reported under. */
export const SCHEMA_SNAPSHOT_FETCH_STEP = declareStep('Schema snapshot fetch');

/**
 * The budget of one snapshot request, body included: a snapshot is at most 10 MiB, so the control plane's ten seconds is too short for a slow link and the
 * file transfer's ten minutes is far too long for a text. The explicit signal wins over `peerSafeFetch`'s own budget, so it carries the same bound.
 */
const SNAPSHOT_TIMEOUT_MS = 2 * 60_000;

/** The most owed fingerprints one turn looks at for the held check. */
const HELD_CHECK_WINDOW = 64;

/** An answer's body, past the text it carries (its links, its quotes): the text itself is held to {@link SCHEMA_SNAPSHOT_MAX_BYTES} by bytes, after the read. */
const BODY_MAX_BYTES = 2 * SCHEMA_SNAPSHOT_MAX_BYTES + 64 * 1024;

const REMEMBERED = 4_096;
/** Refused for good: `member@version:space:fp`. A new version of the member is a new key, so it is asked again. */
const terminal = new LruMap<string, SnapshotRefusal | 'not_shared'>(REMEMBERED);
/** A member with no such route, `member@version`. */
const noRoute = new LruMap<string, true>(REMEMBERED);
/** A member without the space, `member@version:space`. */
const noSpace = new LruMap<string, true>(REMEMBERED);
/** Not before this time: `member:space:fp` after a failure, `member:space` after a refused rung. */
const pausedUntil = new LruMap<string, number>(REMEMBERED);
/** In flight, `space:fp`: one request for a fingerprint at a time, however many members' turns want it (checked again before each ask, not only per batch). */
const inFlight = new Set<string>();

const rungSaid = warnOnce<string>();
const behindSaid = warnOnce<string>();
/** A member's failed asks, `member:space`: said once per window, not once per minute for as long as it fails; the metric counts each one. */
const failureSaid = warnOnce<string>({ every: SAY_ONCE_WINDOW_MS });

/** Forget every outcome this module remembers, for tests. */
export function forgetSchemaSnapshotOutcomes(): void {
  terminal.clear(); noRoute.clear(); noSpace.clear(); pausedUntil.clear(); inFlight.clear(); failureSaid.forgetAll();
}

/** Say a failed ask of `member` for `fp`, once per window per member and space. */
function sayFailed(member: NetworkMember, spaceId: string, fp: string, why: unknown): void {
  failureSaid(`${member.instanceId}:${spaceId}`, () => log.warn(`Schema snapshot ${peerText(fpPrefix(fp))} from ${peerText(member.label ?? member.instanceId)} `
    + `for space '${peerText(spaceId)}': ${peerText(why)} (said once per ${SAY_ONCE_WINDOW_MS / 60_000} minutes while it fails)`));
}

/** The members of `spaceId` that may be asked at all: they share it with this server and run a release that serves snapshots. */
function candidatesOf(spaceId: string): string[] {
  const cfg = getConfig();
  const ids = new Set<string>();
  for (const net of networksHolding(spaceId, cfg)) {
    for (const m of net.members) if (m.instanceId !== cfg.instanceId && peerRunsAtLeast(m, SCHEMA_SNAPSHOT_SINCE)) ids.add(m.instanceId);
  }
  return [...ids];
}


/** The arguments of one turn's fetch. `requestInit` is the engine's, which carries the control plane's signal: it is passed through `transferInit`. */
export interface SnapshotFetch {
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  requestInit: () => RequestInit;
  turn: ExchangeTurn;
}

/** What asking for one fingerprint ended in: go on to the next (`not_held`: and keep this one owed to the other members), or end the leg for this turn. */
type Next = 'next' | 'stop' | 'not_held';

/**
 * The turn's fetch leg for one member and space (see the module docblock). Never throws for the member's failures; a failure of this instance's own
 * store that is not answering is rethrown, for the turn to file as this instance's.
 */
export async function fetchOwedSchemaSnapshots(a: SnapshotFetch): Promise<void> {
  const { member, spaceId } = a;
  const memberKey = `${member.instanceId}@${reportedVersion(member)}`;
  const now = Date.now();
  if (!peerRunsAtLeast(member, SCHEMA_SNAPSHOT_SINCE) || noRoute.peek(memberKey) || noSpace.peek(`${memberKey}:${spaceId}`)) return;
  if ((pausedUntil.peek(`${memberKey}:${spaceId}`) ?? 0) > now) return;
  const wanted = owedTo(spaceId, member.instanceId, candidatesOf(spaceId), now)
    .filter(fp => !terminal.peek(`${memberKey}:${spaceId}:${fp}`) && (pausedUntil.peek(`${memberKey}:${spaceId}:${fp}`) ?? 0) <= now)
    .slice(0, HELD_CHECK_WINDOW);
  if (wanted.length === 0) return;
  // Still carried: a record that was deleted or rewritten since the fingerprint was noted no longer needs its snapshot, and nothing is asked for it.
  const { owed, held } = await withinWriteBound(async () => {
    // Additive, as the gap scan: a collection whose read fails throws to the turn, and the fingerprint is asked about again next turn.
    const carried = new Set<string>();
    for (const collection of STAMPED_COLLECTIONS) for (const fp of await fingerprintsCarriedIn(spaceId, collection, wanted)) carried.add(fp);
    for (const fp of wanted) if (!carried.has(fp)) forgetOwedSchemaSnapshot(spaceId, fp);
    const stillOwed = wanted.filter(fp => carried.has(fp));
    // The held check, before any request: a row another member's answer or this server's own write put there is not asked for.
    const rows = await readStoredById<SnapshotRow>(spaceCollection(spaceId, 'schemaSnapshots'), stillOwed, { _id: 1 });
    return { owed: stillOwed, held: new Set(rows.keys()) };
  });
  for (const fp of held) dropOwedSchemaSnapshot(spaceId, fp);
  const toAsk = owed.filter(f => !held.has(f) && !inFlight.has(flightKey(spaceId, f))).slice(0, SNAPSHOT_FETCHES_PER_TURN);
  for (const fp of toAsk) {
    if (!a.turn.mayContinue() || isShuttingDown()) return;
    const flight = flightKey(spaceId, fp);
    // Asked again here, not only when the batch was chosen: another member's turn may have asked for it, or kept it, while this one awaited the one before.
    if (inFlight.has(flight) || knownHeld(spaceId, fp)) continue;
    inFlight.add(flight);
    try {
      const next = await askMemberFor(a, fp, memberKey, a.turn);
      // Asked for, and the answer is in: the owed set is a queue from arrivals to the turn, not a memory of what failed. Whatever the answer was (kept, refused,
      // no route, no space, a failure) the entry leaves it, and the gap scan owes the fingerprint again while a stored record carries it and no row holds it;
      // what was refused or is backing off is remembered below, per member and version, so the scan does not make the member answer it again. Only "not
      // held" stays: the OTHER members it may be asked of have not answered yet.
      if (next !== 'not_held') forgetOwedSchemaSnapshot(spaceId, fp);
      if (next === 'stop') return;
    } finally { inFlight.delete(flight); }
  }
}

/** The key of one fingerprint's request in flight. */
const flightKey = (space: string, fp: string): string => `${space}:${fp}`;

/** Ask the member for `fp`, decide the answer, and keep the snapshot when it verifies. */
async function askMemberFor(a: SnapshotFetch, fp: string, memberKey: string, turn: ExchangeTurn): Promise<Next> {
  const { member, spaceId } = a;
  const failedKey = `${memberKey}:${spaceId}:${fp}`;
  const failed = (next: Next): Next => { schemaSnapshotTotal.note('failed'); pausedUntil.set(failedKey, Date.now() + BACKOFF_FIRST_MS); return next; };
  const q = new URLSearchParams({ spaceId: a.remoteSpaceId, networkId: a.networkId, fp });
  let resp: Response;
  try {
    resp = await peerSafeFetch(`${member.url}/api/sync/schema-snapshot?${q}`,
      { ...transferInit(a.requestInit()), signal: turnSignal(AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS), turn) }, { timeoutMs: SNAPSHOT_TIMEOUT_MS });
  } catch (err) {
    // The turn was cut (an act on the space, shutdown): the member did not fail. Otherwise it is unreachable, and the next fingerprint would wait too.
    if (!turn.mayContinue() || isShuttingDown()) return 'stop';
    sayFailed(member, spaceId, fp, err);
    return failed('stop');
  }
  if (resp.status === 200) return await keepFetched(a, fp, memberKey, resp, failed, turn);
  // A hold or a decline the member answers is its own word for "not now" (a 423 `space_held`): the turn is held, not failed.
  const refusal = await transferRefusal(resp);
  if (refusal !== 'failed') { turn.refusedBy(refusal); return 'stop'; }
  const { code, error } = await refusalOf(resp);
  const lostSpace = (): Next => { schemaSnapshotTotal.note('lost_space'); noSpace.set(`${memberKey}:${spaceId}`, true); return 'stop'; };
  switch (resp.status) {
    case 404:
      if (code === 'unknown_fingerprint') {
        schemaSnapshotTotal.note('not_held');
        noteNotHeld(spaceId, fp, member.instanceId, candidatesOf(spaceId), Date.now());
        return 'not_held';
      }
      if (code === undefined) {
        // The sentence the member's one existence rule answers an unknown space with (`sendLostSpace`, as `GET /meta` answers it): no code, so told from
        // a missing route by its words, which are the ones `unknownSpaceSentence` spells for the id this server asked about.
        if (error?.startsWith(unknownSpaceSentence(a.remoteSpaceId))) return lostSpace();
        schemaSnapshotTotal.note('route_missing'); noRoute.set(memberKey, true); return 'stop';
      }
      break;
    case 410:
      if (code === 'space_retired') return lostSpace();
      break;
    case 409:
      if (code === 'not_shared') { schemaSnapshotTotal.note('not_shared'); terminal.set(`${memberKey}:${spaceId}:${fp}`, 'not_shared'); return 'next'; }
      break;
    case 403:
      if (code === 'schema_rung') {
        schemaSnapshotTotal.note('refused_rung');
        pausedUntil.set(`${memberKey}:${spaceId}`, Date.now() + BACKOFF_FIRST_MS);
        rungSaid(`${member.instanceId}:${spaceId}`, () => log.warn(`${peerText(member.label ?? member.instanceId)} refused this instance the schema of space '${peerText(spaceId)}': `
          + 'the token it holds for that member has no `schema: read` there, so the schema versions its records are stamped with cannot be fetched. Grant it on that member.'));
        return 'stop';
      }
      break;
    default:
  }
  sayFailed(member, spaceId, fp, `HTTP ${resp.status}`);
  return failed('next');
}

/** A 200: verify the text against the fingerprint asked for, then keep it. */
async function keepFetched(a: SnapshotFetch, fp: string, memberKey: string, resp: Response, failed: (next: Next) => Next, turn: ExchangeTurn): Promise<Next> {
  const { member, spaceId } = a;
  let body: { text?: unknown; links?: unknown; layerOf?: unknown };
  try {
    body = await boundedJson(resp, 'schema snapshot', BODY_MAX_BYTES);
  } catch (err) {
    if (err instanceof ResponseTooLargeError) return refuse(spaceId, member, fp, memberKey, 'over_cap');
    if (!turn.mayContinue() || isShuttingDown()) return 'stop';
    sayFailed(member, spaceId, fp, err);
    return failed('next');
  }
  let links: SnapshotLinks | null;
  try {
    const kept = await keepVerifiedSnapshot(spaceId, fp, body?.text, body?.links, member.instanceId);
    if (kept.outcome !== 'written' && kept.outcome !== 'held' && kept.outcome !== 'act_stands') return refuse(spaceId, member, fp, memberKey, kept.outcome);
    // An act stands on the space: nothing is written now, and what it still owes is asked for in a later turn.
    if (kept.outcome === 'act_stands') return 'stop';
    links = kept.links;
  } catch (err) {
    schemaSnapshotTotal.note('failed');
    reportSpaceFailure(SCHEMA_SNAPSHOT_FETCH_STEP, spaceId, err, { unit: fp, when: 'a later turn' });
    if (storeIsNotAnswering(err)) throw err;
    return 'next';
  }
  dropOwedSchemaSnapshot(spaceId, fp);
  await sayBehind(spaceId, member, { fp, links, ...(typeof body.layerOf === 'string' ? { layerOf: body.layerOf } : {}) });
  return 'next';
}

/** A text that was refused: counted, said, and terminal for this member, version and fingerprint. */
function refuse(spaceId: string, member: NetworkMember, fp: string, memberKey: string, outcome: SnapshotRefusal): Next {
  schemaSnapshotTotal.note(outcome);
  terminal.set(`${memberKey}:${spaceId}:${fp}`, outcome);
  log.warn(`Schema snapshot ${peerText(fpPrefix(fp))} from ${peerText(member.label ?? member.instanceId)} for space '${peerText(spaceId)}' REFUSED (${outcome}): `
    + 'it is not the canonical schema text that fingerprint names (or it is over the size a snapshot may have). It is not asked for again from this member at this version.');
  return 'next';
}

/**
 * Read the links of a snapshot just kept as a HINT that this variation is behind the sender's (S-N3: a peer's claim, input to nothing this server keeps):
 * said once per space, network and fingerprint, counted `behind`. The layer rows this server holds are the history it compares against.
 */
async function sayBehind(spaceId: string, member: NetworkMember, sender: { fp: string; links: SnapshotLinks | null; layerOf?: string }): Promise<void> {
  try {
    const variation = variationOf(spaceId);
    const nets = networksSharedWith(spaceId, member.instanceId);
    if (!variation || nets.length === 0) return;
    const layerRows = await snapshots(spaceId)
      .find(asFilter<SnapshotRow>({ origin: 'layer', networkId: { $in: nets.map(n => n.id) } }), { projection: { _id: 1, networkId: 1 } }).toArray();
    const mine: SharedNetwork[] = nets.map(n => ({
      networkId: n.id,
      role: isUpstreamPeer(n, member.instanceId) ? 'upstream' : isDirectionalNetwork(n) ? 'downstream' : 'closed',
      layerFp: variation.layers.find(l => l.networkId === n.id)?.stamp.fp ?? '',
      heldLayerFps: layerRows.filter(r => r.networkId === n.id).map(r => String(r._id)),
    }));
    for (const networkId of behindVerdict({ networks: mine }, sender)) {
      behindSaid(`${spaceId}:${networkId}:${sender.fp}`, () => {
        schemaSnapshotTotal.note('behind');
        log.info(`Schema snapshot ${peerText(fpPrefix(sender.fp))} kept for space '${peerText(spaceId)}': the links ${peerText(member.label ?? member.instanceId)} sent, `
          + `a hint only, say this variation's layer from network '${peerText(networkId)}' is not the one it uses. Nothing is changed: the layer arrives by the meta pull or a round.`);
      });
    }
  } catch (err) {
    // A hint is never a reason to fail a turn.
    log.debug(`Schema snapshot behind-verdict for space '${peerText(spaceId)}': ${peerText(err)}`);
  }
}
