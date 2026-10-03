/**
 * How a sync push door answers a page it could not finish writing — the one answer for every push route.
 *
 * ## Why one function (bundle-30, `R1`)
 *
 * Every push door ended in its own `catch` answering `500` for everything. Once writes on those doors carry a bound
 * (`db/write-bound.ts`), a write the bound ended is the STORE's condition: the page is safe to send again, the
 * sender should hold its watermark and retry, and a `500` reads as our bug. The classification is
 * `classifyReadFailure`'s, the one the REST and MCP doors answer from, so a push and a REST write of the same record
 * cannot disagree about whose fault a stalled store is.
 *
 * ## What the sender is told
 *
 * A `503`, `retryable: true`, `Retry-After`, and words of our own — a peer is not told our collection names or the
 * driver's internals. Anything the classifier does not positively identify as the store's stays a `500`, and is
 * reported to the operator either way (`reportServerFailure`: a 5xx leaves evidence behind).
 */
import type express from 'express';
import { classifyReadFailure, STORE_TIMEOUT_MESSAGE } from '../../brain/store-failure.js';
import { isWriteTimeout } from '../../db/write-timeout.js';
import { reportServerFailure } from '../../util/report-failure.js';

const STORE_FAILURE_MESSAGE = 'A store-side failure stopped this page; nothing about it is the sender\'s, and it can '
  + 'be sent again (retryable).';

export function sendSyncWriteFailure(res: express.Response, where: string, err: unknown): void {
  reportServerFailure(where, err);
  const f = classifyReadFailure(err);
  if (!f.retryable) {
    res.status(500).json({ error: 'Internal error' });
    return;
  }
  if (f.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(f.retryAfterSeconds));
  res.status(503).json({ error: isWriteTimeout(err) ? STORE_TIMEOUT_MESSAGE : STORE_FAILURE_MESSAGE, retryable: true });
}
