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

/** Where a caller the MCP door refuses goes instead: the REST route that takes a code, or the page of the web UI that asks for one. */
export type MfaStepUpPlace = { route: string } | { page: string };

/**
 * The sentence an MCP door refuses a caller with who REST would ask for a second factor, or null when the caller would not be asked.
 *
 * ## What it prevents
 *
 * Four tools (`import_rdf` with `schema`, `import_schema_rdf`, `network_reread`, `view_copy`) each asked {@link callerIsAskedForMfa} and wrote
 * the sentence out; a fifth that wrote it differently, or asked a different question, would refuse one caller in two voices or let one through.
 * The question and the sentence are written here: `action` is what the caller asked for ("Re-reading a network"), `place` where to go instead.
 * The door decides the status and the error type it throws.
 */
export function mfaStepUpRefusalFor(
  record: (Pick<TokenRecord, 'mfa'> & { source?: string }) | undefined | null, action: string, place: MfaStepUpPlace,
): string | null {
  if (!callerIsAskedForMfa(record)) return null;
  const instead = 'route' in place ? ` or ${place.route}` : ` (${place.page})`;
  return `${action} needs MFA step-up, which this door cannot present; use the web UI${instead}`;
}
