import { spacesWhereTokenMay } from '../auth/reachable-spaces.js';
import type { TokenRights, Rung } from '../config/rights-shape.js';
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
 * (`edited` — someone corrected a record; `linked` — a contradicts/supersedes edge was drawn instead) and
 * leaves the records themselves to the normal edit paths.
 */
import { Router } from 'express';
import { requireAuth, requireAdminMfa, denyReadOnly, requireAuthMfa } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import { pairContentHash } from '../brain/dupe-scanner.js';
import { scanSpace } from '../brain/contradiction-scanner.js';
import { nliConfigured } from '../brain/nli-client.js';
import { upsertEdge } from '../brain/edges.js';
import { webhookToken } from './brain/_shared.js';
import type { ContradictionCandidateDoc } from '../config/types.js';

export const contradictionsRouter = Router();

/**
 * The edge label a `superseded` resolution draws.
 *
 * Their vocabulary, not a new one — `supersedes` was already how this codebase described "this record
 * overtook that one" in prose, and the reviewer's alternative was to draw it by hand. A constant rather than
 * a string literal because the client filters on it and a second spelling would be invisible.
 */
export const SUPERSEDES_LABEL = 'supersedes';

const collectionFor = (spaceId: string) => col<ContradictionCandidateDoc>(`${spaceId}_contradiction_candidates`);

/** Space IDs the authenticated token may access (empty/absent allow-list = all spaces). */
/**
 * The space IDs this token may act on at the given Data-quality level.
 *
 * These routes take no space in the path — they walk every space the token can reach — so this list IS the
 * enforcement point. It also removes the copy of a conflation that lived here: `tokenSpaces.length === 0`
 * used to mean "unrestricted". An ABSENT allowlist means every space; an EMPTY one means none. Anything
 * holding `spaces: []` was handed the whole instance.
 */
function accessibleSpaces(req: { authToken?: unknown }, needs: Rung = 'read'): string[] {
  const t = req.authToken as { rights?: TokenRights; spaces?: string[] } | undefined;
  return spacesWhereTokenMay(t?.rights, 'dataQuality', needs);
}

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

    let spaces = accessibleSpaces(req, 'read');
    if (spaceFilter) spaces = spaces.filter(id => id === spaceFilter);

    const results: ContradictionCandidateDoc[] = [];
    for (const spaceId of spaces) {
      const q = status === 'all' ? { spaceId } : { spaceId, status };
      const docs = await collectionFor(spaceId)
        .find(asFilter<ContradictionCandidateDoc>(q))
        // Deterministic findings first (confidence 1), then the model's most confident. Within a tie the
        // newest, so a reviewer meets fresh disagreements rather than re-reading the same old ones.
        .sort({ confidence: -1, detectedAt: -1 })
        .limit(500)
        .toArray() as ContradictionCandidateDoc[];
      results.push(...docs);
    }
    results.sort((a, b) => (b.confidence - a.confidence) || b.detectedAt.localeCompare(a.detectedAt));
    // Cap the merged cross-space result, as duplicates does — a many-space token must not materialise
    // 500 x spaces rows.
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
    res.json({ contradictions: results.slice(0, 500).map(toRecord), nliConfigured: nliConfigured() });
  } catch (err) {
    log.error(`GET /api/contradictions: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/contradictions/:id/dismiss — reviewed, not a real disagreement.
// Captures the pair's content fingerprint so a later re-embed / re-sync / index rebuild (which bump seq
// without changing content) will NOT resurface it, while a real edit to either record will.
contradictionsRouter.post('/:id/dismiss', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const id = req.params['id'] as string;
    for (const spaceId of accessibleSpaces(req, 'write')) {
      const coll = collectionFor(spaceId);
      const doc = await coll.findOne(asFilter<ContradictionCandidateDoc>({ _id: id })) as ContradictionCandidateDoc | null;
      if (!doc) continue;
      const dismissedContentHash = await pairContentHash(spaceId, doc.type, doc.aId, doc.bId);
      await coll.updateOne(
        asFilter<ContradictionCandidateDoc>({ _id: id }),
        asUpdate<ContradictionCandidateDoc>({ $set: { status: 'dismissed', dismissedContentHash, updatedAt: new Date().toISOString() } }),
      );
      res.json({ status: 'dismissed' });
      return;
    }
    res.status(404).json({ error: 'Contradiction candidate not found' });
  } catch (err) {
    log.error(`POST /api/contradictions/:id/dismiss: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/contradictions/:id/reopen — bring a dismissed pair back onto the review list.
// Only matches a currently-dismissed pair: reopening an open or resolved one is a 404, not a silent no-op.
contradictionsRouter.post('/:id/reopen', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const id = req.params['id'] as string;
    for (const spaceId of accessibleSpaces(req, 'write')) {
      const r = await collectionFor(spaceId).updateOne(
        asFilter<ContradictionCandidateDoc>({ _id: id, status: 'dismissed' }),
        asUpdate<ContradictionCandidateDoc>({ $set: { status: 'open', updatedAt: new Date().toISOString() }, $unset: { dismissedContentHash: '' } }),
      );
      if (r.matchedCount > 0) { res.json({ status: 'open' }); return; }
    }
    res.status(404).json({ error: 'Dismissed contradiction candidate not found' });
  } catch (err) {
    log.error(`POST /api/contradictions/:id/reopen: ${err}`);
    res.status(500).json({ error: 'Internal error' });
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
// loser on the finding, and, for an entity pair, drawing the `supersedes` edge the reviewer would otherwise
// have to draw themselves.
//
// **Nothing is deleted or absorbed.** That is the line between this and a duplicate merge: a duplicate merge
// is lossless because the two records are the same thing, and a contradiction is not — the loser is a real
// record that was true, or was believed, and its history is the point.
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

    for (const spaceId of accessibleSpaces(req, 'write')) {
      const coll = collectionFor(spaceId);
      const doc = await coll.findOne(asFilter<ContradictionCandidateDoc>({ _id: id })) as ContradictionCandidateDoc | null;
      if (!doc) continue;

      const set: Partial<ContradictionCandidateDoc> = {
        status: 'resolved', resolution, updatedAt: new Date().toISOString(),
      };
      // The token's NAME, never the token. Absent when the token is unnamed rather than stored as ''.
      if (req.authToken?.name) set.resolvedBy = req.authToken.name;

      let edge: { id: string; from: string; to: string; label: string } | null = null;
      let edgeSkipped: string | undefined;

      if (resolution === 'superseded') {
        const winnerId = body.winner === 'a' ? doc.aId : doc.bId;
        const loserId = body.winner === 'a' ? doc.bId : doc.aId;
        set.supersededId = loserId;

        if (doc.type === 'entity') {
          // from → to reads "winner supersedes loser". `upsertEdge` is keyed on (from, to, label), so
          // resolving the same pair twice lands on the same edge instead of accumulating duplicates.
          const e = await upsertEdge(spaceId, winnerId, loserId, SUPERSEDES_LABEL,
            undefined, undefined, undefined, undefined, undefined, webhookToken(req));
          edge = { id: e._id, from: e.from, to: e.to, label: e.label };
        } else {
          // An edge in Ythril connects ENTITIES. Drawing one between two memories or two chrono entries
          // would produce exactly the accepted-dead-edge an integrator reported (#695): a link that is
          // stored, returned, and points at nothing traversable.
          //
          // So the decision is still recorded — it is the reviewer's judgement and it is worth keeping —
          // and the response SAYS no edge was drawn. Silently recording a resolution the caller believes
          // drew an edge is the failure this endpoint is meant to avoid.
          edgeSkipped = `no edge drawn: edges connect entities, and this pair is of type '${doc.type}'`;
        }
      }

      await coll.updateOne(asFilter<ContradictionCandidateDoc>({ _id: id }),
        asUpdate<ContradictionCandidateDoc>({ $set: set }));
      res.json({
        status: 'resolved', resolution,
        ...(set.resolvedBy ? { resolvedBy: set.resolvedBy } : {}),
        ...(set.supersededId ? { supersededId: set.supersededId } : {}),
        ...(edge ? { edge } : {}),
        ...(edgeSkipped ? { note: edgeSkipped } : {}),
      });
      return;
    }
    res.status(404).json({ error: 'Contradiction candidate not found' });
  } catch (err) {
    log.error(`POST /api/contradictions/:id/resolve: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/contradictions/scan?space=<id> — run the sweep now instead of waiting for the schedule.
// Admin + MFA, like the duplicate scan: it is a model-spending operation over a whole space.
contradictionsRouter.post('/scan', globalRateLimit, requireAuthMfa, denyReadOnly, async (req, res) => {
  try {
    const spaceFilter = typeof req.query['space'] === 'string' ? req.query['space'] : undefined;
    const spaces = accessibleSpaces(req, 'write').filter(id => !spaceFilter || id === spaceFilter);
    let scanned = 0, found = 0, nliStalled = false, judgedPairs = 0, modelCalls = 0, budgetExhausted = false;
    for (const spaceId of spaces) {
      const r = await scanSpace(spaceId);
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
    res.json({ scannedSpaces: spaces.length, scanned, found, judgedPairs, modelCalls, nliStalled, budgetExhausted });
  } catch (err) {
    log.error(`POST /api/contradictions/scan: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
