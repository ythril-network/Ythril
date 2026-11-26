/**
 * An evaluated SPARQL Update's change set as planned record writes (bundle-272, Q-761; design d, h, r2 R5, R6): the translate and plan steps
 * of the Update's act (`spaces/sparql-update-act.ts`), between the evaluation (`sparql-update-eval.ts`) and the one write group
 * (`commitWriteGroup`). Nothing here writes a record.
 *
 * ## Why it lives in `rdf/`
 *
 * A new record is planned under an id the instance minted, handed to the planners as a trusted argument (`trustedPlan`), and only the write
 * planners and the RDF code may name one (`a-planner-judges-a-whole-import-before-anything-is-stored`): no door can build a trust from what
 * a request carries.
 *
 * ## What it prevents
 *
 * - **A translation that reads less than it changes.** The translator (`subjectChanges`) is handed every record the change set names (its
 *   subjects, its objects, the ends of its triple terms), each with its link rows, and the stored edge each removed or inserted relation
 *   statement (`<from> <label> <to>`) asserts, read by its triplet.
 * - **DELETE DATA taken for a match.** A statement DELETE DATA states and the store lacks is a no-op, as SPARQL says; a statement a
 *   DELETE ... WHERE matched and the store lacks is stale (the evaluation read an older record). Which is which is read from the Update's own
 *   algebra ({@link statedRemovals}), never guessed.
 * - **A plan made against a record other than the one evaluated.** A record the evaluation read at one version and the planner reads at
 *   another is a lost race ({@link PlannedChangeSet} `stale`): the act runs the whole Update again.
 * - **An identity taken from an address.** A new subject under an address of this space is inserted under a minted UUID, never the
 *   address's id; an edge stated as a bare relation is minted under its triplet.
 * - **A delete planned after what it frees.** Deletes are planned first, so the read set knows them gone (`noteDeleted`) when the inserts
 *   and converges of the same Update are judged.
 */
import { v4 as uuidv4 } from 'uuid';
import type * as N3 from 'n3';
import type { SpaceMeta } from '@ythril-network/schema';
import { ReadSet } from '../brain/write-plan/read-set.js';
import { trustedPlan, type PlanTrust } from '../brain/write-plan/trust.js';
import { planEntity, entityWant, type EntityInput } from '../brain/write-plan/plan-entity.js';
import { planFact, factWant, type FactInput } from '../brain/write-plan/plan-fact.js';
import { planChrono, chronoWant, type ChronoInput } from '../brain/write-plan/plan-chrono.js';
import { planEdge, edgeWant, type EdgeInput } from '../brain/write-plan/plan-edge.js';
import { planDelete } from '../brain/write-plan/plan-delete.js';
import { dryPlan, type DryItem } from '../brain/write-plan/dry-plan.js';
import type { PlanKind, WritePlan } from '../brain/write-plan/types.js';
import type { ChronoStatus, ChronoType } from '../config/types.js';
import type { RefKind } from '../config/types-knowledge.js';
import { RequestRefusal, ForkRowReadOnly, NotFoundError } from '../util/errors.js';
import { RecordVersionAtCeiling } from '../brain/write-precondition.js';
import { loadStoredRecords, seedImported, type MintedEnd } from './import-plan.js';
import { subjectChanges, type ChangedOp, type RecordDelete } from './subject-changes.js';
import { edgeLabelOf, groupSubjectOf, recordKey, tripletKey, type MintedRecord, type ReasonEntry, type StoredRecord } from './quads-to-ops.js';
import { addressNames, recordOfAddress, type AddressNames } from './term-reverse.js';
import { recordIri, resolveTermIri, type RecordKind } from './term-iri.js';
import { iri, type BlankTerm, type IriTerm, type Quad, type Term } from './literals.js';
import type { SparqlAlgebra } from './sparql-engine.js';
import type { ReadRecord } from './quad-source.js';
import type { ImportMode } from './import-reasons.js';

// ── Terms ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The part of an RDF/JS term read here. */
interface RdfJsTerm { termType: string; value: string; language?: string; datatype?: { value: string }; subject?: RdfJsTerm; predicate?: RdfJsTerm; object?: RdfJsTerm }

function termOf(t: RdfJsTerm): Term {
  switch (t.termType) {
    case 'NamedNode': return { kind: 'iri', value: t.value };
    case 'BlankNode': return { kind: 'blank', id: t.value };
    case 'Literal': return { kind: 'literal', value: t.value, ...(t.language ? { language: t.language } : t.datatype ? { datatype: t.datatype.value } : {}) };
    case 'Quad': {
      const subject = termOf(t.subject!) as IriTerm | BlankTerm;
      return { kind: 'triple', subject, predicate: termOf(t.predicate!) as IriTerm, object: termOf(t.object!) };
    }
    default: throw new TypeError(`sparql-update-plan: a ${t.termType} is no term of a change set`);
  }
}

/** A change set's statement in the model the translator reads; the graph is dropped (the change set holds the space's graph alone). */
export function modelQuad(q: N3.Quad): Quad {
  const raw = q as unknown as RdfJsTerm;
  return { subject: termOf(raw.subject!) as IriTerm | BlankTerm, predicate: termOf(raw.predicate!) as IriTerm, object: termOf(raw.object!) };
}

/** A statement's identity without its graph. */
const sigOf = (q: Quad): string => JSON.stringify([q.subject, q.predicate, q.object]);

/**
 * The statements the Update's DELETE DATA parts state, by identity: a `deleteinsert` part with no WHERE is DATA (sparqlalgebrajs), and its
 * `delete` quads are ground. Answers whether a removed statement was stated (`subjectChanges`'s `stated`).
 */
export function statedRemovals(algebra: SparqlAlgebra): (q: Quad) => boolean {
  const root = algebra as unknown as { type?: string; updates?: unknown[] };
  const parts = root.type === 'compositeupdate' && Array.isArray(root.updates) ? root.updates : [algebra];
  const stated = new Set<string>();
  for (const part of parts as Array<{ type?: string; where?: unknown; delete?: N3.Quad[] }>) {
    if (part.type !== 'deleteinsert' || part.where !== undefined) continue;
    for (const q of part.delete ?? []) stated.add(sigOf(modelQuad(q)));
  }
  return (q) => stated.has(sigOf(q));
}

// ── What the change set names ────────────────────────────────────────────────────────────────────────────────────────────

const spaceRecordOf = (t: Term, names: AddressNames): { kind: RecordKind; id: string } | null => {
  if (t.kind !== 'iri') return null;
  const read = recordOfAddress(t.value, names);
  if (read.answer === 'record' && read.of === 'space') return { kind: read.kind, id: read.id };
  if (read.answer === 'record-part' && read.of === 'space') return { kind: 'chrono', id: read.id };
  return null;
};

function nodesOf(q: Quad): Term[] {
  const nodes: Term[] = [q.subject];
  const visit = (t: Term): void => { if (t.kind === 'triple') { nodes.push(t.subject); visit(t.object); } else nodes.push(t); };
  visit(q.object);
  return nodes;
}

/** A minted id per new subject (by its address), and per bare relation (by its triplet key) on first ask, as the import mints them. */
class MintedOnAsk extends Map<string, MintedRecord> {
  /** `storedTriplets`: the triplet keys of the stored edges the change set names, which converge and are never minted (the import's index rule). */
  constructor(private readonly storedTriplets: ReadonlySet<string>) { super(); }
  override get(key: string): MintedRecord | undefined {
    const known = super.get(key);
    if (known !== undefined || !key.startsWith('[') || this.storedTriplets.has(key)) return known;
    const minted: MintedRecord = { kind: 'edge', id: uuidv4() };
    super.set(key, minted);
    return minted;
  }
  override has(key: string): boolean { return this.get(key) !== undefined; }
}

// ── Planning ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A planned write and the record it is of, by its address: what a refusal names. */
interface Item { item: DryItem; kind: PlanKind; id: string; address: string }

function trustOf(spaceId: string, op: ChangedOp): PlanTrust {
  return trustedPlan(spaceId, op.op === 'insert' && op.kind !== 'edge' ? { mintedId: op.id } : {});
}

/** The planner call of one operation, with the removals the Update states (`deleteFields`, `replaceTags`). */
function itemOf(spaceId: string, op: ChangedOp): DryItem {
  const trust = trustOf(spaceId, op);
  const addressed = op.op === 'converge' ? { id: op.id } : {};
  const removals = {
    ...(op.deleteFields && op.deleteFields.length > 0 ? { deleteFields: op.deleteFields } : {}),
    ...(op.replaceTags !== undefined ? { replaceTags: op.replaceTags } : {}),
  };
  switch (op.kind) {
    case 'entity': {
      const f = op.fields;
      const input: EntityInput = {
        name: text(f.name), type: text(f.type), tags: f.tags, properties: f.properties,
        ...(f.description !== undefined ? { description: f.description } : {}), ...addressed, ...removals,
      };
      return { kind: 'entity', input, ...(op.op === 'insert' ? { seededId: op.id } : {}), want: entityWant(input, trust), plan: view => planEntity(spaceId, input, view, trust) };
    }
    case 'fact': {
      const f = op.fields;
      const input: FactInput = {
        fact: text(f.fact), tags: f.tags, properties: f.properties, linkEntities: op.links.entity ?? [],
        ...(f.type !== undefined ? { type: f.type } : {}), ...(f.description !== undefined ? { description: f.description } : {}), ...addressed, ...removals,
      };
      return { kind: 'fact', input, ...(op.op === 'insert' ? { seededId: op.id } : {}), want: factWant(input, trust), plan: view => planFact(spaceId, input, view, trust) };
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
        ...removals,
      };
      return { kind: 'chrono', input, ...(op.op === 'insert' ? { seededId: op.id } : {}), want: chronoWant(input, trust), plan: view => planChrono(spaceId, input, view, trust) };
    }
    case 'edge': {
      const f = op.fields;
      const input: EdgeInput = {
        from: f.from, to: f.to, label: f.label, tags: f.tags, properties: f.properties, opts: { fromKind: f.fromKind, toKind: f.toKind },
        ...(f.type !== undefined ? { type: f.type } : {}), ...(f.weight !== undefined ? { weight: f.weight } : {}),
        ...(f.description !== undefined ? { description: f.description } : {}), ...removals,
      };
      return { kind: 'edge', input, want: edgeWant(spaceId, input, undefined, trust), plan: view => planEdge(spaceId, input, view, trust) };
    }
  }
}

/** A planner's refusal of one record, named by its kind, id and address: the reason, a code when it has one, the rule it broke. */
export interface PlanRefusal { kind: PlanKind; id: string; subject: string; reason: string; code?: string; violation?: Record<string, unknown> }

/** What the translation and the plan of an Update answer. */
export type PlannedChangeSet =
  /** The writes, deletes first, in the order the group writes them; the records they are of; `statements` counts the change set's outcome. */
  | { kind: 'planned'; plans: WritePlan[]; statements: { taken: number; noops: number; notTaken: number } }
  /** A statement no write can take, or a record a planner refused: nothing may land. */
  | { kind: 'refused'; reasons: ReasonEntry[]; refusals: PlanRefusal[] }
  /** The Update read an older record than the one now stored (a removal of what is not stored, or a record read at another version). */
  | { kind: 'stale'; record: { kind: string; id: string } | null; statement?: Quad };

/** The stored records a change set names, with the edges its relation statements assert. */
async function storedNamed(spaceId: string, names: AddressNames, quads: readonly Quad[]): Promise<Map<string, StoredRecord>> {
  const wants: Array<{ kind: RecordKind; id: string }> = [];
  const seen = new Set<string>();
  for (const q of quads) {
    for (const t of nodesOf(q)) {
      const r = spaceRecordOf(t, names);
      if (r === null || r.kind === 'file') continue;
      const key = recordKey(r.kind, r.id);
      if (!seen.has(key)) { seen.add(key); wants.push(r); }
    }
  }
  const stored = await loadStoredRecords(spaceId, wants);
  // The stored edge each relation statement asserts, read by its triplet (an edge has no address in that statement).
  const triplets: Array<{ from: string; to: string; label: string; fromKind: RefKind; toKind: RefKind }> = [];
  for (const q of quads) {
    const label = edgeLabelOf(q.predicate.value, names);
    if (label === null || label === 'shared') continue;
    const from = spaceRecordOf(q.subject, names);
    const to = spaceRecordOf(q.object, names);
    if (!from || !to || from.kind === 'edge' || to.kind === 'edge') continue;
    triplets.push({ from: from.id, to: to.id, label, fromKind: from.kind as RefKind, toKind: to.kind as RefKind });
  }
  if (triplets.length > 0) {
    const view = new ReadSet(spaceId);
    await view.load({ triplets });
    for (const t of triplets) {
      const doc = view.triplet(t);
      if (doc !== null) stored.set(recordKey('edge', String(doc._id)), { doc: doc as unknown as StoredRecord['doc'] });
    }
  }
  return stored;
}

/** The version a stored record is at. */
const seqOf = (rec: StoredRecord | undefined): number | null => (typeof rec?.doc?.['seq'] === 'number' ? rec.doc['seq'] as number : null);

/**
 * The change set of an evaluated Update (`removed`, `inserted`, the records it `read`) as the writes of one group, for `spaceId` whose
 * RESOLVED meta is `meta`; `stated` says which removals DELETE DATA stated.
 */
export async function planChangeSet(
  spaceId: string, meta: SpaceMeta, mode: ImportMode,
  changes: { removed: readonly N3.Quad[]; inserted: readonly N3.Quad[]; reads: readonly ReadRecord[] },
  stated: (q: Quad) => boolean,
): Promise<PlannedChangeSet> {
  const names = addressNames(meta);
  const removed = changes.removed.map(modelQuad);
  const inserted = changes.inserted.map(modelQuad);
  const stored = await storedNamed(spaceId, names, [...removed, ...inserted]);

  // A record the evaluation read at one version and the store now holds at another: what it concluded is stale.
  for (const r of changes.reads) {
    if (r.kind === 'file' || r.kind === 'link') continue;
    const now = stored.get(recordKey(r.kind as RecordKind, r.id));
    if (now !== undefined && seqOf(now) !== r.seq) return { kind: 'stale', record: { kind: r.kind, id: r.id } };
  }

  const storedTriplets = new Set<string>();
  for (const [key, rec] of stored) {
    const [kind] = JSON.parse(key) as [string, string];
    const doc = rec.doc as Record<string, unknown>;
    if (kind !== 'edge' || typeof doc['from'] !== 'string' || typeof doc['to'] !== 'string' || typeof doc['label'] !== 'string') continue;
    const fromKind = (typeof doc['fromKind'] === 'string' ? doc['fromKind'] : 'entity') as RecordKind;
    const toKind = (typeof doc['toKind'] === 'string' ? doc['toKind'] : 'entity') as RecordKind;
    storedTriplets.add(tripletKey(iri(recordIri(meta, fromKind, doc['from'])), iri(resolveTermIri(meta, 'edge', doc['label'])), iri(recordIri(meta, toKind, doc['to']))));
  }
  const minted = new MintedOnAsk(storedTriplets);
  for (const q of inserted) {
    if (q.subject.kind !== 'iri') continue;
    const key = groupSubjectOf(q.subject, names);
    const r = spaceRecordOf({ kind: 'iri', value: key }, names);
    if (r === null || r.kind === 'file' || stored.has(recordKey(r.kind, r.id)) || minted.has(key)) continue;
    minted.set(key, { kind: r.kind, id: uuidv4() });
  }

  const out = subjectChanges({ names, meta, mode, stored, minted }, removed, inserted, { stated });
  const refusing = out.reasons.filter(r => r.outcome === 'refused');
  if (refusing.length > 0) return { kind: 'refused', reasons: refusing, refusals: [] };
  if (out.stale.length > 0) {
    const s = out.stale[0]!;
    const r = spaceRecordOf(s.subject, names);
    return { kind: 'stale', record: r, statement: s };
  }

  const deletes = out.ops.filter((o): o is RecordDelete => o.op === 'delete');
  const writes = out.ops.filter((o): o is ChangedOp => o.op !== 'delete');
  const view = new ReadSet(spaceId);
  const refusals: PlanRefusal[] = [];
  const plans: WritePlan[] = [];
  const addressOf = (o: { correlation: string }): string => o.correlation;
  if (deletes.length > 0) {
    const records: Partial<Record<PlanKind, string[]>> = {};
    for (const d of deletes) (records[d.kind] ??= []).push(d.id);
    await view.load({ records });
    for (const d of deletes) {
      try {
        plans.push(planDelete(view, d.kind, d.id));
      } catch (err) {
        if (!(err instanceof NotFoundError || err instanceof ForkRowReadOnly || err instanceof RecordVersionAtCeiling || err instanceof RequestRefusal)) throw err;
        refusals.push({ kind: d.kind, id: d.id, subject: addressOf(d), reason: err.message });
      }
    }
  }
  const items: Item[] = writes.map(op => ({ item: itemOf(spaceId, op), kind: op.kind, id: op.id, address: addressOf(op) }));
  const seeds = new Map<string, MintedEnd>();
  for (const op of writes) {
    if (op.op === 'insert' && op.kind !== 'edge') seeds.set(op.id, { kind: op.kind, ...(op.kind === 'entity' ? { type: typeof op.fields.type === 'string' ? op.fields.type : null } : {}) });
  }
  await seedImported(view, writes, seeds);
  const dry = await dryPlan(items.map(i => i.item), view);
  for (const r of dry.refusals) {
    const i = items[r.index]!;
    refusals.push({ kind: i.kind, id: i.id, subject: i.address, reason: r.reason, ...(r.code ? { code: r.code } : {}), ...(r.violation ? { violation: r.violation } : {}) });
  }
  if (refusals.length > 0) return { kind: 'refused', reasons: [], refusals };
  for (const p of dry.plans) if (p !== null) plans.push(p);
  return { kind: 'planned', plans, statements: { taken: out.taken, noops: out.noops.length, notTaken: out.notTaken.length } };
}
