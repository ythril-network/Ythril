/**
 * An id DERIVED from what it names: the same parts always give the same id, and different parts never do.
 *
 * ## Why a module (bundle-30 I13, pre-ship architecture ARCH-1)
 *
 * A fork's id (`forkIdFor`, `sync/upsert-plan.ts`) is derived so a re-sent push upserts the fork it already made; a
 * link violation's id (`sync/linkage-check.ts`) is derived so a dangling end is one record however often it is
 * checked. The fork id was written first, with the injective encoding below and the version bits set on the bytes.
 * The violation id was a second spelling: its parts joined with NUL and the version patched into the hex. A target id
 * is a peer's text, so a crafted `(docId, field, target)` could move a boundary and collide two violations — which is
 * exactly what the fork id's docblock warned a second spelling would allow.
 *
 * ## The forgettable part, kept inside
 *
 * **The encoding.** Each part is length-prefixed (`idPart`), so no text inside a part can stand for a separator; a
 * plain join is the line that looks like it does the same thing. **The namespace**, which keeps two derivations over
 * the same parts apart, is required — an empty one is refused. **The shape**: a v4 UUID with the version and variant
 * bits set on the bytes, because every reader of these ids (link endpoints, the fork-id response, a violation's
 * `_id`) validates that shape.
 *
 * A namespace is fixed for ever once ids derived under it are stored: changing it re-derives every future id.
 */
import { createHash } from 'node:crypto';

/**
 * One part of a derived identity, length-prefixed so no part can forge the separator. Also the encoding of edge
 * identity (`brain/edge-id.ts`), whose ids are v5 rather than v4 and pinned byte-for-byte to older peers.
 */
export const idPart = (s: string): string => `${s.length}:${s}`;

/** The v4-shaped id of `parts` under `namespace` — sha256 over the namespace and the length-prefixed parts. */
export function derivedV4Id(namespace: string, ...parts: string[]): string {
  if (!namespace) throw new Error('a derived id needs a namespace — two derivations without one can share an id');
  const h = createHash('sha256').update(`${namespace}${parts.map(idPart).join('')}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
