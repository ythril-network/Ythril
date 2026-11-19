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
 *   status line; `Ythril-View-Members` for a view and `Ythril-File-Triples: withheld` when file statements were left out, both exposed to
 *   browsers; the budget used (`Ythril-Budget-Chars`, `Ythril-Budget-Bytes` when stated); the left-out values in the HTTP trailers declared
 *   up front (`Trailer:`) on a chunked answer only (`export/export-trailers.ts`: an HTTP/1.0 or a `HEAD` answer cannot carry them, and a
 *   declared one ended the server), beside the closing comment and the report node the document carries; `Retry-After` on a 429 and a 503.
 * - **A `HEAD`** is asked the `GET`'s rights (`export/export-head.ts`) and answered with the `GET`'s headers alone: no slot, no walk, no audit.
 * - **Nothing an answer meets ends the process**: a fault after the status line closes the connection, one before it is the caught answer.
 * - **A reader that stops reading.** The page is written with backpressure; a reader that goes away, or takes nothing for the idle bound
 *   (`rdfExportIdleMs`), ends the response and frees the export slot at once, exactly once.
 * - **An unaudited copy.** The audit rule (`rdf.export`, written when the response finishes or is cut off) takes the act's counts.
 */
import { Router, type Request, type Response } from 'express';
import { requireSpaceAuth } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { viewReadOfRequest } from '../../spaces/read-scope.js';
import {
  rdfExportAct, rdfExportHeadAct, rdfExportIdleMs, rdfExportRate, type RdfExportPage, type RdfExportRefusal, type RdfExportStream,
} from '../../rdf/export-act.js';
import { trailersFor } from '../../export/export-trailers.js';
import { headAskedAsGet } from '../../export/export-head.js';
import { answeredUnknownSpace } from '../write-target-answer.js';
import { sendCaughtFailure } from '../send-failure.js';
import type { TokenRights } from '../../config/rights-shape.js';
import { EXPORT_OK } from '../../export/export-statuses.js';
import { schemaFingerprintOf } from '../../spaces/schema-stamp.js';

export const rdfExportRouter = Router();

/** The headers a browser may read of an export answer. */
const EXPOSED = 'Link, Content-Disposition, Ythril-View-Members, Ythril-File-Triples, Ythril-Budget-Chars, Ythril-Budget-Bytes';

const ROUTE = 'GET /api/brain/spaces/:spaceId/export/rdf';

// GET (and HEAD) /api/brain/spaces/:spaceId/export/rdf - the records of a space or of the caller's own view, as Turtle, TriG, N-Quads or JSON-LD.
// A HEAD is asked the GET's rights (`headAskedAsGet`) and answered with the GET's headers alone: no slot, no walk, no audit row.
rdfExportRouter.get('/spaces/:spaceId/export/rdf', globalRateLimit, headAskedAsGet(requireSpaceAuth), async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;
  const token = req.authToken as { id?: string; admin?: boolean; rights?: TokenRights | null } | undefined;
  res.setHeader('Vary', 'Accept');
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
  if (head.viewMembers) res.setHeader('Ythril-View-Members', head.viewMembers.map(encodeURIComponent).join(', '));
  if (head.fileTriplesWithheld) res.setHeader('Ythril-File-Triples', 'withheld');
  res.end();
}

/** The parameters that ask for one bounded page instead of the whole scope. */
const PAGE_PARAMETERS = ['limit', 'after', 'maxChars', 'maxBytes', 'maxTokens'] as const;

/**
 * The whole scope, a store page per chunk, with backpressure: the slot is released exactly once, when the stream ends, when the reader goes
 * or when it takes nothing for the idle bound (then the response is cut: its chunked body lacks the final chunk, RFC 9112 §7.1, which every
 * HTTP client reports as a broken transfer). A store that fails before the first byte is the clean 503; after it, the document ends in the
 * act's incomplete form and the trailer `Ythril-Export-Complete: false` says so. The audit row is kept current and written when it ends.
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
  // Declared only on a chunked answer: an HTTP/1.0 reader reads the same facts in the document's ending.
  const trailers = trailersFor(req, res, STREAM_TRAILERS);
  if (stream.viewMembers) res.setHeader('Ythril-View-Members', stream.viewMembers.map(encodeURIComponent).join(', '));
  if (stream.fileTriplesWithheld) res.setHeader('Ythril-File-Triples', 'withheld');
  const started = Date.now();
  let sent = 0;
  try {
    let chunk: string | undefined = begun.first;
    while (chunk !== undefined) {
      if (chunk !== '' && !res.write(chunk) && !(await drainedWithin(res, rdfExportIdleMs()))) {
        res.destroy();
        return;
      }
      sent += Buffer.byteLength(chunk, 'utf8');
      audit();
      // Too slow on average once the grace is over (a trickling reader): the incomplete ending is written while the socket still takes it,
      // so the reader is told, and the slot is freed.
      const { graceMs, minBytesPerSecond } = rdfExportRate();
      const elapsed = Math.max(Date.now() - started, 1);
      if (elapsed >= graceMs && (sent * MS_PER_SECOND) / elapsed < minBytesPerSecond) {
        await rest.return();
        res.write(stream.abandon(`the reader took the export too slowly (under ${minBytesPerSecond} bytes a second after ${graceMs} ms)`));
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

const MS_PER_SECOND = 1_000;

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
  if (page.viewMembers) res.setHeader('Ythril-View-Members', page.viewMembers.map(encodeURIComponent).join(', '));
  if (summary.fileTriplesWithheld) res.setHeader('Ythril-File-Triples', 'withheld');
  try {
    for (const chunk of page.chunks) {
      if (chunk === '') continue;
      if (res.write(chunk)) continue;
      if (!(await drainedWithin(res, rdfExportIdleMs()))) {
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

/** Whether `res` drained before `ms` passed and before it closed; every listener and the timer are removed either way. */
function drainedWithin(res: Response, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    const settle = (drained: boolean): void => {
      clearTimeout(timer);
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(drained);
    };
    const onDrain = (): void => settle(true);
    const onClose = (): void => settle(false);
    const timer = setTimeout(() => settle(false), ms);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}
