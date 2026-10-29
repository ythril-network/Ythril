/**
 * Invoking a tool — the whole capability layer, in one function both doors call.
 *
 * ## Why this file exists
 *
 * Owner, 2026-09-16: *"create modules that are used by both doors"*, and then *"this shared module concept
 * for both doors should be applied to each and every tool"*.
 *
 * Done one capability at a time that is forty-five modules and ninety adapters, and the forty-sixth tool is
 * written by someone who does one of the two. So it is done ONCE, here: everything between *a caller named
 * a tool* and *the tool answered* lives in this function, and each door is a translation of its own
 * envelope into these arguments and back out of this result.
 *
 * MCP hands it a JSON-RPC `tools/call`. REST hands it `POST /api/<tool-name>` with the arguments as the
 * body. They cannot drift, because there is nothing left to drift — no second gate, no second space parse,
 * no second rung check, no second error classification.
 *
 * ## What was two implementations until now, and what each one had that the other did not
 *
 * The gates below ran inside the MCP dispatcher and nowhere else, while the REST routes were guarded
 * per-route by `ROUTE_RIGHTS` middleware. Both were defensible and they answered differently:
 *
 * - the rung check ran against the FIRST named space only, so a three-space `recall` was authorised
 *   against one of the three. REST's body-scoped guard checked every one. Fixed here by looping, which
 *   is the change that made the extraction worth doing rather than a move.
 * - the destructive-call throttle was express middleware, so it existed on REST and not on MCP. It is a
 *   counter in this function now, so an agent gets the same five-a-minute a browser does.
 *
 * ## What an adapter may do
 *
 * Translate. A status code, a prose rendering, an envelope. It may NOT decide: a check that appears in an
 * adapter is a rule with two implementations again, one layer in, and the copy that gets forgotten is
 * whichever door its author was not using that day.
 */
import { getConfig } from '../config/loader.js';
import { log, peerText } from '../util/log.js';
import { reachableSpaceIds } from '../auth/space-reach.js';
import { toolRightsRefusal, spaceAdminRefusal, toolReach } from './tool-rights-guard.js';
import { TOOL_RIGHTS, toolTakesAView } from '../auth/space-rights.js';
import { isViewId, resolveOwnView, viewOwnerOf, viewReadMembers, viewsOfOwner } from '../config/views.js';
import { ownViewNamedIn, retiredIdNamedIn, unknownSpaceAnswer } from '../spaces/unknown-space.js';
import { peerBoundTo } from '../auth/peer-bound.js';
import { withoutHeldFor } from '../sync/space-exchange-set.js';
import { admitPeerToolCall } from '../sync/peer-space-admission.js';
import { toolIsVisible } from './tool-visibility.js';
import { createSpacesRefusal } from '../auth/create-spaces.js';
import type { TokenRights } from '../config/rights-shape.js';
import { storeFailureAnswer, type StoreFailureAnswer } from '../brain/store-failure.js';
import { SchemaViolationError, writeRefusalAnswer, schemaRefusalStatus, countSchemaRefusal } from '../brain/write-validation.js';
import { edgeIdentityTakenAnswer } from '../brain/edge-rekey.js';
import { answerFileActFailure } from '../files/act-failure-answer.js';
import { answerForCaught } from '../util/answer-for-caught.js';
import { spaceActAnswer } from '../spaces/space-act-answer.js';
import { NotFoundError, ToolRefusal } from '../util/errors.js';
import { WriteConflict } from '../brain/write-plan/types.js';
import { RecordVersionAtCeiling } from '../brain/write-precondition.js';
import { PositionClockUnusable, PositionsSeedUnavailable, ForkRowReadOnly, ForkCapRefusal, EndpointRemoved, LinkTargetRemoved } from '../util/errors.js';
import { ConnectionsNotWritten, connectionsNotWrittenAnswer } from '../brain/connections-not-written.js';
import { mergeRefusal } from '../brain/merge.js';
import { TOOLS_BY_NAME, type ToolResult } from './tools/index.js';
import type { ToolCallerRecord } from './tools/types.js';
import { validatorFor } from './validate-args.js';
import { withUnknownFieldRows } from './schema-warnings.js';
import { answerUnknownWriteFields, writeBodyOfToolCall, writeDoorOfTransport } from '../contract/write-accepts.js';
import { judgedOperationOfTool, isBatchWriteOperation } from '../contract/judged-write-operations.js';
import type { UnknownFieldRow } from '../contract/unknown-field-rows.js';
import { consumeHeavyToolCall } from '../rate-limit/heavy-tool.js';
import { auditedToolCall, type ToolAuditFacts } from './tool-call-audit.js';
import { toolCallsTotal, toolFailuresTotal } from '../metrics/registry.js';
/** Who is calling, for the rung checks and the audit trail. Snapshotted by the door at its own edge. */
export interface ToolCaller {
  rights?: TokenRights;
  /** The caller's token record (what a personal view's owner key is made of, and what its copy and peer rules read). Snapshotted by the door. */
  record?: ToolCallerRecord;
  tokenId?: string;
  tokenLabel?: string;
  ip: string;
  authMethod: 'pat' | 'oidc' | null;
  oidcSubject: string | null;
  /** Which door. Recorded in the audit trail so the transport stays recoverable; changes nothing else. */
  transport: 'mcp' | 'rest';
  /** The REST path the call came in by, recorded as the row's `path` (a classic route's own, not `/api/<tool>`). Set by `restToolCaller`. */
  routePath?: string;
  /**
   * Called when the tool door has decided this call's audit row, so the route rule of the REST request it serves writes none:
   * one call, one row, and the row that knows the space (Q-444). Set by `restToolCaller`.
   */
  onAudited?: () => void;
}

export interface ToolCallOutcome {
  result: ToolResult;
  /**
   * The HTTP status the REST door answers. MCP discards it — the JSON-RPC transport answers 200 and carries
   * the failure in `isError`, which is the MCP specification's shape rather than a difference of ours.
   *
   * It lives here and not in the REST adapter because mapping it there means re-deciding, from the message
   * text, what this function already knew: a refusal that says "not found" reaching a caller as a 400 is
   * how the two doors start disagreeing about what happened.
   */
  status: number;
  /** The first space the call resolved to, for the caller's own logging. Empty for instance-level tools. */
  callSpace: string;
  /**
   * The store's answer, when the call failed on the store's side — so a door with a status line puts it on the wire
   * whole (`sendToolAnswer`): the `Retry-After` the tool's own transport has no place for was dropped by every REST
   * door that delegates here until bundle-30 I12. MCP carries the same answer in `structuredContent`.
   */
  storeFailure?: StoreFailureAnswer;
  /** The `Retry-After` a REST door puts on the answer (for a move still owed): MCP has no place for it and says `retryable` in `structuredContent`. */
  retryAfterSeconds?: number;
}

/** Is a tool's error result the failed-act answer (`spaces/space-act-failure.ts`: our sentence and `space_act_failed`, whether or not a vote decided the act)? */
function isSpaceActFailure(result: { structuredContent?: Record<string, unknown> } | undefined): boolean {
  return result?.structuredContent?.['code'] === 'space_act_failed';
}

/**
 * A result of a read through a personal view, carrying the members it read in `structuredContent`, where both doors read it (every
 * successful tool answer carries one: `a-tool-answer-reaches-both-halves`). A SUCCESS decoration, not an error classification, so it
 * stands above the dispatch and outside the catch that `mcp-structured-errors` holds to "no key without a classification".
 */
function announceViewMembers(result: ToolResult, spaces: readonly string[] | undefined): ToolResult {
  if (!spaces) return result;
  return { ...result, structuredContent: { ...(result.structuredContent ?? {}), viewMembers: [...spaces] } };
}

/**
 * A refusal, with the status the REST door should use. Prose is identical on both doors, by construction. `structuredContent` is the
 * body a refusal carries beside its prose — the judge's `{ error, issues, warnings }` — so a client that reads that half and not the
 * text sees the same refusal.
 */
function refuse(status: number, text: string, callSpace = '', structuredContent?: Record<string, unknown>): ToolCallOutcome {
  return {
    result: { content: [{ type: 'text' as const, text }], isError: true, ...(structuredContent ? { structuredContent } : {}) },
    status, callSpace,
  };
}

export interface ToolCallRequest {
  name: string;
  args: Record<string, unknown>;
  caller: ToolCaller;
}

/**
 * Gate, resolve, dispatch, classify — for any tool, from any door.
 *
 * Never throws: a handler's exception is classified into a result and a status here, because a door that
 * has to catch is a door that gets to decide what the failure meant.
 */
export async function callTool(req: ToolCallRequest): Promise<ToolCallOutcome> {
  // A peer token's call is counted in the fence of every space it names for as long as it runs; the release is HERE, in a `finally`, so no
  // return of the dispatch below (a refusal of a later space, a handler that threw) can leave a count behind.
  const admitted: (() => void)[] = [];
  try {
    // The audit row of the call is written at THIS exit, once, whatever the dispatch answered (`auditedToolCall`, Q-444).
    return await auditedToolCall(req.name, req.caller, req.args, facts => dispatchTool(req, admitted, facts));
  } finally {
    for (const release of admitted) release();
  }
}

/**
 * The body of {@link callTool}: every release it owes is pushed onto `admitted`, which the caller releases however this ends.
 * It records NOTHING: what the audit row must say that only this function knows goes onto `facts`, and `auditedToolCall` writes the row.
 */
async function dispatchTool(req: ToolCallRequest, admitted: (() => void)[], facts: ToolAuditFacts): Promise<ToolCallOutcome> {
  const { name, args: a, caller } = req;
  const { rights } = caller;
  const cfg = getConfig();
  // The peer this call's token is bound to, or none: a peer token is a peer's credential, every other token the operator's own tooling.
  const peerId = peerBoundTo(cfg.tokens?.find(t => t.id === caller.tokenId));
  const accessibleSpaceIds = reachableSpaceIds(rights, cfg.spaces.map(s => s.id));
  const accessibleSpaces = cfg.spaces.filter(s => accessibleSpaceIds.includes(s.id));
  // The caller's own personal views, offered to the tools that take one (and to no other), and resolved per call below.
  const ownerKey = caller.record ? viewOwnerOf(caller.record) : null;
  const ownViewIds = viewsOfOwner(ownerKey, cfg).map(v => v.id);

  /*
   * The arguments must be an OBJECT, and this is refused before anything reads a field off them.
   *
   * A JSON array or a bare string parses fine and then answers every property lookup with `undefined`, so
   * the first gate that reads one reports the wrong thing: `POST /api/space_stats` with a body of `[1,2]`
   * was told it was missing `space`. That is a refusal naming a field the caller never meant to send, and
   * the caller then goes looking for the field rather than at the body.
   */
  if (a === null || typeof a !== 'object' || Array.isArray(a)) {
    return refuse(400, `Error: arguments for '${name}' must be an object`);
  }

  // Unknown tools carry no flags and fall through the gates to be reported below, as they always did.
  const tool = TOOLS_BY_NAME.get(name);

  /*
   * The space the audit row names is the one the REST path would name, and only a space that EXISTS: a caller's spelling of one that does not
   * is never written to the trail. Said here, before any refusal below, so a call refused for what the token may see names its space as the REST
   * route's does; the loop below says it again for each space it checks, and after the loop it is the first one named.
   */
  const namedSpace = typeof a['space'] === 'string' ? a['space'].trim() : '';
  if (cfg.spaces.some(s => s.id === namedSpace)) facts.auditSpace = namedSpace;

  // A retired proxy id answers 410 to every caller, before anything about the caller or the tool is asked (visibility, reach, rung): the id
  // was public, it is not a view, and what happened to it is the answer however little the caller may do.
  const namedRetired = retiredIdNamedIn(a['space'], cfg);
  const gone = namedRetired === null ? null : unknownSpaceAnswer(null, namedRetired, false, cfg);
  if (gone) return refuse(gone.status, gone.body.error, '', { ...gone.body });

  // The caller's OWN view named on a tool that does not take one (every write) is answered as what it is, with the owner-only hint, BEFORE the
  // rights below are judged - the REST path routes ask the existence rule first, so the order is one on every door (`ownViewNamedIn`).
  const notASpace = tool && !toolTakesAView(name) ? ownViewNamedIn(ownerKey, a['space'], cfg) : null;
  if (notASpace) return refuse(notASpace.status, `Error: ${notASpace.body.error}`);

  // Reachability, from the same predicate that builds `tools/list` — so a listing cannot advertise a tool
  // this refuses. Filtering the list stays advisory; this is the enforcement point.
  if (tool && !toolIsVisible(tool, rights)) {
    // A space-creating tool is refused in the REST create's own sentence (Q-134): one predicate, one refusal.
    const createRefusal = tool.createsSpaces ? createSpacesRefusal({ rights }) : null;
    if (createRefusal) return refuse(403, `Error (403): ${createRefusal}`);
    return refuse(403, tool.admin
      ? `Error: tool '${name}' requires a token with instance-admin rights`
      // Without its own branch a space-admin tool would be refused as "mutates, and this token holds no
      // write rung", which names the wrong missing thing — a token can hold write everywhere and still
      // administer nothing.
      : tool.spaceAdmin
        ? `Error: tool '${name}' configures a space, and this token administers none — it needs the `
          + 'spaceAdmin grant on some space, or instance-admin rights'
        : `Error: tool '${name}' mutates, and this token holds no write rung in any space`);
  }

  /*
   * Validate the space parameter, which is one name, a LIST of names (5.0, search family only), or absent.
   *
   * Parsed into one shape — `rawSpaces` — before anything is checked, so there is no branch where a check
   * applies to a single space and not to a listed one.
   */
  const spaceArg = a['space'];
  let rawSpaces: string[];
  if (Array.isArray(spaceArg)) {
    if (!tool?.spaceList) {
      return refuse(400, `Error: tool '${name}' takes one 'space', not a list`);
    }
    if (!spaceArg.every(v => typeof v === 'string')) {
      return refuse(400, `Error: every entry in 'space' must be a space name`);
    }
    if (spaceArg.length === 0) {
      // NOT read as "no space named". An empty list is what a caller's own filter produces when it matches
      // nothing, and widening that to every reachable space is the opposite of what they meant.
      return refuse(400, `Error: 'space' is an empty list. Name at least one space, or omit 'space' to search every space you can reach`);
    }
    rawSpaces = [...new Set(spaceArg.map(v => v.trim()).filter(v => v.length > 0))];
    if (rawSpaces.length === 0) {
      return refuse(400, `Error: every entry in 'space' must be a space name`);
    }
  } else if (spaceArg !== undefined && spaceArg !== null && typeof spaceArg !== 'string') {
    // An object or a number here used to reach the handler as the empty string — the cross-space case — so
    // a malformed `space` WIDENED the call instead of failing it.
    return refuse(400, `Error: 'space' must be a space name, or a list of them`);
  } else {
    const one = typeof spaceArg === 'string' ? spaceArg.trim() : '';
    rawSpaces = one ? [one] : [];
  }
  /*
   * ONE REACHABLE SPACE NEEDS NO NAMING — `B-6`.
   *
   * `space`'s enum is already narrowed to the spaces this token reaches. When that list has exactly one
   * member there is no other space the call could mean, so requiring it buys no safety and costs every
   * caller who did not read the schema. A generic MCP client does not read it: it matches a tool by name,
   * fills the parameters it recognises and calls. Against us that meant `save_fact({fact})`, refused —
   * and the run then stored nothing, searched an empty space and scored about zero with no error anybody
   * saw, because the harness swallows its own reset failure.
   *
   * With TWO OR MORE the omission is genuinely ambiguous and guessing would write into a space nobody
   * named, so it stays required.
   *
   * **Here rather than in each handler.** Forty-odd tools filling in a space is forty chances for one to
   * forget, and the one that forgets writes somewhere the caller did not ask for. `toolSchemasFor` makes
   * the same decision about what to ADVERTISE, from the same list, so the schema and the dispatcher
   * cannot disagree about when it may be omitted.
   */
  if (tool?.spaceRequired && rawSpaces.length === 0 && accessibleSpaceIds.length === 1) {
    rawSpaces = [accessibleSpaceIds[0] as string];
  }
  const rawSpace = rawSpaces[0] ?? '';
  if (tool?.spaceRequired && rawSpaces.length === 0) {
    /*
     * The refusal NAMES them, unlike the unreachable-space refusal a few lines down, and the difference
     * is who is asking. That one withholds the list because naming spaces to a caller who could not reach
     * the one they tried hands an unauthorised party an inventory. These are this token's OWN spaces —
     * it can read the same list from `list_spaces` — so withholding them only makes the caller go and
     * fetch what the error could have told them.
     */
    const reachable = accessibleSpaceIds.length ? accessibleSpaceIds.join(', ') : 'none';
    return refuse(400, `Error: tool '${name}' needs a 'space' — this token reaches more than one, so `
      + `there is no single space it could mean. Choose one of: ${reachable}`);
  }

  /*
   * EVERY named space, not the first — for existence, for reach, AND for the rung.
   *
   * The rung check used to sit outside this loop, reading the first entry. On a single-space call that is
   * the same thing, which is why it survived; on a three-space `recall` the token was authorised against
   * one of the three and read all three. The REST body-scoped guard checked every one, so this was the
   * two-doors defect in its usual form: both defensible, one weaker, and only visible from outside.
   *
   * One unreachable name refuses the whole call — owner decision, 2026-09-16 — because dropping it returns a
   * SHORTER answer, and a caller cannot tell a filtered result from a small one. The refusal names only the
   * space that failed: listing the reachable ones hands an unauthorised caller an inventory of what exists.
   */
  /** The caller's own views this call NAMED, each with the spaces it reads for this tool: handed to the handler, never recomputed there. */
  const viewReads = new Map<string, readonly string[]>();
  const viewRow = tool && toolTakesAView(name) ? TOOL_RIGHTS.find(r => r.tool === name) : undefined;
  for (const sid of rawSpaces) {
    // The caller's OWN view, on a tool that reads data: the members it reads for this caller in this tool's area, now. Every other id
    // (a space, another token's view, an unknown id, a retired proxy id, or a view on a tool that does not take one) is answered by the one
    // existence rule: another token's view and an id that never existed answer in the same words.
    const own = viewRow && rights && isViewId(sid) ? resolveOwnView(ownerKey, sid, cfg) : null;
    if (own && viewRow && rights) {
      viewReads.set(sid, viewReadMembers({ rights, view: own, area: viewRow.area, needs: viewRow.needs, peerId }));
      continue;
    }
    const unknown = unknownSpaceAnswer(ownerKey, sid, false, cfg);
    if (unknown) {
      // A retired id is answered with its sentence alone and its code, to every caller; the rest carry the tool door's "Error: " prefix.
      return unknown.status === 410
        ? refuse(410, unknown.body.error, '', { ...unknown.body })
        : refuse(unknown.status, `Error: ${unknown.body.error}`);
    }
    // A space that exists (a name that does not was refused above): the row of a refusal below names it.
    facts.auditSpace = sid;
    if (!accessibleSpaceIds.includes(sid)) {
      return refuse(403, `Error: token does not have access to '${sid}'`);
    }
    const rightsRefusal = toolRightsRefusal(name, rights, sid);
    if (rightsRefusal) return refuse(403, rightsRefusal);
    // And the space-admin question, for the tools that configure ONE space. `toolIsVisible` admitted anyone
    // administering *a* space, because it runs before a space is named; this is where one exists.
    const adminRefusal = spaceAdminRefusal(tool, rights, sid);
    if (adminRefusal) return refuse(403, adminRefusal);
    // A peer token naming a space held while a wipe is applied on one side: the sync doors' 423, on this door too (W13) — and one
    // naming a space that is not held is counted in its fence until the call ends, as on every door (`sync/peer-space-admission.ts`).
    if (peerId) {
      const admission = admitPeerToolCall(peerId, sid);
      if ('held' in admission) return refuse(admission.held.status, admission.held.text, '', { ...admission.held.body });
      admitted.push(admission.release);
    }
  }
  const callSpace = rawSpace;
  // Every named space passed existence, reach and the rung: the row of what happens from here names the first one (a view's members replace it below).
  facts.auditSpace = callSpace;
  // Which door asked, in the judge's and the metric's vocabulary: `POST /api/<tool>` arrives as transport `rest` and is the `tool` door.
  const writeDoor = writeDoorOfTransport(caller.transport);

  /**
   * What a call that threw is answered with, whatever threw it: the one classification both doors share.
   *
   * It stands BEFORE the judge on purpose, and not for tidiness: every `return` of this function after the judge call is an exit of a
   * judged call and must go through `withUnknownFieldRows` (a gate holds it), whereas the returns in here only CLASSIFY — what they
   * answer is handed back to the catch arm below, which is the exit.
   */
  function answerThrown(err: unknown): ToolCallOutcome {
    const message = err instanceof Error ? err.message : String(err);
    // A refusal a shared module made with its own status (`ToolRefusal`): answered with that status, and not logged as a
    // tool's failure, because nothing failed.
    if (err instanceof ToolRefusal) {
      return {
        result: { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true, ...(err.body ? { structuredContent: { ...err.body } } : {}) },
        status: err.status, callSpace,
      };
    }
    /*
     * THE RECORD LANDED and its connections did not (`Q-170`) — matched before the store's classification below, which
     * looks through the wrapper to the failure it holds and would answer a stored record as a retryable `503`. The
     * answer is the one the REST door's error handler gives (`connectionsNotWrittenAnswer`), carried in
     * `structuredContent`; and the call is audited as a write of the record it named, which the arguments of a create
     * cannot (`facts.writtenId`, read by the one row `auditedToolCall` writes).
     */
    if (err instanceof ConnectionsNotWritten) {
      const connectionsNotWritten = connectionsNotWrittenAnswer(err, `tool ${name}`);
      log.warn(`tool '${peerText(name)}' stored its ${err.written.kind} and failed its connections in space '${peerText(callSpace || 'global')}', answered ${connectionsNotWritten.status}`);
      facts.writtenId = err.written.id;
      return {
        result: { content: [{ type: 'text' as const, text: connectionsNotWritten.body.error }], isError: true, structuredContent: { ...connectionsNotWritten.body } },
        status: connectionsNotWritten.status, callSpace,
      };
    }
    /*
     * Classified FIRST, because classifying a store failure logs the driver's text (`storeFailureAnswer`) — and this
     * line logged it as well, so every failed call wrote it twice (bundle-30 I12, verify-drive-2 finding 4). The line
     * still names the tool and the space; for the store's failure it says so instead of repeating the text. None of
     * the refusals below is a driver error, so classifying before them changes none of their answers.
     */
    const store = storeFailureAnswer(err, `tool ${name}`);
    // Said once per failure: a refusal a typed branch below answers, or the plain `Error` refusal the end of this function answers, says it
    // here; a FAULT is reported (cause and stack, once per tool and class per window) by `answerForCaught`, never also by this line.
    const sayRefusal = (): void => {
      log.warn(`tool '${peerText(name)}' error in space '${peerText(callSpace || 'global')}': ${store ? `store-side failure, answered ${store.status}` : peerText(message)}`);
    };
    const typed = (): ToolCallOutcome | null => {
    /*
     * Classified HERE, once, rather than in each tool — every write funnels through this catch, and the
     * alternative was editing a dozen throw sites, which is how the introduced/pre-existing split came to
     * survive on the REST routes and not on the MCP one. The prose stays the whole answer for a client that
     * reads only `content`.
     */
    // A refused MERGE answers what it answers on every merge door (`mergeRefusal`): 400 (a merge is the caller's to fix, never the family's
    // 422) with the standard schema-refusal body, or 422 merge_too_large. Asked BEFORE the generic schema mapping below — a refused merge IS
    // a `SchemaViolationError` now, and that mapping would flip `graph_merge` to 422 on this door and leave REST at 400 (R5-3).
    const merge = mergeRefusal(err);
    if (merge) {
      return { result: { content: [{ type: 'text' as const, text: `Error: ${merge.refusal.message}` }], isError: true, structuredContent: merge.refusal.toStructured() }, status: merge.status, callSpace };
    }
    if (err instanceof SchemaViolationError) {
      countSchemaRefusal(writeDoor, err);
      // A tool is an edit of what the caller named: the status is an update's, not spelled here.
      return {
        result: { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true, structuredContent: err.toStructured() },
        status: schemaRefusalStatus('update'), callSpace,
      };
    }
    /*
     * A STORE failure says so on both doors, and carries the same `retryable` flag. Without it an agent got
     * the truncated prose that told fourteen personas nothing, while a REST caller alongside it got a 503
     * and a reason.
     */
    /*
     * A record the call names and cannot find is a 404 on REST, as the routes answered before a tool served them
     * (`Q-89`: `similar` for an entry that does not exist). The prose is the tool's either way.
     */
    if (err instanceof NotFoundError) {
      return { result: { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }, status: 404, callSpace };
    }
    // A relabel onto an identity another edge holds: the REST route's 409 and body (`edgeIdentityTakenAnswer`).
    const identityTaken = edgeIdentityTakenAnswer(err);
    if (identityTaken) {
      return { result: { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true, structuredContent: { ...identityTaken.body } }, status: identityTaken.status, callSpace };
    }
    /*
     * A file act's refusal or failure (the kinds `files/act-answers.ts` defines): the status and body every REST door answers
     * (`answerFileActFailure`), the body carried as `structuredContent`.
     * Not a `ToolRefusal`: that is raised before the work and is not logged as a failure, and these come from an act that ran.
     */
    // An answer that is the server's own leaves the cause in the log (reported inside, as the REST door's is).
    const fileAct = answerFileActFailure(err, `tool ${name}`);
    if (fileAct) {
      return {
        result: { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true, structuredContent: { ...fileAct.body } },
        status: fileAct.status, callSpace, ...(fileAct.retryAfterSeconds !== undefined ? { retryAfterSeconds: fileAct.retryAfterSeconds } : {}),
      };
    }
    /*
     * A write the space's standing deletion, wipe or rename refused, or an act shutdown refused: the status and body the REST sender
     * answers (`spaceActAnswer`), carried as `structuredContent`. A SIBLING of the file-act answer and not
     * the rights guards' 403 text: the check runs in the writer, after every rights door passed.
     */
    const spaceClosed = spaceActAnswer(err);
    if (spaceClosed) {
      return { result: { content: [{ type: 'text' as const, text: `Error: ${spaceClosed.body.error}` }], isError: true, structuredContent: { ...spaceClosed.body } }, status: spaceClosed.status, callSpace };
    }
    // The same 409 the REST door answers: another write kept moving the record, nothing was written, retry.
    if (err instanceof WriteConflict) {
      return { result: { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }, status: writeRefusalAnswer(err, 'update')!.status, callSpace };
    }
    // The refusals of a local write's stamp (`record_version_at_ceiling`, a clock before the first usable instant, a position seed the store could
    // not read): the status and body REST answers (`writeRefusalAnswer`), carried as `structuredContent` beside the same sentence.
    // (A seed the store could not read is the store's failure and falls through to it below: `writeRefusalAnswer` answers null for that one.)
    // And a fork row named by an ordinary edit, or a re-key or merge past the fork cap (Q-624): the REST door's 409, `fork_row_read_only` or `fork_cap`.
    const stampRefusal = err instanceof RecordVersionAtCeiling || err instanceof PositionClockUnusable || err instanceof PositionsSeedUnavailable
      || err instanceof ForkRowReadOnly || err instanceof ForkCapRefusal || err instanceof EndpointRemoved || err instanceof LinkTargetRemoved
      ? writeRefusalAnswer(err, 'update') : null;
    if (stampRefusal) {
      return { result: { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true, structuredContent: { ...stampRefusal.body } }, status: stampRefusal.status, callSpace };
    }
    // The store's condition, answered as every door answers it (`storeFailureAnswer`, bundle-30 I6 `C1`); this
    // transport has no status line to carry it, so `storeSideFailure: true` says it in the body. The text is the
    // answer's message EXACTLY — no `Error: ` before it — so `/api/<tool>`, `/api/brain/recall` and MCP spell one
    // failure one way (bundle-30 I12, verify-drive-2 finding 5).
    if (store) {
      return {
        result: {
          content: [{ type: 'text' as const, text: store.body.error }],
          isError: true,
          structuredContent: { ...store.body, storeSideFailure: true },
        },
        status: store.status, callSpace, storeFailure: store,
      };
    }
      return null;
    };
    const claimed = typed();
    if (claimed) { sayRefusal(); return claimed; }
    // Nothing above claimed it: answered by what it IS, in our words (`answerForCaught`) — a fault of ours is a `500`, a file-system error
    // `file_system_fault`, a socket failure `502`, and only a plain `Error`, our refusal convention, is the caller's `400` and its message.
    const caught = answerForCaught(err, `tool ${name}`, { refusals: true });
    toolFailuresTotal.inc({ door: caller.transport, tool: name, class: caught.kind });
    if (caught.kind === 'refusal') sayRefusal();
    return {
      result: { content: [{ type: 'text' as const, text: `Error: ${caught.body.error}` }], isError: true,
        ...(caught.status === 400 ? {} : { structuredContent: { ...caught.body } }) },
      status: caught.status, callSpace,
    };
  }

  /** The members every view this call named reads, deduplicated (undefined when it named none): what is recorded and announced. */
  const viewSpacesRead = viewReads.size > 0 ? [...new Set([...viewReads.values()].flat())] : undefined;
  facts.viewSpaces = viewSpacesRead;

  /** The unknown-field rows of this call, once the judge has run; every answer from there on is given through `withUnknownFieldRows`. */
  let rows: readonly UnknownFieldRow[] = [];

  try {
    // Refused BEFORE it is counted (`Q-108`): `name` is whatever the caller sent, and as a metric label an
    // unknown one mints a new time series per spelling — unbounded cardinality from any authenticated caller.
    if (!tool) {
      return refuse(404, `Unknown tool: ${name}`, callSpace);
    }
    // A view's id is the caller's own text and unbounded as a label: it is one label, as a space's id is one per configured space.
    toolCallsTotal.inc({ tool: name, space: viewReads.size > 0 ? '@view' : (callSpace || 'global'), door: caller.transport });
    /*
     * A brain RECORD write is judged for an argument it does not take (Q-320, bundle-128): the target space is resolved here,
     * through the one function that does it for the dispatcher, because what becomes of such an argument is the setting of the
     * space the write LANDS in; then `answerUnknownWriteFields` answers by that setting — a refusal before anything is stored, or
     * the rows every answer from here on carries. A failed resolution is refused for that, with nothing said about the arguments
     * (resolution precedes the judge, as it does on REST). It is judged against the caller's grant (`toolWriteGrant`, `Q-440`),
     * and a refusal travels with its own status (`assertWriteTarget`): a member the token does not reach is never named, and a
     * missing rung is a 403.
     *
     * A batch (`save_bulk`) is not judged here: its top level is refused in every mode by the handler and its ITEMS are judged
     * one by one by the batch writer.
     */
    const judgedOperation = judgedOperationOfTool(name);
    if (judgedOperation !== null && !isBatchWriteOperation(judgedOperation)) {
      // The space the write LANDS in is the one the call named: reach and rung were judged on it above, and a view is never a write target
      // (a write tool is never offered one, and an own view named to it was refused as an unknown space).
      const judged = answerUnknownWriteFields(writeBodyOfToolCall(a, judgedOperation), judgedOperation, callSpace, writeDoor);
      rows = judged.rows;
      if (judged.refused) {
        return withUnknownFieldRows(refuse(400, `Error: ${judged.refusal!.error}`, callSpace, { ...judged.refusal }), rows);
      }
    }
    // Enforce the advertised inputSchema before the handler runs — except partial-success tools
    // (save_bulk), which report per-item errors in the result rather than rejecting the whole call. A judged tool's TOP level is
    // tolerated (its unknown arguments were answered above); everything nested is still held to the closed schema.
    if (!tool.skipSchemaValidation) {
      const argErr = validatorFor(accessibleSpaceIds, ownViewIds).validate(tool, a, { tolerateTopLevel: judgedOperation !== null });
      if (argErr) return withUnknownFieldRows(refuse(400, `Error: ${argErr}`, callSpace), rows);
    }
    /*
     * The destructive-call throttle, immediately before the handler runs — which is the LAST point at
     * which nothing has been destroyed, and therefore the right one.
     *
     * It is in this function rather than in front of the REST route because that is where it used to be:
     * express middleware on five routes, and nothing at all on the MCP door. An agent emptying a space in
     * a loop met no limit a browser would have hit at the fifth call.
     *
     * **It counts calls that REACH the handler, not attempts, and that is a reversal worth recording.**
     * The first version sat above the gates on the reasoning that a caller getting it wrong in a loop
     * should be slowed too. It does not survive contact: a refused call destroys nothing, so counting
     * refusals turns a malformed-argument loop into a lockout and makes the API hostile to anyone probing
     * it — five 400s and an integrator learning the shape of the call is locked out of the real one. The
     * rail exists to bound DESTRUCTION, and destruction begins one line below this.
     */
    const rateKey = caller.tokenId ?? caller.ip;
    if (tool.heavy && !consumeHeavyToolCall(rateKey)) {
      return withUnknownFieldRows(refuse(429, `Error: tool '${name}' is rate limited — too many destructive calls, try again shortly`, callSpace), rows);
    }
    const handlerSpaceIds = withoutHeldFor(toolReach(name, rights, accessibleSpaceIds), peerId);
    const result = await tool.handle({
      args: a,
      callSpace,
      callSpaces: rawSpaces,
      name,
      // Handed to the handler as well as recorded in the audit trail, because the default byte budget
      // depends on who is reading the answer rather than on which module produced it — see
      // `defaultBudgetChars`. Before this the tool modules chose MCP's number themselves, so a caller on
      // `POST /api/<tool>` got half the answer a caller on the legacy REST route got.
      transport: caller.transport,
      rateKey,
      cfg,
      // Narrowed to the tool's area for a read tool, so a search that names no space reads only where it may (Q-89).
      accessibleSpaces: accessibleSpaces.filter(sp => handlerSpaceIds.includes(sp.id)),
      accessibleSpaceIds: handlerSpaceIds,
      // Populated, not merely declared. `toolIsVisible(t, undefined)` hides every mutating and admin tool,
      // so an unpopulated `rights` here would empty `help`'s listing while `tools/list` stayed correct.
      rights,
      ...(caller.record ? { callerRecord: caller.record } : {}),
      viewReads,
      actor: { tokenId: caller.tokenId, tokenLabel: caller.tokenLabel },
      auditIdentity: { authMethod: caller.authMethod, oidcSubject: caller.oidcSubject },
      recordChanges: (before, after) => { facts.snapshots = { before, after }; },
      recordAuditChanges: (changes) => { facts.snapshots = { explicit: changes }; },
    });
    // A tool that returns `isError` failed on its own terms, so the status has to come from the RESULT or
    // every rejected write would be logged as a success. 422: the call was well-formed and it was refused.
    // A failed act after a passed vote is a FAILURE the act's tool answers with `spaceActFailureAnswer`'s body (design v5 section 2.2
    // v4 (3)): 500, as the REST route answers it - not the 422 of a call that was refused.
    const status = result?.isError ? (isSpaceActFailure(result) ? 500 : 422) : 200;
    // A read through a view says which members it read (the answer is narrowed to what the caller reads now, never silently).
    return withUnknownFieldRows({ result: result && !result.isError ? announceViewMembers(result, viewSpacesRead) : result, status, callSpace }, rows);
  } catch (err) {
    const answer = answerThrown(err);
    // Recorded by `auditedToolCall`, at the status `answer` carries: a refusal, a conflict, a store failure and a fault are each one row.
    return withUnknownFieldRows(answer, rows);
  }
}

/**
 * Re-exported, not re-implemented. Both lived here until the materialisation had to be shared with
 * `validate-args.ts`, which this file imports — a cycle, and the honest signal that deciding what schema
 * a token sees is a third thing rather than part of dispatching a call. See `mcp/tool-schema.ts`.
 */
export { toolSchemasFor, materialisedSchema } from './tool-schema.js';
