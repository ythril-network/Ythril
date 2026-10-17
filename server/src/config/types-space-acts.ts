/**
 * The act entry: one deletion, wipe or rename of a space this instance has to carry out, written to `config.json` the moment the act
 * becomes owed or queued (bundle-106, design v5 §2.6, X1).
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

/** What an act does to its space. */
export type SpaceActKind = 'delete' | 'wipe' | 'rename';

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
    /** Receive marks to forget for these (network, local space) pairs, so the wiped space is read again from the start. */
    forgetReceiveMarks?: { networkId: string; localSpaceId: string }[];
  };
  registeredAt: string;
  state: SpaceActState;
  /** The act's ONE retry clock: failed attempts so far and when the next is due. */
  attempts: number;
  retryAt?: string;
  /** Our sentence for the last failure, never a driver's text. */
  lastError?: string;
}
