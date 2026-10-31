/**
 * A rate limit an admin can set per TOKEN, under a ceiling infra can set instance-wide.
 *
 * Owner request, 2026-08-20: *"ratelimit should be settable on token by instance admin"* and *"and instancewide
 * by infra"*. Two tiers, and the pure resolution lives here so it can be tested without an HTTP server.
 *
 * ## The bucket was already per token — only the ceiling was a constant
 *
 * `clientRateLimitKey` has always keyed the global limiter on a hash of the credential, so requests were already
 * counted per token. `max: 300` was simply hardcoded. This is not a new counting mechanism; it is the number
 * becoming resolvable.
 *
 * ## Why a SECOND limiter rather than making the existing one token-aware
 *
 * The global limiter runs BEFORE authentication, deliberately — it is the only throttle in front of admin TOTP
 * verification, so it has to throttle requests carrying no valid credential at all. That means it cannot know
 * which token a request holds: answering that needs a bcrypt compare against every stored token, per request.
 *
 * So the per-token quota is enforced after auth, where the record is already resolved and free. The pre-auth
 * limiter is untouched and remains the outer backstop for the anonymous surface.
 *
 * ## Resolution, in the order this codebase already resolves tiers
 *
 * `record > instance > default`, the same shape as `ttlDays` and `suppressEmbeddings`:
 *
 *   1. the token's own `rateLimitPerMinute`, set by an instance admin, or a space admin for a token in scope;
 *   2. `YTHRIL_RATE_LIMIT_PER_MINUTE`, set by infra;
 *   3. `DEFAULT_PER_MINUTE`, which is the number the global limiter has always used — so an instance that sets
 *      nothing behaves exactly as it does today.
 *
 * ## The infra value is a CEILING, not just a default
 *
 * If it were only a default, an admin could set a per-token value above it and infra's control would be
 * decorative. So a write above the ceiling is **refused, naming the ceiling** — never accepted and clamped.
 * Storing a smaller number than the caller asked for, and answering 200, is the defect this repo keeps finding:
 * the caller is told it worked and the thing they asked for did not happen.
 */

import { envIntOpt } from '../config/env-num.js';
import type { TokenRecord } from '../config/types.js';

/**
 * What the global limiter has always allowed, and therefore what an instance that configures nothing gets.
 *
 * Kept equal to `globalRateLimit`'s `max` on purpose: the per-token limiter is a second gate on the same
 * traffic, so a lower default here would silently tighten every existing deployment.
 */
export const DEFAULT_PER_MINUTE = 300;

/** The window both limiters count over. One minute, stated once so the two cannot drift. */
export const WINDOW_MS = 60_000;

/** Infra's instance-wide value, or `undefined` when infra has not set one. */
export function instanceCeiling(): number | undefined {
  return envIntOpt('YTHRIL_RATE_LIMIT_PER_MINUTE');
}

/**
 * The limit that applies to one resolved token.
 *
 * Takes the record rather than a request so it is pure. An OIDC-derived token carries no `rateLimitPerMinute`
 * field at all — it is built per request from a claim mapping — so it resolves to the instance value, which is
 * the correct answer rather than a special case.
 */
export function resolveLimitFor(token: { rateLimitPerMinute?: number } | undefined): number {
  const own = token?.rateLimitPerMinute;
  if (typeof own === 'number' && Number.isFinite(own) && own > 0) return own;
  return instanceCeiling() ?? DEFAULT_PER_MINUTE;
}

/** The bounds a per-token value must satisfy regardless of the ceiling. */
export const MIN_PER_MINUTE = 1;
export const MAX_PER_MINUTE = 1_000_000;

/**
 * Why a requested per-token limit is unacceptable, or `null` when it is fine.
 *
 * One function so the create and the update route cannot disagree (no MCP tool writes a token) — the y-flows convention `convention-find-every-instance` names one
 * rule with two implementations, and here the weaker one would be handing out quota nobody granted. The message
 * is returned rather than thrown so each surface can attach it to its own status code.
 */
export function rateLimitRefusal(requested: unknown): string | null {
  if (requested === undefined || requested === null) return null;   // absent = inherit, which is the default
  if (typeof requested !== 'number' || !Number.isInteger(requested)) {
    return 'rateLimitPerMinute must be a whole number of requests per minute.';
  }
  if (requested < MIN_PER_MINUTE || requested > MAX_PER_MINUTE) {
    return `rateLimitPerMinute must be between ${MIN_PER_MINUTE} and ${MAX_PER_MINUTE}.`;
  }
  const ceiling = instanceCeiling();
  if (ceiling !== undefined && requested > ceiling) {
    return `rateLimitPerMinute ${requested} exceeds the instance ceiling of ${ceiling} set by `
      + 'YTHRIL_RATE_LIMIT_PER_MINUTE. Infra owns that number; lower the per-token value or have infra raise '
      + 'the ceiling. The request was refused rather than silently reduced.';
  }
  return null;
}

/** The subset of a token this module needs, so callers do not have to hand over a whole record. */
export type RateLimited = Pick<TokenRecord, 'rateLimitPerMinute'>;
