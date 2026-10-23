import { spacesWhereTokenMay } from '../auth/reachable-spaces.js';
import { findWhereTokenMay } from '../auth/find-where-token-may.js';
/**
 * Contradiction review API (F-REVIEW slice 4) — the Review tab's Contradictions sub-view.
 *
 * Mirrors `api/duplicates.ts` deliberately: same space-scoping, same sticky-dismissal contract, same
 * shapes. The Review tab shows both under one vocabulary, so the two APIs should not drift.
 *
 * Where it differs is what a candidate MEANS. A duplicate carries a similarity `score`; a contradiction
 * carries a **basis** — `structured-field` (deterministic: the records set the same single-valued property
 * to different values, and the offending fields are listed) or `nli` (a model's opinion, with its
 * confidence). The list preserves that distinction rather than flattening both into one number, because a
 * reviewer needs to tell "these disagree on `port`" from "a model thinks these disagree".
 *
 * Resolution is also different. Duplicates merge; contradictions do not — two records that disagree are
 * both real, and which one is wrong is a judgement call. So `resolve` records HOW it was settled
 * (`edited` — someone corrected a record; `linked` — a contradicts/supersedes edge was drawn instead;
 * `superseded` — the reviewer kept one side, see the resolve route) and leaves the records themselves to the
 * normal edit paths.
 */
import { Router } from 'express';
import type express from 'express';
import { requireAuth, denyReadOnly, requireAuthMfa } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { pairContentHash } from '../brain/dupe-scanner.js';
import { scanSpace, SCAN_STEP } from '../brain/contradiction-scanner.js';
import { scanSpacesInRequest } from '../brain/scan-spaces-in-request.js';
import { nliConfigured } from '../brain/nli-client.js';
import { upsertEdge, deleteEdge, EdgeSchemaViolation } from '../brain/edges.js';
import { retireRecord, reinstateRecord, canBeRetired } from '../brain/retire-record.js';
import { RECORD_SUPERSEDED_FIELD } from '../brain/record-flag.js';
import { WriteConflict } from '../brain/write-plan/types.js';
import { COLLECTION } from '../brain/embed-record.js';
import { readStoredById } from '../db/read-by-id.js';
import { notFlaggedIfFile } from '../files/live-file-row.js';
import { storeFailureAnswer, type StoreFailureAnswer } from '../brain/store-failure.js';
import { isRefKind } from '../config/types-knowledge.js';
import { webhookToken } from './brain/_shared.js';
import type { ContradictionCandidateDoc, ContradictionChoice, ContradictionClaim, ContradictionResolveNote } from '../config/types.js';
import { edgeIdFor } from '../brain/edge-id.js';
import { spaceCollection } from '../db/space-collection.js';
import { pageMemberList } from '../brain/list-page.js';
import { defaultBudgetChars } from '../brain/result-budget.js';
import { sendCaughtFailure, sendStoreFailure } from './send-failure.js';

export const contradictionsRouter = Router();

/**
 * The edge label a `superseded` resolution draws.
 *
 * Their vocabulary, not a new one — `supersedes` was already how this codebase described "this record
 * overtook that one" in prose, and the reviewer's alternative was to draw it by hand. A constant rather than
 * a string literal because the client filters on it and a second spelling would be invisible.
 */
export const SUPERSEDES_LABEL = 'supersedes';

const collectionFor = (spaceId: string) => col<ContradictionCandidateDoc>(spaceCollection(spaceId, 'contradictionCandidates'));

/*
 * These routes take no space in the path: they walk every space the token can reach, so the space list each one
 * walks IS its enforcement point (`auth/reachable-spaces.ts`). Every walk names its area and rung at the call —
 * `spacesWhereTokenMay` for a list, `findWhereTokenMay` for a record by id — and neither has a default (`Q-304`).
 */

function toRecord(c: ContradictionCandidateDoc) {
  return {
    id: c._id,
    spaceId: c.spaceId,
    type: c.type,
    aId: c.aId,
    aSummary: c.aSummary,
    bId: c.bId,
    bSummary: c.bSummary,
    basis: c.basis,
    confidence: c.confidence,
    // Present only for a structured verdict — this is what lets the UI name the disagreement instead of
    // just asserting one.
    ...(c.fields ? { fields: c.fields } : {}),
    // A confident verdict on the first page of a long record reads exactly like a confident verdict on the
    // record, so the reviewer is told which one they are looking at.
    ...(c.truncated ? { truncated: true } : {}),
    status: c.status,
    ...(c.resolution ? { resolution: c.resolution } : {}),
    // Who settled it and which record they judged stale. A resolution is a judgement between two real
    // records, so the next reviewer needs to know whether to ask, and whom — the audit log has the actor,
    // but nobody reading the Review tab is reading the audit log.
    ...(c.resolvedBy ? { resolvedBy: c.resolvedBy } : {}),
    ...(c.supersededId ? { supersededId: c.supersededId } : {}),
    // What the resolve could not do as asked (`Q-442`): a reviewer reading the resolved list later sees the refused link too.
    ...(c.notes?.length ? { notes: c.notes } : {}),
    // A resolve that has claimed this pair and not closed it — in flight, or abandoned (L3). Without it the card looks open
    // while every other choice is refused `409`.
    ...(c.resolving ? { resolving: c.resolving } : {}),
    detectedAt: c.detectedAt,
    updatedAt: c.updatedAt,
  };
}

// GET /api/contradictions?status=open&space=<id>
contradictionsRouter.get('/', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const statusRaw = req.query['status'];
    const status = statusRaw === 'dismissed' || statusRaw === 'resolved' || statusRaw === 'all' ? statusRaw : 'open';
    const spaceFilter = typeof req.query['space'] === 'string' ? req.query['space'] : undefined;

    let spaces = spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'read');
    if (spaceFilter) spaces = spaces.filter(id => id === spaceFilter);

    const q = (spaceId: string) => (status === 'all' ? { spaceId } : { spaceId, status });
    // Q-127: a page through the one list rule, never a list stopped at 500 with nothing saying so.
    const page = await pageMemberList<ContradictionCandidateDoc>({
      members: spaces,
      // Deterministic findings first (confidence 1), then the model's most confident. Within a tie the newest, so a
      // reviewer meets fresh disagreements rather than re-reading the same old ones.
      readMember: async (spaceId, limit, skip) => await collectionFor(spaceId).find(asFilter<ContradictionCandidateDoc>(q(spaceId)))
        .sort({ confidence: -1, detectedAt: -1 }).skip(skip).limit(limit).toArray() as ContradictionCandidateDoc[],
      countMember: spaceId => collectionFor(spaceId).countDocuments(asFilter<ContradictionCandidateDoc>(q(spaceId))),
      compare: (a, b) => (b.confidence - a.confidence) || b.detectedAt.localeCompare(a.detectedAt) || a._id.localeCompare(b._id),
      req: req.query as Record<string, unknown>,
      page: { defaultLimit: 100, maxLimit: 500, budgetChars: defaultBudgetChars('rest') },
      ceiling: 5_000,
    });
    if (!page.ok) { res.status(400).json({ error: page.error }); return; }
    // `nliConfigured` rides along because the client has to explain an EMPTY list, and it cannot tell
    // "nothing disagrees" from "the judge never ran" without knowing this. It used to guess, and always
    // guessed the alarming answer: the empty state asserted "contradiction detection is not running yet —
    // it needs an NLI model" unconditionally, so a genuinely clean space was told it was broken.
    //
    // Reported here rather than fetched separately: this is the request the view already makes, the
    // media-processing config endpoint is admin-scoped (a reviewer would get a 403 and be back to
    // guessing), and a second source could disagree with this one.
    //
    // Note it is NOT "is detection running". The structured pass runs with no model at all — see
    // `scanSpace`, which uses `['structured']` when nothing is configured. This says only whether the
    // model-judged pass is among the ones that run.
    res.json({ contradictions: page.rows.map(toRecord), ...page.fields, nliConfigured: nliConfigured() });
  } catch (err) {
    sendCaughtFailure(res, `GET /api/contradictions`, err);
  }
});

// POST /api/contradictions/:id/dismiss — reviewed, not a real disagreement.
// Captures the pair's content fingerprint so a later re-embed / re-sync / index rebuild (which bump seq
// without changing content) will NOT resurface it, while a real edit to either record will.
//
// A RESOLVED candidate is refused `409 alreadyResolved` (round 5, coordinator's decision): dismissing one left it `dismissed`
// with its resolution, its `supersededId`, the edge and the mark all standing, and a reopen then showed it open with the old
// badges. The refusal is in the update's own filter (`status: {$ne: 'resolved'}`), not a read before it, so a dismiss racing a
// resolve's close cannot land on the resolved document.
contradictionsRouter.post('/:id/dismiss', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const id = req.params['id'] as string;
    const found = await findWhereTokenMay<ContradictionCandidateDoc>(req.authToken?.rights, 'dataQuality', 'write', 'contradictionCandidates', id);
    if (found) {
      const { doc, spaceId } = found;
      const coll = collectionFor(spaceId);
      const dismissedContentHash = await pairContentHash(spaceId, doc.type, doc.aId, doc.bId);
      const released = await coll.findOneAndUpdate(
        asFilter<ContradictionCandidateDoc>({ _id: id, status: { $ne: 'resolved' } }),
        // A dismiss releases a resolve's claim (L3): the pair is judged no disagreement, so no choice about it stands, and
        // what the claim recorded it wrote is undone.
        asUpdate<ContradictionCandidateDoc>({ $set: { status: 'dismissed', dismissedContentHash, updatedAt: new Date().toISOString() }, $unset: { resolving: '' } }),
        { returnDocument: 'before' },
      ) as ContradictionCandidateDoc | null;
      if (!released) {
        const now = await coll.findOne(asFilter<ContradictionCandidateDoc>({ _id: id }), { projection: { status: 1, resolution: 1 } });
        if (now?.status === 'resolved') {
          res.status(409).json({
            error: `this contradiction is already resolved (as '${now.resolution}'); a resolved finding cannot be dismissed`,
            code: 'alreadyResolved', retryable: false, resolution: now.resolution,
          });
          return;
        }
        res.status(404).json({ error: 'Contradiction candidate not found' });
        return;
      }
      const notes = await releaseClaim(req, spaceId, released);
      res.json({ status: 'dismissed', ...(notes.length > 0 ? { notes } : {}) });
      return;
    }
    res.status(404).json({ error: 'Contradiction candidate not found' });
  } catch (err) {
    sendCaughtFailure(res, `POST /api/contradictions/:id/dismiss`, err);
  }
});

// POST /api/contradictions/:id/reopen — bring a dismissed pair back onto the review list.
// Only matches a currently-dismissed pair: reopening an open or resolved one is a 404, not a silent no-op.
contradictionsRouter.post('/:id/reopen', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const id = req.params['id'] as string;
    for (const spaceId of spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'write')) {
      const released = await collectionFor(spaceId).findOneAndUpdate(
        asFilter<ContradictionCandidateDoc>({ _id: id, status: 'dismissed' }),
        // A reopen releases any claim too (L3): the pair comes back to be judged afresh, and what the claim wrote is undone.
        asUpdate<ContradictionCandidateDoc>({ $set: { status: 'open', updatedAt: new Date().toISOString() }, $unset: { dismissedContentHash: '', resolving: '' } }),
        { returnDocument: 'before' },
      ) as ContradictionCandidateDoc | null;
      if (released) {
        const notes = await releaseClaim(req, spaceId, released);
        res.json({ status: 'open', ...(notes.length > 0 ? { notes } : {}) });
        return;
      }
    }
    res.status(404).json({ error: 'Dismissed contradiction candidate not found' });
  } catch (err) {
    sendCaughtFailure(res, `POST /api/contradictions/:id/reopen`, err);
  }
});

// POST /api/contradictions/:id/resolve  { resolution: 'edited' | 'linked' | 'superseded', winner?: 'a' | 'b' }
//
// Contradictions are NOT merged. Two records that disagree are both real and which one is wrong is a
// judgement call, so this records HOW a human settled it and leaves the records to the normal edit paths.
//
// ── `superseded` — the reviewer picks a winner (their ask, and why it is not a merge) ──────────────────────
//
// The reviewer's most common actual decision is "this one is right, that one is stale", and neither `edited`
// nor `linked` expresses it: `edited` says a record was corrected (it was not), `linked` says the reviewer
// drew an edge by hand somewhere else. So `superseded` records the judgement AND acts on it — naming the
// loser on the finding, marking the loser itself, and drawing the `supersedes` edge the reviewer would
// otherwise have to draw themselves.
//
// **Nothing is deleted or absorbed.** That is the line between this and a duplicate merge: a duplicate merge
// is lossless because the two records are the same thing, and a contradiction is not — the loser is a real
// record that was true, or was believed, and its history is the point.
//
// ── The judgement is kept, and a resolve converges (`Q-442`) ─────────────────────────────────────────────────
//
// The steps are: read the pair, CLAIM the candidate for this choice, draw the edge, mark the loser, close.
//
//  - **A link the space's rules refuse does not undo the judgement** (D-25, the owner's decision). A functional
//    `supersedes` that already has a target, or an endpoint rule the pair does not meet, is the edge writer's
//    `EdgeSchemaViolation`: the loser is still marked, the candidate still closed, and the answer says
//    `linkRefused`. It used to throw out of the route as a `500` with the loser already marked.
//  - **A record of the pair that is gone skips the link and says which** (`winnerGone`, `loserGone`), rather
//    than reaching the edge writer, which refuses a dangling end.
//  - **The claim is written before the first effect**, under a status guard: a second resolve with a DIFFERENT
//    choice — a retry that changed its mind, a second reviewer — is refused `409 resolvedOtherwise` before it
//    writes anything, so the space can never hold two `supersedes` edges pointing opposite ways. The SAME
//    choice converges: the edge is keyed on (from, to, label), and an already-marked loser is not re-marked
//    (re-marking moves its `seq` and `updatedAt` for a write that changed nothing).
//  - **A store failure part-way is a `503` that says what was written** (`written: {edge, markedRecord, closed}`),
//    so the caller knows the retry is safe and what it will finish. Nothing else is caught: a refusal is a
//    refusal and a fault is a fault.
//  - **The claim records what it writes, as it writes it** (`resolving.wrote: {edgeId?, markedId?}`), each entry
//    set under the claim immediately BEFORE its effect. So an effect lands only while this request holds the
//    claim, and a claim taken over as stale (`RESOLVE_CLAIM_STALE_MS`) or released by a dismiss or reopen is
//    undone EXACTLY — that edge deleted, that record's mark lifted, nothing else ever — and the undo is said
//    (`oppositeChoiceUndone`). A resolve that finds its claim taken over undoes what it wrote itself and answers
//    `409`; a first-time resolve never touches a mark or edge it did not write.
contradictionsRouter.post('/:id/resolve', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const id = req.params['id'] as string;
    const body = (req.body ?? {}) as { resolution?: unknown; winner?: unknown };
    const resolution = body.resolution;
    if (resolution !== 'edited' && resolution !== 'linked' && resolution !== 'superseded') {
      res.status(400).json({ error: "resolution must be 'edited', 'linked' or 'superseded'" });
      return;
    }
    // A winner is meaningless without `superseded`, and REQUIRED with it. Refused rather than defaulted:
    // guessing which record a reviewer meant to keep is the one mistake this endpoint must never make.
    if (resolution === 'superseded' && body.winner !== 'a' && body.winner !== 'b') {
      res.status(400).json({ error: "resolution 'superseded' requires winner: 'a' or 'b'" });
      return;
    }
    if (resolution !== 'superseded' && body.winner !== undefined) {
      res.status(400).json({ error: "`winner` applies only to resolution 'superseded'" });
      return;
    }
    const choice: ContradictionChoice = resolution === 'superseded'
      ? { resolution, winner: body.winner as 'a' | 'b' } : { resolution };

    const found = await findWhereTokenMay<ContradictionCandidateDoc>(req.authToken?.rights, 'dataQuality', 'write', 'contradictionCandidates', id);
    if (!found) { res.status(404).json({ error: 'Contradiction candidate not found' }); return; }
    await resolveCandidate(req, res, found.doc, found.spaceId, choice);
  } catch (err) {
    sendCaughtFailure(res, RESOLVE_WHERE, err);
  }
});

const RESOLVE_WHERE = 'POST /api/contradictions/:id/resolve';

/** What one claim recorded it was about to write: the edge it drew, the record it marked. */
type ClaimWrote = NonNullable<ContradictionClaim['wrote']>;

/**
 * What a resolve has written so far: the `503` for a failure part-way carries it, so a caller knows what its retry finishes.
 * `undone` — present only when something was — is what this request undid of an abandoned claim's writes, or of its own after
 * losing its claim.
 */
interface Written { edge: boolean; markedRecord: boolean; closed: boolean; undone?: Undone }

/** This request's claim was taken over by another choice, or released, between two of its writes. */
class ClaimLost extends Error {}

/**
 * How old a claim must be before another choice may take it over (L3). A resolve is a handful of writes, each bounded by the
 * store's own deadline, so a claim this old belongs to a request that crashed or a `503` nobody retried — not one in flight.
 * Ten minutes rather than the write bound itself, because taking over a claim that IS in flight is the race the claim exists
 * to prevent; and a slow resolver that is overtaken all the same stops at its next write and undoes its own.
 */
export const RESOLVE_CLAIM_STALE_MS = 10 * 60_000;

/**
 * The candidates this choice may claim: one nobody has claimed, one already claimed by the SAME choice, or one whose claim is
 * older than {@link RESOLVE_CLAIM_STALE_MS}. Never a resolved one: a resolved candidate is answered from what it recorded
 * (`sameResolved`) and gets no claim, which a crash would otherwise leave on it for good.
 */
function claimableBy(id: string, choice: ContradictionChoice): Record<string, unknown> {
  const staleBefore = new Date(Date.now() - RESOLVE_CLAIM_STALE_MS).toISOString();
  return {
    _id: id,
    status: { $ne: 'resolved' },
    $or: [
      { resolving: { $exists: false } },
      sameClaim(choice),
      // `$not: {$gte}` also takes a claim with no time on it, which only an unreleased build wrote.
      { 'resolving.at': { $not: { $gte: staleBefore } } },
    ],
  };
}

/** The candidate's claim is this choice. `null` matches an absent winner, which is how `edited` and `linked` are stored. */
const sameClaim = (choice: ContradictionChoice) => ({ 'resolving.resolution': choice.resolution, 'resolving.winner': choice.winner ?? null });
const isSameChoice = (claim: ContradictionChoice | undefined, choice: ContradictionChoice) =>
  claim !== undefined && claim.resolution === choice.resolution && (claim.winner ?? null) === (choice.winner ?? null);

/** The candidate is already closed by this choice: its resolution, and for `superseded` the same loser. */
const sameResolved = (choice: ContradictionChoice, loserId: string | undefined) =>
  ({ status: 'resolved', resolution: choice.resolution, supersededId: loserId ?? null });

/**
 * Undo exactly what a claim recorded: delete the edge it drew, lift the mark it set — through the writers, so each travels and
 * is audited. Nothing a claim did not record is ever deleted or lifted: a mark set by hand or by another pair, an edge drawn
 * by hand, are not this pair's to take back. Returns what was undone, or `undefined` when nothing was.
 *
 * **A recorded mark another pair has since come to depend on stays** (`markKept`): when a `supersedes` edge other than the
 * claim's own points at the record, or another resolved candidate names it as its loser, that pair found the record marked,
 * recorded nothing, and relies on the mark. Lifting it would leave that pair's edge and `supersededId` over an unmarked record.
 *
 * Idempotent, and writes nothing it need not: an edge already gone is not deleted, a record no longer marked is not written —
 * which is what lets a takeover run it twice (`resolveCandidate`, before its close).
 */
async function undoClaim(
  req: express.Request, spaceId: string, candidate: Pick<ContradictionCandidateDoc, '_id' | 'type'>, wrote: ClaimWrote | undefined,
): Promise<Undone | undefined> {
  if (!wrote) return undefined;
  const undone: Undone = {};
  if (wrote.edgeId && await deleteEdge(spaceId, wrote.edgeId, webhookToken(req))) undone.edgeId = wrote.edgeId;
  const markedId = wrote.markedId;
  if (markedId && canBeRetired(candidate.type)) {
    const marked = await col<{ _id: string; superseded?: boolean }>(spaceCollection(spaceId, COLLECTION[candidate.type]))
      .findOne(asFilter<{ _id: string }>({ _id: markedId, [RECORD_SUPERSEDED_FIELD]: true, ...notFlaggedIfFile(candidate.type) }), { projection: { _id: 1 } });
    if (marked) {
      const edgeInto = await col<{ _id: string }>(spaceCollection(spaceId, 'edges')).findOne(asFilter<{ _id: string }>({
        to: markedId, label: SUPERSEDES_LABEL, ...(wrote.edgeId ? { _id: { $ne: wrote.edgeId } } : {}),
      }), { projection: { _id: 1 } });
      const pairOn = edgeInto ? null : await collectionFor(spaceId).findOne(asFilter<ContradictionCandidateDoc>({
        _id: { $ne: candidate._id }, status: 'resolved', supersededId: markedId,
      }), { projection: { _id: 1 } });
      if (edgeInto || pairOn) undone.markKept = markedId;
      else if (await reinstateRecord(spaceId, candidate.type, markedId, webhookToken(req))) undone.markedId = markedId;
    }
  }
  return undone.edgeId || undone.markedId || undone.markKept ? undone : undefined;
}

/** What an undo did: the edge deleted, the mark lifted, or the mark KEPT because another pair depends on it. */
type Undone = ClaimWrote & { markKept?: string };

/** Fold a second run of the undo into the first: whatever either took back. */
const undoneEither = (a: Undone | undefined, b: Undone | undefined): Undone | undefined => (a || b ? { ...a, ...b } : undefined);

/**
 * The undo of an unfinished resolve, as notes — one code per thing that is TRUE, because a client says each code in its own
 * words and those words must hold in every case the code is sent (round 5):
 *   `oppositeChoiceUndone`  something it wrote was taken back (its edge deleted, its mark lifted — `detail` says which);
 *   `markKept`              a mark it set was KEPT, because another resolved pair relies on it.
 * Either, both or none.
 */
function undoneNotes(undone: Undone | undefined): ContradictionResolveNote[] {
  if (!undone) return [];
  const took = [
    undone.edgeId ? `its edge '${undone.edgeId}' was deleted` : '',
    undone.markedId ? `the mark on '${undone.markedId}' was lifted` : '',
  ].filter(Boolean);
  return [
    ...(took.length > 0 ? [{ code: 'oppositeChoiceUndone' as const, detail: `an unfinished resolve of this pair was undone first: ${took.join(' and ')}` }] : []),
    ...(undone.markKept ? [{ code: 'markKept' as const,
      detail: `an unfinished resolve of this pair had marked '${undone.markKept}'; the mark was kept, because another pair's resolve depends on it` }] : []),
  ];
}

/** Refuse a resolve whose choice differs from the one the candidate is already resolving or resolved by: `409 resolvedOtherwise`. */
async function answerResolvedOtherwise(res: express.Response, spaceId: string, id: string, written?: Written): Promise<void> {
  const now = await collectionFor(spaceId).findOne(asFilter<ContradictionCandidateDoc>({ _id: id }));
  if (!now) { res.status(404).json({ error: 'Contradiction candidate not found' }); return; }
  const taken = now.resolving ?? { resolution: now.resolution, ...(now.supersededId ? { winner: now.supersededId === now.aId ? 'b' : 'a' } : {}) };
  res.status(409).json({
    error: `this contradiction is already ${now.resolving ? 'being resolved' : 'resolved'} otherwise (as '${taken.resolution}'`
      + `${taken.winner ? `, keeping ${taken.winner}` : ''}); `
      + (written ? 'what this request wrote, and undid, is in `written`' : 'nothing was written by this request'),
    code: 'resolvedOtherwise', retryable: false, resolution: taken.resolution,
    ...(taken.winner ? { winner: taken.winner } : {}),
    ...(written ? { written } : {}),
  });
}

/**
 * Answer a failure on the store's side part-way through a resolve: the store's own answer (status, `Retry-After`, body) with
 * `written` added. A `WriteConflict` — another write kept moving a record — is the same condition for this caller: nothing it
 * did was wrong and a retry converges. Anything else is not answered here (`false`), and reaches `sendCaughtFailure`.
 */
function sendPartWayFailure(res: express.Response, err: unknown, written: Written): boolean {
  const answer: StoreFailureAnswer | null = storeFailureAnswer(err, RESOLVE_WHERE)
    ?? (err instanceof WriteConflict ? { status: 503, retryAfterSeconds: 5, body: { error: err.message, retryable: true } } : null);
  if (!answer) return false;
  sendStoreFailure(res, answer, { ...answer.body, written });
  return true;
}

/** The refused link, as a note: the label it carried and the rules that refused it, in the validator's words. */
function linkRefusedNote(err: EdgeSchemaViolation): ContradictionResolveNote {
  const rules = [...new Set(err.check.introduced.concat(err.check.all).map(v => v.field))];
  return {
    code: 'linkRefused', label: SUPERSEDES_LABEL, rule: rules.join(', '),
    detail: `no edge drawn: the space's edge schema refused '${SUPERSEDES_LABEL}' (${err.check.message}); the decision was kept and the record marked`,
  };
}

/** The pair's ends as stored: whether each exists and carries the mark. A soft-deleted file's row is gone for this question. */
type Stored = Map<string, { _id: string; superseded?: boolean }>;

/** A resolve whose candidate is already resolved by the same choice: answered from what it recorded, writing nothing. */
async function answerAlreadyResolved(
  res: express.Response, spaceId: string, now: ContradictionCandidateDoc, choice: ContradictionChoice, stored: Stored, edgeId: string | undefined,
): Promise<void> {
  const superseding = choice.resolution === 'superseded';
  const e = edgeId ? await col<{ _id: string; from: string; to: string; label: string }>(spaceCollection(spaceId, 'edges'))
    .findOne(asFilter<{ _id: string }>({ _id: edgeId }), { projection: { _id: 1, from: 1, to: 1, label: 1 } }) : null;
  const notes = now.notes ?? [];
  res.json({
    status: 'resolved', resolution: choice.resolution,
    ...(now.resolvedBy ? { resolvedBy: now.resolvedBy } : {}),
    ...(now.supersededId ? { supersededId: now.supersededId } : {}),
    ...(e ? { edge: { id: e._id, from: e.from, to: e.to, label: e.label } } : {}),
    ...(superseding ? { markedRecord: stored.get(now.supersededId ?? '')?.superseded === true } : {}),
    notes,
    ...(notes.length > 0 ? { note: notes.map(n => n.detail).join('; ') } : {}),
  });
}

async function resolveCandidate(
  req: express.Request, res: express.Response, doc: ContradictionCandidateDoc, spaceId: string, choice: ContradictionChoice,
): Promise<void> {
  const coll = collectionFor(spaceId);
  const superseding = choice.resolution === 'superseded';
  const winnerId = choice.winner === 'a' ? doc.aId : doc.bId;
  const loserId = choice.winner === 'a' ? doc.bId : doc.aId;
  // The edge's id is its identity (`edgeIdFor`), so it is known — and recorded on the claim — before it is drawn.
  const kind = isRefKind(doc.type) && doc.type !== 'entity' ? doc.type : undefined;
  const edgeId = superseding && isRefKind(doc.type) ? edgeIdFor(winnerId, loserId, SUPERSEDES_LABEL, kind, kind) : undefined;

  // 1. The pair as stored now: whether each end exists, and whether the loser already carries the mark.
  const readPair = (): Promise<Stored> => readStoredById<{ _id: string; superseded?: boolean }>(spaceCollection(spaceId, COLLECTION[doc.type]),
    [winnerId, loserId], { [RECORD_SUPERSEDED_FIELD]: 1 }, { filter: notFlaggedIfFile(doc.type) });
  const stored: Stored = superseding ? await readPair() : new Map();

  /** The candidate as it is now, answered: already resolved by this choice → 200 from its record; anything else → 409. */
  const answerTaken = async (written?: Written): Promise<boolean> => {
    const now = await coll.findOne(asFilter<ContradictionCandidateDoc>({ _id: doc._id, ...sameResolved(choice, superseding ? loserId : undefined) }));
    if (now) { await answerAlreadyResolved(res, spaceId, now, choice, stored, edgeId); return true; }
    await answerResolvedOtherwise(res, spaceId, doc._id, written);
    return false;
  };

  // 2. The claim, before the first effect: a different choice is refused here, having written nothing. The candidate as it
  //    was BEFORE the claim says whether this took over another choice's abandoned claim, and what that claim recorded.
  //    The claim's fields are set one by one, never `resolving` whole: a same-choice re-claim must keep what the earlier claim
  //    recorded (`wrote`) on the claim at every moment, or a dismiss in between would find nothing to undo and orphan a
  //    crashed request's edge and mark (N1). A takeover clears the old `wrote` itself, after undoing it.
  const at = new Date().toISOString();
  const before = await coll.findOneAndUpdate(
    asFilter<ContradictionCandidateDoc>(claimableBy(doc._id, choice)),
    asUpdate<ContradictionCandidateDoc>({
      $set: { 'resolving.resolution': choice.resolution, 'resolving.at': at, updatedAt: at, ...(choice.winner ? { 'resolving.winner': choice.winner } : {}) },
      ...(choice.winner ? {} : { $unset: { 'resolving.winner': '' } }),
    }),
    { returnDocument: 'before' },
  ) as ContradictionCandidateDoc | null;
  if (!before) { await answerTaken(); return; }

  const written: Written = { edge: false, markedRecord: false, closed: false };
  const notes: ContradictionResolveNote[] = [];
  /** What THIS request recorded and wrote, which it undoes itself if it loses its claim. */
  const mine: ClaimWrote = {};
  /** Record `entry` on the claim, under it: the effect after this lands only while this request still holds the claim. */
  const record = async (entry: ClaimWrote): Promise<void> => {
    const r = await coll.updateOne(asFilter<ContradictionCandidateDoc>({ _id: doc._id, ...sameClaim(choice) }),
      asUpdate<ContradictionCandidateDoc>({ $set: Object.fromEntries(Object.entries(entry).map(([k, v]) => [`resolving.wrote.${k}`, v])) }));
    if (r.matchedCount === 0) throw new ClaimLost();
  };
  let edge: { id: string; from: string; to: string; label: string } | null = null;
  try {
    // The same choice's earlier claim (a retry, or a second request at once) needs nothing: what it recorded stayed on the
    // claim, so a later takeover still undoes all of it.
    const prior = before.resolving;
    const tookOver = prior !== undefined && !isSameChoice(prior, choice);
    if (tookOver) {
      // 2b. Another choice's claim, stale: undo exactly what it recorded, say so, and only then drop its record from the claim.
      written.undone = await undoClaim(req, spaceId, doc, prior.wrote);
      const r = await coll.updateOne(asFilter<ContradictionCandidateDoc>({ _id: doc._id, ...sameClaim(choice) }),
        asUpdate<ContradictionCandidateDoc>({ $unset: { 'resolving.wrote': '' } }));
      if (r.matchedCount === 0) throw new ClaimLost();
    }

    if (superseding) {
      // Re-read after an undo: the record the abandoned claim marked may be the one this choice keeps.
      const now = written.undone?.markedId ? await readPair() : stored;
      const winner = now.get(winnerId);
      const loser = now.get(loserId);
      if (!winner) notes.push({ code: 'winnerGone', detail: `no edge drawn: the record kept, '${winnerId}', no longer exists` });
      if (!loser) notes.push({ code: 'loserGone', detail: `nothing marked and no edge drawn: the record judged stale, '${loserId}', no longer exists` });

      /*
       * 3. The edge. from → to reads "winner supersedes loser", keyed on (from, to, label), so resolving the same choice
       * again lands on the same edge. An edge that is already there — drawn by hand, or by this choice's earlier claim — is
       * reported and not written again, and only an edge this request draws is recorded as the claim's.
       *
       * DRAWN FOR EVERY PAIR KIND SINCE 5.0, because the walk follows an edge to a fact, chrono entry or file. WHICH kinds can
       * be an endpoint is `REF_KINDS`: an EDGE is not among them. `contradictions.types` is configurable, so an edge pair
       * reaches here; it keeps the judgement and says why there is no link (`edgePairUnlinkable`).
       *
       * Only the writer's own refusal is caught: a store failure, a lost race (`WriteConflict`) or a held space is not a
       * refusal, and taking one for `linkRefused` would close the candidate on a link that could have been drawn.
       */
      if (winner && loser) {
        if (edgeId) {
          const edges = col<{ _id: string; from: string; to: string; label: string }>(spaceCollection(spaceId, 'edges'));
          const there = await edges.findOne(asFilter<{ _id: string }>({ _id: edgeId }), { projection: { _id: 1, from: 1, to: 1, label: 1 } });
          if (there) {
            edge = { id: there._id, from: there.from, to: there.to, label: there.label };
            written.edge = true;
          } else {
            await record({ edgeId });
            mine.edgeId = edgeId;
            try {
              const e = await upsertEdge(spaceId, winnerId, loserId, SUPERSEDES_LABEL,
                undefined, undefined, undefined, undefined, undefined, webhookToken(req),
                undefined, { fromKind: kind, toKind: kind });
              edge = { id: e._id, from: e.from, to: e.to, label: e.label };
              written.edge = true;
            } catch (err) {
              if (!(err instanceof EdgeSchemaViolation)) throw err;
              notes.push(linkRefusedNote(err));
              // Nothing was drawn, so nothing is this claim's to delete: an edge of that id drawn by hand afterwards must not
              // be taken by a later undo of this claim (N2).
              await coll.updateOne(asFilter<ContradictionCandidateDoc>({ _id: doc._id, ...sameClaim(choice) }),
                asUpdate<ContradictionCandidateDoc>({ $unset: { 'resolving.wrote.edgeId': '' } }));
              delete mine.edgeId;
            }
          }
        } else {
          notes.push({ code: 'edgePairUnlinkable', detail: `no edge drawn: an edge cannot be the endpoint of an edge, and this pair is of type '${doc.type}'` });
        }
      }

      /*
       * 4. THE MARK GOES ON THE RECORD (`Q-35`). `supersededId` names the loser on the CANDIDATE, which no retrieval path
       * reads, so a resolve that stopped there changed nothing the next recall answered. The loser keeps its vector and
       * keeps ranking — see `RECORD_SUPERSEDED_FIELD`. A loser already marked is not written again, and not recorded: the
       * mark is not this request's to take back.
       */
      if (loser && canBeRetired(doc.type)) {
        if (loser.superseded === true) written.markedRecord = true;
        else {
          await record({ markedId: loserId });
          mine.markedId = loserId;
          written.markedRecord = await retireRecord(spaceId, doc.type, loserId, webhookToken(req));
        }
      }
    }

    /*
     * 4b. A takeover runs the abandoned claim's undo once more, just before it closes: the overtaken request may still have been
     * alive, past its last check, and landed an effect after the first undo. The undo is idempotent and writes only what is
     * there, so this costs two reads when nothing landed.
     *
     * The windows this does NOT close, stated rather than hidden:
     *  - a dismiss or reopen undoes once, with no second pass: an effect the released request lands after that undo (it passed
     *    its check just before the release) stays until that request's next check fails and it undoes its own — or for good, if
     *    it crashes in between;
     *  - the existence read and the write are not one step: an edge drawn by hand, or a mark set by hand, between this request
     *    reading "not there" (step 3, step 4) and writing it is recorded as this claim's, and a later undo of the claim takes it.
     */
    if (tookOver) written.undone = undoneEither(written.undone, await undoClaim(req, spaceId, doc, prior.wrote));
    notes.unshift(...undoneNotes(written.undone));

    // 5. Close, under the claim: a candidate whose claim was taken over since is not closed by this request. A candidate
    //    another request of the SAME choice closed first is closed again, idempotently: that race is not a conflict (L2).
    const set: Partial<ContradictionCandidateDoc> = {
      status: 'resolved', resolution: choice.resolution, updatedAt: new Date().toISOString(),
      ...(superseding ? { supersededId: loserId } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
    // The token's NAME, never the token. Absent when the token is unnamed rather than stored as ''.
    if (req.authToken?.name) set.resolvedBy = req.authToken.name;
    const closed = await coll.updateOne(
      asFilter<ContradictionCandidateDoc>({ _id: doc._id, $or: [sameClaim(choice), sameResolved(choice, superseding ? loserId : undefined)] }),
      asUpdate<ContradictionCandidateDoc>({ $set: set, $unset: { resolving: '', ...(notes.length > 0 ? {} : { notes: '' }) } }),
    );
    if (closed.matchedCount === 0) throw new ClaimLost();
    written.closed = true;

    res.json({
      status: 'resolved', resolution: choice.resolution,
      ...(set.resolvedBy ? { resolvedBy: set.resolvedBy } : {}),
      ...(set.supersededId ? { supersededId: set.supersededId } : {}),
      ...(edge ? { edge } : {}),
      // Whether the LOSER itself carries the mark. Reported rather than assumed: a decision recorded on the queue and
      // nowhere else is the defect `Q-35` ended, and a response that claimed the mark unconditionally would hide its return.
      ...(superseding ? { markedRecord: written.markedRecord } : {}),
      notes,
      ...(written.undone ? { written } : {}),
      // The notes' sentences as one string, for a client older than `notes`.
      ...(notes.length > 0 ? { note: notes.map(n => n.detail).join('; ') } : {}),
    });
  } catch (err) {
    if (err instanceof ClaimLost) {
      // Closed by the same choice meanwhile: what this request wrote is that choice's too, and stays.
      const sameNow = await coll.findOne(asFilter<ContradictionCandidateDoc>({ _id: doc._id, ...sameResolved(choice, superseding ? loserId : undefined) }));
      if (sameNow) { await answerAlreadyResolved(res, spaceId, sameNow, choice, stored, edgeId); return; }
      // Taken over by another choice, or released: take back what this request wrote, so its judgement is not left beside
      // the standing one, and say what it wrote and undid.
      const undone = await undoClaim(req, spaceId, doc, mine);
      if (undone) written.undone = undone;
      await answerResolvedOtherwise(res, spaceId, doc._id, written);
      return;
    }
    if (!sendPartWayFailure(res, err, written)) throw err;
  }
}

/**
 * Release a candidate's claim and undo exactly what it recorded (dismiss, reopen): the claim is taken off atomically FIRST, so
 * a resolver still holding it stops at its next write and undoes its own, and two releases cannot both undo. Returns the note
 * saying what was undone, if anything.
 */
async function releaseClaim(req: express.Request, spaceId: string, released: ContradictionCandidateDoc | null): Promise<ContradictionResolveNote[]> {
  const undone = released?.resolving ? await undoClaim(req, spaceId, released, released.resolving.wrote) : undefined;
  return undoneNotes(undone);
}

// POST /api/contradictions/scan?space=<id> — run the sweep now instead of waiting for the schedule.
// Admin + MFA, like the duplicate scan: it is a model-spending operation over a whole space.
contradictionsRouter.post('/scan', globalRateLimit, requireAuthMfa, denyReadOnly, async (req, res) => {
  try {
    const spaceFilter = typeof req.query['space'] === 'string' ? req.query['space'] : undefined;
    const spaces = spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'write').filter(id => !spaceFilter || id === spaceFilter);
    let scanned = 0, found = 0, nliStalled = false, judgedPairs = 0, modelCalls = 0, budgetExhausted = false;
    // A space that fails is named in `failedSpaces` and the rest are still scanned; a store that is not answering ends the request
    // (the `catch` below answers it 503). `scannedSpaces` counts the spaces that were scanned, so it equals `spaces.length` on success.
    const { results, failedSpaces } = await scanSpacesInRequest(SCAN_STEP, spaces, (spaceId) => scanSpace(spaceId));
    for (const r of results) {
      scanned += r.scanned; found += r.found; judgedPairs += r.judgedPairs; modelCalls += r.modelCalls;
      nliStalled = nliStalled || r.nliStalled;
      budgetExhausted = budgetExhausted || r.budgetExhausted;
    }
    // Two different reasons the list may be incomplete, and they are NOT interchangeable:
    //   nliStalled       the judge was unreachable — nothing was settled, the cursor is parked.
    //   budgetExhausted  the pair budget ran out — what was judged IS settled; the next run continues.
    // Neither may read as a clean result.
    //
    // Two counts, because they answer different questions and an operator needs both: `judgedPairs` is what
    // the sweep SETTLED, `modelCalls` is what it SPENT — the number their endpoint's own request log shows,
    // and the one `maxJudgedPairsPerRun` bounds. Reporting only the first is what made our report look 2×
    // short of a judge's own counter.
    res.json({ scannedSpaces: results.length, scanned, found, judgedPairs, modelCalls, nliStalled, budgetExhausted, failedSpaces });
  } catch (err) {
    sendCaughtFailure(res, `POST /api/contradictions/scan`, err);
  }
});
