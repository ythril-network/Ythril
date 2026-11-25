/**
 * Who a long read counts against, and when it stops (bundle-271, Q-757, Q-758; lens-2 A3, lens-3 Q2): the two questions every door that reads in
 * a slot asks of its request, each written here once.
 *
 * ## What it prevents
 *
 * - **Two keys for one caller.** The slot a read takes is counted by {@link slotCallerKey} (the token's id, or the address of a caller with
 *   none): a door that spelled it its own way would let one caller hold more than its share, or two doors count one caller twice.
 * - **A read that outlives its client.** {@link abortWhenClientGoes} aborts when the response closes before it was written, so the engine and
 *   the store are asked nothing more for a caller who left; a door that forgot it held a slot and a cursor until its deadline.
 *
 * A leaf module: it imports types only.
 */
import type { Request, Response } from 'express';

/** The key a slot counts this request's caller by: the token's id, else the address the request came from. */
export function slotCallerKey(req: Request): string {
  return (req.authToken as { id?: string } | undefined)?.id ?? req.ip ?? '';
}

/** A signal that aborts when `res` closes before its answer was written: the client went away. */
export function abortWhenClientGoes(res: Response): AbortSignal {
  const ended = new AbortController();
  res.once('close', () => { if (!res.writableFinished) ended.abort(); });
  return ended.signal;
}
