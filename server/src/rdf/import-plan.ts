/**
 * The RDF import's record operations as planner calls: the dry plan that judges a window of them, and the commit that lands it (bundle-270,
 * slice S6; plan section 3 (b), amendments A1, A2, A4).
 *
 * ## What it prevents
 *
 * - **A second judge.** The dry plan and the commit call the same planners with the same input, the same trusted arguments and a read set
 *   seeded the same way: an item is built once here (`opItem`), so what the commit lands is what the dry plan passed. Nothing else in the
 *   import names a planner or `trustedPlan` (the lint of `trust.ts` allows only `brain/write-plan/` and `rdf/`).
 * - **A supplied id made an identity.** A new record is planned under the id the import minted for it (`trustedPlan`'s `mintedId`, a UUID v4
 *   the instance generated); a stored record is addressed by its stored id, which only addresses. A minted id that is stored by the time the
 *   commit plans it (a resumed commit whose first attempt landed it) converges onto it: no record is written twice.
 * - **An end that exists only in the file refused.** Before a window is planned, every record the window names that the import brings and the
 *   store does not hold yet is seeded into the read set (`ReadSet.seed`, with an entity's type for the endpoint rules), so an edge or a link to
 *   it is judged as one to a record that exists (A2). A record already stored is never seeded (the seed refuses that).
 * - **A partial commit reported as a success.** A commit outcome that is not `ok` throws: the act stays owed and runs again, and a second run
 *   converges (A1: the commit never refuses, so a failure is the store's, and a retry meets it again or lands).
 *
 * Edges are planned in one read set across the whole import's dry plan, so an edge under a functional label in one window sees the edges the
 * other windows planned; records of the other kinds are planned in a fresh read set per window, which bounds what the dry plan holds.
 */
import type { RefKind } from '../config/types-knowledge.js';
import type { ChronoStatus, ChronoType } from '../config/types.js';
import { ReadSet, mergeWants, type SeedKind } from '../brain/write-plan/read-set.js';
import { trustedPlan, type PlanTrust } from '../brain/write-plan/trust.js';
import { planEntity, entityWant, type EntityInput } from '../brain/write-plan/plan-entity.js';
import { planFact, factWant, type FactInput } from '../brain/write-plan/plan-fact.js';
import { planChrono, chronoWant, type ChronoInput } from '../brain/write-plan/plan-chrono.js';
import { planEdge, edgeWant, type EdgeInput } from '../brain/write-plan/plan-edge.js';
import { dryPlan, type DryItem, type DryRefusal } from '../brain/write-plan/dry-plan.js';
import { commitPlans } from '../brain/write-plan/commit.js';
import type { WritePlan } from '../brain/write-plan/types.js';
import { recordKey, type RecordOp, type StoredRecord } from './quads-to-ops.js';
import type { RecordKind } from './term-iri.js';

/** A record the import brings that the store may not hold yet: its kind, and an entity's type. */
export interface MintedEnd { kind: SeedKind; type?: string | null }

/** What the import minted, by id: the records it inserts. */
export type MintedEnds = ReadonlyMap<string, MintedEnd>;

const SEED_KINDS: readonly SeedKind[] = ['entity', 'fact', 'chrono'];
const isSeedKind = (k: string): k is SeedKind => (SEED_KINDS as readonly string[]).includes(k);

/** The trusted arguments of an operation: a minted id for an insert of a kind whose identity is minted; none otherwise. */
function trustOf(spaceId: string, op: RecordOp): PlanTrust | undefined {
  return op.op === 'insert' && op.kind !== 'edge' ? trustedPlan(spaceId, { mintedId: op.id }) : undefined;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The planner call of one operation, as a dry-plan item: the same closure the commit calls. */
export function opItem(spaceId: string, op: RecordOp): DryItem {
  const trust = trustOf(spaceId, op);
  const addressed = op.op === 'converge' ? { id: op.id } : {};
  switch (op.kind) {
    case 'entity': {
      const f = op.fields;
      const input: EntityInput = {
        name: text(f.name), type: text(f.type), tags: f.tags, properties: f.properties,
        ...(f.description !== undefined ? { description: f.description } : {}), ...addressed,
      };
      return { kind: 'entity', input, want: entityWant(input, trust), plan: view => planEntity(spaceId, input, view, trust) };
    }
    case 'fact': {
      const f = op.fields;
      const input: FactInput = {
        fact: text(f.fact), tags: f.tags, properties: f.properties, linkEntities: op.links.entity ?? [],
        ...(f.type !== undefined ? { type: f.type } : {}), ...(f.description !== undefined ? { description: f.description } : {}), ...addressed,
      };
      return { kind: 'fact', input, want: factWant(input, trust), plan: view => planFact(spaceId, input, view, trust) };
    }
    case 'chrono': {
      const f = op.fields;
      const input: ChronoInput = {
        fields: {
          title: text(f.title), type: text(f.type) as ChronoType, startsAt: text(f.startsAt), tags: f.tags, properties: f.properties,
          linkEntities: op.links.entity ?? [], linkFacts: op.links.fact ?? [],
          ...(f.endsAt !== undefined ? { endsAt: f.endsAt } : {}), ...(f.status !== undefined ? { status: f.status as ChronoStatus } : {}),
          ...(f.confidence !== undefined ? { confidence: f.confidence } : {}), ...(f.description !== undefined ? { description: f.description } : {}),
          ...(f.recurrence !== undefined ? { recurrence: f.recurrence as NonNullable<ChronoInput['fields']['recurrence']> } : {}),
          ...addressed,
        },
      };
      return { kind: 'chrono', input, want: chronoWant(input, trust), plan: view => planChrono(spaceId, input, view, trust) };
    }
    case 'edge': {
      const f = op.fields;
      const input: EdgeInput = {
        from: f.from, to: f.to, label: f.label, tags: f.tags, properties: f.properties, opts: { fromKind: f.fromKind, toKind: f.toKind },
        ...(f.type !== undefined ? { type: f.type } : {}), ...(f.weight !== undefined ? { weight: f.weight } : {}),
        ...(f.description !== undefined ? { description: f.description } : {}),
      };
      return { kind: 'edge', input, want: edgeWant(spaceId, input, undefined, trust), plan: view => planEdge(spaceId, input, view, trust) };
    }
  }
}

/** The records an operation names as an end or a link, by kind. */
function endsOf(op: RecordOp): Array<{ kind: RefKind; id: string }> {
  if (op.kind === 'fact') return (op.links.entity ?? []).map(id => ({ kind: 'entity' as RefKind, id }));
  if (op.kind === 'chrono') {
    return [...(op.links.entity ?? []).map(id => ({ kind: 'entity' as RefKind, id })), ...(op.links.fact ?? []).map(id => ({ kind: 'fact' as RefKind, id }))];
  }
  if (op.kind === 'edge') return [{ kind: op.fields.fromKind, id: op.fields.from }, { kind: op.fields.toKind, id: op.fields.to }];
  return [];
}

/**
 * Seed `view` with every record `ops` name that the import brings and the store does not hold now (read once to know), with an entity's type.
 * A record the view already holds (seeded, planned or loaded) is left as it is.
 */
export async function seedImported(view: ReadSet, ops: readonly RecordOp[], minted: MintedEnds): Promise<void> {
  const wanted = new Map<SeedKind, Set<string>>();
  for (const op of ops) {
    for (const end of endsOf(op)) {
      const m = minted.get(end.id);
      if (!m || m.kind !== end.kind || !isSeedKind(end.kind) || view.seeded(end.kind, end.id)) continue;
      let ids = wanted.get(end.kind);
      if (!ids) { ids = new Set(); wanted.set(end.kind, ids); }
      ids.add(end.id);
    }
  }
  if (wanted.size === 0) return;
  await view.load({ records: Object.fromEntries([...wanted].map(([k, ids]) => [k, [...ids]])) });
  for (const [kind, ids] of wanted) {
    const absent = [...ids].filter(id => view.stored(kind, id, 'unresolved') === null && !view.seeded(kind, id));
    if (absent.length > 0) await view.seed(kind, absent.map(id => ({ _id: id, ...(kind === 'entity' ? { type: minted.get(id)?.type ?? null } : {}) })));
  }
}

/**
 * The stored records the translation of a window reads, by `recordKey`: each with its link rows when its kind holds links. Read through the
 * planners' own read set (one merged read), so the import reads the store the way its planners will; a fork row reads as absent.
 */
export async function loadStoredRecords(spaceId: string, wants: ReadonlyArray<{ kind: RecordKind; id: string }>): Promise<Map<string, StoredRecord>> {
  const found = new Map<string, StoredRecord>();
  if (wants.length === 0) return found;
  const view = importReadSet(spaceId);
  const records: Partial<Record<RecordKind, string[]>> = {};
  for (const w of wants) (records[w.kind] ??= []).push(w.id);
  const links = wants.filter(w => w.kind === 'fact' || w.kind === 'chrono').map(w => ({ fromKind: w.kind as RefKind, id: w.id }));
  await view.load({ records, ...(links.length > 0 ? { links } : {}) });
  for (const w of wants) {
    const doc = view.stored(w.kind, w.id, 'unresolved');
    if (doc === null) continue;
    found.set(recordKey(w.kind, w.id), { doc, ...(w.kind === 'fact' || w.kind === 'chrono' ? { links: view.storedLinks(w.kind, w.id) } : {}) });
  }
  return found;
}

/** What a dry plan of a window answers: per operation its plan (`null` when refused), and every refusal by operation index. */
export interface DryWindow { plans: ReadonlyArray<WritePlan | null>; refusals: readonly DryRefusal[] }

/** Dry-plan one window of operations against `view` (seeded here), writing nothing. */
export async function dryPlanWindow(spaceId: string, ops: readonly RecordOp[], view: ReadSet, minted: MintedEnds): Promise<DryWindow> {
  await seedImported(view, ops, minted);
  return dryPlan(ops.map(op => opItem(spaceId, op)), view);
}

/** A read set for `spaceId`, as the dry plan and the commit plan against. */
export const importReadSet = (spaceId: string): ReadSet => new ReadSet(spaceId);

/** The commit of a window did not land whole: the act stays owed and runs again. Our sentence; the outcome's reason stays in the log. */
export class ImportCommitIncomplete extends Error {
  override readonly name = 'ImportCommitIncomplete';
}

/**
 * Plan and commit one window of operations, in the store's order of kinds, against a fresh read of the store. Answers how many of the window's
 * operations inserted and how many converged; throws {@link ImportCommitIncomplete} when any did not land (nothing is reported landed then).
 */
export async function commitWindow(spaceId: string, ops: readonly RecordOp[], minted: MintedEnds): Promise<{ inserted: number; converged: number }> {
  const view = importReadSet(spaceId);
  await seedImported(view, ops, minted);
  const items = ops.map(op => opItem(spaceId, op));
  await view.load(mergeWants(items.map(i => i.want)));
  const plans: WritePlan[] = [];
  for (const item of items) plans.push((await item.plan(view)).plan);
  const outcomes = await commitPlans(spaceId, plans);
  const failed = outcomes.findIndex(o => !o.ok);
  // The outcome's own reason can quote a value of the record: it is never put in the sentence, which reaches the act's entry and the log.
  if (failed >= 0) throw new ImportCommitIncomplete(`a ${plans[failed]!.kind} of the import did not land; the import runs again and converges`);
  return { inserted: plans.filter(p => p.op === 'insert').length, converged: plans.filter(p => p.op === 'converge').length };
}
