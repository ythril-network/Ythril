/**
 * What a create/converge write DECIDES, separated from what it WRITES (`Q-99` part 3).
 *
 * ## Why the split exists
 *
 * A fact, entity, chrono entry or edge write used to be one function that read, decided and wrote — so a batch
 * of 500 was 500 of them, each paying its own round trips (about five per fact, ten per edge, measured), and a
 * batch could not share a read or a seq allocation without growing a second write path beside the first.
 *
 * Now each writer is a PLANNER (`plan-*.ts`) and one COMMIT (`commit.ts`). A planner takes an item and a read set
 * and returns a `WritePlan`: every rule has been applied, every refusal raised, every default filled, and the
 * record as it will be stored is in hand. The commit writes plans — one, for a single-record door; hundreds, for
 * a batch — allocating their seqs and writing each collection in one round trip. The rules exist once, and a
 * single write and a bulk write are the same code with a different count.
 *
 * ## What a plan is NOT allowed to hold
 *
 * A seq. Seqs are allocated by the commit immediately before the write that carries them, because everything
 * awaited between allocation and write holds every seq-paged reader of the space (`util/seq.ts`, `Q-196`).
 */
import type { KnowledgeType, RefKind } from '../../config/types-knowledge.js';
import { COLLECTION_SUFFIX } from '../../config/types-knowledge.js';
import type { AuthorRef } from '../../config/types.js';
import type { DesiredLinks } from '../links.js';

/** The record kinds a plan can be for — the knowledge types, derived. */
export type PlanKind = KnowledgeType;

/**
 * Per kind: where its records live and when, in a commit, they are written.
 *
 * The ORDER is the batch contract — facts, entities, chrono, then edges — so an edge can name a record of any
 * kind the same commit writes, and an entity addressed by id is written before an edge reads it. A table rather
 * than a switch in the commit: a fifth kind is a row here, not a branch in every function that walks plans.
 */
export const PLAN_KINDS = {
  fact: { collection: COLLECTION_SUFFIX.fact, rank: 0 },
  entity: { collection: COLLECTION_SUFFIX.entity, rank: 1 },
  chrono: { collection: COLLECTION_SUFFIX.chrono, rank: 2 },
  edge: { collection: COLLECTION_SUFFIX.edge, rank: 3 },
} as const satisfies Record<PlanKind, { collection: string; rank: number }>;

/** The kinds in commit order, derived from the ranks. */
export const COMMIT_ORDER: readonly PlanKind[] = (Object.keys(PLAN_KINDS) as PlanKind[])
  .sort((a, b) => PLAN_KINDS[a].rank - PLAN_KINDS[b].rank);

/** The link rows a written record should end up with — reconciled by the commit after the record lands. */
export interface PlannedLinks {
  fromKind: RefKind;
  desired: DesiredLinks;
  author: AuthorRef;
}

/**
 * One decided write.
 *
 * `insert` carries the whole document; `converge` the `$set`/`$unset` that bring an existing record to what the
 * write says. Neither carries `seq` — see the module docblock.
 */
export interface WritePlan {
  readonly kind: PlanKind;
  /** The space the plan was decided against. The commit refuses a plan for another space. */
  readonly spaceId: string;
  /** The record's identity: minted by the planner on insert (ID IS ID), the stored one on converge. */
  readonly id: string;
  readonly op: 'insert' | 'converge';
  /** insert: the document as it will be stored, `seq` aside. */
  readonly doc?: Record<string, unknown>;
  /** converge: the fields to set (`seq` aside) and to unset. */
  readonly set?: Record<string, unknown>;
  readonly unset?: Record<string, unknown>;
  /**
   * converge: the seq the record had when this plan was decided. The update lands only if it still does, so a
   * write that raced in between is detected rather than overwritten — and the commit re-plans against it.
   * `null` for a stored record that has no seq at all.
   */
  readonly expectSeq?: number | null;
  /** The record as it will stand once written, `seq` aside — what a single-record door answers with. */
  readonly result: Record<string, unknown>;
  /** Queue an embed job once the record lands. False when suppressed, or when the planner embedded inline. */
  readonly enqueue: boolean;
  /** Reconcile link rows once the record lands. Absent: this write names no link class. */
  readonly links?: PlannedLinks;
  /**
   * True when `id` was minted by this plan. A record minted this instant has no link rows, so a commit that
   * would read them to diff against can skip the read. Set by the planner that minted, never by a door.
   */
  readonly minted: boolean;
  /** Run the space's insert-time duplicate rules once the record lands (`dupeRulesOnInsert`). */
  readonly dupeRules: boolean;
  /** Indexes of plans in the same commit this one needs written first — a `$ref` end, a connection edge's source. */
  readonly dependsOn?: readonly number[];
}

/**
 * A single-record write that could not land because another write kept changing its record — answered 409 on
 * both doors (`app.ts`, `mcp/call-tool.ts`).
 *
 * The commit re-plans a write whose record moved once, against a fresh read; this is the second time. Nothing
 * was written, and retrying is the remedy, which is what 409 says.
 */
export class WriteConflict extends Error {
  constructor(readonly recordKind: PlanKind, readonly recordId: string) {
    super(`the ${recordKind} '${recordId}' was changed by another write while this one was being applied, twice; `
      + 'nothing was written — retry it');
    this.name = 'WriteConflict';
  }
}

/** What the commit did with one plan. */
export type CommitOutcome =
  /** `linksAdded`: link rows the reconcile created for this record — what a batch reports as connections. */
  | { readonly ok: true; readonly seq: number; readonly linksAdded?: number }
  | { readonly ok: false; readonly reason: string; readonly stale?: boolean };
