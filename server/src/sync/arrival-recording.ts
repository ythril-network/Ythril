/**
 * What a STORED arrival carried that its schema does not accept, recorded once, and never at the cost of the write (`Q-93`, `R6-9`).
 *
 * ## The question, and why a module
 *
 * A record a peer sent (a push, a pulled page) or an admin restored (an import) is stored whatever it carries: the sender validated it
 * against ITS schema, so a refusal would discard data the sender believes it delivered, and a backup taken before a schema change must
 * still restore. What a receiver CAN do is say what it holds that its own schema would not have let a local write add. That was done at six
 * call sites of one helper (`violationsAgainstLocalSchema`: five in `api/sync/docs.ts`, one in `api/admin-import.ts`), each with its own
 * rule: the single routes reported a document the plan SKIPPED, the batch route recounted what the page accept had already counted, a
 * pulled page recorded nothing at all, an `off` space was reported on as if it judged, and a copy that replaced a record carrying the same
 * break reported it again every time the peer re-sent it. Now there is one place that decides all of it.
 *
 * ## The five rules, each of them inside so no door can drop it
 *
 * 1. **Only a document that was STORED.** {@link recordedOf} is asked after the write, of the documents that landed: a document the plan
 *    skipped, the writer refused or a unique index declined records nothing.
 * 2. **Only what the replaced copy lacked.** {@link watchArrivals} runs BEFORE the write, because afterwards the copy is gone: it reads the
 *    stored copy of every document that carries a violation and judges it by the same validator, and the verdict is the write classifier's
 *    (`classifyUpdateViolations`, P-6): a row is new when the replaced copy lacked it, or when the arrival changed the value it is about.
 *    A key already stored is never recorded again, however often a peer re-sends it.
 * 3. **`off` records nothing** (`judgesKeys`: only `warn` and `strict` judge a record). The validator ignored `validationMode` for a declared
 *    value, so an off space used to be told about every document that broke a property type.
 * 4. **Names and counts, never values.** What these sinks say is the key or field NAME and how many documents carried it: one log line per
 *    (space, peer) per window ({@link sayRecorded}), the counter `ythril_schema_violations_recorded_total`, and the page summary the sync history
 *    stores. A value is the sender's data, and a log line or a history row is not where it goes. The push answer's per-document rows are
 *    the one place a row keeps its value, because they answer the sender about its own document.
 * 5. **A recorder that breaks never stops the write, and says so once.** Everything here catches: a read that fails, a validator that throws
 *    or a log line that cannot be written is reported as ONE warning until a recording succeeds again (`warnOnce`, then `forget`, so a
 *    recorder that broke, recovered and broke again is said again), counted in `ythril_schema_recorder_failures_total`, and the arrival goes
 *    on: a refused page would be offered again for ever, and a quiet failure would leave the operator reading "nothing wrong" where
 *    there was something.
 *
 * ## What it is not
 *
 * It is not a validator (`spaces/schema-validation.ts` decides what breaks a schema) and not a classifier (`brain/write-validation.ts`
 * decides whose fault a break is): it asks them. It does not look at a file or a link, which have no type schema. It does not refuse.
 *
 * The functions are plain and take the state as data (an {@link ArrivalWatch}), not as methods on an object, so that
 * `every-door-that-stores-a-record-reaches-a-validator` — which follows calls by name — sees the validator from every door that stores a record.
 */
import type { BrainCollection, KnowledgeType, SpaceMeta } from '../config/types.js';
import { KNOWLEDGE_TYPES } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { classifyUpdateViolations, deltaBetween } from '../brain/write-validation.js';
import { recordViewOf, type RecordView } from '../brain/record-view.js';
import {
  getSpaceMeta, judgesKeys, validateChrono, validateEdge, validateEntity, validateFact, applyValidation, type SchemaViolation,
} from '../spaces/schema-validation.js';
import { schemaRecorderFailuresTotal, schemaViolationsRecordedTotal } from '../metrics/registry.js';
import { log, logSafe, peerList, peerText, NAME_QUOTED } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';
import { yieldToEventLoop } from '../util/yield-to-event-loop.js';
import { RECORD_TYPE_OF } from './replicated-families.js';

type Doc = Record<string, unknown> & { _id: string };

/** The doors a recording is made for: the label of `ythril_schema_violations_recorded_total`. */
export type RecordingSource = 'push' | 'pull' | 'import';

/** Documents judged between two turns of the event loop, so a page of five hundred never holds it (R6-1). */
const YIELD_EVERY = 50;

/** How long a (space, peer) is not told about again: one line per window, never one per page (`warnOnce`). */
const SAID_WINDOW_MS = 10 * 60_000;

/** The schema kind a collection's documents are judged by, or `undefined` for a family with no type schema (a file, a link). */
export function schemaKindOf(collection: BrainCollection): KnowledgeType | undefined {
  const type = RECORD_TYPE_OF[collection];
  return type !== null && (KNOWLEDGE_TYPES as readonly string[]).includes(type) ? type as KnowledgeType : undefined;
}

/**
 * What the validator says about `doc` as a record of `kind` — one switch, written by name, so every door reaches the validator of its kind
 * through here. The view is made from the document as it is (`recordViewOf`), never from a literal of the fields a rule happens to read.
 */
function rowsOf(meta: SpaceMeta, kind: KnowledgeType, doc: object): SchemaViolation[] {
  switch (kind) {
    case 'entity': return validateEntity(meta, recordViewOf('entity', doc));
    case 'edge': return validateEdge(meta, recordViewOf('edge', doc));
    case 'chrono': return validateChrono(meta, recordViewOf('chrono', doc));
    case 'fact': return validateFact(meta, recordViewOf('fact', doc));
  }
}

/** The state {@link watchArrivals} takes before a write and {@link recordedOf} reads after it. */
export interface ArrivalWatch {
  spaceId: string;
  kind: KnowledgeType;
  meta: SpaceMeta;
  /** What the validator says about each arriving document that has something to say, by document. */
  found: Map<Doc, SchemaViolation[]>;
  /** The copy each of those documents replaces, by id: what the validator says about it, and its view. Absent for an id nothing is stored under. */
  held: Map<string, { rows: SchemaViolation[]; view: RecordView }>;
}

/**
 * Look at `docs` BEFORE they are written: which of them carry a violation of the space's schema, and, for those, what the copy they will
 * replace held. `null` when there is nothing to record — the family has no type schema, the space does not judge (`off`), no document has a
 * violation, or the recorder broke (said once; the write goes on).
 */
export async function watchArrivals(spaceId: string, collection: BrainCollection, docs: readonly Doc[], source: RecordingSource): Promise<ArrivalWatch | null> {
  const kind = schemaKindOf(collection);
  if (kind === undefined || docs.length === 0) return null;
  try {
    const meta = getSpaceMeta(spaceId);
    if (!meta || !judgesKeys(meta)) return null;
    const found = new Map<Doc, SchemaViolation[]>();
    let judged = 0;
    for (const doc of docs) {
      const rows = rowsOf(meta, kind, doc);
      if (rows.length > 0) found.set(doc, rows);
      if (++judged % YIELD_EVERY === 0) await yieldToEventLoop();
    }
    if (found.size === 0) return null;
    // The copies these documents replace, read once and only for the documents that have something to say: a clean page reads nothing.
    const copies = await readStoredById<Doc>(spaceCollection(spaceId, collection), [...new Set([...found.keys()].map(d => d._id))], 'all');
    const held = new Map<string, { rows: SchemaViolation[]; view: RecordView }>();
    for (const [id, copy] of copies) held.set(id, { rows: rowsOf(meta, kind, copy), view: recordViewOf(kind, copy) });
    return { spaceId, kind, meta, found, held };
  } catch (err) {
    recorderFailed(spaceId, source, err);
    return null;
  }
}

/**
 * What each document of `stored` — the documents that LANDED — carries that the copy it replaced did not, by document. Nothing for a document
 * with no violation, or whose violations the replaced copy already had. Never throws.
 */
export function recordedOf(watch: ArrivalWatch | null, stored: readonly Doc[], source: RecordingSource): Map<Doc, SchemaViolation[]> {
  const out = new Map<Doc, SchemaViolation[]>();
  if (watch === null) return out;
  try {
    for (const doc of stored) {
      const rows = watch.found.get(doc);
      if (!rows) continue;
      const copy = watch.held.get(doc._id);
      // The write's own classification (P-6): a row is the arrival's when the replaced copy lacked it, or when the arrival changed the value
      // it is about. A new document has no copy and is all new. `applyValidation` is the one definition of what a mode surfaces — the
      // guard in `watchArrivals` saves the work for a space that surfaces nothing, and this is the belt to it.
      const after = recordViewOf(watch.kind, doc);
      const verdict = classifyUpdateViolations(watch.meta, copy?.rows ?? [], rows, deltaBetween(copy?.view ?? null, after));
      const recorded = applyValidation(watch.meta, verdict.introduced).warnings;
      if (recorded.length > 0) out.set(doc, recorded);
    }
    return out;
  } catch (err) {
    recorderFailed(watch.spaceId, source, err);
    return new Map();
  }
}

/** What a page recorded, as the sync history keeps it: how many documents, and the names most of them carried. Names and counts only. */
export interface RecordedSummary {
  records: number;
  /** The field names (`properties.<key>` for an undeclared key) by the number of documents carrying them, most first, at most {@link TOP_NAMES}. */
  top: Array<{ name: string; count: number }>;
}

/** How many names a summary keeps: a page of peer data must not become a list as long as its keys. */
export const TOP_NAMES = 5;

const said = warnOnce<string>({ every: SAID_WINDOW_MS });
const failureSaid = warnOnce<string>();
/** The one key a recorder failure is reported under: a broken recorder is one condition, whichever space and peer it met it in. */
const FAILURE = 'recorder';

/** No recording: what a page that recorded nothing summarises to, and what a sum starts from. */
export const NOTHING_RECORDED: RecordedSummary = Object.freeze({ records: 0, top: [] as Array<{ name: string; count: number }> });

/**
 * Two summaries as one — pages of one cycle, families of one space: the documents add, and the names are added by name and cut again to
 * {@link TOP_NAMES}. Approximate by design: each page kept only its own top names, so a name that was never in a page's top is not in the sum.
 */
export function mergeSummaries(a: RecordedSummary, b: RecordedSummary | undefined): RecordedSummary {
  if (b === undefined || b.records === 0) return a;
  const names = new Map<string, number>();
  for (const { name, count } of [...a.top, ...b.top]) names.set(name, (names.get(name) ?? 0) + count);
  const top = [...names].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, TOP_NAMES).map(([name, count]) => ({ name, count }));
  return { records: a.records + b.records, top };
}

/** What was recorded in each family of a page: the rows of each document, by the document's id. */
export type RecordedFamilies = ReadonlyMap<string, ReadonlyMap<string, readonly SchemaViolation[]>>;

/** The summary of `families`: how many documents, and the names most of them carried. Pure; names and counts only. */
export function summarise(families: RecordedFamilies): RecordedSummary {
  const records = [...families.values()].reduce((n, docs) => n + docs.size, 0);
  const names = new Map<string, number>();
  for (const docs of families.values()) {
    for (const rows of docs.values()) for (const field of new Set(rows.map(r => r.field))) names.set(field, (names.get(field) ?? 0) + 1);
  }
  const top = [...names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_NAMES)
    .map(([name, count]) => ({ name: peerText(name, { max: NAME_QUOTED }), count }));
  return { records, top };
}

/**
 * Say what a page recorded: count it, say it once per (space, peer) per window, and return the summary the history keeps.
 *
 * `families` are the documents recorded in each family of the page (the key is the family's name, for the line). The counter moves FIRST,
 * so a log that cannot be written cannot hide the count. A recording that reaches the end — whatever it found — is a recorder that works,
 * so a failure reported before is forgotten and the next one is news again. Never throws.
 */
export function sayRecorded(o: { spaceId: string; source: RecordingSource; peer: string; families: RecordedFamilies }): RecordedSummary {
  const summary = summarise(o.families);
  const { records, top } = summary;
  if (records === 0) {
    failureSaid.forget(FAILURE);
    return summary;
  }
  try {
    schemaViolationsRecordedTotal.inc({ source: o.source }, records);
    said(`${o.spaceId}\u0000${o.peer}`, () => {
      const per = peerList([...o.families].filter(([, docs]) => docs.size > 0).map(([family, docs]) => `${docs.size} ${family}`), ', ');
      log.warn(`${peerText(o.source)} from ${peerText(o.peer)}: ${per} record(s) stored in space '${peerText(o.spaceId)}' carry something its schema does not accept `
        + `that the copy each replaced did not: ${peerList(top.map(t => `${t.name} (${t.count})`), ', ')}. Stored as sent; the key and field names are all this line says`);
    });
    failureSaid.forget(FAILURE);
  } catch (err) {
    recorderFailed(o.spaceId, o.source, err);
  }
  return summary;
}

/**
 * The recorder broke: count it and say so ONCE, until a recording succeeds again. Never throws — it is the one function a failure of the
 * log itself reaches, so the line is written inside its own guard.
 */
function recorderFailed(spaceId: string, source: RecordingSource, err: unknown): void {
  try { schemaRecorderFailuresTotal.inc({ source }); } catch { /* a counter that cannot move is not a reason to stop the write */ }
  try {
    failureSaid(FAILURE, () => log.warn(`Recording what ${peerText(source)} arrivals break in the schema of space '${peerText(spaceId)}' failed `
      + `(${logSafe(err instanceof Error ? err.message : String(err))}); the records were stored, and this is said once until a recording succeeds again`));
  } catch { /* ditto: the line itself could not be written */ }
}
