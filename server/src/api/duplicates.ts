/**
 * Duplicate-candidate review API.
 *
 * Lists the near-duplicate pairs found by the background scanner
 * (`server/src/brain/dupe-scanner.ts`), lets a reviewer dismiss them, and lets
 * an admin trigger an on-demand full re-scan. Read/dismiss follow the conflicts
 * router's model (space-scoped via the token); the write-heavy scan trigger is
 * admin + non-read-only.
 */

import { Router } from 'express';
import { requireAuth, denyReadOnly, requireAuthMfa } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { spacesWhereTokenMay, holdsRung } from '../auth/reachable-spaces.js';
import { findWhereTokenMay } from '../auth/find-where-token-may.js';
import { readStoredById } from '../db/read-by-id.js';
import { getConfig } from '../config/loader.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { log } from '../util/log.js';
import { scanSpace, pairContentHash } from '../brain/dupe-scanner.js';
import { computeMergePlan, applyResolutions, executeMerge } from '../brain/merge.js';
import { nliConfigured } from '../brain/nli-client.js';
import type { DupeCandidateDoc, ContradictionCandidateDoc } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';
import { pageMemberList } from '../brain/list-page.js';
import { defaultBudgetChars } from '../brain/result-budget.js';

/**
 * The canonical key both candidate collections use for a pair: the two ids, lower first.
 *
 * `{space}_dupe_candidates` keys rows `${type}:${aId}:${bId}` and `{space}_contradiction_candidates` keys them
 * `${aId}:${bId}`, both with `aId < bId` already enforced by the scanners. Deriving the key here rather than
 * trusting field order means a pair found in either order joins the same way — and a row written before that
 * ordering was enforced still joins.
 */
function pairKey(c: Pick<DupeCandidateDoc, 'aId' | 'bId'>): string {
  return c.aId < c.bId ? `${c.aId}:${c.bId}` : `${c.bId}:${c.aId}`;
}

/**
 * For one space's duplicate pairs, what is known about each pair being a CONTRADICTION.
 *
 * The two lists have always held this between them and never been joined: a pair can sit in `open` on both,
 * and only the duplicates list is what a nightly merge pass reads. So a reversal of opinion arrives labelled
 * as redundancy, and merging it destroys the fact that someone changed their mind — the most valuable thing a
 * fact store holds.
 *
 * One batched `$in` per space, not a query per pair: the contradiction rows are keyed by exactly the pair key,
 * so this is an indexed lookup over at most 500 ids.
 *
 * **When nothing has judged the pair, that is reported rather than omitted.** Returning "no contradiction
 * record" for a space whose scanner has never run would be a claim the data cannot support; the caller must be
 * able to tell "checked, they do not disagree" from "nobody has looked".
 */
async function contradictionSignalsFor(
  spaceId: string,
  pairs: DupeCandidateDoc[],
): Promise<Map<string, ContradictionSignal>> {
  const out = new Map<string, ContradictionSignal>();
  if (pairs.length === 0) return out;

  // Without a judge there is no NLI pass at all, so a clean contradiction list says nothing about semantics —
  // only that no structured field conflicted. Say so instead of implying agreement.
  if (!nliConfigured()) {
    for (const p of pairs) out.set(pairKey(p), { checked: false, reason: 'no-judge-configured' });
    return out;
  }

  const keys = [...new Set(pairs.map(pairKey))];
  const byKey = await readStoredById<ContradictionCandidateDoc>(
    spaceCollection(spaceId, 'contradictionCandidates'), keys, { basis: 1, confidence: 1, status: 1 });

  // "The collection is empty" is not "these pairs are clean" — an unscanned space and a clean space look
  // identical from a per-pair lookup, and only one of them licenses a merge.
  const everScanned = await col(spaceCollection(spaceId, 'contradictionCandidates')).estimatedDocumentCount() > 0;

  for (const p of pairs) {
    const key = pairKey(p);
    const hit = byKey.get(key);
    if (hit) {
      out.set(key, {
        checked: true, found: true,
        basis: hit.basis, confidence: hit.confidence, status: hit.status, id: hit._id,
      });
    } else {
      out.set(key, everScanned ? { checked: true, found: false } : { checked: false, reason: 'never-scanned' });
    }
  }
  return out;
}

/*
 * These routes take no space in the path: they walk every space the token can reach, so the space list each one
 * walks IS its enforcement point (`auth/reachable-spaces.ts`). Every walk names its area and rung at the call —
 * `spacesWhereTokenMay` for a list, `findWhereTokenMay` for a record by id — and neither has a default, because a
 * default rung is how the merge door came to walk at `read` (`Q-304`).
 */
export const duplicatesRouter = Router();

/**
 * Negation tokens, for the lexical asymmetry cue.
 *
 * Deliberately short and English-only. This is not a semantic analyser and must not grow into one that looks
 * like a judgement: it answers "does one side say a not-word the other does not?", which is a reason to READ
 * the pair, never a verdict on it.
 */
const NEGATION_TOKENS = [
  'not', 'never', 'no', 'none', 'cannot', "can't", 'cant', "won't", 'wont', "don't", 'dont',
  "doesn't", 'doesnt', "didn't", 'didnt', "shouldn't", 'shouldnt', "isn't", 'isnt', "aren't", 'arent',
  'without', 'avoid', 'stop', 'refuse', 'reject', 'neither', 'nor',
];

/** The negation tokens present in a summary, as a set. */
function negationsIn(text: string): Set<string> {
  const words = new Set(text.toLowerCase().split(/[^a-z']+/).filter(Boolean));
  return new Set(NEGATION_TOKENS.filter(t => words.has(t)));
}

/**
 * Does exactly one side of the pair carry negation the other lacks?
 *
 * Their own example is the case: *"ship the rough version today"* vs *"take the extra days and **never** ship
 * a rough version"* — 0.97 similar, opposite meaning, and no structured property in conflict. A lexical
 * asymmetry is the cheapest thing that separates those two from ordinary redundancy.
 *
 * **What it is not:** semantic. Two records can disagree with no negation word at all ("approved" vs
 * "rejected"), and two can share a negation and agree completely. So this is reported as a cue with a name
 * that says what it measured, absent when false so it cannot read as a per-pair verdict, and documented as
 * "a reason to look". A hint that fires on ordinary pairs is worse than no hint — the same standard the
 * metrics registry applies when it refuses to count a missing lexical channel.
 */
function negationAsymmetry(a: string, b: string): boolean {
  const na = negationsIn(a);
  const nb = negationsIn(b);
  if (na.size === 0 && nb.size === 0) return false;
  // Asymmetry, not mere presence: both sides negating is not a signal.
  return (na.size === 0) !== (nb.size === 0);
}

/**
 * Exported for the standalone test only.
 *
 * The cue is a pure function of two strings and is the one part of this file worth testing directly — the rest
 * needs a database. Named `…ForTest` rather than exporting the internal, so nothing outside imports it by
 * accident and starts depending on a heuristic as if it were an API.
 */
export const negationAsymmetryForTest = negationAsymmetry;

/**
 * How the contradiction question was answered for this pair — never a bare absence.
 *
 * `not-checked` and `none-found` are different facts and the caller cannot act on the first as if it were the
 * second. This correspondent reported that exact confusion against our own settings page in their §6b: an
 * unconfigured optional endpoint looks identical to "checked, nothing found" from outside. An optional
 * `contradiction` field alone would have reproduced it here, on the endpoint whose whole purpose is telling a
 * merge pass what NOT to merge.
 */
type ContradictionSignal =
  | { checked: false; reason: 'no-judge-configured' | 'never-scanned' }
  | { checked: true; found: false }
  | { checked: true; found: true; basis: 'structured-field' | 'nli'; confidence: number; status: string; id: string };

function toRecord(c: DupeCandidateDoc, contradiction?: ContradictionSignal) {
  return {
    id: c._id,
    spaceId: c.spaceId,
    type: c.type,
    aId: c.aId,
    aSummary: c.aSummary,
    bId: c.bId,
    bSummary: c.bSummary,
    score: c.score,
    status: c.status,
    ...(c.resolution ? { resolution: c.resolution } : {}),
    // A cue, not a verdict — absent when false so it cannot be read as a judgement on every pair.
    ...(negationAsymmetry(c.aSummary, c.bSummary) ? { negationAsymmetry: true } : {}),
    ...(contradiction ? { contradiction } : {}),
    detectedAt: c.detectedAt,
    updatedAt: c.updatedAt,
  };
}

// GET /api/duplicates?status=open&space=<id> — list candidate pairs across accessible spaces.
duplicatesRouter.get('/', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const statusRaw = req.query['status'];
    const status = statusRaw === 'dismissed' || statusRaw === 'all' ? statusRaw : 'open';
    const spaceFilter = typeof req.query['space'] === 'string' ? req.query['space'] : undefined;

    let spaces = spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'read');
    if (spaceFilter) spaces = spaces.filter(id => id === spaceFilter);

    // Served by the {status, score, detectedAt} index (de-prefixed in P10): `status` is the leading equality field
    // and the sort by (score desc, detectedAt desc) follows it. The redundant `spaceId` equality is a harmless
    // residual (the collection is already per-space).
    const q = (spaceId: string) => (status === 'all' ? { spaceId } : { spaceId, status });
    const coll = (spaceId: string) => col<DupeCandidateDoc>(spaceCollection(spaceId, 'dupeCandidates'));
    // Q-127: a page, never a list stopped at 500 with nothing saying so. Whole rows, `total`, `truncated`,
    // `nextSkip`, through the one list rule; a many-space merge is bounded by its ceiling, refused past it.
    const page = await pageMemberList<DupeCandidateDoc>({
      members: spaces,
      readMember: async (spaceId, limit, skip) => await coll(spaceId).find(asFilter<DupeCandidateDoc>(q(spaceId)))
        .sort({ score: -1, detectedAt: -1 }).skip(skip).limit(limit).toArray() as DupeCandidateDoc[],
      countMember: spaceId => coll(spaceId).countDocuments(asFilter<DupeCandidateDoc>(q(spaceId))),
      compare: (a, b) => (b.score - a.score) || b.detectedAt.localeCompare(a.detectedAt) || a._id.localeCompare(b._id),
      req: req.query as Record<string, unknown>,
      page: { defaultLimit: 100, maxLimit: 500, budgetChars: defaultBudgetChars('rest') },
      ceiling: 5_000,
    });
    if (!page.ok) { res.status(400).json({ error: page.error }); return; }
    /** Per space, the contradiction signal for each pair on THIS page — see `contradictionSignalsFor`. */
    const signals = new Map<string, Map<string, ContradictionSignal>>();
    for (const spaceId of new Set(page.rows.map(r => r.spaceId))) {
      signals.set(spaceId, await contradictionSignalsFor(spaceId, page.rows.filter(r => r.spaceId === spaceId)));
    }
    res.json({
      duplicates: page.rows.map(c => toRecord(c, signals.get(c.spaceId)?.get(pairKey(c)))),
      ...page.fields,
    });
  } catch (err) {
    log.error(`GET /api/duplicates: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/duplicates/:id/dismiss — mark a candidate pair reviewed/not-a-duplicate.
// Captures the pair's content fingerprint so a later re-embed / re-sync / index rebuild (which bump
// seq without changing content) will NOT resurface it — but a real content edit will.
duplicatesRouter.post('/:id/dismiss', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const id = req.params['id'] as string;
    const found = await findWhereTokenMay<DupeCandidateDoc>(req.authToken?.rights, 'dataQuality', 'write', 'dupeCandidates', id);
    if (!found) { res.status(404).json({ error: 'Duplicate candidate not found' }); return; }
    const { doc, spaceId } = found;
    const dismissedContentHash = await pairContentHash(spaceId, doc.type, doc.aId, doc.bId);
    await col<DupeCandidateDoc>(spaceCollection(spaceId, 'dupeCandidates')).updateOne(
      asFilter<DupeCandidateDoc>({ _id: id }),
      asUpdate<DupeCandidateDoc>({ $set: { status: 'dismissed', dismissedContentHash, updatedAt: new Date().toISOString() } }),
    );
    res.json({ status: 'dismissed' });
  } catch (err) {
    log.error(`POST /api/duplicates/:id/dismiss: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/duplicates/:id/reopen — manually re-rate a dismissed pair back onto the open review list.
// The counterpart to dismiss: dismissal is sticky (a re-embed/re-sync no longer resurfaces it), so
// bringing a pair back for review is a deliberate action. Only matches a pair that is currently
// `dismissed` — reopening a resolved/merged or already-open pair is a no-op 404.
duplicatesRouter.post('/:id/reopen', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const id = req.params['id'] as string;
    for (const spaceId of spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'write')) {
      const r = await col<DupeCandidateDoc>(spaceCollection(spaceId, 'dupeCandidates')).updateOne(
        asFilter<DupeCandidateDoc>({ _id: id, status: 'dismissed' }),
        asUpdate<DupeCandidateDoc>({ $set: { status: 'open', updatedAt: new Date().toISOString() } }),
      );
      if (r.matchedCount > 0) { res.json({ status: 'open' }); return; }
    }
    res.status(404).json({ error: 'Dismissed duplicate candidate not found' });
  } catch (err) {
    log.error(`POST /api/duplicates/:id/reopen: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/duplicates/:id/merge — merge an entity candidate pair (lossless).
// Survivor = the older record (lower seq), or the space's dupeMergeSurvivor policy.
// Returns 409 with the merge plan if the pair has a property-value conflict.
//
// Governed like every merge (Q-304). The candidate is looked up only where the token holds dataQuality WRITE, the
// rung its rights row names. A merge also deletes a knowledge record, so it needs knowledge WRITE in the pair's
// space, as the REST entity merge and MCP graph_merge do. A candidate the token may not merge answers 404, as
// dismiss and reopen do, so the refusal does not tell the caller the candidate exists.
duplicatesRouter.post('/:id/merge', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const rights = req.authToken?.rights;
    const found = await findWhereTokenMay<DupeCandidateDoc>(rights, 'dataQuality', 'write', 'dupeCandidates', req.params['id'] as string);
    if (!found || !rights || !holdsRung(rights, found.spaceId, 'knowledge', 'write')) {
      res.status(404).json({ error: 'Duplicate candidate not found' });
      return;
    }
    const { doc, spaceId } = found;
    if (doc.type !== 'entity') { res.status(400).json({ error: 'Merge is only supported for entity candidates' }); return; }

    const pref = getConfig().spaces.find(s => s.id === spaceId)?.dupeMergeSurvivor ?? 'older';
    const olderId = doc.aSeq <= doc.bSeq ? doc.aId : doc.bId;
    const newerId = doc.aSeq <= doc.bSeq ? doc.bId : doc.aId;
    const survivorId = pref === 'newer' ? newerId : olderId;
    const absorbedId = pref === 'newer' ? olderId : newerId;

    const plan = await computeMergePlan(spaceId, survivorId, absorbedId, []);
    if ('error' in plan) { res.status(plan.status).json({ error: plan.error }); return; }
    if (!plan.fullyResolved) { res.status(409).json({ error: 'Property value conflict — resolve manually', plan: plan.plan }); return; }

    const mergedProps = applyResolutions(plan.survivor.properties ?? {}, plan.absorbed.properties ?? {}, plan.plan.propertyConflicts, plan.plan.absorbedOnlyProperties);
    const result = await executeMerge(spaceId, plan.survivor, plan.absorbed, mergedProps, { tokenId: req.authToken?.id, tokenLabel: req.authToken?.name });

    await col<DupeCandidateDoc>(spaceCollection(spaceId, 'dupeCandidates')).updateOne(
      asFilter<DupeCandidateDoc>({ _id: doc._id }),
      asUpdate<DupeCandidateDoc>({ $set: { status: 'resolved', resolution: 'merged', updatedAt: new Date().toISOString() } }),
    );
    res.json({ status: 'merged', survivorId: result.entity._id });
  } catch (err) {
    log.error(`POST /api/duplicates/:id/merge: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/duplicates/scan?space=<id> — trigger an on-demand full re-scan.
// Admin + non-read-only: it is write-heavy (populates the candidates collection).
duplicatesRouter.post('/scan', globalRateLimit, requireAuthMfa, denyReadOnly, async (req, res) => {
  try {
    const spaceFilter = typeof req.query['space'] === 'string' ? req.query['space'] : undefined;
    // Intersect with the token's space allowlist — a space-restricted admin must
    // not be able to trigger destructive rules (automerge/notify) on spaces it
    // cannot access.
    const allowed = new Set(spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'write'));
    const targets = concreteSpaces()
      .filter(s => allowed.has(s.id) && (!spaceFilter || s.id === spaceFilter))
      .map(s => s.id);
    if (spaceFilter && targets.length === 0) { res.status(404).json({ error: `Space '${spaceFilter}' not found or not accessible` }); return; }

    let scanned = 0;
    let pairs = 0;
    for (const spaceId of targets) {
      const r = await scanSpace(spaceId, { reset: true });
      scanned += r.scanned;
      pairs += r.pairs;
    }
    res.json({ scannedSpaces: targets.length, scanned, pairs });
  } catch (err) {
    log.error(`POST /api/duplicates/scan: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
