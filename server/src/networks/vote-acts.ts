/**
 * Network governance acts that stay instance-admin — open votes, casting a vote, the sync history — once, for both
 * doors (`F-36`, slice 2).
 *
 * ## Why this exists
 *
 * A vote is how a networked space approves a destructive act, and it was the one governance act MCP could not
 * reach: an agent could be a member of a process it could not take part in (`mcp/parity.ts` said so in as many
 * words). The REST handlers held the decisions, so writing tools beside them would have been the defect this repo
 * produces most — one rule, two implementations. The handlers moved here; each door only translates.
 *
 * Who may call them is decided at the door, not here: the routes carry `requireAdmin`, the tools `admin: true`. That
 * is the rule these acts have always had — votes and sync telemetry act on the network as a whole, not on a space.
 */
import { z } from 'zod';
import { getConfig, saveConfig } from '../config/loader.js';
import { concludeRoundIfReady, sendMemberRemovedNotify } from '../sync/governance.js';
import { getSyncHistory } from '../sync/history.js';
import { applyConcludedSpaceRounds } from '../spaces/apply-wipe-round.js';
import { makeSignedOwnCast } from '../util/signing.js';
import { log, logSafe } from '../util/log.js';
import type { NetworkActResult } from './network-acts.js';
import { roundSpaceLocalId } from '../sync/space-map.js';
import { admitPassedJoin } from './admit-passed-join.js';

export const CastVoteBody = z.object({ vote: z.enum(['yes', 'veto']) });

const notFound = { status: 404 as const, error: 'Network not found' };

/** The rounds still open on a network, as the peer and the page read them. */
export function listOpenVotesAct(id: string): NetworkActResult {
  const net = getConfig().networks.find(n => n.id === id);
  if (!net) return notFound;
  /*
   * `localSpaceId` (Q-133, additive): what THIS instance calls the space a round is about. A round names it by the
   * network's id or by its proposer's local id, and after a rename neither is the name the operator here knows, so an
   * operator asked to vote on deleting `y-project-template` would be shown `y-twin`. Operator-facing only: the peer
   * route (`api/sync/votes.ts`) serves rounds as they travel.
   */
  const rounds = net.pendingRounds.filter(r => !r.concluded).map(r => {
    const localSpaceId = r.spaceId ? roundSpaceLocalId(net, r) : null;
    return localSpaceId ? { ...r, localSpaceId } : r;
  });
  return { status: 200, body: { rounds } };
}

/**
 * Cast this instance's vote on an open round, signed, and apply whatever the round's conclusion does here: admit a
 * joiner, remove a member, delete, wipe or add a space. Answers `{ concluded, round }`.
 */
export function castVoteAct(id: string, roundId: string, input: unknown): NetworkActResult {
  const parsed = CastVoteBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === id);
  if (!net) return notFound;
  const round = net.pendingRounds.find(r => r.roundId === roundId && !r.concluded);
  if (!round) return { status: 404, error: 'Round not found or already concluded' };

  const instanceId = cfg.instanceId;
  const existing = round.votes.findIndex(v => v.instanceId === instanceId);
  const cast = makeSignedOwnCast(net.id, round, instanceId, parsed.data.vote);
  if (existing >= 0) round.votes[existing] = cast;
  else round.votes.push(cast);

  concludeRoundIfReady(net, round);

  if (admitPassedJoin(net, cfg.instanceId, round)) {
    log.info(`Join vote ${logSafe(round.roundId)} passed — added member ${logSafe(round.subjectLabel)} to network ${logSafe(net.id)}`);
  }
  // Deletion, wipe and addition: the function all three conclusion sites call (X-5, F-38.4).
  applyConcludedSpaceRounds(net, [round], 'local vote');
  if (round.concluded && round.passed && round.type === 'remove') {
    sendMemberRemovedNotify(round.subjectUrl, round.subjectInstanceId, net.id);
  }

  saveConfig(cfg);
  log.info(`Vote cast in round ${logSafe(round.roundId)}: ${logSafe(parsed.data.vote)} (concluded=${logSafe(round.concluded)})`);
  return { status: 200, body: { concluded: round.concluded ?? false, round } };
}

/** The newest sync cycles recorded for a network, newest first; `limit` 1–100, default 20. */
export async function syncHistoryAct(id: string, limit: unknown): Promise<NetworkActResult> {
  const net = getConfig().networks.find(n => n.id === id);
  if (!net) return notFound;
  const n = Math.min(parseInt(String(limit ?? ''), 10) || 20, 100);
  return { status: 200, body: { history: await getSyncHistory(net.id, n) } };
}
