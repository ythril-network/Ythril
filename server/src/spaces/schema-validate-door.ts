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
 * - **A scan with no way past its end.** It pages by `_id` (`db/id-keyset-page.ts`), spelled `after` / `nextAfter` as every keyset page
 *   on this server is; at most {@link SCHEMA_VALIDATE_SCAN_BOUND} records are read per call, `totalViolations` counts what the call read,
 *   and `complete` is true only when nothing is left after it. A page never holds more than `limit` records.
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
});

/** One record's rows. */
export interface RecordViolations { collection: string; _id?: string; violations: SchemaViolation[] }

/** What both doors answer (REST adds `meta` in stored mode, as it always has). */
export interface SchemaValidateAnswer {
  spaceId: string;
  /** Per collection: the records this call read, and how many the collection holds. */
  checked: Record<string, { checked: number; total: number }>;
  /** True when nothing is left after this answer: no `nextAfter`. */
  complete: boolean;
  /** The violating records this call found — every one it read, not only the page's. */
  totalViolations: number;
  violations: RecordViolations[];
  /** Edges whose write guard names another subject: not violations, so not counted in `totalViolations`. Stored mode only. */
  staleGuards?: StaleGuard[];
  /** Pass as `after` to continue. Present only while records are left. */
  nextAfter?: string;
}

export type SchemaValidateOutcome =
  | { status: 200; answer: SchemaValidateAnswer; mode: 'sample' | 'stored'; meta: SpaceMeta }
  | { status: 400 | 404 | 409 | 429; error: string };

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
const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify([c.space, c.collection, c.last]), 'utf8').toString('base64url');
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
 */
export async function beginSchemaValidate(input: {
  spaceId: string; memberIds: string[]; body: unknown; canReadValues: boolean; callerKey: string;
}): Promise<SchemaValidateOutcome> {
  const { spaceId, memberIds, canReadValues, callerKey } = input;
  const space = getConfig().spaces.find(s => s.id === spaceId);
  if (!space) return { status: 404, error: `Space '${spaceId}' not found` };
  const parsed = SchemaValidateBody.safeParse(input.body ?? {});
  // Why a body was refused, naming each parameter — the one sentence both doors send.
  if (!parsed.success) return { status: 400, error: refusalOfParse(parsed.error).error };
  const { sample, after } = parsed.data;
  const limit = parsed.data.limit ?? SCHEMA_VALIDATE_MAX_LIMIT;

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
        spaceId, checked: {}, complete: true, totalViolations: rows.length > 0 ? 1 : 0,
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
  }, () => walkStored(spaceId, memberIds, resolved, { limit, cursor, canReadValues }));
  return ran.ok ? { status: 200, mode: 'stored', meta, answer: ran.value } : { status: ran.status, error: ran.error };
}

/** The stored-data walk: every member's four collections in turn, by `_id`, from `cursor`. */
async function walkStored(
  spaceId: string, memberIds: readonly string[], meta: SpaceMeta,
  opts: { limit: number; cursor: Cursor | null; canReadValues: boolean },
): Promise<SchemaValidateAnswer> {
  const { limit, cursor, canReadValues } = opts;
  const checked: Record<string, { checked: number; total: number }> = {};
  const page: RecordViolations[] = [];
  const staleGuards: StaleGuard[] = [];
  let total = 0;
  let read = 0;
  let lastReturned: Cursor | undefined;
  let stoppedAt: Cursor | undefined;

  // Where to start: the cursor's member and collection, after its id; everything before it was answered by an earlier page.
  const startMember = cursor ? memberIds.indexOf(cursor.space) : 0;
  walk: for (let m = startMember; m < memberIds.length; m++) {
    const mid = memberIds[m]!;
    const startCollection = cursor && m === startMember ? WALK.findIndex(w => w.collection === cursor.collection) : 0;
    for (let c = 0; c < WALK.length; c++) {
      const { collection, kind, projection } = WALK[c]!;
      const name = spaceCollection(mid, collection);
      const tally = (checked[collection] ??= { checked: 0, total: 0 });
      tally.total += await col(name).countDocuments();
      if (c < startCollection) continue;
      let afterId = cursor && m === startMember && c === startCollection ? cursor.last : undefined;
      for (;;) {
        if (read >= SCHEMA_VALIDATE_SCAN_BOUND) {
          stoppedAt = { space: mid, collection, last: afterId ?? '' };
          break walk;
        }
        const docs = await idKeysetPage<{ _id: string } & Record<string, unknown>>(
          { collection: name, filter: {}, projection, size: Math.min(READ_PAGE, SCHEMA_VALIDATE_SCAN_BOUND - read) }, afterId);
        read += docs.rows.length;
        tally.checked += docs.rows.length;
        let found: RecordViolations[];
        if (kind === 'edge') {
          const edges = await validateStoredEdges(mid, meta, docs.rows as unknown as StoredEdge[]);
          found = edges.violations;
          staleGuards.push(...edges.staleGuards);
        } else {
          found = [];
          for (const doc of docs.rows) {
            const rows = violationsOfRecord(meta, kind, doc);
            if (rows.length > 0) found.push({ collection, _id: String(doc._id), violations: rows });
          }
        }
        for (const f of found) {
          total++;
          if (page.length < limit) {
            // The one bounded renderer: at most `MAX_ROWS` rows a record, each name and string bounded, and no value for a caller who
            // may not read the stored data.
            page.push({ ...f, violations: boundedRows(f.violations, { value: canReadValues }) });
            lastReturned = { space: mid, collection, last: f._id ?? '' };
          }
        }
        await yieldToEventLoop();
        if (docs.end || docs.last === undefined) break;
        afterId = docs.last;
      }
    }
  }

  // More violating records than the page holds: continue right after the last one returned. Stopped at the bound with every violation
  // it found returned: continue where it stopped. Neither: the walk reached the end.
  const next = total > page.length ? lastReturned : stoppedAt;
  return {
    spaceId, checked, complete: next === undefined, totalViolations: total, violations: page, staleGuards,
    ...(next !== undefined ? { nextAfter: encodeCursor(next) } : {}),
  };
}
