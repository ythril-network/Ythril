/**
 * The batch correlation key — how one call creates a record and points at it.
 *
 * ## What it is for (`F-27` item 2)
 *
 * `save_bulk` takes facts, entities, chrono entries and edges in one payload, and its own contract says
 * why that is not enough: **you cannot reference a record this call creates**, because identities are minted
 * server-side. So a person, a document about them and the date it was signed is three ordered calls.
 *
 * Measured by the operator who asked: posting ONE message to their board cost six round trips — one
 * `save_entity`, then five `save_edge` for `posted_by`, `addressed_to`, two `answers` and one `corrects`.
 * Every post on that board is one record and three to five labelled relationships.
 *
 * ## A key, scoped to the call, never stored
 *
 * An item declares `"$ref": "post-1"`; anything later in the same payload names it as `"$ref:post-1"`. The
 * key exists for the length of one request and reaches no document — it is not an id, and a caller that
 * expects to find it afterwards has misread it.
 *
 * ## The KIND becomes derivable, which removes a hazard rather than adding one
 *
 * `fromKind`/`toKind` exist because a bare UUID could name records in two collections, and a wrong guess
 * produces a relationship that reads as correct and points at nothing. A `$ref` cannot be ambiguous: it
 * resolves to a record this payload created, and **which array it came from says what kind it is**. Where a
 * caller states a kind that disagrees with the array, the item is refused rather than stored — the
 * disagreement is a mistake somewhere, and guessing which side is right is how the hazard comes back.
 */
import type { RefKind } from '../config/types-knowledge.js';

/** How a caller declares a key on an item, and how they name it afterwards. */
export const REF_DECLARE_FIELD = '$ref';
const REF_USE_PREFIX = '$ref:';

/** Is this value a reference to something the same call created, rather than a stored id? */
export function isRefUse(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(REF_USE_PREFIX);
}

/** The key a `"$ref:post-1"` names. Undefined for anything that is not a reference. */
export function refKeyUsed(value: unknown): string | undefined {
  return isRefUse(value) ? value.slice(REF_USE_PREFIX.length) : undefined;
}

/** The key an item declares, if any. */
export function refKeyDeclared(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const v = (item as Record<string, unknown>)[REF_DECLARE_FIELD];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** What a key resolved to: the minted id, and the kind implied by the array it was declared in. */
export interface ResolvedRef {
  id: string;
  kind: RefKind;
}

/**
 * The keys one call has minted so far.
 *
 * Deliberately a class rather than a bare Map: recording a key has a RULE — a duplicate is refused rather
 * than overwritten — and a Map cannot carry that. Two items claiming `post-1` is a mistake with two
 * plausible readings, and picking one silently means half of a payload points somewhere its author did not
 * intend.
 */
export class BatchRefs {
  private readonly minted = new Map<string, ResolvedRef>();

  /** Record what a key resolved to. Returns an error string when the key is already taken. */
  declare(key: string, id: string, kind: RefKind): string | null {
    const existing = this.minted.get(key);
    if (existing) {
      return `duplicate $ref "${key}" — it already names the ${existing.kind} ${existing.id}. `
        + 'A key must be unique within one call, or a reference to it means two different things.';
    }
    this.minted.set(key, { id, kind });
    return null;
  }

  /** What a key names, or undefined when nothing in this call declared it. */
  get(key: string): ResolvedRef | undefined {
    return this.minted.get(key);
  }

  get size(): number {
    return this.minted.size;
  }

  /**
   * Every key this call minted, with its id — what the batch answers with, so a caller never reads the space
   * back by text to learn the ids it just created. Only keys whose item was WRITTEN are here: `declare` runs
   * after the write, so a refused item's key is absent rather than present with an id nobody was given.
   */
  toJSON(): Record<string, ResolvedRef> {
    return Object.fromEntries(this.minted);
  }
}

/** What went wrong resolving one reference, phrased for the caller who wrote it. */
export interface RefResolution {
  id?: string;
  kind?: RefKind;
  error?: string;
}

/**
 * Turn one value into a stored id, whether it is a reference or already an id.
 *
 * A value that is not a `$ref:` is returned untouched — this is the one place that decides, so a caller
 * never has to ask "is this a reference" before using it.
 *
 * `statedKind` is what the caller wrote alongside it, if anything. For a reference it is CHECKED rather
 * than used: the array the key was declared in already says what kind it is, and a disagreement is refused.
 */
export function resolveRef(value: unknown, refs: BatchRefs, statedKind?: RefKind): RefResolution {
  const key = refKeyUsed(value);
  if (key === undefined) {
    return { id: typeof value === 'string' ? value : undefined, ...(statedKind ? { kind: statedKind } : {}) };
  }

  const found = refs.get(key);
  if (!found) {
    return {
      error: `unknown $ref "${key}". A reference can only name a record declared earlier in the SAME call, `
        + `with "${REF_DECLARE_FIELD}": "${key}" on it — and the arrays are written in order, so a `
        + 'reference cannot point forwards.',
    };
  }
  if (statedKind && statedKind !== found.kind) {
    return {
      error: `$ref "${key}" names a ${found.kind}, but the item says ${statedKind}. The array a key was `
        + 'declared in decides its kind, so this is refused rather than resolved — guessing which side is '
        + 'right is exactly the hazard an explicit kind exists to remove.',
    };
  }
  return { id: found.id, kind: found.kind };
}

/**
 * The `$ref` property for a bulk item's published schema — one builder, spread into all four item types.
 *
 * It has to be DECLARED on each of them: a bulk item schema is `additionalProperties: false`, and the MCP
 * dispatcher enforces that before the handler runs. A key declared on three item types and forgotten on the
 * fourth is refused outright on that one while the others accept it, which is the parity failure this
 * codebase has paid for repeatedly — and it is invisible until somebody uses the fourth.
 */
export function refDeclareSchema(kind: string): Record<string, unknown> {
  return {
    type: 'string',
    minLength: 1,
    description:
      `Name this ${kind} so LATER items in the SAME call can point at it, as "$ref:<name>". It is a `
      + 'correlation key, not an id: it is never stored, it means nothing after this call returns, and it '
      + 'does not become the identity of the record — that is still minted here. Use it to write a record and '
      + 'the edges that reach it in one call, which is otherwise impossible because you cannot know the id '
      + 'until the write returns. Every record array is written before any edge, so an edge can reference '
      + 'any record in the payload; a reference can never point FORWARDS within the same array. A name used '
      + 'twice is refused rather than resolved.',
  };
}
