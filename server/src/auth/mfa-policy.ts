import type { TokenRecord } from '../config/types.js';

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
