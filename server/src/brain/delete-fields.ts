/**
 * deleteFields utility — validates and applies dot-notation path deletions
 * to documents during update operations.
 *
 * Used by entity, edge, and fact update endpoints to support the
 * `deleteFields` array parameter.
 */

// ── System fields that cannot be deleted ────────────────────────────────────

const SYSTEM_FIELDS = new Set([
  'id', '_id', 'name', 'type', 'spaceId', 'createdAt', 'updatedAt',
  // Chrono's required fields, added with `deleteFields` support for chrono (X-4). They are here rather than
  // simply omitted from the writer's unset list because the two behave differently where it matters: a path
  // the writer ignores is accepted and silently does nothing, while a path listed here is REFUSED with a
  // message naming it. "Nothing happened and nobody said so" is the failure this whole file exists to avoid.
  //
  // Harmless on the other three record types: the check is against the TOP-LEVEL segment only, so
  // `properties.title` is still deletable everywhere, and no entity, edge or fact has a bare `title` or
  // `startsAt` to remove.
  'title', 'startsAt', 'status',
]);

/** Dangerous prototype keys that must never be traversed or deleted. */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate a `deleteFields` array from a request body.
 *
 * Returns `{ ok: true }` if valid, or `{ ok: false, error }` with a
 * user-facing error message if invalid.
 */
export function validateDeleteFields(
  deleteFields: unknown,
): { ok: true } | { ok: false; error: string } {
  if (deleteFields === undefined || deleteFields === null) return { ok: true };

  if (!Array.isArray(deleteFields)) {
    return { ok: false, error: '`deleteFields` must be an array of strings' };
  }

  for (const p of deleteFields) {
    if (typeof p !== 'string' || !p.trim()) {
      return { ok: false, error: '`deleteFields` entries must be non-empty strings' };
    }
    const segments = p.split('.');
    // Reject empty segments from consecutive dots (e.g. "properties..key")
    if (segments.some(s => s === '')) {
      return { ok: false, error: `Invalid deleteFields path '${p}': contains empty segments` };
    }
    // Reject any segment that could cause prototype pollution
    for (const seg of segments) {
      if (PROTO_KEYS.has(seg)) {
        return { ok: false, error: `Invalid deleteFields path segment '${seg}'` };
      }
    }
    // The top-level segment is what matters for system field protection
    const topLevel = segments[0] ?? '';
    if (SYSTEM_FIELDS.has(topLevel)) {
      return {
        ok: false,
        error: `Cannot delete system field '${topLevel}' via deleteFields`,
      };
    }
  }

  return { ok: true };
}

/**
 * Apply `deleteFields` paths to a plain object, mutating it in place.
 *
 * Each path is a dot-notation string (e.g. `"properties.oldKey"`).
 * - `"properties.oldKey"` deletes `obj.properties.oldKey`.
 * - `"description"` deletes `obj.description`.
 * - `"properties.items.*.stale"` deletes `stale` from every object inside
 *   the `items` array (wildcard `*` iterates over array elements).
 * - Paths targeting non-existent keys are silently ignored (no-op).
 *
 * Returns the set of top-level keys that were affected (useful for
 * determining whether re-embedding is needed).
 */
export function applyDeleteFields(
  obj: Record<string, unknown>,
  deleteFields: string[],
): Set<string> {
  const affected = new Set<string>();

  for (const path of deleteFields) {
    const segments = path.split('.');
    if (segments.length === 0) continue;

    const firstSeg = segments[0] ?? '';
    affected.add(firstSeg);

    applyDeletePath(obj, segments, 0);
  }

  return affected;
}

/**
 * Write `field` into `$set` — unless the same update is REMOVING it, in which case `$unset` wins.
 *
 * ## Why this is a function and not four lines at each call site
 *
 * It was four lines at each call site, and seven of the eight were wrong in the same way. `entities.ts` and
 * `edges.ts` each guarded with
 *
 *     if (updates.tags !== undefined || (deleteFieldsPaths && !$unset['tags'])) $set['tags'] = newTags;
 *
 * and `$unset` entries are written as `$unset['tags'] = ''`, which is Mongo's convention and also FALSY. So
 * `!$unset['tags']` was always true, `$set['tags']` was always written, and the update reached Mongo naming one
 * path in both `$set` and `$unset`. Mongo rejects that outright — *"Updating the path 'tags' would create a
 * conflict at 'tags'"* — so `deleteFields` on a whole field could never work on either record type. Reported by
 * the canary operator 2026-08-12 against `deleteFields: ["tags"]`, which returned a 500.
 *
 * **Nested paths were unaffected**, which is why it survived: deleting `properties.region` leaves `properties`
 * present, so no `$unset` is written for it and the guard never mattered. Every documented example used a nested
 * path.
 *
 * ## The precedence, and why `$unset` wins
 *
 * `deleteFields` is documented as applying AFTER the normal merge, so a request that both updates a field and
 * deletes it has asked for the deletion last. The `in` test is what makes that expressible at all: with the old
 * guard, that combination did not resolve one way or the other — it produced a rejected write.
 *
 * `fact.ts` had this right by a different route (it writes the `$set` first, then `delete $set[field]` beside the
 * `$unset`), and both broken files used the correct idiom a few lines away for a different field: `'_expireAt' in
 * $unset`. The test that was missing is the one that drives the real write path; `delete-fields.test.js` covered
 * the pure helper above, which was never the broken part.
 */
export function setUnlessDeleted(
  $set: Record<string, unknown>,
  $unset: Record<string, unknown>,
  field: string,
  value: unknown,
  requested: boolean,
): void {
  if (field in $unset) {
    // Defensive: the caller may have written the `$set` before deciding on the `$unset`, as `fact.ts` does.
    delete $set[field];
    return;
  }
  if (requested) $set[field] = value;
}

/**
 * Recursively apply a single deleteFields path starting at `depth`.
 * Handles `*` wildcard segments by iterating over array elements.
 */
function applyDeletePath(
  current: unknown,
  segments: string[],
  depth: number,
): void {
  if (current == null || typeof current !== 'object') return;

  const seg = segments[depth] ?? '';
  if (PROTO_KEYS.has(seg)) return;

  const isLeaf = depth === segments.length - 1;

  if (seg === '*') {
    // Wildcard: current must be an array — apply remaining path to each element
    if (!Array.isArray(current)) return;
    if (isLeaf) return; // `*` as the final segment is a no-op (can't delete array elements by wildcard)
    for (const item of current) {
      applyDeletePath(item, segments, depth + 1);
    }
    return;
  }

  if (Array.isArray(current)) {
    // Non-wildcard segment on an array — stop traversal
    return;
  }

  const obj = current as Record<string, unknown>;

  if (isLeaf) {
    if (Object.prototype.hasOwnProperty.call(obj, seg)) {
      delete obj[seg];
    }
    return;
  }

  // Continue traversal
  applyDeletePath(obj[seg], segments, depth + 1);
}
