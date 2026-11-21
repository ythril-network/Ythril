/**
 * The front half of every door that reads an RDF document: which format it is in, whether its encoding is one we read, the parameters' REST
 * spellings, the MCP tool's inline document, and the answer to a body that could not be read (bundle-270, Q-754, design revision 2).
 *
 * ## What it prevents
 *
 * The data import (`spaces/rdf-import-act.ts`) wrote all of it for itself, and the schema-from-RDF door needs the same: a second copy of the
 * media-type table reading, the encoding check and the refusal mapping would answer one malformed file with two codes or two sentences once
 * either copy moved. Each door now asks this module, and says only what it did not do (`what`: "nothing was imported"), so a refusal keeps the
 * door's own consequence while its code, status and place come from here.
 *
 * ## What it does not decide
 *
 * The bounds a door reads under (the import's spool bounds, a door's own quad cap) and every refusal about the space are the door's: this
 * module knows the document, never the store.
 */
import { RDF_FORMATS, type RdfFormat } from './serialize.js';
import { RDF_MEDIA_TYPES } from './export-format.js';
import { RdfParseError } from './parse.js';
import { BodyTooLarge, UploadStalled } from './import-upload.js';

/** The HTTP statuses of a document refusal, each named. */
const HTTP = { BAD_REQUEST: 400, TOO_LARGE: 413, UNSUPPORTED_MEDIA: 415 } as const;

/** A format that is not one the reader takes (415), named neither by `format` nor by a known `Content-Type`. */
export const RDF_UNSUPPORTED_FORMAT = 'rdf_unsupported_format';
/** A `Content-Encoding` other than none or gzip (415). */
export const RDF_UNSUPPORTED_ENCODING = 'rdf_unsupported_encoding';
/** An upload that sent nothing for the idle bound (400; the REST door closes the connection after the answer). The wire code predates the module. */
export const RDF_UPLOAD_STALLED = 'rdf_import_upload_stalled';
/** A body over the byte bound, or a file over a bound of the reader (413). */
export const RDF_BOUND_EXCEEDED = 'rdf_bound_exceeded';
/** The name of the byte bound a body over it is answered with. */
export const RDF_BODY_BOUND = 'importBodyMaxBytes';

/** A refusal of the document: its status, our sentence, its code, and what more a caller reads. The shape the import's refusals have. */
export interface RdfDocumentRefusal { kind: 'refused'; status: number; error: string; code: string; detail?: Record<string, unknown> }

const refusal = (status: number, code: string, error: string, detail?: Record<string, unknown>): RdfDocumentRefusal =>
  ({ kind: 'refused', status, code, error, ...(detail ? { detail } : {}) });

/** The format a media type names (parameters such as `; version=1.2` and `; charset` aside), or undefined. */
function formatOfMediaType(contentType: string | undefined): RdfFormat | undefined {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return RDF_FORMATS.find(f => RDF_MEDIA_TYPES[f] === type);
}

/**
 * The document's format: the `format` parameter when given, else the one `contentType` names; then its encoding, plain or gzip. Answers the
 * format, or the refusal (415). `reader` names who reads the document in the refusal ("the import").
 */
export function rdfFormatOf(
  format: RdfFormat | undefined, contentType: string | undefined, contentEncoding: string | undefined, reader: string,
): { ok: true; format: RdfFormat } | { ok: false; refusal: RdfDocumentRefusal } {
  const read = format ?? formatOfMediaType(contentType);
  if (!read) {
    return { ok: false, refusal: refusal(HTTP.UNSUPPORTED_MEDIA, RDF_UNSUPPORTED_FORMAT, `The document's format is not one ${reader} reads: send ${RDF_FORMATS.map(f => RDF_MEDIA_TYPES[f]).join(', ')}, or name it in format`) };
  }
  const encoding = (contentEncoding ?? 'identity').trim().toLowerCase();
  if (encoding !== 'identity' && encoding !== 'gzip' && encoding !== '') {
    return { ok: false, refusal: refusal(HTTP.UNSUPPORTED_MEDIA, RDF_UNSUPPORTED_ENCODING, 'The document is sent plain or gzipped (Content-Encoding: gzip); no other encoding is read') };
  }
  return { ok: true, format: read };
}

/**
 * The answer to a failure of reading the document that is the document's (a stalled upload, a body over the byte bound, a file the reader
 * refuses), or null for any other failure, which the door throws on. `what` is what the door did not do because of it ("nothing was imported").
 */
export function rdfDocumentRefusalOf(err: unknown, format: RdfFormat, what: string): RdfDocumentRefusal | null {
  if (err instanceof UploadStalled) {
    return refusal(HTTP.BAD_REQUEST, RDF_UPLOAD_STALLED, `The upload sent nothing for ${Math.round(err.idleMs / 1000)} seconds and was cut off; ${what}: send the file again, without pauses`);
  }
  if (err instanceof BodyTooLarge) {
    return refusal(HTTP.TOO_LARGE, RDF_BOUND_EXCEEDED, `The body is over the import body bound (${err.limit} bytes); ${what}`, { bound: RDF_BODY_BOUND, limit: err.limit });
  }
  if (err instanceof RdfParseError) {
    if (err.code === RDF_BOUND_EXCEEDED) {
      return refusal(HTTP.TOO_LARGE, err.code, `The file is over the reader's bound ${err.bound ?? ''}; ${what}`, { ...(err.bound ? { bound: err.bound } : {}), ...(err.place ? { place: err.place } : {}) });
    }
    const where = err.place ? ` at line ${err.place.line}${err.place.column === undefined ? '' : `, column ${err.place.column}`}` : '';
    const why = err.code === 'rdf_malformed' ? `is not well-formed ${format}${where}` : `cannot be read${where} (${err.code})`;
    return refusal(err.code === RDF_UNSUPPORTED_FORMAT ? HTTP.UNSUPPORTED_MEDIA : HTTP.BAD_REQUEST, err.code, `The file ${why}; ${what}`, err.place ? { place: err.place } : undefined);
  }
  return null;
}

/** A REST query's boolean as the parameters take it: `'true'` and `'false'` read as booleans, anything else passed on for the schema to judge. */
export const rdfParamBool = (v: unknown): unknown => (v === 'true' ? true : v === 'false' ? false : v);

/** A REST query's repeatable value as the parameters take it: one value or several, as a list; absent stays absent. */
export const rdfParamList = (v: unknown): unknown => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

/** An MCP tool's inline document as the body a door reads (the MCP body limit bounded it before it reached the tool). */
export async function* inlineRdfDocument(text: string): AsyncGenerator<string, void, undefined> {
  yield text;
}
