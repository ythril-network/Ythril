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
import type { ContradictionCandidateDoc, ContradictionChoice, ContradictionResolveNote } from '../config/types.js';
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
contradictionsRouter.post('/:id/dismiss', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const id = req.params['id'] as string;
    const found = await findWhereTokenMay<ContradictionCandidateDoc>(req.authToken?.rights, 'dataQuality', 'write', 'contradictionCandidates', id);
    if (found) {
      const { doc, spaceId } = found;
      const coll = collectionFor(spaceId);
      const dismissedContentHash = await pairContentHash(spaceId, doc.type, doc.aId, doc.bId);
      await coll.updateOne(
        asFilter<ContradictionCandidateDoc>({ _id: id }),
        // A dismiss releases a resolve's claim (L3): the pair is judged no disagreement, so no choice about it stands.
        asUpdate<ContradictionCandidateDoc>({ $set: { status: 'dismissed', dismissedContentHash, updatedAt: new Date().toISOString() }, $unset: { resolving: '' } }),
      );
      res.json({ status: 'dismissed' });
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
      const r = await collectionFor(spaceId).updateOne(
        asFilter<ContradictionCandidateDoc>({ _id: id, status: 'dismissed' }),
        // A reopen releases any claim too (L3): the pair comes back to be judged afresh.
        asUpdate<ContradictionCandidateDoc>({ $set: { status: 'open', updatedAt: new Date().toISOString() }, $unset: { dismissedContentHash: '', resolving: '' } }),
      );
      if (r.matchedCount > 0) { res.json({ status: 'open' }); return; }
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

/** What a resolve has written so far: the `503` for a failure part-way carries it, so a caller knows what its retry finishes. */
interface Written { edge: boolean; markedRecord: boolean; closed: boolean }

/**
 * How old a claim must be before another choice may take it over (L3). A resolve is a handful of writes, each bounded by the
 * store's own deadline, so a claim this old belongs to a request that crashed or a `503` nobody retried — not one in flight.
 * Ten minutes rather than the write bound itself, because taking over a claim that IS in flight is the race the claim exists
 * to prevent.
 */
export const RESOLVE_CLAIM_STALE_MS = 10 * 60_000;

/**
 * The candidates this choice may claim: one nobody has claimed, one already claimed — resolving or resolved — by the SAME
 * choice, or one whose claim is older than {@link RESOLVE_CLAIM_STALE_MS} and not closed. A resolved candidate from before
 * the claim existed carries no `resolving`, so its choice is read from what it recorded (`sameResolved`).
 */
function claimableBy(id: string, choice: ContradictionChoice, loserId: string | undefined): Record<string, unknown> {
  const staleBefore = new Date(Date.now() - RESOLVE_CLAIM_STALE_MS).toISOString();
  return {
    _id: id,
    $or: [
      { status: { $ne: 'resolved' }, resolving: { $exists: false } },
      sameClaim(choice),
      sameResolved(choice, loserId),
      // `$not: {$gte}` also takes a claim with no time on it, which only an unreleased build wrote.
      { status: { $ne: 'resolved' }, 'resolving.at': { $not: { $gte: staleBefore } } },
    ],
  };
}

/** The candidate's claim is this choice. `null` matches an absent winner, which is how `edited` and `linked` are stored. */
const sameClaim = (choice: ContradictionChoice) => ({ 'resolving.resolution': choice.resolution, 'resolving.winner': choice.winner ?? null });

/** The candidate is already closed by this choice: its resolution, and for `superseded` the same loser. */
const sameResolved = (choice: ContradictionChoice, loserId: string | undefined) =>
  ({ status: 'resolved', resolution: choice.resolution, supersededId: loserId ?? null });

/** Refuse a resolve whose choice differs from the one the candidate is already resolving or resolved by: `409 resolvedOtherwise`. */
async function answerResolvedOtherwise(res: express.Response, spaceId: string, id: string, written?: Written): Promise<void> {
  const now = await collectionFor(spaceId).findOne(asFilter<ContradictionCandidateDoc>({ _id: id }));
  if (!now) { res.status(404).json({ error: 'Contradiction candidate not found' }); return; }
  const taken = now.resolving ?? { resolution: now.resolution, ...(now.supersededId ? { winner: now.supersededId === now.aId ? 'b' : 'a' } : {}) };
  res.status(409).json({
    error: `this contradiction is already ${now.resolving ? 'being resolved' : 'resolved'} otherwise (as '${taken.resolution}'`
      + `${taken.winner ? `, keeping ${taken.winner}` : ''}); `
      + (written ? 'what this request wrote before its claim was taken over is in `written`' : 'nothing was written by this request'),
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

/**
 * Undo what the OPPOSITE choice about this pair left behind, before the standing choice writes (L3): its `supersedes` edge
 * (loser → winner) and its mark on the record now kept.
 *
 * Only an abandoned claim can have left them — a fresh or closed claim of the other choice refuses this request at the claim —
 * once it was taken over as stale, or released by a dismiss or reopen. Without this the space held both judgements: two
 * opposite edges, and both records marked superseded.
 *
 * The mark is taken off only when no OTHER record's `supersedes` edge points at the kept record: a mark that another
 * resolve or a hand-drawn edge explains is not this pair's to undo. A mark with no edge behind it from either (a link the
 * schema refused) is taken off — the one case this cannot tell apart from another pair's refused link, stated rather than hidden.
 */
async function overruleOppositeChoice(
  req: express.Request, spaceId: string, type: ContradictionCandidateDoc['type'], winnerId: string, loserId: string, winnerMarked: boolean,
): Promise<void> {
  const edges = col<{ _id: string; from: string; to: string; label: string }>(spaceCollection(spaceId, 'edges'));
  const opposite = await edges.find(asFilter<{ _id: string }>({ from: loserId, to: winnerId, label: SUPERSEDES_LABEL }),
    { projection: { _id: 1 } }).toArray();
  for (const e of opposite) await deleteEdge(spaceId, e._id, webhookToken(req));
  if (!winnerMarked || !canBeRetired(type)) return;
  const explained = await edges.countDocuments(asFilter<{ _id: string }>({ to: winnerId, label: SUPERSEDES_LABEL, from: { $ne: loserId } }), { limit: 1 });
  if (explained === 0) await reinstateRecord(spaceId, type, winnerId, webhookToken(req));
}

async function resolveCandidate(
  req: express.Request, res: express.Response, doc: ContradictionCandidateDoc, spaceId: string, choice: ContradictionChoice,
): Promise<void> {
  const coll = collectionFor(spaceId);
  const superseding = choice.resolution === 'superseded';
  const winnerId = choice.winner === 'a' ? doc.aId : doc.bId;
  const loserId = choice.winner === 'a' ? doc.bId : doc.aId;

  // 1. The pair as stored now: whether each end exists, and whether the loser already carries the mark. A soft-deleted
  //    file's row is gone for this question, as it is for the edge writer's own existence check.
  const stored = superseding
    ? await readStoredById<{ _id: string; superseded?: boolean }>(spaceCollection(spaceId, COLLECTION[doc.type]),
      [winnerId, loserId], { [RECORD_SUPERSEDED_FIELD]: 1 }, { filter: notFlaggedIfFile(doc.type) })
    : new Map<string, { _id: string; superseded?: boolean }>();

  // 2. The claim, before the first effect: a different choice is refused here, having written nothing.
  const claimed = await coll.updateOne(
    asFilter<ContradictionCandidateDoc>(claimableBy(doc._id, choice, superseding ? loserId : undefined)),
    asUpdate<ContradictionCandidateDoc>({ $set: { resolving: { ...choice, at: new Date().toISOString() }, updatedAt: new Date().toISOString() } }),
  );
  if (claimed.matchedCount === 0) { await answerResolvedOtherwise(res, spaceId, doc._id); return; }

  const written: Written = { edge: false, markedRecord: false, closed: false };
  const notes: ContradictionResolveNote[] = [];
  let edge: { id: string; from: string; to: string; label: string } | null = null;
  try {
    if (superseding) {
      const winner = stored.get(winnerId);
      const loser = stored.get(loserId);
      if (!winner) notes.push({ code: 'winnerGone', detail: `no edge drawn: the record kept, '${winnerId}', no longer exists` });
      if (!loser) notes.push({ code: 'loserGone', detail: `nothing marked and no edge drawn: the record judged stale, '${loserId}', no longer exists` });

      /*
       * 3. The edge. from → to reads "winner supersedes loser", and `upsertEdge` is keyed on (from, to, label), so
       * resolving the same choice again lands on the same edge.
       *
       * DRAWN FOR EVERY PAIR KIND SINCE 5.0, because the walk follows an edge to a fact, chrono entry or file — which is
       * the whole of what makes the edge half of this worth drawing. WHICH kinds can be an endpoint is `REF_KINDS`, read
       * rather than restated: an EDGE is not among them, and cannot be. The scanner's defaults are facts, entities and
       * chrono entries, but `contradictions.types` is configurable, so an edge pair reaches here; it keeps the judgement
       * and says why there is no link (`edgePairUnlinkable`). Omitting the kinds means both ends are entities.
       *
       * Only the writer's own refusal is caught: a store failure, a lost race (`WriteConflict`) or a held space is not a
       * refusal, and taking one for `linkRefused` would close the candidate on a link that could have been drawn.
       */
      // The claim can have been taken over from an abandoned opposite choice, or released by a dismiss or reopen after one
      // wrote: its edge and mark are undone first, so the pair never holds two opposite judgements (L3).
      if (winner && loser) await overruleOppositeChoice(req, spaceId, doc.type, winnerId, loserId, winner.superseded === true);

      if (winner && loser) {
        if (isRefKind(doc.type)) {
          const kind = doc.type === 'entity' ? undefined : doc.type;
          try {
            const e = await upsertEdge(spaceId, winnerId, loserId, SUPERSEDES_LABEL,
              undefined, undefined, undefined, undefined, undefined, webhookToken(req),
              undefined, { fromKind: kind, toKind: kind });
            edge = { id: e._id, from: e.from, to: e.to, label: e.label };
            written.edge = true;
          } catch (err) {
            if (!(err instanceof EdgeSchemaViolation)) throw err;
            notes.push(linkRefusedNote(err));
          }
        } else {
          notes.push({ code: 'edgePairUnlinkable', detail: `no edge drawn: an edge cannot be the endpoint of an edge, and this pair is of type '${doc.type}'` });
        }
      }

      /*
       * 4. THE MARK GOES ON THE RECORD (`Q-35`). `supersededId` names the loser on the CANDIDATE, which no retrieval path
       * reads, so a resolve that stopped there changed nothing the next recall answered. The loser keeps its vector and
       * keeps ranking — see `RECORD_SUPERSEDED_FIELD`. A loser already marked is not written again.
       */
      if (loser && canBeRetired(doc.type)) {
        written.markedRecord = loser.superseded === true || await retireRecord(spaceId, doc.type, loserId, webhookToken(req));
      }
    }

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
    if (closed.matchedCount === 0) { await answerResolvedOtherwise(res, spaceId, doc._id, written); return; }
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
      // The notes' sentences as one string, for a client older than `notes`.
      ...(notes.length > 0 ? { note: notes.map(n => n.detail).join('; ') } : {}),
    });
  } catch (err) {
    if (!sendPartWayFailure(res, err, written)) throw err;
  }
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
