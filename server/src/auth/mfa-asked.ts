import { mfaRequiredFor } from './mfa-policy.js';
import { isMfaEnabled } from './totp.js';
import { isOidc } from './oidc-caller.js';
import type { TokenRecord } from '../config/types.js';

/**
 * Will an MFA-gated act of this caller be asked for a second factor?
 *
 * ## The question it answers
 *
 * The one the gates ask at the moment of the act (`enforceMfa`: a personal access token, and `mfaRequiredFor` its own setting against the
 * instance switch), asked BEFORE it, so a door can say "you will be asked for a code" only when it is true. An OIDC session is never asked (its
 * identity provider owns step-up), and a caller with no record is not either. `GET /api/mfa/status` answers it as `asked`, the web UI's
 * re-read dialog shows its MFA sentence by it, and the MCP doors refuse by it where they cannot present a code.
 *
 * It exists because the sentence was written once, at the dialog, as if every instance asked: an instance with no second factor enrolled showed
 * "You are asked for your MFA code when you confirm" and then asked nothing.
 */
export function callerIsAskedForMfa(record: (Pick<TokenRecord, 'mfa'> & { source?: string }) | undefined | null): boolean {
  return !!record && !isOidc(record) && mfaRequiredFor({ mfa: record.mfa }, isMfaEnabled());
}
