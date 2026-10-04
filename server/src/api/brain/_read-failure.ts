/**
 * One place the read routes answer a failure from, so the three of them cannot drift apart again.
 *
 * `/query`, `/recall` and `/find-similar` each carried their own two-line catch answering `400` for every
 * throw. Three copies of one rule is how the rule gets fixed in one of them — the defect class this codebase
 * produces most, and the reason this is a function rather than three edits.
 *
 * The classification itself lives in `brain/store-failure.ts`, which is where the reasoning and the two
 * independent reports are recorded. This file is only the HTTP half of a READ: a body that says `retryable` in a
 * field rather than in prose. The store failure itself is put on the wire by `sendStoreFailure` (`api/send-failure.ts`),
 * the one sender every door uses.
 */
import type express from 'express';
import { storeFailureAnswer } from '../../brain/store-failure.js';
import { sendStoreFailure } from '../send-failure.js';

/**
 * Answer a read failure with the truth about whose fault it is.
 *
 * **`retryable` is on EVERY failure body, true or false.** A field that appears only when retrying is
 * worthwhile is a field whose absence has to be interpreted, and the caller who most needs it is the one who
 * does not know to look — the same argument the byte budget's accounting fields are built on. A client can
 * branch on one boolean instead of matching our prose, which is what `Retry-After` alone would have left them
 * doing on the 4xx-shaped failures.
 */
export function sendReadFailure(res: express.Response, err: unknown): void {
  const store = storeFailureAnswer(err);
  if (store) { sendStoreFailure(res, store); return; }
  // Not the store's: the request's, which the caller is the one who can fix.
  res.status(400).json({ error: err instanceof Error ? err.message : String(err), retryable: false });
}

/**
 * Put `retryable` on EVERY failure from a read route, including the twenty-odd validation refusals that never
 * reach the handler's catch.
 *
 * ## Why middleware and not twenty-odd edits
 *
 * `sendReadFailure` above only sees a THROW. The three read handlers also refuse early — a bad `collection`, a
 * non-boolean flag, a malformed `entryId` — with their own `res.status(400).json(...)` and a `return`, and
 * those bodies carried no `retryable` at all. Measured: three of four probed refusals came back without it.
 *
 * **An absent `retryable` is exactly what this change exists to remove.** The whole argument for the field is
 * that a caller branches on a boolean instead of interpreting a silence; a field present on some failures and
 * missing from others is worse than no field, because the caller who reads it will conclude the wrong thing on
 * the ones that lack it.
 *
 * Editing every refusal by hand would have been the "eight places to forget" shape this codebase produces
 * most — and it would miss the twenty-first, added next month. One wrapper cannot miss one.
 *
 * ## The default, and the one exception
 *
 * `4xx` is not retryable and `5xx` is — plus `429`, which is retryable by definition and already documents its
 * `Retry-After`. A body that already states `retryable` is left exactly as it is, so `sendReadFailure`'s
 * classification always wins over this default.
 */
export function statesRetryability(
  _req: express.Request, res: express.Response, next: express.NextFunction,
): void {
  const original = res.json.bind(res);
  res.json = (body: unknown) => {
    const isPlainObject = body !== null && typeof body === 'object' && !Array.isArray(body);
    if (res.statusCode >= 400 && isPlainObject
        && (body as Record<string, unknown>)['retryable'] === undefined) {
      return original({ ...(body as Record<string, unknown>), retryable: res.statusCode >= 500 || res.statusCode === 429 });
    }
    return original(body);
  };
  next();
}
