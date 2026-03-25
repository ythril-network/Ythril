/**
 * TOTP helpers — wraps otplib v2 for MFA on admin routes.
 *
 * The TOTP secret is stored as a base32 string in secrets.json under
 * `totpSecret`.  When that field is absent MFA is considered disabled and
 * all `requireAdminMfa`-gated routes behave like `requireAdmin`.
 *
 * Standard TOTP parameters (RFC 6238):
 *   - algorithm  : SHA-1 (broadest authenticator compatibility)
 *   - step        : 30 s
 *   - digits      : 6
 *   - epochTolerance: 30 s (±1 step clock skew)
 */

import { generateSecret, generateURI, verifySync } from 'otplib';
import { getSecrets, saveSecrets } from '../config/loader.js';

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
  saveSecrets(secrets);
  return { secret, otpauth };
}

/** Remove the TOTP secret, disabling MFA */
export function disableMfa(): void {
  const secrets = getSecrets();
  delete secrets.totpSecret;
  saveSecrets(secrets);
}

/**
 * Verify a 6-digit TOTP code against the stored secret.
 * Returns false if MFA is not enabled or the code is wrong.
 * Allows ±30 s clock skew via epochTolerance.
 */
export function verifyMfaCode(code: string): boolean {
  const { totpSecret } = getSecrets();
  if (!totpSecret) return false;
  const result = verifySync({ token: code, secret: totpSecret, epochTolerance: 30 });
  return result.valid;
}
