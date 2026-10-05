/**
 * Every `description` string a JSON Schema carries, at any depth — the text a caller reads while constructing
 * arguments (`CLAUDE.md`: a schema description is the authoritative reference).
 *
 * ## Why a module
 *
 * Two gates read it — `schema-descriptions-agree-with-help` (no description repeats a corrected claim) and
 * `delete-entity-states-its-cascade` (a cascade tool says what it cascades) — and each walked the schema by hand.
 * The copies differed in what they could miss: one recursed into arrays explicitly and the other reached them only
 * because an array is an object.
 *
 * ## The case a hand-written walk drops
 *
 * A PROPERTY named `description` (`properties: { description: { type: 'string', description: '…' } }`) is an object,
 * not text: it is walked into, so the text describing it is found, and it is never taken for a description itself.
 */
export function schemaDescriptions(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) schemaDescriptions(n, out); return out; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' && typeof v === 'string') out.push(v);
      else schemaDescriptions(v, out);
    }
  }
  return out;
}
