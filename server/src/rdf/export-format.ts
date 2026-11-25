/**
 * Which RDF format an export answers in, under what media type and file name (Q-750, Q-751; owner 2026-11-19; standards review rows 8, 17).
 *
 * ## What it prevents
 *
 * - **Two doors choosing differently.** Both exports and both doors ask {@link chooseRdfFormat}: the `format` parameter wins; with none, the
 *   REST `Accept` header is read with its q-values (RFC 9110 §12.5.1, the most specific range deciding a type's weight); with neither, or a
 *   header that accepts anything (`*\/*`), the scope's default. A media-type parameter (a JSON-LD `profile`) is not weighed.
 * - **A Turtle file that silently drops graphs.** Over a scope of several members only the formats that hold several graphs fit, in the order
 *   TriG, N-Quads, JSON-LD, and an `Accept` that prefers Turtle gets the best format that fits. A 406 (`rdf_format_not_acceptable`, listing
 *   what fits) answers only an explicit `format=turtle` over several members or a header naming nothing that fits.
 * - **A wrong or hand-spelled media type.** Each format's registered type is here once ({@link RDF_MEDIA_TYPES}); the RDF 1.2 version label
 *   joins it as `; version=1.2` only when the writer announces it ({@link rdfContentType}).
 * - **A file name that breaks the header or the reader's disk.** {@link rdfContentDisposition} asks the export family's one rule
 *   (`export/export-file-name.ts`).
 *
 * Pure.
 */
import { RDF_FORMATS, type RdfFormat } from './serialize.js';
import { exportContentDisposition } from '../export/export-file-name.js';
import { acceptRanges, weightOf } from '../http/accept-weigh.js';
import { EXPORT_BAD_REQUEST, EXPORT_NOT_ACCEPTABLE } from '../export/export-statuses.js';

/** Each format's registered media type. */
export const RDF_MEDIA_TYPES: Readonly<Record<RdfFormat, string>> = Object.freeze({
  turtle: 'text/turtle', trig: 'application/trig', nquads: 'application/n-quads', jsonld: 'application/ld+json',
});

/** Each format's registered file extension. */
export const RDF_FILE_EXTENSIONS: Readonly<Record<RdfFormat, string>> = Object.freeze({ turtle: 'ttl', trig: 'trig', nquads: 'nq', jsonld: 'jsonld' });

/** The formats that hold several named graphs, in the order an export prefers them when its scope has several members. */
const SEVERAL_GRAPHS: readonly RdfFormat[] = Object.freeze(['trig', 'nquads', 'jsonld']);

/** The refusal code of a format the scope cannot take or a header naming nothing that fits. */
export const RDF_FORMAT_NOT_ACCEPTABLE = 'rdf_format_not_acceptable';
/** The refusal code of a `format` that is not one this export offers. */
export const RDF_BAD_FORMAT = 'rdf_bad_format';

export type FormatChoice =
  | { ok: true; format: RdfFormat; from: 'parameter' | 'accept' | 'default' }
  | { ok: false; status: typeof EXPORT_BAD_REQUEST | typeof EXPORT_NOT_ACCEPTABLE; code: string; error: string; formats: RdfFormat[] };

/** The formats that fit a scope of `members` member graphs, from `offered`, in preference order. */
export function formatsThatFit(members: number, offered: readonly RdfFormat[] = RDF_FORMATS): RdfFormat[] {
  return members > 1 ? SEVERAL_GRAPHS.filter(f => offered.includes(f)) : [...offered];
}

const NAMES: Readonly<Record<RdfFormat, string>> = { turtle: 'Turtle', trig: 'TriG', nquads: 'N-Quads', jsonld: 'JSON-LD' };
const list = (formats: readonly RdfFormat[]): string => formats.map(f => `${f} (${RDF_MEDIA_TYPES[f]})`).join(', ');

/**
 * The format an export answers in.
 *
 * @param input.format  the `format` parameter as the caller sent it (any value), or `undefined`
 * @param input.accept  the REST `Accept` header, or `undefined` (MCP has none)
 * @param input.members how many member graphs the scope holds (0 and 1 hold one)
 * @param input.offered the formats this export offers (default: all four)
 */
export function chooseRdfFormat(input: { format?: unknown; accept?: string | undefined; members: number; offered?: readonly RdfFormat[] }): FormatChoice {
  const offered = input.offered ?? RDF_FORMATS;
  const fits = formatsThatFit(input.members, offered);
  if (input.format !== undefined) {
    if (typeof input.format !== 'string' || !offered.includes(input.format as RdfFormat)) {
      return { ok: false, status: EXPORT_BAD_REQUEST, code: RDF_BAD_FORMAT, error: `format must be one of ${offered.join(', ')}`, formats: [...fits] };
    }
    const format = input.format as RdfFormat;
    if (!fits.includes(format)) {
      return {
        ok: false, status: EXPORT_NOT_ACCEPTABLE, code: RDF_FORMAT_NOT_ACCEPTABLE, formats: [...fits],
        error: `${NAMES[format]} holds one graph, and this export holds ${input.members}: ask for one of ${list(fits)}`,
      };
    }
    return { ok: true, format, from: 'parameter' };
  }
  const header = (input.accept ?? '').trim();
  const ranges = header === '' ? [] : acceptRanges(header);
  if (ranges.length === 0) return { ok: true, format: fits[0]!, from: 'default' };
  // `fits` is in preference order and `reduce` keeps the first of equal weight, so a tie goes to the scope's own order.
  const weighed = fits.map(f => ({ f, q: weightOf(RDF_MEDIA_TYPES[f], ranges) }));
  const best = weighed.reduce((a, b) => (b.q > a.q ? b : a));
  if (best.q <= 0) {
    return { ok: false, status: EXPORT_NOT_ACCEPTABLE, code: RDF_FORMAT_NOT_ACCEPTABLE, formats: [...fits], error: `Accept names none of the formats this export can answer: ${list(fits)}` };
  }
  const anything = ranges.every(r => r.type === '*' && r.subtype === '*');
  return { ok: true, format: best.f, from: anything ? 'default' : 'accept' };
}

/** The Content-Type of a format: its media type, plus `; version=<v>` when the document announces an RDF version. */
export function rdfContentType(format: RdfFormat, version: string | undefined): string {
  return version === undefined ? RDF_MEDIA_TYPES[format] : `${RDF_MEDIA_TYPES[format]}; version=${version}`;
}

/** `Content-Disposition: attachment` for `name` (a space or view id) with the format's extension, by the export family's one file-name rule. */
export function rdfContentDisposition(name: string, format: RdfFormat, suffix = ''): string {
  return exportContentDisposition(name, RDF_FILE_EXTENSIONS[format], suffix);
}
