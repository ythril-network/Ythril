/**
 * The act entry: one deletion, wipe, rename, restore or migration of a space this instance has to carry out, written to `config.json`
 * the moment the act becomes owed or queued (bundle-106, design v5 §2.6, X1). The kinds and what each declares are ONE record,
 * {@link SPACE_ACT_KINDS} (bundle-157).
 *
 * ## Why it is on disk and not in memory
 *
 * A queued act that lived only in memory closed nothing until its body began and was lost by a restart: a wipe concluded, the instance
 * went down, and the space came back taking writes with the round still owed — or, worse, the round marked applied with nothing
 * deleted. The entry is written in the SAME save as the conclusion that makes the act owed, so from that write on the space is closed to
 * writes and held from exchanges (`spaceActStands`, `spaces/space-act-runner.ts`), and the next start finds the entry and finishes it.
 *
 * ## One entry per act, never one per space
 *
 * A `files` wipe and a later `facts` wipe of one space are two entries: completing one clears only its own, so a failed `files` wipe is
 * never erased by a later wipe of other types. Only the runner reads or removes entries; a rename's commit rewrites `localId`.
 *
 * Declared here rather than in `types.ts` because that file is frozen by the size ratchet; it re-exports these names.
 */
import type { BrainCollection } from './types-knowledge.js';

/** The lane an act's body runs in: one body at a time per lane (`spaces/space-act-runner.ts`, "Lanes"). */
export type SpaceActLane = 'space-op' | 'wipe' | 'restore';

/** The fields of a request that make two requests the same act, besides its kind and space. */
export type SpaceActKeyField = 'types' | 'networkId' | 'newId';

/** What every kind of act declares about itself. */
export interface SpaceActKindSpec {
  /** Where its body runs. */
  readonly lane: SpaceActLane;
  /** The code a local write to its space is refused with while it stands (`spaces/space-write-gate.ts`). */
  readonly writeRefusalCode: string;
  /** Our sentence for that refusal, completing "Space 'x' takes no writes while ...". */
  readonly writeRefusalWhy: (act: { newId?: string }) => string;
  /** The act stands on every space of the instance at once (a restore, a migrate), not on one space for its own sake. */
  readonly instanceWide: boolean;
  /** The request fields that, with the kind and the space, make two requests one act; only these are stored on its entry. */
  readonly keyFields: readonly SpaceActKeyField[];
  /** The member-mark step its registration computes from the networks carrying the space, or null when it forgets no mark. */
  readonly forgetsMarks: keyof SpaceActEntry['postSteps'] | null;
}

/**
 * EVERY kind of act, and what each declares: THE list, read at runtime by the runner (its lane, its key, its post-step, its counters) and by
 * the write gate (its refusal), so no reader keeps a switch of its own over the kinds.
 *
 * ## What it prevents
 *
 * The kinds were a type union and every reader spelled its own `if` per kind. A kind added to the union was a kind the write gate had no
 * `if` for: its act stood for the space, `refusalFor` matched none of the three it knew, and the write landed in a space about to be
 * replaced (bundle-157, R3.1). Here a kind without a refusal code, a lane or a key does not compile, and `SpaceActKind` is derived from
 * this record, so there is no second list to forget.
 *
 * `restore` and `migrate` stand on every space of the instance (`instanceWide`) and share the `restore` lane, apart from the space-op
 * and wipe lanes, so a restore set never waits behind a long wipe of one space and never runs two bodies at once.
 */
export const SPACE_ACT_KINDS = {
  delete: {
    lane: 'space-op', writeRefusalCode: 'space_being_deleted', writeRefusalWhy: () => 'it is being deleted',
    instanceWide: false, keyFields: ['networkId'], forgetsMarks: null,
  },
  wipe: {
    lane: 'wipe', writeRefusalCode: 'space_being_wiped', writeRefusalWhy: () => 'it is being wiped; retry once the wipe completes',
    instanceWide: false, keyFields: ['types'], forgetsMarks: 'forgetReceiveMarks',
  },
  rename: {
    lane: 'space-op', writeRefusalCode: 'space_being_renamed',
    writeRefusalWhy: (act) => `it is being renamed to '${act.newId ?? ''}'; retry under the new id once the rename completes`,
    instanceWide: false, keyFields: ['newId'], forgetsMarks: null,
  },
  restore: {
    lane: 'restore', writeRefusalCode: 'space_being_restored',
    writeRefusalWhy: () => 'the instance is being restored from a backup; retry once the restore completes',
    instanceWide: true, keyFields: [], forgetsMarks: 'forgetReceived',
  },
  migrate: {
    lane: 'restore', writeRefusalCode: 'space_being_migrated',
    writeRefusalWhy: () => 'the instance is being copied to another database; retry once the migration completes',
    instanceWide: true, keyFields: [], forgetsMarks: null,
  },
} as const satisfies Record<string, SpaceActKindSpec>;

/** What an act does to its space: a key of {@link SPACE_ACT_KINDS}, and nothing else. */
export type SpaceActKind = keyof typeof SPACE_ACT_KINDS;

/** Every kind, in the record's order. */
export const SPACE_ACT_KIND_NAMES = Object.keys(SPACE_ACT_KINDS) as SpaceActKind[];

/** The code a write is refused with while an act stands for its space: one per kind. */
export type SpaceWriteClosedCode = (typeof SPACE_ACT_KINDS)[SpaceActKind]['writeRefusalCode'];

/**
 * Does an act of `kind` stand for the whole instance? THE one predicate for that set (a restore, a migrate): maintenance, the backup
 * refusal, the second-restore refusal and the "whole instance" text all ask it, so the set is written once (bundle-157, R5.1).
 */
export function isInstanceWide(kind: SpaceActKind): boolean {
  return SPACE_ACT_KINDS[kind].instanceWide;
}

/** A count per kind, every kind present, each starting at `n`. */
export function perSpaceActKind(n: number): Record<SpaceActKind, number> {
  return Object.fromEntries(SPACE_ACT_KIND_NAMES.map(k => [k, n])) as Record<SpaceActKind, number>;
}

/** Where an act stands: waiting for its turn, waiting for its space's transfers to end, in its body, or failed and due again at `retryAt`. */
export type SpaceActState = 'registered' | 'draining' | 'running' | 'owed';

/** One round an act carries out, by the network that holds it. */
export interface SpaceActRound { networkId: string; roundId: string }

/** What the completion does in the same write that removes the entry. */
export type SpaceActPostSteps = SpaceActEntry['postSteps'];

export interface SpaceActEntry {
  /** The runner's handle (a uuid). */
  id: string;
  kind: SpaceActKind;
  /** The space acted on, by this instance's id; a rename's commit rewrites it to the new id. */
  localId: string;
  /** A wipe's covered collections, canonical (deduplicated, in `BRAIN_COLLECTIONS` order); absent = all of them. */
  types?: BrainCollection[];
  /** A deletion's network, whose round it carries out; absent = this instance's own (solo) deletion. */
  networkId?: string;
  /** A rename's new id. */
  newId?: string;
  /** Every round this act carries out; a round that joins the act is appended in the same save. */
  rounds: SpaceActRound[];
  /** What the completion does in the same write that removes the entry. */
  postSteps: {
    /**
     * EVERY mark each member holds for these (network, local space) pairs is forgotten (`forgetEveryMark`), so the wiped space is read
     * again from the start. The key keeps its 5.x name although it forgets more than receive marks: an entry written before an upgrade
     * holds this key, and reading it as "receive marks only" would make that wipe forget less than it promised.
     */
    forgetReceiveMarks?: { networkId: string; localSpaceId: string }[];
    /**
     * Only what was RECEIVED is forgotten for these pairs (`forgetWhatWasReceived`, `RECEIVE_MARKS`): a restore went back to an older
     * snapshot, so the peers send again what arrived after it, and what this instance sent or had acknowledged is kept.
     */
    forgetReceived?: { networkId: string; localSpaceId: string }[];
  };
  registeredAt: string;
  state: SpaceActState;
  /** The act's ONE retry clock: failed attempts so far and when the next is due. */
  attempts: number;
  retryAt?: string;
  /** Our sentence for the last failure, never a driver's text. */
  lastError?: string;
  /**
   * The last failure was the act's INPUT (a backup that is not whole, a unique index the backup's own records refuse): another attempt
   * meets the same input, so nothing retries it, and the space stays held until an operator abandons the act (bundle-157, R5.5).
   */
  needsAbandon?: true;
  /** The act set this entry is one member of (`spaceActSets`), for a kind that stands on every space at once. */
  setId?: string;
  /** A restore's backup, by id under the backups root; never a path, which is resolved again (and checked) when the body runs. */
  backupId?: string;
}

/** Where one member of an act set stands: its entry still stands, its act completed, or the set was abandoned before it did. */
export type SpaceActSetMemberState = 'standing' | 'done' | 'abandoned';

/** One space of an act set, as the set's record keeps it after the member's entry is gone. */
export interface SpaceActSetMember {
  state: SpaceActSetMemberState;
  completedAt?: string;
  /** What the member's body reported (a restore's index results), kept for the report. */
  report?: Record<string, unknown>;
}

/**
 * An act set: ONE act of a kind that stands on every space at once (a restore), registered as one entry per space in one config write
 * (bundle-157, R5.1). The entries hold and run each space; this record is what is true of the whole - which spaces it covers, which are
 * done, how it ended - so a report, maintenance and the end-of-set work read one record rather than counting entries that are removed as
 * they complete. One record per kind is kept: the standing set, or the last one that ended, until the next set of its kind replaces it.
 */
export interface SpaceActSet {
  id: string;
  kind: SpaceActKind;
  startedAt: string;
  /** Set when the last member ended (completed or abandoned). */
  endedAt?: string;
  outcome?: 'completed' | 'abandoned';
  backupId?: string;
  members: Record<string, SpaceActSetMember>;
  /** A restore: the served spaces the backup does not hold, emptied by their acts. */
  emptied?: string[];
  /** A restore: the spaces the backup holds that this instance does not serve, left out at the operator's word (`leaveOut`). */
  leftOut?: string[];
}
