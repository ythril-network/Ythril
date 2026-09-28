/**
 * Whether a token may create spaces — ONE answer for every door that creates one (`Q-134`).
 *
 * Owner, 2026-09-28: *"Create space has a extra toggle to avoid needing instance admin to create space."* The toggle is
 * `rights.createSpaces`, and it worked on one door of three: a network join read it, while `POST /api/spaces` and the
 * `save_space` tool asked for an instance administrator. Every door now asks this module, so the right cannot mean
 * one thing over REST and another over MCP.
 *
 * Instance admin implies it. Administering spaces does not: a space administrator configures the spaces it was given,
 * and creating new ones is a separate grant (a space admin cannot even mint `createSpaces`, see `mint-cap.ts`).
 */
import type { TokenRights } from '../config/rights-shape.js';
import { isInstanceAdmin } from './instance-admin.js';

type Holder = { admin?: boolean; rights?: TokenRights | null } | null | undefined;

/** The clause a compound refusal embeds — the join names what it would create, then says why it may not. */
export const CREATE_SPACES_PHRASE = 'this token may not create spaces (createSpaces)';

export function mayCreateSpaces(record: Holder): boolean {
  if (!record) return false;
  return isInstanceAdmin(record) || record.rights?.createSpaces === true;
}

/** Why this token may not create a space, or `null` when it may. The same sentence on the REST and the MCP door. */
export function createSpacesRefusal(record: Holder): string | null {
  if (mayCreateSpaces(record)) return null;
  return 'This token may not create spaces: creating one needs the createSpaces right, or instance admin.';
}
