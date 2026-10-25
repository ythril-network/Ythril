/**
 * What a push to a member selects, by the network's type — in one module (bundle-81, design rev 8 §6 "Push selection", decision 1).
 *
 * ## The question it answers
 *
 * "Which of this space's rows does a push on THIS network offer?" It used to be answered at three places (`space-exchange.ts`'s `ownedFilter` by
 * author, `push-family.ts`'s author-guarded watermark, and the tombstone push, which sent every stored tombstone). Now:
 *
 *  - **braintree and pubsub** (`isDirectionalNetwork`): everything — records and tombstones. They relay: a record or deletion a node holds goes on down the tree.
 *  - **closed, democratic and club** (the mesh): the records WRITTEN HERE (`writtenHere: true`, the local bit `sync/written-here.ts` stamps at landing —
 *    delivery first, so a peer's text never makes a row ours), and the tombstones ISSUED HERE (`issuedHere: true`, the local mark
 *    `sync/issued-here.ts`, never the sender's `instanceId`). A mesh peer pulls everything else from the instance that wrote it.
 *  - **solo** (a space in no network): no transfer, so no selection.
 *
 * ## What it prevents
 *
 * The weaker copy winning: the record selection by AUTHOR let a peer's rows that named this instance as author be re-pushed as its own, and the
 * tombstone push forwarded every relayed deletion as if this instance had issued it. A push that reads its selection from here cannot ask either
 * question by itself. A relayed tombstone is not lost on a mesh: it carries a position of this instance's stream and is served by pull.
 */
import type { NetworkConfig } from '../config/types.js';
import { isDirectionalNetwork } from '../networks/network-spaces.js';
import { issuedHereFilter } from './issued-here.js';

/** What the push of one network offers, as the `extra` filter of the position read: `{}` is everything. */
export interface PushSelection {
  /** For every record family (composed with the family's own `pushFilter`). */
  readonly records: Readonly<Record<string, unknown>>;
  /** For the brain tombstones. */
  readonly tombstones: Readonly<Record<string, unknown>>;
}

/** The selection of a push on `net`: everything on a relaying network, what this instance wrote or issued on a mesh. */
export function pushSelection(net: Pick<NetworkConfig, 'type'>): PushSelection {
  if (isDirectionalNetwork(net)) return { records: {}, tombstones: {} };
  return { records: { writtenHere: true }, tombstones: issuedHereFilter() };
}
