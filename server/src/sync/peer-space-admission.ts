/**
 * What happens when a PEER's request meets a space, written once for every door a peer reaches a space through (bundle-106, design v5
 * section 3.3, W13): the sync routes, the rights middleware and the tool dispatch.
 *
 * ## What it prevents
 *
 * The same three steps were spelled at five sites, and the one that spelled two of them was the weaker copy: a peer that meets a HELD
 * space is counted in `ythril_space_held_refusals_total` and answered `423 space_held` (which its sender reads as "held", never as a failed
 * transfer of the whole member), and a peer that is admitted is counted in the fence for as long as the request is open, so an act registered
 * meanwhile waits for it instead of deleting under it. The tool dispatch refused without counting and admitted without entering the fence,
 * so the metric an operator watches for held peers under-counted every tool refusal, and a peer's `recall` could be reading a space while its
 * wipe began deleting from it.
 *
 * Here the three steps are one function per medium: the count and the admission are {@link admitPeer} (the admission IS the hold, so there is
 * no second predicate to disagree with it), and what differs between a response and a tool call is only what the count is bound to and how a
 * refusal is worded.
 *
 * ## What a hand-written copy drops
 *
 * The release on a path that never reaches a close: an admitted transfer nobody releases makes every later act on that space wait for it,
 * `draining` for ever with nothing to report. Both binders release for their caller — the response's `close`, the call's own end — so a door
 * only decides whether it was refused.
 *
 * ## The one reasoned difference between the media
 *
 * An admitted request on a response can be CUT: the server destroys the stream past `INBOUND_TRANSFER_MS` and, for a rights door, the moment an
 * act registers (a file stream must not make the act wait out the sender). A tool call has no stream to destroy and its handler cannot be
 * stopped from outside, so its count is bound to the call and bounded by the same `INBOUND_TRANSFER_MS`: past it the COUNT is released, so a
 * hung handler cannot hold a drain open, and the handler is not cut. An act registering does not cut a tool call; it waits for the call, which a
 * tool call's own bounds end.
 */
import type { Response } from 'express';
import { SPACE_HELD_ANSWER } from './held-answer.js';
import { enterSpaceTransfer } from './space-exchange-set.js';
import { holdTransferWhileOpen, type SpaceTransfer } from './space-transfer-fence.js';
import { spaceActKnob } from '../spaces/space-act-runner.js';
import { spaceHeldRefusalsTotal } from '../metrics/registry.js';

/**
 * Admit one transfer of `spaceId` with `peerId`, or count the refusal: the transfer, counted in the fence until it is released, or `null`
 * when the space is held for that peer. `door` is the metric's label. The caller owns the release — a door goes through
 * {@link admitPeerOnResponse} or {@link admitPeerToolCall}, which release for it.
 */
export function admitPeer(spaceId: string, peerId: string, networkId: string | undefined, door: string): SpaceTransfer | null {
  const transfer = enterSpaceTransfer(spaceId, peerId, networkId);
  if (!transfer) spaceHeldRefusalsTotal.inc({ door });
  return transfer;
}

/** Answer a peer `423 space_held` on `res` and count it: the refusal of a door that asked the hold itself and found the space held. Always true. */
export function answerSpaceHeld(res: Response, door: string): true {
  spaceHeldRefusalsTotal.inc({ door });
  res.status(423).json(SPACE_HELD_ANSWER);
  return true;
}

/**
 * Admit a peer's request on `res`, counted until the response closes however it closes (a response that cannot say so is not counted at all);
 * `cutOnAct` destroys the response the moment an act on the space registers. Returns true when the space is held, after answering `423`.
 */
export function admitPeerOnResponse(
  res: Response, spaceId: string, peerId: string, networkId: string | undefined, door: string, cutOnAct: boolean,
): boolean {
  const transfer = admitPeer(spaceId, peerId, networkId, door);
  if (!transfer) { res.status(423).json(SPACE_HELD_ANSWER); return true; }
  let kept = false;
  try { kept = holdTransferWhileOpen(res, transfer, spaceActKnob('INBOUND_TRANSFER_MS'), cutOnAct); } finally { if (!kept) transfer.release(); }
  return false;
}

/** What a peer's tool call met on a space it named: the refusal to answer it with, or the release its dispatcher calls when the call ends. */
export type ToolCallAdmission =
  | { held: { status: 423; text: string; body: typeof SPACE_HELD_ANSWER } }
  | { release: () => void };

/**
 * Admit a peer token's tool call on the space it named. Held: the sync doors' own body, and the refusal counted. Admitted: counted in the fence
 * until `release` (idempotent), which the dispatcher calls from a `finally` and which fires by itself past `INBOUND_TRANSFER_MS`.
 */
export function admitPeerToolCall(peerId: string, space: string): ToolCallAdmission {
  const transfer = admitPeer(space, peerId, undefined, 'tool');
  if (!transfer) {
    return { held: { status: 423, text: `Error: ${SPACE_HELD_ANSWER.error} (space '${space}', ${SPACE_HELD_ANSWER.code})`, body: SPACE_HELD_ANSWER } };
  }
  const timer = setTimeout(() => transfer.release(), spaceActKnob('INBOUND_TRANSFER_MS'));
  timer.unref?.();
  return { release: () => { clearTimeout(timer); transfer.release(); } };
}
