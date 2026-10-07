/**
 * May this DELIVERY delete that OBJECT here? — the one answer for a peer's tombstone, for records and for files, on
 * both doors (bundle-51, D-14 = C).
 *
 * ## The question, and why it is asked in one place
 *
 * A peer's tombstone deletes a held record or file only if somebody this instance trusts to speak for it said so. The
 * rule was spelled inline in `applyPeerTombstones` (the delivering peer must BE the issuer, and the issuer must be the
 * record's author), and the file-tombstone door did not ask at all — it deleted any path any peer named (Q-242). Two
 * doors, two spellings, the weaker one winning silently: that is the defect this repo produces most. So the rule is
 * here, and `a-tombstone-authority-is-compared-in-one-module` holds that no other file compares an issuer, an author,
 * a deliverer or a stamp against one another.
 *
 * ## The grounds (`authorises`) — ANY OF
 *
 *  - **absent** — nothing is held under the id. The tombstone is stored so that this node can relay it onward (a
 *    deletion may arrive before its record); it deletes nothing, and it is never a decline.
 *  - **issuer** — the delivery PROVES the issuer (a trusted admin relays any issuer's; a peer must be the issuer) and the
 *    issuer governs the target's author (`tombstoneGoverns`: the same instance, or either side unknown). The rule as it
 *    was — except that a FILE row arriving bytes created has no author to govern (`fileTargetOf`, Q-405).
 *  - **upstream** — on a DIRECTIONAL network (pub/sub, braintree) the deliverer is this space's direct upstream and the
 *    stored `deliveredBy` stamp of the target IS that deliverer, whoever wrote it, and it was not written HERE. That is
 *    the owner's ruling D-14: what an upstream relayed, it may delete downstream. This instance's own records and every
 *    other peer's stay protected, and a compromised publisher can delete what it relayed — the accepted cost.
 *
 * ## What it carries INTO the write (`deleteBound`)
 *
 * `authorises` decides from a READ, and the delete is a later WRITE: a record another author wrote, or a stamp that
 * changed, in between must not be taken with it. So each ground has its own bound, spelled once here and carried by the
 * delete itself, which re-checks the verdict instead of trusting it. A bound that cannot be built from what it is given
 * THROWS — `{ deliveredBy: undefined }` is dropped by the driver and matches rows it was never meant to reach, and
 * `{ deliveredBy: '' }` matches every record that arrived with no peer deliverer (an admin push, a local write, a
 * pre-release row), which is exactly what the upstream ground must never touch.
 *
 * ## The two small state machines that ride along
 *
 *  - `backfillStamp` stamps a row stored BEFORE the stamp existed, once, with the upstream — and only where the upstream
 *    was the only way a record could have reached the space. It errs toward `''` (nobody's delivery): a stamp given to a
 *    row the upstream never sent would hand it the power to delete data it never relayed, which is one row more than D-14
 *    accepted.
 *  - `nextRereadState` folds one cycle's outcome into the state of the one-time re-read of an upstream's tombstones
 *    (absent = owed from the start, a cursor = owed from there, `'done'` = finished and never asked again).
 *
 * Pure, and importing no database: every branch is decidable from a config and the arguments. (`deliveryOfMember` is the one
 * that reads the live config for its caller, and only to hand it to `deliveryOf`.)
 */
import type { Config } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { isDirectionalNetwork, isUpstreamPeer, upstreamOf } from '../networks/network-spaces.js';
import { networksHolding } from '../spaces/wipe-vote.js';
import { peersReachingOnlyByToken } from './served-watermark.js';
import { tombstoneGoverns } from './upsert-plan.js';
import { isArrivedPlaceholder } from '../files/file-meta.js';

/**
 * The longest instance id a tombstone's issuer may be named by. The issuer is a peer's text that is compared with the
 * deliverer and the record's author, stored on a relayed tombstone and written into log lines, so both wire shapes of a
 * tombstone (a record's, `sync/tombstone-apply.ts`, and a file's, `files/peer-tombstone-apply.ts`) bound it by this one number.
 */
export const MAX_ISSUER = 256;

/** What a door knows about who delivered a page, before this instance's config says what that is worth. */
export interface DeliveryAuth {
  /** The authenticated peer that delivered the page (the peer pulled from, or the pusher's bound identity). */
  peerInstanceId?: string;
  /** True for a trusted instance administrator relaying on anyone's behalf (a push by a non-peer admin token). */
  trustedRelay?: boolean;
}

/** A delivery as the deletion authority reads it. Built by `deliveryOf` and by nothing else. */
export interface Delivery {
  peerInstanceId?: string;
  trustedRelay: boolean;
  /** The deliverer is the direct upstream of a directional network carrying the space being applied to. */
  upstream: boolean;
}

/** Why a delivery may delete a held object — the ground the verdict names, and the bound the write carries. */
export type DeletionGround = 'issuer' | 'upstream';

export type Verdict =
  | { ok: true; ground: DeletionGround | 'absent' }
  | { ok: false; reason: 'not_issuer' | 'not_author' | 'not_upstream' };

/** What a verdict is asked of: a held record or file row, as far as authority reads it. */
export interface DeletionTarget {
  author?: { instanceId?: string };
  deliveredBy?: string;
}

/**
 * Resolve a delivery once per page, from the door's own knowledge and THIS instance's config.
 *
 * `upstream` is read from the records this instance holds about its networks (`upstreamOf`), never from anything the
 * peer said, so it fails closed: a pub/sub member stored `both`, a temporary reparent and an adopted subtree name nobody
 * as upstream. The space is the one the door ADMITTED (`localSpaceId`), and a network counts only when it carries it.
 */
export function deliveryOf(cfg: Config, localSpaceId: string, auth: DeliveryAuth): Delivery {
  const peerInstanceId = typeof auth.peerInstanceId === 'string' && auth.peerInstanceId !== '' ? auth.peerInstanceId : undefined;
  const upstream = peerInstanceId !== undefined
    && networksHolding(localSpaceId, cfg).some(net => isDirectionalNetwork(net) && isUpstreamPeer(net, peerInstanceId));
  return { peerInstanceId, trustedRelay: auth.trustedRelay === true, upstream };
}

/**
 * The delivery of a page THIS instance pulled from `member`, against the live config: the peer pulled from is the
 * authenticated source, so its id is the deliverer and nothing it says is read. The one spelling for the pull side (the record
 * tombstone pull, the file tombstone pull, the one-time re-read) — written inline each had to remember the live config and the
 * id, and `deliveryOf`'s door for a pushed page is `deliveryOfRequest` (`api/sync/_shared.ts`).
 */
export function deliveryOfMember(localSpaceId: string, member: { instanceId: string }): Delivery {
  return deliveryOf(getConfig(), localSpaceId, { peerInstanceId: member.instanceId });
}

/** What `fileTargetOf` reads of a held file row. */
export interface HeldFileRow extends DeletionTarget {
  seq?: number;
}

/**
 * The row of a FILE as the deletion authority reads it: a placeholder that arriving bytes created has no author (bundle-71, Q-405).
 *
 * Bytes land before their metadata when a peer R delivers a file's bytes, and `recordArrivedFile` creates the row as a
 * placeholder: seq 0, `author` = R (the deliverer, by lack of anyone else), nothing authored in it. Read as R's, the
 * file's origin O could never delete it — O's tombstone was declined `not_author` and, being declined, not stored either, so
 * the file stayed here for ever and nothing relayed its deletion on. A placeholder is recognised by what it holds: version 0
 * and an author that is only the deliverer. Such a row is returned WITHOUT its author, which `tombstoneGoverns` already
 * governs (an author-less row is deleted by whoever proves they issued the tombstone). The row stays protected the moment
 * anything authors it: metadata lands at a seq above 0 (or at 0 from an author who is not the deliverer), and then its author
 * counts as before.
 *
 * Files only. A record is never written as a placeholder, so `authorises` over a record keeps reading its author (D-14).
 * Passing a record here would hand its author's protection to whoever proves the issuer; the caller is the file apply.
 */
export function fileTargetOf<R extends HeldFileRow>(row: R): R {
  if (!isArrivedPlaceholder(row)) return row;
  const { author: _placeholderAuthor, ...authorless } = row;
  return authorless as R;
}

/**
 * May `delivery` delete `target` on behalf of a tombstone `issuer` named? `target` is `null` when nothing is held.
 *
 * A decline names the half that failed, so an operator reading it knows what to look at: `not_author` (the issuer was
 * proven and the record is another author's), `not_upstream` (the deliverer is an upstream and the stamp is not its own
 * or the record is this instance's), `not_issuer` (nothing proved the issuer, and the deliverer is no upstream).
 */
export function authorises(delivery: Delivery, issuer: string | undefined, target: DeletionTarget | null, selfId: string): Verdict {
  if (target === null) return { ok: true, ground: 'absent' };
  const deliverer = delivery.peerInstanceId;
  const author = target.author?.instanceId;
  const issuerProven = delivery.trustedRelay || (deliverer !== undefined && deliverer === issuer);
  if (issuerProven && tombstoneGoverns(issuer, author)) return { ok: true, ground: 'issuer' };
  // A blank stamp means "nobody delivered it" and never equals a deliverer; a record THIS instance wrote is never the
  // upstream's, whatever stamp it carries (D-14).
  const stampedByDeliverer = delivery.upstream && !!deliverer && target.deliveredBy === deliverer;
  if (stampedByDeliverer && author !== selfId) return { ok: true, ground: 'upstream' };
  if (issuerProven) return { ok: false, reason: 'not_author' };
  if (delivery.upstream) return { ok: false, reason: 'not_upstream' };
  return { ok: false, reason: 'not_issuer' };
}

/**
 * The predicate the delete carries, so the write re-checks the verdict (see the module docblock).
 *
 *  - `issuer`   — the issuer's own records and author-less ones, which is `tombstoneGoverns` written as a predicate. An
 *                 issuer-less tombstone governs EVERY author (as `tombstoneGoverns` says), so its bound is no author
 *                 restriction at all: a stricter bound would let the verdict say yes and the write delete nothing.
 *  - `upstream` — exactly what the deliverer stamped, minus anything THIS instance wrote. It names no author: it only
 *                 refuses one.
 *
 * Every call returns a fresh object, so a caller adding its own `_id` clause cannot alter the next bound.
 */
export function deleteBound(
  ground: DeletionGround,
  p: { issuer: string; deliverer?: string; selfId: string },
): Record<string, unknown> {
  if (ground === 'issuer') return p.issuer ? { 'author.instanceId': { $in: [p.issuer, null, ''] } } : {};
  if (!p.deliverer) throw new Error('deleteBound(\'upstream\') needs the deliverer whose stamp it matches; an absent or blank one would match rows it must never reach');
  return { deliveredBy: p.deliverer, 'author.instanceId': { $ne: p.selfId } };
}

/**
 * The stamp for a row stored before `deliveredBy` existed — the upstream's id, or `''` (see the module docblock).
 *
 * The upstream when ALL hold: every network that carries the space is directional and they all name one upstream (no
 * mesh, club, closed or democratic network carries it, and this instance is not the publisher or root of one), no peer
 * token outside the networks' membership reaches the space (a second route), and the row's author is non-empty and not
 * this instance.
 */
export function backfillStamp(cfg: Config, localSpaceId: string, row: { author?: { instanceId?: string } }, selfId: string): string {
  const author = row.author?.instanceId;
  if (!author || author === selfId) return '';
  const nets = networksHolding(localSpaceId, cfg);
  if (nets.length === 0 || !nets.every(isDirectionalNetwork)) return '';
  const upstreams = new Set(nets.map(upstreamOf));
  const [only] = upstreams;
  if (upstreams.size !== 1 || !only) return '';
  return peersReachingOnlyByToken(cfg, localSpaceId).length === 0 ? only : '';
}

/**
 * How many one-time re-reads are still owed: the (upstream, space) pairs whose state is not `'done'`, over every
 * directional network's upstream that is listed as a member here (the state lives on the member row). Read from the
 * config alone — it is what `ythril_sync_tombstone_rereads_owed` reports, so a scrape never touches the store.
 */
export function rereadsOwed(cfg: Config): number {
  const owed = new Set<string>();
  for (const net of cfg.networks ?? []) {
    if (!isDirectionalNetwork(net)) continue;
    const up = net.members?.find(m => isUpstreamPeer(net, m.instanceId));
    if (!up) continue;
    for (const space of net.spaces ?? []) {
      if (up.tombstoneRereadAt?.[space] !== 'done') owed.add(`${up.instanceId}\n${space}`);
    }
  }
  return owed.size;
}

/**
 * The state of the one-time re-read after one cycle's outcome: absent = owed from the start, a cursor = owed from there,
 * `'done'` = finished. A complete read is `'done'` from every state; a stop or a failure changes nothing, so the repair
 * stays owed (and the caller says so once per window); a partial read leaves the cursor it reached. `'done'` is
 * absorbing — a re-read re-applies deletions, and a second full read is a cost nobody asked for.
 */
export function nextRereadState(
  current: string | undefined,
  outcome: { complete: boolean; cursor?: string; stopped?: boolean },
): string | undefined {
  if (current === 'done' || outcome.complete) return 'done';
  if (outcome.stopped || outcome.cursor === undefined) return current;
  return outcome.cursor;
}
