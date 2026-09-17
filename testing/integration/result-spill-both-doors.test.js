/**
 * A result set past the BYTE BUDGET comes back as a whole-record prefix plus a link to the rest — on both doors.
 *
 * ## Why this exists as well as the standalone gate
 *
 * `result-spill-suppresses-vectors.test.js` pins the rules by reading source: the node count comes from the
 * payload, the vector strip wraps the write, all eight result paths go through the shared budget. None of that
 * proves the budget is ever REACHED, and a truncation that never triggers is indistinguishable from no budget
 * at all.
 *
 * So this seeds 28 entities and asks for them under a budget small enough to bite, then asserts the shape a
 * caller actually receives and downloads the remainder to count what is in it.
 *
 * ## What it caught, twice
 *
 * The first version of this test found the record cap living in the `traverse > 0` branch only, so `topK: 28`
 * with no traversal returned everything. The standalone gate had passed, because every rule it checked was true
 * in the branch it looked at.
 *
 * The byte-budget rewrite found the second one, and it is the same shape a layer down: `spillResultSet` still
 * carried the old `records <= 25` guard, so a response truncated with a small remainder said `truncated: true`
 * and carried NO `remainder` — the caller was told there was more and given no way to reach it. **That is why
 * the budget here is set to bite with only a handful of records left over rather than with dozens.** A test
 * that truncated at three and spilled twenty-five would have passed over it.
 *
 * ## What "a way to reach the rest" means since the dump became opt-in
 *
 * The remainder FILE is now written only on `remainderDump: true`, because it is a write on a read path that
 * most callers never opened. That is only permitted because `nextSkip` and `skip` exist, so the invariant this
 * file guards is unchanged and its assertions moved rather than relaxed: a truncated response must still offer
 * a route to the remaining matches, and it is now `nextSkip` that must always be there.
 *
 * The paging test does not stop at "the field is present" — it FOLLOWS it to exhaustion and checks the union
 * against the seeded ids, because a `nextSkip` off by one would satisfy every presence assertion while dropping
 * or duplicating a record on every page.
 *
 * Run: node --test testing/integration/result-spill-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `result-spill-${RUN}`;
const COUNT = 28;
const QUERY = 'vault credential rotation service';

/**
 * The budget is MEASURED, not guessed — 80% of what the full 28 records actually serialise to.
 *
 * A hardcoded byte figure would be a flake with a delay on it: the record size here depends on the seed text,
 * on which fields recall returns by default, and on whether diagnostics are included, and all three have
 * changed within one release. A budget derived from the response cannot fall on the wrong side of the total.
 *
 * 80% for a reason: the point is a SMALL remainder. The defect this file now guards was invisible at a large
 * one, because the dead threshold it exposes only dropped remainders of 25 records or fewer.
 */
let tightBytes = 0;

let tokenA;
let ids = [];
const token = () => tokenA;

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const created = await post(INSTANCES.a, token(), '/api/spaces', { id: SPACE, label: `Result spill ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // Written WITHOUT `waitForEmbedding`: 28 sequential model calls is the difference between a test that runs and
  // one nobody runs.
  for (let i = 0; i < COUNT; i++) {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
      name: `vault-credential-service-${i}-${RUN}`,
      type: 'service',
      description: `Vault credential rotation service number ${i}, scoping authentication tokens`,
      tags: [], properties: {},
    });
    if (r.status !== 201) break;
    ids.push(r.body._id ?? r.body.id);
  }
  // NO wait for the vector index. Every recall also scans the newest records straight from the collection
  // since 5.0, so the test does not depend on how warm the embedder is. This used to pass
  // `includeFreshWrites: true` for the same reason; the flag is gone because the scan is unconditional.
  //
  // IT DOES DEPEND ON `DUPE_FRESH_WINDOW_MS`, which `testing/docker-compose.test.yml` sets to ten minutes —
  // the maximum `env-num.ts` accepts, and it refuses anything higher at boot rather than clamping.
  // The default is 180 s, sized from the worst reported deployment, and this file takes longer than that on
  // a loaded runner: seed 28, calibrate, then twelve assertions. When the window expires, the OLDEST record
  // is in neither channel — not indexed yet, no longer fresh — and the only symptom is `count` short by
  // exactly the records that aged out. It read 27 of 28 on CI, against a client-only diff. Q-6.
  //
  // So do not shorten the window in the compose file to match production. The window is what makes this
  // file's premise true, and the premise is the thing being tested.
  //
  // It matters: waiting for 28 embeddings on a freshly rebuilt stack hit the shared 300-second index-lag timeout
  // and failed every assertion for a reason that had nothing to do with the spill.

  // Measure the full answer once, and take 80% of it as the budget every assertion below uses.
  if (ids.length === COUNT) {
    // Both ceilings raised, like the two reference calls below: this measures how big the WHOLE answer is,
    // and a default ceiling clipping it would leave `tightBytes` at 0 — which makes the whole file skip
    // rather than fail, so the failure would arrive as silence.
    const full = await recall({
      query: QUERY, types: ['entity'], topK: COUNT, maxBytes: 5_000_000, maxChars: 5_000_000,
    });

    /*
     * THE BUDGET IS 80% OF THE SMALLER DOOR'S FULL ANSWER, and taking it from REST alone was a latent bug
     * that `includeRecordMeta` finally tripped.
     *
     * A REST result FLATTENS the record into the ranking envelope; an MCP result nests it under `record`
     * with a narrower envelope. So the same corpus is a different number of bytes through each door, and
     * MCP's has always been the smaller. 80% of REST's was above MCP's full answer only by a margin
     * nobody had measured — it was luck, not design, and the margin was thin.
     *
     * Making storage bookkeeping opt-in removed the SAME absolute bytes from both doors, which is a
     * smaller PROPORTION of the larger one. The bar `M > 0.8R` became `M > 0.8R + 0.2S`, MCP's answer
     * dropped under it, and the assertion that MCP truncates went false — with nothing wrong in either
     * door.
     *
     * Taking the minimum makes the budget bind on both by construction, so this cannot rot again the next
     * time either envelope changes size. It stays MEASURED rather than assumed, and it stays ONE number,
     * which is what lets the assertions below claim the two doors honour the same parameter identically.
     */
    let mcpBytes = Infinity;
    try {
      const probe = await openMcpSession(token());
      try {
        const unbudgeted = JSON.parse((await probe.callTool('recall', {
          space: SPACE, query: QUERY, types: ['entity'], topK: COUNT,
          maxBytes: 5_000_000, maxChars: 5_000_000,
        }))?.content?.[0]?.text ?? '{}');
        if (unbudgeted.truncated === false && typeof unbudgeted.bytesReturned === 'number') {
          mcpBytes = unbudgeted.bytesReturned;
        }
      } finally {
        await probe.close?.();
      }
    } catch {
      // No MCP session here is not a failure: the MCP test skips itself on the same condition, and the REST
      // assertions must still run. `Infinity` leaves the budget REST-derived, exactly as before.
    }

    if (full.status === 200 && full.body.truncated === false) {
      tightBytes = Math.max(1_000, Math.floor(Math.min(full.body.bytesReturned, mcpBytes) * 0.8));
    }
  }
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

/** The answer does not wait on the embedding queue: recall scans the newest records itself. */
const recall = (body) => post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ ...body }) });

/**
 * The full match total, measured NOW — never the `COUNT` constant.
 *
 * ## The flake this removes, and why the constant was the bug rather than the timing
 *
 * These assertions read `count === COUNT` (28). CI failed three of them with `27 !== 28`, which the
 * docblock above `before()` had already diagnosed against itself: with no wait for the vector index, a
 * record is reachable through the fresh-write channel only until `DUPE_FRESH_WINDOW_MS` expires, and the
 * OLDEST one can age out between the seed and an assertion — in neither channel, and `count` is short by
 * exactly the records that lapsed.
 *
 * The mitigation was a ten-minute window in the compose file, which is **the maximum `env-num.ts` accepts**.
 * So there was no larger number to reach for, and a test whose premise is "a wall clock has not run out yet"
 * is a guard on the wrong axis: the property being tested has nothing to do with elapsed time.
 *
 * **The property is that `count` is the FULL total rather than the returned prefix or the post-skip
 * remainder.** So it is compared against a total measured milliseconds earlier, by the same door, on the
 * same corpus — which cannot disagree about what has aged out. If a record lapses, both numbers move
 * together and the property still holds; if `count` ever became the prefix, both would not.
 *
 * The floor is what keeps it from passing vacuously: a corpus that had collapsed to two records would
 * satisfy any equality, so `ready()` requires a total worth truncating.
 */
const fullCount = async () => {
  // BOTH ceilings, not just the byte one. `maxChars` has its own default (50000 on this door) and would
  // otherwise be the binding constraint, so a reference call meant to be unbudgeted could truncate and
  // answer 0 — which reads as "writes unavailable" and skips the whole file.
  const r = await recall({
    query: QUERY, types: ['entity'], topK: COUNT, maxBytes: 5_000_000, maxChars: 5_000_000,
  });
  return r.status === 200 && r.body.truncated === false ? r.body.count : 0;
};

/**
 * Skip when the environment could not seed; FAIL when it seeded and the calibration still did not happen.
 *
 * The two are not the same and must not share an exit. "Writes unavailable" is an honest environment skip;
 * a calibration that silently produced no budget would make every assertion below run against `maxBytes: 0`
 * and report green for having measured nothing.
 */
const ready = (t) => {
  if (ids.length !== COUNT) { t.skip(`seeded ${ids.length}/${COUNT} — writes unavailable`); return false; }
  assert.ok(tightBytes > 0, 'the calibration recall in before() did not produce a budget — see its guard');
  return true;
};

/**
 * The total to compare against, plus the floor that stops the comparison being vacuous.
 *
 * At most `COUNT`, and allowed to be less — a record aged out of the fresh-write window is a fact about the
 * environment, not a defect. Below the floor it IS a defect, or a corpus so collapsed that "count is the
 * full total" would be true of almost any number.
 */
const totalNow = async () => {
  const total = await fullCount();
  assert.ok(total >= COUNT - 3 && total <= COUNT,
    `the unbudgeted total is ${total}, outside ${COUNT - 3}..${COUNT} — too far off to compare a budgeted `
    + 'count against, and a corpus that small would satisfy the equality without testing it');
  return total;
};

describe('REST: a tight budget returns a prefix and a way to reach the rest', () => {
  it('says what it sent, what exists, and where to continue from', async (t) => {
    if (!ready(t)) return;
    // Measured first and used below: the same door's answer to "how many match", taken milliseconds before
    // the budgeted call so the two cannot disagree about what has aged out of the fresh-write window.
    const total = await totalNow();
    const r = await recall({ query: QUERY, types: ['entity'], topK: COUNT, maxBytes: tightBytes });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));

    // The five accounting fields are on EVERY response, which is the property that makes an absence
    // uninterpretable rather than ambiguous. Asserted by presence, not by value, where the value is data.
    // Seven now, not five: B-1 split the one figure that claimed to be bytes into the character count it
    // actually was plus a real byte count, and both ceilings are echoed.
    for (const f of ['returned', 'count', 'truncated', 'budgetChars', 'budgetBytes', 'charsReturned', 'bytesReturned']) {
      assert.notEqual(r.body[f], undefined, `${f} must be on every response: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    assert.equal(r.body.budgetBytes, tightBytes, 'the budget applied must be the one asked for');
    assert.equal(r.body.truncated, true,
      `${COUNT} records must not fit in ${tightBytes} bytes: ${JSON.stringify(r.body).slice(0, 300)}`);

    // A PREFIX of whole records — not a fixed sample. The old shape returned three whatever the budget was.
    assert.equal(r.body.returned, r.body.results.length, 'returned must count what was actually sent');
    assert.ok(r.body.returned > 3,
      `a budget must return what fits, not a constant — got ${r.body.returned} of ${r.body.count}`);
    assert.ok(r.body.returned < r.body.count, 'and it must not be the whole set, or nothing was truncated');
    assert.equal(r.body.count, total, 'count is the full match total, so a caller can size what they are missing');
    assert.ok(r.body.bytesReturned <= tightBytes, `bytesReturned ${r.body.bytesReturned} exceeds the budget`);

    // Every returned record is WHOLE. A description cut in half would be the one failure the byte accounting
    // could otherwise hide.
    // `.record.description`: a hit is `{score, spaceId, type, record}` on this door since 5.0, when the
    // route collapsed onto the shared tool module. Reading `rec.description` would be `undefined` and the
    // regex would fail for the wrong reason — which is what it did.
    for (const rec of r.body.results) {
      assert.match(rec.record?.description, /^Vault credential rotation service number \d+, scoping authentication tokens$/,
        `a returned record must be whole: ${JSON.stringify(rec).slice(0, 200)}`);
    }

    /*
     * THE REGRESSION THIS FILE EXISTS FOR: truncated and no way to reach the rest.
     *
     * The way is now `nextSkip` rather than a file. The dump became opt-in because it is a WRITE on a read
     * path that most callers never opened — but that is only allowed to be optional BECAUSE this field is
     * here, so the assertion is unconditional and this call deliberately does NOT ask for the dump.
     */
    assert.equal(r.body.nextSkip, r.body.returned,
      'truncated with no nextSkip — the caller is told there is more and cannot reach it');
    assert.equal(r.body.remainder, undefined,
      'the dump is opt-in now: a truncated call that did not ask for it must not write a file');
  });

  it('the remainder file is written only when asked, and then holds exactly what did not fit', async (t) => {
    if (!ready(t)) return;
    const r = await recall({
      query: QUERY, types: ['entity'], topK: COUNT, maxBytes: tightBytes, remainderDump: true,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.truncated, true);
    assert.notEqual(r.body.remainder, undefined, 'asked for and not delivered');
    assert.equal(r.body.remainder.matches, r.body.count - r.body.returned,
      'the file holds exactly what did not fit, never the records already sent');
    assert.match(r.body.remainder.path, /^_tmp\/results-[0-9a-f-]+\.json$/);
    assert.equal(r.body.remainder.inline, undefined,
      'inline described the old three-record sample and must not reappear');
    // Both ways out of a truncated answer, on the same response. Asking for the file does not cost the
    // continuation, because a caller may well want to page AND keep the artifact.
    assert.equal(r.body.nextSkip, r.body.returned, 'and the continuation is still stated');

    const ttlHours = (new Date(r.body.remainder.expiresAt) - Date.now()) / 3_600_000;
    assert.ok(ttlHours > 20 && ttlHours <= 24, `one day, got ${ttlHours.toFixed(1)}h`);
  });

  it('the file holds the remainder, carries no vectors, and needs the token', async (t) => {
    if (!ready(t)) return;
    const r = await recall({
      query: QUERY, types: ['entity'], topK: COUNT, maxBytes: tightBytes, remainderDump: true,
    });
    assert.notEqual(r.body.remainder, undefined, JSON.stringify(r.body).slice(0, 300));
    const url = `${INSTANCES.a}${r.body.remainder.download}`;

    const anon = await fetch(url);
    assert.ok(anon.status === 401 || anon.status === 403, `unauthenticated must be refused, got ${anon.status}`);

    const authed = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
    assert.equal(authed.status, 200);
    const text = await authed.text();
    const body = JSON.parse(text);

    assert.equal(body.kind, 'recall-results');
    assert.equal(body.results.length, r.body.count - r.body.returned,
      'the file must hold the remainder, not the whole set — re-sending what the caller has is the old defect');
    assert.equal(body.matches, body.results.length, 'and its own header must agree with its contents');
    assert.equal(body.graphNodes, 0, 'no traversal was asked for, so the file claims no nodes');
    assert.equal(body.records, body.results.length, 'records is matches plus nodes, counted from the payload');
    assert.equal(body.request.query, QUERY, 'and say what produced it');
    // The owner asked for this by name.
    assert.equal(/"embedding"|"vector"|"embeddings"/.test(text), false, 'no vector may reach the file');
  });

  it('an answer that fits is untouched — no truncation, no file', async (t) => {
    if (!ready(t)) return;
    const r = await recall({ query: QUERY, types: ['entity'], topK: 5 });
    assert.equal(r.status, 200);
    assert.equal(r.body.truncated, false, 'five records fit the default budget');
    assert.equal(r.body.remainder, undefined, 'and nothing is written out');
    assert.equal(r.body.results.length, 5);
    assert.equal(r.body.returned, 5);
    /*
     * Still stated rather than implied: the fields are present on the calls where the budget did NOT bite,
     * which is the whole reason a caller never has to interpret an absence.
     *
     * The DEFAULT is a character ceiling. It used to be `budgetBytes: 100000`, which was a character count
     * with a byte name — the defect B-1 fixed. `budgetBytes` is now null here because no byte ceiling was
     * asked for, and null is REPORTED rather than omitted, for the same reason every other field on this
     * envelope is: an absent field has to be interpreted.
     */
    assert.equal(r.body.budgetChars, 50_000, 'the operator default, reported even when it did not bite');
    assert.equal(r.body.budgetBytes, null, 'no byte ceiling was asked for, and its absence is STATED');
    assert.equal(typeof r.body.charsReturned, 'number', 'both figures are reported, always');
    assert.equal(typeof r.body.bytesReturned, 'number');
  });

  it('a budget that cannot hold one record still returns that record, whole', async (t) => {
    if (!ready(t)) return;
    // A budget must not become a wall. The floor is 1000 bytes, below which the request is refused rather
    // than silently rounded — so this asks for the floor and a record larger than it.
    const r = await recall({ query: QUERY, types: ['entity'], topK: COUNT, maxBytes: 1000 });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.ok(r.body.returned >= 1, 'a caller must always be able to read at least one record');
    assert.match(r.body.results[0].record?.description, /scoping authentication tokens$/, 'and it must be whole');
    assert.equal(r.body.truncated, true);
    assert.equal(r.body.nextSkip, r.body.returned, 'with the other 27 reachable');
  });

  it('refuses a budget it cannot honour, rather than choosing one', async (t) => {
    if (!ready(t)) return;
    const bad = await recall({ query: QUERY, maxBytes: 'plenty' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body).slice(0, 200));
    assert.match(bad.body.error, /maxBytes/, 'and name the parameter it refused');
  });

  it('refuses a skip it cannot honour, on the same terms', async (t) => {
    if (!ready(t)) return;
    // Same shape of refusal as the budget: named parameter, 400, no chosen-for-you fallback. A `skip` that
    // silently floored to zero would re-serve page one to a caller who thought they were on page two.
    for (const skip of ['2', -1, 1.5]) {
      const bad = await recall({ query: QUERY, skip });
      assert.equal(bad.status, 400, `skip ${JSON.stringify(skip)}: ${JSON.stringify(bad.body).slice(0, 200)}`);
      assert.match(bad.body.error, /skip/, 'and name the parameter it refused');
    }
    const badDump = await recall({ query: QUERY, remainderDump: 'yes' });
    assert.equal(badDump.status, 400, JSON.stringify(badDump.body).slice(0, 200));
    assert.match(badDump.body.error, /remainderDump/);
  });

  /**
   * THE CLAUSE THAT MAKES THE OPT-IN DUMP SAFE, exercised end to end rather than asserted a field exists.
   *
   * Paging is what a truncated caller does instead of downloading a file, so "there is a `nextSkip`" is not the
   * property that matters — "following it reaches every match exactly once" is. Loops the whole 28 under a
   * budget that bites and checks the union against the ids that were seeded.
   */
  it('following nextSkip reaches every match exactly once, and then stops', async (t) => {
    if (!ready(t)) return;
    /*
     * THE PRECONDITION IS CHECKED, NOT ASSUMED — and that is what makes this a gate rather than a flake.
     *
     * `skip` is a continuation over ONE ranked answer, not a cursor over a snapshot: the search re-runs per
     * call. So "the pages union to the whole set" only holds while the ranking holds still, and on this space
     * it can legitimately move — 28 records are being ingested into the vector index while the test runs, so
     * a record can be scored by the fresh-write channel on one call and by the index on the next.
     *
     * The first version of this test asserted the union unconditionally and CI failed it: page two was
     * entirely inside page one. That found a real defect — nine ranking sorts with no tie-break, so a fully
     * tied set came back in whatever order the database gave, fixed by `byRankThenId`. It also showed the
     * assertion was stronger than the feature: reading the unbudgeted order before and after is what
     * separates "the paging arithmetic is wrong" from "the corpus moved under it".
     *
     * The arithmetic assertions inside the loop are unconditional either way, because those hold whatever the
     * ranking does.
     */
    const orderOf = async () => {
      // Both ceilings raised, for the reason `fullCount` gives: a null here skips the identity assertions
      // AND the union-size check below, so this call truncating would quietly remove the strongest part
      // of this test rather than fail it.
      const r = await recall({
        query: QUERY, types: ['entity'], topK: COUNT, maxBytes: 5_000_000, maxChars: 5_000_000,
      });
      return r.status === 200 && r.body.truncated === false ? r.body.results.map(x => x.record?._id).join(',') : null;
    };
    const before = await orderOf();
    const total = await totalNow();

    const seen = [];
    let skip = 0;
    let pages = 0;
    for (;;) {
      const r = await recall({ query: QUERY, types: ['entity'], topK: COUNT, maxBytes: tightBytes, skip });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      assert.equal(r.body.count, total, 'count stays the FULL total on every page, never the post-skip total');
      seen.push(...r.body.results.map(x => x.record?._id));
      pages++;
      assert.ok(pages <= COUNT, 'a page that returns nothing and still says truncated would loop forever');
      if (!r.body.truncated) { assert.equal(r.body.nextSkip, undefined, 'and the last page offers no next'); break; }
      assert.ok(r.body.returned > 0, 'a truncated page that returned nothing would never advance');
      assert.equal(r.body.nextSkip, skip + r.body.returned, 'nextSkip is absolute, not relative to the page');
      skip = r.body.nextSkip;
    }
    assert.ok(pages > 1, `the budget must actually bite or this proves nothing — ${pages} page(s)`);

    const after = await orderOf();
    if (before === null || after === null || before !== after) {
      t.diagnostic('the ranking moved while paging (the index was still ingesting) — the identity assertions '
        + 'below do not apply, and the feature does not promise a snapshot. The arithmetic above still passed.');
      return;
    }

    /*
     * THE UNION SIZE IS CHECKED HERE, NOT ABOVE, AND AGAINST THE MEASURED LENGTH — NOT AGAINST `COUNT`.
     *
     * It used to sit above the stability check, with a comment claiming it was *"independent of the ranking:
     * paging must visit exactly as many slots as there are matches"*. That is not independent, and CI proved
     * it: 27 slots across 2 pages where `COUNT` is 28. Every other assertion agreed at 27 — `count` matched
     * `total`, which is measured rather than assumed — so the only number that disagreed was the seeded
     * constant.
     *
     * THE CAUSE IS ALREADY DIAGNOSED IN THIS FILE — see the docblock on `totalNow`, whose first line is
     * *"never the `COUNT` constant"*. Nothing waits for the vector index here, so a record is reachable
     * through the fresh-write channel only until `DUPE_FRESH_WINDOW_MS` expires, and the OLDEST one can
     * age out between the seed and an assertion: in neither channel, and the answer is short by exactly
     * the records that lapsed. That is why `totalNow` exists and why it accepts `COUNT - 3`.
     *
     * So this was a MISSED INSTANCE of a fix already made, not a new defect. Three comparisons against
     * `COUNT` survived that change; two of them failed together on CI. Asserting against the seeded
     * constant makes the test fail for the corpus lapsing, which is what the stability check below was
     * added to separate out — the assertion was simply on the wrong side of it.
     *
     * It keeps its purpose: with the ranking held still, an off-by-one in `nextSkip` still changes this
     * count, and `before` is the ranked length measured the same way the loop measures it.
     */
    const rankedPositions = before.split(',').length;
    assert.equal(seen.length, rankedPositions,
      `paging must visit all ${rankedPositions} ranked positions, got ${seen.length} across ${pages} pages`);
    assert.equal(new Set(seen).size, seen.length, 'a record was served twice — the pages overlap');
    /*
     * Over the ids the RANKING held, not over the ids the test created — the same correction as the size
     * assertion above. `before === after` says the ranking held still; it does not say the ranking contained
     * every record written, and `totalNow` already concedes that point by accepting a total of `COUNT - 3`.
     * Iterating the created set would fail for a record the index had not finished with, which is a fact
     * about the environment rather than a gap between two pages.
     */
    for (const id of before.split(',')) {
      assert.ok(seen.includes(id), `paging never returned ${id} — a gap between two pages`);
    }
    assert.equal(seen.join(','), before,
      'the pages concatenated must equal the unbudgeted ranked answer, in order');
  });
});

describe('MCP: the same answer through the other door', () => {
  it('truncates identically and points at the same kind of remainder', async (t) => {
    if (!ready(t)) return;
    let session;
    try {
      session = await openMcpSession(token());
    } catch (e) {
      return t.skip(`MCP session unavailable: ${e.message}`);
    }
    try {
      // Measured over the REST door on purpose: the total is a fact about the CORPUS, and reading it through
      // the surface under test would let one door's own bug supply the number it is checked against.
      const total = await totalNow();
      const res = await session.callTool('recall', {
        space: SPACE, query: QUERY, types: ['entity'], topK: COUNT,
        maxBytes: tightBytes,
      });
      const text = res?.content?.[0]?.text ?? '';
      const out = JSON.parse(text);

      /*
       * HOW MANY RANKED POSITIONS THERE ARE, which is NOT the same number as `count`.
       *
       * `count` is how many records MATCH, supplied to the envelope separately; `results` is the ranked
       * list. Both can fall below the 28 seeded, for the reason `totalNow`'s docblock records: the oldest
       * record ages out of `DUPE_FRESH_WINDOW_MS` while nothing waits for the vector index, so it is in
       * neither channel. That docblock's rule is *"never the `COUNT` constant"*, and these three
       * comparisons were the ones that change missed.
       *
       * Three assertions in this file compared against the hardcoded `COUNT` instead, and CI failed two of
       * them together: `remainder.matches` was 6 where `count - returned` was 7. Measured once here, through
       * an unbudgeted call, and used by all three.
       */
      /*
       * BOTH ceilings are raised, and `truncated` is checked — because on THIS door `maxChars` defaults to
       * 25000 against REST's 50000, which is the one place the two doors deliberately differ. Raising
       * `maxBytes` alone would leave the character ceiling binding, so the "unbudgeted" call could come back
       * truncated and `results.length` would be a prefix masquerading as the full ranked list — a comparand
       * quietly smaller than the thing it is used to measure.
       */
      const unbudgeted = JSON.parse((await session.callTool('recall', {
        space: SPACE, query: QUERY, types: ['entity'], topK: COUNT,
        maxBytes: 5_000_000, maxChars: 5_000_000,
      }))?.content?.[0]?.text ?? '{}');
      assert.equal(unbudgeted.truncated, false,
        'the reference call must not itself truncate, or the ranked length it supplies is a prefix');
      const rankedLen = unbudgeted.results.length;
      assert.ok(rankedLen >= COUNT - 3 && rankedLen <= COUNT,
        `the unbudgeted ranked list is ${rankedLen}, outside ${COUNT - 3}..${COUNT} — too far off to page against`);

      for (const f of ['returned', 'count', 'truncated', 'budgetChars', 'budgetBytes', 'charsReturned', 'bytesReturned']) {
        assert.notEqual(out[f], undefined, `${f} must be on every response too: ${text.slice(0, 200)}`);
      }
      assert.equal(out.truncated, true, `MCP must truncate too: ${text.slice(0, 250)}`);
      assert.equal(out.budgetBytes, tightBytes, 'the same parameter, honoured the same way');
      assert.equal(out.returned, out.results.length);
      assert.ok(out.returned > 3, `a prefix, not a sample — got ${out.returned}`);
      assert.equal(out.count, total, 'count is the full set');
      // Same default as REST, and the parity is the point: a dump that happened on one door and not the other
      // would make a truncated read cost different amounts depending on which client the caller picked.
      assert.equal(out.nextSkip, out.returned, 'and the continuation is there');
      assert.equal(out.remainder, undefined, 'with no file written, because none was asked for');

      // Then the same call WITH the flag, on the same door — the second half of clause 6b.
      const dumped = JSON.parse((await session.callTool('recall', {
        space: SPACE, query: QUERY, types: ['entity'], topK: COUNT,
        maxBytes: tightBytes, remainderDump: true,
      }))?.content?.[0]?.text ?? '{}');
      assert.notEqual(dumped.remainder, undefined, 'asked for and not delivered on the MCP door');
      assert.equal(dumped.remainder.matches, rankedLen - dumped.returned,
        'holding only what did not fit — measured against the RANKED length, not `count`, which is the corpus');

      // And `skip` continues here too, or the opt-in would strand an MCP caller specifically.
      const next = JSON.parse((await session.callTool('recall', {
        space: SPACE, query: QUERY, types: ['entity'], topK: COUNT,
        maxBytes: tightBytes, skip: out.nextSkip,
      }))?.content?.[0]?.text ?? '{}');
      assert.equal(next.count, total, 'count stays the full total on a skipped page');
      assert.ok(next.results.length > 0, 'the next page must not be empty');
      // Counted, not identity-compared. `skip` continues one ranked answer rather than a snapshot, and this
      // space is still ingesting into the vector index — so two calls can legitimately rank differently and an
      // id comparison here would be asserting a promise the feature does not make. What must hold on any
      // ranking is that skipping N leaves exactly the rest: see the REST paging test for the identity check
      // and the precondition it guards it with.
      assert.equal(next.results.length, rankedLen - out.nextSkip,
        `skipping ${out.nextSkip} of ${rankedLen} ranked positions must leave ${rankedLen - out.nextSkip} to serve`);
      assert.equal(next.truncated, false,
        'and the remaining matches fit, so the last page must not still claim more');

      // A tool result is a model's context window: the budget is the promise, so hold it to the budget.
      assert.ok(text.length <= tightBytes * 1.5,
        `the payload must respect the budget it reported, got ${text.length} chars for ${tightBytes}`);
    } finally {
      session?.close();
    }
  });

  it('the same maxTokens convenience, and the smaller of the two wins', async (t) => {
    if (!ready(t)) return;
    let session;
    try {
      session = await openMcpSession(token());
    } catch (e) {
      return t.skip(`MCP session unavailable: ${e.message}`);
    }
    try {
      // 2000 tokens at the default 3.5 chars/token is 7000 bytes; the 3000-byte ceiling is smaller and must win.
      const res = await session.callTool('recall', {
        space: SPACE, query: QUERY, types: ['entity'], topK: COUNT,
        maxTokens: 2000, maxBytes: 3000,
      });
      const out = JSON.parse(res?.content?.[0]?.text ?? '{}');
      assert.equal(out.budgetBytes, 3000,
        'a caller who states two ceilings meant both, so the smaller applies');
    } finally {
      session?.close();
    }
  });
});
