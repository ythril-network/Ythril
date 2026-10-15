/**
 * The live check of a schema — `POST /api/spaces/:id/validate-schema` and MCP `schema_validate` — from a request to an answer, so the two
 * doors cannot differ in which meta they check, which records they read, what they show whom, what they cost or when they refuse. Each
 * door only shapes the answer: REST as a status code (and, in stored mode, its published echo of the meta it checked), MCP as a tool
 * result that never echoes the meta (F-46, ruling R6-12).
 *
 * ## The two modes
 *
 * - **sample** (`sample: { kind, record }`): the meta (the caller's proposed one, or the stored one) run over ONE record the caller
 *   typed, in the stored shape `recordViewOf` takes. Nothing stored is read, so it costs one evaluation and asks no right beyond the
 *   route's: the record is the caller's own.
 * - **stored data** (no `sample`): the meta run over the space's stored records, a page at a time.
 *
 * ## What it prevents
 *
 * - **A schema door that reads the data.** The stored-data check answers the stored value of the property that broke a schema. Only a
 *   caller who may read the space's knowledge sees it (`canReadValues`); every other caller gets the rows with their field and reason
 *   and NO `value` key. A rule's row carries no value for anybody: its reason is the rule's message.
 * - **A read that takes the vectors with it.** Each collection is read with a FIXED projection — the fields a view is built from — and
 *   never one a caller names; a body key the check does not take is dropped, never followed.
 * - **A page that reads far past what it shows.** It pages by `_id` (`db/id-keyset-page.ts`), spelled `after` / `nextAfter` as every
 *   keyset page on this server is, and a call STOPS reading at the record that fills its page — `limit` violating records, `limit`
 *   stale guards, or the byte budget — or at {@link SCHEMA_VALIDATE_SCAN_BOUND} records, or at the end. The next call continues right
 *   after the last record this one read, so no record is read twice: `progress.checked` is what THIS call read, a caller sums it over
 *   its pages, and it reaches `progress.total` when the walk ends (`complete`). Counting the violations a page does not show used to
 *   read up to the bound for every page of fifty rows, and read the same records again on the next.
 * - **An answer nobody can carry.** Rows go through the byte budget (`brain/result-budget.ts`) like every other read: `maxChars` /
 *   `maxBytes` / `maxTokens`, a door default (the one sanctioned divergence: lower on MCP), the number used disclosed, whole rows only
 *   and the cut continued by `nextAfter`.
 * - **A check that stalls the server.** The stored-data check is priced like the ingest (`consumeHeavyToolCall`, one count per token
 *   across both doors) and runs once per space at a time; it yields to the event loop after every page. A refusal costs no slot.
 */
import { z } from 'zod';
import { getConfig } from '../config/loader.js';
import type { SpaceMeta } from '../config/types.js';
import { KNOWLEDGE_TYPES, type BrainCollection } from '../config/types-knowledge.js';
import type { TokenRights } from '../config/rights-shape.js';
import { HEAVY_CALLS_PER_WINDOW } from '../rate-limit/heavy-tool.js';
import { heavyRunner } from '../rate-limit/heavy-run.js';
import { idKeysetPage } from '../db/id-keyset-page.js';
import { col } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { yieldToEventLoop } from '../util/yield-to-event-loop.js';
import { refusalOfParse } from '../util/log.js';
import { holdsRung } from '../auth/reachable-spaces.js';
import { viewSourceProjection, type ViewKind } from '../brain/record-view.js';
import { boundedRows } from '../brain/write-validation.js';
import {
  budgetFields, budgetMeter, carriagesFor, defaultBudgetChars, resolveBudget, type CeilingRefusal, type ResolvedBudget,
} from '../brain/result-budget.js';
import { parseSpaceMeta, readStoredMeta } from './body-schemas.js';
import { violationsOfRecord, resolveMetaRefs, type SchemaViolation } from './schema-validation.js';
import { validateStoredEdges, STORED_EDGE_PROJECTION, type StoredEdge, type StaleGuard } from './validate-stored-edges.js';

/** The most violating records one page holds, and the default. */
export const SCHEMA_VALIDATE_MAX_LIMIT = 500;
/** The most records one call reads before it stops and hands back a cursor. */
export const SCHEMA_VALIDATE_SCAN_BOUND = 10_000;
/** The longest `after` a caller can send back: a cursor this check made is far shorter. */
export const SCHEMA_VALIDATE_CURSOR_MAX = 2048;
/** Records read per database round trip. */
const READ_PAGE = 500;

/**
 * The body, and the tool's arguments once `space` is taken off. NOT `.strict()`, unlike the space bodies: a key this check does not
 * take is dropped, never followed — `projection` or `fields` in the body must change nothing about what is read, and a refusal would be
 * a second way of honouring them. The keys it does take are bounded as the tool's schema states.
 */
export const SchemaValidateBody = z.object({
  /** The meta to check: a proposed schema, parsed as a save would parse it. Absent: the space's stored meta. */
  meta: z.unknown().optional(),
  /** One record the caller typed, in the stored shape; with it nothing stored is read. */
  sample: z.object({
    // Every kind with a validator: the knowledge types, by their one declaration (the MCP tool's enum reads the same tuple).
    kind: z.enum(KNOWLEDGE_TYPES),
    record: z.record(z.string(), z.unknown()),
  }).strict().optional(),
  limit: z.number().int().min(1).max(SCHEMA_VALIDATE_MAX_LIMIT).optional(),
  after: z.string().min(1).max(SCHEMA_VALIDATE_CURSOR_MAX).optional(),
  // The size ceilings, read as every budgeted door reads them: `resolveBudget` states what is wrong with one, in one sentence.
  maxChars: z.unknown().optional(),
  maxBytes: z.unknown().optional(),
  maxTokens: z.unknown().optional(),
});

/** One record's rows. */
export interface RecordViolations { collection: string; _id?: string; violations: SchemaViolation[] }

/** What both doors answer (REST adds `meta` in stored mode, as it always has). */
export interface SchemaValidateAnswer {
  spaceId: string;
  /** Per collection: the records this call read, and how many the collection holds. */
  checked: Record<string, { checked: number; total: number }>;
  /** True when the walk reached its end: nothing is left after this answer, so no `nextAfter`. */
  complete: boolean;
  violations: RecordViolations[];
  /** Edges whose write guard names another subject: not violations. Stored mode only; the ones among the records THIS call read, at most `limit`. */
  staleGuards?: StaleGuard[];
  /** Pass as `after` to continue. Present only while records are left. */
  nextAfter?: string;
  /**
   * Stored mode only: `checked` is the records THIS call read (a caller sums it over its pages — each record is read once, the next
   * call continues right after the last one this call read), `total` the records the space held when the check started
   * (`estimatedDocumentCount`, collection metadata), so a space that grows while it is paged can read above its total.
   */
  progress?: { checked: number; total: number };
  /** Stored mode only: whether the BYTE BUDGET (not `limit`, not the scan bound) ended this page, and the budget as `budgetFields` states it. */
  truncated?: boolean;
  budgetChars?: number;
  budgetBytes?: number | null;
  charsReturned?: number;
  bytesReturned?: number;
  budgetBoundBy?: string[];
}

export type SchemaValidateOutcome =
  | { status: 200; answer: SchemaValidateAnswer; mode: 'sample' | 'stored'; meta: SpaceMeta }
  /** A refusal. `body` is the whole answer where it has structure — a failed parse's `{ error, issues }` — which both doors send as it is. */
  | { status: 400 | 404 | 409 | 429; error: string; body?: Readonly<Record<string, unknown>> };

/** The refusal a caller over the rail gets, the same words on both doors. */
export const SCHEMA_VALIDATE_RATE_LIMITED = `the stored-data schema check is rate limited — at most ${HEAVY_CALLS_PER_WINDOW} runs a minute per token, `
  + 'counted across the REST route and the tool; try again shortly (a sample check is not limited)';

/** Whether `rights` may see the stored values of `spaceId`'s records: `knowledge: read`, or an instance administrator. */
export function mayReadStoredValues(rights: TokenRights | null | undefined, spaceId: string): boolean {
  if (!rights) return false;
  if (rights.instanceAdmin) return true;
  return holdsRung(rights, spaceId, 'knowledge', 'read');
}

/** The stored-data checks running, by space. Module state, so a second door finds the first one's run. */
const checks = heavyRunner();

/**
 * The collections in the order they are walked, with the fixed projection each is read with: the stored fields a view is built from
 * (`viewSourceProjection`, so a field added to the view is read here too) — and for an edge the stored-edge check's, which also needs the
 * ends and the write guard.
 */
const WALK: ReadonlyArray<{ collection: Exclude<BrainCollection, 'links'>; kind: ViewKind; projection: Readonly<Record<string, 1>> }> = [
  { collection: 'entities', kind: 'entity', projection: { _id: 1, ...viewSourceProjection('entity') } },
  { collection: 'edges', kind: 'edge', projection: STORED_EDGE_PROJECTION },
  { collection: 'facts', kind: 'fact', projection: { _id: 1, ...viewSourceProjection('fact') } },
  { collection: 'chrono', kind: 'chrono', projection: { _id: 1, ...viewSourceProjection('chrono') } },
];

/** A position in the walk: a member space, a collection, the last `_id` read. Opaque to the caller. */
interface Cursor { space: string; collection: string; last: string }
const encodeCursor = (c: Cursor): string =>
  Buffer.from(JSON.stringify([c.space, c.collection, c.last]), 'utf8').toString('base64url');
function decodeCursor(text: string, memberIds: readonly string[]): Cursor | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 3 || !v.every(x => typeof x === 'string')) return null;
    const [space, collection, last] = v as [string, string, string];
    if (!memberIds.includes(space) || !WALK.some(w => w.collection === collection)) return null;
    return { space, collection, last };
  } catch {
    return null;
  }
}


/**
 * Run the live check for `spaceId`.
 *
 * @param memberIds      the spaces to read, as each door narrows a proxy (REST by request, MCP by the connection's reach)
 * @param body           the caller's arguments — any value; refused here when it is not that shape
 * @param canReadValues  whether the caller may see stored values ({@link mayReadStoredValues})
 * @param callerKey      who the rail counts against: the calling token's id, or its address when it has none
 * @param transport      the door, which decides the byte budget's default and how many times it carries the answer
 */
export async function beginSchemaValidate(input: {
  spaceId: string; memberIds: string[]; body: unknown; canReadValues: boolean; callerKey: string; transport: 'mcp' | 'rest';
}): Promise<SchemaValidateOutcome> {
  const { spaceId, memberIds, canReadValues, callerKey, transport } = input;
  const space = getConfig().spaces.find(s => s.id === spaceId);
  if (!space) return { status: 404, error: `Space '${spaceId}' not found` };
  const parsed = SchemaValidateBody.safeParse(input.body ?? {});
  // Why a body was refused, naming each parameter: the whole refusal every parse door sends, `{ error, issues }` (the spread is its
  // enumerable part; `reasons` is not part of a body).
  if (!parsed.success) {
    const refusal = refusalOfParse(parsed.error);
    return { status: 400, error: refusal.error, body: { ...refusal } };
  }
  const { sample, after } = parsed.data;
  const limit = parsed.data.limit ?? SCHEMA_VALIDATE_MAX_LIMIT;
  // Resolved in both modes, so a size parameter that is wrong is refused whichever mode it rides on; only a stored-data answer is cut by it.
  const budget = resolveBudget(parsed.data, defaultBudgetChars(transport), carriagesFor(transport));
  if (!budget.ok) return { status: 400, error: budget.error };

  // A proposed meta is parsed by the one parse a save runs (`parseSpaceMeta`), so a meta the save would refuse is refused here in the
  // same words. The stored meta is read as every store reads what it holds (`readStoredMeta`): it was checked when it was stored, so a
  // key from a newer build, a part that no longer parses or a rule that no longer compiles is left out and reported elsewhere — never a
  // reason to refuse the check of the space's own schema.
  let meta: SpaceMeta;
  if (parsed.data.meta !== undefined) {
    const proposed = parseSpaceMeta(parsed.data.meta);
    if (!proposed.ok) return { status: 400, error: proposed.message };
    meta = proposed.meta as SpaceMeta;
  } else {
    meta = readStoredMeta(space.meta ?? {}).meta as SpaceMeta;
  }
  const resolved = resolveMetaRefs(meta);

  if (sample) {
    // The caller's own record: its values are the caller's, so they stay in the rows whatever the caller may read.
    const rows = boundedRows(violationsOfRecord(resolved, sample.kind, sample.record));
    return {
      status: 200, mode: 'sample', meta,
      answer: {
        spaceId, checked: {}, complete: true,
        violations: rows.length > 0 ? [{ collection: WALK.find(w => w.kind === sample.kind)!.collection, violations: rows }] : [],
      },
    };
  }

  const cursor = after === undefined ? null : decodeCursor(after, memberIds);
  if (after !== undefined && !cursor) return { status: 400, error: 'after: not a cursor this check gave (pass the nextAfter of the previous page)' };
  // One check per space at a time, priced on the heavy rail, in the order that makes it a guard (`heavyRunner`).
  const ran = await checks.run(spaceId, callerKey, {
    busy: `A stored-data schema check of '${spaceId}' is already running — try again when it ends`,
    limited: SCHEMA_VALIDATE_RATE_LIMITED,
  }, () => walkStored(spaceId, memberIds, resolved, { limit, cursor, canReadValues, budget }));
  return ran.ok ? { status: 200, mode: 'stored', meta, answer: ran.value } : { status: ran.status, error: ran.error };
}

/**
 * The stored-data walk: every member's four collections in turn, by `_id`, from `cursor` — one record at a time, and it stops AT the
 * record that fills the page (see the header), so what it read is what it answers for.
 */
async function walkStored(
  spaceId: string, memberIds: readonly string[], meta: SpaceMeta,
  opts: { limit: number; cursor: Cursor | null; canReadValues: boolean; budget: ResolvedBudget },
): Promise<SchemaValidateAnswer> {
  const { limit, cursor, canReadValues, budget } = opts;
  const checked: Record<string, { checked: number; total: number }> = {};
  const page: RecordViolations[] = [];
  const staleGuards: StaleGuard[] = [];
  const meter = budgetMeter(budget);
  let read = 0;
  /** Where the next call starts: set when this one stops before the end of the walk. */
  let next: Cursor | undefined;
  let refusedBy: CeilingRefusal | null = null;

  // Every collection's size, the ones this call will not reach included: `progress.total` is the space's, not this call's. The count
  // is the collection's metadata (`estimatedDocumentCount`), not a scan, and it is the count when this call started.
  const sizes = new Map<string, number>();
  for (const mid of memberIds) {
    for (const { collection } of WALK) {
      const name = spaceCollection(mid, collection);
      sizes.set(name, await col(name).estimatedDocumentCount());
    }
  }

  // Where to start: the cursor's member and collection, after its id; everything before it was answered by an earlier page.
  const startMember = cursor ? memberIds.indexOf(cursor.space) : 0;
  walk: for (let m = startMember; m < memberIds.length; m++) {
    const mid = memberIds[m]!;
    const startCollection = cursor && m === startMember ? WALK.findIndex(w => w.collection === cursor.collection) : 0;
    for (let c = 0; c < WALK.length; c++) {
      const { collection, kind, projection } = WALK[c]!;
      const name = spaceCollection(mid, collection);
      const tally = (checked[collection] ??= { checked: 0, total: 0 });
      tally.total += sizes.get(name) ?? 0;
      if (c < startCollection) continue;
      let afterId = cursor && m === startMember && c === startCollection ? cursor.last : undefined;
      /** The last record of this collection this call has read: where a call that stops before the next record continues from. */
      let previousId = afterId ?? '';
      for (;;) {
        if (read >= SCHEMA_VALIDATE_SCAN_BOUND) {
          next = { space: mid, collection, last: previousId };
          break walk;
        }
        const docs = await idKeysetPage<{ _id: string } & Record<string, unknown>>(
          { collection: name, filter: {}, projection, size: Math.min(READ_PAGE, SCHEMA_VALIDATE_SCAN_BOUND - read) }, afterId);
        // An edge is judged against the others of its page (a subject's count, the ends it names), so the page is judged whole and
        // each record then takes its own findings in order — what it does not take, it was never read.
        const edgeFindings = kind === 'edge'
          ? await validateStoredEdges(mid, meta, docs.rows as unknown as StoredEdge[])
          : null;
        const edgeRows = new Map((edgeFindings?.violations ?? []).map(v => [v._id ?? '', v]));
        const edgeGuards = new Map((edgeFindings?.staleGuards ?? []).map(g => [g._id, g]));
        for (const doc of docs.rows) {
          const id = String(doc._id);
          const found: RecordViolations | undefined = kind === 'edge'
            ? edgeRows.get(id)
            : (() => {
              const rows = violationsOfRecord(meta, kind, doc);
              return rows.length > 0 ? { collection, _id: id, violations: rows } : undefined;
            })();
          const guard = edgeGuards.get(id);
          // The one bounded renderer: at most `MAX_ROWS` rows a record, each name and string bounded, and no value for a caller who
          // may not read the stored data.
          const shown = found ? { ...found, violations: boundedRows(found.violations, { value: canReadValues }) } : undefined;
          // The record that does not fit the budget is not read: the next call starts at it, and this one's `checked` ends before it.
          if ((shown || guard) && !meter.admit({ ...(shown ? { violation: shown } : {}), ...(guard ? { guard } : {}) })) {
            refusedBy = meter.refusedBy();
            next = { space: mid, collection, last: previousId };
            break walk;
          }
          read++;
          tally.checked++;
          previousId = id;
          if (shown) page.push(shown);
          if (guard) staleGuards.push(guard);
          // The record that fills the page ends the read: it is the last one this call has read, and the next one starts after it.
          if (page.length >= limit || staleGuards.length >= limit) {
            next = { space: mid, collection, last: id };
            break walk;
          }
        }
        await yieldToEventLoop();
        if (docs.end || docs.last === undefined) break;
        afterId = docs.last;
      }
    }
  }

  const cut = refusedBy !== null;
  const disclosed = budgetFields({
    returned: page, remainder: [], charsReturned: meter.chars(), bytesReturned: meter.bytes(), truncated: cut,
    ...(refusedBy ? { refusedBy } : {}),
  }, page.length, budget);
  return {
    spaceId, checked, complete: next === undefined, violations: page, staleGuards,
    ...(next !== undefined ? { nextAfter: encodeCursor(next) } : {}),
    progress: { checked: read, total: [...sizes.values()].reduce((a, b) => a + b, 0) },
    truncated: cut,
    budgetChars: disclosed['budgetChars'] as number,
    budgetBytes: disclosed['budgetBytes'] as number | null,
    charsReturned: meter.chars(),
    bytesReturned: meter.bytes(),
    ...(disclosed['budgetBoundBy'] ? { budgetBoundBy: disclosed['budgetBoundBy'] as string[] } : {}),
  };
}
