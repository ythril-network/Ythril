import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { log, peerText } from '../util/log.js';
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
 * 300/min global limit of the time and onto the per-address flood backstop (3000/min, which counts it: no token's
 * limit metered it). The backstop bounded it, so this was a tenfold step up from the anonymous cap rather than an open
 * door, but it was available to anyone with a query string.
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

/**
 * The key of a request's SOURCE ADDRESS: `req.ip` with an IPv6 address folded to its subnet (`ipKeyGenerator`), so a client that owns a
 * whole /64 cannot rotate through it. The one place an address becomes a key: `clientRateLimitKey` (an anonymous caller's bucket) and the
 * second-factor lockout (`auth/code-attempts.ts`, which counts wrong codes per address) both ask it, so the two cannot disagree about
 * which requests share an address.
 */
export function clientAddressKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? '');
}

export function clientRateLimitKey(req: Request): string {
  const credential = presentedCredential(req);
  if (credential) {
    return `c:${createHash('sha256').update(credential).digest('base64url').slice(0, 22)}`;
  }
  return `ip:${clientAddressKey(req)}`;
}

/**
 * Who a request is, to the code that counts per token: its token's id, else (a caller with no stored id, an OIDC identity) the shared client
 * key of its credential, so that caller is still counted and never exempt. The one definition, so the per-token quota (`tokenRateLimit`) and the
 * second-factor attempt counter (`auth/code-attempts.ts`, through its three doors) bucket one caller under one key. A guard that runs before the
 * token is attached to the request (`enforceMfa`) passes the record it resolved; everything behind the guards reads the attached one. Each caller
 * adds its own `t:` prefix; this is not a key in any table by itself.
 */
export function callerKeyOf(req: Request, record?: { id?: string }): string {
  return (record ?? (req.authToken as { id?: string } | undefined))?.id || clientRateLimitKey(req);
}

/**
 * The `SKIP_*_RATE_LIMIT` kill-switches exist only for the test harness. They are
 * honoured **outside production only**, so a leaked env var (copy-pasted compose,
 * shared `.env`) can never silently disable rate limiting on a live deployment —
 * the limiters are the first throttle in front of admin TOTP verification, and the
 * second-factor lockout (`auth/code-attempts.ts`, which no kill-switch turns off) is the bound on wrong codes.
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
    log.warn(`authRateLimit hit: ${peerText(req.ip)} on ${peerText(req.method)} ${peerText(req.path)}`);
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
    log.warn(`notifyRateLimit hit: ${peerText(req.ip)} on ${peerText(req.method)} ${peerText(req.path)}`);
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
 * express-rate-limit asks "was this request successful" with the request AND the response; the backstop's rule reads the response alone.
 * This hands `read` the response, so the rule is written as one expression over `res`.
 */
const ofResponse = (read: (res: Response) => boolean) => (_req: Request, res: Response): boolean => read(res);

/**
 * 3000 requests/minute per SOURCE IP — the flood backstop, mounted once in front of every route. It counts the requests of an address
 * that NO TOKEN'S OWN LIMIT COVERED, and nothing else.
 *
 * Per-client keying (below) is what stops one client starving the others, but on its own it hands an
 * attacker an escape hatch: every distinct bearer string mints a fresh bucket, so a flood of random
 * credentials would never hit a limit. This limiter closes that — it is keyed purely on the IP and counts what no
 * token's limiter bounds, so it is invisible in normal operation and only bites a flood.
 *
 * ## What it gives back, and why that is only safe for one thing
 *
 * A token's own limit is `DEFAULT_PER_MINUTE` by default and may be raised (D-68), so three busy tokens behind one
 * address (a gateway, a NAT, the default Docker bridge, one reverse proxy) reach this `max` together, and a backstop that counted them
 * answered a `429` that no token's own figure (`rateLimitEffective`) predicted (Q-693). A request that `attachToken` handed to
 * `tokenRateLimit` and that limiter admitted is bounded by that limiter and the token's grant, so it is given back whatever its answer
 * (`skipSuccessfulRequests`, with `res.locals.meteredByToken === true` as "successful"; the limiter's own 429 resets the flag, so a token
 * over its limit still counts here). EVERYTHING ELSE counts, whatever its answer: anonymous requests, invented bearers, a valid token
 * refused before metering (403 admin, MFA_REQUIRED, MFA_INVALID, MFA_LOCKED), 404s, static files, the SPA fallback, `/.well-known`,
 * maintenance 503s. The status is never the question: a 200 nobody metered still counts.
 *
 * It never steps aside for a PRESENTED credential: an invented bearer is not metered by anything.
 *
 * Named cost: express-rate-limit gives a skipped request back when it FINISHES, in the window it finishes in, so a metered request that
 * ends in a later window decrements that window: at most one request per such stream, and only for a token already metered by its own limit.
 *
 * It deliberately does NOT replace the per-route limiters; it sits behind them as the outer bound.
 */
export const ipFloodBackstop = rateLimit({
  windowMs: 60_000,
  max: 3000,
  standardHeaders: false,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded: too many requests from this address that no token\'s own limit covered, please slow down.' },
  handler: (req, res, _next, options) => {
    log.warn(`ipFloodBackstop hit: ${peerText(req.ip)} on ${peerText(req.method)} ${peerText(req.path)} — the address sent more than its share of requests no token's own limit covered`);
    res.status(options.statusCode).json(options.message);
  },
  skipSuccessfulRequests: true,
  requestWasSuccessful: ofResponse(res => res.locals.meteredByToken === true),
  skip: () => skipRateLimit('SKIP_GLOBAL_RATE_LIMIT'),
});

/**
 * 300 requests/minute for a request that presents NO credential — and only for those. A token's own default
 * (`DEFAULT_PER_MINUTE`) is higher since 6.4; an anonymous caller keeps the tighter cap.
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
 * closes that, keyed purely on the IP, and it never steps aside for a presented credential: it gives back only a request a valid
 * token's own limiter metered (see its own note).
 */
export const globalRateLimit = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientRateLimitKey,
  message: { error: 'Rate limit exceeded, please slow down.' },
  handler: (req, res, _next, options) => {
    log.warn(`globalRateLimit hit: ${peerText(req.ip)} on ${peerText(req.method)} ${peerText(req.path)}`);
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
    log.warn(`syncRateLimit hit: ${peerText(req.ip)} on ${peerText(req.method)} ${peerText(req.path)}`);
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
 * That one runs before auth, deliberately — it is the first throttle in front of admin TOTP verification (the bound on
 * wrong codes is `auth/code-attempts.ts`), so it must throttle requests carrying no valid credential at all. It therefore cannot know WHICH token a request
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
  // An OIDC-derived identity has no stored token id; `callerKeyOf` falls back to the shared client key so it is still
  // bucketed rather than exempt. Exempting anything from a quota is how a quota stops being one.
  keyGenerator: (req: Request) => `t:${callerKeyOf(req)}`,
  message: { error: 'Rate limit exceeded for this token, please slow down.' },
  handler: (req, res, _next, options) => {
    const token = req.authToken as { id?: string; name?: string } | undefined;
    // The token is named because the operator's next question is always WHICH one, and a quota they set
    // themselves is the one thing they can act on.
    log.warn(`tokenRateLimit hit: token '${peerText(token?.name ?? 'unknown')}' (${peerText(token?.id ?? 'no id')}) `
      + `on ${peerText(req.method)} ${peerText(req.path)} — limit ${resolveLimitFor(token as { rateLimitPerMinute?: number })}/min`);
    // `attachToken` marked this request metered before asking the limiter; a request the limiter REFUSES was not admitted by it, so it is
    // counted by `ipFloodBackstop` again — one token over its own limit cannot flood an address for free.
    res.locals.meteredByToken = false;
    res.status(options.statusCode).json(options.message);
  },
  // The same kill-switch the global limiter honours, and for the same reason: parallel test suites on one host
  // would otherwise exhaust a shared window. Non-production only, enforced in `skipRateLimit`.
  skip: () => skipRateLimit('SKIP_GLOBAL_RATE_LIMIT'),
});
