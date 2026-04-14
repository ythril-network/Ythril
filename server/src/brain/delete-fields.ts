/**
 * deleteFields utility — validates and applies dot-notation path deletions
 * to documents during update operations.
 *
 * Used by entity, edge, and memory update endpoints to support the
 * `deleteFields` array parameter.
 */

// ── System fields that cannot be deleted ────────────────────────────────────

const SYSTEM_FIELDS = new Set([
  'id', '_id', 'name', 'type', 'spaceId', 'createdAt', 'updatedAt',
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

    if (segments.length === 1) {
      // Top-level deletion — skip dangerous proto keys
      if (firstSeg !== '__proto__' && firstSeg !== 'constructor' && firstSeg !== 'prototype') {
        if (Object.prototype.hasOwnProperty.call(obj, firstSeg)) {
          delete obj[firstSeg];
        }
      }
    } else {
      // Nested deletion — walk to the parent, then delete the leaf
      let current: unknown = obj;
      let safe = true;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i] ?? '';
        if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') { safe = false; break; }
        if (current == null || typeof current !== 'object' || Array.isArray(current)) {
          current = undefined;
          break;
        }
        current = (current as Record<string, unknown>)[seg];
      }
      const leafSeg = segments[segments.length - 1] ?? '';
      if (safe && leafSeg !== '__proto__' && leafSeg !== 'constructor' && leafSeg !== 'prototype'
          && current != null && typeof current === 'object' && !Array.isArray(current)) {
        if (Object.prototype.hasOwnProperty.call(current, leafSeg)) {
          delete (current as Record<string, unknown>)[leafSeg];
        }
      }
    }
  }

  return affected;
}
