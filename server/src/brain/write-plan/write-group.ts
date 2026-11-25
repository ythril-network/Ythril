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
 * Before a session opens: every plan is for this space and names a distinct (kind, id); the group is inside its ceilings
 * (`GROUP_MAX_RECORDS`, `GROUP_MAX_OPERATIONS`, `GROUP_MAX_BYTES`, refused `413 write_group_too_large` naming the one it passed); and the
 * write gate admits every family the group writes (`admitSpaceWriteUnit`, left in a `finally`). Then one `inHeldTransaction`, the position
 * floor held throughout, runs the callback:
 *
 *  - each kind's stage through `writeStage` with the session, in commit order; the link rows through `reconcileLinkRows` with the session;
 *  - **every error is thrown as it came**, its labels kept: a write conflict (`TransientTransactionError`) re-runs the callback from the top;
 *  - **a duplicate key, a version at the ceiling, or a short count** (a converge whose record moved since it was planned matches nothing,
 *    and says so only in `matchedCount`) throws `GroupAborted`, which aborts the transaction: nothing lands;
 *  - the callback is safe to run again: it takes fresh versions and positions each run and keeps nothing outside its return value. It runs at
 *    most `GROUP_MAX_TRIES` times; a further run is refused `GroupAborted('retries')`.
 *
 * After the commit, and only then, `runAfterCommit` takes back what names an entity removed meanwhile, queues the embed jobs and runs the
 * duplicate rules. A take-back removes a row the group landed: it is REPORTED (`takenBack`), since no transaction can close that race (the
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
  writeStage, reconcileLinkRows, landedEdgeOf, storedVersions, runAfterCommit, type LinkReconcile, type FailedEffect, type LandedLinkRow,
} from './commit.js';

/** The most records one group writes. A SPARQL Update's own cap (`sparql.maxRecordsChanged`) is bounded by it. */
export const GROUP_MAX_RECORDS = 5_000;
/** The most writes one group makes: its records and the link rows they name. */
export const GROUP_MAX_OPERATIONS = 50_000;
/** The most bytes one group writes, as `writeGroupSize` measures them: 32 MiB. */
export const GROUP_MAX_BYTES = 32 * 1024 * 1024;
/** The most times the group's transaction runs: the first run and two re-runs after a transient failure. */
export const GROUP_MAX_TRIES = 3;

/** Why a group landed nothing — the label of `ythril_write_group_aborts_total`. */
export const GROUP_ABORT_REASONS = ['stale', 'duplicate_key', 'version_ceiling', 'retries', 'too_large', 'space_not_writable', 'failed'] as const;
export type GroupAbortReason = typeof GROUP_ABORT_REASONS[number];
for (const reason of GROUP_ABORT_REASONS) writeGroupAbortsTotal.inc({ reason }, 0);

/** The group's reasons a group aborts inside its transaction, each a refusal of the whole group. */
type InSessionReason = 'stale' | 'duplicate_key' | 'version_ceiling' | 'retries';

/**
 * The group landed nothing: inside its transaction a record moved since it was planned (`stale`), an insert met an id already stored
 * (`duplicate_key`), a record's version is at the ceiling (`version_ceiling`), or the transaction met a transient failure on every run it
 * may take (`retries`). `recordId`/`recordKind` name the record when one is known; `attempts` is how many times the transaction ran.
 */
export class GroupAborted extends Error {
  constructor(
    readonly reason: InSessionReason, readonly attempts: number,
    readonly recordKind?: PlanKind, readonly recordId?: string, options?: { cause?: unknown },
  ) {
    super(GroupAborted.say(reason, recordKind, recordId), options);
    this.name = 'GroupAborted';
  }

  private static say(reason: InSessionReason, kind?: PlanKind, id?: string): string {
    const record = kind && id ? `the ${kind} '${id}'` : 'a record of it';
    switch (reason) {
      case 'stale': return `nothing was written: ${record} was changed by another write since it was read — retry the whole request`;
      case 'duplicate_key': return `nothing was written: ${record} was created by another write since it was read — retry the whole request`;
      case 'version_ceiling': return `nothing was written: ${record} is at the highest version sync accepts, so this instance cannot change it`;
      case 'retries': return `nothing was written: the write met another write on every one of its ${GROUP_MAX_TRIES} tries — retry the whole request`;
    }
  }
}

/** Which ceiling a group passed. */
export type GroupCeiling = 'records' | 'operations' | 'bytes';

/** A group over one of its ceilings, refused before a session opened: `413 write_group_too_large`, naming the ceiling, its limit and the size. */
export class WriteGroupTooLarge extends Error {
  readonly status = 413;
  readonly code = 'write_group_too_large';
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
  readonly code = 'write_group_outcome_unknown';
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

/** The size of what a group writes, as its ceilings count it. */
export interface GroupSize { readonly records: number; readonly operations: number; readonly bytes: number }

/**
 * What `plans` would write: records, writes (records plus the link rows they name), and bytes — the document each insert writes, the `$set`
 * and `$unset` each converge writes, and each named link row as stored. A link row the group removes is not counted here: which ones go is
 * read inside the transaction; a removal writes a tombstone no larger than the row it buries, and the 32 MiB ceiling sits far below what the
 * store refused (probe E5: 100 MB).
 */
export function writeGroupSize(plans: readonly WritePlan[]): GroupSize {
  let operations = 0;
  let bytes = 0;
  for (const p of plans) {
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
}

/**
 * Write `plans` (all for `spaceId`) as one group: all of them land, or none does — see the module docblock.
 *
 * @throws WriteGroupTooLarge (413) over a ceiling; the write gate's `SpaceNotWritableError` while an act stands for a family it writes;
 * `GroupAborted` when the transaction refused the group; `WriteGroupOutcomeUnknown` when a failed commit could not be read back; any other
 * failure of the store as it came (nothing landed: a failure before the commit aborts the transaction).
 */
export async function commitWriteGroup(spaceId: string, plans: readonly WritePlan[]): Promise<GroupCommitted> {
  assertOneGroup(spaceId, plans);
  const size = writeGroupSize(plans);
  const over = size.records > GROUP_MAX_RECORDS ? new WriteGroupTooLarge('records', GROUP_MAX_RECORDS, size.records)
    : size.operations > GROUP_MAX_OPERATIONS ? new WriteGroupTooLarge('operations', GROUP_MAX_OPERATIONS, size.operations)
      : size.bytes > GROUP_MAX_BYTES ? new WriteGroupTooLarge('bytes', GROUP_MAX_BYTES, size.bytes) : null;
  if (over) {
    writeGroupAbortsTotal.inc({ reason: 'too_large' });
    throw over;
  }
  if (plans.length === 0) return { seqs: [], linksAdded: [], attempts: 0, takenBack: { edges: [], links: [] }, failedEffects: [] };

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
      return runGroup(spaceId, plans, session, attempts);
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
  const report = await runAfterCommit(spaceId, {
    edges: plans.filter(p => p.kind === 'edge').map(landedEdgeOf),
    linkRows: value.owedLinks,
    embed: plans.filter(p => p.enqueue).map(p => ({ recordType: p.kind, recordId: p.id })),
    dupeRules: plans.filter(p => p.dupeRules).map(p => ({ kind: p.kind, id: p.id })),
  });
  const linksAdded = [...value.linksAdded];
  const links: Array<{ plan: number; entityId: string }> = [];
  for (const [linkId, entityId] of report.linksTakenBack) {
    const plan = value.linkOwner.get(linkId);
    if (plan === undefined) continue;
    linksAdded[plan] = Math.max(0, linksAdded[plan]! - 1);
    links.push({ plan, entityId });
  }
  return {
    seqs: value.seqs, linksAdded, attempts,
    takenBack: { edges: [...report.edgesTakenBack].map(([id, end]) => ({ id, end })), links },
    failedEffects: report.failed,
  };
}

/** One run of the transaction's callback — see the module docblock. Everything it decides is in its value; it keeps nothing outside. */
async function runGroup(spaceId: string, plans: readonly WritePlan[], session: ClientSession, attempt: number): Promise<RunValue> {
  if (attempt > GROUP_MAX_TRIES) throw new GroupAborted('retries', attempt - 1);
  const seqs = new Array<number>(plans.length).fill(0);
  let marker: RunValue['marker'];
  for (const kind of COMMIT_ORDER) {
    const at = plans.flatMap((p, i) => (p.kind === kind ? [i] : []));
    if (at.length === 0) continue;
    const ofKind = at.map(i => plans[i]!);
    let stage: Awaited<ReturnType<typeof writeStage>>;
    try {
      stage = await writeStage(spaceId, kind, ofKind, { session });
    } catch (err) {
      // A duplicate key is a record created since the plan read it; it carries no transient label (probe E1), and a read inside a transaction
      // the server already aborted would fail: the group aborts on the error alone. Everything else goes as it came, its labels kept.
      if (!carriesErrorLabel(err, 'TransientTransactionError') && isDuplicateKey(err)) throw new GroupAborted('duplicate_key', attempt, kind, undefined, { cause: err });
      throw err;
    }
    const refused = stage.rows.find(r => 'refused' in r);
    if (refused) throw new GroupAborted('version_ceiling', attempt, kind, refused.id);
    const inserts = ofKind.filter(p => p.op === 'insert').length;
    const converges = ofKind.length - inserts;
    if (stage.matched < converges) {
      throw new GroupAborted('stale', attempt, kind, await staleConverge(spaceId, kind, ofKind, stage, session));
    }
    if (stage.inserted < inserts) throw new GroupAborted('stale', attempt, kind);
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
    const records: LinkReconcile[] = withLinks.map(i => ({ from: plans[i]!.id, minted: plans[i]!.minted, ...plans[i]!.links! }));
    const counts = await reconcileLinkRows(spaceId, records, { session, owed: owedLinks });
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
  return { seqs, linksAdded, owedLinks, linkOwner, ...(marker ? { marker } : {}) };
}

/** The converge of a short stage whose record moved: read in the session (the transaction is still open: a short count is no error). */
async function staleConverge(
  spaceId: string, kind: PlanKind, ofKind: readonly WritePlan[], stage: Awaited<ReturnType<typeof writeStage>>, session: ClientSession,
): Promise<string | undefined> {
  const converges = stage.sent.filter(k => ofKind[k]!.op === 'converge');
  const stored = await storedVersions(spaceId, kind, converges.map(k => ofKind[k]!.id), session);
  const moved = converges.find(k => stored.get(ofKind[k]!.id) !== stage.stamps[stage.sent.indexOf(k)]!.version);
  return moved === undefined ? undefined : ofKind[moved]!.id;
}

/** Every plan is for `spaceId`, and no (kind, id) is planned twice: a group writes each record once. A planner's defect, thrown as one. */
function assertOneGroup(spaceId: string, plans: readonly WritePlan[]): void {
  const seen = new Set<string>();
  for (const p of plans) {
    if (p.spaceId !== spaceId) throw new Error(`commitWriteGroup: a plan decided for space '${p.spaceId}' was handed to a group for '${spaceId}'`);
    const key = `${p.kind}\u0000${p.id}`;
    if (seen.has(key)) throw new Error(`commitWriteGroup: the ${p.kind} '${p.id}' is planned twice in one group`);
    seen.add(key);
  }
}

/** The families the group writes: each plan's collection, and the link rows (with their tombstones) when a plan names links. */
function familiesOf(plans: readonly WritePlan[]): BrainCollection[] {
  const families = new Set<BrainCollection>(plans.map(p => PLAN_KINDS[p.kind].collection as BrainCollection));
  if (plans.some(p => p.links)) families.add('links');
  return [...families];
}
