/**
 * The shape a round a peer serves must have before this instance adopts it — `IncomingVoteRound` (bundle-106, design v5 §3.6, X11).
 *
 * ## What it prevents
 *
 * Adoption took whatever a peer served. A `wipeTypes` that was a string, a `spaceId` that was an object: every later reader iterated
 * the string letter by letter and compared the object to an id, and the hold, the settle and the act each met a value it was never
 * written for — inside the per-network sync runner, where a throw costs the pass. Now a round is read against its DECLARED keys first,
 * and one that does not have their shape is not adopted (said as malformed, the cycle goes on).
 *
 * ## What it does not do
 *
 * - It strips NOTHING (`passthrough`): a key a later release adds is kept and served on as it came, and a schema that dropped it would
 *   break the signatures over it and lose what the next release relies on.
 * - It does not refuse an older proposer: a repeated or unordered `wipeTypes` is accepted (adoption stores it canonical), a cast with no
 *   `castAt` or no `bsig` is accepted (the cast merge stamps or refuses it under its own rule), and an `openedAt` ahead of this clock is
 *   accepted (counted and warned by the caller, never refused: a skewed clock is not an attack).
 */
import { z } from 'zod';
import { BRAIN_COLLECTIONS, type BrainCollection } from '../config/types-knowledge.js';

const VOTE_ROUND_TYPES = ['join', 'remove', 'space_deletion', 'space_wipe', 'meta_change', 'space_addition'] as const;

/** The most casts, and required voters, one served round may carry: one per member, far above any network's roster. */
const MAX_ROUND_VOTERS = 1_000;

/** One cast as it travels. Its signatures and stamp are judged by the cast merge (`acceptVoteCast`), not here. */
const IncomingVoteCast = z.object({
  instanceId: z.string().min(1),
  vote: z.enum(['yes', 'veto']),
  castAt: z.string().optional(),
  sig: z.string().optional(),
  bsig: z.string().optional(),
}).passthrough();

/** A served round, read by its declared keys; every other key passes through untouched. */
export const IncomingVoteRound = z.object({
  roundId: z.string().min(1),
  type: z.enum(VOTE_ROUND_TYPES),
  subjectInstanceId: z.string(),
  subjectLabel: z.string().optional(),
  subjectUrl: z.string().optional(),
  openedAt: z.string(),
  deadline: z.string(),
  votes: z.array(IncomingVoteCast).max(MAX_ROUND_VOTERS),
  spaceId: z.string().optional(),
  networkSpaceId: z.string().optional(),
  // At most one entry per collection: a repeat within that is an older proposer's, stored canonical; more is no wipe anyone opened.
  wipeTypes: z.array(z.enum(BRAIN_COLLECTIONS as unknown as [string, ...string[]])).max(BRAIN_COLLECTIONS.length).optional(),
  requiredVoters: z.array(z.string()).max(MAX_ROUND_VOTERS).optional(),
}).passthrough();

/** Does `round` have the declared shape of a served round? */
export function hasRoundShape(round: unknown): boolean {
  return IncomingVoteRound.safeParse(round).success;
}

/**
 * A wipe's covered types as adoption stores them: deduplicated, in collection order. Never `undefined` for a list — a list naming all of
 * them stays a list, because the signatures over the round cover the list as it was sent (sorted and deduplicated, `util/signing.ts`).
 *
 * The one filter every canonical form of a wipe's types is built on: `canonicalWipeTypes` (the runner's key and entry) is this, validated
 * first and collapsed to `undefined` when it names all of them, because an entry's key reads "all" as no list at all.
 */
export function canonicalRoundWipeTypes(types: readonly string[]): BrainCollection[] {
  return BRAIN_COLLECTIONS.filter(t => types.includes(t));
}
