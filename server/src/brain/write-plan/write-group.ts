/**
 * A GROUP of planned inserts and converges lands in ONE bounded transaction, or not at all (`Q-760`, D-73 a16 and b4).
 *
 * ## The question it answers
 *
 * *"Write all of these plans, or none of them."* Asked by a request that must land whole — a SPARQL Update (`Q-761`). `commitPlans`
 * (`commit.ts`) answers a different question, "write what can be written and say what happened to each", and keeps its promise never to throw
 * once something landed; the two share the one stage writer (`writeStage`), so a create or converge still reaches a record collection in
 * `commit.ts` alone.
 *
 * ## How
 *
 * Before a session opens: every plan is for this space and names a distinct (kind, id) (a delete of an edge the group also converges is dropped:
 * one record, written once; any other record planned twice is refused `409 write_group_record_planned_twice`); the link rows the group removes
 * are counted (one count per delete kind, and the stored rows the converges drop), and the group is inside its ceilings
 * (`GROUP_MAX_RECORDS`, `GROUP_MAX_OPERATIONS`, `GROUP_MAX_BYTES`, refused `413 write_group_too_large` naming the one it passed); and the
 * write gate admits every family the group writes (`admitSpaceWriteUnit`, left in a `finally`). Then one `inHeldTransaction`, the position
 * floor held throughout, runs the callback:
 *
 *  - the deletes first (`Q-963`, `planDelete`), edges before the records they join and a deleted fact's or chrono entry's link rows before
 *    it, each record removed only at the version it was planned against (`removeInSession`), so a swap at a functional subject frees the
 *    unique guard before its successor takes it;
 *  - each kind's stage through `writeStage` with the session, in commit order; the link rows through `reconcileLinkRows` with the session;
 *  - last, the delete guard over the group's own result (`deleteBlockersOfEach`, with the session): a deleted record something still
 *    names aborts the group `referenced`, naming the blockers — no implicit cascade (owner D-91);
 *  - **every error is thrown as it came**, its labels kept: a write conflict (`TransientTransactionError`) re-runs the callback from the top;
 *  - **a duplicate key, a version at the ceiling, or a short count** (a converge whose record moved since it was planned matches nothing,
 *    and says so only in `matchedCount`) throws `GroupAborted`, which aborts the transaction: nothing lands;
 *  - the callback is safe to run again: it takes fresh versions and positions each run and keeps nothing outside its return value. It runs at
 *    most `GROUP_MAX_TRIES` times; a further run is refused `GroupAborted('retries')`.
 *
 * After the commit, and only then, `runAfterCommit` takes back what names an entity removed meanwhile, queues the embed jobs and runs the
 * duplicate rules; the deleted records get the tail every removal gets (`afterRemovalCommitted`, shared with `removeRecords`), its take-back
 * of what was written to a deleted entity meanwhile counted from `began`, the position each run took before its first write. A take-back removes a row the group landed: it is REPORTED (`takenBack`), since no transaction can close that race (the
 * take-back's handshake needs the write visible, `gone-entity-references.ts`). A failed effect is returned in `failedEffects`, never silent.
 *
 * ## A commit whose reply is lost
 *
 * A commit may land and fail on the wire. The callback's value names a MARKER: one row the group inserted (an inserted record, else an added
 * link row), stamped with this run's version — never a converged row, which existed before and proves nothing. The bound reads it back inside
 * the hold: found, the group is answered as written. Not found, nobody can say what happened: `WriteGroupOutcomeUnknown`, a store-side
 * failure (`StoreTimeout`, so every door answers it 503 retryable through the store-failure classification), never "nothing landed". A group
 * with nothing inserted has no marker and always answers outcome unknown on a lost reply.
 *
 * ## What it prevents, and the part a caller cannot drop
 *
 * **A partial request.** `commitPlans` writes stage by stage with no transaction; a failure part-way leaves part of a request written.
 * **A write outside the transaction.** A write made inside the callback without the session lands at once and survives the abort (probe E4):
 * every writer here takes the session by parameter, and `a-write-group-lands-whole-or-not-at-all-db` watches every write in the window.
 * **A group the store cannot take.** The server rolls back an oversized transaction with a TRANSIENT label (probe E5), which the bound would
 * retry until its deadline, holding every position-paged reader of the space: the ceilings refuse it before a session opens.
 */
import type { ClientSession } from 'mongodb';
import { operationBytes } from '../../db/one-command.js';
import { StoreTimeout } from '../../db/write-timeout.js';
import { carriesErrorLabel } from '../../db/store-condition.js';
import { isDuplicateKey } from '../../db/write-errors.js';
import { inHeldTransaction } from '../held-transaction.js';
import { linkIdFor } from '../link-id.js';
import { admitSpaceWriteUnit, isSpaceNotWritable } from '../../spaces/space-write-gate.js';
import { writeGroupAbortsTotal } from '../../metrics/write-group-metrics.js';
import { log, peerText } from '../../util/log.js';
import type { BrainCollection } from '../../config/types.js';
import type { RefKind } from '../../config/types-knowledge.js';
import { COMMIT_ORDER, PLAN_KINDS, type PlanKind, type WritePlan } from './types.js';
import {
  writeStage, reconcileLinkRows, countDroppedLinkRows, LinkRemovalsOverCount, landedEdgeOf, storedVersions, runAfterCommit,
  type LinkReconcile, type FailedEffect, type LandedLinkRow,
} from './commit.js';
import { linkRowsStartingFrom, countLinkRowsStartingFrom } from '../link-adjacency.js';
import { nextUnheldPosition } from '../../util/position-clock.js';
import { recordPositions } from '../../sync/record-position-stream.js';
import type { WebhookActor } from '../../webhooks/webhook-actor.js';
import { RecordVersionAtCeiling } from '../write-precondition.js';
import { tombstoneDoc, removeWithTombstones } from '../tombstones.js';
import { forkRowsUnder } from '../forks.js';
import { removeInSession, afterRemovalCommitted, StaleRemoval } from '../record-removal.js';
import { deleteBlockersOfEach, type EntityDeleteBlock } from '../entity-delete-guard.js';
import type { BacklinkEntry } from '../entities.js';

/** The most records one group writes. A SPARQL Update's own cap (`sparql.maxRecordsChanged`) is bounded by it. */
export const GROUP_MAX_RECORDS = 5_000;
/** The most writes one group makes: its records and the link rows they name. */
export const GROUP_MAX_OPERATIONS = 50_000;
/** The most bytes one group writes, as `writeGroupSize` measures them: 32 MiB. */
export const GROUP_MAX_BYTES = 32 * 1024 * 1024;
/** The most times the group's transaction runs: the first run and two re-runs after a transient failure. */
export const GROUP_MAX_TRIES = 3;

/** Why a group landed nothing — the label of `ythril_write_group_aborts_total`. */
export const GROUP_ABORT_REASONS = ['stale', 'duplicate_key', 'version_ceiling', 'referenced', 'retries', 'too_large', 'space_not_writable', 'failed'] as const;
export type GroupAbortReason = typeof GROUP_ABORT_REASONS[number];
for (const reason of GROUP_ABORT_REASONS) writeGroupAbortsTotal.inc({ reason }, 0);

/** The group's reasons a group aborts inside its transaction, each a refusal of the whole group. */
type InSessionReason = 'stale' | 'duplicate_key' | 'version_ceiling' | 'referenced' | 'retries' | 'too_large';

/**
 * The group landed nothing: inside its transaction a record moved since it was planned (`stale`), an insert met an id already stored
 * (`duplicate_key`), a record's version is at the ceiling (`version_ceiling`), a record it deletes is still named by another (`referenced`:
 * the delete guard's refusal, its blockers in `blockers`, owner D-91 — no implicit cascade), or the transaction met a transient failure on
 * every run it may take (`retries`). `recordId`/`recordKind` name the record when one is known; `attempts` is how many times the transaction ran.
 * `too_large`: the session read more link rows to remove than the ceilings counted before it opened (rows arrived since).
 */
export class GroupAborted extends Error {
  /** `referenced`: what still names the record (the guard's `blocking` rows), so the caller can delete them in the same request. */
  readonly blockers?: readonly BacklinkEntry[];

  constructor(
    readonly reason: InSessionReason, readonly attempts: number,
    readonly recordKind?: PlanKind, readonly recordId?: string, options?: { cause?: unknown; block?: EntityDeleteBlock },
  ) {
    super(GroupAborted.say(reason, recordKind, recordId, options?.block), options);
    this.name = 'GroupAborted';
    if (options?.block) this.blockers = options.block.blocking;
  }

  private static say(reason: InSessionReason, kind?: PlanKind, id?: string, block?: EntityDeleteBlock): string {
    const record = kind && id ? `the ${kind} '${id}'` : 'a record of it';
    switch (reason) {
      case 'stale': return `nothing was written: ${record} was changed by another write since it was read — retry the whole request`;
      case 'duplicate_key': return `nothing was written: ${record} was created by another write since it was read — retry the whole request`;
      case 'version_ceiling': return `nothing was written: ${record} is at the highest version sync accepts, so this instance cannot change it`;
      // Not the guard's own sentence: that one points at a door's cascade, and a group has none (owner D-91).
      case 'referenced': return `nothing was written: ${record} is still referenced by ${(block?.blocking ?? []).map(b => `${b.type} ${b._id}${b.end ? ` (at its ${b.end === 'both' ? 'both ends' : `${b.end} end`})` : ''}`).join(', ') || 'another record'}`
        + ' — delete or relink those in the same request';
      case 'retries': return `nothing was written: the write met another write on every one of its ${GROUP_MAX_TRIES} tries — retry the whole request`;
      case 'too_large': return 'nothing was written: more link rows were found to remove than were counted when the write was checked against its limits (another write added some meanwhile) — retry the whole request';
    }
  }
}

/** The codes a group answers of its own, each the `code` of the class that carries it (a door maps a refusal by them, never by retyping them). */
export const WRITE_GROUP_RECORD_PLANNED_TWICE = 'write_group_record_planned_twice';
export const WRITE_GROUP_TOO_LARGE = 'write_group_too_large';
export const WRITE_GROUP_OUTCOME_UNKNOWN = 'write_group_outcome_unknown';

/** Which ceiling a group passed. */
export type GroupCeiling = 'records' | 'operations' | 'bytes';

/**
 * A record planned twice in one group, refused before a session opened: `409 write_group_record_planned_twice`, naming the record. A group writes
 * each record once; a planner that hands it two plans of one id has built a request the store cannot honour whole. (A delete and a converge of
 * the same EDGE are one record written once and are no refusal: the delete is dropped, see `droppedDeletes`.)
 */
export class WriteGroupRecordPlannedTwice extends Error {
  readonly status = 409;
  readonly code = WRITE_GROUP_RECORD_PLANNED_TWICE;
  constructor(readonly recordKind: PlanKind, readonly recordId: string) {
    super(`the write plans the ${recordKind} '${recordId}' twice; one write changes a record once — nothing was written`);
    this.name = 'WriteGroupRecordPlannedTwice';
  }
}

/** A group over one of its ceilings, refused before a session opened: `413 write_group_too_large`, naming the ceiling, its limit and the size. */
export class WriteGroupTooLarge extends Error {
  readonly status = 413;
  readonly code = WRITE_GROUP_TOO_LARGE;
  constructor(readonly ceiling: GroupCeiling, readonly limit: number, readonly size: number) {
    super(`the write is too large to apply as one: it would write ${size} ${ceiling === 'bytes' ? 'bytes' : ceiling}, `
      + `and one write applies at most ${limit}; nothing was written — split it`);
    this.name = 'WriteGroupTooLarge';
  }
}

/**
 * The group's commit failed and the read-back could not confirm it: it may have landed, or not. A store-side failure (`StoreTimeout`, 503
 * retryable on every door), with its own code; the cause is the commit's error. A caller reads back before it retries.
 */
export class WriteGroupOutcomeUnknown extends StoreTimeout {
  readonly code = WRITE_GROUP_OUTCOME_UNKNOWN;
  constructor(options?: { cause?: unknown }) {
    super('the write', options);
    this.name = 'WriteGroupOutcomeUnknown';
  }
}

/** What a group that landed did. */
export interface GroupCommitted {
  /** Per plan, in the order given: the version the record landed at. */
  readonly seqs: readonly number[];
  /** Per plan: the link rows it added. */
  readonly linksAdded: readonly number[];
  /** How many times the transaction ran (1 when no transient failure met it). */
  readonly attempts: number;
  /**
   * Rows the group LANDED that a check after the commit took back, because an entity they name was removed while the group was written:
   * edges by id with the end that was gone, link rows by the plan that carried them and the entity they named. Not a partial write of the
   * group; a race no transaction closes, said here so the door can answer it.
   */
  readonly takenBack: {
    readonly edges: ReadonlyArray<{ readonly id: string; readonly end: { readonly id: string; readonly side: 'from' | 'to' } }>;
    readonly links: ReadonlyArray<{ readonly plan: number; readonly entityId: string }>;
  };
  /** Effects after the commit that did not complete (embed jobs, take-backs). The records are stored; these are what is owed. */
  readonly failedEffects: readonly FailedEffect[];
}

/** The writes one removed record costs: its delete and its tombstone. */
const WRITES_PER_REMOVAL = 2;
/** The widest stamp a tombstone carries, so a counted tombstone is never smaller than the one written. */
const WIDEST_STAMP = { seq: Number.MAX_SAFE_INTEGER, pos: Number.MAX_SAFE_INTEGER, posAtSeq: Number.MAX_SAFE_INTEGER } as const;
/** A fork's id as counted (its own is read inside the transaction): the length of a minted id. */
const FORK_ID_SHAPE = '00000000-0000-4000-8000-000000000000';
/** A link row's id as counted: the length of a derived one (a uuid v5, as every link id is). */
const LINK_ID_SHAPE = linkIdFor(FORK_ID_SHAPE, 'fact', FORK_ID_SHAPE, 'entity');

/** The size of what a group writes, as its ceilings count it. */
export interface GroupSize { readonly records: number; readonly operations: number; readonly bytes: number }

/**
 * What `plans` would write: records, writes (records plus the link rows they name), and bytes — the document each insert writes, the `$set`
 * and `$unset` each converge writes, and each named link row as stored. The link rows a group REMOVES are counted too, as `opts.linkRemovals`
 * (contract-760: a removal is two writes and a tombstone, whichever record it hangs off): one 13-fact delete holds up to 52 000 of them.
 *
 * A delete (`Q-963`) is two writes, its removal and its tombstone, and the tombstone's bytes; so is each unresolved version it settles
 * (`opts.forks`) and each link row a removal takes (`opts.linkRemovals`: the rows the deleted facts and chrono entries START and the stored rows
 * the converges drop). Both are read before the session (`commitWriteGroup` counts them), each removed behind a tombstone of its own.
 */
export function writeGroupSize(plans: readonly WritePlan[], opts: { forks?: number; linkRemovals?: number } = {}): GroupSize {
  let operations = 0;
  let bytes = 0;
  const removal = (id: string, type: PlanKind | 'link') => {
    operations += WRITES_PER_REMOVAL;
    bytes += operationBytes(tombstoneDoc(plans[0]?.spaceId ?? '', WIDEST_STAMP, { _id: id, type, originalSeq: WIDEST_STAMP.seq }));
  };
  for (let f = 0; f < (opts.forks ?? 0); f++) removal(FORK_ID_SHAPE, 'fact');
  for (let l = 0; l < (opts.linkRemovals ?? 0); l++) removal(LINK_ID_SHAPE, 'link');
  for (const p of plans) {
    if (p.op === 'delete') { removal(p.id, p.kind); continue; }
    operations += 1;
    bytes += operationBytes(p.op === 'insert' ? p.doc : { $set: p.set ?? {}, $unset: p.unset ?? {} });
    if (!p.links) continue;
    for (const toKind of Object.keys(p.links.desired) as RefKind[]) {
      for (const to of p.links.desired[toKind] ?? []) {
        operations += 1;
        bytes += operationBytes({
          _id: linkIdFor(p.id, p.links.fromKind, to, toKind), spaceId: p.spaceId, from: p.id, fromKind: p.links.fromKind, to, toKind, author: p.links.author,
        });
      }
    }
  }
  return { records: plans.length, operations, bytes };
}

/** The value of one run of the callback: the versions, the link counts, the rows owed a check after commit, and the marker. */
interface RunValue {
  readonly seqs: number[];
  readonly linksAdded: number[];
  readonly owedLinks: LandedLinkRow[];
  readonly linkOwner: Map<string, number>;
  readonly marker?: { readonly kind: PlanKind | 'link'; readonly id: string; readonly seq: number };
  /** Per kind the group deleted: the ids and the forks removed with them, owed their tail after the commit (`afterRemovalCommitted`). */
  readonly removed: ReadonlyArray<{ readonly kind: PlanKind; readonly ids: string[]; readonly forks: string[] }>;
  /** The record position this run began at, taken before its first write: what the removals' take-back counts from. */
  readonly began?: number;
}

/** The kinds in the order their deletes run: an edge before the records it joins, so a peer applies its tombstone first (vet-2 S11). */
const DELETE_ORDER: readonly PlanKind[] = [...COMMIT_ORDER].reverse();

/**
 * Remove, in the session, the link rows the group's deleted facts and chrono entries START (design-r2 R7): with their tombstones, before
 * the records, so a peer applies a row's removal before its subject's, and the delete guard that follows does not see them name an entity
 * the group also deletes. Rows pointing AT a deleted record are the guard's to refuse, never removed here.
 */
async function removeLinksFromDeleted(
  spaceId: string, kind: PlanKind, ids: readonly string[], counted: number, session: ClientSession, attempt: number,
): Promise<void> {
  if (ids.length === 0 || (kind !== 'fact' && kind !== 'chrono')) return;
  // Bounded by what the ceilings counted before the session opened: one row more is read and refused, never removed.
  const rows = await linkRowsStartingFrom(spaceId, ids, kind, counted + 1, session);
  if (rows.length > counted) throw new GroupAborted('too_large', attempt, kind, ids[0]);
  try {
    await removeWithTombstones(spaceId, 'links', rows.map(r => ({ _id: r._id, type: 'link' as const, originalSeq: r.seq })), { session, filter: { spaceId } });
  } catch (err) {
    // A link row at the version ceiling cannot be removed (its tombstone would be refused by every peer): the record it hangs off is the one named.
    if (err instanceof RecordVersionAtCeiling) {
      throw new GroupAborted('version_ceiling', attempt, kind, rows.find(r => r._id === err.id)?.from ?? ids[0], { cause: err });
    }
    throw err;
  }
}

/**
 * The group's deletes, in {@link DELETE_ORDER}, inside the session: the deleted facts' and chrono entries' links first, then each kind's
 * records at the versions planned (`removeInSession`). A record changed since it was planned aborts the group `stale`, naming it; a
 * tombstone at the version ceiling aborts it `version_ceiling`.
 */
async function writeDeletes(
  spaceId: string, plans: readonly WritePlan[], session: ClientSession, attempt: number, linkRows: ReadonlyMap<PlanKind, number>,
): Promise<RunValue['removed']> {
  const removed: Array<{ kind: PlanKind; ids: string[]; forks: string[] }> = [];
  const ofKind = (kind: PlanKind) => plans.filter(p => p.op === 'delete' && p.kind === kind);
  for (const kind of DELETE_ORDER) await removeLinksFromDeleted(spaceId, kind, ofKind(kind).map(p => p.id), linkRows.get(kind) ?? 0, session, attempt);
  for (const kind of DELETE_ORDER) {
    const deletes = ofKind(kind);
    if (deletes.length === 0) continue;
    // Read before the removal: once it ran, a record it removed is as absent from the transaction as one that was never there, and only the
    // versions read BEFORE tell the record that was missing or moved from the ones the same removal took.
    const before = await storedVersions(spaceId, kind, deletes.map(p => p.id), session);
    try {
      const { forks } = await removeInSession(spaceId, kind, deletes.map(p => ({ _id: p.id, seq: p.expectSeq ?? null })), session);
      removed.push({ kind, ids: deletes.map(p => p.id), forks });
    } catch (err) {
      if (err instanceof StaleRemoval) {
        const moved = deletes.find(p => !before.has(p.id) || (before.get(p.id) ?? null) !== (p.expectSeq ?? null));
        throw new GroupAborted('stale', attempt, kind, moved?.id, { cause: err });
      }
      if (err instanceof RecordVersionAtCeiling) throw new GroupAborted('version_ceiling', attempt, kind, err.id, { cause: err });
      throw err;
    }
  }
  return removed;
}

/**
 * The delete guard over the group's result (owner D-91; alternative d): inside the session, after every write of the group, one batched
 * scan per deleted kind (`deleteBlockersOfEach`). Anything still naming a deleted record — stored before, or written by this group —
 * aborts the group `referenced` with its blockers. No implicit cascade: the caller deletes the references in the same group.
 */
async function guardDeletes(spaceId: string, removed: RunValue['removed'], session: ClientSession, attempt: number): Promise<void> {
  for (const { kind, ids } of removed) {
    if (kind === 'edge') continue;   // nothing references an edge
    const blocked = await deleteBlockersOfEach(spaceId, ids, kind, { session });
    const first = ids.find(id => blocked.has(id));
    if (first !== undefined) throw new GroupAborted('referenced', attempt, kind, first, { block: blocked.get(first)! });
  }
}

/**
 * Write `plans` (all for `spaceId`) as one group: all of them land, or none does — see the module docblock.
 *
 * @throws WriteGroupTooLarge (413) over a ceiling; the write gate's `SpaceNotWritableError` while an act stands for a family it writes;
 * `GroupAborted` when the transaction refused the group; `WriteGroupOutcomeUnknown` when a failed commit could not be read back; any other
 * failure of the store as it came (nothing landed: a failure before the commit aborts the transaction).
 */
export async function commitWriteGroup(
  spaceId: string, given: readonly WritePlan[], opts: { actor?: WebhookActor } = {},
): Promise<GroupCommitted> {
  // The plans the group writes, and where each stands among the ones given: a delete of an edge the group also converges is dropped (it is one
  // record, written once), every other record planned twice is refused. Everything below runs on `plans`; the result is given back per `given`.
  const dropped = droppedDeletes(given);
  const keep = given.map((_, i) => i).filter(i => !dropped.has(i));
  const plans = keep.map(i => given[i]!);
  assertOneGroup(spaceId, plans);
  const linkRows = await linkRowsToRemove(spaceId, plans);
  const size = writeGroupSize(plans, { forks: await forksOfDeletes(spaceId, plans), linkRemovals: linkRows.started + linkRows.dropped });
  const over = size.records > GROUP_MAX_RECORDS ? new WriteGroupTooLarge('records', GROUP_MAX_RECORDS, size.records)
    : size.operations > GROUP_MAX_OPERATIONS ? new WriteGroupTooLarge('operations', GROUP_MAX_OPERATIONS, size.operations)
      : size.bytes > GROUP_MAX_BYTES ? new WriteGroupTooLarge('bytes', GROUP_MAX_BYTES, size.bytes) : null;
  if (over) {
    writeGroupAbortsTotal.inc({ reason: 'too_large' });
    throw over;
  }
  if (plans.length === 0) return { seqs: given.map(() => 0), linksAdded: given.map(() => 0), attempts: 0, takenBack: { edges: [], links: [] }, failedEffects: [] };

  const families = familiesOf(plans);
  let leave: () => void;
  try {
    leave = admitSpaceWriteUnit(spaceId, families);
  } catch (err) {
    if (isSpaceNotWritable(err)) writeGroupAbortsTotal.inc({ reason: 'space_not_writable' });
    throw err;
  }
  let attempts = 0;
  let readBack = false;
  let value: RunValue;
  try {
    value = await inHeldTransaction(spaceId, 'write.group', (session) => {
      attempts += 1;
      return runGroup(spaceId, plans, session, attempts, linkRows);
    }, {
      landed: async (run) => {
        readBack = true;
        if (!run.marker) return false;
        return (await storedVersions(spaceId, run.marker.kind, [run.marker.id])).get(run.marker.id) === run.marker.seq;
      },
    });
  } catch (err) {
    if (err instanceof GroupAborted) {
      writeGroupAbortsTotal.inc({ reason: err.reason });
      throw err;
    }
    // The commit failed and the read-back did not confirm it: the outcome is unknown, never "nothing landed".
    if (readBack) {
      log.error(`write group: a commit to '${peerText(spaceId)}' failed and its read-back could not confirm it; the caller is answered outcome unknown`);
      throw new WriteGroupOutcomeUnknown({ cause: err });
    }
    writeGroupAbortsTotal.inc({ reason: 'failed' });
    throw err;
  } finally {
    leave();
  }

  // Committed: what follows a write runs now, over what landed.
  const written = plans.filter(p => p.op !== 'delete');
  const report = await runAfterCommit(spaceId, {
    edges: written.filter(p => p.kind === 'edge').map(landedEdgeOf),
    linkRows: value.owedLinks,
    embed: written.filter(p => p.enqueue).map(p => ({ recordType: p.kind, recordId: p.id })),
    dupeRules: written.filter(p => p.dupeRules).map(p => ({ kind: p.kind, id: p.id })),
  });
  // What a removal owes once committed: the one tail `removeRecords` runs (embed jobs, the forks' leftovers, the kind's cascade with the
  // straggler take-back from `began`, the events). Never thrown from here: the group is committed, and what failed is reported.
  const failedEffects = [...report.failed];
  for (const { kind, ids, forks } of value.removed) {
    try {
      await afterRemovalCommitted(spaceId, kind, ids, forks, opts.actor, value.began!);
    } catch (error) {
      failedEffects.push({ effect: 'removal', count: ids.length, error });
      log.warn(`write group: ${ids.length} ${kind}(s) removed from '${peerText(spaceId)}' were not settled after the commit: ${peerText(error)}`);
    }
  }
  const linksAdded = [...value.linksAdded];
  const links: Array<{ plan: number; entityId: string }> = [];
  for (const [linkId, entityId] of report.linksTakenBack) {
    const plan = value.linkOwner.get(linkId);
    if (plan === undefined) continue;
    linksAdded[plan] = Math.max(0, linksAdded[plan]! - 1);
    links.push({ plan: keep[plan]!, entityId });
  }
  // Per plan GIVEN: a delete dropped for a converge of the same edge wrote nothing of its own.
  const perGiven = (values: readonly number[]) => {
    const out = given.map(() => 0);
    keep.forEach((at, k) => { out[at] = values[k]!; });
    return out;
  };
  return {
    seqs: perGiven(value.seqs), linksAdded: perGiven(linksAdded), attempts,
    takenBack: { edges: [...report.edgesTakenBack].map(([id, end]) => ({ id, end })), links },
    failedEffects,
  };
}

/**
 * How many unresolved versions the group's deletes will settle, read before the session (`forkRowsUnder`, one `$in` per kind): what the
 * ceilings count beside the plans. Inside the transaction the removal reads them again, with the session.
 */
async function forksOfDeletes(spaceId: string, plans: readonly WritePlan[]): Promise<number> {
  let forks = 0;
  for (const kind of COMMIT_ORDER) {
    const ids = plans.filter(p => p.op === 'delete' && p.kind === kind).map(p => p.id);
    if (ids.length > 0) forks += (await forkRowsUnder(spaceId, PLAN_KINDS[kind].collection, ids)).length;
  }
  return forks;
}

/** One run of the transaction's callback — see the module docblock. Everything it decides is in its value; it keeps nothing outside. */
async function runGroup(
  spaceId: string, plans: readonly WritePlan[], session: ClientSession, attempt: number, linkRows: LinkRowsToRemove,
): Promise<RunValue> {
  if (attempt > GROUP_MAX_TRIES) throw new GroupAborted('retries', attempt - 1);
  const seqs = new Array<number>(plans.length).fill(0);
  let marker: RunValue['marker'];
  // Taken at the start of each run, before its first write: the take-back after the commit counts stragglers from here (vet-2 S7).
  const deletes = plans.some(p => p.op === 'delete');
  const began = deletes ? await nextUnheldPosition(recordPositions, spaceId) : undefined;
  // Deletes before inserts (design-r2 R6): an edge swapped at a functional subject leaves the unique guard before its successor takes it.
  const removed = deletes ? await writeDeletes(spaceId, plans, session, attempt, linkRows.startedBy) : [];
  for (const kind of COMMIT_ORDER) {
    const at = plans.flatMap((p, i) => (p.kind === kind && p.op !== 'delete' ? [i] : []));
    if (at.length === 0) continue;
    const ofKind = at.map(i => plans[i]!);
    let stage: Awaited<ReturnType<typeof writeStage>>;
    try {
      stage = await writeStage(spaceId, kind, ofKind, { session });
    } catch (err) {
      // A duplicate key is a record created since the plan read it; it carries no transient label (probe E1), and a read inside a transaction
      // the server already aborted would fail: the group aborts on the error alone. Everything else goes as it came, its labels kept.
      if (!carriesErrorLabel(err, 'TransientTransactionError') && isDuplicateKey(err)) {
        throw new GroupAborted('duplicate_key', attempt, kind, duplicateOf(err, ofKind), { cause: err });
      }
      throw err;
    }
    const refused = stage.rows.find(r => 'refused' in r);
    if (refused) throw new GroupAborted('version_ceiling', attempt, kind, refused.id);
    const inserts = ofKind.filter(p => p.op === 'insert').length;
    const converges = ofKind.length - inserts;
    if (stage.matched < converges) {
      throw new GroupAborted('stale', attempt, kind, await movedRecord(spaceId, kind, 'converge', ofKind, stage, session));
    }
    if (stage.inserted < inserts) {
      throw new GroupAborted('stale', attempt, kind, await movedRecord(spaceId, kind, 'insert', ofKind, stage, session));
    }
    stage.sent.forEach((k, s) => {
      seqs[at[k]!] = stage.stamps[s]!.version;
      if (!marker && ofKind[k]!.op === 'insert') marker = { kind, id: ofKind[k]!.id, seq: stage.stamps[s]!.version };
    });
  }

  const withLinks = plans.flatMap((p, i) => (p.links ? [i] : []));
  const linksAdded = new Array<number>(plans.length).fill(0);
  const owedLinks: LandedLinkRow[] = [];
  const linkOwner = new Map<string, number>();
  if (withLinks.length > 0) {
    const records = linkRecordsOf(plans);
    let counts: Awaited<ReturnType<typeof reconcileLinkRows>>;
    try {
      counts = await reconcileLinkRows(spaceId, records, { session, owed: owedLinks, removalCeiling: linkRows.dropped });
    } catch (err) {
      if (err instanceof LinkRemovalsOverCount) throw new GroupAborted('too_large', attempt, undefined, undefined, { cause: err });
      throw err;
    }
    withLinks.forEach((i, k) => { linksAdded[i] = counts[k]!.added; });
    for (const row of owedLinks) {
      const owner = withLinks.find(i => {
        const r = plans[i]!;
        return Object.entries(r.links!.desired).some(([toKind, tos]) => (tos ?? []).some(to => linkIdFor(r.id, r.links!.fromKind, to, toKind as RefKind) === row._id));
      });
      if (owner !== undefined) linkOwner.set(row._id, owner);
    }
    if (!marker && owedLinks.length > 0) marker = { kind: 'link', id: owedLinks[0]!._id, seq: owedLinks[0]!.seq };
  }
  // Last, over everything the group wrote and removed.
  await guardDeletes(spaceId, removed, session, attempt);
  return { seqs, linksAdded, owedLinks, linkOwner, removed, ...(marker ? { marker } : {}), ...(began !== undefined ? { began } : {}) };
}

/**
 * The plan of `op` in a short stage whose record did not take the version the stage gave it: read in the session (the transaction is still
 * open: a short count is no error). A converge that matched nothing moved or went; an insert that was not made is not stored at its version.
 */
async function movedRecord(
  spaceId: string, kind: PlanKind, op: 'converge' | 'insert', ofKind: readonly WritePlan[], stage: Awaited<ReturnType<typeof writeStage>>,
  session: ClientSession,
): Promise<string | undefined> {
  const planned = stage.sent.filter(k => ofKind[k]!.op === op);
  const stored = await storedVersions(spaceId, kind, planned.map(k => ofKind[k]!.id), session);
  const moved = planned.find(k => stored.get(ofKind[k]!.id) !== stage.stamps[stage.sent.indexOf(k)]!.version);
  return moved === undefined ? undefined : ofKind[moved]!.id;
}

/**
 * The record a duplicate key stopped: the document the failed insert carried (the bulk error holds it, `writeErrors[i].err.op`) is one of this
 * stage's, so its id names the plan. Unnamed only when the driver's error carries no document.
 */
function duplicateOf(err: unknown, ofKind: readonly WritePlan[]): string | undefined {
  const writeErrors = (err as { writeErrors?: unknown } | null)?.writeErrors;
  const list = Array.isArray(writeErrors) ? writeErrors : writeErrors ? Object.values(writeErrors as object) : [];
  for (const w of list as Array<{ err?: { op?: { _id?: unknown } }; getOperation?: () => { _id?: unknown } | undefined }>) {
    const id = w.err?.op?._id ?? w.getOperation?.()?._id;
    if (typeof id === 'string' && ofKind.some(p => p.id === id)) return id;
  }
  return undefined;
}

/** Every plan is for `spaceId`, and no (kind, id) is planned twice: a group writes each record once. A wrong space is a planner's defect, thrown as one. */
function assertOneGroup(spaceId: string, plans: readonly WritePlan[]): void {
  const seen = new Set<string>();
  for (const p of plans) {
    if (p.spaceId !== spaceId) throw new Error(`commitWriteGroup: a plan decided for space '${p.spaceId}' was handed to a group for '${spaceId}'`);
    const key = `${p.kind}\u0000${p.id}`;
    if (seen.has(key)) throw new WriteGroupRecordPlannedTwice(p.kind, p.id);
    seen.add(key);
  }
}

/**
 * The indexes of the delete plans the group does not write: a delete of an EDGE the group also converges. An edge's identity is its triplet and
 * end kinds, so a batch that deletes one and plans the same triplet again (`planEdge` plans that converge, from the read set's deleted edge)
 * writes ONE record, converged in place, and the delete would remove what the converge writes. Only an edge: the other kinds' identities are
 * not their content, and two plans of one such record stay a refusal (`assertOneGroup`).
 */
export function droppedDeletes(plans: readonly WritePlan[]): Set<number> {
  const converged = new Set(plans.filter(p => p.kind === 'edge' && p.op === 'converge').map(p => p.id));
  return new Set(plans.flatMap((p, i) => (p.kind === 'edge' && p.op === 'delete' && converged.has(p.id) ? [i] : [])));
}

/** The link rows the group's plans remove, counted before the session opens: those a deleted fact or chrono entry starts, and those a converge drops. */
interface LinkRowsToRemove {
  /** Per deleted kind (fact, chrono): the rows its deleted records start. */
  readonly startedBy: ReadonlyMap<PlanKind, number>;
  readonly started: number;
  /** The stored rows the converges drop, over all of them. */
  readonly dropped: number;
}

/** The link-reconcile input of the plans that name link classes, in plan order: what `runGroup` reconciles and what the count reads. */
function linkRecordsOf(plans: readonly WritePlan[]): LinkReconcile[] {
  return plans.filter(p => p.links).map(p => ({ from: p.id, minted: p.minted, ...p.links! }));
}

/**
 * Count, before a session opens, the link rows the group removes (contract-760: a removal is two writes and a tombstone, of whatever it hangs
 * off): one count per delete kind of the rows its records start, and the stored rows the converges drop. Inside the session the same rows are read
 * again and a row more than counted aborts the group `too_large`.
 */
async function linkRowsToRemove(spaceId: string, plans: readonly WritePlan[]): Promise<LinkRowsToRemove> {
  const startedBy = new Map<PlanKind, number>();
  let started = 0;
  for (const kind of COMMIT_ORDER) {
    if (kind !== 'fact' && kind !== 'chrono') continue;
    const ids = plans.filter(p => p.op === 'delete' && p.kind === kind).map(p => p.id);
    const n = await countLinkRowsStartingFrom(spaceId, ids, kind);
    if (n > 0) startedBy.set(kind, n);
    started += n;
  }
  const dropped = await countDroppedLinkRows(spaceId, linkRecordsOf(plans));
  return { startedBy, started, dropped };
}

/** The families the group writes: each plan's collection, and the link rows (with their tombstones) when a plan names links. */
function familiesOf(plans: readonly WritePlan[]): BrainCollection[] {
  const families = new Set<BrainCollection>(plans.map(p => PLAN_KINDS[p.kind].collection as BrainCollection));
  // A deleted fact or chrono entry takes the link rows it starts with it.
  if (plans.some(p => p.links || (p.op === 'delete' && (p.kind === 'fact' || p.kind === 'chrono')))) families.add('links');
  return [...families];
}
