/**
 * Network governance — vote-round conclusion and member-removal notification.
 *
 * These were exported from the api/sync.ts ROUTE module and imported by five others
 * (api/invite.ts, api/networks/{join,members,votes}.ts, sync/engine.ts) — route modules importing
 * domain logic from another route module. They are domain logic, so they live here now (A17.6).
 *
 * Round state is config (`network.pendingRounds`), persisted via saveConfig — not in-memory — which
 * is why both the HTTP surfaces and the sync engine can safely drive conclusion.
 */
import { getConfig, saveConfig } from '../config/loader.js';
import { revokePeerCredentialsIfOrphaned } from '../auth/tokens.js';
import { log, peerList, peerText, refusalOfParse } from '../util/log.js';
import { convertRecordsSignedByProposer } from '../util/signing.js';
import { inlineResolvableRefs } from '../spaces/schema-validation.js';
import {
  ConvertRecordsZ, conversionStepIssues,
  type ConvertRecords, type ConversionStep, type ConversionMeta, type ConversionIssueCode,
} from '@ythril-network/schema/internal';
import { commitOwnMetaEdit, storeNetworkLayer } from '../spaces/effective-meta.js';
import { carriedLocalId } from './space-map.js';
import { buildBraintreeAncestors } from '../util/braintree.js';
import { sendNotice } from '../networks/notify-members.js';
import { publishesOn } from '../networks/network-role.js';
import { parseMetaRound, type MetaRoundParse, type MetaRoundProposal } from './meta-round-merge.js';
import type { NetworkConfig, SpaceMeta, VoteRound } from '../config/types.js';
import type { ParsedSpaceMeta } from '../spaces/body-schemas.js';
import { keyedLock } from '../util/keyed-lock.js';
import { settleSpaceAct } from '../spaces/apply-wipe-round.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { metaChangeNote, queueGeneratedNote } from './change-notes.js';
import { isSpaceActRound, roundConversionOwed, roundPastDeadline } from '../networks/round-state.js';
import { roundElectorate, votersOf } from '../networks/round-electorate.js';
import { recordRoundOutcome } from '../networks/round-outcomes.js';

export { roundElectorate };

/**
 * Recompute the braintree ancestor voter set for a round from this instance's
 * own view of the tree, so conclusion never depends on a peer-supplied
 * `requiredVoters` *set*. Returns null for round types that are not
 * ancestor-gated (space_deletion / meta_change) or when no anchor is available —
 * the caller then falls back to requiring every member to vote yes.
 *
 * The round's `requiredVoters[0]` is the anchor node the proposer computed the
 * chain from (the inviting node for a join, the subject's parent for a remove).
 * We trust only that single anchor and recompute the FULL chain from it against
 * our local topology. This exactly reproduces the proposer's set for legitimate
 * rounds, but a peer cannot SHRINK the required set: anchoring on `[attacker]`
 * still recomputes the real ancestor chain from the attacker up to the root, so
 * every genuine ancestor must still vote yes.
 */
export function localBraintreeRequiredVoters(
  net: import('../config/types.js').NetworkConfig,
  round: import('../config/types.js').VoteRound,
): string[] | null {
  if (round.type !== 'join' && round.type !== 'remove') return null;
  const anchor = round.requiredVoters?.[0];
  if (!anchor) return null;
  return buildBraintreeAncestors(net, getConfig().instanceId, anchor);
}

/**
 * Decide whether `round` is over at `now`, and conclude it if so. Returns whether it just PASSED.
 *
 * `now` is the ONE reading of the clock the caller took for this request: the deadline is judged against it, and it is the
 * `concludedAt` the round and its outcome entry carry, so a request cannot refuse a cast for being late and then conclude the
 * round as if it were not. A round is open AT its deadline instant (`round-state.ts`).
 *
 * How it ended is recorded as the LOCAL `outcome` (`passed`, `vetoed`, `expired`) and written to the network's outcome log in
 * the same step. A veto beats expiry: a cast's `castAt` is unsigned and a relayer can set it, so it decides no label.
 */
export function concludeRoundIfReady(
  net: import('../config/types.js').NetworkConfig,
  round: import('../config/types.js').VoteRound,
  now: number = Date.now(),
): boolean {
  const verdict = roundVerdict(net, round, now);
  if (verdict === 'vetoed' || verdict === 'expired') {
    round.concluded = true;
    round.passed = false;
    round.outcome = verdict;
    round.concludedAt = new Date(now).toISOString();
    recordRoundOutcome(net, round, now);
    // A failed JOIN leaves the candidate's provisioned credentials (peer PAT
    // issued at invite/apply time, outbound token in secrets) with no membership
    // to justify them — revoke unless something else still references the
    // instance. Deferred a tick so the caller's saveConfig runs first.
    if (round.type === 'join' && round.subjectInstanceId) {
      const rejectedId = round.subjectInstanceId;
      setImmediate(() => {
        revokePeerCredentialsIfOrphaned(rejectedId)
          .catch(err => log.error(`peer credential revocation for rejected joiner ${peerText(rejectedId)}: ${peerText(err)}`));
      });
    }
    return false;
  }
  if (verdict === 'passed') {
    round.concluded = true;
    round.passed = true;
    round.outcome = 'passed';
    round.concludedAt = new Date(now).toISOString();
    // Before the passed round acts: a removal takes its subject off the roster, and the count belongs to the electorate that decided.
    recordRoundOutcome(net, round, now);
    // On join round pass: the candidate will call join again and get a 200 with member list
    // On remove round pass: remove the member
    if (round.type === 'remove') {
      const idx = net.members.findIndex(m => m.instanceId === round.subjectInstanceId);
      if (idx >= 0) net.members.splice(idx, 1);
      // Revoke the ejected peer's credentials once it holds no membership anywhere.
      // Deferred a tick so the caller's saveConfig (and the member_removed notify,
      // which still needs our outbound token) run first.
      const ejectedId = round.subjectInstanceId;
      if (ejectedId) {
        setImmediate(() => {
          revokePeerCredentialsIfOrphaned(ejectedId)
            .catch(err => log.error(`peer credential revocation for ${peerText(ejectedId)}: ${peerText(err)}`));
        });
      }
    }
    // On meta_change round pass: apply the fields this round proposed to the space's CURRENT meta.
    //
    // Not `{ meta: round.pendingMeta }`. That snapshot was computed when the round opened, and rounds stay
    // open for `votingDeadlineHours` — so writing it wholesale reverts every field another round changed
    // in the meantime, with no error and a correctly-recorded carried vote to hide it.
    // The round names the space by the NETWORK's id; this instance may carry it under another (F-39.4) — and acts
    // only on a space this network carries here (S-7). What is written, and that it is parsed first, is `passedMetaChange`'s.
    if (round.type === 'meta_change') passedMetaChange.apply(net, round);
    return true;
  }
  return false;
}

/**
 * How `round` stands at `now` by this network's rule, PURE — it writes nothing, not even to the round (bundle-106, W22): `vetoed`,
 * `expired`, `passed`, or `null` while it is still undecided. {@link concludeRoundIfReady} concludes on it; the "acts now or opens a
 * vote" forecast (`networks/round-forecast.ts`) reads it on a scratch round, so the forecast is the real pass rule and applies nothing.
 * A veto beats expiry.
 */
export function roundVerdict(
  net: import('../config/types.js').NetworkConfig,
  round: import('../config/types.js').VoteRound,
  now: number = Date.now(),
): 'vetoed' | 'expired' | 'passed' | null {
  // Who votes is `votersOf`'s (the subject is left out only where it is the member voted ON — a join or a removal; on every
  // other round it is the PROPOSER, a voter like any member, whose yes is cast for it when the round opens, S-7; owner,
  // 2026-09-25: "of course a proposer votes yes ... require the yes but set it automatically". Dropping it there let a peer
  // name any member as proposer and so drop that member's vote from the quorum).
  const { voters, localInstanceId, localIsVotedOn } = votersOf(net, round);
  const vetoCount = round.votes.filter(v => v.vote === 'veto').length;
  if (vetoCount > 0) return 'vetoed';
  if (roundPastDeadline(round, now)) return 'expired';

  // For unanimous-requirement types (closed, braintree): every remote voter must have voted yes
  // individually. A self/proposer yes vote counts as evidence of intent but does NOT short-circuit
  // the requirement for all listed members to vote.
  //
  // SECURITY: when there are no remote voters (the only member left is the round's
  // subject), conclude ONLY if THIS instance itself voted yes — i.e. a local
  // operator proposed the action. A self-initiated remove / space_deletion casts
  // our own yes when the round opens, so legitimate solo actions still pass. An
  // empty voter set was previously treated as vacuously "all voted yes", so a round
  // ADOPTED via gossip (which never carries our vote) concluded on an empty
  // quorum — letting a malicious peer in a small network force a
  // remove / space_deletion / meta_change through with no legitimate vote. Forged
  // casts are dropped by acceptVoteCast, so an adopted forged round holds no local
  // yes and correctly never concludes here.
  const localVotedYes = round.votes.some(
    c => c.instanceId === localInstanceId && c.vote === 'yes',
  );
  const allRemoteVotedYes =
    voters.length === 0
      ? localVotedYes
      : voters.every(v => round.votes.some(c => c.instanceId === v.instanceId && c.vote === 'yes'));
  // Unanimous means EVERY member, and `net.members` lists every member but this one (`Q-76`). Counting only the
  // remote yeses let a member that adopted a round by gossip pass it on the others' word alone — on two members, the
  // proposer decided for the other, whose own data the round then deleted or wiped. The proposer's yes is cast when
  // the round opens, so its own path is unchanged. The subject of a join or removal is not asked about itself, so
  // when this instance IS that subject its own yes is not required here either.
  const everyMemberVotedYes = allRemoteVotedYes && (localVotedYes || localIsVotedOn);

  const yesCount = round.votes.filter(v => v.vote === 'yes').length;

  let passed = false;
  switch (net.type) {
    case 'closed':
      passed = everyMemberVotedYes;
      break;
    case 'braintree': {
      // SECURITY: recompute the ancestor voter set from the LOCAL topology rather
      // than trusting `round.requiredVoters`. Once a round is adopted via gossip,
      // that field is attacker-controllable — a malicious peer could shrink it to
      // `[attacker]` and, with its own (authentic) yes vote, force a join/remove/
      // space_deletion to conclude on the victim. The local recomputation yields
      // the same set for legitimate rounds and cannot be shrunk by a peer.
      const localRequired = localBraintreeRequiredVoters(net, round);
      if (localRequired && localRequired.length > 0) {
        const relevant = localRequired.filter(id => id !== round.subjectInstanceId);
        passed = relevant.every(id =>
          round.votes.some(c => c.instanceId === id && c.vote === 'yes'),
        );
      } else {
        // No locally-derivable ancestor set (e.g. space_deletion / meta_change, a
        // pre-requiredVoters round, or an incomplete local tree view): fall back to
        // requiring EVERY current member to have voted yes — never fewer, this one included.
        passed = everyMemberVotedYes;
      }
      break;
    }
    case 'democratic': {
      // A majority of EVERY member, this one included unless the round is about it (`Q-77`). The count compared the
      // yeses against half the OTHER members, so on an even-sized network exactly half passed — on two members the
      // proposer's own automatic yes decided for both. Only a member's yes counts.
      const { eligible, yes: memberYes } = roundElectorate(net, round);
      passed = memberYes > eligible / 2;
      break;
    }
    case 'club':
      // For Club: only the inviter (first yes voter) decides
      passed = yesCount >= 1 && vetoCount === 0;
      break;
    case 'pubsub':
      // For Pubsub: the publisher (first yes voter) decides — except that a deletion or wipe on a network where THIS instance is the
      // publisher passes only when it opened the round (D-40, X10). Every other such round there is a subscriber's, whose deletion or
      // wipe is its own local act; one an older publisher adopted before the upgrade would otherwise pass at the next gossip or relay
      // and empty the publisher's space for every subscriber. Decided from the local role and a local field, never a wire field.
      passed = yesCount >= 1 && vetoCount === 0
        && !(isSpaceActRound(round.type) && publishesOn(net) && round.proposedHere !== true);
      break;
  }
  return passed ? 'passed' : null;
}

/**
 * What a passed `meta_change` round would write on this instance, parsed — or why this member cannot read it; `null` when the round
 * is not about a space this network carries here (`Q-216`, R6-6).
 *
 * One plan per store the round writes, each parsed AGAINST the base it merges into (`parseMetaRound`): the proposer's own definitions
 * and, where it holds one, this network's layer; every other member's is the layer alone. If ANY of them cannot be read the whole
 * round is unreadable here — refused whole, never in part, as `sync-protocol.md` already promises — so this is asked before a single
 * store is written, and by a member deciding whether to cast its yes on the round at all (`castVoteAct`).
 */
export function planPassedMetaChange(net: NetworkConfig, round: VoteRound): MetaRoundPlan | null {
  const localSpace = round.type === 'meta_change' ? carriedLocalId(net, round.spaceId) : null;
  if (!localSpace || !round.pendingMeta) return null;
  const space = getConfig().spaces.find(s => s.id === localSpace);
  const proposal = round as MetaRoundProposal;
  const layerBase = net.schemaLayers?.[localSpace];
  // Who proposed it is what THIS instance recorded when it opened the round — never `subjectInstanceId` (S-7).
  const ownEdit = round.proposedHere === true && round.proposesLayer !== true;
  // The proposer's own edit goes through its own definitions (F-39.2) so a layered space keeps it. A proposal TO a network (F-39.5)
  // is not one: it was that network's definition all along. Anyone else: the NETWORK decided it, so it lands in that network's layer
  // (F-39.4), and replaying an old round on a late joiner can only refresh the layer, never overwrite what this instance defined.
  const own = ownEdit ? parseMetaRound(space?.ownMeta ?? space?.meta, proposal) : undefined;
  // Q-60: and the network's layer, where this instance holds one. Every other member keeps the passed round in that layer, and a
  // layer outranks own definitions — so a proposer that wrote only its own kept the layer's OLD value in front of its own edit, and
  // was the one instance on which its change could not be seen.
  const layer = !ownEdit || layerBase ? parseMetaRound(layerBase ?? {}, proposal) : undefined;
  const failed = [own, layer].filter((r): r is Extract<MetaRoundParse, { ok: false }> => r !== undefined && !r.ok);
  if (failed.length > 0) return { ok: false, localSpace, reason: failed.map(f => f.reason).join('; ') };
  const ok = (r: MetaRoundParse | undefined) => (r?.ok ? r : undefined);
  return {
    ok: true, localSpace, ownEdit,
    ...(ok(own) ? { own: ok(own)!.meta } : {}),
    ...(ok(layer) ? { layer: ok(layer)!.meta } : {}),
    conflicts: (ok(own) ?? ok(layer))?.conflicts ?? [],
    unknownFields: [...(ok(own)?.unknownFields ?? []), ...(ok(layer)?.unknownFields ?? [])],
  };
}

/** The plan {@link planPassedMetaChange} answers. */
export type MetaRoundPlan =
  | { ok: true; localSpace: string; ownEdit: boolean; own?: ParsedSpaceMeta; layer?: ParsedSpaceMeta; conflicts: string[]; unknownFields: string[] }
  | { ok: false; localSpace: string; reason: string };

/**
 * What a passed `meta_change` round DOES here: parse every part it writes, and write all of it or none of it.
 *
 * A member object rather than a function of its own: it is reached from `concludeRoundIfReady` and from nowhere else, and the
 * conclusion it hangs off is called by the proposer's own path (`applySpaceMetaUpdate`) on the same tick, where the proposal is
 * already parsed — the application is a step of a conclusion, not a function a caller may pick up.
 */
export const passedMetaChange = {
  apply(net: NetworkConfig, round: VoteRound): void {
    const plan = planPassedMetaChange(net, round);
    if (plan === null) return;
    if (!plan.ok) {
      // Refused whole. The vote is carried, so the round stays passed — but this member keeps what it had in every store, says why on
      // the round (the view an operator reads) and in the log, and its yes was never cast on it (`castVoteAct`).
      round.refusedHere = peerText(plan.reason, { max: 1000 });
      log.warn(`meta_change round ${peerText(round.roundId)} passed but this member cannot read what it proposes for space '${peerText(plan.localSpace)}', so none of it is applied: ${peerText(plan.reason, { max: 1000 })}`);
      return;
    }
    const currentMeta = getConfig().spaces.find(s => s.id === plan.localSpace)?.meta;
    if (plan.own) commitOwnMetaEdit(plan.localSpace, () => plan.own!);
    if (plan.layer) storeNetworkLayer(net.id, plan.localSpace, plan.layer);
    // `Q-746`: what this member does with its records, decided from the effective schema before the stores above were written and after.
    startRoundConversion(net, round, plan, currentMeta);
    // F-42 / Q-61: the proposer tells the members below what the network just changed — on every path a round
    // passes by, at once or later. A no-op on a network with nobody below this instance.
    if (round.proposedHere) {
      void queueGeneratedNote(net.id, metaChangeNote(getConfig().instanceLabel, net.label, plan.localSpace,
        { fields: round.metaChangedFields, changedTypes: round.changedTypes, keptTypes: round.keptTypes }), [plan.localSpace]);
    }
    if (plan.unknownFields.length > 0) {
      log.warn(`meta_change round ${peerText(round.roundId)} named field(s) this release does not know, applied without them: ${peerList(plan.unknownFields, ', ')}`);
    }
    if (plan.conflicts.length > 0) {
      // The vote wins — the network decided this value — but the operator whose edit it superseded has
      // to be able to find out, and the only place that can say so is here.
      log.warn(
        `meta_change round ${peerText(round.roundId)} overwrote field(s) changed since it was proposed ` +
        `(space ${peerText(round.spaceId)}, based on meta v${round.baseMetaVersion}, now v${currentMeta?.version ?? 0}): ` +
        `${peerList(plan.conflicts, ', ')} — the passed vote wins`,
      );
    }
  },
};

// ── What a member does with the steps a passed round carries ──────────────────────

/** Why a member refused the steps of a round: the proposer did not sign them, they do not fit the round's own change, or a step's own code. */
export type RoundConvertRefusal =
  | 'steps_not_signed' | 'step_target_not_in_round' | 'property_still_declared_here' | ConversionIssueCode;

/**
 * What a member decided for a passed `meta_change` round: the SCHEMA half (apply it, or refuse the round whole because this member cannot read it)
 * and the STEPS half (none carried, apply them, or refuse them with a reason). A refused step leaves the schema half as the plan has it.
 */
export type RoundConvertDecision =
  | { schema: 'refused'; convert: { state: 'none' } }
  | { schema: 'apply'; convert:
      | { state: 'none' }
      | { state: 'apply'; convertRecords: ConvertRecords }
      | { state: 'refused'; reason: RoundConvertRefusal; message: string; step: number | null } };

/** What the member itself holds that the round does not carry: its effective meta before the round lands, and once it has landed. */
export interface HeldForConvert { before?: ConversionMeta; after?: ConversionMeta }

/** The types of `held` the round does not carry, laid under the types it does: the schema a member reads as "before". */
function beforeOfRound(round: VoteRound, held: ConversionMeta | undefined): ConversionMeta {
  const carried = inlineResolvableRefs(round.metaBase ?? {}).typeSchemas as Record<string, Record<string, unknown> | undefined> | undefined;
  const have = (held?.typeSchemas ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const typeSchemas: Record<string, Record<string, unknown>> = {};
  for (const kind of new Set([...Object.keys(have), ...Object.keys(carried ?? {})])) typeSchemas[kind] = { ...(have[kind] ?? {}), ...(carried?.[kind] ?? {}) };
  return { typeSchemas };
}

/** The `kind:Type` each type step moves records INTO: what the round has to have changed for the move to be the round's own. */
function typeStepTargets(step: ConversionStep): string[] {
  if (step.op === 'renameType') return [`${step.kind}:${step.to}`];
  if (step.op === 'splitType') return [...new Set([...step.cases.map(c => c.to), ...(step.otherwise === undefined ? [] : [step.otherwise])])].map(t => `${step.kind}:${t}`);
  return [];
}

/**
 * What THIS member does with the steps a passed `meta_change` round carries, decided from the round itself (`Q-745`, bundle-284 design 2.4, 3, 1.5).
 *
 * ## What it prevents
 *
 * Steps on a round can make every member rewrite its records, and the round came through whoever relayed it. So a member never applies steps on a
 * relayer's word, and a refused step never refuses the schema:
 *
 * - **Unsigned steps are not applied.** Only when the proposer's cast carries a `csig` that verifies over the steps as the round carries them
 *   (`convertRecordsSignedByProposer`). A missing, stripped or failing `csig`, and steps added to a round whose proposer chose none, are refused as
 *   `steps_not_signed`: the schema lands as the network voted it and the steps do not.
 * - **Steps that do not fit the round's own change are not applied.** Each is held to the round's `metaBase` and `pendingMeta`, which every member sees
 *   alike (a layer this member already pulled cannot make the check fail), by the same check the save made (`conversionStepIssues`); each type step's
 *   target must be a type the round changed; and the member's own effective meta once the round has landed must no longer declare a renamed property's
 *   old name, because own and layer definitions union their properties and a name any definition keeps is a name records may still hold.
 * - **What the round does not carry, the member holds.** `metaBase` holds the types the round CHANGED, and a type a type step moves records out of is
 *   one the round leaves alone (a network keeps it), so `held.before` fills in the types the round did not carry. Never over one it did.
 * - **A round this member cannot read is refused whole, as ever,** and starts nothing: `plan.ok === false` is the schema half, not a step's.
 *
 * Pure: it reads the net's pinned keys and nothing of the instance, and it starts nothing. What it answers is the one thing a later step wires to
 * the run: `convert.state === 'apply'` with the steps to start it from, or `'refused'` with the reason to record, or `'none'`.
 */
export function decideRoundConvertRecords(net: Pick<NetworkConfig, 'id' | 'members'>, round: VoteRound, plan: MetaRoundPlan, held: HeldForConvert = {}): RoundConvertDecision {
  if (!plan.ok) return { schema: 'refused', convert: { state: 'none' } };
  if (round.convertRecords === undefined) return { schema: 'apply', convert: { state: 'none' } };

  const refuse = (reason: RoundConvertRefusal, message: string, step: number | null = null): RoundConvertDecision =>
    ({ schema: 'apply', convert: { state: 'refused', reason, message, step } });

  if (!convertRecordsSignedByProposer(net, round)) {
    return refuse('steps_not_signed', 'the steps are not signed by the proposer of this round, so this instance applies the schema as voted and none of the steps');
  }
  const parsed = ConvertRecordsZ.safeParse(round.convertRecords);
  if (!parsed.success) return refuse('malformed_step', `the steps the round carries are not valid: ${refusalOfParse(parsed.error).error}`);
  const steps = parsed.data.steps ?? [];

  if (steps.length > 0) {
    const issue = conversionStepIssues(steps, beforeOfRound(round, held.before), inlineResolvableRefs(round.pendingMeta ?? {}) as ConversionMeta)[0];
    if (issue) return refuse(issue.code, `step ${issue.step}: ${issue.message}`, issue.step);

    const changed = new Set(round.changedTypes ?? []);
    for (const [i, step] of steps.entries()) {
      const missing = typeStepTargets(step).find(t => !changed.has(t));
      if (missing !== undefined) {
        return refuse('step_target_not_in_round', `step ${i}: the round does not change ${peerText(missing)}, the type this step moves records into`, i);
      }
    }
    const heldAfter = held.after?.typeSchemas as Record<string, Record<string, { propertySchemas?: Record<string, unknown> } | undefined> | undefined> | undefined;
    for (const [i, step] of steps.entries()) {
      if (step.op === 'renameProperty' && heldAfter?.[step.kind]?.[step.type]?.propertySchemas?.[step.from] !== undefined) {
        return refuse('property_still_declared_here', `step ${i}: this instance's own definitions still declare ${peerText(step.from)} on the ${step.kind} type `
          + `${peerText(step.type)} once the round has landed, so records may still hold it`, i);
      }
    }
  }
  return { schema: 'apply', convert: { state: 'apply', convertRecords: parsed.data } };
}

// ── The conversion run a schema change starts or restarts, one start at a time per space ──────────────────────────────

/** The housekeeping step a start or restart that failed is reported under. */
const SCHEMA_CONVERT_START_STEP = declareStep('Schema convert start');
/** The longest a failure's words are kept on an answer. */
const START_ERROR_TEXT_MAX = 300;
/** The status a start that threw is answered with: the store's or the module's failure, never the caller's. */
const NOT_STARTED_STATUS = 500 as const;
/** Every start and restart of a space's run takes this space's turn, in the order asked. */
const convertTurns = keyedLock();
/** The start a passed round made here, while it is being made: the proposer's own save reads it to say what started (`roundConvertStartOf`). */
const roundConvertStarts = new Map<string, Promise<SchemaConvertStarted>>();

/** One type a run converts (`*`: the whole kind), as the run module names it. */
export interface SchemaConvertTypeRef { kind: string; type: string }

/** What a start hands the run module (its `SchemaConvertStart`, spelt here by shape: this module may not name that one, see {@link SchemaConvertRuns}). */
export interface SchemaConvertStartRequest {
  spaceId: string;
  types: readonly SchemaConvertTypeRef[];
  steps?: readonly ConversionStep[];
  stepsRefused?: readonly { step: ConversionStep | null; reason: string }[];
  source: { kind: 'write' | 'round' | 'act'; roundId?: string };
  before?: ConversionMeta;
}

/** What a start answered, or the failure it threw, said as an answer (the save that asked it has landed and is not undone). */
export type SchemaConvertStarted =
  | { ok: true; state: string; run: { toFp: string } | null }
  | { ok: false; status: number; code: string; error: string };

/**
 * The functions of the conversion run module this one calls, handed in by a module the server always loads and no member of the large import cycle
 * reaches (`api/spaces.ts`): the run module reaches this one through the sync engine, so this one naming it, statically, dynamically or by a type,
 * would put the run module into the server's largest import cycle, whose size is held to a ceiling. Method syntax, so the run module's own narrower
 * parameter types are accepted as they are.
 */
export interface SchemaConvertRuns {
  start(start: SchemaConvertStartRequest): Promise<SchemaConvertStarted>;
  restart(spaceId: string): Promise<boolean>;
  typesToConvert(input: {
    changedTypes: readonly string[]; droppedTypes: readonly string[]; inNetwork: boolean; rulesBefore?: unknown; rulesAfter?: unknown; steps?: readonly ConversionStep[];
  }): SchemaConvertTypeRef[];
  /** The run of a space as it stands (its sources name the rounds it was started for), or null when it never had one. Writes nothing. */
  status(spaceId: string): Promise<{ toFp: string; sources: readonly { roundId?: string }[] } | null>;
  /** Arm the watcher, whose tick starts every round's run still owed: after a start that failed, so it is tried again. */
  wake(): void;
}

let convertRuns: SchemaConvertRuns | undefined;

/** Hand this module the run module's functions (once, at the load of the module that holds both). */
export function useSchemaConvertRuns(runs: SchemaConvertRuns): void { convertRuns = runs; }

/** The run module's functions, or a throw naming what was never wired: a start without them is a failure said, never a run silently not made. */
function runsOrThrow(): SchemaConvertRuns {
  if (!convertRuns) throw new Error('the schema conversion run was never wired into governance (useSchemaConvertRuns): spaces/meta-update.js is not loaded');
  return convertRuns;
}

/** The types a run of a schema change reaches (`typesToConvert` of the run module). Throws when the run module was never wired. */
export function schemaConvertTypes(input: Parameters<SchemaConvertRuns['typesToConvert']>[0]): SchemaConvertTypeRef[] {
  return runsOrThrow().typesToConvert(input);
}

/** `err` as the words an answer carries, bounded. */
const failureText = (err: unknown): string => peerText(err instanceof Error ? err.message : String(err), { max: START_ERROR_TEXT_MAX });

/** A start that threw, reported through the shared reporter and said as an answer. */
function notStarted(spaceId: string, err: unknown): SchemaConvertStarted {
  reportSpaceFailure(SCHEMA_CONVERT_START_STEP, spaceId, err, { when: 'next tick for a passed round, with the next save for a save' });
  return { ok: false, status: NOT_STARTED_STATUS, code: 'schema_convert_not_started', error: failureText(err) };
}

/**
 * Start a conversion run in the space's turn (`Q-746`): the start of a schema save (source `write`), of a passed round (`round`), each after the
 * one before it for the same space has finished.
 *
 * ## What it prevents
 *
 * - **Two starts that each read "no run" and write their own.** A start reads the run document and then writes it; two at once on one space (a save
 *   whose rounds passed in two networks, a round concluded while a save starts) would each write a new run and the second would erase the
 *   first's source, a round's owed mark among them. In one turn, the second finds the first unfinished and joins it.
 * - **A failed start failing the save that already landed.** It never rejects: a failure is reported through the shared reporter and answered as
 *   `schema_convert_not_started` with its words, for the caller to say on its answer.
 */
export function startSchemaConvertInTurn(start: SchemaConvertStartRequest): Promise<SchemaConvertStarted> {
  return convertTurns.run(start.spaceId, async () => {
    try {
      return await runsOrThrow().start(start);
    } catch (err) {
      return notStarted(start.spaceId, err);
    }
  });
}

/**
 * Restart the unfinished run of each of `spaceIds` toward the schema it has now, in the space's turn (`restartSchemaConvertRun`): what a door that
 * changes a schema and takes no `convertRecords` asks after its write (design 2.1, 5.2), so the types the run had not finished are converted
 * toward the schema the door left and not one that is gone. A space with no unfinished run is left alone. Never rejects: a failure is reported
 * through the shared reporter, and the run's own fingerprint check restarts it at its next page.
 */
export async function restartSchemaConvertInTurn(spaceIds: readonly string[]): Promise<void> {
  await Promise.all([...new Set(spaceIds)].map(spaceId => convertTurns.run(spaceId, async () => {
    try {
      await runsOrThrow().restart(spaceId);
    } catch (err) {
      reportSpaceFailure(SCHEMA_CONVERT_START_STEP, spaceId, err, { when: 'at the run\'s next page' });
    }
  })));
}

/** The start the passed round `roundId` is making here, while it is in flight; `undefined` when it made none or has finished. */
export function roundConvertStartOf(roundId: string): Promise<SchemaConvertStarted> | undefined {
  return roundConvertStarts.get(roundId);
}

/** A meta as a conversion step and the run read it: library `$ref`s inlined. */
const resolvedMeta = (meta: Partial<SpaceMeta> | undefined): ConversionMeta | undefined =>
  (meta === undefined ? undefined : inlineResolvableRefs(meta) as ConversionMeta);

/**
 * What a passed `meta_change` round starts on THIS member once its stores are written (`Q-745`, `Q-746`, design 3, 4.1, 4.2): the decision of
 * {@link decideRoundConvertRecords} on the member's effective schema before the round landed and after, made into a run.
 *
 * - `apply`: a run with the round's steps, source `round` with the round's id, owed until it completes;
 * - `refused` (owner: "Schema yes, steps no"): a run with NO steps and `stepsRefused` naming why, so the copies that conform are stamped and the rest
 *   reach Review, and this member rewrites nothing;
 * - `none`: no run; an unfinished one is restarted toward the schema the round left, as any door that takes no steps does.
 *
 * **Owed from the moment the round passes here, and started exactly once** (decision 12: an act a vote passed is the instance's to finish). The round
 * is marked done (`appliedHere`, by its one writer `settleSpaceAct`, saved) only AFTER its run document exists; until then it is owed, and the boot
 * resume and the watcher's tick start every round still owed ({@link startOwedRoundConversions}). Each start first asks whether the run already
 * names the round, in the space's turn, so a crash after the run document and before the mark settles the round and starts nothing more. A start
 * that fails is reported and wakes the watcher, which tries it again. While one is in flight, a second conclusion or a tick does not start another.
 */
function startRoundConversion(net: NetworkConfig, round: VoteRound, plan: Extract<MetaRoundPlan, { ok: true }>, before: SpaceMeta | undefined): void {
  if (round.appliedHere === true || startingRounds.has(round.roundId)) return;
  const after = getConfig().spaces.find(s => s.id === plan.localSpace)?.meta;
  const held: HeldForConvert = { before: resolvedMeta(before), after: resolvedMeta(after) };
  const decision = decideRoundConvertRecords(net, round, plan, held);
  if (decision.schema !== 'apply') return;
  if (decision.convert.state === 'none') { void restartSchemaConvertInTurn([plan.localSpace]); return; }
  const steps = decision.convert.state === 'apply' ? [...(decision.convert.convertRecords.steps ?? [])] : [];
  const stepsRefused = decision.convert.state === 'refused' ? [{ step: null, reason: decision.convert.reason }] : [];
  const { roundId } = round;
  const spaceId = plan.localSpace;
  startingRounds.add(roundId);
  const started = convertTurns.run(spaceId, async (): Promise<SchemaConvertStarted> => {
    try {
      const runs = runsOrThrow();
      // Started already (a crash after the run document and before the round was marked): settle the round, start nothing more.
      const existing = await runs.status(spaceId);
      if (existing?.sources.some(s => s.roundId === roundId)) return { ok: true, state: 'started', run: { toFp: existing.toFp } };
      const types = runs.typesToConvert({
        changedTypes: round.changedTypes ?? [], droppedTypes: [], inNetwork: true, rulesBefore: before?.rules, rulesAfter: after?.rules, steps,
      });
      return await runs.start({
        spaceId, types, steps, ...(stepsRefused.length > 0 ? { stepsRefused } : {}), source: { kind: 'round', roundId }, before: beforeOfRound(round, held.before),
      });
    } catch (err) {
      return notStarted(spaceId, err);
    }
  }).then((out) => {
    if (out.ok) markRoundConverted(net.id, roundId);
    else convertRuns?.wake();
    return out;
  }).finally(() => { startingRounds.delete(roundId); roundConvertStarts.delete(roundId); });
  roundConvertStarts.set(roundId, started);
}

/** The rounds whose run start is in flight here: neither a second conclusion nor a tick starts another while one is. */
const startingRounds = new Set<string>();

/** Mark the round `roundId` of network `netId` done here, in the live config, and save it: its run document exists. */
function markRoundConverted(netId: string, roundId: string): void {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === netId);
  const round = net?.pendingRounds.find(r => r.roundId === roundId);
  if (!net || !round || round.appliedHere === true) return;
  settleSpaceAct(net, round, 'completed');
  saveConfig(cfg);
}

/**
 * Start the run of every passed `meta_change` round that carries steps and is still owed here (not marked done, no start in flight): what the boot
 * resume and the watcher's tick ask, so a round whose start crashed or failed is started at the next boot or tick. A round this member cannot apply
 * (not carried here, or a schema it cannot read) owes nothing and is settled. Answers how many runs are owed (started now or in flight).
 */
export function startOwedRoundConversions(): number {
  const cfg = getConfig();
  let owed = 0;
  let settled = false;
  for (const net of cfg.networks ?? []) {
    for (const round of net.pendingRounds ?? []) {
      if (!roundConversionOwed(round)) continue;
      if (startingRounds.has(round.roundId)) { owed++; continue; }
      const plan = planPassedMetaChange(net, round);
      if (plan === null || !plan.ok) { settleSpaceAct(net, round, plan === null ? 'not-carried' : 'absent'); settled = true; continue; }
      // The schema before the round landed is not kept; the meta now stands in for it (it holds every type the round left alone).
      startRoundConversion(net, round, plan, cfg.spaces.find(s => s.id === plan.localSpace)?.meta);
      if (startingRounds.has(round.roundId)) owed++;
    }
  }
  if (settled) saveConfig(cfg);
  return owed;
}

// ── Notify ejected member after a remove vote passes ──────────────────────
// Fire-and-forget: non-fatal if the peer is unreachable. Sent through the one notice sender (`networks/notify-members.ts`), which
// reads the token at send time.
export function sendMemberRemovedNotify(
  subjectUrl: string,
  subjectInstanceId: string,
  networkId: string,
): void {
  sendNotice(networkId, { instanceId: subjectInstanceId, url: subjectUrl }, 'member_removed', undefined, MEMBER_REMOVED_TIMEOUT_MS)
    .then(status => {
      if (status === null) log.warn(`member_removed: no outbound token for ${peerText(subjectInstanceId)} — cannot notify`);
      else if (status < 200 || status >= 300) log.warn(`member_removed notify to ${peerText(subjectInstanceId)}: HTTP ${status}`);
    })
    .catch(err => log.warn(`member_removed notify to ${peerText(subjectInstanceId)}: ${peerText(err)}`));
}

/** How long the ejected member is given to take the notice: it is told once and never again, so longer than a wake-up. */
const MEMBER_REMOVED_TIMEOUT_MS = 10_000;
