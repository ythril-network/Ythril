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
 * Both doors send through this one function, so neither can leave a code out of the closing set or drop the header.
 */
import type { Request, Response } from 'express';
import { RDF_UPLOAD_CLOSE_CODES, RDF_UPLOAD_COOLDOWN, type RdfDocumentRefusal } from '../rdf/rdf-document.js';

/** Answer `r`, a refusal of an RDF door's act, to `req`. */
export function sendRdfRefusal(req: Request, res: Response, r: Pick<RdfDocumentRefusal, 'status' | 'error' | 'code' | 'detail'>): void {
  if (RDF_UPLOAD_CLOSE_CODES.has(r.code) || !req.complete) {
    res.setHeader('Connection', 'close');
    req.resume();
  }
  if (r.code === RDF_UPLOAD_COOLDOWN) res.setHeader('Retry-After', String(r.detail?.['retryAfter']));
  res.status(r.status).json({ error: r.error, code: r.code, ...(r.detail ?? {}) });
}
