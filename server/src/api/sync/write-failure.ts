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
 * reported to the operator either way (`reportServerFailure`: a 5xx leaves evidence behind). The answer itself is
 * `storeFailureAnswer`'s, for a peer, put on the wire by the one HTTP sender (bundle-30 I6, `C1`).
 */
import type express from 'express';
import { storeFailureAnswer } from '../../brain/store-failure.js';
import { sendStoreFailure } from '../brain/_read-failure.js';
import { reportServerFailure } from '../../util/report-failure.js';

export function sendSyncWriteFailure(res: express.Response, where: string, err: unknown): void {
  reportServerFailure(where, err);
  const store = storeFailureAnswer(err, { audience: 'peer' });
  if (store) { sendStoreFailure(res, store); return; }
  res.status(500).json({ error: 'Internal error' });
}
