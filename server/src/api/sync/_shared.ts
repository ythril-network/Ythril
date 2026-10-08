/**
 * Shared machinery for the /api/sync sub-routers: the incoming-document schemas, peer/space
 * authorisation, cursor codec, and the fork-depth and implausible-seq guards.
 */
import { z } from 'zod';
import { isComparableIso } from '../../util/comparable-iso.js';
import { getConfig } from '../../config/loader.js';
import { reachesSpace } from '../../auth/space-reach.js';
import { isInstanceAdmin } from '../../auth/instance-admin.js';
import { peerRelayCaller } from '../../auth/peer-relay.js';
import { deliveryOf, type Delivery, type DeliveryAuth } from '../../sync/deletion-authority.js';
import { networksHolding } from '../../spaces/wipe-vote.js';
import { isDirectionalNetwork } from '../../networks/network-spaces.js';
import { REF_KINDS } from '../../config/types-knowledge.js';
import type { KnowledgeType } from '../../config/types-knowledge.js';
import type { TokenRights } from '../../config/rights-shape.js';
import { MAX_SYNC_SEQ } from '../../util/seq.js';
import { decodeSeqCursor, parseSeqText, type SeqPosition } from '../../util/seq-keyset.js';
import type { FileMetaDoc, AuthorRef } from '../../config/types.js';
import { LOCAL_ONLY_FIELDS } from '../../sync/local-only-fields.js';

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

import { CHRONO_STATUSES } from '../../config/types.js';
import { validateEntity, validateEdge, validateChrono, validateFact, getSpaceMeta, type SchemaViolation }
  from '../../spaces/schema-validation.js';
import { MAX_FACT_LENGTH, MAX_TAGS } from '../../util/request-bounds.js';

export const AuthorRefSchema = z.object({
  instanceId: z.string().min(1),
  instanceLabel: z.string().min(1),
});

export const IncomingFactDoc = z.object({
  _id: z.string().min(1),
  /*
   * Every `Incoming*` schema is a bare `z.object`, and zod STRIPS undeclared keys on push — so every
   * replicated (hashed) field must be declared, or push loses it while pull keeps it.
   *
   * The type selects the fact's type schema; stripped, the fact is validated against nothing and hashes
   * differently from the sender's copy for ever.
   */
  type: z.string().optional(),
  /*
   * The RECORD tier of suppression (`record > schema > space`; the other two tiers are the receiver's own
   * config). Stripped, a record its author kept out of meaning-ranked search would be embedded on every peer.
   * Optional: absent means included, and requiring it would drop suppressed facts from their batch silently.
   */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  fact: z.string().max(MAX_FACT_LENGTH),
  tags: z.array(z.string()).max(MAX_TAGS),
  description: z.string().optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  forkOf: z.string().optional(),
});

/** How many authored keys, and how long a key name, a peer's `authoredKeys` may carry (a file has a handful today). */
const MAX_AUTHORED_KEYS = 64;
const MAX_AUTHORED_KEY_LENGTH = 64;
/**
 * The longest an arriving file timestamp may be: an ISO instant in the comparable form is 24 characters, and this
 * leaves room for an offset spelling without leaving room for a payload. A bound as well as the format check, because
 * the refusal is cheaper than the regex on a megabyte of text a sender had no business sending.
 */
const MAX_TIMESTAMP_LENGTH = 40;

/**
 * A file's METADATA as a peer sends it — only the AUTHORED fields. Fields derived from the local blob
 * (`sizeBytes`, `sha256`, `excerpt`, `embedding`, `chunkCount`, `embeddingStatus`, `conversionError`,
 * `convertedFileId`, `mediaType`) are the receiver's own; chunk-only fields must not travel at all.
 *
 * `.strict()` deliberately: an undeclared key fails the push with a 400 instead of being stripped, because
 * a stripped `parentFileId` would turn a chunk into a top-level file.
 *
 * **A key the sender REMOVED is a key its document lacks, and absence says nothing on its own** (`Q-256`). The merge
 * only ever sets (`sync/file-meta-write.ts`), so an older sender's document means "these keys, and I have no word on
 * the others". `authoredKeys` is the word: the authored keys the SENDER'S version knows (`FILE_META_AUTHORED_KEYS`), so
 * a key listed and absent is a key removed, and a key it never heard of is left alone. It is wire control, never
 * stored and never re-served as stored: every sender computes it afresh from what it holds. A peer that predates it
 * REFUSES it (`.strict()`), which is why a push sends it only to a peer known to run the version that declares it
 * (`sync/push-family.ts`).
 *
 * `tags` is optional for the same reason: an operator who removes the tags leaves a row with no `tags` key, and
 * requiring one refused that file whole, so none of its other edits arrived either. An older receiver still requires
 * it, so a push to one carries `tags: []` for a row that has none.
 */
export const IncomingFileMetaDoc = z.object({
  // The path IS the id. Both are carried, as the document does.
  _id: z.string().min(1),
  spaceId: z.string().min(1),
  path: z.string().min(1),
  description: z.string().optional(),
  descriptionSource: z.enum(['generated', 'extracted']).optional(),
  tags: z.array(z.string()).max(MAX_TAGS).optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  /** The authored keys the sender's version knows — see above. Bounded: it is a peer's list, read once per document. */
  authoredKeys: z.array(z.string().max(MAX_AUTHORED_KEY_LENGTH)).max(MAX_AUTHORED_KEYS).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  /**
   * CHECKED, unlike every other family's, because a file row's timestamp became a write power (`Q-419`).
   *
   * At an equal seq a receiver adopts the author's own `updatedAt`, so this string can now change a stored row — and it
   * is a peer's string. A bare `z.string()` let a sender put anything in it: text that is not a date at all, a spelling
   * no comparison can order, or a megabyte of it. It must be an ISO instant in the fixed-width comparable form, and
   * bounded in length, before the convergence may write it.
   *
   * The other families keep `z.string()` deliberately: their `updatedAt` is replaced wholesale by a newer version and
   * is never read to decide a write, so a malformed one is the sender's own problem with its own record.
   */
  updatedAt: z.string().max(MAX_TIMESTAMP_LENGTH).refine(isComparableIso, 'not a comparable ISO timestamp'),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  /** Present only on a CHUNK: `never()` so a chunk is refused rather than stripped into a file. */
  parentFileId: z.never().optional(),
}).strict();

/*
 * An arriving file's metadata is written by the arrival writer's files branch (`sync/arrivals.ts`, `Q-107` part 2):
 * a page of guarded `$set` upserts built by `sync/file-meta-write.ts`. `ingestFileMeta`, its per-document
 * predecessor, filtered on `_id` alone, so a newer copy written between the accept read and the merge was
 * overwritten by an older one.
 */

export const IncomingEntityDoc = z.object({
  _id: z.string().min(1),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs in order to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  tags: z.array(z.string()).max(MAX_TAGS),
  description: z.string().optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
});

/**
 * The kinds an edge endpoint may declare, built from `REF_KINDS` so a new kind is not refused on the push
 * door alone.
 */
export const RefKindSchema = z.enum(REF_KINDS);

export const IncomingEdgeDoc = z.object({
  _id: z.string().min(1),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs in order to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  /**
   * Must be declared (zod strips undeclared keys on push), or a pushed edge would resolve its endpoints in
   * the wrong collection. Optional: absent means entity, as in the database.
   */
  fromKind: RefKindSchema.optional(),
  toKind: RefKindSchema.optional(),
  label: z.string(),
  type: z.string().optional(),
  weight: z.number().optional(),
  tags: z.array(z.string()).max(MAX_TAGS).default([]),
  description: z.string().optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
});

/**
 * A link record on the wire: two endpoints, their kinds, and replication bookkeeping — no suppression
 * marks, since a link has nothing to embed.
 *
 * Both kinds are REQUIRED (unlike an edge's): a link has no default kind, and an unknown endpoint kind
 * cannot be resolved.
 *
 * Every field of `LinkDoc` must be declared: all of them are hashed, and a hashed field that does not
 * replicate logs a `MERKLE_DIVERGENCE` every cycle for a space where nothing is wrong
 * (`a-replicated-field-reaches-its-incoming-schema.test.js` gates this).
 */
export const IncomingLinkDoc = z.object({
  _id: z.string().min(1),
  spaceId: z.string().min(1),
  from: z.string().min(1),
  fromKind: RefKindSchema,
  to: z.string().min(1),
  toKind: RefKindSchema,
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
});

export const IncomingChronoDoc = z.object({
  _id: z.string().min(1),
  /*
   * The content-redaction marks replicate (and are hashed): they tell "never had a description" from "it
   * lapsed". The retention STAMP behind them (`_contentExpireAt`) deliberately does not travel — it comes
   * from each instance's own policy, and shipping it would let one peer decide when another deletes data.
   */
  contentRedacted: z.boolean().optional(),
  contentRedactedAt: z.string().optional(),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs in order to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.string().min(1),
  startsAt: z.string().min(1),
  endsAt: z.string().optional(),
  // The shared tuple, never a local copy: a wrong list here would refuse a valid status and hold the
  // sync watermark on it.
  status: z.enum(CHRONO_STATUSES),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).max(MAX_TAGS).default([]),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  recurrence: z.object({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().positive(),
    until: z.string().optional(),
  }).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
});

// ── Paginated cursor helpers ─────────────────────────────────────────────────

// The cursor codec is `util/seq-keyset.ts` (`encodeSeqCursor`, `decodeSeqCursor`): the one place a position becomes
// text and back. It had a second decoder here that read a pair as nothing.

/** The one refusal text for a start a sync read cannot read. Fixed, so it never repeats what the caller sent. */
export const BAD_SYNC_START = 'sinceSeq and cursor must each be a whole number of 0 or more';

/**
 * Where a sync read starts: the `cursor` a previous page handed back when there is one, else `sinceSeq` — a position,
 * which is the pair `(seq, _id)` for a cursor and the bare seq for `sinceSeq`. A cursor wins over `sinceSeq`: a 5.6
 * client sends its `sinceSeq` CONSTANT on every request beside the cursor it echoes.
 *
 * `undefined` means the start cannot be read, and the route answers `400` with {@link BAD_SYNC_START}. It is
 * a refusal and not a default because both defaults are wrong in a way nothing reports: `sinceSeq=abc` used to
 * become `NaN`, which matches no record, so the page came back empty with `nextCursor: null` — and every client
 * reads that as "nothing left" (`Q-388`). A cursor that did not decode read as 0 and silently started over.
 */
export function syncReadStart(sinceSeq: unknown, cursor: unknown): SeqPosition | undefined {
  if (cursor !== undefined && cursor !== '') return decodeSeqCursor(cursor);
  if (sinceSeq === undefined) return { seq: 0 };
  const seq = typeof sinceSeq === 'string' ? parseSeqText(sinceSeq) : undefined;
  return seq === undefined ? undefined : { seq };
}

// ── Space access guard ─────────────────────────────────────────────────────

/** The peer identity bound to a production peer PAT (set by the invite handshake). */
export function callerPeerId(authToken: Record<string, unknown> | undefined): string | undefined {
  const v = authToken?.['peerInstanceId'];
  return typeof v === 'string' && v ? v : undefined;
}

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
  const instanceId = callerPeerId(authToken);
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

  const peerId = callerPeerId(authToken);
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
    const heldByJoinRound = cfg.networks.some(n =>
      n.pendingRounds?.some(r =>
        r.type === 'join' && r.subjectInstanceId === peerId && !r.passed));
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
  return !callerPeerId(authToken);
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
  if (!spaceAllowed(spaceId, networkId, token)) { res.status(403).json({ error: 'Forbidden' }); return null; }
  if (isNonPeerSyncWrite(token)) { res.status(403).json({ error: NON_PEER_WRITE_MESSAGE }); return null; }
  if (isDirectionalWriteBlocked(spaceId, token)) { res.status(403).json({ error: 'Directional network: write not permitted from this peer' }); return null; }
  return spaceId;
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
  const peerInstanceId = callerPeerId(authToken);
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

/**
 * Validate an incoming record against the LOCAL space's schema, and never refuse it.
 *
 * Sync checks, lets everything in, and reports what broke the rules: a peer validated these records against
 * ITS schema, so a refusal would discard data the sender believes it delivered. Violations go back to the
 * caller (batch stats, or beside the stored document via `withSchemaViolations`), not to a log line.
 */
export function violationsAgainstLocalSchema(
  spaceId: string,
  kind: KnowledgeType,
  doc: Record<string, unknown>,
): SchemaViolation[] {
  const meta = getSpaceMeta(spaceId);
  if (!meta) return [];
  const properties = doc['properties'] as Record<string, unknown> | undefined;
  const type = typeof doc['type'] === 'string' ? doc['type'] : undefined;
  switch (kind) {
    case 'entity':
      return validateEntity(meta, { name: doc['name'] as string, type, properties });
    case 'edge':
      return validateEdge(meta, { label: doc['label'] as string, properties });
    case 'chrono':
      return validateChrono(meta, { type, properties });
    case 'fact':
      return validateFact(meta, { type, properties });
  }
}

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
const FILE_META_WIRE_KEYS = Object.keys(IncomingFileMetaDoc.shape);
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
