/**
 * Which keys of a write body the route did not understand — reported, never refused.
 *
 * ## The failure this closes
 *
 * A brain create had no body schema. It destructured the keys it knew, hand-validated those, and dropped
 * everything else: `"totallyMadeUpField": "xyzzy"` returned `201` and a record id. So a caller could not tell
 * *"this parameter is not implemented"* from *"this parameter was applied"* — both are a success and an id.
 *
 * That is not hypothetical. It is how `suppressEmbeddings`-on-create stayed hidden: the fleet integrator sent
 * it, got a 200, and believed it. They found out only because the symptom surfaced somewhere else and they ran
 * a deliberate read-back and a recall probe.
 *
 * ## Why a warning and not a 400
 *
 * They asked for exactly this, and were explicit that a strict rejection might break existing callers. It is
 * also the better answer on its own terms: a refusal answers a different question, and it would turn every
 * forward-compatible client into a broken one the day a field is removed.
 *
 * The rows go in the `warnings` array these responses already carry for schema violations, in the same
 * `{field, value, reason}` shape. Two warning channels on one response would be a worse outcome than the
 * silence they replace.
 *
 * ## MCP needs none of this, and the asymmetry is deliberate
 *
 * An MCP tool's input schema is `additionalProperties: false` and the dispatcher enforces it, so an unknown
 * argument is REFUSED there before a handler runs. One rule, two doors, two answers — which is normally the
 * defect this codebase names as its most expensive. Here it is the honest split: MCP's schema is published to
 * its caller and REST's body shape is not, so the strict door can afford to refuse and the open one has to
 * explain. It is documented rather than left to be discovered.
 */
import { RECORD_SUPPRESS_FIELD, RECORD_SUPERSEDED_FIELD } from '../../brain/record-flag.js';
import type { SchemaViolation } from '../../spaces/schema-validation.js';
import { NAME_QUOTED, REFUSAL_NAMES_MAX, peerText } from '../../util/log.js';

/**
 * Body keys every brain WRITE accepts, whichever record type it is — read by shared helpers rather than by
 * any route body.
 *
 * They have to live here, or every route would warn about `ttlDays`: a route declares the fields it
 * destructures, and these are read by `ttlDaysFromBody`, `dupeCheckOptsFromBody` and the suppression parser.
 * A warnings array that cried wolf on the commonest write there is would be one nobody reads.
 *
 * The two suppression spellings come from the constants the parser itself uses, so a rename cannot leave this
 * list behind.
 */
export const SHARED_WRITE_BODY_KEYS: readonly string[] = [
  'ttlDays',
  'waitForEmbedding',
  'checkDuplicates',
  'checkContradictions',
  'dupeThreshold',
  RECORD_SUPPRESS_FIELD,
  RECORD_SUPERSEDED_FIELD,
];

/**
 * The keys of `body` that are neither in `known` nor shared by every write.
 *
 * Returns `SchemaViolation` rows so they can be concatenated onto the schema warnings a `warn` space already
 * produces — one array, one shape, one thing for a caller to read.
 *
 * A non-object body yields nothing: `req.body` can be `undefined`, a string, a number or an array depending on
 * what was posted and what the parser made of it, and none of those is a bag of keys. Inventing warnings from
 * one would report on something that was never a field.
 *
 * **Bounded, because the keys are the caller's** (`Q-362`, R6-11). At most {@link REFUSAL_NAMES_MAX} unknown keys get a row, in the
 * order the body carries them, and one last row says how many were left out: a ten-megabyte body of unknown keys was hundreds of
 * thousands of rows, each carrying the same accepted list. A key is named at `NAME_QUOTED` and a string value by `peerText`, the
 * renderer every refusal quotes a caller's choices with; the accepted list is built ONCE. This is the BOUND only — whether an
 * unknown key is warned or refused is another question (`Q-320`) and is not decided here.
 */
export function unknownFieldWarnings(body: unknown, known: readonly string[]): SchemaViolation[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  const accepted = new Set([...known, ...SHARED_WRITE_BODY_KEYS]);
  const bag = body as Record<string, unknown>;
  const out: SchemaViolation[] = [];
  let unknown = 0;
  let reason: string | undefined;
  for (const key of Object.keys(bag)) {
    if (accepted.has(key)) continue;
    unknown++;
    if (out.length >= REFUSAL_NAMES_MAX) continue;
    // What it accepts, not just what it did not: "unknown field" alone tells a caller their write was
    // wrong without telling them what right looks like, which is the refusal shape this repo keeps fixing.
    reason ??= `unknown field — ignored. This route accepts: ${[...accepted].sort().join(', ')}`;
    out.push({
      field: peerText(key, { max: NAME_QUOTED }),
      // The caller's own value, echoed so they can see WHICH of several sends produced this. Objects and
      // arrays are named by type rather than inlined: a warning is not a place to reflect a payload back.
      value: summarise(bag[key]),
      reason,
    });
  }
  if (unknown > out.length) {
    const left = unknown - out.length;
    out.push({ field: `…(+${left} more)`, value: left, reason: `${left} more unknown field(s) — ignored; the first ${REFUSAL_NAMES_MAX} are named above` });
  }
  return out;
}

/** A value small enough to put in a warning: primitives as they are, a string through the bounded renderer, everything else named by its type. */
function summarise(v: unknown): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) return `[array of ${v.length}]`;
  if (typeof v === 'object') return '[object]';
  if (typeof v === 'string') return peerText(v, { max: SUMMARISED_STRING_MAX });
  return v;
}

/** How much of a string value a warning row echoes: enough to tell which of several sends produced it. */
const SUMMARISED_STRING_MAX = 80;
