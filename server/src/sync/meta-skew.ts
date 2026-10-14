/**
 * Which members of a space's networks may REFUSE what a schema write sets — the writer's one warning for a rolling upgrade (`R6-7`, Q-217).
 *
 * ## What it prevents
 *
 * A meta key a release adds (`stampSkew`, `rules`) reaches every member as part of the network's layer. A member on the release BEFORE
 * that one refuses a meta carrying a key it does not know whole (its body is strict), so the new key does not arrive as an unread key:
 * the member's whole layer is refused, once per cycle, and the writer — whose own write answered success — is never told. From this
 * release a receiver reads what it knows and reports the rest (`readPeerMeta`), so the NEXT key added is not this problem again; the
 * members still on the old release are what this module speaks for.
 *
 * Capability negotiation (refuse the write until every member announces the key) was the first answer and was withdrawn: it cannot reach a
 * member beyond the direct peers, a member that never reports deadlocks it, and an announcement can be forged. What a release CAN do on
 * its own is say, at the moment of the write, which members it cannot show are on a release that reads the key. D-24 is the precedent for
 * how a mixed network is told to upgrade; the write is NOT refused, because a network of one upgraded instance and some old ones is the
 * ordinary state of a rolling upgrade and the operator decides whether to go on.
 *
 * ## One question, and what is inside so no caller can drop it
 *
 * *"For these keys, which members are not known to read them?"* — `peerRunsAtLeast`, which answers `false` for an absent or unparseable
 * version, so a member that never reported one is named like an older one: a member we cannot show is current is one we cannot promise
 * will read the key. A member's label is the networks area's to read, so this module returns labels and the CALLER decides who sees them
 * (`networkWriteNotice`): a warning must not be the way round `networks: read`.
 *
 * ## The table is a fact about releases, and a gate holds it
 *
 * `NEW_META_KEYS` and `NEW_TYPE_FIELDS` say, per key, the first release that reads it. They are NOT derived from the body — the body at
 * run time cannot know what the previous release's accepted — so `the-since-table-names-every-key-new-since-the-previous-release` loads
 * the previous release's body and holds the two tables equal to the difference, in both directions: a key added to the body and not here
 * is a warning nobody gets, and a key here that the previous release already reads is a warning about nothing.
 */
import type { NetworkConfig, NetworkMember, SpaceMeta } from '../config/types.js';
import { boundedNames, PER_TYPE_META_FIELD } from '../spaces/meta-fields.js';
import { peerRunsAtLeast } from './peer-floor.js';

/**
 * The first release that reads each top-level meta key the previous release (`v5.6.10`) refuses. 5.7.0 is the next minor above every
 * published 5.6.x, as `FILE_META_REMOVAL_SINCE` reads it.
 */
export const NEW_META_KEYS: Readonly<Record<string, string>> = Object.freeze({
  stampSkew: '5.7.0',
  rules: '5.7.0',
});

/** The same for a type's own fields (`typeSchemas.<kind>.<type>.<field>`): the first release that reads each the previous one refuses. */
export const NEW_TYPE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  rules: '5.7.0',
});

/** One group of new keys a write sets, and the members that may refuse them. */
export interface MemberSkew {
  /** The release that reads these keys. */
  since: string;
  /** The keys the write sets: a top-level name, or `typeSchemas.<kind>.<type>.<field>` for a type's field. Bounded. */
  keys: string[];
  /** The labels of the members not known to run `since` or later. Whether a caller may be shown them is the caller's question. */
  members: Array<{ label: string; networkId: string; neverHeardFrom: boolean }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The new keys a proposal sets, by the release that reads them: its top-level keys and, inside the types it carries, the fields of each
 * type. A key set to `undefined` is a clear, which an older member never sees as a key.
 */
function newKeysSet(proposal: SpaceMeta | undefined): Map<string, string[]> {
  const bySince = new Map<string, string[]>();
  const add = (since: string, key: string) => bySince.set(since, [...(bySince.get(since) ?? []), key]);
  for (const [field, value] of Object.entries(proposal ?? {})) {
    if (value !== undefined && Object.hasOwn(NEW_META_KEYS, field)) add(NEW_META_KEYS[field]!, field);
  }
  const held = (proposal as Record<string, unknown> | undefined)?.[PER_TYPE_META_FIELD];
  for (const [kind, types] of Object.entries(isObj(held) ? held : {})) {
    for (const [type, def] of Object.entries(isObj(types) ? types : {})) {
      for (const [field, value] of Object.entries(isObj(def) ? def : {})) {
        if (value !== undefined && Object.hasOwn(NEW_TYPE_FIELDS, field)) add(NEW_TYPE_FIELDS[field]!, `${PER_TYPE_META_FIELD}.${kind}.${type}.${field}`);
      }
    }
  }
  return bySince;
}

/**
 * The members of `networks` (the networks a write reaches) that are not known to read the new keys `proposal` sets — one entry per release
 * that reads a group of them, none when the write sets no new key or every member is known to be current.
 *
 * A member in two of the networks is one member. The instance itself is not a member of its own networks.
 */
export function membersBehindNewKeys(proposal: SpaceMeta | undefined, networks: readonly Pick<NetworkConfig, 'id' | 'members'>[]): MemberSkew[] {
  const out: MemberSkew[] = [];
  for (const [since, keys] of newKeysSet(proposal)) {
    const behind = new Map<string, MemberSkew['members'][number]>();
    for (const net of networks) {
      for (const member of net.members as readonly NetworkMember[]) {
        if (peerRunsAtLeast(member, since) || behind.has(member.instanceId)) continue;
        // Never exchanged with (`versionCheckedAt` unset) is a different thing from a peer that answered and named a version below
        // `since`: the first may be current and just not heard from, the second is not. Both are named; the answer says which.
        behind.set(member.instanceId, { label: member.label, networkId: net.id, neverHeardFrom: !member.versionCheckedAt });
      }
    }
    if (behind.size > 0) out.push({ since, keys: boundedNames(keys), members: [...behind.values()] });
  }
  return out;
}
