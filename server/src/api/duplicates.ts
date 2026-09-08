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
import { requireAuth, requireAdminMfa, denyReadOnly, requireAuthMfa } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { spacesWhereTokenMay } from '../auth/reachable-spaces.js';
import type { TokenRights, Rung } from '../config/rights-shape.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import { scanSpace, pairContentHash } from '../brain/dupe-scanner.js';
import { computeMergePlan, applyResolutions, executeMerge } from '../brain/merge.js';
import { nliConfigured } from '../brain/nli-client.js';
import type { DupeCandidateDoc, ContradictionCandidateDoc } from '../config/types.js';

/** Find a candidate across the caller's accessible spaces. */
async function findCandidate(id: string, rights?: TokenRights): Promise<{ doc: DupeCandidateDoc; spaceId: string } | null> {
  // Same rule as `accessibleSpaces`, and deliberately not a second copy of it: resolving a candidate id
  // reads the record, so `read` is the level, and an empty allowlist means none rather than all.
  const spaces = spacesWhereTokenMay(rights, 'dataQuality', 'read');
  for (const spaceId of spaces) {
    const doc = await col<DupeCandidateDoc>(`${spaceId}_dupe_candidates`).findOne(asFilter<DupeCandidateDoc>({ _id: id })) as DupeCandidateDoc | null;
    if (doc) return { doc, spaceId };
  }
  return null;
}

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
 * memory store holds.
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
  const found = await col<ContradictionCandidateDoc>(`${spaceId}_contradiction_candidates`)
    .find(asFilter<ContradictionCandidateDoc>({ _id: { $in: keys } }))
    .toArray() as ContradictionCandidateDoc[];
  const byKey = new Map(found.map(f => [f._id, f]));

  // "The collection is empty" is not "these pairs are clean" — an unscanned space and a clean space look
  // identical from a per-pair lookup, and only one of them licenses a merge.
  const everScanned = await col(`${spaceId}_contradiction_candidates`).estimatedDocumentCount() > 0;

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

export const duplicatesRouter = Router();

/**
 * The space IDs this token may act on, at the Data-quality level the caller needs.
 *
 * These routes take no space in the path — they walk every space the token can reach — so this list IS the
 * enforcement point. Reading it from the rights matrix is what stops the Data quality column being
 * decorative.
 *
 * It also removes a conflation that lived here: `tokenSpaces.length === 0` used to mean "unrestricted". An
 * ABSENT allowlist means every space; an EMPTY one means none, and they are opposite. Anything holding
 * `spaces: []` was handed the whole instance.
 */
function accessibleSpaces(req: { authToken?: unknown }, needs: Rung = 'read'): string[] {
  const t = req.authToken as { rights?: TokenRights; spaces?: string[] } | undefined;
  return spacesWhereTokenMay(t?.rights, 'dataQuality', needs);
}

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

    let spaces = accessibleSpaces(req);
    if (spaceFilter) spaces = spaces.filter(id => id === spaceFilter);

    const results: DupeCandidateDoc[] = [];
    /** Per space, the contradiction signal for each pair — see `contradictionSignalsFor`. */
    const signals = new Map<string, Map<string, ContradictionSignal>>();
    for (const spaceId of spaces) {
      // Served by the {status, score, detectedAt} index (de-prefixed in P10): `status` is the
      // leading equality field and the sort by (score desc, detectedAt desc) follows it. The
      // redundant `spaceId` equality is a harmless residual (the collection is already per-space).
      const q = status === 'all' ? { spaceId } : { spaceId, status };
      const docs = await col<DupeCandidateDoc>(`${spaceId}_dupe_candidates`)
        .find(asFilter<DupeCandidateDoc>(q))
        .sort({ score: -1, detectedAt: -1 })
        .limit(500)
        .toArray() as DupeCandidateDoc[];
      results.push(...docs);
      signals.set(spaceId, await contradictionSignalsFor(spaceId, docs));
    }
    results.sort((a, b) => (b.score - a.score) || b.detectedAt.localeCompare(a.detectedAt));
    // Cap the merged cross-space result so a many-space token can't materialise 500×spaces rows.
    res.json({
      duplicates: results.slice(0, 500).map(c => toRecord(c, signals.get(c.spaceId)?.get(pairKey(c)))),
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
    const spaces = accessibleSpaces(req, 'write');
    for (const spaceId of spaces) {
      const coll = col<DupeCandidateDoc>(`${spaceId}_dupe_candidates`);
      const doc = await coll.findOne(asFilter<DupeCandidateDoc>({ _id: id })) as DupeCandidateDoc | null;
      if (!doc) continue;
      const dismissedContentHash = await pairContentHash(spaceId, doc.type, doc.aId, doc.bId);
      await coll.updateOne(
        asFilter<DupeCandidateDoc>({ _id: id }),
        asUpdate<DupeCandidateDoc>({ $set: { status: 'dismissed', dismissedContentHash, updatedAt: new Date().toISOString() } }),
      );
      res.json({ status: 'dismissed' });
      return;
    }
    res.status(404).json({ error: 'Duplicate candidate not found' });
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
    const spaces = accessibleSpaces(req, 'write');
    for (const spaceId of spaces) {
      const r = await col<DupeCandidateDoc>(`${spaceId}_dupe_candidates`).updateOne(
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
duplicatesRouter.post('/:id/merge', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const found = await findCandidate(req.params['id'] as string, (req.authToken as { rights?: TokenRights } | undefined)?.rights);
    if (!found) { res.status(404).json({ error: 'Duplicate candidate not found' }); return; }
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

    await col<DupeCandidateDoc>(`${spaceId}_dupe_candidates`).updateOne(
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
    const cfg = getConfig();
    // Intersect with the token's space allowlist — a space-restricted admin must
    // not be able to trigger destructive rules (automerge/notify) on spaces it
    // cannot access.
    const allowed = new Set(accessibleSpaces(req, 'write'));
    const targets = cfg.spaces
      .filter(s => !s.proxyFor && allowed.has(s.id) && (!spaceFilter || s.id === spaceFilter))
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
