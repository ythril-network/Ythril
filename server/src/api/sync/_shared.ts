/**
 * Shared machinery for the /api/sync sub-routers: the incoming-document schemas, peer/space
 * authorisation, cursor codec, and the fork-depth and implausible-seq guards.
 */
import { getConfig } from '../../config/loader.js';
import { reachesSpace } from '../../auth/space-reach.js';
import { isInstanceAdmin } from '../../auth/instance-admin.js';
import { peerRelayCaller } from '../../auth/peer-relay.js';
import { peerBoundTo } from '../../auth/peer-bound.js';
import { joinRoundOf } from '../../networks/round-state.js';
import { deliveryOf, type Delivery, type DeliveryAuth } from '../../sync/deletion-authority.js';
import { networksHolding } from '../../spaces/wipe-vote.js';
import { isDirectionalNetwork } from '../../networks/network-spaces.js';
import type { TokenRights } from '../../config/rights-shape.js';
import { decodePositionCursor, parsePositionText, type PositionStart } from '../../util/position-keyset.js';
import type { FileMetaDoc, AuthorRef } from '../../config/types.js';
import { LOCAL_ONLY_FIELDS } from '../../sync/local-only-fields.js';
import { spaceHold } from '../../sync/space-exchange-set.js';
import { SPACE_DECLINED_ANSWER } from '../../sync/held-answer.js';
import { admitPeerOnResponse, answerSpaceHeld } from '../../sync/peer-space-admission.js';
import { isSpaceNotWritable } from '../../spaces/space-write-gate.js';

/*
 * What a landed edge or link points at that is not here is `sync/linkage-check.ts`'s question (bundle-30 I8): checked
 * once a transfer is whole, and recorded once per dangling end.
 */

/*
 * An arriving brain document is written by `writeArrivals` (`sync/arrivals.ts`, `Q-107` part 1), which replaced
 * `ingestBrainDoc` here: one writer for every door — push, pull and admin import — that owns every precondition
 * the doors used to hold a different subset of.
 */

// ── Safety limits ─────────────────────────────────────────────────────────

/**
 * Maximum chain depth for forkOf links — prevents a "fork chain bomb" of repeated equal-seq docs with
 * different content. Enforced twice, on every door (push and pull): chain depth (walk forkOf upward) and sibling fan-out
 * (count forks of the same parent, the ones a page is creating included). Defined beside the planner that
 * enforces it (`planArrivals`, `sync/upsert-plan.ts`) and re-exported here for the routes and their tests.
 */
export { MAX_FORK_DEPTH } from '../../sync/upsert-plan.js';

// ── Incoming document schemas (Zod validation for peer-submitted docs) ─────

/*
 * The schemas live in `sync/incoming-schemas.ts`, the schema leaf (Q-624, design rev 4 section 2): they were here, and a module that also
 * re-exports the planner's constants cannot be read by the body hash without a load cycle. Re-exported, so no importer changes.
 */
export {
  AuthorRefSchema, IncomingFactDoc, IncomingFileMetaDoc, IncomingEntityDoc, RefKindSchema, IncomingEdgeDoc, IncomingLinkDoc, IncomingChronoDoc,
} from '../../sync/incoming-schemas.js';
import { IncomingFileMetaDoc } from '../../sync/incoming-schemas.js';
import type { SchemaViolation } from '../../spaces/schema-validation.js';

// ── Paginated cursor helpers ─────────────────────────────────────────────────

// The cursor codec is `util/seq-keyset.ts` (`encodeSeqCursor`, `decodeSeqCursor`): the one place a position becomes
// text and back. It had a second decoder here that read a pair as nothing.

/** The one refusal text for a position start a sync read cannot read. Fixed, so it never repeats what the caller sent. */
export const BAD_POSITION_START = 'afterPos must be a whole number from 0 to 9007199254740991, and cursor one a previous page of this route returned';

/**
 * The refusal of a `sinceSeq` (the 5.6.7 rule): this server pages by position, so it names position paging and never guesses what a seq would mean.
 * Fixed, so it never repeats what the caller sent.
 */
export const SINCE_SEQ_REFUSED = 'sinceSeq is not accepted: this server pages by position — start with afterPos (a whole number) or the cursor a previous page returned';

/** A start a position read refuses, with the words the route answers `400` with. */
export interface PositionStartRefusal { readonly refusal: string }

/**
 * Where a position read starts, from the request — the ONE parse of every sync read (the six record families and the tombstones), replacing
 * `syncReadStart` (bundle-81, design rev 8 §6, decision 4):
 *
 *  - **a `sinceSeq` is refused FIRST**, before the cursor branch, whatever else the request carries: a 5.6 client sends its `sinceSeq` constant beside the
 *    cursor it echoes, and read as a position (or ignored beside a cursor) its numbers would be taken for another space's. The answer names position paging;
 *  - **the `cursor` a previous page handed back** wins over `afterPos`: the opaque `p1.` form, with its own bound (`Number.MAX_SAFE_INTEGER`, not
 *    `parseSeqText`'s `MAX_SYNC_SEQ`, which would refuse every clock-band cursor). Every OLD form is refused, the bare-seq first cursor the 5.6 integrator
 *    guide told clients to build included — a cursor that decoded as 0 would silently start over;
 *  - **`afterPos`**: a whole number from 0 to `Number.MAX_SAFE_INTEGER`, its own parse and its own bound. A value that read as 0 would silently start over, so
 *    anything else is a refusal and not a default. What bounds the damage of a huge one is not the parse but the cap every read applies and
 *    `ownPositionMark`'s cut of every mark recorded from it;
 *  - neither: the start of the stream.
 */
export function syncPositionStart(query: Record<string, unknown>): PositionStart | PositionStartRefusal {
  if (query['sinceSeq'] !== undefined) return { refusal: SINCE_SEQ_REFUSED };
  const cursor = query['cursor'];
  if (cursor !== undefined && cursor !== '') return decodePositionCursor(cursor) ?? { refusal: BAD_POSITION_START };
  const afterPos = query['afterPos'];
  if (afterPos === undefined) return { pos: 0 };
  const pos = typeof afterPos === 'string' ? parsePositionText(afterPos) : undefined;
  return pos === undefined ? { refusal: BAD_POSITION_START } : { pos };
}

/** The refusal of a `since` that is not an ISO instant (the file-tombstone route's legacy start). Fixed, so it never repeats what the caller sent. */
export const BAD_SINCE_INSTANT = 'since must be an ISO8601 instant';

// ── Space access guard ─────────────────────────────────────────────────────

/**
 * Who a page of tombstones came from, as the push route knows it from the authenticated token: the peer the token is
 * bound to, a trusted instance administrator relaying on anyone's behalf, or nobody entitled to either.
 *
 * The input of `deliveryOf` (`sync/deletion-authority.ts`), which adds what only this instance's config knows — whether
 * that peer is the space's upstream. Built on `peerRelayCaller` so the three-way answer has one spelling: a peer
 * identity WINS over admin (a token bound to a peer acts as that peer), and a token that is neither is no relay. The
 * two tombstone routes each read the field by hand (`['peerInstanceId']`) and the admin test beside it.
 */
export function deliveryFromToken(authToken: Record<string, unknown> | undefined): DeliveryAuth {
  const caller = peerRelayCaller(authToken as Parameters<typeof peerRelayCaller>[0]);
  if (caller.kind === 'peer') return { peerInstanceId: caller.peerInstanceId };
  return { trustedRelay: caller.kind === 'admin' };
}

/**
 * The delivery of a page a peer PUSHED, resolved once for the page from the space the door admitted and the request's
 * authenticated token against the live config — what both tombstone doors hand their apply. The pull side's twin is
 * `deliveryOfMember` (`sync/deletion-authority.ts`); the token is read here and nowhere else, so a door cannot hand the
 * authority a peer id it took from the body.
 */
export function deliveryOfRequest(spaceId: string, req: { authToken?: unknown }): Delivery {
  return deliveryOf(getConfig(), spaceId, deliveryFromToken(req.authToken as Record<string, unknown> | undefined));
}

/**
 * The peer a peer-bound token belongs to, as the author of what it delivers — or undefined for any other token.
 * The label is the member's as this instance lists it, or the id when no network lists the peer.
 */
export function callerPeerAuthor(authToken: Record<string, unknown> | undefined): AuthorRef | undefined {
  const instanceId = peerBoundTo(authToken);
  if (!instanceId) return undefined;
  const member = peerMemberNetworks(instanceId).flatMap(n => n.members).find(m => m.instanceId === instanceId);
  return { instanceId, instanceLabel: member?.label ?? instanceId };
}

/**
 * Networks (local view) in which `peerInstanceId` is a member.
 *
 * An EMPTY result means the token is bound to a peer we do not list as a member
 * anywhere. That happens for manually-provisioned peer tokens and for
 * single-side-configured (asymmetric) networks, where the sender holds the
 * network config and we do not. Those callers fall back to plain token-space
 * scoping — see spaceAllowed.
 */
export function peerMemberNetworks(peerInstanceId: string) {
  return getConfig().networks.filter(n => n.members.some(m => m.instanceId === peerInstanceId));
}

/**
 * Does this token's own scope reach `spaceId`? **The matrix, and nothing else** — no matrix, no reach.
 *
 * Never fall back to a legacy allowlist or read an absent scope as unrestricted: that fails open and hands
 * a scope-less token every space. No live token shape lacks a matrix (PATs get one at mint or on boot
 * migration; OIDC sessions carry `rights` as required), so refusing costs nothing.
 *
 * Downstream checks are not a second line of defence: without a `networkId`, `spaceAllowed` only asks
 * whether the space exists.
 */
export function tokenReachesSpace(authToken: Record<string, unknown> | undefined, spaceId: string): boolean {
  const rights = authToken?.['rights'] as TokenRights | undefined;
  if (!rights) return false;
  return reachesSpace(rights, spaceId);
}

/**
 * Returns true if the caller may touch `spaceId` (optionally within `networkId`).
 *
 * Checks, in order:
 *  1. Token space scope (a space-scoped token may only touch its own spaces).
 *  2. **Network membership** — a peer-bound token may only reach spaces shared
 *     through a network that peer is actually a member of. Space scope alone is
 *     not enough: two networks with overlapping spaces but disjoint membership
 *     would otherwise leak into each other.
 *  3. The space is actually shared by that network.
 *
 * Local/admin tokens (no `peerInstanceId`) skip step 2 — they are this
 * instance's own credentials, not a remote peer's.
 */
export function spaceAllowed(
  spaceId: string,
  networkId: string | undefined,
  authToken?: Record<string, unknown>,
): boolean {
  const cfg = getConfig();
  // Enforce token-level space scope before any network check.
  if (!tokenReachesSpace(authToken, spaceId)) return false;

  const peerId = peerBoundTo(authToken);
  if (peerId) {
    const memberNets = peerMemberNetworks(peerId);
    if (memberNets.length > 0) {
      // A known peer: it may only reach spaces via networks it belongs to.
      const usable = networkId
        ? memberNets.filter(n => n.id === networkId)
        : memberNets;
      return networksHolding(spaceId, { networks: usable }).length > 0;
    }
    // A peer whose join is still being voted on (or was denied) holds a
    // provisioned PAT but no membership — it must NOT fall through to plain
    // space scoping, or the vote hold would be meaningless.
    // `joinRoundOf` reads the round ONE way for every caller: this one refuses on either answer (open, or voted down / past
    // its deadline and not yet pruned), where the standing question below admits only an open one.
    const now = Date.now();
    const heldByJoinRound = cfg.networks.some(n => joinRoundOf(n, peerId, now) !== null);
    if (heldByJoinRound) return false;
    // Unknown peer (manual token / asymmetric network): fall through to the
    // legacy space-existence check below — the token's own scope still applies.
  }

  // If no networkId given, allow any known space
  if (!networkId) return cfg.spaces.some(s => s.id === spaceId);
  const net = cfg.networks.find(n => n.id === networkId);
  // networkId not found locally — fall back to checking the space exists.
  // This handles asymmetric networks where the caller has the network config
  // but the recipient does not (e.g. single-side configured networks).
  if (!net) return cfg.spaces.some(s => s.id === spaceId);
  return net.spaces.includes(spaceId);
}

/**
 * The sync data-write surface is for peers. A write must be presented by a
 * server-issued peer token (`peerInstanceId`) or an instance-admin token.
 * Space-scoped user PATs are refused: sync writes carry raw sync metadata
 * (seq/_id/author), so accepting them would let any user-PAT holder forge
 * stream state — e.g. pushing upstream against a directional network.
 *
 * Returns true if the write must be REJECTED (403). Admin is asked through
 * `isInstanceAdmin`, never by reading a token field directly.
 */
export function isNonPeerSyncWrite(authToken: Record<string, unknown> | undefined): boolean {
  if (authToken && isInstanceAdmin(authToken as { admin?: boolean; rights?: TokenRights | null })) return false;
  return !peerBoundTo(authToken);
}

export const NON_PEER_WRITE_MESSAGE =
  'Sync writes require a peer token (peerInstanceId) or an admin token — use the regular REST API for user writes';

/**
 * The preamble every sync WRITE route runs before it reads the body: a space named, the caller's reach into it, a
 * peer (or admin) token, and the network direction. Answers the refusal itself and returns `null`; otherwise the
 * space id. One function, because these four checks were written out at every write route (the document routes,
 * the tombstone route, the file-tombstone route) and a write route that misses one is a door with less in front
 * of it.
 *
 * Handed the parameters rather than the request, so each route still states what it reads in one destructure
 * (`a-tool-and-its-route-take-the-same-parameters` reads that). The file-tombstone route names its space in the
 * body, the others in the query.
 */
export function pushAllowed(
  res: import('express').Response,
  spaceId: unknown,
  networkId: string | undefined,
  authToken: unknown,
): string | null {
  const token = authToken as Record<string, unknown>;
  if (typeof spaceId !== 'string' || !spaceId) { res.status(400).json({ error: 'spaceId required' }); return null; }
  // Reach, the decline and the hold: a push is a data door like any other. Admitted LAST, once every refusal below has passed.
  if (refusePeerSpace(res, spaceId, networkId, token, 'push', false)) return null;
  if (isNonPeerSyncWrite(token)) { res.status(403).json({ error: NON_PEER_WRITE_MESSAGE }); return null; }
  if (isDirectionalWriteBlocked(spaceId, token)) { res.status(403).json({ error: 'Directional network: write not permitted from this peer' }); return null; }
  const peerId = peerBoundTo(token);
  if (!peerId) return spaceId;
  // The push is a transfer of the space, counted in the fence until its response closes, so an act registered meanwhile waits for it.
  return admitPeerOnResponse(res, spaceId, peerId, networkId, 'push', false) ? null : spaceId;
}

/**
 * May the caller REACH `spaceId` at all? Answers `403` itself and returns true when not. The one place the sync routes ask
 * `spaceAllowed`: a route that asked it by hand and wrote its own 403 was a door the hold could not reach. The schema door
 * (`GET /meta`) asks this only - schema propagation is not data, and a wipe changes no schema (X17).
 */
export function refusePeerReach(
  res: import('express').Response, spaceId: string, networkId: string | undefined, authToken: unknown,
): boolean {
  if (spaceAllowed(spaceId, networkId, authToken as Record<string, unknown>)) return false;
  res.status(403).json({ error: 'Forbidden' });
  return true;
}

/**
 * Did the PEER `peerId` dismiss network space `spaceId` (it is a network space id this instance left, pub/sub): asked in the
 * network the request names, or in every network that lists the peer. A space never carried and never dismissed is not declined.
 */
function declinedByThisMember(spaceId: string, networkId: string | undefined, peerId: string): boolean {
  return getConfig().networks.some(n => (!networkId || n.id === networkId)
    && n.members.some(m => m.instanceId === peerId)
    && !n.spaces.includes(spaceId)
    && (n.dismissedSpaces ?? []).includes(spaceId));
}

/**
 * The question every sync DATA door asks before it serves or stores a space for a caller, answering the refusal itself
 * (returns true) or admitting the request (false):
 *
 * - a peer asking for a network space this instance LEFT (pub/sub) is answered `423 space_declined`, which a new sender records
 *   and stops asking for (a `403` would read as a failed transfer every cycle);
 * - a caller that may not reach the space is answered `403` (`refusePeerReach`);
 * - a PEER token is answered `423 space_held` while the space is held with that peer (`spaceHold`, the one answer); an admin or
 *   local token is the operator's own tooling, not the exchange, and is never held;
 * - an admitted peer request is a transfer of the space, counted in the fence for as long as its response is open, so an act
 *   registered meanwhile waits for it (and the server ends it past `INBOUND_TRANSFER_MS`).
 */
export function refusePeerSpace(
  res: import('express').Response, spaceId: string, networkId: string | undefined, authToken: unknown, door = 'sync', admit = true,
): boolean {
  const token = authToken as Record<string, unknown>;
  const peerId = peerBoundTo(token);
  if (peerId && declinedByThisMember(spaceId, networkId, peerId)) { res.status(423).json(SPACE_DECLINED_ANSWER); return true; }
  if (refusePeerReach(res, spaceId, networkId, token)) return true;
  if (!peerId) return false;
  if (!admit) {
    // A push door admits the transfer itself, after its own refusals (`pushAllowed`); the hold is still asked here.
    return spaceHold(getConfig(), spaceId, peerId, networkId) ? answerSpaceHeld(res, door) : false;
  }
  return admitPeerOnResponse(res, spaceId, peerId, networkId, door, false);
}

/**
 * A sync write door's catch, asked before the ordinary failure answer: a PEER whose request was admitted before an act
 * registered, and whose next unit met the writer's refusal, is answered `423 space_held` - what its sender classifies as a hold -
 * and never the `409` an operator's own token gets, which a sender reads as a failed transfer of the whole member (X2, CH4).
 * Returns true when it answered.
 */
export function refusePeerWrite(res: import('express').Response, err: unknown, authToken: unknown): boolean {
  const token = authToken as Record<string, unknown> | undefined;
  if (!isSpaceNotWritable(err) || !peerBoundTo(token)) return false;
  if (token && isInstanceAdmin(token as { admin?: boolean; rights?: TokenRights | null })) return false;
  return answerSpaceHeld(res, 'write');
}

/**
 * For directional networks (braintree, pubsub), reject inbound writes from
 * members whose direction is 'push'. Direction is stored from THIS instance's
 * perspective:
 *   direction='push'  → we push TO them → they must NOT push to us
 *   direction='pull'  → we pull FROM them → they may push to us (data source)
 *   direction='both'  → bidirectional → accept
 *
 * Enforcement is against an IDENTIFIED member and derived from THIS instance's
 * own membership records covering the TARGET SPACE — never from the caller-
 * supplied `networkId`, which a push-only peer could omit or point elsewhere
 * to slip past the guard. The write is space-level, so it is allowed only when
 * at least one of the caller's network relationships carrying that space
 * permits inbound flow (direction pull/both, or a non-directional type).
 *
 * A token with NO `peerInstanceId` never reaches this check on the write
 * endpoints (isNonPeerSyncWrite gates first); a peer that is a member of no
 * local network carrying the space is governed by token space scope and the
 * pending-join hold in spaceAllowed (braintree receivers legitimately do not
 * list their parent as a member).
 *
 * Returns true if the write should be REJECTED (403).
 */
export function isDirectionalWriteBlocked(spaceId: string, authToken: Record<string, unknown> | undefined): boolean {
  const peerInstanceId = peerBoundTo(authToken);
  if (!peerInstanceId) return false;
  const nets = networksHolding(spaceId, { networks: peerMemberNetworks(peerInstanceId) });
  if (nets.length === 0) return false;
  return !nets.some(n => {
    if (!isDirectionalNetwork(n)) return true;
    const member = n.members.find(m => m.instanceId === peerInstanceId);
    // direction='push' means WE push to THEM — they should not be writing to us
    return member ? member.direction !== 'push' : false;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMORIES
// ═══════════════════════════════════════════════════════════════════════════

// What an incoming record breaks in the LOCAL space's schema is judged, classified against the copy it replaced and recorded — never
// refused — by `sync/arrival-recording.ts`, once, from the page accept (`Q-93`, R6-9). It was `violationsAgainstLocalSchema` here, called
// from six sites that each decided for themselves which documents and which rules.

// Moved to `db/write-errors.ts`, which every reader of a write failure now shares; re-exported for the routes.
export { isDuplicateKeyOnly } from '../../db/write-errors.js';

/**
 * Attach the violations to a single-record ingest response — the one spelling of that rule, so every
 * single-record route reports them as `batch-upsert` does.
 *
 * Absent when empty, deliberately: a clean ingest keeps its response byte for byte.
 */
export function withSchemaViolations<T extends Record<string, unknown>>(
  body: T,
  violations: SchemaViolation[],
): T & { schemaViolations?: SchemaViolation[] } {
  return violations.length > 0 ? { ...body, schemaViolations: violations } : body;
}

/**
 * A file's metadata as it may travel: only the keys `IncomingFileMetaDoc` declares (`Q-69`).
 *
 * The stored record carries the local machinery too (`sizeBytes`, `sha256`, the vector and its model, `matchedText`,
 * `embeddingStatus`, `chunkCount`, `excerpt`). The push sent it whole and the receiver's STRICT schema refused it
 * whole, so a file's bytes replicated and its description and tags never did. The pull side handed the same record
 * straight to the merge, which `$set` every key, publishing the sender's size and hash for bytes this instance
 * derived itself. Both ends go through this one function, and the key list is read from the schema, so a key added to
 * the schema travels and a key added to the document does not.
 */
export const FILE_META_WIRE_KEYS: readonly string[] = Object.keys(IncomingFileMetaDoc.shape);
export function fileMetaForWire(doc: object): Record<string, unknown> {
  const src = doc as Record<string, unknown>;
  return Object.fromEntries(FILE_META_WIRE_KEYS.filter(k => src[k] !== undefined).map(k => [k, src[k]]));
}

/** What identifies and orders a file's metadata record: on the wire, never AUTHORED, never removable. */
const FILE_META_IDENTITY_KEYS: readonly string[] = ['_id', 'spaceId', 'path', 'author', 'createdAt', 'updatedAt', 'seq', 'parentFileId'];

/**
 * What a document says ABOUT itself on the wire rather than a field of the record: consumed at admission, never stored,
 * so never authored and never removable.
 */
export const FILE_META_WIRE_CONTROL_KEYS: readonly string[] = ['authoredKeys'];

/**
 * The AUTHORED keys of a file's metadata, as this version knows them — read out of the wire schema, never listed: the
 * optional keys of `IncomingFileMetaDoc` less identity, order and the wire's own control keys. A key added to the schema is
 * authored (and removable) from that release on; `sha256`, `sizeBytes`, `deletedAt` and every other local-only key are
 * outside it by construction, because the schema does not declare them.
 *
 * A `Set`, not a list kept to match: a peer's names are checked against it (`has`), so no name a peer chooses reaches an
 * update — `__proto__` and `constructor` included.
 */
export const FILE_META_AUTHORED_KEYS: ReadonlySet<string> = new Set(
  Object.entries(IncomingFileMetaDoc.shape)
    .filter(([k, schema]) => !FILE_META_IDENTITY_KEYS.includes(k) && !FILE_META_WIRE_CONTROL_KEYS.includes(k)
      && schema.safeParse(undefined).success)
    .map(([k]) => k));

/**
 * A file's metadata with the word that makes its ABSENCES mean something: the authored keys this version knows
 * (`authoredKeys` on `IncomingFileMetaDoc`). Every SENDER applies it — a push to a peer that takes it, and the page and
 * the read by id a peer pulls — relays included, so a removal made at A reaches C through B, who holds the document
 * without the key and says so. Never stored: the receiver consumes it (`fileMetaUpdate`).
 */
export function withAuthoredKeys<T extends object>(wire: T): T & { authoredKeys: string[] } {
  return { ...wire, authoredKeys: [...FILE_META_AUTHORED_KEYS] };
}

/**
 * A file's metadata in the shape EVERY version accepts, for a peer not known to take `authoredKeys`: the keys it
 * declares, and `tags: []` for a row with none — a v5.6.9 receiver requires `tags`, and refuses the document whole
 * without it, which drops every other edit the push carried for the file. A file whose tags were removed reaches such a
 * peer as an empty list, the one shape it can apply.
 */
export function fileMetaForOlderPeer(wire: Record<string, unknown>): Record<string, unknown> {
  const { authoredKeys: _consumed, ...rest } = wire;
  return rest['tags'] === undefined ? { ...rest, tags: [] } : rest;
}

/**
 * The authored keys an arriving document REMOVES here: those its sender lists, that this version also authors, that the
 * document lacks. A key the sender does not list is never touched (an older sender has no word on keys it never
 * heard of), and a name that is not an authored key here (`sha256`, `deletedAt`, `$where`, anything) is never returned,
 * whatever the list says.
 *
 * A RESTORE is a full record: every authored key its document lacks is removed, and it carries no list.
 */
export function removedFileMetaKeys(doc: Readonly<Record<string, unknown>>, { restore = false }: { restore?: boolean } = {}): string[] {
  const listed = restore ? [...FILE_META_AUTHORED_KEYS] : Array.isArray(doc['authoredKeys']) ? doc['authoredKeys'] as unknown[] : [];
  return [...new Set(listed)].filter((k): k is string => typeof k === 'string' && FILE_META_AUTHORED_KEYS.has(k) && doc[k] === undefined);
}

/**
 * Every key a stored file row carries that is NOT on the wire — the sender's own machinery, which a peer's
 * `GET /filemeta` page serves (a 5.6 peer serves the stored row whole, less the local-only fields).
 *
 * Typed against `FileMetaDoc` minus the wire keys, so the COMPILER holds it complete: a key added to the document
 * and to neither list fails the build rather than turning every pulled file into a strict-schema refusal. A chunk's
 * `parentFileId` is a wire key (declared `never`), so it is not here and a pulled chunk is refused, never stripped
 * into a top-level file.
 *
 * Exported for ONE reader: `the-file-field-sets-agree.test.js`, which holds this list equal to `localFileFields()`
 * (`files/derived-fields.ts`) — the same fact (the file-row keys that never travel) spelled from the wire side and from the
 * hash side, so a field added to only one of them is caught rather than served or hashed wrongly.
 */
type FileMetaWireKey = keyof typeof IncomingFileMetaDoc.shape;
export const FILE_META_SENDER_KEYS: Readonly<Record<Exclude<keyof FileMetaDoc, FileMetaWireKey>, true>> = {
  excerpt: true, matchedText: true, sizeBytes: true, sha256: true, deletedAt: true, embedding: true,
  embeddingModel: true, chunkIndex: true, headingText: true, content: true, convertedFileId: true, chunkCount: true,
  conversionError: true, mediaType: true, embeddingStatus: true, chunkOffsetMs: true, chunkDurationMs: true,
  mediaJobError: true, faceEmbedding: true, faceEntityId: true, faceBbox: true, faceScore: true,
};

/**
 * A file's metadata as a SENDER may serve it, with the sender's own machinery and every local-only field removed —
 * what the receiver validates with the strict `IncomingFileMetaDoc` (`sync/arrival-shape.ts`, `Q-225`). A key that
 * is neither a wire key nor a known part of a file row is kept, so the strict schema refuses it as it does on push.
 */
export function fileMetaFromSender(doc: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc as Record<string, unknown>)
    .filter(([k]) => !Object.hasOwn(FILE_META_SENDER_KEYS, k) && !LOCAL_ONLY_FIELDS.has(k)));
}
