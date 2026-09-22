/**
 * What relationships a write asks for — the `link*` fields and the `edges` field, and applying them.
 *
 * Named for the QUESTION rather than for either field, because a door does not care which of the two a
 * caller used: it asks *"what connections does this body want"* and gets one answer. That is also what keeps
 * every door to two lines — one refusal, one apply — rather than six copies of the same pair growing apart.
 *
 * ## The `link*` fields — one call to create a record and the links it needs.
 *
 * ## What this is for (`F-27`)
 *
 * A fleet operator, 2026-09-06: they intend to convert to link records and this is what stops them. Every
 * write door takes a reference at create time today, and after conversion those fields are refused — so
 * attaching a record to three things becomes four calls, and `save_bulk`'s reason for existing is undone.
 *
 * **They are not asking to keep the arrays.** Their words: *"if links become the only truth and the arrays
 * are deleted, that is cleaner than carrying two things that must be kept in step forever."* What has to
 * survive is the single call. Read that way the field is plain INPUT — sugar for *"and then make these
 * links"* — so there is no second representation left to diverge from the first.
 *
 * ## A VERB, not a noun, and one field per kind
 *
 * `entityIds` reads as *store this value*, which is what it did for all of 3.x. After conversion the same
 * name would mean *go and create these links*: a field named like a property and behaving like an
 * instruction reads correctly and is understood wrongly. An old caller gets a refusal naming the new field,
 * and the rename is what explains the change — the same argument this project made for
 * `OLLAMA_URL` → `VISION_BASE_URL`, quoted back at us.
 *
 * One field per kind rather than a generic `links: [{to, toKind}]`, for the reason `save_link` already
 * gives for requiring `toKind` explicitly: the same UUID can name records in two collections, and a wrong
 * guess produces a link that reads as correct and points at nothing. Putting the kind in the field NAME
 * retires that hazard instead of restating it.
 *
 * ## The unlink semantics are `reconcileLinks`, not a new rule
 *
 * The operator asked us to state whether an update replaces or adds, having been caught before by tags that
 * union-merge and can never be removed. The answer already exists in the writer and is worth naming: a
 * class the caller NAMES is replaced wholesale, a class they omit is untouched. So `linkEntities: []`
 * detaches every entity and leaves the fact links alone, and there is no add-only trap to fall into.
 *
 * This module does not implement that. It maps input to the shape `reconcileLinks` already takes — see the
 * `CLAUDE.md` rule on reusing a module rather than writing the rule a second time.
 */
import { REF_KINDS, LINK_INPUT_FIELDS } from '../config/types-knowledge.js';
import type { RefKind } from '../config/types-knowledge.js';
import type { DesiredLinks } from './links.js';
import { isWellFormedRef, edgeEndpointKindSchema, edgeEndpointKind } from './entity-refs.js';
import { primitivePropertyError } from './property-values.js';
import { reconcileLinks } from './links.js';
import { linksStartingFrom, linkClassesFrom } from './link-adjacency.js';
import { upsertEdge } from './edges.js';
import { retiredWriteFieldError } from './retired-write-fields.js';
import type { AuthorRef } from '../config/types.js';
import type { WebhookActor } from '../webhooks/dispatcher.js';

/**
 * The write field for each kind — declared beside the kind vocabulary and re-exported here.
 *
 * `entity` → `linkEntities`, `fact` → `linkFacts`, `chrono` → `linkChronos`, `file` → `linkFiles`. It sits
 * in `config/types-knowledge.ts` because `brain/links.ts` names these fields in its refusals and cannot
 * import this module — it is the writer this one calls. One map, both ends.
 */
export { LINK_INPUT_FIELDS } from '../config/types-knowledge.js';

/** Every `link*` field name, for a door that needs to spot one in a body. */
export const LINK_INPUT_NAMES: readonly string[] = Object.freeze(Object.values(LINK_INPUT_FIELDS));

/**
 * Read the `link*` fields out of a request body.
 *
 * Returns `null` when the body names none of them — which a caller must treat as "this write has nothing to
 * say about links", NOT as "remove them all". An empty object would be the same value as
 * `{ entity: [] }` to `reconcileLinks`, and those two mean opposite things.
 */
export function desiredLinksFrom(body: unknown): DesiredLinks | null {
  if (!body || typeof body !== 'object') return null;
  const bag = body as Record<string, unknown>;
  const desired: Record<string, readonly string[]> = {};
  for (const kind of REF_KINDS) {
    const field = LINK_INPUT_FIELDS[kind];
    if (!(field in bag)) continue;
    desired[kind] = (bag[field] as string[] | null) ?? [];
  }
  return Object.keys(desired).length > 0 ? desired as DesiredLinks : null;
}

/**
 * The `link*` fields a body names, keyed as the WRITERS take them rather than by kind.
 *
 * `saveFact`, `updateChrono` and `updateFileMeta` take `linkEntities` / `linkFacts` / `linkChronos`
 * directly, so a door spreads this into the options object it was building anyway. A field the body does
 * not name is ABSENT from the result rather than empty, because those two mean opposite things to
 * `reconcileLinks` — omitted leaves the class alone, `[]` detaches it.
 */
export function linkFieldsFrom(body: unknown): Record<string, string[]> {
  const desired = desiredLinksFrom(body);
  if (!desired) return {};
  const out: Record<string, string[]> = {};
  for (const kind of Object.keys(desired) as RefKind[]) {
    out[LINK_INPUT_FIELDS[kind]] = [...(desired[kind] ?? [])];
  }
  return out;
}

/**
 * Why this body's `link*` fields cannot be honoured, or `null`.
 *
 * Shape first, then well-formedness per kind. It does NOT check that the targets exist: that is
 * `assertRefsResolve`'s job at the writer, where it can be done in one query against the records being
 * written rather than once per door — and a door that checked existence itself would be the second
 * implementation this module exists to avoid.
 */
export function linkInputError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const bag = body as Record<string, unknown>;

  for (const kind of REF_KINDS) {
    const field = LINK_INPUT_FIELDS[kind];
    if (!(field in bag)) continue;

    const value = bag[field];
    // `null` is the caller writing "none", the same as `[]`. Anything else that is not an array is a shape
    // error rather than an empty set — reading `"abc"` as one id is how a filter silently matches nothing.
    if (value === null) continue;
    if (!Array.isArray(value)) return `${field} must be an array of ids`;

    for (const ref of value) {
      if (typeof ref !== 'string' || !ref.trim()) return `${field} must contain non-empty ids`;
      if (!isWellFormedRef(kind, ref)) {
        return kind === 'file'
          ? `${field} must contain space-relative paths, not ids`
          : `${field} must contain UUIDs`;
      }
    }
  }
  return null;
}


/**
 * The `link*` properties for a tool's `inputSchema`, built from the same map the readers use.
 *
 * A tool schema is `additionalProperties: false` and the dispatcher enforces it BEFORE the handler runs, so
 * a field declared on one door and not the other is refused outright while the other door accepts it —
 * `traverse`'s three link flags shipped exactly that way. Building both from one place is what makes the
 * parity structural rather than remembered.
 */
export function linkInputSchemas(): Record<string, unknown> {
  return linkInputSchemasForKinds(REF_KINDS);
}

/**
 * The `link*` properties a record of THIS kind can honour — a fact names entities, a file names all three.
 *
 * A door for one record kind declares this rather than the whole set. Declaring a class the record cannot
 * hold is the worse half of the same defect a missing declaration is: the caller is told they can attach a
 * file to a file, the writer has no class for it, and what comes back is a success.
 *
 * Derived from `LINK_CLASSES`, which is the one definition of what the six classes are.
 */
export function linkInputSchemasFor(fromKind: RefKind): Record<string, unknown> {
  return linkInputSchemasForKinds(linkClassesFrom(fromKind).map(c => c.toKind));
}

function linkInputSchemasForKinds(kinds: readonly RefKind[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kind of kinds) {
    const isPath = kind === 'file';
    out[LINK_INPUT_FIELDS[kind]] = {
      type: 'array',
      items: { type: 'string' },
      description:
        `Create links from this record to these ${kind} records, in the same call. `
        + (isPath
          ? 'Each entry is a space-relative PATH, not an id. '
          : 'Each entry is a UUID v4. ')
        + 'An entry naming nothing is refused rather than stored as a dead link. '
        + 'ON AN UPDATE THIS REPLACES the links of this kind: sending `[]` detaches them all, and omitting '
        + 'the field entirely leaves them alone. Links of OTHER kinds are never touched by this field.',
    };
  }
  return out;
}

/**
 * The `edges` write field — a record and its LABELLED relationships in one call.
 *
 * ## Why this exists beside `link*` rather than inside it (`F-27`)
 *
 * The operator drew the line and it is the right one: *"A link is unlabelled. Which way it runs is fixed by
 * the kinds at its ends — a fact names entities and entities name nothing — so `linkEntities: [uuid]` is
 * complete on its own. An edge carries a LABEL, a DIRECTION that is data rather than derivable, and
 * optionally properties, tags, weight and type. `posted_by` and `addressed_to` from the same post to two
 * parties are two different facts, and no array of bare UUIDs can say which is which."*
 *
 * So the shapes cannot merge. What they can share is the mechanism: one module that produces the field, its
 * validation and its published schema, which every door spreads in. The operator's own objection to edges on
 * create tools was *"writing edge support into six endpoints"* — a cost that is only real if it is written
 * six times, and this is the reason it is not.
 *
 * ## The other end must already EXIST, and that is what makes this simpler than the batch
 *
 * A single-record write has exactly one new record in it, so there is nothing to correlate: every `to` names
 * something already stored. No `$ref`, no ordering, no derived kind. The batch case — creating a post and
 * three labelled relationships to records the same call minted — is the correlation key in `save_bulk`, and
 * it stays there.
 *
 * ## Edges UPSERT. They do NOT replace, and links do
 *
 * The one place these two fields deliberately disagree, and it is worth stating because the operator asked
 * for the semantics to be stated. `linkEntities: []` detaches every entity link, because the set of
 * unlabelled links from a record is a thing a caller owns wholesale. An edge is not: it carries a label,
 * properties, and possibly another author, so replacing "every edge from this record" on an update would
 * delete work nobody asked to delete. Writing the same triplet again updates it; removing one is
 * `delete_edge`, which is a deliberate act with its own door.
 */
export interface EdgeInput {
  to: string;
  label: string;
  toKind?: RefKind;
  weight?: number;
  type?: string;
  description?: string;
  tags?: string[];
  properties?: Record<string, string | number | boolean>;
}

/** The published schema for the `edges` field, so both doors declare the identical shape. */
export function edgeInputSchema(): Record<string, unknown> {
  return {
    type: 'array',
    description:
      'Create labelled relationships from this record, in the same call. Each entry needs `to` and '
      + '`label`; `toKind` defaults to entity. The other end must ALREADY EXIST — this is not a way to '
      + 'connect two records the same call creates, which is what `save_bulk` and its `$ref` are for. '
      + 'THESE UPSERT, they do not replace: writing the same (to, label) again updates that edge, and no '
      + 'edge is ever removed by this field — an edge carries a label, properties and possibly another '
      + "author, so clearing the set would delete work nobody asked to delete. Use `delete_edge` for that. "
      + 'Contrast `linkEntities` and its siblings, which DO replace, because an unlabelled link set is '
      + 'something one record owns wholesale.',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['to', 'label'],
      properties: {
        to: { type: 'string', description: 'The record at the other end. A UUID v4, or a space-relative path when `toKind` is `file`.' },
        label: { type: 'string', minLength: 1, description: 'What the relationship IS — `posted_by`, `answers`, `owns`. It is part of the edge identity.' },
        toKind: edgeEndpointKindSchema('to'),
        weight: {
          type: 'number', minimum: 0, maximum: 1,
          description: 'How strong this relationship is, 0–1. It is NOT a ranking input — nothing sorts by '
            + 'it — so it is yours to interpret, and a space that means different things by it in different '
            + 'places has made it useless. Omit it rather than defaulting it to 1.',
        },
        type: {
          type: 'string',
          description: 'Optional edge type, validated against the space schema exactly like a record type. '
            + 'On a strict space an unknown type is refused, so this is the field that turns a typo into a '
            + '400 rather than into an edge nobody queries.',
        },
        description: {
          type: 'string',
          description: 'Free text about this relationship, and it IS embedded — an edge is a searchable '
            + 'record, so what you write here is findable by meaning later. That is the reason to write a '
            + 'sentence rather than a note to yourself.',
        },
        tags: {
          type: 'array', items: { type: 'string' },
          description: 'Tags on the EDGE, not on either end. They are embedded with it and filterable '
            + 'exactly, so they are how you find a class of relationship without knowing either record.',
        },
        properties: {
          type: 'object',
          additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
          description: 'Property values must be a string, a number or a boolean — the same rule every other door applies.',
        },
      },
    },
  };
}

/** The `edges` a body asks for, or `null` when it names none. Absent is not empty — see `desiredLinksFrom`. */
export function edgeInputsFrom(body: unknown): EdgeInput[] | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>)['edges'];
  if (raw === undefined) return null;
  return Array.isArray(raw) ? raw as EdgeInput[] : [];
}

/**
 * Why this body's `edges` cannot be honoured, or `null`.
 *
 * Shape and well-formedness only. Existence is checked at the writer, against the space, in one query per
 * kind — a door that checked it itself would be the second implementation this module exists to avoid, and
 * `assertRefsResolve` is already that one implementation.
 */
export function edgeInputError(body: unknown): string | null {
  const edges = edgeInputsFrom(body);
  if (edges === null) return null;
  if (!Array.isArray((body as Record<string, unknown>)['edges'])) return '`edges` must be an array';

  for (const [i, e] of edges.entries()) {
    const at = `edges[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return `${at} must be an object`;
    if (typeof e.label !== 'string' || !e.label.trim()) return `${at}.label is required`;
    if (typeof e.to !== 'string' || !e.to.trim()) return `${at}.to is required`;

    // The SHARED coalescer. Writing `?? 'entity'` here would be a seventh copy of the same default, in a
    // module whose own docblock argues against exactly that — and the gate that forbids it caught this
    // before the commit did.
    const kind = edgeEndpointKind(e.toKind);
    if (!REF_KINDS.includes(kind as RefKind)) {
      return `${at}.toKind must be one of ${REF_KINDS.join(', ')}`;
    }
    if (!isWellFormedRef(kind as RefKind, e.to)) {
      return kind === 'file'
        ? `${at}.to must be a space-relative path when toKind is file`
        : `${at}.to must be a UUID v4`;
    }
    if (e.weight !== undefined && (typeof e.weight !== 'number' || e.weight < 0 || e.weight > 1)) {
      return `${at}.weight must be a number between 0 and 1`;
    }
    const propErr = primitivePropertyError(e.properties);
    if (propErr) return `${at}.properties: ${propErr}`;
  }
  return null;
}


/**
 * Everything a body says about relationships, refused in one call.
 *
 * A door asks this ONCE. Three separate checks would mean every door remembering all of them, and a door
 * that remembers two is the shape this repository has paid for over and over. The retired NAMES are
 * checked first, so a caller still on the 4.x spelling is told what to send instead of being told their
 * ids are the wrong shape for a field they did not mention.
 */
export function connectionInputError(body: unknown): string | null {
  return retiredWriteFieldError(body) ?? linkInputError(body) ?? edgeInputError(body);
}

/** The published properties for a tool schema: the `link*` fields and `edges`, from one place. */
export function connectionSchemas(): Record<string, unknown> {
  return { ...linkInputSchemas(), edges: edgeInputSchema() };
}

/** Every body key these fields occupy, so a door can call them known rather than warn about them. */
export const CONNECTION_BODY_KEYS: readonly string[] = Object.freeze([...LINK_INPUT_NAMES, 'edges']);

/**
 * What an audit entry should compare when a write changes a record's links — the pair, from ONE place.
 *
 * ## Why the record snapshots cannot answer this any more
 *
 * `audit/middleware.ts` records what changed by diffing the record BEFORE against the record AFTER, and
 * the allowlist named `entityIds`, `memoryIds` and `chronoIds` so a re-link left a trace. 5.0 moved those
 * connections into link records, so neither snapshot carries them — and the way that fails is the one this
 * module's neighbours keep warning about: the entry still appears, the field is simply missing from
 * `changes`, and an audit reader concludes the links were untouched. *"Losing track of what a file was
 * linked to is exactly the kind of change nobody notices until a traversal comes back empty."*
 *
 * ## Only the classes the body NAMED, and that is the same rule the writer applies
 *
 * A class the caller omitted is not touched by the write, so reporting it would put an unchanged set into
 * every entry. A body naming no link field at all gets two empty objects and costs no query — links cannot
 * have changed, so there is nothing to read.
 *
 * Call it BEFORE the write: `before` is read from the link records as they still stand, and `after` is what
 * the body asked for, which is what `reconcileLinks` will make true of the classes it names.
 */
export async function linkAuditSnapshots(
  spaceId: string,
  from: string,
  body: unknown,
): Promise<{ before: Record<string, string[]>; after: Record<string, string[]> }> {
  const desired = desiredLinksFrom(body);
  if (!desired) return { before: {}, after: {} };

  const rows = await linksStartingFrom(spaceId, [from]);
  const before: Record<string, string[]> = {};
  const after: Record<string, string[]> = {};
  for (const kind of Object.keys(desired) as RefKind[]) {
    const field = LINK_INPUT_FIELDS[kind];
    before[field] = rows.filter(r => r.toKind === kind).map(r => r.to);
    after[field] = [...(desired[kind] ?? [])];
  }
  return { before, after };
}

/**
 * Make the relationships a write asked for, AFTER the record exists.
 *
 * After, because a relationship needs both ends and the `from` is what was just minted. One function rather
 * than two calls per door for the reason above — and because the two halves have different semantics that a
 * door should not have to hold in its head:
 *
 *  - **Links REPLACE per class.** A class the caller named is made to equal what they sent; a class they
 *    omitted is untouched. `reconcileLinks` has always done this, and it is the unlink rule the operator
 *    asked to have stated.
 *  - **Edges UPSERT.** Writing the same (to, label) again updates it; nothing is ever removed. An edge
 *    carries a label, properties and possibly another author, so clearing the set would delete work nobody
 *    asked to delete — removal is `delete_edge`, a deliberate act with its own door.
 *
 * Returns what it did, so a door can report it without counting again.
 */
export async function applyConnections(
  spaceId: string,
  from: string,
  fromKind: RefKind,
  body: unknown,
  author: AuthorRef,
  actor?: WebhookActor,
): Promise<{ links: number; edges: number }> {
  const desired = desiredLinksFrom(body);
  const links = desired ? (await reconcileLinks(spaceId, from, fromKind, desired, author)).added : 0;

  let edges = 0;
  for (const e of edgeInputsFrom(body) ?? []) {
    await upsertEdge(
      spaceId, from, e.to, e.label, e.weight, e.type, e.description, e.properties, e.tags,
      actor, undefined,
      { fromKind, ...(e.toKind ? { toKind: e.toKind } : {}) },
    );
    edges++;
  }
  return { links, edges };
}
