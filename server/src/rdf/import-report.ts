/**
 * The report of an RDF import: what it read, what it would land or landed per kind, every reason with its statements, and the statements it
 * left out on purpose (bundle-270, slice S6, Q-753). Both import doors, both status doors and the audit row read it.
 *
 * ## What it prevents
 *
 * - **A value of the file repeated.** A statement is shown by its subject, its predicate and its object; a literal object by its datatype (or
 *   language) and its length, never its text. A planner's refusal is shown by its code, the record's kind and subject, and the field names a
 *   schema refusal lists, never the planner's sentence (which can quote the value). The audit row takes counts only.
 * - **An answer as large as the file.** At most {@link RDF_IMPORT_REASONS_NAMED_MAX} reasons are named, each with at most
 *   {@link STATEMENTS_PER_REASON_MAX} statements; every reason is counted (`reasonCount`, `reasonsByCode`), and a refusing reason past the cap
 *   still refuses.
 */
import type { RdfFormat } from './serialize.js';
import type { ImportMode } from './import-reasons.js';
import type { Quad, Term } from './literals.js';
import type { OpKind, ReasonEntry } from './quads-to-ops.js';

/** The most reasons an answer names one by one; the rest are counted (`reasonCount`, `reasonsByCode`). */
export const RDF_IMPORT_REASONS_NAMED_MAX = 100;
/** The most statements one named reason shows. */
export const STATEMENTS_PER_REASON_MAX = 20;
/** The longest field name a refusal row may name in the report: a longer one is a value written into a name's place, and is left out. */
const FIELD_NAME_MAX_CHARS = 200;
/** The kinds an import writes, in the store's commit order (`brain/write-plan/types.ts`, `COMMIT_ORDER`: facts, entities, chrono, edges). */
export const IMPORT_OP_ORDER: readonly OpKind[] = ['fact', 'entity', 'chrono', 'edge'];

/** The code of the reason a record of a commit window is left out for ({@link ReportBuilder.leftOutAtCommit}). */
export const STORED_RECORD_GONE = 'stored_record_gone';

/** One statement of a reason: its subject, predicate and object, a literal object shown by its datatype and length only. */
export interface ReportStatement { subject: string; predicate: string; object: string; graph?: string }

/** One reason an import answers. */
export interface ReportReason {
  code: string;
  outcome: 'refused' | 'recorded';
  message: string;
  statements: ReportStatement[];
  /** The statements this reason covers, of which `statements` shows the first. */
  statementCount: number;
  /** A planner's refusal: the kind of the record, its subject, and the fields a schema refusal names. */
  kind?: string;
  subject?: string;
  fields?: string[];
}

export type RdfImportStatus = 'running' | 'completed' | 'refused' | 'failed' | 'dry-run';

export interface RdfImportReport {
  importId: string;
  space: string;
  status: RdfImportStatus;
  dryRun: boolean;
  format: RdfFormat;
  mode: ImportMode;
  quads: number;
  subjects: number;
  kinds: Record<OpKind, { inserted: number; converged: number }>;
  reasons: ReportReason[];
  reasonCount: number;
  reasonsByCode: Record<string, number>;
  notTaken: Record<string, number>;
  startedAt: string;
  endedAt?: string;
  /** Our sentence when the import failed for good (its folder was lost or cannot be read, or the space can no longer hold it). */
  error?: string;
  /** The status and code a door answers a failure for good by: the same on both doors, kept so the status door and a later reader see it. */
  failure?: { status: number; code: string };
  /** When an owed act (one that failed and will be tried again) is retried: said by the status door, from the act. */
  retryAt?: string;
}

/** Every kind at zero. */
export const emptyKinds = (): RdfImportReport['kinds'] =>
  Object.fromEntries(IMPORT_OP_ORDER.map(kind => [kind, { inserted: 0, converged: 0 }])) as RdfImportReport['kinds'];

/** A term as a statement shows it: an address, a blank node, a triple term by its parts, a literal by its datatype and length. */
function termText(t: Term): string {
  switch (t.kind) {
    case 'iri': return t.value;
    case 'blank': return `_:${t.id}`;
    case 'literal': return `literal(${t.language !== undefined ? `language ${t.language}` : t.datatype ?? 'string'}, ${[...t.value].length} characters)`;
    case 'triple': return `<<( ${termText(t.subject)} ${termText(t.predicate)} ${termText(t.object)} )>>`;
    default: return '?';
  }
}

const statementOf = (q: Quad): ReportStatement => ({
  subject: termText(q.subject), predicate: q.predicate.value, object: termText(q.object), ...(q.graph ? { graph: q.graph.value } : {}),
});

/** The field names a schema refusal's rows name, never their values. */
function violationFields(v: Record<string, unknown>): string[] {
  const rows = Array.isArray(v['violations']) ? v['violations'] : [];
  const names = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    for (const k of ['field', 'key', 'path', 'property']) {
      const name = (row as Record<string, unknown>)[k];
      if (typeof name === 'string' && name.length <= FIELD_NAME_MAX_CHARS) names.add(name);
    }
  }
  return [...names].slice(0, STATEMENTS_PER_REASON_MAX);
}

/** The report as it grows: reasons named up to the cap, every reason counted. */
export class ReportBuilder {
  private refusedBeyondNamed = false;
  constructor(readonly report: RdfImportReport) {}
  /** Whether any reason refuses the import. */
  get refused(): boolean { return this.refusedBeyondNamed || this.report.reasons.some(r => r.outcome === 'refused'); }
  private add(reason: ReportReason): void {
    this.report.reasonCount += 1;
    this.report.reasonsByCode[reason.code] = (this.report.reasonsByCode[reason.code] ?? 0) + 1;
    if (this.report.reasons.length < RDF_IMPORT_REASONS_NAMED_MAX) this.report.reasons.push(reason);
    else if (reason.outcome === 'refused') this.refusedBeyondNamed = true;
  }
  /** A reason the translation answered. */
  translation(r: ReasonEntry): void {
    this.add({
      code: r.code, outcome: r.outcome, message: r.message, statementCount: r.quads.length,
      statements: r.quads.slice(0, STATEMENTS_PER_REASON_MAX).map(statementOf),
    });
  }
  /** A planner's refusal of the record `subject` states. */
  planner(kind: string, subject: string, refusal: { code?: string; violation?: Record<string, unknown> }): void {
    // A schema refusal's code is its body's own `error` (`toStructured`), never spelled here.
    const code = refusal.code ?? (refusal.violation ? String(refusal.violation['error'] ?? 'plan_refused') : 'plan_refused');
    this.add({
      code, outcome: 'refused', kind, subject, statements: [], statementCount: 0,
      message: refusal.violation
        ? `The ${kind} this subject states breaks the space's schema; the fields named are the ones it breaks.`
        : `The ${kind} this subject states would not be written (${code}): a bound, a link, a reference or its version refuses it.`,
      ...(refusal.violation ? { fields: violationFields(refusal.violation) } : {}),
    });
  }
  /**
   * A record of a commit window the store no longer let be written, though the dry plan passed it (a stored record it converges onto, links to
   * or ends at went meanwhile: the database's expiry). The import's earlier windows had landed, so it cannot be refused whole: the reason is
   * RECORDED, and the counts are taken back, so the report says what landed.
   */
  leftOutAtCommit(kind: OpKind, subject: string, op: 'insert' | 'converge'): void {
    this.add({
      code: STORED_RECORD_GONE, outcome: 'recorded', kind, subject, statements: [], statementCount: 0,
      message: `The ${kind} this subject states was not written: after the import was planned, a record it converges onto, links to or ends at was no longer stored. Every other record of the import was written.`,
    });
    this.report.kinds[kind][op === 'insert' ? 'inserted' : 'converged'] -= 1;
  }
  /** A statement left out on purpose. */
  notTaken(why: string, n = 1): void { this.report.notTaken[why] = (this.report.notTaken[why] ?? 0) + n; }
}

/** The audit changes of a report: counts only, never a value of the file. */
export function rdfImportAuditChanges(r: RdfImportReport): Array<{ field: string; to: string | number | boolean }> {
  const sum = (k: 'inserted' | 'converged'): number => IMPORT_OP_ORDER.reduce((n, kind) => n + r.kinds[kind][k], 0);
  return [
    { field: 'format', to: r.format }, { field: 'dryRun', to: r.dryRun }, { field: 'status', to: r.status },
    { field: 'quads', to: r.quads }, { field: 'subjects', to: r.subjects }, { field: 'inserted', to: sum('inserted') },
    { field: 'converged', to: sum('converged') }, { field: 'reasons', to: r.reasonCount },
    { field: 'notTaken', to: Object.values(r.notTaken).reduce((n, v) => n + v, 0) },
  ];
}
