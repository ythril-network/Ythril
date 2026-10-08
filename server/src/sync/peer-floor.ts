/**
 * The peer version floor — what another instance must be running to stay on the network.
 *
 * Owner's ruling on `P-33`, 2026-09-04: **B, and explicitly not A.** A would have kept the legacy
 * `excludeFromVectorSearch` spelling at 4.0 purely so that an old peer could not strip a record's
 * suppression mark. B removes the need for it: declare a floor, enforce it, and the legacy key has
 * nothing left to guard against.
 *
 * ## Two floors, and this is the one nobody had
 *
 * `_DEPRECATIONS.md` was treating them as one and the arithmetic came out wrong because of it:
 *
 * - the **upgrade floor** — what version an instance must be at to run the 4.0 migrations. Derived from
 *   when those migrations shipped, and unrelated to peers.
 * - the **peer floor** — what version another instance may be running while remaining compatible. This
 *   one. Nothing derived it, and nothing could express it: there was no `minPeerVersion` in the
 *   codebase, no version on `NetworkMember`, and no sync path that read the version `/health` reports.
 *
 * ## The floor IS the running major, and it is derived rather than chosen
 *
 * Owner, 2026-09-05: *"can we make the current major always be the version floor? that fits to 'this is
 * breaking'. That makes sure no chaining (4.1 allows 3.2, 3.2 allows 2.5,...) It also fits to
 * deprecation kills"*.
 *
 * **The chaining argument is the one that settles it, and it defeats the alternative outright.**
 * Compatibility between two instances is not transitive, but a NETWORK is: with a hand-set floor a few
 * minors back, 4.1 admits 3.2, 3.2 admits 2.5, and records travel the length of that chain even though
 * the ends were never compatible. Every hop is individually within its own floor and the path as a whole
 * is outside all of them. A floor at the running major cannot chain, because every member is inside the
 * same breaking boundary by construction.
 *
 * **And it makes the floor mean what a major already means.** A major is the release where removals
 * happen — that is what `_DEPRECATIONS.md` is a list of. So anything a major deletes cannot be needed by
 * a peer, which is exactly the guarantee `D-6` was waiting for, with no separate number to keep in step.
 *
 * **What it costs, stated plainly.** A network cannot be rolled across a major one instance at a time:
 * the moment one reaches 4.0, every 3.x peer stops syncing data until it is upgraded too. That is the
 * honest price of a breaking release rather than a defect, and the mitigation is that it is VISIBLE — a
 * badge on the member row and a refusal naming both versions, instead of records quietly not arriving.
 * The earlier draft picked 3.1.0 to preserve that rolling upgrade, and the chaining argument is what
 * makes preserving it the wrong goal.
 *
 * **Derived, so it can never go stale.** There is no floor to remember to raise at the next major, and
 * no second copy of the number to disagree with the manifest. That was the failure mode of the constant
 * it replaces: `MIN_PEER_VERSION` would still have read 3.1.0 the day 5.0 shipped, and nothing would
 * have contradicted it.
 *
 * ## Absent means two different things, and conflating them is an outage
 *
 * A peer that ANSWERED and reported no version is older than the release that started reporting one, so
 * it is below the floor. Read the other way — absent means "unknown, so allow" — every peer this floor
 * exists to refuse walks straight through, which is the shape `CLAUDE.md` names as this repo's most
 * common defect and which has shipped three times as an empty allowlist read as "unrestricted".
 *
 * **But a peer we have never exchanged with reports nothing for a completely different reason, and the
 * first version of this refused it too.** CI caught it: a member can legitimately be versionless for
 * ever. `conflicts.test.js` registers a member under an invented `instanceId` with a token carrying no
 * `peerInstanceId` — which is not a broken fixture, it is what a manually-provisioned peer and a
 * single-side-configured network both look like. Gossip can never match that member to a self-record,
 * so no version can ever arrive, so the data plane stopped for good. Fresh networks were the same
 * before their first exchange completed.
 *
 * So the floor acts on EVIDENCE, and `versionCheckedAt` is the evidence: set on every completed gossip
 * exchange whether or not a version came with it. Three outcomes rather than two — refuse a version
 * below the floor; refuse a peer that answered and named none; say NOTHING about a peer we have never
 * heard from, and let the ordinary failure counter handle a peer that cannot be reached.
 *
 * An unparseable version is refused with the first group. A claim we cannot compare is not evidence of
 * being current — and unlike silence, it only exists because the peer sent it.
 *
 * ## What this is NOT
 *
 * **It is not a defence against a peer that LIES.** A version is self-reported and unauthenticated by
 * construction, so a hostile instance can claim any number it likes. The floor exists to stop an OLD
 * peer from silently mishandling data — a compatibility control, not a security one. Anything that has
 * to hold against a hostile peer belongs in the governance and signing paths, which authenticate.
 */

import { getConfig } from '../config/loader.js';
import { SERVER_VERSION } from '../util/server-version.js';

/**
 * The minimum version a peer may run: this instance's own MAJOR, at `.0.0`.
 *
 * **Fails OPEN if our own version cannot be parsed**, which admits every peer instead of refusing every
 * peer. That is the right way round for a value that comes from our own manifest: an unparseable
 * `SERVER_VERSION` is a build defect on THIS side, and answering it by stopping the whole network's data
 * plane would turn a packaging mistake into an outage at every member. The release gate is what keeps
 * the manifest well-formed.
 */
export const MIN_PEER_VERSION = ((): string => {
  const major = Number.parseInt(SERVER_VERSION.trim().split(/[-+]/)[0]?.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? `${major}.0.0` : '0.0.0';
})();

/**
 * Compare two version strings numerically. Negative if `a` is older, positive if newer, 0 if equal.
 *
 * **Numerically, because a string comparison is a defect with a date on it.** `'10.0.0' < '9.0.0'` is
 * true for strings, so a lexicographic floor starts refusing the NEWEST peers the moment any component
 * reaches double digits — and it refuses them for being too new, which is the opposite of what the
 * message would say.
 *
 * A prerelease suffix is ignored rather than rejected: our own tags are plain, but a peer built from
 * source reports something like `4.0.0-rc.1`, and refusing that as unparseable would lock a tester out
 * of their own network for running the build they were asked to test.
 */
export function comparePeerVersions(a: string, b: string): number {
  const parts = (v: string): number[] => {
    const core = v.trim().split(/[-+]/)[0] ?? '';
    return core.split('.').map(n => Number.parseInt(n, 10));
  };
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** A version string we can actually reason about: three numeric components, suffix allowed. */
function parseable(v: string): boolean {
  const core = v.trim().split(/[-+]/)[0] ?? '';
  const parts = core.split('.');
  return parts.length === 3 && parts.every(p => /^\d+$/.test(p));
}

/**
 * Is this peer KNOWN to run `since` or later? The one question every "send the new shape only to a peer that
 * understands it" gate asks (a vote's bound signature, a file's removal list), so no site spells its own version
 * comparison or its own reading of "no version".
 *
 * **Unknown, absent and unparseable are all OLD, so this answers `false`, and that is the opposite of
 * `peerFloorRefusal` on purpose.** The floor protects the network from a peer that may mishandle data, and an
 * unparseable claim is not evidence of being current, so it refuses. This is a gate on what we SEND: a peer we cannot
 * show runs the newer version must get the shape every version accepts, because the newer one is refused by an older
 * receiver (a strict schema discards the document, and the push counts it delivered). Failing open here would send
 * every unknown peer a payload it may drop. Self is not a member and is the caller's own check.
 *
 * Takes the version string or the member that carries one, so a caller holding a `NetworkMember` is not made to
 * unwrap it (and forget that `version` is optional).
 */
export function peerRunsAtLeast(versionOrMember: string | { version?: string | null } | null | undefined, since: string): boolean {
  const version = typeof versionOrMember === 'string' ? versionOrMember : versionOrMember?.version;
  if (typeof version !== 'string' || !parseable(version.trim())) return false;
  return comparePeerVersions(version, since) >= 0;
}

/**
 * `null` if this peer may sync, otherwise the refusal to send back.
 *
 * **The message names both numbers on purpose.** The instance being refused is the one that has to be
 * upgraded, and its operator reads our refusal in their own log — so a message saying only "too old"
 * makes them come and ask. Naming what they run and what is required makes the refusal actionable
 * without a second conversation.
 */
export function peerFloorRefusal(
  version: string | null | undefined,
  /**
   * When a member-gossip exchange with this peer last COMPLETED. Omitted means never, and never means
   * this function has no evidence and returns `null` — see the module docblock. Passing it is not
   * optional for a real caller; the default exists so a caller that genuinely has a version in hand and
   * no member record (a test, a one-off comparison) is not forced to invent a timestamp.
   */
  versionCheckedAt?: string | null,
): string | null {
  const reported = typeof version === 'string' ? version.trim() : '';
  if (!reported) {
    if (!versionCheckedAt) return null;
    return `Peer reports no version, so it predates ${MIN_PEER_VERSION} — the minimum this network `
      + `requires. Upgrade the peer to ${MIN_PEER_VERSION} or later.`;
  }
  if (!parseable(reported)) {
    return `Peer reports version '${reported}', which is not a version this instance can compare `
      + `against the required minimum of ${MIN_PEER_VERSION}.`;
  }
  if (comparePeerVersions(reported, MIN_PEER_VERSION) < 0) {
    return `Peer runs ${reported}, below the minimum of ${MIN_PEER_VERSION} this network requires. `
      + `Upgrade the peer to ${MIN_PEER_VERSION} or later.`;
  }
  return null;
}

/**
 * Throw unless this member is at or above the floor. The outbound half of the enforcement.
 *
 * **Lives here rather than in the engine, and not only to keep that file from growing.** The inbound
 * middleware and this are the two halves of one rule, and one rule with two implementations is the
 * defect `CLAUDE.md` says this repo produces most. Both now sit in the module that owns the floor.
 *
 * **The version is re-read from config, not taken from the caller.** The engine holds a `member` it
 * captured before the gossip exchange, so by the time this runs that copy is a cycle stale — an
 * upgraded peer would be refused for a version it no longer runs. `reported` is the fallback for the
 * case where the network or member has since gone.
 *
 * **Throwing rather than returning a verdict** is deliberate: the cycle counts an error and surfaces
 * the reason, and a cycle reporting success while a member is silently excluded sends an operator
 * looking at the network instead of at the version.
 */
export function assertPeerAtFloor(networkId: string, instanceId: string, reported?: string): void {
  const member = getConfig().networks
    .find(n => n.id === networkId)?.members
    .find(m => m.instanceId === instanceId);
  const refusal = peerFloorRefusal(member?.version ?? reported, member?.versionCheckedAt);
  if (refusal) throw new Error(refusal);
}
