/**
 * The answer of `GET /api/files/:spaceId` for a stored FILE: its headers, then its bytes streamed through the stored-bytes door; for a
 * `HEAD`, the headers alone.
 *
 * It left `api/files.ts` (a frozen god-file, G-4) when the HEAD stop was added, because a frozen file grows only after a concern has
 * moved out of it, and this is the one part of that route that reads a file's content.
 *
 * What it prevents:
 * - a file whose content can run script in this origin (HTML, SVG, XML) rendered inline: it is sent as an attachment with a sandbox CSP
 *   (stored XSS);
 * - a truncated file that looks complete: a chunk that fails its integrity check after bytes were sent destroys the response;
 * - a HEAD that opens, reads and decrypts the whole file to send nothing. Express runs this GET route for a HEAD, and its headers need
 *   only the plaintext size, which the stat reads from the ciphertext length without decrypting, so the content is never opened for one.
 *   A file whose content cannot be opened (a missing key) is a `500` to a GET and a `200` to a HEAD, which never asks for the content.
 */

import path from 'path';
import type { Request, Response } from 'express';
import { log } from '../util/log.js';
import { openStoredRead, statStored } from '../files/stored-bytes.js';
import { contentTypeForDownload } from '../files/mime.js';
import { contentDispositionOf } from '../util/content-disposition.js';

// Extensions whose content can execute script when rendered inline by a
// browser — always served as attachments (stored-XSS guard).
const ACTIVE_CONTENT_EXTS = new Set(['.html', '.htm', '.svg', '.xml', '.xhtml']);

/**
 * Answer the stored file at `abs`, named `requested` as the caller asked for it; `where` names it in a log line. Throws before any header
 * is written when the file cannot be stated or opened, for the route's own failure answer.
 */
export async function sendStoredDownload(req: Request, res: Response, abs: string, requested: string, where: string): Promise<void> {
  // STREAMED through the stored-bytes door (F-43): a file of any size, decrypted a chunk at a time when it is
  // encrypted at rest. The length is the PLAINTEXT size, read from the ciphertext length without decrypting.
  const { size } = await statStored(abs);
  const body = req.method === 'HEAD' ? null : await openStoredRead(abs);
  const ext = path.extname(requested).toLowerCase();
  // Stored XSS guard: user-uploaded HTML/SVG/XML rendered inline would run
  // script in this origin (token theft from the web UI). Active-content
  // types are forced to download and get a sandbox CSP so nothing executes
  // even if a browser renders them anyway. Passive types (images, pdf,
  // plain text) stay inline so previews keep working.
  const isActive = ACTIVE_CONTENT_EXTS.has(ext);
  res
    .status(200)
    .setHeader('Content-Type', contentTypeForDownload(requested))
    .setHeader('Content-Length', size)
    .setHeader('X-Content-Type-Options', 'nosniff')
    .setHeader('Content-Disposition', contentDispositionOf(isActive ? 'attachment' : 'inline', path.basename(abs)));
  if (isActive) {
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  }
  if (body === null) {
    res.end();
    return;
  }
  /*
   * A chunk that fails its integrity check AFTER bytes were sent must ABORT the response. Ending it normally would
   * hand the client a truncated file that looks complete; destroying it makes the client see a failed transfer.
   */
  body.on('error', err => {
    log.warn(`download of ${where} failed mid-stream: ${err instanceof Error ? err.message : String(err)}`);
    res.destroy(err instanceof Error ? err : undefined);
  });
  body.pipe(res);
}
