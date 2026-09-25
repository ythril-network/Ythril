/**
 * Shared machinery for the /api/sync sub-routers: the incoming-document schemas, peer/space
 * authorisation, cursor codec, fork-depth and implausible-seq guards, and the strict-linkage
 * violation recorders.
 */
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { col, asFilter, asDoc, asUpdate } from '../../db/mongo.js';
import { getConfig } from '../../config/loader.js';
import { reachesSpace } from '../../auth/space-reach.js';
import { isInstanceAdmin } from '../../auth/instance-admin.js';
import { REF_KINDS } from '../../config/types-knowledge.js';
import type { KnowledgeType } from '../../config/types-knowledge.js';
import { enqueueIngestedRecord } from '../../brain/embed-queue.js';
import { isWellFormedRef, collectionForRefKind, edgeEndpointKind } from '../../brain/entity-refs.js';
import type { TokenRights } from '../../config/rights-shape.js';
import { log } from '../../util/log.js';
import { isSeqImplausible, MAX_INGEST_SEQ } from '../../util/seq.js';
import { isStrictLinkage } from '../../spaces/proxy.js';
import type { FileMetaDoc } from '../../config/types.js';
import { emitWebhookEvent } from '../../webhooks/dispatcher.js';
import type { FactDoc, EdgeDoc, LinkViolationDoc, BrainEmbedRecordType } from '../../config/types.js';

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;



/**
 * Record a link violation detected during sync ingest.
 * Fire-and-forget: violations are informational, never block sync.
 */
export async function recordLinkViolation(
  spaceId: string,
  docId: string,
  docType: LinkViolationDoc['docType'],
  field: string,
  reason: string,
  peerInstanceId: string,
): Promise<void> {
  try {
    const doc: LinkViolationDoc = {
      _id: uuidv4(),
      spaceId,
      docId,
      docType,
      field,
      reason,
      peerInstanceId,
      detectedAt: new Date().toISOString(),
    };
    await col<LinkViolationDoc>(spaceCollection(spaceId, 'linkViolations')).insertOne(asDoc<LinkViolationDoc>(doc));
    emitWebhookEvent({ event: 'link_violation.created', spaceId, entry: doc as unknown as Record<string, unknown> });
  } catch (err) {
    log.error(`Failed to record link violation for ${docType} ${docId}: ${err}`);
  }
}

/**
 * Validate an edge's from/to references against strict linkage rules.
 * Records violations but never blocks the ingest.
 *
 * Each endpoint is checked against the kind it DECLARES, with shape and collection taken from
 * `brain/entity-refs.ts` — assuming entity would record a legitimate file endpoint as two violations.
 */
export async function checkEdgeLinkViolations(
  spaceId: string,
  edge: EdgeDoc,
  peerInstanceId: string,
): Promise<void> {
  if (!isStrictLinkage(spaceId)) return;

  for (const field of ['from', 'to'] as const) {
    const val = edge[field];
    const kind = edgeEndpointKind(field === 'from' ? edge.fromKind : edge.toKind);
    if (!isWellFormedRef(kind, val)) {
      await recordLinkViolation(spaceId, edge._id, 'edge', field,
        `${field} '${val}' is not a valid ${kind} reference`, peerInstanceId);
    } else {
      const coll = `${spaceId}_${collectionForRefKind(kind)}`;
      const exists = await col<{ _id: string }>(coll).findOne(asFilter<{ _id: string }>({ _id: val }));
      if (!exists) {
        await recordLinkViolation(spaceId, edge._id, 'edge', field,
          `${field} references non-existent ${kind} '${val}'`, peerInstanceId);
      }
    }
  }
}

/**
 * Record what an arriving LINK points at that is not there.
 *
 * It only RECORDS, never throws: sync ingest is validated, counted and let in, and a refusal would hold
 * the watermark and stop the channel. An operator reads an empty violation list as "all fine", so every
 * `fromKind` is checked — no narrowing to a list of kinds here.
 *
 * A file is keyed by its path, not a UUID, so the UUID check skips `file` targets; otherwise every
 * legitimate file reference would be logged as malformed.
 */
export async function checkLinkViolations(
  spaceId: string,
  link: { _id: string; from: string; fromKind: RefKind; to: string; toKind: string } | undefined,
  peerInstanceId: string,
): Promise<void> {
  if (!isStrictLinkage(spaceId) || !link) return;

  const field = `${link.fromKind}.${link.toKind}`;
  if (link.toKind !== 'file' && !UUID_V4_RE.test(link.to)) {
    await recordLinkViolation(spaceId, link.from, link.fromKind, field,
      `${field} contains non-UUID value '${link.to}'`, peerInstanceId);
    return;
  }
  const coll = `${spaceId}_${collectionForRefKind(link.toKind as RefKind)}`;
  const exists = await col<{ _id: string }>(coll).findOne(asFilter<{ _id: string }>({ _id: link.to }));
  if (!exists) {
    await recordLinkViolation(spaceId, link.from, link.fromKind, field,
      `${field} references non-existent ${link.toKind} '${link.to}'`, peerInstanceId);
  }
}

/**
 * Write one arriving brain document and offer it to this instance's embedder — in that order, together.
 *
 * A write without the queue call yields a record absent from every meaning-ranked search on this peer,
 * silently. So this is the only thing in the ingest router that may call `replaceOne` or `insertOne` on a
 * brain collection, and `a-receiver-embeds-by-its-own-rules.test.js` fails on any that reappears.
 *
 * Always `upsert: true`: the caller has decided the document lands, and a `replaceOne` without upsert
 * silently writes nothing when the local copy was deleted meanwhile.
 *
 * Whether to embed is the RECEIVER's decision: `enqueueIngestedRecord` resolves `record > schema > space`
 * against this instance's configuration.
 */
export async function ingestBrainDoc<T extends { _id: string; suppressEmbeddings?: boolean;}>(
  spaceId: string,
  recordType: BrainEmbedRecordType | null,
  collection: string,
  incoming: T,
): Promise<void> {
  await col<T>(`${spaceId}_${collection}`).replaceOne(
    asFilter<T>({ _id: incoming._id }),
    asDoc<T>(incoming),
    { upsert: true },
  );
  /*
   * `null` means this record kind has NOTHING TO EMBED (a link carries no text) — not "skip the queue this
   * time". An explicit argument rather than a second ingest function, so a caller that embeds nothing has
   * to say `null` at the call, where a reviewer sees it.
   */
  if (recordType !== null) await enqueueIngestedRecord(spaceId, recordType, incoming);

  /*
   * No link reconcile here: links replicate as their own documents. Deriving them from an arriving record
   * would reconcile it to "no links" and delete the link rows that arrived beside it.
   */
}

// ── Safety limits ─────────────────────────────────────────────────────────

/**
 * Upper bound on any seq value accepted from a remote peer. Prevents a peer poisoning the high-water
 * mark with seq = MAX_SAFE_INTEGER, which would make later legitimate writes silently ignored.
 * 2^50 is far above any realistic counter yet keeps nextSeq() arithmetic in safe range.
 */
export const MAX_SYNC_SEQ = 2 ** 50; // 1_125_899_906_842_624

/**
 * Maximum chain depth for forkOf links — prevents a "fork chain bomb" of repeated equal-seq docs with
 * different content. Enforced twice: chain depth (walk forkOf upward) and sibling fan-out (count forks
 * of the same parent).
 */
export const MAX_FORK_DEPTH = 10;

// ── Incoming document schemas (Zod validation for peer-submitted docs) ─────

import type { RefKind } from '../../config/types-knowledge.js';
import { CHRONO_STATUSES } from '../../config/types.js';
import { validateEntity, validateEdge, validateChrono, validateFact, getSpaceMeta, type SchemaViolation }
  from '../../spaces/schema-validation.js';
import { spaceCollection } from '../../db/space-collection.js';

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
  fact: z.string(),
  tags: z.array(z.string()).max(100),
  description: z.string().optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  forkOf: z.string().optional(),
});

/**
 * A file's METADATA as a peer sends it — only the AUTHORED fields. Fields derived from the local blob
 * (`sizeBytes`, `sha256`, `excerpt`, `embedding`, `chunkCount`, `embeddingStatus`, `conversionError`,
 * `convertedFileId`, `mediaType`) are the receiver's own; chunk-only fields must not travel at all.
 *
 * `.strict()` deliberately: an undeclared key fails the push with a 400 instead of being stripped, because
 * a stripped `parentFileId` would turn a chunk into a top-level file.
 */
export const IncomingFileMetaDoc = z.object({
  // The path IS the id. Both are carried, as the document does.
  _id: z.string().min(1),
  spaceId: z.string().min(1),
  path: z.string().min(1),
  description: z.string().optional(),
  descriptionSource: z.enum(['generated', 'extracted']).optional(),
  tags: z.array(z.string()).max(100),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  /** Present only on a CHUNK: `never()` so a chunk is refused rather than stripped into a file. */
  parentFileId: z.never().optional(),
}).strict();

/**
 * Write an arriving file's metadata — a `$set` of the authored keys, NOT a whole-document replace, or the
 * receiver would report the SENDER's size and hash for bytes it derived itself, with no vector.
 *
 * `$set`, never `$unset`: an omitted key is left alone, so an older peer cannot erase a field it does
 * not know.
 *
 * Embedding is enqueued only when this instance HOLDS the blob; metadata can arrive first, and the file
 * transfer path enqueues via `upsertFileMeta` when the bytes land.
 */
export async function ingestFileMeta(spaceId: string, incoming: z.infer<typeof IncomingFileMetaDoc>): Promise<void> {
  const $set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== undefined) $set[k] = v;
  }

  const existing = await col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
    .findOne(asFilter<FileMetaDoc>({ _id: incoming._id }), { projection: { sha256: 1, sizeBytes: 1 } });

  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).updateOne(
    asFilter<FileMetaDoc>({ _id: incoming._id }),
    asUpdate<FileMetaDoc>({ $set }),
    { upsert: true },
  );

  const haveBytes = existing?.sha256 !== undefined || existing?.sizeBytes !== undefined;
  if (haveBytes) await enqueueIngestedRecord(spaceId, 'file', incoming);
}
/**
 * Apply a whole PAGE of arriving file metadata on pull, through the same merge as push (`ingestFileMeta`)
 * rather than the engine's `replaceOne` bulk write, so the two directions cannot diverge.
 *
 * A chunk is skipped, not stored: stored, it would appear in every file list as a file.
 */
export async function applyFileMetaPage(
  spaceId: string, docs: readonly (z.infer<typeof IncomingFileMetaDoc> & { parentFileId?: string })[],
): Promise<void> {
  for (const doc of docs) {
    if (doc.parentFileId !== undefined) continue;
    await ingestFileMeta(spaceId, doc);
  }
}

export const IncomingEntityDoc = z.object({
  _id: z.string().min(1),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs in order to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  tags: z.array(z.string()).max(100),
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
const RefKindSchema = z.enum(REF_KINDS);

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
  tags: z.array(z.string()).max(100).default([]),
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
  tags: z.array(z.string()).max(100).default([]),
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

export function encodeCursor(seq: number): string {
  return Buffer.from(String(seq)).toString('base64url');
}
export function decodeCursor(token: string): number {
  try { return parseInt(Buffer.from(token, 'base64url').toString(), 10) || 0; }
  catch { return 0; }
}

// ── Space access guard ─────────────────────────────────────────────────────

/**
 * Walk the forkOf chain upward from a document to measure how deep
 * this fork is in the chain.  Returns 0 for a root document.
 *
 * Uses a visited set to break any hypothetical cycle in O(depth) time.
 * Hard-caps the walk at MAX_FORK_DEPTH + 1 to avoid slow queries on
 * corrupted data.
 */
export async function forkChainDepth(spaceId: string, docId: string | undefined): Promise<number> {
  if (!docId) return 0;
  const coll = col<FactDoc>(spaceCollection(spaceId, 'facts'));
  const visited = new Set<string>();
  let depth = 0;
  let currentId: string | undefined = docId;

  while (currentId && depth <= MAX_FORK_DEPTH) {
    if (visited.has(currentId)) break; // cycle guard
    visited.add(currentId);
    const doc = await coll.findOne(asFilter<FactDoc>({ _id: currentId })) as FactDoc | null;
    if (!doc?.forkOf) break;
    depth++;
    currentId = doc.forkOf;
  }
  return depth;
}

/**
 * Refuse a document whose `seq` is implausibly far ahead of the space counter
 * (see util/seq.ts — MAX_INGEST_SEQ). Responds 400 and returns true when rejected.
 */
export function rejectImplausibleSeq(
  spaceId: string,
  seq: number,
  res: import('express').Response,
  peerInstanceId?: string,
): boolean {
  if (!isSeqImplausible(seq)) return false;
  log.warn(
    `Refused document with implausible seq ${seq} for space '${spaceId}' ` +
    `from peer '${peerInstanceId ?? 'unknown'}' (max ingest seq ${MAX_INGEST_SEQ}).`,
  );
  res.status(400).json({ error: `seq ${seq} is too close to the protocol ceiling and was refused` });
  return true;
}

/** The peer identity bound to a production peer PAT (set by the invite handshake). */
export function callerPeerId(authToken: Record<string, unknown> | undefined): string | undefined {
  const v = authToken?.['peerInstanceId'];
  return typeof v === 'string' && v ? v : undefined;
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
      return usable.some(n => n.spaces.includes(spaceId));
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
  const nets = peerMemberNetworks(peerInstanceId).filter(n => n.spaces.includes(spaceId));
  if (nets.length === 0) return false;
  return !nets.some(n => {
    if (n.type !== 'braintree' && n.type !== 'pubsub') return true;
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

/**
 * Is this write failure ONLY duplicate-key rejections — the shape two peers produce independently?
 *
 * Two peers creating the same edge independently produce one `{ from, to, label }` triplet under two ids, so
 * the receiver's upsert hits the unique index. Answering that with a 500 would stall the sender's edges
 * channel permanently (its watermark never advances past the batch).
 *
 * Only duplicates: any other write fault still throws, or genuine corruption would be hidden.
 *
 * Both shapes reach here: a single `replaceOne` rejects with `code: 11000`, while a `bulkWrite` collects
 * them into `writeErrors` with no top-level code.
 */
export function isDuplicateKeyOnly(err: unknown): boolean {
  const e = err as { code?: number; writeErrors?: Array<{ code?: number; err?: { code?: number } }> };
  const writeErrors = e?.writeErrors;
  if (Array.isArray(writeErrors) && writeErrors.length > 0) {
    return writeErrors.every(w => (w.code ?? w.err?.code) === 11000);
  }
  return e?.code === 11000;
}

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
