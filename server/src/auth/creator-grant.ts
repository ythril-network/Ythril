/**
 * The creator of a space administers it (`Q-134`).
 *
 * Owner, 2026-09-28: *"Creator of a space gets space admin."* Without it, a token holding `createSpaces` and per-space
 * rows but no floor creates a space it cannot read or write — the right would produce something its holder is locked
 * out of. So the grant lives inside `createSpace`, the one writer every creating door reaches (REST, MCP, a join, an
 * adoption), and not in each door: a door written next year cannot forget it.
 *
 * It widens exactly one thing: the created space joins `rights.spaceAdmin.spaces`. The floor, `instanceAdmin`,
 * `createSpaces` and every per-space row are left as they are.
 *
 * - `granted` — the stored token did not administer the space and now does. The caller audits it.
 * - `already` — it administers the space already (by name, or by the all-spaces floor an instance admin holds).
 * - `not-stored` — no stored token by that id, or one with no matrix. An OIDC session is the real case: its rights are
 *   derived per request from the identity provider's mapping, so there is nothing to persist, and the mapping governs.
 * - `no-creator` — the create had nobody to credit (the caller said so with `null`).
 *
 * Pure over the config it is handed; the caller saves it in the same write as the space.
 */
import type { TokenRights } from '../config/rights-shape.js';
import { administers } from './mint-cap.js';

export type CreatorGrant = 'granted' | 'already' | 'not-stored' | 'no-creator';

export function grantCreatorAdmin(
  cfg: { tokens?: { id: string; rights?: TokenRights | null }[] },
  tokenId: string | null,
  spaceId: string,
): CreatorGrant {
  if (tokenId === null) return 'no-creator';
  const token = cfg.tokens?.find(t => t.id === tokenId);
  const rights = token?.rights;
  if (!rights) return 'not-stored';
  if (administers(rights, spaceId)) return 'already';
  const sa = rights.spaceAdmin ?? { floor: false, spaces: [] };
  rights.spaceAdmin = { floor: sa.floor, spaces: [...sa.spaces, spaceId] };
  return 'granted';
}
