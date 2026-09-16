/**
 * `recall`'s `traverse` option: a depth, or a whole traversal.
 *
 * ## Why it grew from a number
 *
 * Recall's graph expansion used to be one integer — a depth — and followed EVERY edge in BOTH directions,
 * because there was nowhere to say otherwise. The standalone `traverse` tool, building the same Mongo query
 * twenty lines away in the same file, applied an `edgeLabels` filter and honoured `direction`. One rule, two
 * implementations, and the one reachable from a search had the weaker.
 *
 * That is not a missing convenience. On any corpus where a few nodes hold most of the edges — every real one —
 * an unnarrowed hop off a hub returns whichever neighbours the node cap happened to keep, and the caller cannot
 * tell that from a deliberate answer. The owner's ruling, 2026-08-29: *"recall's traverse must be the same as
 * the real thing"*.
 *
 * ## The shape
 *
 * It is a `traverse` call without its start node, because in a recall the start nodes ARE the results:
 *
 *     traverse: 2
 *     traverse: { depth: 2, edgeLabels: ['owns', 'lives_in'], direction: 'outbound' }
 *
 * The number still works and means exactly what it always meant. That is not politeness to old callers — it is
 * the common case, and a parameter that forces `{ depth: 1 }` on somebody who wants one hop of everything has
 * made the simple thing harder to buy the complex one.
 *
 * `limit` is deliberately NOT accepted. In a standalone traverse the caller sets it; in a recall the node cap is
 * derived from `topK` and the byte budget, and letting a caller raise it here would let `traverse` overrule the
 * budget that governs the rest of the answer.
 */

export interface TraverseOption {
  depth: number;
  edgeLabels?: string[] | undefined;
  /**
   * Which way to walk STORED EDGES. It does not narrow links.
   *
   * **A link's direction is fixed by the KINDS at its ends, not by how it is stored.** A fact names
   * entities; an entity names nothing. So from any starting point there is only one way a link can run,
   * and there is nothing for `direction` to select between. Both traversals reach what a record names,
   * whatever `direction` says — the standalone `traverse` tool has always done so and recall's expansion
   * matches it.
   *
   * The consequence worth stating, because it surprises: `{direction: 'inbound', includeMemories: true}` on a
   * matched fact still returns the entities that fact NAMES, which is an outbound step from the record.
   * Honouring direction on links would make `inbound` hide a fact's own links, which is not what anyone
   * asks for by narrowing.
   *
   * ## THE REASON ABOVE REPLACES A WRONG ONE, corrected 2026-09-05
   *
   * This said a link *"is an `entityIds` ARRAY today … carrying ONE orientation"*, and that `M-2` would
   * make it a record with two ends and therefore have to decide the question again. Both halves were
   * wrong, and the second was the dangerous one — it told a future reader to change a documented
   * parameter as soon as the migration landed.
   *
   *  - Links are ALREADY records on a converted space. `usesLinkRecords` decides per space and
   *    `links-conversion.ts` sets it, so "a link is an array today" describes one of the two shapes.
   *  - **The array expresses BOTH readings, and `link-frontier.ts` implements both.** `linksToAny` finds
   *    the records whose array names an id — inbound; reading a record's own `cls.field` gives what it
   *    names — outbound. The record shape has the same two, as `linksPointingAt` and `linksStartingFrom`.
   *    So the representation was never what made `direction` meaningless.
   *
   * What makes it meaningless is the sentence at the top, which holds for both shapes and cannot rot with
   * the storage: the ends of a link are of different KINDS, so its orientation is implied by where you
   * started. `docs/integration-guide/04a-recall-api.md` already said it that way; the source did not.
   *
   * The lesson is the one `CLAUDE.md` states about schema descriptions: write the GUARANTEE, not the
   * mechanism. A reason given as a mechanism has to be revisited every time the mechanism gains a case,
   * and nobody does — so it goes on being read after it stops being true.
   */
  direction?: 'outbound' | 'inbound' | 'both' | undefined;
  /** Follow `chrono.entityIds` as an inbound link, reaching timeline entries about a matched entity. */
  includeChrono?: boolean | undefined;
  /** Follow `fact.entityIds` the same way. */
  includeMemories?: boolean | undefined;
  /** Follow `file.entityIds`, reaching file META — never chunk text. */
  includeFiles?: boolean | undefined;
}

/** Every key the object form accepts. Exported so both doors refuse the same set rather than each their own. */
export const TRAVERSE_OPTION_FIELDS =
  ['depth', 'edgeLabels', 'direction', 'includeChrono', 'includeMemories', 'includeFiles'] as const;

/**
 * The three link flags, and why every one of them defaults to **off** here.
 *
 * The standalone `traverse` tool defaults `includeChrono` ON, because its caller is explicitly exploring a
 * graph: a flag defaulting off would leave the graph looking the same to everyone who does not already know
 * the answer. That argument does not carry across.
 *
 * A recall caller asked for semantic matches, and expansion is decoration on top of them. The answer is
 * BUDGETED — a match is counted together with its whole nested subtree — so every linked record admitted by
 * default is paid for in matches that no longer fit. Facts are usually the most numerous record type in a
 * space, which is the same reason the standalone tool leaves that one off too.
 *
 * Off by default also means this change alters no existing response, which is what makes a change this wide
 * safe to ship at all. Raising `includeChrono` to on for recall is a one-line follow-up somebody can argue
 * for on its own merits, against measurements rather than against a release.
 */
const LINK_FLAGS = ['includeChrono', 'includeMemories', 'includeFiles'] as const;

const DIRECTIONS = new Set(['outbound', 'inbound', 'both']);

export type TraverseParseResult =
  | { ok: true; value: TraverseOption }
  | { ok: false; error: string };

/**
 * Parse `traverse` from a request body: absent, a number, or an object.
 *
 * REFUSES rather than coerces, in every direction. `traverse: "2"` is a mistake, not a two; `direction: 'up'`
 * is a mistake, not a default; an unknown key is a misspelling of a real one. A parameter that silently
 * downgrades to its default returns a shallower graph with a 200 — which is the shape of defect this file's
 * neighbours have been fixing for three releases, and the reason `/traverse` and `/query` already refuse
 * unknown body fields.
 *
 * @param raw      the caller's value, or `undefined`
 * @param maxDepth the ceiling this door allows, so the two doors quote the same number in the same message
 */
export function parseTraverseOption(raw: unknown, maxDepth: number): TraverseParseResult {
  if (raw === undefined || raw === null) return { ok: true, value: { depth: 0 } };

  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0 || raw > maxDepth) {
      return { ok: false, error: `traverse must be an integer between 0 and ${maxDepth}, or an object` };
    }
    return { ok: true, value: { depth: raw } };
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'traverse must be a number (the depth) or an object { depth, edgeLabels, direction }' };
  }

  const obj = raw as Record<string, unknown>;
  const unknown = Object.keys(obj).filter(k => !(TRAVERSE_OPTION_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `traverse has unknown field(s): ${unknown.join(', ')}. Allowed: ${TRAVERSE_OPTION_FIELDS.join(', ')}. `
        + 'Note `limit` is not accepted here — in a recall the node cap comes from topK and the byte budget.',
    };
  }

  const depth = obj['depth'];
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0 || depth > maxDepth) {
    return { ok: false, error: `traverse.depth must be an integer between 0 and ${maxDepth}` };
  }

  const value: TraverseOption = { depth };

  const labels = obj['edgeLabels'];
  if (labels !== undefined) {
    if (!Array.isArray(labels) || !labels.every(l => typeof l === 'string' && l.length > 0)) {
      return { ok: false, error: 'traverse.edgeLabels must be an array of non-empty strings' };
    }
    // An EMPTY array is preserved as "no narrowing" rather than "match nothing", matching the standalone
    // traverse. Both readings are defensible; they must not differ between the two doors, and this is the one
    // the standalone path has always taken.
    if (labels.length > 0) value.edgeLabels = labels as string[];
  }

  const direction = obj['direction'];
  if (direction !== undefined) {
    if (typeof direction !== 'string' || !DIRECTIONS.has(direction)) {
      return { ok: false, error: "traverse.direction must be one of 'outbound', 'inbound', 'both'" };
    }
    value.direction = direction as 'outbound' | 'inbound' | 'both';
  }

  // REFUSED rather than coerced, like everything else here: `includeChrono: 'yes'` is a mistake, and a
  // truthy-string default would return a bigger graph with a 200 and no way to tell it was not asked for.
  for (const flag of LINK_FLAGS) {
    const raw = obj[flag];
    if (raw === undefined) continue;
    if (typeof raw !== 'boolean') return { ok: false, error: `traverse.${flag} must be a boolean` };
    value[flag] = raw;
  }

  return { ok: true, value };
}

/**
 * What to echo back on the response, so a caller can see what the server actually did.
 *
 * The number form echoes as a number and the object form as an object: a response that always reported the
 * expanded shape would make every existing caller's assertion fail for no behavioural reason, and one that
 * always reported a number would hide the narrowing that was applied.
 */
export function echoTraverse(opt: TraverseOption): number | TraverseOption {
  // Every narrowing key, not a hand-kept pair. When the three link flags were added, a list naming only
  // `edgeLabels` and `direction` would have echoed `traverse: 2` for a call that also asked for chrono —
  // reporting a walk the server did not do, which is the one thing this echo exists to prevent.
  const narrowed = TRAVERSE_OPTION_FIELDS.some(k => k !== 'depth' && opt[k] !== undefined);
  return narrowed ? opt : opt.depth;
}

/**
 * The JSON Schema for the `traverse` parameter, DERIVED from the fields this module accepts.
 *
 * ## Why it lives here and not beside the tools
 *
 * The two MCP tools that take a traverse — `recall` and `find_similar` — each spelled this object out
 * inline, and that is how they came to disagree with the parser: 3.6 added three flags to
 * `TRAVERSE_OPTION_FIELDS` and the REST route accepted them the same day, while both schemas went on
 * declaring `{depth, edgeLabels, direction}` with `additionalProperties: false`.
 *
 * That is not a documentation lapse. The dispatcher validates `inputSchema` with Ajv **before** the handler
 * runs, so the object branch matched nothing and the call was refused — while the byte-identical REST body
 * answered 200. One API, two doors, and the door with the stricter guard silently offered less.
 *
 * Building it from the same constant the parser refuses unknown keys against means a fourth field cannot
 * reach one surface and not the other: there is one list, and both the acceptance and the advertisement come
 * out of it.
 *
 * `additionalProperties: false` is kept deliberately. `limit` is not accepted here — in a recall the node cap
 * comes from `topK` and the byte budget, and a traverse that could raise it would overrule the budget
 * governing the rest of the answer — and a schema that accepted any key would let it through.
 *
 * @param maxDepth the ceiling this door allows, so the schema and the parser quote the same number.
 */
export function traverseOptionSchema(maxDepth: number): Record<string, unknown> {
  return {
    // `oneOf` rather than a widened type, so a caller sending a string still gets a schema refusal from the
    // dispatcher rather than a runtime one.
    oneOf: [
      { type: 'number', minimum: 0, maximum: maxDepth },
      {
        type: 'object',
        properties: {
          depth: { type: 'number', minimum: 0, maximum: maxDepth },
          edgeLabels: { type: 'array', items: { type: 'string' } },
          direction: {
            type: 'string',
            enum: ['outbound', 'inbound', 'both'],
            description: 'Which way to walk STORED EDGES; default both. It does NOT narrow links. A link is a '
              + 'record with a from and a to since 4.0, but which way it runs is fixed by the KINDS at its '
              + 'ends rather than by the data — a fact names entities and entities name nothing — so there '
              + 'is nothing for direction to select between and both traversals reach the entity it names '
              + 'whatever this says. So {direction: "inbound", includeMemories: true} on a matched fact '
              + 'still returns the entities that fact NAMES.',
          },
          includeChrono: { type: 'boolean' },
          includeMemories: { type: 'boolean' },
          includeFiles: { type: 'boolean' },
        },
        required: ['depth'],
        additionalProperties: false,
      },
    ],
  };
}
