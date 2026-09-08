import type { Request, Response, NextFunction } from 'express';
import { log } from '../util/log.js';
import { tokenRateLimit } from '../rate-limit/middleware.js';
import { findMatchingToken, touchToken } from './tokens.js';
import { consumeSseTicket } from './sse-ticket.js';
import { isMfaEnabled, verifyMfaCode } from './totp.js';
import { validateOidcJwt, getOidcConfig } from './oidc.js';
import type { TokenRecord } from '../config/types.js';
import { spaceAdminSpacesFor, isSpaceAdminFor, administersAnySpace } from './editor-scope.js';
import type { OidcTokenRecord } from './oidc.js';
import { resolveMemberSpaces } from '../spaces/proxy.js';
import { reachesSpace } from './space-reach.js';
import { rungFor, satisfies } from './required-rung.js';
import { effectiveRung } from './mint-cap.js';
import { authAttemptsTotal } from '../metrics/registry.js';
import { logAuthFailure } from '../audit/middleware.js';
import { mcpResourceMetadataUrl } from '../mcp/oauth.js';
import { canWriteAnywhere } from './write-anywhere.js';
import type { TokenRights } from '../config/rights-shape.js';
// Re-exported so the guards here and every existing importer keep one name for one rule. The definition
// lives in its own module because `mcp/oauth.ts` needs it too, and this file already imports from there.
export { isInstanceAdmin } from './instance-admin.js';
import { isInstanceAdmin } from './instance-admin.js';

// Augment Express Request type
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authToken?: Omit<TokenRecord, 'hash'> | OidcTokenRecord;
      resolvedSpaceId?: string;
      /** Bearer exchanged from a single-use SSE ticket, cached so multiple auth middlewares in the same
       *  request (e.g. a router-level requireAuth + a route-level requireAdmin) don't each try to consume
       *  it. `null` means the ticket was invalid; `undefined` means not yet exchanged. */
      sseTicketBearer?: string | null;
      /**
       * Before/after snapshots a route offers the audit log, so the entry can say WHAT changed rather
       * than only that something did. The audit middleware runs on `res.finish` and cannot see resource
       * state, so the handler must hand it over.
       *
       * Handing them over does NOT publish them: `audit-changes.ts` reads only the fields allowlisted for
       * that operation and ignores everything else, so a handler may pass a whole record without auditing
       * its secrets.
       */
      auditSnapshots?: { before?: unknown; after?: unknown };
      /**
       * Whether a recall actually came back with something, and how good the best hit was.
       *
       * Set by the recall handler, read by the audit middleware on `res.finish` for the per-space usefulness
       * counters. It has to travel this way: only the handler knows what the answer contained, and only the
       * middleware knows how long the whole request took and which space it was attributed to.
       *
       * This is the field that separates a useful space from one that is merely asked a lot — a space queried
       * five hundred times that answers nothing looks identical to a popular one in a call count.
       */
      recallOutcome?: { answered: boolean; topScore?: number };
    }
  }
}

/** Returns true when the bearer value looks like a PAT (Ythril-issued token). */
function isPat(bearer: string): boolean {
  return bearer.startsWith('ythril_');
}

/**
 * Resolve a bearer token to an auth record, trying PAT first and OIDC JWT
 * as a fallback when OIDC is enabled and the value is not a PAT.
 *
 * Returns null when validation fails.
 */
async function resolveBearer(
  bearer: string,
): Promise<Omit<TokenRecord, 'hash'> | OidcTokenRecord | null> {
  if (isPat(bearer)) {
    // PAT path — existing bcrypt verification
    const record = await findMatchingToken(bearer);
    if (!record) return null;
    const { hash: _h, ...safeRecord } = record;
    return safeRecord;
  }

  // Non-PAT bearer — attempt OIDC JWT validation when OIDC is enabled
  if (getOidcConfig()) {
    return validateOidcJwt(bearer);
  }

  return null;
}

/**
 * Middleware: rejects a token that cannot write anywhere.
 * Must be placed after requireAuth / requireSpaceAuth on mutating routes.
 *
 * Reads the RIGHTS MATRIX, not the removed `readOnly` flag. The predicate is deliberately the same one
 * that flag expressed — `migrateToken` turned `readOnly: true` into a `read` rung, so "holds write in
 * dataQuality somewhere" is the identical answer for every token the migration produced.
 *
 * It stays coarse because its callers are: seventeen mutating routes across conflicts, contradictions and
 * duplicates, none of which is space-scoped. `requireSpaceAuth` never runs for them, so `enforceAreaRung`
 * never sees them, and this was their only write guard. A route that NAMES a space must not use this —
 * `canWriteAnywhere` would let a token scoped to space A mutate through a route touching space B.
 */
export function denyReadOnly(req: Request, res: Response, next: NextFunction): void {
  const rights = (req.authToken as { rights?: TokenRights } | undefined)?.rights;
  if (!canWriteAnywhere(rights)) {
    res.status(403).json({ error: 'This token has read-only access' });
    return;
  }
  next();
}

/**
 * Query-string auth for streams the browser `EventSource` API opens (it cannot set an `Authorization`
 * header). A token in a URL leaks into access logs, proxy logs, browser history and `Referer`, so a browser
 * stream takes a single-use `?ticket=` — minted by an authenticated `POST …/ticket`, exchanged back to the
 * bearer here (see auth/sse-ticket.ts). The list stays anchored and GET-only so the fallback cannot widen to
 * other routes.
 *
 * **No route accepts a raw `?token=` any more.** Exactly one ever did: `GET /mcp`, the MCP SSE transport,
 * whose clients might not have been able to set a header. 4.0 removes that transport — `POST /mcp` has been
 * the recommended one throughout 3.x and its clients send an `Authorization` header — so the exception is
 * deleted rather than emptied. An allowlist with no entries fails closed, but it is a mechanism looking for
 * a consumer, and the next route that cannot set a header should have to argue for itself rather than find
 * a list already waiting.
 */
// Browser SSE streams authenticated via a single-use ?ticket= (never the raw token).
const TICKET_PATHS = new Set([
  '/api/about/logs/stream', // admin audit-log live tail (EventSource)
]);
const TICKET_PATH_PATTERNS: RegExp[] = [
  /^\/api\/brain\/spaces\/[^/]+\/events$/, // live brain-change stream (F12, EventSource)
];

/** Request path without query string or trailing slash (`/` when empty). */
function pathOf(req: Request): string {
  const pathOnly = (req.originalUrl.split('?')[0] ?? '').replace(/\/+$/, '');
  return pathOnly || '/';
}

function allowsTicket(req: Request): boolean {
  if (req.method !== 'GET') return false;
  const p = pathOf(req);
  return TICKET_PATHS.has(p) || TICKET_PATH_PATTERNS.some(re => re.test(p));
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  // Browser SSE: exchange the single-use ticket back to its bearer (keeps the token out of the URL).
  // Bound to this exact path, so a ticket can't cross to another space's stream or the log stream. A
  // request can pass through more than one auth middleware (a router-level requireAuth + a route-level
  // requireAdmin), so exchange the ticket ONCE and cache it on the request — single-use is enforced
  // across requests (each gets a fresh req), but stays consistent within one.
  if (allowsTicket(req)) {
    if (req.sseTicketBearer !== undefined) return req.sseTicketBearer;
    const ticket = req.query['ticket'];
    const bearer = (typeof ticket === 'string' && ticket.trim())
      ? consumeSseTicket(ticket.trim(), pathOf(req))
      : null;
    req.sseTicketBearer = bearer;
    return bearer;
  }
  return null;
}

// ── Shared auth core ─────────────────────────────────────────────────────────
// The require* middlewares below share the same extract → resolve → attach
// preamble, plus a couple of common predicates (admin, MFA, space scope). These
// helpers hold each in one place so a change — a new metric, an audit hook, an
// OIDC tweak — is made once instead of mirrored by hand across ~6 functions.

/**
 * Attach the resolved record, refresh a PAT's `lastUsed`, and METER the request against the token's quota.
 *
 * ## Why the metering lives here, and why this function consumes `next`
 *
 * There are NINE auth entry points — `requireAuth`, `requireMcpAuth`, `requireSpaceAuth`, the admin variants,
 * the MFA one — and each resolves a record and attaches it separately. Applying the per-token limiter at any
 * one of them would leave the other eight uncounted, and a quota with a hole in it is not a quota. Applying it
 * at all nine works until somebody adds a tenth.
 *
 * So the function that ATTACHES a token is the function that METERS it, and it takes `next` rather than letting
 * the caller call it. A new auth path cannot attach a token without metering, because attaching is how a
 * request proceeds: there is no `next()` left for a caller to reach on its own.
 *
 * It also cannot be applied any earlier than this. The limit is a property of the token, so until the record is
 * resolved there is nothing to read it from — which is exactly why the pre-auth `globalRateLimit` keys on a
 * hash of the credential and identifies nothing.
 *
 * `tokenRateLimit` calls `next()` on a pass and answers 429 on a hit.
 */
function attachToken(
  req: Request,
  res: Response,
  next: NextFunction,
  record: Omit<TokenRecord, 'hash'> | OidcTokenRecord,
  bearer: string,
): void {
  req.authToken = record;
  // Update lastUsed asynchronously for PAT tokens — do not block the request.
  if (isPat(bearer) && 'id' in record) touchToken(record.id);
  tokenRateLimit(req, res, next);
}

/**
 * Extract and resolve the bearer, writing the shared 401 responses. Returns the
 * resolved record (and the raw bearer) on success, or null once a response has
 * been sent — callers must `return` immediately on null.
 *
 * `onChallenge` runs just before a 401 (to attach a `WWW-Authenticate` header).
 * `recordInvalidMetric` preserves the historical behaviour where only the
 * non-admin paths increment `authAttemptsTotal{result="invalid"}`.
 */
async function resolveAuthOrFail(
  req: Request,
  res: Response,
  opts: { onChallenge?: (res: Response) => void; recordInvalidMetric?: boolean } = {},
): Promise<{ record: Omit<TokenRecord, 'hash'> | OidcTokenRecord; bearer: string } | null> {
  const bearer = extractBearer(req);
  if (!bearer) {
    if (opts.onChallenge) opts.onChallenge(res);
    res.status(401).json({ error: 'Missing Authorization header' });
    return null;
  }
  const record = await resolveBearer(bearer);
  if (!record) {
    if (opts.recordInvalidMetric) authAttemptsTotal.inc({ result: 'invalid' });
    logAuthFailure(req);
    if (opts.onChallenge) opts.onChallenge(res);
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
  return { record, bearer };
}


/** Enforce instance-admin; writes 403 and returns false when the token is not one. */
function enforceAdmin(res: Response, record: Omit<TokenRecord, 'hash'> | OidcTokenRecord): boolean {
  if (!isInstanceAdmin(record)) {
    res.status(403).json({ error: 'Admin token required' });
    return false;
  }
  return true;
}

/**
 * Admin for THIS instance, or administrator of at least one space.
 *
 * ## Why this is a second guard and not a change to `enforceAdmin`
 *
 * `enforceAdmin` is one function behind every admin route — spaces, networks, instance settings, the database
 * page, tokens. Widening it would hand a space administrator the instance, so the widening is applied at the
 * routes where "for my space" is a meaning the route can carry, and `enforceAdmin` is left exactly as it was
 * everywhere else.
 *
 * ## Passing this guard is not permission to do anything
 *
 * It is permission to be CONSIDERED. Every route behind it still runs `refusalsOutsideEditorScope`, which is
 * fed by `editorScopeFor` and confines a space-restricted editor to its own spaces' rows — no `instanceAdmin`,
 * no `createSpaces`, no floor, no foreign per-space rights. That guard is what makes opening this door safe,
 * and it shipped first (#916) for exactly that reason.
 *
 * So the two together read: this token may reach the token routes because it administers a space, and what it
 * may then write is bounded by which spaces those are.
 */
function enforceAdminOrSpaceAdmin(
  res: Response,
  record: Omit<TokenRecord, 'hash'> | OidcTokenRecord,
): boolean {
  if (isInstanceAdmin(record)) return true;
  // Narrowed rather than cast wholesale: `rights` is the only field this decision reads, and naming it here
  // is what stops the predicate quietly growing a second input later.
  const withRights = record as { rights?: TokenRights | null };
  // `administersAnySpace`, not a row count: a token whose admin comes from the FLOOR holds no per-space
  // rows, and counting rows read that as administering nothing — a flat refusal where the guide promises a
  // scoped listing. See the function's own note.
  if (administersAnySpace(withRights)) return true;
  res.status(403).json({ error: 'Admin token required' });
  return false;
}

/**
 * Does this token need a second factor on an MFA-gated route?
 *
 * Pure, exported, and separate from the middleware so the policy can be enumerated without an HTTP request —
 * it is three lines and each one is a security decision.
 *
 * The token's own setting wins over the instance switch in BOTH directions, because the instance switch is
 * all-or-nothing and that is the reported defect: turning MFA on made it mutually exclusive with automation.
 * An absent setting is `inherit`, so every token that exists today keeps exactly its current behaviour.
 */
export function mfaRequiredFor(
  record: Pick<TokenRecord, 'mfa'> | { mfa?: undefined },
  instanceEnabled: boolean,
): boolean {
  if (record.mfa === 'exempt') return false;
  if (record.mfa === 'required') return true;
  return instanceEnabled;
}

/**
 * Enforce a current TOTP code for PAT sessions when this token needs one. Writes the
 * MFA_REQUIRED / MFA_INVALID 403 and returns false on failure. OIDC sessions are
 * exempt (the IdP handles its own step-up auth).
 */
function enforceMfa(
  req: Request,
  res: Response,
  bearer: string,
  // An OIDC record carries no `mfa` field and never reaches the check anyway — `isPat` is false for it, and
  // the IdP owns its own step-up auth. Typed as the union so the call sites do not have to narrow.
  record?: Omit<TokenRecord, 'hash'> | OidcTokenRecord,
): boolean {
  const mfa = record && 'mfa' in record ? { mfa: record.mfa } : {};
  if (isPat(bearer) && mfaRequiredFor(mfa, isMfaEnabled())) {
    const code = (req.headers['x-totp-code'] as string | undefined ?? '').trim();
    if (!code) {
      res.status(403).json({ error: 'MFA_REQUIRED' });
      return false;
    }
    if (!verifyMfaCode(code)) {
      res.status(403).json({ error: 'MFA_INVALID' });
      return false;
    }
  }
  return true;
}

/**
 * Enforce the token's `spaces` allowlist against a space id (proxy-aware).
 * Writes 403 and returns false when the token lacks access. Unrestricted tokens
 * (no `spaces` allowlist) always pass.
 */
/**
 * The AREA check, layered on top of reach — and deliberately staged.
 *
 * A route the inventory does not resolve at RUNTIME falls through to the reach check alone, with a warning.
 * That is not the permissive default this feature exists to remove: reach is still enforced, so this can
 * only ever be stricter than yesterday, never looser. What it cannot yet be is COMPLETE, because
 * `req.baseUrl + req.route.path` is the only way to reconstruct the inventory key at runtime and nested
 * routers can make that disagree with the registered path.
 *
 * The warning is the point. It names the key that missed, so the log says exactly which routes still need
 * the mapping before misses can be turned into refusals — which is the follow-up. Flipping to refuse now
 * would 403 real traffic on any route whose key I reconstructed wrongly, and I have no runtime evidence yet
 * that I did not.
 */
/** The spaces a request actually touches: a proxy's members, or the space itself. Shared so the reach check
 *  and the area check can never disagree about WHAT they are checking. */
/**
 * The members of `spaceId` this token may actually see — the proxy NARROWED, not the proxy expanded.
 *
 * ## The defect this closes
 *
 * A proxy space became grantable to a scoped token in 2.6.0, and the ask it answered was explicit about the
 * shape: *"expand it through the token's own scope rather than through its full member list. A token holding
 * ['qa','team'] would recall across qa and nothing else."*
 *
 * It shipped grantable and never narrowing. This function returned the FULL member list, and
 * `enforceAreaRung` then walked it refusing on the first member the token lacked — so a token scoped to 22
 * spaces, with the commons deliberately absent, got `403 Token needs 'read' on knowledge in space 'general'`
 * for the whole proxy. A token holding `['qa','team']` recalled across **nothing**.
 *
 * The reporter located it precisely: a proxy over the same members MINUS the commons read 200 and returned
 * results. So proxy-to-a-scoped-token worked; only the narrowing did not, and the difference between the two
 * cases was a member the token cannot see.
 *
 * ## Why here rather than in the area guard
 *
 * The reach check already computed this subset and threw it away. Two callers then asked the un-narrowed
 * question, which is the same "one rule, two answers" shape that produced the ER lane bug the same day. So the
 * narrowing lives in the one place both the reach check and the area check read from, and a member the token
 * cannot reach is DROPPED from the expansion — never converted into a refusal for the whole proxy.
 *
 * A caller that may see NO member still gets a 403, from the reach check: narrowing to nothing is not access.
 */
function spaceTargets(spaceId: string | undefined, record?: Omit<TokenRecord, 'hash'> | OidcTokenRecord): string[] {
  if (!spaceId) return [];
  const memberIds = resolveMemberSpaces(spaceId);
  const all = memberIds.length > 0 ? memberIds : [spaceId];
  if (!record) return all;

  const rights = (record as { rights?: Parameters<typeof reachesSpace>[0] }).rights;
  // No matrix reaches NOTHING. It used to fall through to the legacy `spaces` allowlist, where an absent one
  // meant unrestricted — so a record carrying neither reached every member. The refusal is not lost by
  // failing closed here: the line below hands the original back, and the reach guard owns the 403.
  const reachable = rights ? all.filter(sid => reachesSpace(rights, sid)) : [];

  // Narrowing a real (non-proxy) space to nothing must not silently become "check no space at all": the reach
  // guard owns that refusal, and handing back the original keeps its 403 the one a caller sees.
  return reachable.length > 0 ? reachable : all;
}

function enforceAreaRung(
  res: Response,
  record: Omit<TokenRecord, 'hash'> | OidcTokenRecord,
  req: Request,
  targets: string[],
): boolean {
  const rights = (record as { rights?: Parameters<typeof effectiveRung>[0] }).rights;

  const routePath = `${req.baseUrl ?? ''}${(req.route as { path?: string } | undefined)?.path ?? ''}`;
  const verdict = rungFor(req.method, routePath);
  // A route on NOT_AREA_SCOPED is DECIDED, not missed, so it says nothing. Warning on it told an operator to
  // add it to ROUTE_RIGHTS — which would undo the recorded decision — and made "once the log is clean" a state
  // four routes guaranteed could never be reached. See the note on NOT_AREA_SCOPED for the whole account.
  if (verdict.kind === 'not-area-scoped') return true;
  if (verdict.kind === 'unclassified') {
    log.warn(`Space rights: no inventory entry for '${req.method} ${routePath}' — reach enforced, area not. `
      + 'Add it to ROUTE_RIGHTS with its area and lowest rung, or to NOT_AREA_SCOPED with the reason it is not '
      + 'a view of the space\'s data; misses become refusals once the log is clean.');
    return true;
  }
  const need = verdict;
  if (need.scope !== 'path') return true;      // iterating routes gate their LOOP, not the call

  /*
   * NO MATRIX, NO AREA — and the position of this check is the fix rather than the check itself.
   *
   * It stood at the top of the function as `if (!rights) return true;  // OIDC records: reach already
   * answered for them`, which allowed the call past the AREA check entirely. Both halves of that comment had
   * expired: an OIDC session carries `rights` as a REQUIRED field derived per request from its claim
   * mapping, and the reach guard answers a different question — which spaces, not which areas within one.
   *
   * It is here rather than at the top because everything above decides whether an area rung is the question
   * at all. A route on `NOT_AREA_SCOPED` is a DECIDED exemption, and an unclassified one is reach-enforced
   * with a warning — refusing those for want of a matrix would area-scope routes the design says are not,
   * which is the opposite of the recorded decision.
   *
   * Owner, 2026-09-05: *"no matrix = refuse - no fallback no backwards compatibility anymore."* That swept
   * `tokenReachesSpace` and `editorScopeFor`; this was the fourth copy and `toolRightsRefusal` the third.
   * `spaceTargets`, forty lines above, was swept then and says so in its own comment — so this file held
   * both answers to one question, adjacent.
   */
  if (!rights) {
    res.status(403).json({
      error: `Token needs '${need.needs}' on ${need.area}, and presented no rights matrix`,
    });
    return false;
  }

  for (const sid of targets) {
    if (!satisfies(effectiveRung(rights, sid, need.area), need.needs)) {
      res.status(403).json({
        error: `Token needs '${need.needs}' on ${need.area} in space '${sid}'`,
      });
      return false;
    }
  }
  return true;
}

function enforceSpaceScope(
  res: Response,
  record: Omit<TokenRecord, 'hash'> | OidcTokenRecord,
  spaceId: string | undefined,
): boolean {
  if (!spaceId) return true;

  // A proxy is a LENS over what the caller may already see: it is usable when the token reaches AT LEAST ONE
  // member, and the read paths then serve only the members it reaches.
  //
  // This used to require ALL members, which meant a proxy could not be granted to a scoped token at all — listing it
  // in `spaces` did nothing and every call 403'd. The fleet integrator proved it was not specific to one proxy by building their
  // own over 15 spaces and getting the same refusal (Q-6).
  //
  // **This is the ONLY behaviour change in Q-6**, and it is safe now because all 29 read fan-outs were narrowed
  // first — `proxy-fanout-inventory.test.js` asserts `PENDING` is empty. Flipping this beforehand would have handed
  // a token records from every member of the proxy, well-formed and with nothing to notice.
  //
  // For a NON-PROXY space nothing changes, and that deserves precision rather than trust: a real space resolves to
  // `[spaceId]`, so "reaches at least one of one" is the same predicate as "reaches all of one".
  //
  // A space missing from the config resolves to `[]`, and the fallback to `[spaceId]` keeps the answer a 403 for a
  // token that cannot reach it, rather than a 404 that would confirm the space does not exist.
  const memberIds = resolveMemberSpaces(spaceId);
  const targets = memberIds.length > 0 ? memberIds : [spaceId];

  /*
   * A record with no matrix reaches NOTHING, and this is where the old reason for the opposite lived.
   *
   * The comment here used to read: *"the legacy branch survives for records that carry no rights: OIDC-derived
   * tokens are built per request rather than read from config, so the backfill never sees them... removing it
   * would refuse every OIDC caller instead."* That stopped being true when the OIDC path started deriving a
   * matrix per request through the same `migrateToken` the migration uses — the fix that closed a hole where
   * OIDC connections were governed by the old booleans while PATs were enforced per space and per area.
   *
   * So the branch was kept alive by a reason that had expired, and what it did in the meantime was fail
   * OPEN: an absent legacy allowlist meant unrestricted, so a record carrying neither piece of scope
   * information reached every target. Failing closed here turns that into this function's own 403.
   */
  const rights = (record as { rights?: Parameters<typeof reachesSpace>[0] }).rights;
  const reachable = rights ? targets.filter(sid => reachesSpace(rights, sid)) : [];

  if (reachable.length === 0) {
    res.status(403).json({ error: `Token does not have access to space '${spaceId}'` });
    return false;
  }
  return true;
}

/**
 * Middleware that requires a valid Bearer PAT token.
 * Sets req.authToken on success.
 * SchemaLibrary-scoped tokens are rejected here — they are only valid on
 * GET /api/schema-library/public* via acceptSchemaLibraryToken.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return performAuth(req, res, next);
}

/**
 * Like {@link requireAuth}, but on a 401 it also emits an RFC 9728
 * `WWW-Authenticate: Bearer resource_metadata="…"` header pointing at the MCP
 * protected-resource metadata. This is what lets OAuth-only browser MCP clients
 * (e.g. the claude.ai custom connector) discover Ythril's authorization server
 * and begin the OAuth flow. Static bearer-token clients are unaffected.
 */
export async function requireMcpAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return performAuth(req, res, next, (r) => {
    // Imported lazily to avoid a load-order dependency on the MCP OAuth module.
    r.setHeader('WWW-Authenticate', `Bearer resource_metadata="${mcpResourceMetadataUrl()}"`);
  });
}

/** Shared auth core for requireAuth / requireMcpAuth. `onChallenge` (if given)
 *  runs immediately before a 401 is written, to attach a challenge header. */
async function performAuth(
  req: Request,
  res: Response,
  next: NextFunction,
  onChallenge?: (res: Response) => void,
): Promise<void> {
  const auth = await resolveAuthOrFail(req, res, { onChallenge, recordInvalidMetric: true });
  if (!auth) return;
  const { record, bearer } = auth;

  // schemaLibrary tokens have no space/admin access — reject them on all other routes
  if ('schemaLibrary' in record && record.schemaLibrary) {
    res.status(403).json({ error: 'Library access tokens may only be used on the schema library public endpoint' });
    return;
  }

  authAttemptsTotal.inc({ result: 'success' });
  attachToken(req, res, next, record, bearer);
}

/**
 * Middleware for GET /api/schema-library/public* routes.
 * The route is unauthenticated by default, but ALSO accepts a valid
 * schemaLibrary Bearer token so that instances behind a reverse proxy
 * that requires Bearer credentials can still browse the catalog.
 * Any other token type present in the header is rejected with 403
 * (don't silently ignore an invalid/wrong-scope credential).
 */
export async function acceptSchemaLibraryToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const bearer = extractBearer(req);
  if (!bearer) { next(); return; } // no auth header — public access

  const record = await resolveBearer(bearer);
  if (!record) {
    authAttemptsTotal.inc({ result: 'invalid' });
    logAuthFailure(req);
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (!('schemaLibrary' in record) || !record.schemaLibrary) {
    res.status(403).json({ error: 'Only library access tokens may be used on this endpoint' });
    return;
  }

  authAttemptsTotal.inc({ result: 'success' });
  attachToken(req, res, next, record, bearer);
}

/**
 * Middleware requiring a valid PAT **and** that the token reaches the space named by `req.params[paramName]`.
 *
 * ## Why the parameter name is an argument
 *
 * Because getting it wrong is SILENT. `enforceSpaceScope` returns `true` when the id is undefined — correctly, since
 * a route with no space in its path has no scope to check — so a guard bound to a parameter the route does not have
 * authenticates and waves the request through. It reads as enforcement at the mount site and enforces nothing.
 *
 * That is not hypothetical. Three space read routes leaked a space's schema, purpose and usage notes to any
 * authenticated token; the first fix mounted `requireSpaceAuth` on them, which reads `spaceId`, while those routes use
 * `:id`. The middleware was right, the mount looked right, and the leak was untouched — caught by a red-team test
 * afterwards, not by the source gate that had just gone green.
 *
 * So the binding is explicit and asserted: `space-routes-honour-token-scope.test.js` requires a route declaring `:id`
 * to use a guard bound to `'id'`, which a bare `requireSpaceAuth` cannot satisfy.
 */
export function requireSpaceAuthScoped(paramName: string) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const auth = await resolveAuthOrFail(req, res, { recordInvalidMetric: true });
    if (!auth) return;
    const { record, bearer } = auth;

    const spaceId = req.params[paramName] as string | undefined;
    if (!enforceSpaceScope(res, record, spaceId)) return;
    if (!enforceAreaRung(res, record, req, spaceTargets(spaceId, record))) return;

    authAttemptsTotal.inc({ result: 'success' });
    req.resolvedSpaceId = spaceId;
    attachToken(req, res, next, record, bearer);
  };
}

/**
 * Middleware that requires a valid Bearer PAT token AND that the token has access to `req.params.spaceId`.
 *
 * The `spaceId` binding of {@link requireSpaceAuthScoped}, kept as its own export because the brain and file routers
 * mount it dozens of times and every one of them names the parameter `spaceId`.
 */
export const requireSpaceAuth = requireSpaceAuthScoped('spaceId');

/**
 * Like requireAdminMfa, but also enforces the token's `spaces` allowlist
 * against the space ID found in `req.params[paramName]`.
 *
 * Use this on admin endpoints that target a specific space (e.g. schema
 * mutation, wipe, export, import) so that space-restricted admin tokens
 * cannot operate on spaces outside their allowlist.
 */
/**
 * The area rung on THIS space, plus the second factor. No admin requirement of any kind.
 *
 * ## Why it exists
 *
 * `POST /:id/validate-schema` is a dry run — it scans stored data against a schema and writes nothing — and
 * its `ROUTE_RIGHTS` row says `schema` / `read`. It was guarded by `requireAdminOrSpaceAdminMfaScoped`, so
 * the rung the rights panel advertised could never open the door: only an instance administrator or a SPACE
 * administrator (`admin` on all FOUR areas) got in. A canary operator granted exactly what the panel asked,
 * was refused with `Admin token required`, read that as INSTANCE admin, and lost an afternoon to it twice.
 *
 * ## Why not simply `requireSpaceAuthScoped`
 *
 * Because that would drop the SECOND FACTOR, and
 * `space-admin-reaches-its-own-space-settings.test.js` pins MFA on this route as deliberate — *"every one of
 * them is MFA-gated, exactly as it was"*. The reported defect is the RUNG, not the factor, and the operator
 * who reported it already satisfies MFA on the neighbouring routes. Fixing more than was broken, in the
 * loosening direction, on an auth path, is not a bargain worth taking.
 *
 * So this is `requireSpaceAuthScoped` with `enforceMfa` in it: strictly the old guard minus the admin
 * demand, which is exactly the reported defect and nothing else.
 */
export function requireSpaceAuthMfaScoped(paramName: string) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const auth = await resolveAuthOrFail(req, res, { recordInvalidMetric: true });
    if (!auth) return;
    const { record, bearer } = auth;

    const spaceId = req.params[paramName] as string | undefined;
    if (!enforceSpaceScope(res, record, spaceId)) return;
    if (!enforceMfa(req, res, bearer, record)) return;
    if (!enforceAreaRung(res, record, req, spaceTargets(spaceId, record))) return;

    authAttemptsTotal.inc({ result: 'success' });
    req.resolvedSpaceId = spaceId;
    attachToken(req, res, next, record, bearer);
  };
}

export function requireAdminMfaScoped(paramName: string) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const auth = await resolveAuthOrFail(req, res, {});
    if (!auth) return;
    const { record, bearer } = auth;

    if (!enforceAdmin(res, record)) return;
    if (!enforceMfa(req, res, bearer, record)) return;

    // Space-scope enforcement for space-restricted admin tokens.
    // Tokens without a spaces allowlist (unrestricted admin) are always allowed.
    const spaceId = req.params[paramName] as string | undefined;
    if (!enforceSpaceScope(res, record, spaceId)) return;
  if (!enforceAreaRung(res, record, req, spaceTargets(spaceId, record))) return;

    attachToken(req, res, next, record, bearer);
  };
}

/**
 * As `requireAdminMfaScoped`, and the administrator of THAT SPACE also passes.
 *
 * Owner ruling P-8 = B, 2026-08-15, second clause: *"those are INSTANCE admin things. B and includes the rest
 * of the matrixes rungs for this space."* A space administrator gets their space — its tokens (shipped) and
 * its own settings (this). Creating a space, reordering the instance's spaces and joining a network stay where
 * they were, because there is no space to scope them to.
 *
 * ## The scope check is the ADMISSION here, not a filter after it
 *
 * `requireAdminOrSpaceAdmin` admits any space administrator and lets `refusalsOutsideEditorScope` bound what
 * they may then write. That works for the token routes, where the body names its own subject. A space route
 * has no such body: the subject is `req.params[paramName]`, so the space being administered has to BE the
 * space in the URL or the guard grants nothing it can take back.
 *
 * Hence `isSpaceAdminFor(rights, spaceId)` rather than `spaceAdminSpacesFor(...).length > 0`. Administering
 * space A must not open space B's settings, and the looser predicate would have done exactly that.
 *
 * ## The instance-admin path is unchanged
 *
 * Byte for byte the old order — MFA, then the space-reach check, then the area rungs. A token that passes
 * today passes identically, which is what keeps this a widening at one named door rather than a rewrite of
 * the guard every admin route shares.
 *
 * (It said *"then the legacy allowlist"*. The ORDER is unchanged; what that step reads is not — it has been
 * the rights matrix since 4.0 removed the allowlist, and calling it by the old name is how a reader
 * concludes there is still a fallback to find.)
 */
export function requireAdminOrSpaceAdminMfaScoped(paramName: string) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const auth = await resolveAuthOrFail(req, res, {});
    if (!auth) return;
    const { record, bearer } = auth;
    const spaceId = req.params[paramName] as string | undefined;

    if (!isInstanceAdmin(record)) {
      // Narrowed to the one field the decision reads, for the same reason `enforceAdminOrSpaceAdmin` does it.
      const withRights = record as { rights?: TokenRights | null };
      if (!spaceId || !isSpaceAdminFor(withRights.rights, spaceId)) {
        res.status(403).json({ error: 'Admin token required' });
        return;
      }
    }

    if (!enforceMfa(req, res, bearer, record)) return;
    // Only meaningful on the instance-admin path: a space administrator was admitted by the space id itself,
    // so the reach check has nothing left to narrow. Run unconditionally anyway — a guard that is skipped
    // for one class of caller is the shape of every "one rule, two implementations" defect in this repo.
    if (!enforceSpaceScope(res, record, spaceId)) return;
    if (!enforceAreaRung(res, record, req, spaceTargets(spaceId, record))) return;

    attachToken(req, res, next, record, bearer);
  };
}

/** Middleware: requires a valid PAT **with admin: true**.
 *  Must be used after (or instead of) requireAuth on admin-only routes.
 *  Non-admin tokens receive 403 even if they are otherwise valid.
 *
 *  Note: OIDC JWT tokens are also accepted when OIDC is enabled — the
 *  admin flag is derived from the configured claimMapping.admin rule.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await resolveAuthOrFail(req, res, {});
  if (!auth) return;
  const { record, bearer } = auth;

  if (!enforceAdmin(res, record)) return;

  attachToken(req, res, next, record, bearer);
}

/**
 * As `requireAdmin`, but a matrix SPACE ADMINISTRATOR also passes — see `enforceAdminOrSpaceAdmin`.
 *
 * Used only where "for my space" is a meaning the route can carry, which today is the token routes. Owner
 * ruling P-8 = B, 2026-08-15. Every route behind it still applies `refusalsOutsideEditorScope`, so passing
 * this is permission to be considered rather than permission to act.
 */
export async function requireAdminOrSpaceAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await resolveAuthOrFail(req, res, {});
  if (!auth) return;
  const { record, bearer } = auth;

  if (!enforceAdminOrSpaceAdmin(res, record)) return;

  attachToken(req, res, next, record, bearer);
}

/** As `requireAdminMfa`, and a matrix space administrator also passes. See `requireAdminOrSpaceAdmin`. */
export async function requireAdminOrSpaceAdminMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await resolveAuthOrFail(req, res, {});
  if (!auth) return;
  const { record, bearer } = auth;

  if (!enforceAdminOrSpaceAdmin(res, record)) return;
  // MFA is unchanged: a space administrator is still a human with an authenticator, and exempting one would
  // make "space admin" a way around the instance-wide second factor.
  if (!enforceMfa(req, res, bearer, record)) return;

  attachToken(req, res, next, record, bearer);
}

/**
 * Middleware: requires a valid admin PAT **and**, when MFA is enabled,
 * a valid TOTP code in the `X-TOTP-Code` header.
 *
 * When MFA is disabled (no `totpSecret` in secrets.json) this behaves
 * identically to `requireAdmin` so enabling MFA is purely additive.
 *
 * Note: OIDC JWT tokens are also accepted when OIDC is enabled.  MFA is
 * NOT enforced for OIDC sessions (the IdP handles its own step-up auth).
 *
 * Error codes returned (distinguish from generic 403 on the client):
 *   403 { error: 'MFA_REQUIRED' } — MFA enabled, header missing
 *   403 { error: 'MFA_INVALID'  } — MFA enabled, code wrong / expired
 */
/**
 * A valid token and the second factor. No admin demand, and no space to scope to.
 *
 * ## Why it exists
 *
 * The three data-quality sweeps -- `POST /api/duplicates/scan`, `POST /api/contradictions/scan` and
 * `POST /api/conflicts/seed` -- take NO space. They walk every space the token can reach, and their
 * `ROUTE_RIGHTS` rows are `scope: 'iterates'`: the enforcement point is the ITERATION SET, not the call.
 *
 * That half was already right. Each handler narrows its loop with `accessibleSpaces(req, 'write')`, so a
 * token only ever scans spaces where it holds the rung. What made the rows unreachable was the guard in
 * front: `requireAdminMfa` refused everyone but an instance administrator before the loop was reached, so
 * the `dataQuality` column in the rights panel could never open these doors either.
 *
 * This is `requireAdminMfa` minus `enforceAdmin`, exactly -- the same auth, the same second factor. It runs
 * no area check of its own on purpose: an iterating route has no single space to check one against, and
 * adding one here would be a second, weaker copy of the narrowing the handler already does.
 */
export async function requireAuthMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await resolveAuthOrFail(req, res, {});
  if (!auth) return;
  const { record, bearer } = auth;

  if (!enforceMfa(req, res, bearer, record)) return;

  attachToken(req, res, next, record, bearer);
}

export async function requireAdminMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await resolveAuthOrFail(req, res, {});
  if (!auth) return;
  const { record, bearer } = auth;

  if (!enforceAdmin(res, record)) return;
  if (!enforceMfa(req, res, bearer, record)) return;

  attachToken(req, res, next, record, bearer);
}
