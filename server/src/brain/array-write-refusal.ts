/**
 * A converted space refuses an array write — one rule, one implementation, seven doors.
 *
 * ## What it refuses and why
 *
 * The six public array fields (`fact.entityIds`, `chrono.entityIds`/`memoryIds`,
 * `file.entityIds`/`memoryIds`/`chronoIds`) are the 3.x way of saying one record concerns another. `M-2`
 * replaced them with link records and gave a link a door of its own.
 *
 * Left open, the arrays are a SECOND write surface for the same fact. On a converted space the two can then
 * disagree, and which one a reader believes is decided by whether that space happens to be converted — which
 * is the exact defect the migration exists to remove, reintroduced by the migration's own compatibility.
 *
 * ## `completeLinkage` arms it, and nothing else may
 *
 * The marker means *"this space has been converted, on this instance"*. That is the only honest precondition
 * for refusing the old surface: before it, some of the space's links exist only as arrays, so the door has
 * nothing to redirect the caller to.
 *
 * **Not `validationMode: strict`.** That governs schema rules — type allowlists, required properties, naming
 * patterns — and it is already set on live spaces. Hung off it, every space on `strict` starts refusing
 * array writes the moment it upgrades, before its operator has run anything.
 *
 * **Not `strictLinkage` either.** One word apart and a different question: that says every reference must
 * RESOLVE, this says every link IS a record.
 *
 * ## What it must never touch
 *
 * **The sync ingest path.** Owner's ruling `P-21`: ingest is *"validated, counted, and let in"*. A peer
 * validated these records against ITS schema, and a refusal here does not merely drop one record — it holds
 * the watermark, so the channel stops making progress and the space silently falls behind.
 *
 * **A write that does not MENTION an array.** A `PATCH` of a fact's `fact` on a record still carrying a
 * legacy array must succeed, or every unconverted record in a converted space becomes uneditable. Tightening
 * a rule freezes the records that no longer fit it — the same hazard the schema validator's
 * `introduced` / `preExisting` split exists for.
 */
import { LINK_CLASSES } from './link-adjacency.js';
import { noteLegacyArrayWrite, type WriteActor } from './legacy-array-writers.js';

/**
 * The field names a caller must stop sending — DERIVED, so a seventh link class is refused by the commit
 * that declares it rather than by a list somebody remembers to extend.
 *
 * Three distinct names across six classes: `entityIds`, `memoryIds`, `chronoIds`.
 */
export const LINK_ARRAY_FIELDS: readonly string[] = [...new Set(LINK_CLASSES.map(c => c.field))];

/** Where a caller is sent instead. Named once so the seven doors answer the same sentence. */
const THE_DOOR = 'POST /api/brain/spaces/:spaceId/links (or the `save_link` tool)';

/**
 * The refusal for a body that writes a link array on a converted space, or `null` when there is none.
 *
 * `converted` is passed in rather than read here, so a caller that has already resolved its write target —
 * every proxy-aware door has — does not resolve it a second time and cannot resolve it differently.
 *
 * **A present key is a write, whatever its value.** `entityIds: []` is *"remove every entity link"* and
 * `entityIds: null` is the other spelling of the same removal. Reading either as "no array mentioned" is the
 * tempting shortcut and it leaves exactly one operation — clearing links — reachable through the surface
 * being retired.
 *
 * **The unconverted case is not "nothing to do".** It records who wrote the array, because that is the one
 * moment the fact exists and it is what the conversion pre-flight answers with (`F-25`). Refusing and
 * recording are the same inspection of the same body, which is why they are one function rather than two
 * calls a door could make one of — a door that inspected and did not record would leave the pre-flight
 * reporting a smaller number, and a smaller number reads exactly like a cleaner space.
 *
 * A returned string rather than a throw, the same shape as `primitivePropertyError` and
 * `validateDeleteFields`: a door needs to answer `400` with a message, and the doors' existing catch blocks
 * carry `SchemaViolationError`, which means something different — a violation of the SPACE's schema, which a
 * space in `warn` mode records and stores. This is refused in every mode.
 */
export function linkArrayFieldsNamed(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  return LINK_ARRAY_FIELDS.filter(f => f in (body as Record<string, unknown>));
}

export function arrayWriteError(input: {
  converted: boolean;
  spaceId: string;
  body: unknown;
  actor: WriteActor | undefined;
}): string | null {
  const { converted, spaceId, body, actor } = input;
  const named = linkArrayFieldsNamed(body);
  if (named.length === 0) return null;
  if (!converted) {
    // The OTHER outcome of the same inspection, and the reason `spaceId` and `actor` are parameters.
    //
    // Before conversion an array write is legal, and it is also the only moment the fact "this token still
    // uses the old surface" exists anywhere. `F-25`: the refusal below lands on the caller's next write
    // rather than at conversion time, so an operator learns which of their writers to move when one breaks.
    //
    // Fired, never awaited, and it cannot throw — see `legacy-array-writers.ts`.
    noteLegacyArrayWrite({ spaceId, fields: named, actor });
    return null;
  }
  return `this space's links are all link records (\`completeLinkage\`), so ${named.join(', ')} `
    + `${named.length === 1 ? 'is' : 'are'} no longer written directly — use ${THE_DOOR}. `
    + 'The field is still READ and still replicates, so nothing you have stored is lost.';
}
