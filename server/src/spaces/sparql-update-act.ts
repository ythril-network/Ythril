/**
 * A SPARQL 1.1 Update on one space, from its text to records landed (bundle-272, Q-761; design h, r2 R4, R5, R8, R11, vet-1 S2-S9,
 * vet-2 S3, S4, S11, vet-3 S2-S4, S8, S12, S13; owner D-91): the one act `POST /api/brain/spaces/:spaceId/sparql/update` and MCP
 * `sparql_update` (with its `POST /api/sparql_update` twin) run.
 *
 * ## The act, in its four steps
 *
 * 1. **Evaluate** (`evaluateSparqlUpdate`): the text checked whole (graph management, SERVICE and LOAD refused), each part run over the
 *    space as the caller reads it, into one bounded change set: the statements removed and inserted, and every record read with its version.
 * 2. **Translate** and 3. **plan** (`planChangeSet`): the statements become record writes by the import's own rules, each judged by the real
 *    planners (the schema, strict linkage, the functional rule), deletes first; any refusal refuses the Update, naming the record and the rule.
 * 4. **Commit one write group** (`commitWriteGroup`): every write in one transaction, or none.
 *
 * ## What it prevents
 *
 * - **Half a change.** Nothing is written before every write was planned; the group lands whole or aborts. The exceptions are said, never
 *   hidden: a take-back after the commit of a row the Update landed (an entity it names was removed meanwhile) answers `409 endpoint_removed`
 *   with what was taken back; an effect after the commit that failed (embed jobs, a removal's cascade) answers `500
 *   sparql_update_cascade_incomplete` naming it and what landed; a lost commit reply that cannot be read back answers `503
 *   write_group_outcome_unknown` (read back before retrying: a statement about a stored record converges and a DELETE run again finds
 *   nothing, but a new subject is minted a new id each time it is sent).
 * - **A change concluded from an older record.** A record the evaluation read at one version and the planner or the transaction finds at
 *   another is a lost race: the WHOLE Update runs again, evaluation included, at most {@link UPDATE_MAX_ATTEMPTS} times inside one deadline
 *   (`sparql.timeoutMs` from the first attempt). An attempt starts only while the time left covers the last attempt's evaluation and hold,
 *   and never once the server is shutting down. After the last, `409 sparql_update_conflict` names the record that kept moving.
 * - **An unbounded write.** More records changed than `sparql.maxRecordsChanged` is `413 sparql_too_many_changes`, naming the cap, before
 *   the group; the group's own ceilings stand behind it (`413 write_group_too_large`).
 * - **A caller holding the store.** One Update per caller at a time, in its own slot family (`sparql_update`), held from evaluation
 *   through commit; an Update that deletes pays one destructive call (`consumeHeavyToolCall`), as every delete door does.
 * - **A cascade nobody asked for.** An Update that deletes an entity still named is refused `409 sparql_update_referenced`, its blockers
 *   in `backlinks` (D-91): the caller deletes or relinks them in the same Update.
 * - **The text in a record of the act.** The audit row (`brain.sparql_update`) and the metric take counts and codes; no refusal, log line or
 *   row repeats the Update's text, and a refused statement is named by its subject and predicate, its value by kind and length.
 * - **A summary per door.** The act emits the one `bulk.write` (`source: 'sparql.update'`, with the additive `deleted` count, D-91) when
 *   anything landed; each deleted record emits its own `<kind>.deleted` from the group (`opts.actor`).
 */
import { getConfig } from '../config/loader.js';
import { KNOWLEDGE_TYPES, type KnowledgeType } from '../config/types.js';
import { sparqlLimits } from '../config/sparql-limits.js';
import { isShuttingDown } from '../lifecycle.js';
import { schemaFingerprintOf } from './schema-stamp.js';
import { consumeHeavyToolCall, HEAVY_CALLS_PER_WINDOW } from '../rate-limit/heavy-tool.js';
import { takeSlot } from '../util/slots.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import { commitWriteGroup, GroupAborted, WriteGroupOutcomeUnknown, WriteGroupTooLarge, type GroupCommitted } from '../brain/write-plan/write-group.js';
import type { WritePlan } from '../brain/write-plan/types.js';
import { rdfSpaceState, type FingerprintOf, type RdfCaller } from '../rdf/rdf-space-state.js';
import { evaluateSparqlUpdate } from '../rdf/sparql-update-eval.js';
import { checkSparqlUpdateAlgebra, SPARQL_QUERY_MAX_BYTES, type SparqlUpdateDataset } from '../rdf/sparql-engine.js';
import { graphIri } from '../rdf/term-iri.js';
import { busyRefusal, sparqlRefusalOf, SPARQL_BAD_REQUEST, SPARQL_QUERY_TOO_LARGE, SPARQL_TOO_LARGE, SPARQL_UNAVAILABLE } from '../rdf/sparql-refusal.js';
import { SPARQL_TOO_MANY_CHANGES } from '../rdf/change-set-store.js';
import { planChangeSet, statedRemovals, type PlanRefusal } from '../rdf/sparql-update-plan.js';
import type { ReasonEntry } from '../rdf/quads-to-ops.js';
import type { Quad, Term } from '../rdf/literals.js';
import { sparqlUpdateTotal } from '../metrics/sparql-update-metrics.js';

/** The most times one Update runs: the first run and two more after a lost race. */
export const UPDATE_MAX_ATTEMPTS = 3;

/** The statuses the act answers with beyond the query endpoint's (`SPARQL_BAD_REQUEST`, `SPARQL_TOO_LARGE`, `SPARQL_UNAVAILABLE`). */
const LANDED_STATUS = 200;
const CONFLICT_STATUS = 409;
const REFUSED_STATUS = 422;
const RATE_LIMITED_STATUS = 429;
const CASCADE_INCOMPLETE_STATUS = 500;
/** When a caller may send again: after a shutdown or an unknown outcome, soon; after the destructive-call limit, when its minute has passed. */
const RETRY_SOON_SECONDS = 5;
const RATE_LIMITED_RETRY_SECONDS = 60;
/** The refusals a 422's sentence names; the rest are counted, and all are in its body. */
const NAMED_IN_SENTENCE = 3;

export const SPARQL_NO_UPDATE = 'sparql_no_update';
export const SPARQL_UPDATE_REFUSED = 'sparql_update_refused';
export const SPARQL_UPDATE_REFERENCED = 'sparql_update_referenced';
export const SPARQL_UPDATE_CONFLICT = 'sparql_update_conflict';
export const SPARQL_UPDATE_CASCADE_INCOMPLETE = 'sparql_update_cascade_incomplete';
export const SPARQL_UPDATE_RATE_LIMITED = 'sparql_update_rate_limited';
export const SPARQL_UPDATE_SHUTTING_DOWN = 'shutting_down';
export const ENDPOINT_REMOVED = 'endpoint_removed';
export const RECORD_VERSION_AT_CEILING = 'record_version_at_ceiling';
export const WRITE_GROUP_OUTCOME_UNKNOWN = 'write_group_outcome_unknown';
export const WRITE_GROUP_TOO_LARGE = 'write_group_too_large';

/**
 * The most addresses one of `using-graph-uri` and `using-named-graph-uri` lists. Only the space's own graph may be named, so a longer list
 * names nothing an Update can use; the bound keeps what a caller sends small on both doors.
 */
export const USING_GRAPH_URIS_MAX = 8;

const NO_UPDATE_WORDS = 'Send exactly one SPARQL Update: the body of an application/sparql-update POST, an update= form field, or the tool\'s `update`';
const TOO_LARGE_WORDS = `The Update is longer than ${SPARQL_QUERY_MAX_BYTES} bytes`;
const USING_WORDS = `\`using-graph-uri\` and \`using-named-graph-uri\` are lists of at most ${USING_GRAPH_URIS_MAX} addresses`;

/** Every code the act answers of its own (the evaluation's are `SPARQL_UPDATE_REFUSAL_CODES` and the engine's). */
export const SPARQL_UPDATE_ACT_CODES: readonly string[] = Object.freeze([
  SPARQL_NO_UPDATE, SPARQL_UPDATE_REFUSED, SPARQL_UPDATE_REFERENCED, SPARQL_UPDATE_CONFLICT, SPARQL_UPDATE_CASCADE_INCOMPLETE,
  SPARQL_UPDATE_RATE_LIMITED, SPARQL_UPDATE_SHUTTING_DOWN, ENDPOINT_REMOVED, RECORD_VERSION_AT_CEILING, WRITE_GROUP_OUTCOME_UNKNOWN,
  WRITE_GROUP_TOO_LARGE,
]);

type Counts = Record<KnowledgeType, number>;
const perKind = <T>(make: () => T): Record<KnowledgeType, T> =>
  Object.fromEntries(KNOWLEDGE_TYPES.map(k => [k, make()])) as Record<KnowledgeType, T>;
const zero = (): Counts => perKind(() => 0);
const total = (c: Counts): number => KNOWLEDGE_TYPES.reduce((n, k) => n + c[k], 0);

/** What a door hands the act. */
export interface SparqlUpdateInput {
  spaceId: string;
  update: unknown;
  usingGraphUri?: unknown;
  usingNamedGraphUri?: unknown;
  caller: RdfCaller | undefined;
  /** The slot and the destructive-call budget are this caller's: a token's id, or the address of a caller with none. */
  callerKey: string;
  actor?: WebhookActor;
  fingerprintOf?: FingerprintOf;
  signal?: AbortSignal;
}

/** The audit row's fields: counts and the outcome, never the text. */
export interface SparqlUpdateAudit {
  form: 'update'; length: number; inserted: number; converged: number; deleted: number; recordsChanged: number; attempts: number; outcome: string;
}

/** What landed, per kind; the inserted records' ids; the attempts it took. */
export interface SparqlUpdateLanded {
  inserted: Counts; converged: Counts; deleted: Counts; recordsChanged: number; attempts: number;
  ids: Record<KnowledgeType, string[]>;
  statements: { removed: number; inserted: number };
}

export type SparqlUpdateAnswer =
  | { ok: true; status: typeof LANDED_STATUS; body: SparqlUpdateLanded; audit: SparqlUpdateAudit }
  | { ok: false; status: number; code: string; error: string; body: Record<string, unknown>; retryAfterSeconds?: number; audit: SparqlUpdateAudit };

/** Test seam: a hook run before each attempt's commit (a test makes a record move there to lose the race). */
export interface SparqlUpdateKnobs { beforeCommit?: () => Promise<void> }
let knobs: SparqlUpdateKnobs = {};
export function setSparqlUpdateKnobsForTest(k: SparqlUpdateKnobs | null): void { knobs = k ?? {}; }

// ── Words ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A term as a refusal names it: an address as itself, a literal by its datatype and length, never its text. */
function termWords(t: Term): string {
  switch (t.kind) {
    case 'iri': return t.value;
    case 'blank': return 'a blank node';
    case 'literal': return `a ${t.language ? `language-tagged (${t.language}) ` : t.datatype ? `${t.datatype} ` : ''}literal of ${t.value.length} characters`;
    case 'triple': return 'a triple term';
    case 'list': return 'a list';
  }
}
const statementWords = (q: Quad): { subject: string; predicate: string; object: string } =>
  ({ subject: termWords(q.subject), predicate: q.predicate.value, object: termWords(q.object) });

/** The statements a reason names, at most this many each; the rest counted. */
const NAMED_MAX = 20;
function reasonsBody(reasons: readonly ReasonEntry[]): Array<Record<string, unknown>> {
  return reasons.map(r => ({ code: r.code, message: r.message, statements: r.quads.slice(0, NAMED_MAX).map(statementWords), count: r.quads.length }));
}
function refusalsBody(refusals: readonly PlanRefusal[]): Array<Record<string, unknown>> {
  return refusals.map(r => ({ kind: r.kind, id: r.id, subject: r.subject, error: r.reason, ...(r.code ? { code: r.code } : {}), ...(r.violation ? { violation: r.violation } : {}) }));
}

// ── The act ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function landedOf(plans: readonly WritePlan[], attempts: number, statements: SparqlUpdateLanded['statements']): SparqlUpdateLanded {
  const out: SparqlUpdateLanded = { inserted: zero(), converged: zero(), deleted: zero(), recordsChanged: plans.length, attempts, ids: perKind((): string[] => []), statements };
  for (const p of plans) {
    const kind = p.kind as KnowledgeType;
    if (p.op === 'delete') out.deleted[kind]++;
    else if (p.op === 'insert') { out.inserted[kind]++; out.ids[kind].push(p.id); } else out.converged[kind]++;
  }
  return out;
}

const auditOf = (length: number, outcome: string, attempts: number, landed?: SparqlUpdateLanded): SparqlUpdateAudit => ({
  form: 'update', length, attempts, outcome,
  inserted: landed ? total(landed.inserted) : 0, converged: landed ? total(landed.converged) : 0, deleted: landed ? total(landed.deleted) : 0,
  recordsChanged: landed ? landed.recordsChanged : 0,
});

/** The audit row's changes, as both doors hand them over: one `{field, to}` per allowlisted field. */
export const auditChangesOf = (a: SparqlUpdateAudit): Array<{ field: string; to: string | number }> =>
  Object.entries(a).map(([field, to]) => ({ field, to: to as string | number }));

/** The bulk.write summary, once per Update that landed anything (D-91: `deleted` additive, `source` sparql.update). */
function announce(spaceId: string, landed: SparqlUpdateLanded, actor: WebhookActor | undefined): void {
  if (landed.recordsChanged === 0) return;
  emitWebhookEvent({
    event: 'bulk.write', spaceId,
    entry: { source: 'sparql.update', inserted: landed.inserted, updated: landed.converged, deleted: landed.deleted, errorCount: 0 },
    ...(actor ? { actor } : {}),
  } as Parameters<typeof emitWebhookEvent>[0]);
}

/** Run the Update `input.update` on `input.spaceId` for its caller: see the module docblock. */
export async function sparqlUpdateAct(input: SparqlUpdateInput): Promise<SparqlUpdateAnswer> {
  const text = input.update;
  const length = typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
  let attempts = 0;
  const refuse = (status: number, code: string, error: string, body: Record<string, unknown> = {}, retryAfterSeconds?: number): SparqlUpdateAnswer => {
    sparqlUpdateTotal.inc({ outcome: code });
    return { ok: false, status, code, error, body: { error, code, ...body }, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}), audit: auditOf(length, code, attempts) };
  };
  if (typeof text !== 'string' || text.trim() === '') return refuse(SPARQL_BAD_REQUEST, SPARQL_NO_UPDATE, NO_UPDATE_WORDS);
  if (length > SPARQL_QUERY_MAX_BYTES) return refuse(SPARQL_TOO_LARGE, SPARQL_QUERY_TOO_LARGE, TOO_LARGE_WORDS);
  const using = datasetOf(input);
  if (using === null) return refuse(SPARQL_BAD_REQUEST, SPARQL_NO_UPDATE, USING_WORDS);
  const slot = takeSlot('sparql_update', input.callerKey);
  if (slot === null) {
    const b = busyRefusal('sparql_update');
    return refuse(b.status, b.code, 'An Update is already running for this caller, or as many as the instance runs at once: try again when it ends', {}, b.retryAfterSeconds);
  }
  try {
    const { timeoutMs, maxRecordsChanged, maxRecordsRead } = sparqlLimits(getConfig());
    const deadline = Date.now() + timeoutMs;
    let lastAttemptMs = 0;
    let stale: { kind: string; id: string } | null = null;
    let staleStatement: ReturnType<typeof statementWords> | null = null;
    /** How the last attempt was lost: `evaluation` (a record read at two versions), `plan` (read again at another), or the group's abort reason. */
    let abortedBy = 'evaluation';
    let deletesPaid = false;
    while (attempts < UPDATE_MAX_ATTEMPTS) {
      if (isShuttingDown()) return refuse(SPARQL_UNAVAILABLE, SPARQL_UPDATE_SHUTTING_DOWN, 'The server is shutting down: nothing of the Update was written, send it again', {}, RETRY_SOON_SECONDS);
      if (attempts > 0 && deadline - Date.now() < lastAttemptMs) break;
      const began = Date.now();
      attempts++;
      const state = rdfSpaceState(getConfig(), input.spaceId, input.caller, input.fingerprintOf ?? schemaFingerprintOf);
      let evaluated: Awaited<ReturnType<typeof evaluateSparqlUpdate>>;
      try {
        evaluated = await evaluateSparqlUpdate(text, { spaceId: input.spaceId, caller: input.caller, ...(input.fingerprintOf ? { fingerprintOf: input.fingerprintOf } : {}) },
          { deadline, ...(input.signal ? { signal: input.signal } : {}), maxRecordsRead, ...(using ? { using } : {}) });
      } catch (err) {
        const r = sparqlRefusalOf(err);
        if (r) return refuse(r.status, r.code, r.message, {}, r.retryAfterSeconds);
        throw err;
      }
      if ('refusal' in evaluated) {
        const r = evaluated.refusal;
        return refuse(r.status, r.code, r.error, { ...(r.line !== undefined ? { line: r.line } : {}), ...(r.column !== undefined ? { column: r.column } : {}) });
      }
      const changes = evaluated.changes;
      if (changes.lostRace) { stale = { kind: changes.lostRace.kind, id: changes.lostRace.id }; lastAttemptMs = Date.now() - began; continue; }
      if (!state.ok) throw new Error('The space an Update changes is not one its caller reads as RDF');
      const checked = await checkSparqlUpdateAlgebra(text, graphIri(state.meta), using ?? undefined);
      if ('refusal' in checked) return refuse(checked.refusal.status, checked.refusal.code, checked.refusal.error);
      const mode = state.meta.validationMode ?? 'warn';
      const planned = await planChangeSet(input.spaceId, state.meta, mode, changes, statedRemovals(checked.algebra));
      if (planned.kind === 'stale') {
        stale = planned.record;
        staleStatement = planned.statement ? statementWords(planned.statement) : null;
        abortedBy = 'plan';
        lastAttemptMs = Date.now() - began;
        continue;
      }
      if (planned.kind === 'refused') {
        const named = [...planned.reasons.map(r => `${r.code} (${r.quads.slice(0, 1).map(q => `${termWords(q.subject)} ${q.predicate.value}`).join('')})`),
          ...planned.refusals.map(r => `${r.kind} '${r.id}' (${r.subject}): ${r.reason}`)];
        return refuse(REFUSED_STATUS, SPARQL_UPDATE_REFUSED,
          `Nothing was written: ${named.slice(0, NAMED_IN_SENTENCE).join('; ')}${named.length > NAMED_IN_SENTENCE ? `; and ${named.length - NAMED_IN_SENTENCE} more` : ''}`,
          { reasons: reasonsBody(planned.reasons), refusals: refusalsBody(planned.refusals) });
      }
      const plans = planned.plans;
      if (plans.length > maxRecordsChanged) {
        return refuse(SPARQL_TOO_LARGE, SPARQL_TOO_MANY_CHANGES, `The Update changes ${plans.length} records, more than ${maxRecordsChanged} (sparql.maxRecordsChanged): nothing was written — split it`,
          { cap: maxRecordsChanged, records: plans.length });
      }
      if (!deletesPaid && plans.some(p => p.op === 'delete')) {
        if (!consumeHeavyToolCall(input.callerKey)) {
          return refuse(RATE_LIMITED_STATUS, SPARQL_UPDATE_RATE_LIMITED, `An Update that deletes is a destructive call, at most ${HEAVY_CALLS_PER_WINDOW} a minute per caller: try again shortly`, {},
            RATE_LIMITED_RETRY_SECONDS);
        }
        deletesPaid = true;
      }
      await knobs.beforeCommit?.();
      let committed: GroupCommitted;
      try {
        committed = await commitWriteGroup(input.spaceId, plans, { ...(input.actor ? { actor: input.actor } : {}) });
      } catch (err) {
        if (err instanceof GroupAborted) {
          if (err.reason === 'stale' || err.reason === 'duplicate_key') {
            stale = err.recordKind && err.recordId ? { kind: err.recordKind, id: err.recordId } : stale;
            abortedBy = err.reason;
            lastAttemptMs = Date.now() - began;
            continue;
          }
          if (err.reason === 'referenced') return refuse(CONFLICT_STATUS, SPARQL_UPDATE_REFERENCED, err.message, { backlinks: err.blockers ?? [] });
          if (err.reason === 'version_ceiling') return refuse(CONFLICT_STATUS, RECORD_VERSION_AT_CEILING, err.message);
          return refuse(CONFLICT_STATUS, SPARQL_UPDATE_CONFLICT, err.message, err.recordKind && err.recordId ? { record: { kind: err.recordKind, id: err.recordId } } : {});
        }
        if (err instanceof WriteGroupTooLarge) return refuse(SPARQL_TOO_LARGE, WRITE_GROUP_TOO_LARGE, err.message, { ceiling: err.ceiling, limit: err.limit, size: err.size });
        if (err instanceof WriteGroupOutcomeUnknown) {
          return refuse(SPARQL_UNAVAILABLE, WRITE_GROUP_OUTCOME_UNKNOWN, 'The Update\'s commit failed and could not be read back: it may have landed, or not. Read the records back before you send it again; '
            + 'sent again, a statement about a stored record converges and a DELETE finds nothing to remove, but a new subject is inserted again under a new id', {}, RETRY_SOON_SECONDS);
        }
        throw err;
      }
      const landed = landedOf(plans, attempts, { removed: changes.removed.length, inserted: changes.inserted.length });
      announce(input.spaceId, landed, input.actor);
      const audit = auditOf(length, 'landed', attempts, landed);
      const takenBack = committed.takenBack.edges.length + committed.takenBack.links.length;
      if (takenBack > 0) {
        const a = refuse(CONFLICT_STATUS, ENDPOINT_REMOVED, 'The Update landed, and then rows it wrote were taken back because an entity they name was removed meanwhile: read the graph again',
          { ...landed, takenBack: committed.takenBack });
        return { ...a, audit: { ...audit, outcome: ENDPOINT_REMOVED } };
      }
      if (committed.failedEffects.length > 0) {
        const a = refuse(CASCADE_INCOMPLETE_STATUS, SPARQL_UPDATE_CASCADE_INCOMPLETE,
          `The Update landed, and an effect owed after it did not complete (${committed.failedEffects.map(f => f.effect).join(', ')}): the records are stored, what follows from them is not all done`,
          { ...landed, failedEffects: committed.failedEffects.map(f => ({ effect: f.effect, count: f.count })) });
        return { ...a, audit: { ...audit, outcome: SPARQL_UPDATE_CASCADE_INCOMPLETE } };
      }
      sparqlUpdateTotal.inc({ outcome: 'landed' });
      return { ok: true, status: LANDED_STATUS, body: landed, audit };
    }
    return refuse(CONFLICT_STATUS, SPARQL_UPDATE_CONFLICT,
      `Nothing was written: ${stale ? `the ${stale.kind} '${stale.id}'` : 'a record the Update reads'} was changed by another write on each of the Update's ${attempts} runs — send it again`,
      { lostAt: abortedBy, ...(stale ? { record: stale } : {}), ...(staleStatement ? { statement: staleStatement } : {}) });
  } finally {
    slot.release();
  }
}

/** A protocol parameter that may be sent once or repeated, as a list: one value becomes a list of one; anything else is left as sent. */
export const asParameterList = (v: unknown): unknown => (typeof v === 'string' ? [v] : v);

/**
 * The refusal of parameters a door's boundary schema refused, in the act's own codes and words: the text past its cap is
 * `413 sparql_query_too_large`, anything else `400 sparql_no_update`.
 */
export function sparqlUpdateParametersRefusal(issue: { path: readonly PropertyKey[]; code: string } | undefined): { status: number; code: string; error: string } {
  if (issue?.path[0] === 'update') {
    return issue.code === 'too_big'
      ? { status: SPARQL_TOO_LARGE, code: SPARQL_QUERY_TOO_LARGE, error: TOO_LARGE_WORDS }
      : { status: SPARQL_BAD_REQUEST, code: SPARQL_NO_UPDATE, error: NO_UPDATE_WORDS };
  }
  return { status: SPARQL_BAD_REQUEST, code: SPARQL_NO_UPDATE, error: USING_WORDS };
}

/** The protocol's `using-graph-uri` and `using-named-graph-uri`, each one address or a list; `null` when either is no text or too long a list. */
function datasetOf(input: SparqlUpdateInput): SparqlUpdateDataset | undefined | null {
  const list = (v: unknown): string[] | null | undefined => {
    if (v === undefined) return undefined;
    const items = Array.isArray(v) ? v : [v];
    return items.length <= USING_GRAPH_URIS_MAX && items.every(x => typeof x === 'string') ? items as string[] : null;
  };
  const d = list(input.usingGraphUri);
  const n = list(input.usingNamedGraphUri);
  if (d === null || n === null) return null;
  if (d === undefined && n === undefined) return undefined;
  return { ...(d ? { defaultGraphUri: d } : {}), ...(n ? { namedGraphUri: n } : {}) };
}
