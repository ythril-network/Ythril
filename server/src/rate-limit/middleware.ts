import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { log } from '../util/log.js';
import { resolveLimitFor, WINDOW_MS } from './per-token.js';

/**
 * Bucket requests by CLIENT, not by source IP.
 *
 * Why: behind no reverse proxy (`trustProxy=false`) — which is the default Docker deployment — every
 * request arrives from the Docker gateway address (`::ffff:172.21.0.x`). Keying on the IP therefore puts
 * *every* client of the instance into ONE bucket, so a single busy client (or a client bug — the brain
 * request storm was exactly this) locks out everyone else, and the app can 429 itself.
 *
 * The key is derived from the presented credential rather than from `req.authToken`, because the limiters
 * run BEFORE the auth middleware that would populate it. It is a SHA-256 of the bearer, truncated — the
 * credential itself never lands in a store key, a log line, or a header.
 *
 * Requests with no credential (login, setup, an anonymous probe) still key on the IP, which is the only
 * identity they have. `ipKeyGenerator` is used for that half so IPv6 addresses are normalised to their /64
 * — an IPv6 client can otherwise trivially rotate through addresses it already owns.
 */
/**
 * The credential a request presents, or `''`.
 *
 * ONE definition, because two things branch on it: the key a limiter buckets by, and whether
 * `globalRateLimit` applies at all. A second reading of the request would eventually disagree with this one.
 *
 * ## It used to read `?token=` too, and that had to go with the SSE transport
 *
 * The MCP SSE transport authenticated from a raw `?token=` query parameter, so this read it as well —
 * otherwise every MCP client would have shared the one IP bucket. Correct while the parameter was a
 * credential the server trusted.
 *
 * 4.0 removes that transport and the query-token fallback with it, which INVERTS the reasoning: a request
 * carrying `?token=` is now unauthenticated. Bucketing by it would let an anonymous caller mint a fresh
 * quota bucket per request by varying a string nobody checks, and — because `globalRateLimit` skips
 * entirely for a request that presents a credential — a bare `?token=anything` moved that caller off the
 * 300/min global limit and onto the 3000/min IP flood backstop. The backstop bounded it, so this was a
 * tenfold amplification rather than an open door, but it was available to anyone with a query string.
 *
 * Header only. A credential that cannot travel in a URL cannot be spoofed in one.
 */
export function presentedCredential(req: Request): string {
  const header = req.get?.('authorization') ?? '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? '';
}

/** Whether this request presents a credential at all — see `presentedCredential`. */
export function hasCredential(req: Request): boolean {
  return presentedCredential(req) !== '';
}

export function clientRateLimitKey(req: Request): string {
  const credential = presentedCredential(req);
  if (credential) {
    return `c:${createHash('sha256').update(credential).digest('base64url').slice(0, 22)}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

/**
 * The `SKIP_*_RATE_LIMIT` kill-switches exist only for the test harness. They are
 * honoured **outside production only**, so a leaked env var (copy-pasted compose,
 * shared `.env`) can never silently disable rate limiting on a live deployment —
 * the limiters are the only throttle in front of admin TOTP verification.
 */
function skipRateLimit(envKey: string): boolean {
  return process.env['NODE_ENV'] !== 'production' && process.env[envKey] === 'true';
}

/** Log a loud warning at startup when a rate-limit kill-switch is set. */
export function warnRateLimitBypass(): void {
  const set = ['SKIP_AUTH_RATE_LIMIT', 'SKIP_GLOBAL_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']
    .filter(f => process.env[f] === 'true');
  if (set.length === 0) return;
  if (process.env['NODE_ENV'] === 'production') {
    log.warn(`SECURITY: rate-limit kill-switch(es) set but IGNORED in production: ${set.join(', ')}. Remove them from the environment.`);
  } else {
    log.warn(`Rate limiting DISABLED via ${set.join(', ')} (non-production only).`);
  }
}

/** 10 requests/minute per IP — used for auth-sensitive endpoints (setup, login) */
export const authRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  handler: (req, res, _next, options) => {
    log.warn(`authRateLimit hit: ${req.ip} on ${req.method} ${req.path}`);
    res.status(options.statusCode).json(options.message);
  },
  // Allow test infrastructure to disable this limit on A/B instances so
  // parallel test suites don't exhaust the window. Instance C omits this env
  // so rate-limit tests on C still exercise the real 429 behaviour.
  skip: () => skipRateLimit('SKIP_AUTH_RATE_LIMIT'),
});

/** 60 requests/minute per CLIENT — notification and setup endpoints */
export const notifyRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientRateLimitKey,
  message: { error: 'Too many requests, please try again later.' },
  handler: (req, res, _next, options) => {
    log.warn(`notifyRateLimit hit: ${req.ip} on ${req.method} ${req.path}`);
    res.status(options.statusCode).json(options.message);
  },
  // This limiter guards the peer notification channel. It also guarded the sync trigger that used to sit
  // on it (`POST /api/notify/trigger`, removed in 5.0), and that is where the kill-switch came from: every
  // request from the harness shares one source IP, so the suites collectively blew through 60/min and got
  // 429s. Those 429s were swallowed by the tests' trigger `.catch()`, so no sync cycle ran and
  // load-sensitive sync assertions timed out looking like flakes. It was the ONLY limiter missing a
  // kill-switch; it now honours the same one as the rest of the sync plane.
  // Instance C omits the env so rate-limit tests still exercise the real 429.
  skip: () => skipRateLimit('SKIP_SYNC_RATE_LIMIT'),
});

/**
 * 3000 requests/minute per SOURCE IP — the flood backstop, mounted once in front of every route.
 *
 * Per-client keying (below) is what stops one client starving the others, but on its own it hands an
 * attacker an escape hatch: every distinct bearer string mints a fresh bucket, so a flood of random
 * credentials would never hit a limit. This limiter closes that — it is keyed purely on the IP and set
 * far above any legitimate single client, so it is invisible in normal operation and only bites a flood.
 *
 * It deliberately does NOT replace the per-route limiters; it sits behind them as the outer bound.
 */
export const ipFloodBackstop = rateLimit({
  windowMs: 60_000,
  max: 3000,
  standardHeaders: false,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded, please slow down.' },
  handler: (req, res, _next, options) => {
    log.warn(`ipFloodBackstop hit: ${req.ip} on ${req.method} ${req.path}`);
    res.status(options.statusCode).json(options.message);
  },
  skip: () => skipRateLimit('SKIP_GLOBAL_RATE_LIMIT'),
});

/**
 * 300 requests/minute for a request that presents NO credential — and only for those.
 *
 * ## Why it steps aside for a credential
 *
 * It used to apply to everything, keyed on a hash of the credential, which made it a second cap on every
 * authenticated caller: the effective limit was `min(300, rateLimitPerMinute)`. Granting a token 1 000 did
 * nothing, and `GET /api/tokens` reported `rateLimitEffective: 1000` while the caller was refused at 300 —
 * three numbers for one quota.
 *
 * Owner's decision, 2026-08-30: the per-token quota is what governs authenticated traffic, which is what it
 * was built to be. This limiter is the pre-auth gate its own description always claimed.
 *
 * It cannot wait for the token to RESOLVE — it runs before auth by mount order, and the limit is a property
 * of a record that does not exist yet (see `attachToken`). So the test is the credential, and both outcomes
 * are covered: it resolves and `tokenRateLimit` governs, or it does not and `requireAuth` answers 401.
 *
 * **A flood of INVENTED credentials is not a hole this opens.** This limiter never bounded one: it is keyed
 * per credential, so every distinct bearer string already minted a fresh bucket. `ipFloodBackstop` is what
 * closes that, keyed purely on the IP, and it does not step aside for anything.
 */
export const globalRateLimit = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientRateLimitKey,
  message: { error: 'Rate limit exceeded, please slow down.' },
  handler: (req, res, _next, options) => {
    log.warn(`globalRateLimit hit: ${req.ip} on ${req.method} ${req.path}`);
    res.status(options.statusCode).json(options.message);
  },
  // A credentialed request is governed by `tokenRateLimit` instead — see the note above.
  //
  // Allow test infrastructure to disable this limit on A/B instances so
  // parallel test suites don't exhaust the window on the same IP. Instance C
  // omits this env so rate-limit tests can exercise the real 429 behaviour.
  skip: (req: Request) => hasCredential(req) || skipRateLimit('SKIP_GLOBAL_RATE_LIMIT'),
});

/** 2000 requests/minute per CLIENT (peer) — machine-to-machine sync endpoints.
 *  Sync pushes one request per item; with large data sets and multiple
 *  networks the per-minute volume can easily exceed the global limit. */
export const syncRateLimit = rateLimit({
  windowMs: 60_000,
  max: 2000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientRateLimitKey,
  message: { error: 'Sync rate limit exceeded, please slow down.' },
  handler: (req, res, _next, options) => {
    log.warn(`syncRateLimit hit: ${req.ip} on ${req.method} ${req.path}`);
    res.status(options.statusCode).json(options.message);
  },
  skip: () => skipRateLimit('SKIP_SYNC_RATE_LIMIT'),
});

/*
 * `bulkWipeRateLimit` WAS HERE, and it is deleted rather than left unused (5.0).
 *
 * Five a minute per client, mounted in front of the five `DELETE .../<collection>` wipe routes. Those became
 * one tool call, and the limiter could not follow: middleware guards a ROUTE, and the same capability is
 * reachable over MCP where there is no route to mount it on. So it throttled a browser and not an agent —
 * the caller most likely to be emptying spaces in a loop was the one with no limit.
 *
 * The replacement is `rate-limit/heavy-tool.ts`: a plain counter that a tool declares (`heavy: true`) and
 * `callTool` consumes, so both doors are held to the same five a minute from one place. Deleted rather than
 * kept exported, because an unused limiter is what somebody reaches for next time and mounts on one door.
 */

/**
 * The PER-TOKEN quota, enforced after authentication.
 *
 * ## Why it is separate from `globalRateLimit`
 *
 * That one runs before auth, deliberately — it is the only throttle in front of admin TOTP verification, so it
 * must throttle requests carrying no valid credential at all. It therefore cannot know WHICH token a request
 * holds: answering that means a bcrypt compare against every stored token, per request. So it keys on a hash of
 * the credential, which buckets correctly and identifies nothing.
 *
 * This one runs where the record is already resolved and free. `globalRateLimit` is unchanged and remains the
 * outer bound for the anonymous surface.
 *
 * ## Keyed on the token ID, not on the credential hash
 *
 * A rotated token is a new credential and the same grant. Keying on the hash would hand a fresh bucket to every
 * rotation, which turns a quota into an inconvenience.
 *
 * ## Why `max` is a function
 *
 * Because the answer is per request: `express-rate-limit` calls it with the request, and
 * `resolveLimitFor` reads the resolved record. A constant here is what this change exists to remove.
 */
export const tokenRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  max: (req: Request) => resolveLimitFor(req.authToken as { rateLimitPerMinute?: number } | undefined),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const token = req.authToken as { id?: string } | undefined;
    // An OIDC-derived identity has no stored token id; fall back to the shared client key so it is still
    // bucketed rather than exempt. Exempting anything from a quota is how a quota stops being one.
    return token?.id ? `t:${token.id}` : clientRateLimitKey(req);
  },
  message: { error: 'Rate limit exceeded for this token, please slow down.' },
  handler: (req, res, _next, options) => {
    const token = req.authToken as { id?: string; name?: string } | undefined;
    // The token is named because the operator's next question is always WHICH one, and a quota they set
    // themselves is the one thing they can act on.
    log.warn(`tokenRateLimit hit: token '${token?.name ?? 'unknown'}' (${token?.id ?? 'no id'}) `
      + `on ${req.method} ${req.path} — limit ${resolveLimitFor(token as { rateLimitPerMinute?: number })}/min`);
    res.status(options.statusCode).json(options.message);
  },
  // The same kill-switch the global limiter honours, and for the same reason: parallel test suites on one host
  // would otherwise exhaust a shared window. Non-production only, enforced in `skipRateLimit`.
  skip: () => skipRateLimit('SKIP_GLOBAL_RATE_LIMIT'),
});
