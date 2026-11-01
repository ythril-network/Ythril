/**
 * Which member keys does this audience see? One question, one allow list per audience (bundle-81, design rev 8 §3b, decisions 17 and 60).
 *
 * ## The leak it closes
 *
 * A member row carries this instance's own bookkeeping about a peer: the per-space marks (how far it has read the peer and sent to it), the frozen 5.6 marks, the
 * re-read cursors, the 6.0 sync stamp. The views were built by SUBTRACTION: `safeMemberList` removed `tokenHash` and `skipTlsVerify` and handed a joining instance every
 * other key; `networkView` removed two cursors by name; the member routes and the sync roster each removed a handful. So every key a release added went out on
 * `GET /api/networks[/:id]`, on MCP `network_get`, on the join answer and to every peer that asked for the roster, until somebody remembered to destructure it,
 * and nothing reports a key that should not have been shown.
 *
 * Here a view is built by ADDITION: {@link memberView} picks the keys of the audience's list from the member, so a key nobody listed is not shown. The audience is a
 * parameter, not a module of its own: the views differ only by which list they read.
 *
 * ## The audiences (five doors, one function)
 *
 *  - `admin`: `GET /api/networks`, `GET /api/networks/:id` and MCP `network_get` - the joiner's keys plus status (`lastSyncAt`, the failure count, the spaces the member
 *    declined). No mark of any kind and no owed marker: the re-read debt is the view's own field, `rereadOwed` (`networks/network-acts.ts`).
 *  - `operator`: the answer to adding a member by hand (`POST /api/networks/:id/members`, MCP `network_member_add`): what the operator needs to see of the row it made.
 *  - `joiner`: the member list a joining instance receives once admitted: identity and topology only.
 *  - `peer`: the roster `GET /api/sync/networks/:id/members` serves to a peer: identity and topology, which is all a peer's merge reads.
 *  - `pending`: the candidate a join round in flight carries, served to peers with the round: the same keys.
 *
 * ## What is withheld, and where it is named
 *
 * Every key of `NetworkMember` is shown to some audience or withheld by name: the per-space marks (`PER_SPACE_WATERMARKS`, which includes the frozen
 * `ROLLBACK_MARKS` and the full-re-read state) and {@link WITHHELD_MEMBER_KEYS}. `every-member-key-is-shown-or-withheld` derives the keys from the type and holds
 * that, and that no key is both: a new member key is invisible until someone decides.
 */
import type { NetworkMember } from '../config/types.js';

/** The audiences a member row is shown to. */
export type MemberAudience = 'admin' | 'operator' | 'joiner' | 'peer' | 'pending';

/** Identity and topology: all a joining instance, a peer's roster merge and a candidate in a round need. */
const IDENTITY_KEYS = [
  'instanceId', 'label', 'url', 'direction', 'parentInstanceId', 'originalParentInstanceId', 'children',
  'signingPublicKey', 'version', 'versionCheckedAt', 'admittedAt', 'introducedBy',
] as const satisfies readonly (keyof NetworkMember)[];

/** Status an administrator reads on the member row: the last exchange, how it is going, and the spaces the member declined. */
const STATUS_KEYS = ['lastSyncAt', 'consecutiveFailures', 'consecutiveLocalFaults', 'declinedSpaces'] as const satisfies readonly (keyof NetworkMember)[];

/** The keys of `NetworkMember` each audience is shown. */
export const MEMBER_VIEW_KEYS = {
  admin: [...IDENTITY_KEYS, ...STATUS_KEYS],
  operator: [...IDENTITY_KEYS, ...STATUS_KEYS],
  joiner: [...IDENTITY_KEYS],
  peer: [...IDENTITY_KEYS],
  pending: [...IDENTITY_KEYS],
} as const satisfies Record<MemberAudience, readonly (keyof NetworkMember)[]>;

/**
 * Member keys no audience is shown, beside the per-space marks (which the type's own list, `PER_SPACE_WATERMARKS`, names): the credentials, and the 6.0 sync stamp, which
 * is this instance's bookkeeping about when a 5.6 build last synced with the member (`sync/member-status.ts`).
 */
export const WITHHELD_MEMBER_KEYS = ['tokenHash', 'skipTlsVerify', 'lastSyncAtBy6'] as const satisfies readonly (keyof NetworkMember)[];

/** `member` as `audience` may see it: the keys of its list that the member holds, and nothing else. */
export function memberView(member: Partial<NetworkMember>, audience: MemberAudience): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of MEMBER_VIEW_KEYS[audience]) {
    const value = member[key as keyof NetworkMember];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
