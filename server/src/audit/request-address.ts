import type { Request } from 'express';

/**
 * The address a request is recorded under: `req.ip` (the client a configured proxy reports), else the socket's own address, else `'unknown'`.
 *
 * The one spelling of "where did this request come from" for everything that writes it down (the audit row of a request, of a rejected
 * credential, of a view act, of a lock start and the log line beside it). Written at four sites by hand it drifted once already (one dropped the
 * `?.` on the socket, which a request with no socket cannot reach it through); a record with `ip` missing is a row nobody can trace. It is NOT
 * the key a limiter counts under: that is `clientAddressKey` (`rate-limit/middleware.ts`), which folds an IPv6 address to its subnet.
 */
export function requestAddress(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
