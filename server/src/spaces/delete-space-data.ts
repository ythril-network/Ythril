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
 * calling `bulkDelete<Collection>` directly, and one tool calling the wipe planner first. So on a space
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
 * The result says what happened — a vote opened, the data was wiped, the change is still running here, or it
 * failed after the vote passed — and each door renders it. Neither decides. Who may call it is decided at the
 * door, by the tool's `spaceAdmin` flag (D-41): this module asks no rights question of its own.
 */
import { WIPE_COLLECTION_TYPES, wipeResultOf, type WipeCollectionType } from './lifecycle.js';
import { decidedBy, wipeSpaceAsRequested, wipeTypesOf, type WipeOutcome } from './wipe-vote.js';
import { isProxySpace } from './proxy.js';
import { getConfig } from '../config/loader.js';
import { queuedActBody, spaceActFailureAnswer } from './space-act-failure.js';
import type { ToolResult } from '../mcp/tools/types.js';

export interface DeleteSpaceDataArgs {
  space: string;
  confirm?: unknown;
  types?: unknown;
}

export type DeleteSpaceDataResult =
  /** The caller got it wrong. `status` is the HTTP code the REST door answers; MCP renders the message. */
  | { ok: false; status: 400 | 404; error: string }
  /** What the wipe came to (`wipeSpaceAsRequested`), and the canonical types it covered (`null` = all). */
  | { ok: true; outcome: WipeOutcome; types: WipeCollectionType[] | null };

/**
 * Validate, then wipe as the network decides.
 *
 * The space is already AUTHORISED by the caller's door (the dispatcher's `spaceAdmin` check, for `POST /api/delete_space_data`
 * and MCP alike). This function does not re-check rights: a second authorisation inside the shared module would be a rule with
 * two implementations again, one layer further in.
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

  // An unknown type is a typo, and "wipe everything except the thing you misspelled" is the worst available reading of one.
  // Refused rather than filtered — and deduplicated and ordered once, so the round, its signature and the act read one list.
  const covered = wipeTypesOf(args.types);
  if (covered === 'refused') {
    return {
      ok: false, status: 400,
      error: `\`types\` must be an array of at most ${WIPE_COLLECTION_TYPES.length} of: ${WIPE_COLLECTION_TYPES.join(', ')}. Omit it to wipe all.`,
    };
  }

  /*
   * THE GOVERNANCE STEP, and it is the reason this module exists rather than two handlers.
   *
   * The planner opens a round in each network that holds the space and this instance votes yes. On a club, a pub/sub
   * network this instance publishes, or a network where it is the only member, that yes passes the round and the data
   * goes in this request — which is why `confirm` is required. Elsewhere the data goes when the round passes, and one veto
   * stops it. A pub/sub subscriber's wipe is its own copy only (D-40): it opens no round and refills from the publisher.
   */
  const outcome = await wipeSpaceAsRequested(space, covered);
  return { ok: true, outcome, types: covered.length === WIPE_COLLECTION_TYPES.length ? null : covered };
}

/** The types label both doors print — `all` when none were named, because that is what happens. */
export const wipeTypesLabel = (types: WipeCollectionType[] | null | undefined): string =>
  types && types.length > 0 ? types.join(', ') : 'all';

/**
 * The tool's answer to a wipe outcome — text and `structuredContent` — for MCP and `POST /api/delete_space_data` alike (the REST tool door
 * answers the same `data`). A failed act is an error result carrying the failure body (`code: 'space_act_failed'`, and `status: 'passed'` only when a vote decided the wipe);
 * a store-side cause is rethrown as itself, so the dispatcher answers it as every store failure (503, `storeSideFailure`).
 */
export function wipeToolResult(space: string, outcome: WipeOutcome, types: WipeCollectionType[] | null): ToolResult {
  const label = wipeTypesLabel(types);
  const text = (t: string) => [{ type: 'text' as const, text: t }];
  const rounds = ('rounds' in outcome ? outcome.rounds : undefined) ?? [];
  const where = (want: 'passed' | 'vote_pending') => rounds.filter(r => r.outcome === want).map(r => r.networkLabel).join(', ');
  switch (outcome.status) {
    case 'vote_pending':
      return {
        content: text(`Nothing has been wiped yet. '${space}' belongs to ${rounds.length} network${rounds.length === 1 ? '' : 's'} (${where('vote_pending') || rounds.map(r => r.networkLabel).join(', ')}), `
          + `so emptying it is a governed act: a vote is ${outcome.repeated ? 'already ' : 'now '}open in each, and this instance has voted yes. [${label}] is wiped on every member `
          + 'when a round passes, and a single veto stops it there. Watch the rounds rather than expecting counts from this call.'),
        structuredContent: { status: 'vote_pending', rounds, types, ...(outcome.repeated ? { repeated: true } : {}) },
      };
    case 'passed':
      return {
        // A wipe no vote decided names the change and the space's `actPending`, never a vote that passed (`space-act-failure.ts`).
        content: text(outcome.local
          ? (outcome.retryAt
            ? `The change on this instance did not complete and is retried automatically at ${outcome.retryAt}. See the space's actPending (list_spaces).`
            : 'The change on this instance is still running and completes on its own. Check the space\'s actPending (list_spaces) or its counts.')
          : (outcome.retryAt
            ? `The vote passed; the change on this instance failed and is retried automatically at ${outcome.retryAt}. See GET /api/networks/:id (owedSpaceActs).`
            : 'The vote passed; the change on this instance is still running and completes on its own. Check GET /api/networks/:id (owedSpaceActs) or the space\'s counts.')),
        structuredContent: { ...queuedActBody(outcome, decidedBy(outcome)), types },
      };
    case 'failed': {
      const answer = spaceActFailureAnswer(outcome.cause, decidedBy(outcome), `tool delete_space_data on '${space}'`);
      if (answer.store) throw outcome.cause;
      return { content: text(`Error: ${answer.body.error}`), isError: true, structuredContent: { ...answer.body } };
    }
    case 'wiped': {
      const d = wipeResultOf(outcome.deleted);
      const counts = `${d.facts} facts, ${d.entities} entities, ${d.edges} edges, ${d.chrono} chrono, ${d.files} files`;
      const open = where('vote_pending');
      const said = outcome.refills
        ? `Wiped your copy of '${space}' [${label}]: ${counts}. It refills from the publisher at the next sync.`
        : rounds.length > 0
          ? `Wiped [${label}] in '${space}' on this instance (passed in ${where('passed')})${outcome.deleted ? `: ${counts}` : ''}.`
            + (open ? ` A vote is still open in ${open} — members there are not yet wiped.` : '')
          : `Wiped [${label}] in space '${space}': ${counts}.`;
      return {
        content: text(said),
        structuredContent: {
          ...d, status: 'wiped', types, deleted: d,
          ...(rounds.length > 0 ? { rounds } : {}), ...(outcome.repeated ? { repeated: true } : {}), ...(outcome.refills ? { refills: true } : {}),
        },
      };
    }
  }
}
