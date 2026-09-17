/**
 * `recall` and `filter` accept the same filter — the same operators AND the same field keys.
 *
 * ## The split this closes
 *
 * The two doors already shared the operator sanitizer. They did not share the KEYS: `recall` refused any
 * key not starting with `properties.`, `tags`, `type`, `name`, `status` or `label`, while `filter` accepted
 * any field at all. So a caller could predicate on `description` through one door and was refused through
 * the other — the exact split `CLAUDE.md` names as the defect this repo produces most, and the
 * recall/query filter pair is the example it was written from.
 *
 * ## Why the restriction went rather than being copied to `filter`
 *
 * It was a PERFORMANCE guard, not a correctness one, and the slow path already existed. A declarable
 * filter becomes a native `$vectorSearch` pre-filter; anything else scores exhaustively and filters after.
 * **Both keep the guarantee** — `topK` is filled from records that satisfy the filter, so a filtered recall
 * cannot silently miss a match — and only one is fast. Refusing the key did not make the query fast; it
 * made the capability absent.
 *
 * ## What had to arrive with it
 *
 * Disclosure. A caller who writes `{ description: … }` now buys an exhaustive scan of the space, and
 * without a signal they would blame recall for being slow. The result says which path ran.
 *
 * Run: node --test testing/integration/recall-filters-what-filter-filters.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `recallkeys-${RUN}`;

let tokenA;

const hit = async (path, args) => {
  const res = await fetch(`${INSTANCES.a}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
};

/** The generic tool door: `{ok, text, data}`, the same envelope for every tool. */
const call = (tool, args) => hit(`/api/${tool}`, args);

/**
 * `POST /api/brain/recall`, which answers the search object as the body.
 *
 * Used wherever a case reads a RESULT FIELD. Both doors run the identical code — the legacy route hands its
 * body to the same `callTool` — but `recall` puts its answer in `content` rather than `structuredContent`,
 * so `data` is `null` on the tool door and the fields live inside `text` as a JSON string. Asserting
 * through this one reads the field rather than a substring of a serialisation.
 */
const recallRest = (args) => hit('/api/brain/recall', args);

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const created = await post(INSTANCES.a, tokenA, '/api/spaces', { id: SPACE, label: `Recall keys ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const w = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${SPACE}/facts`, {
    fact: `The rollout window closes on Friday ${RUN}`,
    description: 'agreed in the platform sync',
    tags: ['rollout'], type: 'note',
  });
  assert.equal(w.status, 201, JSON.stringify(w.body));

  /*
   * Wait until the record is actually RECALLABLE, not until the write returned.
   *
   * A new space builds its vector indexes asynchronously, and a `$vectorSearch` against an index still in
   * INITIAL_SYNC throws — which `recallByType` catches and retries on the exhaustive path, correctly and
   * deliberately. So every `filterPath` assertion below reads `exhaustive` in a fresh space no matter what
   * filter it sent: the call really did scan, and the test would be measuring index warm-up rather than the
   * conversion it is about.
   *
   * Probed with a real recall rather than by sleeping or by watching the embed queue. A drained queue means
   * the vectors were written, not that the index can answer — the two are different clocks and only one of
   * them is the one these assertions depend on.
   */
  const deadline = Date.now() + 120_000;
  for (;;) {
    const probe = await hit('/api/brain/recall', { space: SPACE, query: 'rollout window' });
    if (probe.status === 200 && (probe.body.results ?? []).length > 0) break;
    assert.ok(Date.now() < deadline,
      `the fact never became recallable — the index never came up, so nothing below would be measuring the `
      + `filter path: ${JSON.stringify(probe.body).slice(0, 300)}`);
    await new Promise(r => setTimeout(r, 1000));
  }
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

describe('recall filters what filter filters', () => {
  it('a key outside the old allowlist is accepted by BOTH doors', async () => {
    /*
     * `description` is the case in one word: a real field, on every record type, that `filter` has always
     * accepted and `recall` refused. Nothing about it is unsafe — it is simply not one an index can serve.
     */
    const viaFilter = await call('filter', {
      space: SPACE, collection: 'facts', filter: { description: { $regex: 'platform', $options: 'i' } },
    });
    assert.equal(viaFilter.status, 200, JSON.stringify(viaFilter.body));
    assert.equal(viaFilter.body.data.results.length, 1);

    const viaRecall = await call('recall', {
      space: SPACE, query: 'rollout window',
      filter: { description: { $regex: 'platform', $options: 'i' } },
    });
    assert.equal(viaRecall.status, 200,
      `recall refused a key filter accepts: ${JSON.stringify(viaRecall.body).slice(0, 300)}`);
    assert.equal(viaRecall.body.ok, true);
  });

  it('and so is a key the allowlist never mentioned at all', async () => {
    // `fact` is the record's own text. Filtering on it beside a semantic query is a reasonable thing to
    // want and was refused outright.
    const r = await call('recall', {
      space: SPACE, query: 'rollout', filter: { fact: { $regex: String(RUN) } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  });

  it('a bare-scalar equality actually FILTERS, rather than being accepted and dropped', async () => {
    /*
     * The worst failure this surface can have, and it was live: `{type: 'note'}` was classified as the
     * operator-object grammar — where a value is supposed to be `{eq: 'note'}` — so the translation found no
     * operator, produced nothing, and the recall answered 200 with the UNFILTERED ranking.
     *
     * That is the fleet integrator's `/query` report exactly (*"it cost us a fabricated number"*): accepted,
     * ignored, and indistinguishable from working. It is asserted with a type that MATCHES NOTHING, because
     * a filter that is silently dropped looks perfect against a filter that matches everything.
     */
    const r = await recallRest({
      space: SPACE, query: 'rollout', types: ['fact'], filter: { type: 'NOT-A-REAL-TYPE' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.count, 0,
      `a filter nothing matches returned ${r.body.count} result(s) — it was dropped, not applied: `
      + JSON.stringify(r.body).slice(0, 300));

    // And the same spelling with a real value still finds the record, so the case above is not passing
    // because the filter refuses everything.
    const hit2 = await recallRest({
      space: SPACE, query: 'rollout', types: ['fact'], filter: { type: 'note' },
    });
    assert.equal(hit2.body.count, 1, `the same filter with a matching value must still find it: `
      + JSON.stringify(hit2.body).slice(0, 300));
  });

  it('the result says when it SCANNED, and says nothing when it did not', async () => {
    /*
     * The disclosure that had to arrive with the widening, and it reports the EXCEPTION only.
     *
     * A declarable filter is pushed into the vector search; anything else scores the space exhaustively and
     * filters after. Both are correct and one is far more expensive, so a caller who cannot tell them apart
     * will blame recall rather than the filter they wrote.
     *
     * Owner, 2026-09-17, on making it opt-in: *"we try to reduce the returned corpus for recalls"*. So it
     * follows `degraded`'s established pattern rather than getting a flag — a field that is absent when
     * things are fine costs a caller nothing and needs no parameter to discover. Telling somebody their
     * query was fine is not worth a line of their context.
     */
    const fast = await recallRest({ space: SPACE, query: 'rollout', types: ['fact'], filter: { type: 'note' } });
    assert.equal(fast.status, 200, JSON.stringify(fast.body).slice(0, 200));
    assert.equal(fast.body.filterPath, undefined,
      `a declarable filter took the fast path and must say nothing: ${JSON.stringify(fast.body).slice(0, 200)}`);

    const slow = await recallRest({
      space: SPACE, query: 'rollout', types: ['fact'], filter: { description: { $regex: 'platform' } },
    });
    assert.equal(slow.status, 200, JSON.stringify(slow.body).slice(0, 200));
    assert.equal(slow.body.filterPath, 'exhaustive',
      `a non-declarable filter must say it scanned: ${JSON.stringify(slow.body).slice(0, 200)}`);
  });

  it('a raw Mongo filter on a declared field is NOT a scan', async () => {
    /*
     * The case the disclosure itself found, and the reason it was worth adding.
     *
     * A raw filter went down the exhaustive path unconditionally, on the note that *"a raw filter is never
     * declarable"*. True of `$or`, false of `{type: 'note'}` — and it stopped being acceptable the day the
     * raw grammar became the RECOMMENDED one, because every caller writing what we now recommend was buying
     * a scan while the older operator-object spelling stayed fast.
     */
    const r = await recallRest({
      space: SPACE, query: 'rollout', types: ['fact'], filter: { type: { $eq: 'note' } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.filterPath, undefined,
      `an equality on a declared field pushes into the index: ${JSON.stringify(r.body).slice(0, 200)}`);
  });

  it('and the SAME filter across every kind is exhaustive, because files cannot serve `type`', async () => {
    /*
     * Pinned because it looks like a bug and is not, and because the two cases above pass `types: ['fact']`
     * for exactly this reason — a reader who noticed that would otherwise have to work out why.
     *
     * A recall with no `types` searches all five collections, and the fields an index can filter on differ
     * per collection: a file has no `type`, so its index declares only `tags`. One collection planning a
     * scan is the answer for the whole call, which is the honest aggregate — that scan is real and the
     * caller pays for it.
     *
     * The action it implies is `types`, and that is the point of disclosing it at all.
     */
    const all = await recallRest({ space: SPACE, query: 'rollout', filter: { type: 'note' } });
    assert.equal(all.status, 200, JSON.stringify(all.body).slice(0, 200));
    assert.equal(all.body.filterPath, 'exhaustive',
      `a filter on a field one collection cannot serve must report the scan: ${JSON.stringify(all.body).slice(0, 200)}`);
  });

  it('but an $or stays exhaustive, because half a filter pushed natively would be wrong', async () => {
    // The boundary of the conversion, asserted from the outside. `$or` has no `$vectorSearch` equivalent, so
    // the whole filter goes exhaustive — never partially pushed, which would restrict the candidate set
    // BEFORE scoring and silently change which records `topK` is filled from.
    const r = await recallRest({
      space: SPACE, query: 'rollout', filter: { $or: [{ type: 'note' }, { type: 'decision' }] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.filterPath, 'exhaustive',
      `an $or cannot be a native pre-filter and must say so: ${JSON.stringify(r.body).slice(0, 200)}`);
  });

  it('an unfiltered recall reports no path, rather than a misleading one', async () => {
    // Absent, and absent for a second reason: there was no filter, so neither answer is true and a plausible
    // one is worse than none — the same reason a removed gauge beats a gauge pinned at zero.
    const r = await recallRest({ space: SPACE, query: 'rollout' });
    assert.equal(r.status, 200);
    assert.equal(r.body.filterPath, undefined, 'an unfiltered recall must not claim a filter path');
  });

  it('both REST paths into recall answer with the same byte budget', async () => {
    /*
     * The defect the collapse closed, and the only half of it a caller could ever have seen.
     *
     * `POST /api/brain/recall` held four hundred lines of its own implementation; `POST /api/recall` runs
     * the tool module. The module chose MCP's 25 000-character default itself, because MCP was the only
     * door it had when it was written — so the same capability, on the same transport, answered to half
     * the budget depending on which URL the caller typed, with nothing in either response saying why.
     *
     * Asserted on the number each response REPORTS rather than on a constant here: a gate that spells the
     * budget out is a third copy of a fact the server already holds.
     */
    const args = { space: SPACE, query: 'rollout window' };
    const viaLegacy = await recallRest(args);
    const viaTool = await call('recall', args);
    assert.equal(viaLegacy.status, 200, JSON.stringify(viaLegacy.body).slice(0, 200));
    assert.equal(viaTool.status, 200, JSON.stringify(viaTool.body).slice(0, 200));

    // The tool door serialises the whole answer into `text`; the legacy route returns it as the body.
    const toolBody = JSON.parse(viaTool.body.text);
    assert.ok(viaLegacy.body.budgetChars > 0, 'the legacy route must report the budget it used');
    assert.equal(toolBody.budgetChars, viaLegacy.body.budgetChars,
      `the same capability on the same transport must not answer to two budgets: `
      + `${toolBody.budgetChars} through /api/recall against ${viaLegacy.body.budgetChars} through /api/brain/recall`);
  });

  it('the JavaScript operators are still refused, on both doors', async () => {
    for (const door of ['filter', 'recall']) {
      const args = door === 'filter'
        ? { space: SPACE, collection: 'facts', filter: { $where: 'this.fact.length > 0' } }
        : { space: SPACE, query: 'rollout', filter: { $where: 'this.fact.length > 0' } };
      const r = await call(door, args);
      assert.ok(r.status >= 400, `${door} accepted $where: ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.match(r.body.error, /\$where/, `${door}'s refusal must name the operator`);
    }
  });
});
