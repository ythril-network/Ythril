/**
 * TOTP helpers — wraps otplib for MFA on admin routes.
 *
 * The TOTP secret is stored as a base32 string in secrets.json under
 * `totpSecret`.  When that field is absent MFA is considered disabled and
 * all `requireAdminMfa`-gated routes behave like `requireAdmin`.
 *
 * Standard TOTP parameters (RFC 6238):
 *   - algorithm  : SHA-1 (broadest authenticator compatibility)
 *   - step        : 30 s
 *   - digits      : 6
 *   - window      : ±1 step (clock skew tolerance)
 */

import crypto from 'node:crypto';
import { generateSecret, generateURI } from 'otplib';
import { getSecrets, saveSecrets } from '../config/loader.js';

// ── RFC 4648 base32 decode ────────────────────────────────────────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const c of cleaned) {
    const val = BASE32.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return Buffer.from(bytes);
}

// ── RFC 6238 TOTP computation ─────────────────────────────────────────────

function computeTotp(secret: string, epoch: number, step = 30, digits = 6): string {
  const counter = BigInt(Math.floor(epoch / step));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = (
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!
  ) % (10 ** digits);
  return code.toString().padStart(digits, '0');
}

/** True when a TOTP secret is stored in secrets.json */
export function isMfaEnabled(): boolean {
  return !!getSecrets().totpSecret;
}

/**
 * Generate a new TOTP secret, persist it, and return:
 *   - `secret`  — base32 string (show to user for manual entry)
 *   - `otpauth` — otpauth:// URI for QR-code generation
 */
export function enableMfa(issuer: string, label: string): { secret: string; otpauth: string } {
  const secret = generateSecret(); // 160-bit (20-byte) base32 secret
  const otpauth = generateURI({ issuer, label, secret });
  const secrets = getSecrets();
  secrets.totpSecret = secret;
  // A fresh secret has no consumed steps — clear any counter from a prior enrolment.
  delete secrets.totpLastStep;
  saveSecrets(secrets);
  return { secret, otpauth };
}

/** Remove the TOTP secret, disabling MFA */
export function disableMfa(): void {
  const secrets = getSecrets();
  delete secrets.totpSecret;
  delete secrets.totpLastStep;
  saveSecrets(secrets);
}

const TOTP_STEP_SECONDS = 30;

/**
 * How far back a code still counts as STALE rather than WRONG: 15 minutes of steps, the span the client keeps the last code it was given
 * (`mfa.service.ts`). A code from this span is one a person or a script once held, not a guess.
 */
const STALE_STEPS_BACK = 30;

/** What {@link judgeMfaCode} says of one code. */
export type MfaVerdict = 'ok' | 'wrong' | 'replay' | 'stale' | 'unset';

/**
 * Judge a 6-digit TOTP code against the stored secret, and say WHY it is refused, so that only a guess is counted as one.
 *
 * - `ok`     - the code of the current step or one beside it (±1, a 30 s window each way), above the last step consumed. That step is
 *              burned: saved as `totpLastStep` before the answer is given.
 * - `replay` - a code of that window whose step is at or below the last consumed one.
 * - `stale`  - the code of a step within the last 15 minutes but outside the window (the client's cached code, a script's fixed code).
 * - `wrong`  - matches no step in the window or the last 15 minutes.
 * - `unset`  - no secret is stored; there is nothing to judge.
 *
 * ## What it prevents
 *
 * A boolean verifier lets a lockout counter treat every `false` as a guess. The client resends the code it was given on every change
 * (`mfa.service.ts`) and each step is accepted once, so an honest administrator's resends are replays and a cached code is stale; counting
 * them locks out the person the lockout protects. The caller (`tryMfaCode`) counts `wrong` and nothing else, and answers the other three
 * exactly as it answers `wrong`, so the words never reach a caller that could use them as an oracle.
 *
 * ## How
 *
 * `crypto.timingSafeEqual` over every step, always all of them (the window and the stale span), so which step matched, and whether the
 * code was a replay, stale or wrong, is not leaked by timing. A refused judgement burns nothing. A throw from the store while burning
 * the step is not caught: it is neither a verdict nor a guess.
 */
export function judgeMfaCode(code: string): MfaVerdict {
  const secrets = getSecrets();
  const { totpSecret } = secrets;
  if (!totpSecret) return 'unset';

  const normalizedCode = Buffer.from(code.padStart(6, '0').slice(0, 6));
  const now = Math.floor(Date.now() / 1000);

  // Always iterate all windows to prevent timing leakage of which window matched.
  // `matchedStep` records WHICH step matched so it can be burned below.
  let matchedStep = -1;
  for (const offset of [-TOTP_STEP_SECONDS, 0, TOTP_STEP_SECONDS]) {
    const epoch = now + offset;
    const expected = Buffer.from(computeTotp(totpSecret, epoch));
    const isMatch = crypto.timingSafeEqual(normalizedCode, expected);
    if (isMatch) matchedStep = Math.floor(epoch / TOTP_STEP_SECONDS);
  }

  // The steps before the window, up to 15 minutes back, always all of them: a replay, a stale code and a wrong one take the same time.
  let stale = false;
  for (let back = 2; back <= STALE_STEPS_BACK; back++) {
    const expected = Buffer.from(computeTotp(totpSecret, now - back * TOTP_STEP_SECONDS));
    if (crypto.timingSafeEqual(normalizedCode, expected)) stale = true;
  }

  if (matchedStep < 0) return stale ? 'stale' : 'wrong';

  // Replay guard: refuse a step at or below the last consumed one.
  const lastStep = secrets.totpLastStep ?? -1;
  if (matchedStep <= lastStep) return 'replay';

  secrets.totpLastStep = matchedStep;
  saveSecrets(secrets);
  return 'ok';
}

/**
 * Verify a 6-digit TOTP code against the stored secret: true only for {@link judgeMfaCode}'s `ok`.
 * Returns false if MFA is not enabled or the code is wrong.
 *
 * Checks the current step ±1 (30 s window) using crypto.timingSafeEqual to
 * prevent timing side-channel attacks, then enforces **single use**: the
 * matched step must be strictly greater than the highest step already consumed
 * (`secrets.totpLastStep`). Without this, a code captured in transit — from a
 * proxy log, a shoulder-surf, or a phished operator — stays replayable for the
 * remainder of its up-to-90 s validity window, which is exactly the window an
 * attacker with a stolen admin PAT needs to disable MFA.
 *
 * No door of the server calls this: each asks `tryMfaCode` (`auth/code-attempts.ts`), which counts the wrong codes. It stays for a test that
 * asks whether a code is still spendable, which must not count one.
 */
export function verifyMfaCode(code: string): boolean {
  return judgeMfaCode(code) === 'ok';
}
