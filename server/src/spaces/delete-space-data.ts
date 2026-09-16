/**
 * Emptying a space — the whole capability, in one function both doors call.
 *
 * ## Why a module and not two handlers that agree
 *
 * Owner, 2026-09-16: *"the body can be EXACTLY the mcp tool (create modules that are used by both
 * doors)"*. Not a REST handler written to mirror a tool — one implementation with two thin adapters, so
 * "the same thing called" is structural rather than something a reviewer has to verify.
 *
 * **This capability is why that instruction exists.** There were five `DELETE .../<collection>` routes
 * calling `bulkDelete<Collection>` directly, and one tool calling `planSpaceWipe` first. So on a space
 * that belongs to a network, the tool opened a VOTE and the routes wiped immediately — same act, same
 * instance, and whether other members got a say depended on which door the caller came through. Nothing
 * reported it, because each door did exactly what its own code said.
 *
 * Collapsing the five into one route would have kept that: the new route inherited `wipeSpace` directly.
 * The governance step is the thing a hand-written second copy drops, because it is not what the caller
 * asked for — it is what the NETWORK is owed.
 *
 * ## The shape
 *
 * Arguments are the tool's arguments. `confirm` is required on both doors: one of the two demanded it, the
 * act is irreversible, and aligning on the safer side of a difference is the only direction that cannot
 * cost somebody their data.
 *
 * The result says which of two things happened — a vote opened, or data was deleted — and each door
 * renders it. Neither decides.
 */
import { WIPE_COLLECTION_TYPES, type WipeCollectionType, wipeSpace } from './lifecycle.js';
import { planSpaceWipe, notifyPeersOfWipe } from './wipe-vote.js';

/** One open round, as the planner reports it. Named here so the result type does not index a union. */
interface WipeRound { networkId: string; networkLabel: string; roundId: string }
import { isProxySpace } from './proxy.js';
import { getConfig } from '../config/loader.js';

export interface DeleteSpaceDataArgs {
  space: string;
  confirm?: unknown;
  types?: unknown;
}

export type DeleteSpaceDataResult =
  /** The caller got it wrong. `status` is the HTTP code the REST door answers; MCP renders the message. */
  | { ok: false; status: 400 | 404; error: string }
  /** The space is governed: nothing was deleted and a round is open in each network. */
  | { ok: true; outcome: 'vote_pending'; rounds: WipeRound[]; types: WipeCollectionType[] | null }
  /** Deleted, with a per-collection count. Zeroes mean the space was already empty. */
  | { ok: true; outcome: 'wiped'; deleted: Awaited<ReturnType<typeof wipeSpace>>; types: WipeCollectionType[] | null };

/**
 * Validate, consult the network, then wipe — or open the vote.
 *
 * The space is already AUTHORISED by the caller's door (`requireBodyScopedSpace` on REST, the dispatcher's
 * `spaceAdmin` check on MCP). This function does not re-check rights: a second authorisation inside the
 * shared module would be a rule with two implementations again, one layer further in.
 */
export async function deleteSpaceData(args: DeleteSpaceDataArgs): Promise<DeleteSpaceDataResult> {
  const { space } = args;

  if (!getConfig().spaces.some(s => s.id === space)) {
    return { ok: false, status: 404, error: `Space '${space}' not found` };
  }
  if (isProxySpace(space)) {
    return {
      ok: false, status: 400,
      error: 'Bulk wipe not supported on proxy spaces — target member spaces individually',
    };
  }
  if (args.confirm !== true) {
    return { ok: false, status: 400, error: '`confirm: true` required' };
  }

  let types: WipeCollectionType[] | undefined;
  if (args.types !== undefined) {
    const raw = args.types;
    // An unknown type is a typo, and "wipe everything except the thing you misspelled" is the worst
    // available reading of one. Refused rather than filtered.
    if (!Array.isArray(raw)
      || raw.some(t => typeof t !== 'string' || !WIPE_COLLECTION_TYPES.includes(t as WipeCollectionType))) {
      return {
        ok: false, status: 400,
        error: `\`types\` must be an array of: ${WIPE_COLLECTION_TYPES.join(', ')}. Omit it to wipe all.`,
      };
    }
    types = raw as WipeCollectionType[];
  }

  /*
   * THE GOVERNANCE STEP, and it is the reason this module exists rather than two handlers.
   *
   * A space that belongs to a network cannot be emptied by one member deciding to. The planner opens a
   * round in each network and this instance votes yes; the data goes when a round passes, and one veto
   * stops it. Skipping this is not a slower path — it is a member deleting shared data unilaterally.
   */
  const plan = planSpaceWipe(space, types);
  if (plan.governed) {
    notifyPeersOfWipe(space, types);
    return { ok: true, outcome: 'vote_pending', rounds: plan.rounds, types: types ?? null };
  }

  return { ok: true, outcome: 'wiped', deleted: await wipeSpace(space, types), types: types ?? null };
}

/** The types label both doors print — `all` when none were named, because that is what happens. */
export const wipeTypesLabel = (types: WipeCollectionType[] | null | undefined): string =>
  types && types.length > 0 ? types.join(', ') : 'all';
