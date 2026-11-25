/**
 * The weight an `Accept` header gives each media type a door can answer in (RFC 9110 §12.5.1), and the one it prefers: the one weigher
 * the RDF export's format chooser (`rdf/export-format.ts`) and the SPARQL endpoint's result chooser (`rdf/sparql-answer.ts`) ask
 * (bundle-271, Q-757, design r2 R3.2: extracted from the export's chooser, the second site).
 *
 * ## What it prevents
 *
 * - **Two doors reading one header differently.** The most specific matching range decides a type's weight (`text/csv;q=0` beats `text/*`),
 *   a malformed range is skipped, a malformed `q` is weight 1; a media-type parameter (a JSON-LD `profile`) is not weighed.
 * - **A tie decided by chance.** {@link preferredByAccept} keeps the first of equal weight in the order the door offers its types.
 *
 * Pure.
 */

/** One range of an Accept header: `type/subtype` (either may be `*`) and its weight. */
export interface AcceptRange { type: string; subtype: string; q: number }

/** The ranges of an Accept header; a malformed range is skipped, a malformed q is weight 1 (the header's default). */
export function acceptRanges(header: string): AcceptRange[] {
  const out: AcceptRange[] = [];
  for (const part of header.split(',')) {
    const [range, ...params] = part.split(';').map(s => s.trim());
    const m = /^([A-Za-z0-9!#$&^_.+*-]+)\/([A-Za-z0-9!#$&^_.+*-]+)$/.exec(range ?? '');
    if (!m) continue;
    let q = 1;
    for (const p of params) {
      const qm = /^q\s*=\s*([0-9](?:\.[0-9]{0,3})?)$/i.exec(p);
      if (qm) q = Math.min(1, Number(qm[1]));
    }
    out.push({ type: m[1]!.toLowerCase(), subtype: m[2]!.toLowerCase(), q });
  }
  return out;
}

/** How specifically a range names a media type (RFC 9110 §12.5.1): the more specific range decides the type's weight. */
const SPECIFICITY = Object.freeze({ exact: 2, subtypes: 1, anything: 0, none: -1 });

/** The weight `ranges` give `mediaType`: the most specific matching range decides; none matching is 0. */
export function weightOf(mediaType: string, ranges: readonly AcceptRange[]): number {
  const [type, subtype] = mediaType.split('/') as [string, string];
  let best: { specificity: number; q: number } | null = null;
  for (const r of ranges) {
    const specificity = r.type === type && r.subtype === subtype ? SPECIFICITY.exact : r.type === type && r.subtype === '*' ? SPECIFICITY.subtypes
      : r.type === '*' && r.subtype === '*' ? SPECIFICITY.anything : SPECIFICITY.none;
    if (specificity < 0) continue;
    if (best === null || specificity > best.specificity) best = { specificity, q: r.q };
  }
  return best?.q ?? 0;
}

/**
 * Which of `offered` (media types, in the door's preference order) `header` prefers: `default` when the header names no range (absent,
 * empty or all malformed), `null` when it gives every offered type weight 0, else the heaviest (`fromAnything` when only `*\/*` named it).
 */
export function preferredByAccept<T extends string>(header: string | undefined, offered: readonly T[]):
  { kind: 'default' } | { kind: 'none' } | { kind: 'chosen'; mediaType: T; fromAnything: boolean } {
  const h = (header ?? '').trim();
  const ranges = h === '' ? [] : acceptRanges(h);
  if (ranges.length === 0) return { kind: 'default' };
  const weighed = offered.map(mediaType => ({ mediaType, q: weightOf(mediaType, ranges) }));
  const best = weighed.reduce((a, b) => (b.q > a.q ? b : a));
  if (best.q <= 0) return { kind: 'none' };
  return { kind: 'chosen', mediaType: best.mediaType, fromAnything: ranges.every(r => r.type === '*' && r.subtype === '*') };
}
