/**
 * Network and sync types: topology, membership, and the vote rounds that govern a shared space.
 *
 * ## Why this is a separate file
 *
 * Q-3, slice 2. `types.ts` is the config contract for every subsystem — spaces, networks, media, embedding, auth,
 * sync — and it took FOUR god-file ratchet raises in two days, each individually correct and each one line of
 * honest type. The gate's own comment said a fifth should be a split instead.
 *
 * ## Why the leaf had to come first
 *
 * This exact move was attempted before slice 1 and **reverted**. `NetworkConfig` references `SpaceMeta`, which
 * belongs to spaces. With `types.ts` re-exporting this file and this file importing `SpaceMeta` back from
 * `types.ts`, that is a module cycle — TypeScript resolved it by degrading `NetworkConfig` to `any`, and
 * `api/invite.ts` silently lost the types on three `members` callbacks while every file in the diff compiled
 * clean.
 *
 * So `SpaceMeta` moved to `types-knowledge.ts` first (slice 1, #774), a leaf that imports nothing. This file
 * imports it **from the leaf**, never from `types.ts`. That is the whole reason the two slices are in this order,
 * and the reason to check `grep -c "TS7006"` on a full build rather than trusting a green compile of the moved
 * files.
 *
 * Re-exported from `types.ts`, so no importer changes.
 */
import type { SpaceMeta } from './types-knowledge.js';

// ── Network types ──────────────────────────────────────────────────────────

export type NetworkType = 'closed' | 'democratic' | 'club' | 'braintree' | 'pubsub';
export type SyncDirection = 'both' | 'push' | 'pull';
export type VoteValue = 'yes' | 'veto';
export type VoteRoundType = 'join' | 'remove' | 'space_deletion' | 'space_wipe' | 'meta_change' | 'space_addition';

export interface NetworkMember {
  instanceId: string;
  label: string;
  url: string;
  tokenHash: string;         // bcrypt of the token this instance uses to auth inbound from peer
  direction: SyncDirection;
  lastSyncAt?: string;       // ISO8601 — set only on successful sync
  lastSeqReceived?: Record<string, number>;  // spaceId → last seq ingested from this peer
  lastSeqPushed?: Record<string, number>;    // spaceId → last seq we confirmed pushed to this peer
  /** spaceId → the newest `deletedAt` among FILE tombstones this peer has answered 200 to on a push.
   *  File tombstones carry no `seq`, so their retention floor is built from acknowledgement rather than from a
   *  served position (see `sync/file-tombstone-ack.ts`). Only a 200 may advance it: a direction-blocked peer
   *  that 403s has NOT taken the deletion, and pruning on a rejected push is how a deleted file comes back. */
  lastFileTombstoneAckedAt?: Record<string, string>;
  /** spaceId → the highest `sinceSeq` this peer has pulled OUR tombstones from, i.e. the position it has
   *  confirmed applying. The mirror of the two above: they are our position in the peer's data, this is the
   *  peer's position in ours, and without it a tombstone can never be safely dropped (see
   *  `sync/served-watermark.ts`). Monotonic; absent means "never pulled", which blocks pruning. */
  lastSeqServed?: Record<string, number>;
  consecutiveFailures?: number;  // incremented on each failed sync; reset to 0 on success
  parentInstanceId?: string; // braintree only
  /** Set during a temporary reparent; stores the original parent so it can be restored. */
  originalParentInstanceId?: string;
  children?: string[];       // instanceIds of direct children (braintree)
  skipTlsVerify?: boolean;   // non-default; UI shows security warning when true
  /** Ed25519 public key (SPKI PEM) used to verify this member's signed vote casts.
   *  Trust-on-first-use: pinned the first time we learn it via member gossip / invite;
   *  a later attempt to change it to a different key is rejected. */
  signingPublicKey?: string;
  /** The version this member last reported, learned from member gossip — its own announce, or the
   *  self-record piggybacked on its reply to ours. Checked against `MIN_PEER_VERSION`
   *  (`sync/peer-floor.ts`) before any data flows either way.
   *
   *  **Absent means BELOW the floor, never exempt from it.** A member that has never reported a
   *  version predates the release that started reporting one, so the optionality here is a fact about
   *  old peers rather than permission for them — `peerFloorRefusal(undefined)` returns a refusal. */
  version?: string;
  /** ISO8601 of the last COMPLETED member-gossip exchange with this peer, set whether or not a
   *  version came back with it.
   *
   *  **This is what makes `version` interpretable.** Absent `version` means two completely different
   *  things: a peer that answered and reported nothing (so it predates version reporting, and is
   *  below the floor), or a peer we have simply never exchanged with (so we know nothing). Without
   *  this stamp both look identical, and treating them the same refuses every member of an
   *  asymmetric or manually-provisioned network for ever. */
  versionCheckedAt?: string;
}

/**
 * The member fields keyed BY SPACE ID — the watermarks a space rename has to carry across.
 *
 * ## Why the list exists, and why it lives next to the type rather than at its one caller
 *
 * `applySpaceRenameToConfig` carried these with one `if` block per field: the same rule written four times,
 * and the failure of a missed copy is silent by construction. A watermark that is not carried resets to
 * "unknown", which is SAFE — the pull re-reads from 0, idempotent by seq, and the retention floors simply
 * stop pruning. Nothing errors and nothing is lost, so nobody would ever report it.
 *
 * A fifth per-space watermark is added HERE, to the interface above, by somebody who has no reason to open
 * `spaces/rename.ts`. The list sitting beside the fields is what puts the decision in front of them, and
 * `file-tombstone-ack.test.js` reads the interface's own source to check nothing has been added to it and
 * left out of this.
 */
export const PER_SPACE_WATERMARKS = [
  'lastSeqReceived', 'lastSeqPushed', 'lastSeqServed', 'lastFileTombstoneAckedAt',
] as const satisfies readonly (keyof NetworkMember)[];

export interface VoteCast {
  instanceId: string;
  vote: VoteValue;
  castAt: string;            // ISO8601
  /** Base64 Ed25519 signature by `instanceId` over the canonical vote message
   *  (see util/signing.ts). Present on casts created by signing-capable brains;
   *  absent on legacy/unsigned casts (accepted only via the own-cast path). */
  sig?: string;
}

export interface VoteRound {
  roundId: string;
  type: VoteRoundType;
  subjectInstanceId: string;
  subjectLabel: string;
  subjectUrl: string;
  deadline: string;          // ISO8601
  openedAt: string;          // ISO8601
  votes: VoteCast[];
  inviteKeyHash?: string;    // bcrypt of invite key (join rounds only)
  concluded?: boolean;
  passed?: boolean;          // true if concluded and the motion carried; false if vetoed/expired
  pendingMember?: NetworkMember;  // stored on join rounds; added to members when vote passes
  spaceId?: string;              // populated for space_deletion, space_wipe, meta_change and space_addition rounds (space_addition: the NETWORK's id for it)
  /**
   * Which collections a `space_wipe` round will empty, or absent for all five.
   *
   * Carried ON THE ROUND rather than resolved at conclusion, because a partial wipe is what the members
   * voted for. Resolving it later — from a request that no longer exists, or by defaulting to everything —
   * would let a round approved for `files` conclude by emptying the knowledge graph.
   */
  wipeTypes?: string[];
  pendingMeta?: SpaceMeta;       // stored on meta_change rounds; applied when vote passes
  /**
   * Top-level `meta` fields the proposer changed (meta_change rounds).
   *
   * Conclusion applies only these, re-merged into whatever the meta says at that moment, so two rounds
   * that touch different fields no longer overwrite each other — `pendingMeta` is a full snapshot of the
   * meta as it stood when the round opened, and applying it wholesale silently reverts anything that
   * concluded in between. See `sync/meta-round-merge.ts`.
   */
  metaChangedFields?: string[];
  /**
   * The space's `meta.version` the proposal was computed against (meta_change rounds).
   *
   * Rounds gossip, so this is absent on any round proposed by a peer predating field-merge — and that
   * absence is the compatibility switch: such a round applies wholesale, exactly as before. It cannot
   * field-merge, because the changed-field list it never recorded would merge nothing at all.
   */
  baseMetaVersion?: number;
  /**
   * A proposal for ONE network's layer rather than an edit of the proposer's own definitions (meta_change rounds,
   * `F-39.5`). Passed, it lands in that network's layer on every member — the proposer included, which is the only
   * instance it changes anything for: everyone else stores a passed meta_change as the network's layer anyway.
   */
  proposesLayer?: boolean;
  /**
   * LOCAL: this instance has already applied this concluded space round (`S-9`), so gossip handing it the same round
   * again does nothing. Never taken from a peer: adopting a round and serving one both strip it.
   */
  appliedHere?: boolean;
  /**
   * LOCAL: this instance opened the round (`S-7`). Never inferred from `subjectInstanceId`, which a peer sets, and
   * never taken from or served to a peer — `networks/round-local-state.ts` is the only writer.
   */
  proposedHere?: boolean;
  requiredVoters?: string[];     // braintree only: instanceIds that must ALL vote yes
}

/**
 * The two fields a space carries once it is in a network that sends schema (F-39.2). Here rather than inline in
 * `SpaceConfig` because they exist for the networks, and `types.ts` is on the god-file ratchet.
 */
export interface SpaceSchemaLayering {
  /** This instance's own definitions, kept apart once a network layer arrives; absent = `meta` is all its own. */
  ownMeta?: SpaceMeta;
  /** Network ids, highest precedence first; absent or partial = the order the networks were joined. */
  networkPrecedence?: string[];
}

export interface NetworkConfig {
  id: string;
  label: string;
  type: NetworkType;
  spaces: string[];          // space IDs scoped to this network
  /**
   * Which token established each membership — `spaceId` -> token id.
   *
   * A PARALLEL map rather than a field on the membership, because `spaces` is a plain `string[]` on every
   * instance in the field. Turning it into objects would be a breaking migration of live config for a value
   * that is absent on every existing row anyway.
   *
   * **Absent means unknown, and unknown FAILS CLOSED.** Memberships that predate this field cannot prove
   * whose they are, so leaving one requires the Networks admin rung rather than the write rung. That is the
   * safe direction: a token that cannot dismantle somebody else's topology asks for help, while one that can
   * does it silently. See `mayLeaveNetwork` in `auth/network-membership.ts`.
   */
  spaceOrigins?: Record<string, string>;
  /**
   * The id of the token that joined or created this network here (S-9). It is the authority for what the network may add later:
   * an upstream's announcement of a new space is adopted only if this token could have joined it. Local, never sent
   * to a peer. Absent on a network joined before it was recorded, which then adopts nothing without the operator.
   */
  joinedBy?: string;
  /**
   * Spaces an upstream announced that were NOT adopted, each with why (S-9): the joining token could not have joined
   * it, the joiner is unknown, or a local space already has that id. The operator accepts or maps one explicitly.
   */
  pendingSpaces?: { networkId: string; localId: string; why: string; from: string; at: string }[];
  /**
   * Network space ids the operator dismissed from `pendingSpaces`. An announcement or a passed round never proposes
   * one again — dismissing is an answer, not a snooze — and accepting one later is still possible by its id.
   */
  dismissedSpaces?: string[];
  /** Maps remote (peer-side) space IDs to local space IDs.
   *  Used when a local space was renamed after joining, or when the joiner chose
   *  a different local ID to avoid a collision.  The sync engine uses this to
   *  translate between peer space IDs on the wire and local collection/file IDs.
   *  Key = remote space ID, Value = local space ID. */
  spaceMap?: Record<string, string>;
  /**
   * F-39.2: this network's governed meta for each LOCAL space id, as last received from it (the upstream's
   * `GET /api/sync/meta`). Local state: it is what lets a space in two networks keep each network's definitions
   * apart, apply them in precedence, and send each network only its own. See `spaces/effective-meta.ts`.
   */
  schemaLayers?: Record<string, SpaceMeta>;
  votingDeadlineHours: number;
  merkle?: boolean;
  /** When true, governance vote casts must carry a valid Ed25519 signature from
   *  the voting member (verified against its pinned signingPublicKey). Enable
   *  once every member has published a signing key. Default (false/undefined)
   *  runs in compatibility mode: signed casts are verified and relay-safe, while
   *  unsigned casts are accepted only directly from the voter (never relayed). */
  requireSignedVotes?: boolean;
  members: NetworkMember[];
  pendingRounds: VoteRound[];
  syncSchedule?: string;     // cron expression; omit = manual only
  inviteKeyHash?: string;    // bcrypt of current active invite key
  createdAt: string;
  /** Braintree only: this instance's parent instanceId in the network tree.
   *  When unset this instance is treated as the root. */
  myParentInstanceId?: string;
  /**
   * Whether THIS instance created the network or joined it (`F-38.1`). Local, like the rest of this record: it is
   * what makes a club's creator its organiser. Absent on networks stored before it existed, which read as joined.
   */
  origin?: 'created' | 'joined';
  /** Set on THIS instance when it has been temporarily re-parented in a braintree.
   *  Cleared when the reparent is made permanent (`adopt`) or reverted. */
  temporaryReparent?: {
    newParentInstanceId: string;      // grandparent that adopted us
    originalParentInstanceId: string; // offline intermediate we bypassed
    reparentedAt: string;             // ISO8601
  };
}
