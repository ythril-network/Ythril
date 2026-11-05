/**
 * The second-factor attempt counter: five wrong codes lock a token (and a trustworthy source address) for up to 15 minutes (Q-694).
 *
 * ## What it prevents
 *
 * `verifyMfaCode` answered true or false and remembered nothing, so the holder of a stolen admin token could try six-digit codes at the
 * rate of the one limiter in front of them (10 a minute on one door, the flood backstop on the others): about 14 000 guesses a day at
 * 3 in 1 000 000 each, and the second factor, the one thing that stands between a stolen token and its admin acts, was a long guess away.
 * Every door that asks for a code (`enforceMfa` in `auth/middleware.ts`, the exemption grant in `api/tokens.ts`, `POST /api/mfa/verify`)
 * asks `tryMfaCode` instead of the verifier, and a gate holds that no other source names the verifier.
 *
 * ## What it holds
 *
 * - A sliding window per key: `MFA_FAILURES_MAX` wrong codes inside `MFA_LOCKOUT_WINDOW_MS` lock the key. Each failure leaves the window
 *   that long after IT was made, so a lock does not lift for all failures at once. From the next attempt on, a CORRECT code included, the
 *   answer is `locked` with the seconds until the oldest failure leaves, and the verifier is not asked, so a locked attempt spends no step.
 * - Two keys: the TOKEN (always) and the source ADDRESS (only where the address can be trusted, below). The token key is asked first.
 * - Only a `wrong` code counts. A correct code counts and clears nothing. A replay, a stale code (the client's cached code, a script's fixed
 *   one) and a code with no secret to judge it against are refused AS A WRONG CODE IS and never counted: an honest administrator resending
 *   what the client cached must not lock themselves out, and no answer tells a guesser which of the four it hit (`judgeMfaCode`).
 * - The address key counts only when it is true: `trust proxy` is configured (the client address is then the proxy's report), or the socket's
 *   own address is not private, loopback or link-local (`isBlockedIp`). Behind the default Docker gateway or an unconfigured proxy every
 *   caller shares one private address, so counting it would let one token's guesses lock every administrator; there the token key alone
 *   counts. The cost: a caller holding several stolen tokens gets five tries per token rather than five per address.
 * - A bounded table (`MFA_KEYS_MAX`) in two insertion-ordered maps, so that making room is O(1) and never evicts a running lock: the key
 *   whose last failure is oldest and whose lock is not running goes first. When the table is full of running locks the new failure is not
 *   recorded (the attempt is still refused), `ythril_mfa_lockout_evictions_total` counts it and one warning per window says so. A key is
 *   made by a recorded failure only (a replay, a no-code request or a locked attempt makes none) and dropped once its failures have all left.
 * - A lock START is the recorded failure that brings a key to the limit, and the one place it is counted (`ythril_mfa_lockouts_total{key}`),
 *   logged and audited (`mfa.locked`, the token id and the address; the write is not awaited).
 *
 * ## Why it is synchronous
 *
 * The lock check, the verifier and the record of a wrong code are three steps that must not be pulled apart. Node runs one synchronous
 * stretch to its end, so two requests carrying wrong codes cannot both pass the check at four failures and both be recorded as the fifth.
 * Nothing here waits (a gate refuses `await`, `async`, a promise and a dynamic import in this file).
 *
 * The table lives in this process's memory: a restart empties it (an attacker gets a fresh five), and two replicas count apart. The
 * deployment this guards is one instance; the audit row and the counter are what an operator watches.
 */
import type { Request } from 'express';
import { judgeMfaCode } from './totp.js';
import { isBlockedIp } from '../util/ssrf.js';
import { clientAddressKey, clientRateLimitKey } from '../rate-limit/middleware.js';
import { mfaLockoutsTotal, mfaLockoutEvictionsTotal } from '../metrics/registry.js';
import { logInternalAudit } from '../audit/audit.js';
import { MFA_LOCKED_OPERATION } from '../audit/middleware.js';
import { log, peerText } from '../util/log.js';

/** Wrong codes inside the window that lock a key. The docs state this number; a gate reads it from here. */
export const MFA_FAILURES_MAX = 5;
/** How long after it was made a wrong code still counts, and so the longest a lock runs. The docs state it in minutes; a gate reads it from here. */
export const MFA_LOCKOUT_WINDOW_MS = 15 * 60_000;
/** The most keys (tokens and addresses together) the table holds. */
export const MFA_KEYS_MAX = 10_000;

/** What a key is: the token that sent the codes, or the source address they came from. */
export type MfaLockKey = 'token' | 'address';

/** The answer of a key whose lock is running. `retryAfterSeconds` is whole seconds, at least 1. */
export interface MfaLock { ok: false; reason: 'locked'; key: MfaLockKey; retryAfterSeconds: number }

/** What {@link tryMfaCode} answers: the code was good, was refused (`invalid`, for every reason but a lock), or a lock is running. */
export type MfaAttempt = { ok: true } | { ok: false; reason: 'invalid' } | MfaLock;

/** The failures of one key, oldest first, none older than the window once pruned. */
interface Entry { failures: number[] }

/** Keys with no running lock, oldest last failure first (a key is re-inserted on each failure, so the order is the last failure's). */
const open = new Map<string, Entry>();
/** Keys that reached the limit, in the order they did; their locks may have run out since, which a later touch or an eviction finds out. */
const locked = new Map<string, Entry>();

let clock: () => number = Date.now;
/** The last time a full table was warned about, so a flood of dropped failures writes one line per window, not one per request. */
let evictionWarnedAt: number | null = null;

/**
 * Replace the clock the window is measured on (milliseconds, `null` for the real one). For a test that must move time; reachable from server
 * code only, no route calls it.
 */
export function setMfaClock(fn: (() => number) | null): void {
  clock = fn ?? Date.now;
}

/** Empty the table (a test starts each case from nothing; no route calls this). */
export function resetMfaAttempts(): void {
  open.clear();
  locked.clear();
  evictionWarnedAt = null;
}

/** The entry of `key`, in whichever map it is. */
function entryOf(key: string): Entry | undefined {
  return open.get(key) ?? locked.get(key);
}

/** Drop the failures that have left the window. */
function prune(entry: Entry, now: number): void {
  while (entry.failures.length > 0 && entry.failures[0]! <= now - MFA_LOCKOUT_WINDOW_MS) entry.failures.shift();
}

/** Seconds until `key`'s lock lifts, or null when none is running. An entry whose failures have all left is dropped here. */
function lockSecondsOf(key: string, now: number): number | null {
  const entry = entryOf(key);
  if (!entry) return null;
  prune(entry, now);
  if (entry.failures.length === 0) {
    open.delete(key);
    locked.delete(key);
    return null;
  }
  if (entry.failures.length < MFA_FAILURES_MAX) return null;
  return Math.max(1, Math.ceil((entry.failures[0]! + MFA_LOCKOUT_WINDOW_MS - now) / 1000));
}

/**
 * Make room for one more key, or say there is none. Looks at the front of each order only: the open key with the oldest last failure goes
 * first; with none open, the oldest-locked key goes when its lock has run out. A running lock is never evicted.
 *
 * Not a `LruMap` (`util/lru-map.ts`) on purpose: that drops the least recently used entry whatever it holds, and the one entry this table
 * must never drop is a running lock, which is exactly what an attacker filling the table would want dropped.
 */
function makeRoom(now: number): boolean {
  if (open.size + locked.size < MFA_KEYS_MAX) return true;
  const [oldestOpen] = open.keys();
  if (oldestOpen !== undefined) {
    open.delete(oldestOpen);
    return true;
  }
  const [oldestLocked] = locked;
  if (oldestLocked !== undefined) {
    const [key, entry] = oldestLocked;
    prune(entry, now);
    if (entry.failures.length < MFA_FAILURES_MAX) {
      locked.delete(key);
      return true;
    }
  }
  return false;
}

/** Everything a lock start writes: the counter, one log line and one audit row (not awaited; a failing audit write never changes the answer). */
function announceLock(kind: MfaLockKey, tokenId: string, req: Request): void {
  mfaLockoutsTotal.inc({ key: kind });
  const address = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  log.warn(`MFA lockout started on the ${kind} key: ${MFA_FAILURES_MAX} wrong codes in ${MFA_LOCKOUT_WINDOW_MS / 60_000} minutes, token ${peerText(tokenId)}, address ${peerText(address)}`);
  try {
    logInternalAudit({
      method: 'LOCK',
      path: `internal:mfa-lock:${kind}`,
      operation: MFA_LOCKED_OPERATION,
      tokenId,
      ip: address,
      status: 429,
    });
  } catch (err) {
    log.warn(`The MFA lockout audit row was not written: ${peerText(err)}`);
  }
}

/** Record a wrong code against `key`: a lock start when it is the one that reaches the limit, a dropped failure (counted) when the table is full of running locks. */
function recordFailure(key: string, kind: MfaLockKey, tokenId: string, req: Request, now: number): void {
  let entry = entryOf(key);
  if (entry) {
    prune(entry, now);
    open.delete(key);
    locked.delete(key);
  } else {
    if (!makeRoom(now)) {
      mfaLockoutEvictionsTotal.inc();
      if (evictionWarnedAt === null || now - evictionWarnedAt >= MFA_LOCKOUT_WINDOW_MS) {
        evictionWarnedAt = now;
        log.warn(`The MFA lockout table is full of running locks (${MFA_KEYS_MAX} keys): a wrong code was refused but not recorded`);
      }
      return;
    }
    entry = { failures: [] };
  }
  entry.failures.push(now);
  if (entry.failures.length >= MFA_FAILURES_MAX) {
    locked.set(key, entry);
    if (entry.failures.length === MFA_FAILURES_MAX) announceLock(kind, tokenId, req);
  } else {
    open.set(key, entry);
  }
}

/**
 * Whether the request's source address may be counted: trust proxy is configured (`req.ip` is then the client the proxy reports), or the
 * socket's own address is a public one. A private, loopback or link-local socket with no proxy configured is the shared gateway of every
 * caller, and an address nobody can tell apart is not a key.
 */
function addressIsTrustworthy(req: Request): boolean {
  // Read from the settings table, not through the app's getter: the route inventory takes a getter call with a string for a GET route.
  if (req.app.settings['trust proxy']) return true;
  const socketAddress = req.socket?.remoteAddress;
  return typeof socketAddress === 'string' && socketAddress !== '' && !isBlockedIp(socketAddress);
}

/** The lock a key is under, as an answer. */
function lockAnswer(kind: MfaLockKey, seconds: number): MfaLock {
  return { ok: false, reason: 'locked', key: kind, retryAfterSeconds: seconds };
}

/**
 * The lock the TOKEN key is under, or null. For the door that must answer a locked token before it asks for a code (`enforceMfa`): a token
 * that cannot succeed is not prompted for a code. Reads only; it makes no key and counts nothing.
 */
export function mfaLockOfToken(tokenId: string): MfaLock | null {
  const seconds = lockSecondsOf(`t:${tokenId}`, clock());
  return seconds === null ? null : lockAnswer('token', seconds);
}

/**
 * Ask whether `code` is the caller's current second-factor code, and count it when it is a guess.
 *
 * Checks the token's lock, then the address's (when it counts); a running lock answers `locked` and the verifier is not asked. Otherwise the
 * verifier judges the code: `ok` answers `{ ok: true }`; `wrong` is recorded against the token key and, where the address is trustworthy, the
 * address key, and answers `{ ok: false, reason: 'invalid' }`; replay, stale and unset answer `invalid` too and record nothing.
 *
 * The answer is an OBJECT: a site reads `.ok` (a gate holds that no call reads it as a boolean, which an object always is). A throw from the
 * store while a step is burned propagates: it is neither a verdict nor a guess.
 *
 * @param tokenId the id of the token the code is sent with (`mfaTokenIdOf`)
 */
export function tryMfaCode(code: string, { tokenId, req }: { tokenId: string; req: Request }): MfaAttempt {
  const now = clock();
  const tokenKey = `t:${tokenId}`;
  const addressKey = addressIsTrustworthy(req) ? `a:${clientAddressKey(req)}` : null;

  const tokenSeconds = lockSecondsOf(tokenKey, now);
  if (tokenSeconds !== null) return lockAnswer('token', tokenSeconds);
  if (addressKey !== null) {
    const addressSeconds = lockSecondsOf(addressKey, now);
    if (addressSeconds !== null) return lockAnswer('address', addressSeconds);
  }

  const verdict = judgeMfaCode(code);
  if (verdict === 'ok') return { ok: true };
  if (verdict === 'wrong') {
    recordFailure(tokenKey, 'token', tokenId, req, now);
    if (addressKey !== null) recordFailure(addressKey, 'address', tokenId, req, now);
  }
  return { ok: false, reason: 'invalid' };
}

/**
 * The id a request's second-factor attempts are counted under: its token's id, else (a caller with no stored id) the shared client key of its
 * credential. One definition so the three doors count one token under one key. A guard that runs before the token is attached to the request
 * (`enforceMfa`) passes the record it resolved; the doors behind the guards read the attached one.
 */
export function mfaTokenIdOf(req: Request, record?: { id?: string }): string {
  return (record ?? (req.authToken as { id?: string } | undefined))?.id ?? clientRateLimitKey(req);
}
