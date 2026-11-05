/**
 * The TOTP codes a test sends, computed by the test and not by the server - the question "what does this authenticator show at a given step?"
 * asked once for every file that drives the second factor (bundle-233, Q-694).
 *
 * ## Why a module of our own
 *
 * The server judges a code against the stored secret at the steps now-1, now and now+1, and burns the step it accepted. A test that wants
 * a code that is CORRECT, one that is STALE (right once, 5 minutes ago) or one that is plainly WRONG has to name the step it means: a
 * literal `'000000'` is correct one time in 333,333 and a flaky red nobody can read. This file computes the code for a step offset from now
 * with the RFC 6238 parameters the server uses (SHA-1, 30 s, 6 digits), independently of server/dist, so a defect in the server's own
 * computation cannot make a test agree with it.
 *
 * `wrongCode` is a code that is not the code of ANY step in the last 20 minutes or the next 2: it is wrong, not stale.
 * `staleCode` is the code of a step `stepsAgo` steps back (default 10 = 5 minutes): outside the +-1 window, inside the last 15 minutes.
 * Successive correct codes of one secret must be used in ascending step order (-1, 0, +1): the server refuses a step at or below the last
 * one it consumed, so `codeAtStep(secret, 0)` after `codeAtStep(secret, 1)` is a replay.
 */
import crypto from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;

function base32Decode(input) {
  let bits = '';
  for (const c of input.toUpperCase().replace(/=+$/, '')) {
    const v = BASE32.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const out = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

/** The six digits an authenticator shows for `secret` in the step containing `epochSeconds`. */
export function totpAt(secret, epochSeconds) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(epochSeconds / STEP_SECONDS)));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** The code of the step `offset` steps from the current one (-1, 0 and +1 are inside the server's window). */
export function codeAtStep(secret, offset) {
  return totpAt(secret, Math.floor(Date.now() / 1000) + offset * STEP_SECONDS);
}

/** A code the server's window and its stale memory both refuse: not the code of any step from 40 steps ago to 4 steps ahead. */
export function wrongCode(secret) {
  const held = WRONG_FOR.get(secret);
  if (held) return held;
  const known = new Set();
  for (let k = -40; k <= 4; k++) known.add(codeAtStep(secret, k));
  for (let n = 0; n < 1_000_000; n += 7919) {
    const c = String(n).padStart(6, '0');
    if (!known.has(c)) { WRONG_FOR.set(secret, c); return c; }
  }
  throw new Error('no wrong code found');
}
/** Kept per secret: a test sends tens of thousands of wrong codes, and the margin (40 steps back, 4 ahead) outlasts the run. */
const WRONG_FOR = new Map();

/** The code of a step `stepsAgo` steps back: outside the +-1 window, inside the last 15 minutes. */
export function staleCode(secret, stepsAgo = 10) {
  const code = codeAtStep(secret, -stepsAgo);
  const inWindow = [-1, 0, 1].map(k => codeAtStep(secret, k));
  if (inWindow.includes(code)) throw new Error('the stale code collides with a code inside the window; run again');
  return code;
}

/** A code from 20 minutes ago: past the stale memory, so wrong. */
export function ancientCode(secret) {
  const code = codeAtStep(secret, -40);
  const near = [];
  for (let k = -31; k <= 1; k++) near.push(codeAtStep(secret, k));
  if (near.includes(code)) throw new Error('the ancient code collides with a nearer one; run again');
  return code;
}
