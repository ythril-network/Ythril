/**
 * How an RDF REST door (the import and the schema-from-RDF door) puts a refusal of its act on HTTP (bundle-270, Q-953).
 *
 * ## What it prevents
 *
 * - **A refused sender that never reads its answer, or keeps the socket.** A sender cut off mid-upload (a stall, a trickle, a body over its
 *   bound, a cooled-down caller), or any sender whose body the door did not read to its end, still holds its end open. The answer says
 *   `Connection: close` and the rest of the body is drained (`req.resume()`), so the sender reads the code and the connection ends. The upload
 *   reader never destroys the request and removes its listener on every exit, so the drain can run.
 * - **A 429 without its wait.** A cooled-down caller's answer carries `Retry-After`, from the refusal's own `retryAfter`.
 *
 * - **A fault that is not a refusal, or a refusal outside the act, on a body half read.** A server fault met while the body is still arriving
 *   (a disk error in the spool) went to `sendCaughtFailure` with a keep-alive connection and a paused body, held until Node's request timeout;
 *   the admin import's refusals before its body was read (the two 415s, the busy 409, the 507) did not say `Connection: close` either.
 *   {@link closeUnreadBody} is the one rule for it, and every refusal and failure path of the three upload doors calls it.
 *
 * Both RDF doors send through {@link sendRdfRefusal}, so neither can leave a code out of the closing set or drop the header.
 */
import type { Request, Response } from 'express';
import { RDF_UPLOAD_CLOSE_CODES, RDF_UPLOAD_COOLDOWN, type RdfDocumentRefusal } from '../rdf/rdf-document.js';

/**
 * Before any answer a door gives while it may not have read the body to its end (a refusal, a fault): when the body is still arriving, the
 * answer says `Connection: close` and the rest of the body is drained, so the sender still sending reads the answer and the connection then
 * ends. A body read to its end is left alone. The two doors of RDF and the admin import call this on every refusal and every failure path;
 * a door that answered without it left a keep-alive connection whose half-read body stays paused until Node's request timeout.
 */
export function closeUnreadBody(req: Request, res: Response): void {
  if (req.complete) return;
  res.setHeader('Connection', 'close');
  req.resume();
}

/** Answer `r`, a refusal of an RDF door's act, to `req`. */
export function sendRdfRefusal(req: Request, res: Response, r: Pick<RdfDocumentRefusal, 'status' | 'error' | 'code' | 'detail'>): void {
  // A refusal that ends an upload closes the connection even when the body had just ended.
  if (RDF_UPLOAD_CLOSE_CODES.has(r.code)) res.setHeader('Connection', 'close');
  closeUnreadBody(req, res);
  if (r.code === RDF_UPLOAD_COOLDOWN) res.setHeader('Retry-After', String(r.detail?.['retryAfter']));
  res.status(r.status).json({ error: r.error, code: r.code, ...(r.detail ?? {}) });
}
