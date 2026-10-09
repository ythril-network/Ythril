/**
 * Network governance acts that stay instance-admin — open votes, casting a vote, how rounds ended, the sync history —
 * once, for both doors (`F-36`, slice 2).
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
import type { NetworkConfig, VoteRound } from '../config/types.js';
import { concludeRoundIfReady } from '../sync/governance.js';
import { getSyncHistory } from '../sync/history.js';
import { makeSignedOwnCast } from '../util/signing.js';
import { parseStrictLimit } from '../util/strict-limit.js';
import { log, peerText } from '../util/log.js';
import type { NetworkActResult } from './network-acts.js';
import { roundSpaceLocalId } from '../sync/space-map.js';
import { roundIsOpen, roundClosedRefusal, type RoundRefusal } from './round-state.js';
import { outcomesFor, roundSummary } from './round-outcomes.js';
import { applyRoundConclusion } from './round-conclusion.js';

export const CastVoteBody = z.object({ vote: z.enum(['yes', 'veto']) });

export const VOTE_OUTCOMES_DEFAULT_LIMIT = 20;
export const VOTE_OUTCOMES_MAX_LIMIT = 50;

const notFound = { status: 404 as const, error: 'Network not found' };

/** What a round that is not here reads as: concluded. The refusal for it is the 404 every closed round gets. */
const NOT_HERE = { concluded: true } as const;

/** What a round carries that is not for an operator: the proposal body, a candidate's credential record, the invite key's hash. */
const NOT_FOR_AN_OPERATOR = ['pendingMeta', 'pendingMember', 'inviteKeyHash'] as const;

/**
 * A round as an operator door shows it — the one projection every act that answers a round goes through (the list, and the cast's
 * `{ concluded, round }`, so REST and MCP alike).
 *
 * `localSpaceId` (Q-133, additive): what THIS instance calls the space a round is about. A round names it by the network's id or by
 * its proposer's local id, and after a rename neither is the name the operator here knows, so an operator asked to vote on
 * deleting `y-project-template` would be shown `y-twin`. Operator-facing only: the peer route (`api/sync/votes.ts`) serves rounds as
 * they travel.
 *
 * What the operator is not handed: the proposal body (`pendingMeta`, which can be large), a candidate's credential record
 * (`pendingMember`) and the invite key's hash — the same join round the list shows without them must not come back from a cast
 * with them. A proposal is shown by `summary` instead, a sentence a voter reads without opening a schema.
 * `a-round-answered-to-an-operator-carries-no-credential.test.js` drives every door that answers a round.
 */
export function roundForOperator(net: NetworkConfig, round: VoteRound): Record<string, unknown> {
  const shown: Record<string, unknown> = { ...round };
  for (const key of NOT_FOR_AN_OPERATOR) delete shown[key];
  const localSpaceId = round.spaceId ? roundSpaceLocalId(net, round) : null;
  if (localSpaceId) shown['localSpaceId'] = localSpaceId;
  const summary = roundSummary(net, round);
  if (summary) shown['summary'] = summary;
  return shown;
}

/**
 * The rounds that can still be voted on, as the page reads them: before their deadline and not concluded. A round past its
 * deadline is not listed, whether or not anything has concluded it yet — it takes no cast, so offering it is offering a refusal.
 */
export function listOpenVotesAct(id: string): NetworkActResult {
  const net = getConfig().networks.find(n => n.id === id);
  if (!net) return notFound;
  const now = Date.now();
  const rounds = net.pendingRounds.filter(r => roundIsOpen(r, now)).map(r => roundForOperator(net, r));
  return { status: 200, body: { rounds } };
}

/**
 * The round a cast is for, or the refusal to answer it with — for the operator act and the peer relay both, so a cast on a
 * round that is gone, concluded or past its deadline is refused in the same words wherever it arrives. A round that is not
 * here answers as a concluded one: a caller cannot tell "never existed" from "over", and is not asked to.
 */
export function roundToVoteOn(net: Pick<NetworkConfig, 'pendingRounds'>, roundId: string, now: number): { round: VoteRound } | { refusal: RoundRefusal } {
  const round = net.pendingRounds.find(r => r.roundId === roundId);
  const refusal = roundClosedRefusal(round ?? NOT_HERE, now);
  return refusal ? { refusal } : { round: round! };
}

/**
 * Cast this instance's vote on an open round, signed, and apply whatever the round's conclusion does here: admit a
 * joiner, remove a member, delete, wipe or add a space. Answers `{ concluded, round }`.
 *
 * A round past its deadline takes no cast (409 `round_expired`, naming the deadline). The clock is read ONCE: the same `now`
 * decides whether the round is open and whether it concludes, so a cast is never refused as late and concluded as on time.
 */
export function castVoteAct(id: string, roundId: string, input: unknown): NetworkActResult {
  const parsed = CastVoteBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === id);
  if (!net) return notFound;
  const now = Date.now();
  const found = roundToVoteOn(net, roundId, now);
  if ('refusal' in found) return found.refusal;
  const { round } = found;

  const instanceId = cfg.instanceId;
  const existing = round.votes.findIndex(v => v.instanceId === instanceId);
  const cast = makeSignedOwnCast(net.id, round, instanceId, parsed.data.vote);
  if (existing >= 0) round.votes[existing] = cast;
  else round.votes.push(cast);

  concludeRoundIfReady(net, round, now);
  // What a conclusion does here — admit or introduce a passed join, apply a deletion, wipe or addition, tell an ejected member —
  // is written once (`networks/round-conclusion.ts`), for this cast, a peer's relayed cast, a gossip pass and the expiry job.
  applyRoundConclusion(net, cfg, [round], 'local vote');

  saveConfig(cfg);
  log.info(`Vote cast in round ${peerText(round.roundId)}: ${parsed.data.vote} (concluded=${round.concluded})`);
  return { status: 200, body: { concluded: round.concluded ?? false, round: roundForOperator(net, round) } };
}

/**
 * How the network's rounds ended on this instance, newest first: `{ outcomes, total }`, `total` being the whole log so a short
 * page is told from a short log. `limit` is an integer from 1 to 50, default 20.
 *
 * Each entry is what the operator reads. The log keeps, locally, a join round's invite-key hash and its subject so a joiner
 * polling its own round is still told it was denied after the round is pruned (`member-acts.ts`); `outcomesFor` strips both,
 * so no door hands them out.
 */
export function voteOutcomesAct(id: string, limit: unknown): NetworkActResult {
  const parsed = parseStrictLimit(limit, VOTE_OUTCOMES_DEFAULT_LIMIT, VOTE_OUTCOMES_MAX_LIMIT);
  if (!parsed.ok) return { status: 400, error: parsed.error };
  const net = getConfig().networks.find(x => x.id === id);
  if (!net) return notFound;
  const { outcomes, total } = outcomesFor(net, parsed.limit);
  return { status: 200, body: { outcomes, total } };
}

/** The newest sync cycles recorded for a network, newest first; `limit` 1–100, default 20. */
export async function syncHistoryAct(id: string, limit: unknown): Promise<NetworkActResult> {
  // Refused outside 1–100, as the MCP schema refuses it (Q-109). REST reaches this with the query string's text, so the
  // parse is strict about that too, and it is the one the outcome log's limit goes through.
  const parsed = parseStrictLimit(limit, 20, 100);
  if (!parsed.ok) return { status: 400, error: parsed.error };
  const net = getConfig().networks.find(x => x.id === id);
  if (!net) return notFound;
  return { status: 200, body: { history: await getSyncHistory(net.id, parsed.limit) } };
}
