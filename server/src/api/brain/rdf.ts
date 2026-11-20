/**
 * The records export as RDF over REST: `GET /api/brain/spaces/:spaceId/export/rdf[?format=&edgeDetails=&after=&limit=&maxChars=&maxBytes=&maxTokens=]`,
 * the route a reader of MCP `export_rdf` looks for (owner, 2026-11-19: the first of an `export_*` family, so later formats sit beside it at
 * `.../export/<format>`). A space, or the caller's own personal view (one named graph per member it reads).
 *
 * ## What it prevents
 *
 * With no `limit`, `after` or size ceiling the answer is the WHOLE scope, streamed a store page at a time (`sendStream`): a standard RDF
 * tool follows no `Link`, so a first page handed to it would be a silently short export. Naming any of them asks for one bounded page
 * (`sendPage`), as MCP `export_rdf` always answers.
 *
 * The page, its refusals and every value it answers are `rdf/export-act.ts`'s, the act MCP `export_rdf` runs; this door only puts them on
 * HTTP, and holds the parts only HTTP has:
 *
 * - **Negotiation said out loud**: the `Accept` header is handed to the act (the `format` parameter wins), and every answer says
 *   `Vary: Accept`.
 * - **The page's facts where a client reads them**: `Link: <...after=X>; rel="next"` (RFC 8288) while records are left, known before the
 *   status line; `Ythril-View-Members` for a view (and `Ythril-View-Members-Without-Rdf`, `Ythril-View-Members-In-Conflict` for the read
 *   members it left out) and `Ythril-File-Triples: withheld` when file statements were left out, all exposed to
 *   browsers; the budget used (`Ythril-Budget-Chars`, `Ythril-Budget-Bytes` when stated); the left-out values in the HTTP trailers declared
 *   up front (`Trailer:`) on a chunked answer only (`export/export-trailers.ts`: an HTTP/1.0 or a `HEAD` answer cannot carry them, and a
 *   declared one ended the server), beside the closing comment and the report node the document carries; `Retry-After` on a 429 and a 503.
 * - **A `HEAD`** is judged and audited as the `GET` it mirrors by the product's rule (`http/governed-method.ts`: its rights row, and an
 *   `rdf.export` row with `method: 'HEAD'` that counts nothing as sent), and answered with the `GET`'s headers alone: no slot, no walk.
 * - **Nothing an answer meets ends the process**: a fault after the status line closes the connection, one before it is the caught answer.
 * - **A reader that stops reading.** The answer is written with backpressure; a reader that goes away frees the export slot at once,
 *   exactly once. A page whose reader takes nothing for the idle bound (`rdfExportIdleMs`) is cut; a whole export whose reader is under the
 *   rate or takes nothing for the idle bound is told (`export/export-reader-pace.ts`).
 * - **An unaudited copy.** The audit rule (`rdf.export`, written when the response finishes or is cut off) takes the act's counts.
 */
import { Router, type Request, type Response } from 'express';
import { requireSpaceAuth } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { viewReadOfRequest } from '../../spaces/read-scope.js';
import {
  rdfExportAct, rdfExportEndingWaitMs, rdfExportHeadAct, rdfExportIdleMs, rdfExportRate, type MembersLeftOut, type RdfExportPage, type RdfExportRefusal,
  type RdfExportStream,
} from '../../rdf/export-act.js';
import { trailersFor } from '../../export/export-trailers.js';
import { closeUnlessFinished, pacedWriter, type ReaderPace } from '../../export/export-reader-pace.js';
import { answeredUnknownSpace } from '../write-target-answer.js';
import { sendCaughtFailure } from '../send-failure.js';
import type { TokenRights } from '../../config/rights-shape.js';
import { EXPORT_OK, EXPORT_VARY } from '../../export/export-statuses.js';
import { schemaFingerprintOf } from '../../spaces/schema-stamp.js';

export const rdfExportRouter = Router();

/** The headers a browser may read of an export answer. */
const EXPOSED = 'Link, Content-Disposition, Ythril-View-Members, Ythril-View-Members-Without-Rdf, Ythril-View-Members-In-Conflict, '
  + 'Ythril-File-Triples, Ythril-Budget-Chars, Ythril-Budget-Bytes';

/**
 * The view's members on the answer: those exported (`Ythril-View-Members`), and those the caller reads that were left out, RDF off or names
 * not settled (bundle-269 drive, finding 11: only MCP named them). Each a member the guard accepted for the caller, percent-encoded (a
 * header value is Latin-1).
 */
function setViewHeaders(res: Response, viewMembers: readonly string[] | undefined, leftOut: MembersLeftOut): void {
  const list = (ids: readonly string[]): string => ids.map(encodeURIComponent).join(', ');
  if (viewMembers) res.setHeader('Ythril-View-Members', list(viewMembers));
  if (leftOut.withoutRdf.length > 0) res.setHeader('Ythril-View-Members-Without-Rdf', list(leftOut.withoutRdf));
  if (leftOut.inConflict.length > 0) res.setHeader('Ythril-View-Members-In-Conflict', list(leftOut.inConflict));
}

const ROUTE = 'GET /api/brain/spaces/:spaceId/export/rdf';

// GET (and HEAD) /api/brain/spaces/:spaceId/export/rdf - the records of a space or of the caller's own view, as Turtle, TriG, N-Quads or JSON-LD.
// A HEAD is judged and audited as this GET (`http/governed-method.ts`) and answered with the GET's headers alone: no slot, no walk.
rdfExportRouter.get('/spaces/:spaceId/export/rdf', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;
  const token = req.authToken as { id?: string; admin?: boolean; rights?: TokenRights | null } | undefined;
  // Alike for all four formats: the compression layer adds Accept-Encoding only for the types it compresses (Turtle, JSON-LD), so a cache
  // would key TriG and N-Quads differently (bundle-269 drive, finding 12).
  res.setHeader('Vary', EXPORT_VARY);
  res.setHeader('Access-Control-Expose-Headers', EXPOSED);
  const input = {
    spaceId, viewMembers: viewReadOfRequest(req, spaceId), accept: req.headers['accept'],
    params: {
      format: req.query['format'], edgeDetails: req.query['edgeDetails'], after: req.query['after'], limit: req.query['limit'],
      maxChars: req.query['maxChars'], maxBytes: req.query['maxBytes'], maxTokens: req.query['maxTokens'],
    },
    caller: token, callerKey: token?.id ?? req.ip ?? '', transport: 'rest' as const, fingerprintOf: schemaFingerprintOf,
  };
  if (req.method === 'HEAD') {
    answerHead(res, input);
    return;
  }
  let outcome;
  try {
    outcome = await rdfExportAct({
      ...input,
      // A caller that names no page (no limit, after or size ceiling) gets the whole scope in this one answer: a standard RDF tool follows
      // no Link, and a first page handed to it as the answer would be a silently short export.
      whole: PAGE_PARAMETERS.every(k => req.query[k] === undefined),
    });
  } catch (err) {
    sendCaughtFailure(res, ROUTE, err);
    return;
  }
  if ('error' in outcome) {
    sendRefusal(res, outcome);
    return;
  }
  try {
    if (outcome.kind === 'stream') await sendStream(req, res, outcome);
    else await sendPage(req, res, outcome);
  } catch (err) {
    // Nothing an answer meets may end the process: before the status line it is the caught failure's answer; after it, the connection is
    // closed, so the reader sees a broken transfer and never a short file that looks whole.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // A JSON answer is not chunked: a declared trailer on it would throw again while its headers are written.
    res.removeHeader('Trailer');
    sendCaughtFailure(res, ROUTE, err);
  }
});

/** A refusal of the act, with `Retry-After` on a 429 and a 503. */
function sendRefusal(res: Response, r: RdfExportRefusal): void {
  if (r.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(r.retryAfterSeconds));
  res.status(r.status).json({ error: r.error, code: r.code, ...(r.detail ?? {}) });
}

/** The answer to a HEAD: what a GET would answer, by the same rules and refusals, without content (RFC 9110 §9.3.2). */
function answerHead(res: Response, input: Parameters<typeof rdfExportHeadAct>[0]): void {
  const head = rdfExportHeadAct(input);
  if ('error' in head) {
    sendRefusal(res, head);
    return;
  }
  res.status(EXPORT_OK);
  res.setHeader('Content-Type', head.contentType);
  res.setHeader('Content-Disposition', head.disposition);
  setViewHeaders(res, head.viewMembers, head.membersLeftOut);
  if (head.fileTriplesWithheld) res.setHeader('Ythril-File-Triples', 'withheld');
  res.end();
}

/** The parameters that ask for one bounded page instead of the whole scope. */
const PAGE_PARAMETERS = ['limit', 'after', 'maxChars', 'maxBytes', 'maxTokens'] as const;

/**
 * The whole scope, a store page per chunk, written at the reader's pace (`export/export-reader-pace.ts`): the slot is released exactly once,
 * when the stream ends, when the reader goes, or when it is judged too slow or takes nothing for the idle bound (then the incomplete ending
 * is written behind what its connection holds, and the connection is given `rdfExportEndingWaitMs` to hand it to the operating system; if
 * it has not, the response is cut: its chunked body lacks the final chunk, RFC 9112 §7.1, a broken transfer to every HTTP client). A store that
 * fails before the first byte is the clean 503; after it, the document ends in the act's incomplete form and the trailer
 * `Ythril-Export-Complete: false` says so. The audit row is kept current and written when it ends.
 */
async function sendStream(req: Request, res: Response, stream: RdfExportStream): Promise<void> {
  const begun = await stream.begin();
  if ('error' in begun) {
    sendRefusal(res, begun);
    return;
  }
  const rest = stream.rest();
  let released = false;
  const release = (): void => { if (!released) { released = true; stream.slot.release(); } };
  res.once('close', () => { release(); void rest.return(); });
  const audit = (): void => { req.auditChangesExplicit = stream.state().auditChanges; };
  audit();
  res.status(EXPORT_OK);
  res.setHeader('Content-Type', stream.contentType);
  res.setHeader('Content-Disposition', stream.disposition);
  // Never compressed (lens finding 2): the rate asked of the reader is bytes of the export, and a compressor would be measured instead (a
  // well-compressible export taken at a fraction of its size), would hold the ending back in its own buffer, and would hide the slices the
  // pace is judged on. The guide states the rate in the bytes sent; sent uncompressed they are the export's own.
  res.setHeader('X-No-Compression', '1');
  // Declared only on a chunked answer: an HTTP/1.0 reader reads the same facts in the document's ending.
  const trailers = trailersFor(req, res, STREAM_TRAILERS);
  setViewHeaders(res, stream.viewMembers, stream.membersLeftOut);
  if (stream.fileTriplesWithheld) res.setHeader('Ythril-File-Triples', 'withheld');
  const pace = (): ReaderPace => ({ ...rdfExportRate(), idleMs: rdfExportIdleMs() });
  const writer = pacedWriter(res, pace);
  try {
    let chunk: string | undefined = begun.first;
    while (chunk !== undefined) {
      const how = chunk === '' ? 'taken' : await writer.deliver(chunk);
      audit();
      if (how === 'gone') return;
      if (how === 'slow' || how === 'idle') {
        // Told, not cut off: the ending follows what the connection holds, the slot is free now, and the connection is given the ending
        // wait to hand the rest to the operating system (a reader that took nothing in the idle bound took less than the rate asks).
        await rest.return();
        const { windowMs, minBytesPerSecond, idleMs } = pace();
        const why = how === 'slow' ? `under ${minBytesPerSecond} bytes a second over ${windowMs} ms of waiting on it` : `nothing for ${idleMs} ms`;
        // The cut falls inside a record (a slice is not a line): the ending starts a line of its own, so a line-wise reader still reads it.
        res.write(`\n${stream.abandon(`the reader took the export too slowly (${why})`)}`);
        release();
        closeUnlessFinished(res, rdfExportEndingWaitMs());
        break;
      }
      const next = await rest.next();
      chunk = next.done ? undefined : next.value;
    }
    const state = stream.state();
    audit();
    trailers.send({
      'Ythril-Export-Complete': String(state.complete),
      'Ythril-Skipped-Values': String(state.skippedCount),
      'Ythril-Skipped-Records': state.skippedRecords.map(encodeURIComponent).join(', '),
    });
    res.end();
  } finally {
    if (res.writableEnded || res.destroyed) release();
  }
}

/** The trailers a whole export declares up front. */
const STREAM_TRAILERS = ['Ythril-Export-Complete', 'Ythril-Skipped-Values', 'Ythril-Skipped-Records'] as const;

/** The link to the next page: this request's own path and query, with the chosen format and the next cursor. */
function nextLink(req: Request, format: string, nextAfter: string): string {
  const url = new URL(req.originalUrl, 'http://link.invalid');
  url.searchParams.set('format', format);
  url.searchParams.set('after', nextAfter);
  return `<${url.pathname}${url.search}>; rel="next"`;
}

/** Write `page` with backpressure; release its slot exactly once, when it is sent, when the reader goes, or when it idles past the bound. */
async function sendPage(req: Request, res: Response, page: RdfExportPage): Promise<void> {
  const { summary } = page;
  let released = false;
  const release = (): void => { if (!released) { released = true; page.slot.release(); } };
  res.once('close', release);
  req.auditChangesExplicit = page.auditChanges;
  res.status(EXPORT_OK);
  res.setHeader('Content-Type', page.contentType);
  res.setHeader('Content-Disposition', page.disposition);
  // A header value is Latin-1: the record ids are percent-encoded, as the view members are.
  const values = {
    'Ythril-Skipped-Values': String(summary.skippedValues.count),
    'Ythril-Skipped-Records': page.skippedRecords.map(encodeURIComponent).join(', '),
  };
  const trailers = trailersFor(req, res, Object.keys(values));
  res.setHeader('Ythril-Budget-Chars', String(summary.budgetChars));
  if (summary.budgetBytes !== null) res.setHeader('Ythril-Budget-Bytes', String(summary.budgetBytes));
  if (summary.nextAfter) res.setHeader('Link', nextLink(req, summary.format, summary.nextAfter));
  setViewHeaders(res, page.viewMembers, { withoutRdf: summary.membersWithoutRdf ?? [], inConflict: summary.membersInConflict ?? [] });
  if (summary.fileTriplesWithheld) res.setHeader('Ythril-File-Triples', 'withheld');
  // A page is bounded (at most the largest budget) and built before its first byte: only the idle bound applies to its reader, no rate.
  const writer = pacedWriter(res, () => ({ windowMs: rdfExportIdleMs(), minBytesPerSecond: 0, idleMs: rdfExportIdleMs() }));
  try {
    for (const chunk of page.chunks) {
      if (chunk === '') continue;
      const how = await writer.deliver(chunk);
      if (how === 'gone') return;
      if (how !== 'taken') {
        res.destroy();
        return;
      }
    }
    trailers.send(values);
    res.end();
  } finally {
    if (res.writableEnded || res.destroyed) release();
  }
}
