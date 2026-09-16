/**
 * Every proxy fan-out is accounted for, so Q-6's second half cannot miss one.
 *
 * ## Why a gate and not a checklist
 *
 * `resolveMemberSpaces(spaceId)` expands a proxy space into its members, and the read paths fan out over the
 * result. Q-6 changes the guard so a token that reaches only SOME members may use the proxy — at which point every
 * one of those fan-outs must narrow to the members that token reaches. A fan-out that is missed hands the caller
 * records from a space it cannot see, and nothing looks wrong: the response is well-formed, the status is 200, and
 * the only way to notice is to already know the space exists.
 *
 * There are enough sites, across enough files, that a hand-written list would be out of date by the time the change
 * landed. So the sites are ENUMERATED from source and each must be classified. A new call site fails this test
 * until someone says which kind it is.
 *
 * ## The two kinds
 *
 *  - **A write target** — the argument is an already-resolved single space (`wt.target` from `resolveWriteTarget`).
 *    A proxy write requires an explicit `targetSpace`, so by the time this is called there is exactly one real
 *    space and there is nothing to narrow. Classified automatically from the argument, not by being listed.
 *  - **A read fan-out** — anything else. The argument is the request's space, which may be a proxy. These are the
 *    ones Q-6 must narrow, and they are listed below with their file.
 *
 * ## What this asserts today
 *
 * That the inventory MATCHES the source exactly — no site missing from the list, and no stale entry left in it. It
 * does not yet assert that each site narrows, because none of them do: the rule shipped in #780 with nothing wired
 * to it, deliberately, because allowing a token through the guard without narrowing is the leak above.
 *
 * When the second half lands, each entry moves from `PENDING` to `NARROWED` and this test tightens to check the
 * call actually consults the token. Until then its job is to make the set unforgettable and to refuse a new
 * unclassified fan-out.
 *
 * Run: node --test testing/standalone/proxy-fanout-inventory.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { enclosingBlocksMatching } from './_structural-window.mjs';

/**
 * Read fan-outs, by file, with the count in that file.
 *
 * A count rather than a line number on purpose: line numbers churn on every unrelated edit above them, and a gate
 * that fails for an edit three functions away gets ignored. The count still catches a NEW fan-out appearing in a
 * file that already had some, which a bare file list would not.
 */
/**
 * GUARDS — the sites that decide whether a caller may use the proxy at all.
 *
 * A third class, found by reading them rather than by their argument, and the reason it matters: a guard must NOT be
 * narrowed. It flips, once, at the end — from "reaches every member" to "reaches at least one". Narrowing a guard
 * would make it check the caller against a list already filtered by that same caller, which is a tautology that
 * always passes.
 *
 * They were classified as read fan-outs on the first pass, purely because the argument is the request's space like
 * every fan-out's is. That would have made "PENDING is empty" the wrong definition of done — waiting to narrow three
 * sites that should be flipped, and flipping nothing.
 *
 *  - `auth/middleware.ts` — `spaceTargets` (feeds the area check) and `enforceSpaceScope` itself.
 *  - `mcp/router.ts` — the MCP equivalent of `enforceSpaceScope`, refusing when any member is unreachable.
 *
 * NOTE, and it is a separate defect rather than part of this: the MCP guard filters on `tokenSpaces` — the legacy
 * allowlist — while the HTTP guard uses `reachesSpace` and the rights matrix. Two surfaces, one rule, one of them
 * weaker. Filed rather than fixed here.
 */
/**
 * Sites that turned out NOT to be read fan-outs on closer reading, and are therefore no longer counted among them.
 *
 * Tracked as a number rather than dropped, so the original measurement of 28 stays honest. Lowering the constant to
 * 27 instead would erase the fact that a site moved class — and the whole value of the conserved total is that it
 * cannot be satisfied by quietly deleting something.
 *
 *  - **1** — `brain/write-validation.ts`. `locateForUpdate`'s parameter was called `spaceId`, so it read as a proxy
 *    space. Every one of its four callers passes `wt.target`, which is always a real space, so the loop is
 *    single-element and there is nothing to narrow. Renamed to `writeTarget`, which is what it is.
 */
const RECLASSIFIED = 1;

/**
 * The true total, and why it is 29 rather than the 28 first measured.
 *
 * 28 counted only `resolveMemberSpaces(...)` CALLS. Widening the sweep to catch a by-reference pass —
 * `resolveFindSimilarScope(..., resolveMemberSpaces)` in `mcp/tools/search.ts`, which hands the resolver to a helper
 * that expands a proxy inside it — revealed one more site that had always been there.
 *
 * Raised rather than left at 28, because the alternative is a conserved total that conserves the wrong number. The
 * original figure was not wrong through carelessness: it was an undercount produced by a sweep that matched calls,
 * and the indirection it missed is exactly the kind that makes a fan-out hard to follow.
 */
// 29 -> 30: the `reindex` MCP tool. It resolves its member list with `memberSpacesWithin(callSpace,
// accessibleSpaceIds)`, so it is NARROWED by construction and lands in `narrowedCalls()` the day it is written — which
// is the point of counting rather than listing. It is a genuinely new fan-out, not a re-measurement: `reindex` had no
// MCP surface before, and the REST route narrows by request instead.
//
// Raised deliberately. A conserved total that is quietly adjusted whenever it fails conserves nothing, so every change
// to this number says which site moved and why.
/**
 * 30 -> 31: `api/brain/embed-jobs.ts`, the brain-record half of the embedding queue, added with `memberSpacesForRequest`
 * from its first line rather than converted later. A new fan-out RAISES the total — the invariant is that a site is
 * accounted for, not that the number never moves. Lowering it, or leaving it at 30 and letting the new site sit in
 * PENDING, are the two ways this gate gets quietly defeated.
 */
/**
 * 31 -> 33: the two `/query` paths now name their narrowing EXPLICITLY.
 *
 * They used to fan out through `collectAcrossMembers`, which this gate does not count as a narrowed call — it resolves
 * the member list internally. Fixing the deep-skip defect meant resolving that list in the route, so each path now calls
 * `memberSpacesForRequest` (REST) or `memberSpacesWithin` (MCP) by name and the counter sees two sites it could not see
 * before. Narrowed went 28 -> 30; guards and reclassified are unchanged, so the total is 33.
 *
 * My first attempt at this number was 30, on the reasoning that two fan-outs had been consolidated into one. That was
 * backwards — the arithmetic says the opposite — and lowering a conserved total on a plausible story is exactly the move
 * this invariant exists to catch. It caught it.
 */
/**
 * 33 -> 38: all five brain LIST routes now name their narrowing.
 *
 * They paged through `collectAcrossMembers`, which the counter does not see, and each now calls
 * `memberSpacesForRequest` by name so it can hand the member list to the shared pager — memories, entities, edges, chrono
 * and file-meta. Five more visible sites, the same reads, and the same narrowing they always had.
 *
 * The number moving UP as narrowing becomes explicit is the healthy direction for this invariant. It moved down once in
 * my hands, on a plausible story about consolidation, and the arithmetic said otherwise.
 */
/**
 * 38 -> 39: the `er_model` MCP tool.
 *
 * The REST route has always narrowed with `memberSpacesForRequest`; the tool is new and narrows with
 * `memberSpacesWithin`, which is the MCP half of the same rule. One more visible site, and it reports a proxy's
 * members SEPARATELY rather than merged — merging type counts across spaces would invent relationships that
 * cannot exist, since an edge cannot cross a space.
 */
/**
 * 39 -> 40: the `retry_embed_media` MCP tool.
 *
 * The REST route it mirrors has always summed across members with `memberSpacesForRequest`; the tool narrows
 * with `memberSpacesWithin` and retries every member, because asking a proxy to retry means all of them.
 */
/**
 * 40 -> 42: the memory and chrono DELETE routes.
 *
 * Both used to hand `findFirstAcrossMembers` a closure and never name the member list, so neither was a
 * visible fan-out. `M-2` made a delete refusable — something can point at a memory or a chrono entry now, and
 * under strict linkage that blocks — so each route walks the members itself, checks the guard, and answers
 * `409` with the referring rows. The scope did not widen: `memberSpacesForRequest` is the same narrowing
 * `findFirstAcrossMembers` was applying, said out loud.
 *
 * The number moving up as narrowing becomes explicit is the healthy direction for this invariant, and is why
 * the note above says so.
 */
/**
 * 42 -> 44: the cascade preview, on both doors (`F-17`).
 *
 * The REST route walks a proxy's members with `memberSpacesForRequest` and the MCP tool with
 * `memberSpacesWithin` — one rule against the two sources of scope `CLAUDE.md` names.
 *
 * **The MCP half was wrong first and this inventory is what said so.** It used `resolveMemberSpaces` to
 * match `delete_entity`, which is the wrong twin: that one resolves a WRITE TARGET. A preview is a READ
 * across a proxy's members, so a scoped token would have previewed an entity in a member space it cannot
 * see. Copying the neighbouring tool is exactly how that happens.
 */
/*
 * 44 -> 45 at 5.0: the `filter` tool gained a cross-space read. Its space became OPTIONAL to match the
 * route, and an omitted space fans out over every space the connection can reach — a fan-out site that
 * did not exist before, BORN narrowed rather than converted.
 *
 * Raised rather than absorbed, because the invariant below only means something if the total is the real
 * number of fan-out sites. Leaving it at 44 and letting the arithmetic balance elsewhere is how a
 * conservation check stops conserving anything.
 */
const TOTAL = 45;

/**
 * Fan-out sites that were REMOVED rather than converted, with the tool that owned them.
 *
 * The invariant below says a conversion must MOVE a site and never drop it, because a deletion dressed as a
 * conversion looks exactly like progress. A tool being retired is the one legitimate way a site leaves the
 * inventory — and the honest way to record it is here, not by lowering `TOTAL`, which would erase the fact
 * that the site ever existed and make the original count unverifiable.
 *
 * - **3, at 5.0: `list_chrono`.** It folded into `filter`, which reads across spaces through its own
 *   narrowed path. `server/src/mcp/tools/chrono.ts` left the NARROWED set with it: a file with no fan-out
 *   cannot claim a conversion.
 */
const REMOVED = 3;

const GUARDS = {
  'server/src/auth/middleware.ts': 2,
  // `mcp/router.ts` used to be here. Its guard is FLIPPED: it calls `memberSpacesWithin` and refuses only when the
  // connection reaches no member, so it is counted by `narrowedCalls()` now rather than as an un-flipped guard.
  // Leaving it in both places would double-count it, which the conserved total caught immediately (30 !== 29).
  //
  // `auth/middleware.ts` stays: its predicate is flipped, but it still resolves the member list with
  // `resolveMemberSpaces` — it needs the FULL list to decide reachability, which is exactly what a guard does.
};

const NARROWED = new Set([
  // Converted to memberSpacesForRequest. A no-op while the guard still requires all members, which is what makes
  // the conversion provable rather than a behaviour change taken on trust.
  'server/src/api/brain/search.ts',
  'server/src/mcp/tools/search.ts',
  'server/src/mcp/tools/spaces.ts',
  'server/src/mcp/tools/file.ts',
  'server/src/mcp/tools/edge.ts',
  // `chrono.ts` was here and is not any more, which is a REMOVAL rather than a regression: `list_chrono`
  // was its only read fan-out and it folded into `filter` at 5.0. A file with no fan-out left cannot claim
  // a conversion, and leaving it listed would let the next reader believe a narrowing is enforced there.
  'server/src/api/spaces.ts',
  'server/src/api/brain/file-meta.ts',
  // Born narrowed: the record half of the embedding queue never had a whole-proxy read to convert.
  'server/src/api/brain/embed-jobs.ts',
  'server/src/api/brain/entities.ts',
  'server/src/api/files.ts',
]);

const PENDING = {
};

// 28 read fan-outs across 13 files, plus 5 write-target sites. Those numbers came out of this gate, and the first
// version of this list was WRONG in both directions: it said "17 files", which was a `grep -c` count that included
// import lines, and it missed `mcp/tools/search.ts` and `mcp/tools/spaces.ts` entirely because the shell output
// that produced it had been truncated by `head -30`.
//
// That is the standing lesson about scoping a sweep from the shape rather than from the names, and it is exactly why
// the inventory is derived and asserted here instead of being carried in a tracker: a hand-count of a set this size
// is wrong the first time, every time.

/** The module that DEFINES it, and the rule module that only names it in prose. Neither is a fan-out. */
//  DEFINES it,  names it in prose, and  is the narrowing wrapper — its
// own call is the one legitimate un-narrowed use, since it is what does the narrowing.
const NOT_CALL_SITES = new Set([
  'server/src/spaces/proxy.ts',
  'server/src/auth/proxy-reach.ts',
  'server/src/spaces/proxy-scoped.ts',
]);

/**
 * Every `resolveMemberSpaces(<arg>)` call in the server, with its argument text.
 *
 * Derived from source rather than listed, because a list is the thing being checked. Import lines are excluded by
 * requiring an open paren directly after the name.
 */
function callSites() {
  const out = [];
  const files = execSync('git grep --untracked -l "resolveMemberSpaces" -- server/src', { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  for (const f of files) {
    if (NOT_CALL_SITES.has(f)) continue;
    // Comments STRIPPED first. Without this the sweep matched `resolveMemberSpaces` inside a comment explaining what
    // a handler does, and reported a by-reference fan-out in a file that had none. That is the standing rule about
    // source-reading gates: the prose describing a thing must not satisfy a check for the thing.
    const src = readFileSync(f, 'utf8')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/resolveMemberSpaces\(([^)]*)\)/g)) {
      out.push({ file: f, arg: m[1].trim() });
    }
    // A BY-REFERENCE pass is a fan-out the call regex above cannot see: `resolveFindSimilarScope(..., crossSpace,
    // accessibleSpaceIds, resolveMemberSpaces)` hands the function itself to a helper that then expands a proxy
    // inside. Found by accident — removing the import for a conversion broke the build on a line the gate had never
    // counted. A sweep that only matches calls is blind to exactly the indirection that makes a fan-out hard to
    // follow, which is the wrong way round.
    for (const m of src.matchAll(/(?<![.\w])resolveMemberSpaces(?!\s*\()/g)) {
      /*
       * "Is this name inside an `import { … }` clause?" is a CONTAINMENT question, so it is answered by the brace
       * stack rather than by reading backwards. 200 characters was a guess that fails on a long import list.
       *
       * `statementUpTo` was the wrong tool and said so loudly: it treats `{` as a statement boundary, which is right
       * for a block and wrong for an import clause, so the window began after the brace and no longer contained the
       * word `import`. Six files were then reported as by-reference fan-outs on the strength of their import line.
       */
      const enclosing = enclosingBlocksMatching(src, m.index, /^\s*import\s/);
      if (enclosing.length) continue;   // the import statement itself is not a use
      out.push({ file: f, arg: 'BY-REFERENCE' });
    }
  }
  return out;
}

/**
 * A write target needs no narrowing: a proxy write requires an explicit `targetSpace`, so the argument is already
 * one real space. Recognised from the ARGUMENT rather than from a list, so a new write path is classified without
 * anyone remembering to add it.
 */
const isWriteTarget = (arg) => /^(wt\.target|writeTarget)$/.test(arg);


/** Calls that HAVE been narrowed — `memberSpacesForRequest` / `memberSpacesForRecord`. */
function narrowedCalls() {
  const out = [];
  const files = execSync('git grep --untracked -l "memberSpaces" -- server/src', { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  for (const f of files) {
    if (NOT_CALL_SITES.has(f) || f === 'server/src/spaces/proxy-scoped.ts') continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/memberSpaces(?:ForRequest|ForRecord|Within)\(/g)) out.push({ file: f, at: m.index });
  }
  return out;
}

describe('the inventory matches the source', () => {
  const sites = callSites();
  const done = narrowedCalls();

  it('finds call sites at all — an empty sweep would pass everything', () => {
    // The failure this repo keeps finding: a gate whose measurement returns nothing reads exactly like a clean one.
    assert.ok(sites.length + done.length >= 25, `only found ${sites.length + done.length} — the sweep is broken`);
  });

  it('every un-narrowed read fan-out is a listed PENDING file', () => {
    const unlisted = sites
      .filter(s => !isWriteTarget(s.arg) && !(s.file in PENDING) && !(s.file in GUARDS))
      .map(s => `${s.file} → resolveMemberSpaces(${s.arg})`);
    assert.deepEqual(unlisted, [],
      'a read fan-out in a file the inventory does not list. Narrow it with memberSpacesForRequest '
      + '(spaces/proxy-scoped.ts) and move the file to NARROWED, or add it to PENDING with its count.');
  });

  it('PENDING counts match, so a NEW fan-out in a known file is caught', () => {
    const actual = {};
    for (const s of sites) {
      if (isWriteTarget(s.arg)) continue;
      if (s.file in GUARDS) continue;
      actual[s.file] = (actual[s.file] ?? 0) + 1;
    }
    assert.deepEqual(actual, PENDING);
  });

  it('no PENDING entry is stale', () => {
    // A list that outlives its code starts describing the past — the same reason a tracker checkbox is not evidence.
    const seen = new Set(sites.filter(s => !isWriteTarget(s.arg)).map(s => s.file));
    assert.deepEqual(Object.keys(PENDING).filter(f => !seen.has(f)), []);
    assert.deepEqual(Object.keys(GUARDS).filter(f => !seen.has(f)), []);
  });
});

describe('a NARROWED file is really narrowed', () => {
  it('contains no un-narrowed read fan-out left behind', () => {
    // The half-converted file is the dangerous state: six sites narrowed and a seventh still fanning out over every
    // member reads as done and leaks on one route.
    const leftovers = callSites()
      .filter(s => !isWriteTarget(s.arg) && NARROWED.has(s.file))
      .map(s => `${s.file} → resolveMemberSpaces(${s.arg})`);
    assert.deepEqual(leftovers, []);
  });

  it('actually calls the narrowing helper', () => {
    // Otherwise a file could be moved to NARROWED by deleting its fan-outs rather than converting them.
    const byFile = new Set(narrowedCalls().map(c => c.file));
    assert.deepEqual([...NARROWED].filter(f => !byFile.has(f)), []);
  });
});

describe('the narrowing half is COMPLETE', () => {
  it('PENDING is empty — every read fan-out is narrowed', () => {
    // The definition of done for Q-6's expensive half, and now a regression guard: a new un-narrowed fan-out puts a
    // file back into PENDING and fails here as well as in the classification test.
    //
    // What is left is NOT a fan-out. The three GUARDS still require a token to reach every member of a proxy, which
    // is why all of this has been a provable no-op so far. Flipping them to accept a non-empty intersection is the
    // one behaviour change, and it is now a small diff against fully-narrowed read paths instead of a leap of faith.
    assert.deepEqual(PENDING, {});
  });
});

describe('the total is conserved', () => {
  it('narrowed + still pending accounts for every read fan-out', () => {
    // The invariant that makes progress checkable: converting a site must MOVE it, never drop it. A conversion that
    // quietly deleted a fan-out would otherwise look like progress.
    const pending = Object.values(PENDING).reduce((a, b) => a + b, 0);
    const guards = Object.values(GUARDS).reduce((a, b) => a + b, 0);
    const narrowed = narrowedCalls().length;
    assert.equal(pending + guards + narrowed + RECLASSIFIED + REMOVED, TOTAL,
      `expected ${TOTAL}, got ${pending} pending + ${guards} guards + ${narrowed} narrowed + `
      + `${RECLASSIFIED} reclassified + ${REMOVED} removed`);
  });
});

describe('the write-target classification is real, not a loophole', () => {
  it('recognises exactly the resolved-write-target form', () => {
    assert.equal(isWriteTarget('wt.target'), true);
    // `writeTarget` counts too: `locateForUpdate` takes one and every caller passes `wt.target`. The parameter used
    // to be called `spaceId`, which is exactly why it was misclassified as a fan-out — a name decides this.
    assert.equal(isWriteTarget('writeTarget'), true);
    for (const arg of ['spaceId', 'id', 'callSpace', 'rawSpace', 's.id', 'wt.target ?? spaceId', 'proxyId']) {
      assert.equal(isWriteTarget(arg), false, `${arg} must not classify as a write target`);
    }
  });

  it('at least one real write-target site exists, so the branch is exercised', () => {
    // At zero, `isWriteTarget` could be wrong in either direction and every test above would still pass.
    assert.ok(callSites().some(s => isWriteTarget(s.arg)), 'no write-target call sites found — check the pattern');
  });
});
