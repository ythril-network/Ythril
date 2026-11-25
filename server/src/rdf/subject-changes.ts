/**
 * The statements a change removes and inserts, turned into the record writes they state, or the reason each cannot be one (bundle-272,
 * Q-964; design answer d, challenge F1, F2, F5, vet-1 S8, vet-2 S6, S9). The entry the SPARQL Update's act (Q-761) calls with an evaluated
 * change set (`sparql-update-eval.ts`); the translation of the statements themselves is the import's (`quadsToOps`), never a second copy of its
 * rules.
 *
 * ## What it prevents
 *
 * - **A value deleted that nobody named.** A removal is built only from a removed statement the store holds: a key whose stored statements
 *   were all removed and none inserted. Never from "what the record holds minus what the target states": the record form skips a list, an
 *   object, a value that fits no declared type and a number that is no decimal (`record-triples.ts`, `counts.skippedValues`), so a stored value
 *   it skipped looks absent from the target and would be deleted. Such a value stays stored (the converge states what the statements state, the
 *   planners merge it over the stored one), and a removed statement that names its key is refused (`server-owned-removed`: the form does not
 *   carry the value, so no statement can take it away).
 * - **A tag removal undone.** Tags are a replacement (`replaceTags`: the target set), never a merge plus a removal: the planners' merge unions
 *   the stated tags with the stored ones, so a removed tag stated nowhere would come back.
 * - **A removal that reads an older record.** A removed statement the store does not hold is `stale` (the Update was evaluated on a record
 *   that has changed: the act re-runs it), except under DELETE DATA, where it is a no-op as SPARQL says (`opts.stated`). An inserted statement the
 *   store already holds is a no-op.
 * - **A record written twice, or under a spelling.** Statements are grouped by the record they belong to (its kind and id, from the address,
 *   a chrono's time nodes included), never by the text of the subject.
 * - **A statement taken for a field.** A removal of a server-owned or derived statement (a time node, the author, the stamp), of a field the record
 *   must keep (its name, text, start, status, type) and of a property whose key is not one path segment is refused with its reason; so are a blank
 *   node as a subject, a subject that is a file, an edge whose ends or label would change, and a new record under an address that names none of
 *   this space's records. A retype is a converge (the type statements replace each other); removing every type statement with none inserted is a
 *   delete; removing one while the kind marker stays is refused.
 *
 * ## The target
 *
 * A stored record's target is its form (`recordTriples`, in the RDF 1.2 form the quad source reads, with the link rows as `dcterms:references`)
 * minus the removed statements plus the inserted. It is read by `quadsToOps` with nothing taken from the stored record (the record's own entry
 * is hidden from the translator's context, so its converge fill does not undo a removal) and then given its stored fields back: a field the
 * statements do not state and no removal names is the stored one. `deleteFields` are the keys named by removed statements (each read by the
 * translator itself, with the record's type statements for company) that the target no longer states.
 *
 * ## The context
 *
 * Handed in as data, as for an import: the names, the resolved meta, the mode, the stored records by {@link recordKey} (every record the change
 * set names, an edge a removed relation statement names, and an edge's ends), and the ids minted for new subjects. Nothing is read from a store,
 * nothing minted, no state held. Statements are of one graph (the change set's store puts them in the space's graph).
 */
import type { SpaceMeta } from '@ythril-network/schema';
import { DELETABLE_FIELDS, validateDeleteFields } from '../brain/delete-fields.js';
import { isRefKind } from '../config/types-knowledge.js';
import { IMPORT_REASONS, NOT_TAKEN, reasonOutcome, type ImportMode, type ImportReasonCode } from './import-reasons.js';
import { iri, stdIri, type IriTerm, type Quad, type Term } from './literals.js';
import {
  classOfType, edgeLabelOf, groupSubjectOf, LINKS_HELD, predicateRole, quadsToOps, recordKey, tripletsOfGroup, WRITABLE,
  type EntityFields, type FactFields, type ChronoFields, type EdgeFields, type Links, type MintedRecord, type NotTakenEntry, type OpKind, type QuadsToOpsContext,
  type QuadsToOpsResult, type ReasonEntry, type RecordOp, type StoredRecord,
} from './quads-to-ops.js';
import { recordTriples } from './record-triples.js';
import { recordAddressable, recordIri } from './term-iri.js';
import { recordOfAddress, type AddressNames } from './term-reverse.js';

export interface SubjectChangesContext {
  names: AddressNames;
  /** The space's RESOLVED meta. */
  meta: SpaceMeta;
  mode: ImportMode;
  /** By {@link recordKey}: every record the change set names, with its link rows. A record that is not here is not stored. */
  stored: ReadonlyMap<string, StoredRecord>;
  /** By the subject's address, the id minted for each new subject of an address of this space (and by triplet key, an edge without details). */
  minted: ReadonlyMap<string, MintedRecord>;
  leaveOut?: ReadonlySet<string>;
}

export interface SubjectChangesOptions {
  /** Whether a removed statement was STATED by the Update (DELETE DATA): stated and not stored is a no-op; matched and not stored is stale. */
  stated?: (quad: Quad) => boolean;
}

/** A converge or an insert of the import's form, with the removals the planners take (`deleteFields`, `replaceTags`). */
export type ChangedOp = RecordOp & { deleteFields?: string[]; replaceTags?: string[] };
/** A record the change set deletes: every type statement of it removed, none inserted. */
export interface RecordDelete { op: 'delete'; kind: OpKind; id: string; correlation: string; graph: string | null }

export interface SubjectChangesResult {
  ops: Array<ChangedOp | RecordDelete>;
  reasons: ReasonEntry[];
  notTaken: NotTakenEntry[];
  /** Removed statements the store does not hold, matched by the Update: it read an older record. */
  stale: Quad[];
  /** Statements that change nothing: a removal DELETE DATA stated and the store lacks, an insert the store holds. */
  noops: Quad[];
  /** Statements that are part of a write. Taken, left out, reasons, stale and no-ops add up to the change set's size. */
  taken: number;
}

const RDF_TYPE = stdIri('rdf', 'type').value;
const REFERENCES = stdIri('dcterms', 'references').value;
const RDFS_LABEL = stdIri('rdfs', 'label').value;
const KEYWORDS = stdIri('schema', 'keywords').value;
const STATEMENT_PREDICATES = new Set(['reifies', 'subject', 'predicate', 'object'].map(l => stdIri('rdf', l).value));
const XSD_STRING = stdIri('xsd', 'string').value;
/** Fields the translator reads that are no field of the record a removal can name. */
const NOT_A_FIELD = new Set(['tags', 'properties', 'from', 'fromKind', 'to', 'toKind', 'label']);

function sig(t: Term): string {
  switch (t.kind) {
    case 'iri': return JSON.stringify(['i', t.value]);
    case 'blank': return JSON.stringify(['b', t.id]);
    case 'literal': return JSON.stringify(['l', t.value, t.datatype === undefined || t.datatype === XSD_STRING ? '' : t.datatype, (t.language ?? '').toLowerCase()]);
    case 'triple': return JSON.stringify(['t', sig(t.subject), sig(t.predicate), sig(t.object)]);
    case 'list': return JSON.stringify(['L', ...t.items.map(sig)]);
  }
}
/** A statement without its graph: the change set holds one graph, the form none. */
const quadSig = (q: Quad): string => `${sig(q.subject)}${sig(q.predicate)}${sig(q.object)}`;
const isNode = (t: Term): boolean => t.kind === 'iri' || t.kind === 'blank';
const isBag = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const sortedStrings = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))].sort() : []);

type Owner =
  | { as: 'record'; kind: OpKind; id: string; key: string }
  | { as: 'refuse'; code: ImportReasonCode }
  | { as: 'server' }
  | { as: 'foreign' };

/** The stored record's own form, and what the form leaves out of it. */
interface Form { quads: Quad[]; sigs: Set<string>; skipped: Set<string>; own: IriTerm; identity: Quad[] }

interface Group { key: string; kind: OpKind; id: string; addressKey: string; removed: Quad[]; inserted: Quad[]; graph: string | null }

const graphOf = (q: Quad): string | null => q.graph?.value ?? null;

class Run {
  private readonly placed = new Set<Quad>();
  private readonly out: SubjectChangesResult = { ops: [], reasons: [], notTaken: [], stale: [], noops: [], taken: 0 };
  private readonly forms = new Map<string, Form | null>();
  private edgeByRelation: Map<string, string> | null = null;
  /** The context the translator is handed: the stored records, and the triplets the whole change asserts and reifies (see {@link Run.translate}). */
  private readonly work: Map<string, StoredRecord>;
  private readonly workAsserted = new Set<string>();
  private readonly workReified = new Set<string>();
  /** Whether a reason that refuses was answered for the group being worked: its operations are not emitted. */
  private refusedHere = false;

  constructor(private readonly ctx: SubjectChangesContext, private readonly opts: SubjectChangesOptions) {
    this.work = new Map(ctx.stored);
  }

  // ------------------------------------------------------------------------------------------------------------------------------------
  // The ledger

  private place(q: Quad): void {
    if (this.placed.has(q)) throw new Error('subject-changes placed one statement twice');
    this.placed.add(q);
  }
  private unplaced(quads: readonly Quad[]): Quad[] { return quads.filter(q => !this.placed.has(q)); }
  private refuse(code: ImportReasonCode, quads: readonly Quad[]): void {
    const open = this.unplaced(quads);
    if (open.length === 0) return;
    open.forEach(q => this.place(q));
    const outcome = reasonOutcome(code, this.ctx.mode);
    if (outcome === 'refused') this.refusedHere = true;
    this.out.reasons.push({ code, message: IMPORT_REASONS[code].message, outcome, kept: false, quads: open });
  }
  private noop(q: Quad): void { this.place(q); this.out.noops.push(q); }
  private notStored(q: Quad): void {
    this.place(q);
    if (this.opts.stated?.(q) === true) this.out.noops.push(q); else this.out.stale.push(q);
  }
  private take(quads: readonly Quad[]): void { for (const q of this.unplaced(quads)) { this.place(q); this.out.taken++; } }

  /** What `quadsToOps` answered, kept for the statements of the change set only: a reason or a left-out statement of a stored statement is the stored record's, not the change's. */
  private absorb(result: QuadsToOpsResult, mine: ReadonlySet<Quad>): void {
    for (const r of result.reasons) {
      const quads = this.unplaced(r.quads.filter(q => mine.has(q)));
      if (quads.length === 0) continue;
      quads.forEach(q => this.place(q));
      if (r.outcome === 'refused') this.refusedHere = true;
      this.out.reasons.push({ ...r, quads });
    }
    for (const n of result.notTaken) {
      if (!mine.has(n.quad) || this.placed.has(n.quad)) continue;
      this.place(n.quad);
      this.out.notTaken.push(n);
    }
  }

  // ------------------------------------------------------------------------------------------------------------------------------------
  // What is stored

  private ownerOf(subject: Quad['subject']): Owner {
    if (subject.kind === 'blank') return { as: 'refuse', code: 'blank-node-subject' };
    const read = recordOfAddress(subject.value, this.ctx.names);
    switch (read.answer) {
      case 'record':
        if (read.of !== 'space') return { as: 'foreign' };
        return read.kind === 'file' ? { as: 'refuse', code: 'not-writable-here' } : { as: 'record', kind: read.kind, id: read.id, key: recordKey(read.kind, read.id) };
      case 'record-part': return read.of === 'space' ? { as: 'record', kind: 'chrono', id: read.id, key: recordKey('chrono', read.id) } : { as: 'foreign' };
      case 'other': return { as: 'server' };
      case 'refused': return { as: 'refuse', code: 'not-an-address-the-export-writes' };
      case 'foreign': return { as: 'foreign' };
    }
  }

  private formOf(kind: OpKind, id: string): Form | null {
    const key = recordKey(kind, id);
    if (this.forms.has(key)) return this.forms.get(key)!;
    const rec = this.ctx.stored.get(key);
    let form: Form | null = null;
    if (rec !== undefined) {
      const made = recordTriples(this.ctx.meta, kind, rec.doc, { edgeDetails: 'rdf12' });
      const quads = [...made.quads];
      const own = iri(recordIri(this.ctx.meta, kind, id));
      // The link rows of a fact and a chrono entry are statements of the record: its `dcterms:references`.
      for (const [lk, ids] of Object.entries(rec.links ?? {})) {
        if (!isRefKind(lk) || !(LINKS_HELD[kind] ?? []).includes(lk)) continue;
        for (const to of ids ?? []) if (recordAddressable(lk, to)) quads.push({ subject: own, predicate: iri(REFERENCES), object: iri(recordIri(this.ctx.meta, lk, to)) });
      }
      const identity = quads.filter(q => q.subject.kind === 'iri' && q.subject.value === own.value && (q.predicate.value === RDF_TYPE || STATEMENT_PREDICATES.has(q.predicate.value)));
      form = { quads, sigs: new Set(quads.map(quadSig)), skipped: new Set(made.counts.skippedValues.map(s => s.key)), own, identity };
    }
    this.forms.set(key, form);
    return form;
  }

  /** The stored edge a relation statement (`<from> <label> <to>`) is the asserted triple of, by its statement. */
  private edgeOfRelation(q: Quad): string | null {
    if (edgeLabelOf(q.predicate.value, this.ctx.names) === null || !isNode(q.object)) return null;
    if (this.edgeByRelation === null) {
      this.edgeByRelation = new Map();
      for (const key of this.ctx.stored.keys()) {
        const [kind, id] = JSON.parse(key) as [string, string];
        if (kind !== 'edge') continue;
        const form = this.formOf('edge', id);
        const relation = form?.quads.find(x => x.subject.kind === 'iri' && x.subject.value !== form.own.value && edgeLabelOf(x.predicate.value, this.ctx.names) !== null);
        if (relation !== undefined) this.edgeByRelation.set(quadSig(relation), id);
      }
    }
    return this.edgeByRelation.get(quadSig(q)) ?? null;
  }

  // ------------------------------------------------------------------------------------------------------------------------------------
  // The translation of statements, nothing taken from the stored record

  /**
   * `quadsToOps` over `group` with the record's own entry hidden, so no field is filled from it and no removal is undone. The triplets it reads
   * edges by are the whole change's (what is inserted and what the touched records still state) and the group's own.
   */
  private translate(group: readonly Quad[], g: Group, hide: boolean): QuadsToOpsResult {
    // The working copies are this run's own: an entry is hidden or added for the one call and put back, so a call costs what it names, not the size of the context.
    const swapped = new Map<string, StoredRecord | undefined>();
    const swap = (key: string, value: StoredRecord | undefined): void => {
      if (!swapped.has(key)) swapped.set(key, this.work.get(key));
      if (value === undefined) this.work.delete(key); else this.work.set(key, value);
    };
    const addedTriplets: Array<[Set<string>, string]> = [];
    const triplets = tripletsOfGroup(group);
    for (const [set, keys] of [[this.workAsserted, triplets.asserted], [this.workReified, triplets.reified]] as const) {
      for (const k of keys) if (!set.has(k)) { set.add(k); addedTriplets.push([set, k]); }
    }
    const minted = hide ? new Map([...this.ctx.minted, [g.addressKey, { kind: g.kind, id: g.id }]]) : this.ctx.minted;
    try {
      if (hide) {
        swap(g.key, undefined);
        // An edge's ends are what it is judged against: they are known to be there though the change set does not name them.
        const doc = this.ctx.stored.get(g.key)?.doc;
        if (g.kind === 'edge' && doc !== undefined) {
          for (const [side, kindField] of [['from', 'fromKind'], ['to', 'toKind']] as const) {
            const end = doc[side];
            const endKind = typeof doc[kindField] === 'string' ? doc[kindField] : 'entity';
            if (typeof end === 'string' && typeof endKind === 'string' && isRefKind(endKind) && !this.work.has(recordKey(endKind, end))) swap(recordKey(endKind, end), { doc: { _id: end } });
          }
        }
      }
      const tctx: QuadsToOpsContext = {
        names: this.ctx.names, meta: this.ctx.meta, mode: this.ctx.mode, blankNodes: 'refuse', stored: this.work, minted,
        asserted: this.workAsserted, reified: this.workReified, ...(this.ctx.leaveOut !== undefined ? { leaveOut: this.ctx.leaveOut } : {}),
      };
      return quadsToOps(group, tctx);
    } finally {
      for (const [key, value] of swapped) { if (value === undefined) this.work.delete(key); else this.work.set(key, value); }
      for (const [set, k] of addedTriplets) set.delete(k);
    }
  }

  /** The fields, properties, tags and link a removed statement names on its record, read by the translator itself; `null` when it names none (it is left out or refused). */
  private namedBy(r: Quad, g: Group, form: Form): { fields: string[]; properties: string[]; tags: boolean } | null {
    const result = this.translate([...form.identity, r], g, true);
    const op = result.ops.find(o => o.correlation === g.addressKey && o.kind === g.kind);
    if (op === undefined || result.reasons.some(x => x.quads.includes(r)) || result.notTaken.some(x => x.quad === r)) return null;
    const body = op.fields as unknown as Record<string, unknown>;
    const fields: string[] = [];
    for (const k of Object.keys(body)) {
      if (NOT_A_FIELD.has(k) || body[k] === undefined) continue;
      if (k === 'type' && g.kind !== 'edge') continue; // the type of the other kinds is read from the type statements, never from a data statement
      if ((k === 'name' || k === 'title') && r.predicate.value !== RDFS_LABEL) continue; // a new record's name by its address is no statement
      if (k === 'recurrence' && isBag(body[k])) fields.push(...Object.keys(body[k]).map(p => `recurrence.${p}`)); else fields.push(k);
    }
    return { fields, properties: Object.keys(body['properties'] as object), tags: (body['tags'] as unknown[]).length > 0 };
  }

  // ------------------------------------------------------------------------------------------------------------------------------------
  // The change set

  go(removed: readonly Quad[], inserted: readonly Quad[]): SubjectChangesResult {
    const groups = new Map<string, Group>();
    const pending = new Map<ImportReasonCode, Quad[]>();
    const refuseLater = (code: ImportReasonCode, q: Quad): void => { (pending.get(code) ?? pending.set(code, []).get(code)!).push(q); };
    const add = (q: Quad, side: 'removed' | 'inserted'): void => {
      const edge = this.edgeOfRelation(q);
      let owner: Owner;
      if (edge !== null) {
        if (side === 'inserted') { this.noop(q); return; }
        owner = { as: 'record', kind: 'edge', id: edge, key: recordKey('edge', edge) };
      } else owner = this.ownerOf(q.subject);
      if (owner.as === 'refuse') { refuseLater(owner.code, q); return; }
      if (owner.as === 'server') {
        if (side === 'removed') refuseLater('server-owned-removed', q);
        else { this.place(q); this.out.notTaken.push({ quad: q, why: 'server-owned', message: NOT_TAKEN['server-owned'] }); }
        return;
      }
      if (owner.as === 'foreign') {
        if (side === 'removed') this.notStored(q); else refuseLater('subject-not-an-address-here', q);
        return;
      }
      let g = groups.get(owner.key);
      if (g === undefined) {
        g = { key: owner.key, kind: owner.kind, id: owner.id, addressKey: recordIri(this.ctx.meta, owner.kind, owner.id), removed: [], inserted: [], graph: graphOf(q) };
        groups.set(owner.key, g);
      }
      g[side].push(q);
    };
    removed.forEach(q => add(q, 'removed'));
    inserted.forEach(q => add(q, 'inserted'));
    for (const [code, quads] of pending) this.refuse(code, quads);
    this.refusedHere = false;

    // The statements the triplets of a translation are read from: what is inserted and what the touched records still state.
    const gone = new Set(removed.map(quadSig));
    const universe: Quad[] = [...inserted];
    for (const g of groups.values()) universe.push(...(this.formOf(g.kind, g.id)?.quads ?? []).filter(q => !gone.has(quadSig(q))));
    const triplets = tripletsOfGroup(universe);
    triplets.asserted.forEach(k => this.workAsserted.add(k));
    triplets.reified.forEach(k => this.workReified.add(k));

    for (const g of groups.values()) {
      this.refusedHere = false;
      const ops = this.group(g);
      if (!this.refusedHere) this.out.ops.push(...ops);
    }
    const total = removed.length + inserted.length;
    const placed = this.out.taken + this.out.notTaken.length + this.out.reasons.reduce((n, r) => n + r.quads.length, 0) + this.out.stale.length + this.out.noops.length;
    if (placed !== total) throw new Error('subject-changes left a statement of the change set unaccounted for');
    return this.out;
  }

  private group(g: Group): Array<ChangedOp | RecordDelete> {
    const form = this.formOf(g.kind, g.id);
    return form === null ? this.unstored(g) : this.stored(g, form);
  }

  /** A record the store does not hold: its removals are stale, its inserts the import's own translation under the id minted for it. */
  private unstored(g: Group): ChangedOp[] {
    g.removed.forEach(q => this.notStored(q));
    if (g.inserted.length === 0) return [];
    const addressKey = groupSubjectOf(g.inserted[0]!.subject, this.ctx.names);
    const result = this.translate(g.inserted, { ...g, addressKey }, false);
    this.absorb(result, new Set(g.inserted));
    this.take(g.inserted);
    return result.ops;
  }

  private stored(g: Group, form: Form): Array<ChangedOp | RecordDelete> {
    const rec = this.ctx.stored.get(g.key)!;
    const doc = rec.doc as Record<string, unknown>;
    const own = form.own.value;
    const removedSigs = new Set(g.removed.map(quadSig));
    const insertedSigs = new Set(g.inserted.map(quadSig));
    // A statement both removed and inserted changes nothing.
    const removedHeld: Quad[] = [];
    for (const r of g.removed) {
      const s = quadSig(r);
      if (!form.sigs.has(s)) {
        const named = form.skipped.size > 0 ? this.namedBy(r, g, form) : null;
        if (named !== null && [...named.fields, ...named.properties].some(k => form.skipped.has(k))) this.refuse('server-owned-removed', [r]);
        else this.notStored(r);
      } else if (insertedSigs.has(s)) this.noop(r);
      else removedHeld.push(r);
    }
    const added: Quad[] = [];
    for (const a of g.inserted) {
      if (this.placed.has(a)) continue;
      const s = quadSig(a);
      if (form.sigs.has(s)) this.noop(a); else added.push(a);
    }

    // The kind of each removed statement.
    const ofOwn = (q: Quad): boolean => q.subject.kind === 'iri' && q.subject.value === own;
    const isType = (q: Quad): boolean => ofOwn(q) && q.predicate.value === RDF_TYPE;
    const settles = (q: Quad): boolean => { const c = classOfType(q.object); return c.as === 'marker' || c.as === 'untyped' || c.as === 'class'; };
    const relation = (q: Quad): boolean => edgeLabelOf(q.predicate.value, this.ctx.names) !== null && isNode(q.object);
    const serverOwned: Quad[] = [];
    const typeRemoved: Quad[] = [];
    const statements: Quad[] = [];
    const links: Quad[] = [];
    const tags: Quad[] = [];
    const data: Quad[] = [];
    for (const r of removedHeld) {
      if (g.kind === 'edge' && !ofOwn(r) && relation(r)) statements.push(r);
      else if (!ofOwn(r)) serverOwned.push(r);
      else if (r.predicate.value === RDF_TYPE) (settles(r) ? typeRemoved : serverOwned).push(r);
      else if (STATEMENT_PREDICATES.has(r.predicate.value)) statements.push(r);
      else if (r.predicate.value === REFERENCES) links.push(r);
      else if (r.predicate.value === KEYWORDS) tags.push(r);
      else if (predicateRole(r.predicate.value, g.kind) === 'server-owned' || predicateRole(r.predicate.value, g.kind) === 'derived') serverOwned.push(r);
      else data.push(r);
    }

    // A record whose every type statement goes, none inserted, goes.
    const typesStored = form.quads.filter(q => isType(q) && settles(q));
    const typesAdded = added.filter(q => isType(q) && settles(q));
    if (typeRemoved.length > 0 && typesAdded.length === 0) {
      const left = typesStored.filter(q => !removedSigs.has(quadSig(q)));
      if (left.length === 0) {
        this.take(removedHeld);
        this.refuse('no-kind', added);
        return [{ op: 'delete', kind: g.kind, id: g.id, correlation: g.addressKey, graph: g.graph }];
      }
      this.refuse('field-not-removable', typeRemoved);
    }
    this.refuse('server-owned-removed', serverOwned);

    // The target, read by the translator with nothing taken from the stored record.
    const target = [...form.quads.filter(q => !removedSigs.has(quadSig(q)) && groupSubjectOf(q.subject, this.ctx.names) === g.addressKey), ...added];
    const result = this.translate(target, g, true);
    this.absorb(result, new Set(added));
    // What the translator did not answer for is taken; a relation it carried with a reifier is taken too.
    const taken = this.unplaced(added);
    this.take(taken);
    const record = result.ops.find(o => o.correlation === g.addressKey && o.kind === g.kind);
    const extra = result.ops.filter(o => o !== record);

    // An edge keeps its ends and label.
    const edgeAdds = added.filter(q => STATEMENT_PREDICATES.has(q.predicate.value));
    if (g.kind === 'edge' && (statements.length > 0 || edgeAdds.length > 0)) {
      const f = record?.kind === 'edge' ? record.fields : undefined;
      const same = f !== undefined && f.from === doc['from'] && f.to === doc['to'] && f.label === doc['label'] && f.toKind === (doc['toKind'] ?? 'entity') && f.fromKind === (doc['fromKind'] ?? 'entity');
      if (!same) this.refuse('edge-ends-change', [...statements, ...edgeAdds]);
    }
    if (record === undefined) { this.take(removedHeld); return [...extra]; }

    // The removals: the keys removed statements name that the target no longer states.
    const body = record.fields as unknown as Record<string, unknown>;
    const stated = (k: string): boolean => (k === 'name' || k === 'title') ? target.some(q => q.predicate.value === RDFS_LABEL && ofOwn(q)) : body[k] !== undefined;
    const props = body['properties'] as Record<string, unknown>;
    const recurrenceNow = isBag(body['recurrence']) ? body['recurrence'] : {};
    const paths: string[] = [];
    const removedFields = new Set<string>();
    const removedParts = new Set<string>();
    const removable: readonly string[] = DELETABLE_FIELDS[g.kind];
    for (const r of data) {
      const named = this.namedBy(r, g, form);
      if (named === null) { this.refuse('server-owned-removed', [r]); continue; }
      let refused = false;
      for (const key of named.properties) {
        if (Object.hasOwn(props, key)) continue;
        if (key.includes('.') || key === '*' || key === '') { this.refuse('field-not-removable', [r]); refused = true; continue; }
        paths.push(`properties.${key}`);
      }
      for (const field of named.fields) {
        const [top, part] = field.split('.') as [string, string | undefined];
        if (part !== undefined) {
          if (!removable.includes(top)) { this.refuse('field-not-removable', [r]); refused = true; continue; }
          if (!Object.hasOwn(recurrenceNow, part)) removedParts.add(part);
          continue;
        }
        if (stated(top)) continue;
        if (!removable.includes(top)) { this.refuse('field-not-removable', [r]); refused = true; continue; }
        removedFields.add(top);
        paths.push(top);
      }
      if (!refused) this.take([r]);
    }
    if (removedParts.size > 0) {
      const whole = Object.keys(recurrenceNow).length === 0;
      if (whole) { removedFields.add('recurrence'); paths.push('recurrence'); } else for (const p of removedParts) paths.push(`recurrence.${p}`);
    }
    const unique = [...new Set(paths)];
    if (unique.length > 0) {
      const valid = validateDeleteFields(unique);
      if (!valid.ok) this.refuse('field-not-removable', data);
    }

    // The tags are the target's, replacing what is stored; the links the stored ones less the removed plus the stated.
    const tagsNow = sortedStrings(body['tags']);
    const tagsThen = sortedStrings(doc['tags']);
    const changesTags = tags.length > 0 || added.some(q => q.predicate.value === KEYWORDS);
    const replaceTags = changesTags && JSON.stringify(tagsNow) !== JSON.stringify(tagsThen) ? tagsNow : undefined;
    this.take(tags);
    const removedLinks = new Map<string, Set<string>>();
    for (const l of links) {
      const read = l.object.kind === 'iri' ? recordOfAddress(l.object.value, this.ctx.names) : null;
      if (read?.answer === 'record') (removedLinks.get(read.kind) ?? removedLinks.set(read.kind, new Set()).get(read.kind)!).add(read.id);
    }
    this.take(links);
    this.take(statements);
    this.take(typeRemoved);

    // Whether the record itself is written: something removed, or something inserted that is no relation another record carries.
    const written = data.length + tags.length + links.length + typeRemoved.length > 0 || taken.some(q => !relation(q));
    if (!written) return [...extra];

    const fields: Record<string, unknown> = {};
    for (const f of WRITABLE[g.kind]) {
      if (stated(f)) fields[f] = body[f];
      else if (!removedFields.has(f) && doc[f] !== undefined && doc[f] !== null) fields[f] = doc[f];
    }
    if (g.kind === 'chrono') {
      const base = isBag(doc['recurrence']) ? { ...doc['recurrence'] } : {};
      for (const p of removedParts) delete base[p];
      const merged = { ...base, ...recurrenceNow };
      if (Object.keys(merged).length > 0 && !removedFields.has('recurrence')) fields['recurrence'] = merged;
    }
    const allLinks: Links = {};
    for (const [k, ids] of Object.entries(rec.links ?? {})) {
      if (!isRefKind(k) || ids === undefined) continue;
      const goneIds = removedLinks.get(k);
      const kept = ids.filter(id => goneIds?.has(id) !== true);
      if (kept.length > 0) allLinks[k] = [...kept];
    }
    const wanted = 'links' in record ? record.links : {};
    for (const [k, ids] of Object.entries(wanted)) if (isRefKind(k) && ids !== undefined) allLinks[k] = [...new Set([...(allLinks[k] ?? []), ...ids])].sort();
    const base = { op: 'converge' as const, id: g.id, correlation: g.addressKey, graph: g.graph };
    const fieldsOut = { ...fields, tags: replaceTags ?? tagsThen, properties: props };
    const extras = {
      ...(unique.length > 0 ? { deleteFields: unique } : {}),
      ...(replaceTags !== undefined ? { replaceTags } : {}),
    };
    const op = ((): ChangedOp => {
      switch (g.kind) {
        case 'entity': return { ...base, kind: 'entity', fields: fieldsOut as unknown as EntityFields, ...extras };
        case 'fact': return { ...base, kind: 'fact', fields: fieldsOut as unknown as FactFields, links: allLinks, ...extras };
        case 'chrono': return { ...base, kind: 'chrono', fields: fieldsOut as unknown as ChronoFields, links: allLinks, ...extras };
        case 'edge': return { ...base, kind: 'edge', fields: { ...fieldsOut, ...edgeEnds(record) } as unknown as EdgeFields, ...extras };
      }
    })();
    return [op, ...extra];
  }
}

/** An edge's ends and label as the translator read them. */
function edgeEnds(op: RecordOp): Record<string, unknown> {
  if (op.kind !== 'edge') return {};
  const { from, fromKind, to, toKind, label } = op.fields;
  return { from, fromKind, to, toKind, label };
}

/**
 * The record writes the statements `removed` and `inserted` state, or the reason each cannot be one. See the module comment. `ctx.stored` holds
 * every stored record the change set names; the answer accounts for every statement of it (`taken`, `notTaken`, `reasons`, `stale`, `noops`).
 * Pure.
 */
export function subjectChanges(ctx: SubjectChangesContext, removed: readonly Quad[], inserted: readonly Quad[], opts: SubjectChangesOptions = {}): SubjectChangesResult {
  return new Run(ctx, opts).go(removed, inserted);
}
