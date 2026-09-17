/**
 * `skip` is honoured on `POST /query`, and the four brain read routes refuse a key they cannot honour — REST and MCP.
 *
 * ## The report
 *
 * The fleet integrator, 2026-08-12T1410Z: `skip` was accepted at 200 and silently ignored, and *"it cost us a fabricated number"* —
 * a paged sweep re-read page one every time and was counted as if it had advanced.
 *
 * Two defects, and they need different fixes. Honouring `skip` is a feature; **refusing a key the route cannot honour is
 * the bug fix**, and it is the one that would have saved them the number. So this file asserts the refusal on all four
 * read routes, not the one key on the one route.
 *
 * MCP's `query` already declared `additionalProperties: false` and so already refused unknown arguments — REST was the
 * weaker of the two surfaces for the same rule. That is the pattern this codebase keeps producing, so the MCP half here
 * checks the thing MCP could still get wrong: that `skip` is offered and honoured there too, rather than becoming a
 * REST-only parameter the day after we emptied the REST-only capability map.
 *
 * ## Paging is asserted by TILING, not by "page two differs from page one"
 *
 * Two different pages can both be wrong. The assertion is that the concatenated pages equal one unpaged read exactly —
 * same ids, same order, no repeats — because a sweep that re-reads or drops a row still returns plausible pages, which is
 * precisely how the fabricated number was produced.
 *
 * Run: node --test testing/integration/query-skip-and-strict-bodies.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

const SPACE = `qskip-${RUN}`;
const M1 = `qskip-m1-${RUN}`;
const M2 = `qskip-m2-${RUN}`;
const PROXY = `qskip-proxy-${RUN}`;
const TOTAL = 12;

let token;
let session;
const created = [];

const query = (body, space = SPACE) => post(INSTANCES.a, token, '/api/brain/filter', { space: space, ...(body) });

async function makeSpace(id, body = {}) {
  const r = await post(INSTANCES.a, token, '/api/spaces', { id, label: id, ...body });
  assert.equal(r.status, 201, `space create failed: ${JSON.stringify(r.body)}`);
  created.push(id);
}

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  await makeSpace(SPACE);
  await makeSpace(M1);
  await makeSpace(M2);
  await makeSpace(PROXY, { proxyFor: [M1, M2] });

  // Sequential, so `seq` is strictly increasing and the documented order is total.
  for (let i = 0; i < TOTAL; i++) {
    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/facts`, {
      fact: `paged ${String(i).padStart(2, '0')} ${RUN}`,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  // Half in each member, so a proxy page has to interleave rather than concatenate.
  for (let i = 0; i < 6; i++) {
    for (const m of [M1, M2]) {
      await post(INSTANCES.a, token, `/api/brain/spaces/${m}/facts`, { fact: `${m} row ${i} ${RUN}` });
    }
  }
  session = await openMcpSession(token);
});

after(async () => {
  session?.close();
  for (const id of created.reverse()) {
    await delWithBody(INSTANCES.a, token, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

describe('REST: skip paginates instead of being ignored', () => {
  it('page two does not start where page one did', async () => {
    const p1 = await query({ collection: 'facts', filter: {}, limit: 5, skip: 0 });
    const p2 = await query({ collection: 'facts', filter: {}, limit: 5, skip: 5 });
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    assert.equal(p1.body.results.length, 5);
    assert.notEqual(p1.body.results[0]._id, p2.body.results[0]._id,
      'this is the reported defect: page two returned page one');
  });

  it('the pages TILE the collection — no repeats, no gaps, same order', async () => {
    const all = await query({ collection: 'facts', filter: {}, limit: 100 });
    assert.equal(all.body.results.length, TOTAL);

    const stitched = [];
    for (let s = 0; s < TOTAL; s += 5) {
      const page = await query({ collection: 'facts', filter: {}, limit: 5, skip: s });
      stitched.push(...page.body.results);
    }
    assert.deepEqual(stitched.map(d => d._id), all.body.results.map(d => d._id));
    assert.equal(new Set(stitched.map(d => d._id)).size, TOTAL);
  });

  it('echoes limit and skip, so a caller can tell what was applied', async () => {
    // The distinction the fabricated number came from: "the page I asked for" vs "what the server capped it to".
    const r = await query({ collection: 'facts', filter: {}, limit: 3, skip: 4 });
    assert.equal(r.body.limit, 3);
    assert.equal(r.body.skip, 4);
    assert.equal(r.body.count, 3);
  });

  it('a skip past the end is an empty page, not the last one', async () => {
    // Returning the tail here makes a paging loop run for ever.
    const r = await query({ collection: 'facts', filter: {}, limit: 5, skip: TOTAL + 50 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results, []);
  });

  it('refuses a negative or fractional skip rather than reading it as 0', async () => {
    for (const bad of [-1, 1.5, '3', null]) {
      const r = await query({ collection: 'facts', filter: {}, skip: bad });
      assert.equal(r.status, 400, `skip=${JSON.stringify(bad)} was accepted: ${JSON.stringify(r.body)}`);
    }
  });

  it('pages a PROXY space over the merged set, not per member', async () => {
    // The compounding defect: asking each member for [skip, skip+limit) and concatenating skips that many rows PER
    // MEMBER and orders the result by member. Twelve rows across two members must page exactly like twelve in one.
    const all = await query({ collection: 'facts', filter: {}, limit: 100 }, PROXY);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.results.length, 12, 'both members are read');

    const stitched = [];
    for (let s = 0; s < 12; s += 4) {
      const page = await query({ collection: 'facts', filter: {}, limit: 4, skip: s }, PROXY);
      assert.ok(page.body.results.length <= 4,
        `a proxy page returned ${page.body.results.length} rows for limit 4 — the limit is per member, not per page`);
      stitched.push(...page.body.results);
    }
    assert.equal(new Set(stitched.map(d => d._id)).size, 12, 'every row exactly once across the proxy pages');
    assert.deepEqual(stitched.map(d => d._id), all.body.results.map(d => d._id),
      'and in the same order as the unpaged read');
  });
});

describe('REST: the four read routes refuse a key they cannot honour', () => {
  const cases = [
    // `orderBy`, not `sort`: this case originally used `sort` when it was unimplemented, and became a false alarm the day
    // it shipped. A plausible ALIAS is the better test anyway — it is what a caller actually reaches for, and it is the
    // one that would otherwise be accepted and ignored.
    ['/filter', { collection: 'facts', filter: {}, orderBy: 'seq' }, 'orderBy'],
    ['/recall', { query: 'anything', topk: 5 }, 'topk'],
    ['/traverse', { startId: '00000000-0000-4000-8000-000000000000', depth: 2 }, 'depth'],
    ['/similar', { entryId: '00000000-0000-4000-8000-000000000000', entryType: 'fact', limit: 5 }, 'limit'],
  ];

  for (const [route, body, offender] of cases) {
    it(`${route} names the unknown key '${offender}' in a 400`, async () => {
      // Naming it matters: `{"error":"unknown field"}` sends a caller reading their own request to find which one, and
      // the entire value of refusing is to shorten that search to zero.
      // THREE of the four moved off the space path at 5.0 and take `space` in the body; `traverse` did not,
      // because it walks FROM an entity and an entity lives in exactly one space. Building the URL from a
      // variable is why the bulk rewriter could not see this site — it matched a literal path.
      const moved = route !== '/traverse';
      const url = moved ? `/api/brain${route}` : `/api/brain/spaces/${SPACE}${route}`;
      const r = await post(INSTANCES.a, token, url, moved ? { space: SPACE, ...body } : body);
      assert.equal(r.status, 400, `${route} accepted '${offender}': ${JSON.stringify(r.body)}`);
      assert.ok(JSON.stringify(r.body).includes(offender), `the 400 must name '${offender}': ${JSON.stringify(r.body)}`);
      /*
       * `unrecognized_keys` comes from `unknownBodyFields`, which a route uses when it parses its own body.
       * `/recall` stopped doing that at 5.0 — it hands its body to `callTool`, whose schema validation
       * refuses the key and names it in the message. The machine-readable list is not produced there, and
       * synthesising one by parsing the prose would be worse than not having it.
       *
       * The claim above survives either way and is the one with the value in it: the refusal NAMES the
       * offending key, which is what shortens the caller's search to zero. The array is asserted only where
       * the route still builds it, so this case cannot pass by the field quietly disappearing everywhere.
       */
      if (route === '/recall') {
        assert.match(r.body.error, /unexpected property 'topk'/,
          'the shared dispatcher must name the key it refused');
      } else {
        assert.deepEqual(r.body.unrecognized_keys, [offender]);
      }
    });
  }

  it('still accepts every documented key on /query', async () => {
    // The other half of strictness, and the one that breaks callers if it is wrong.
    const r = await query({
      collection: 'facts', filter: {}, projection: { fact: 1 }, limit: 2, skip: 1, maxTimeMS: 3000,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('still accepts the DEPRECATED crossSpace on find-similar', async () => {
    // Refusing a key we deprecated but still accept elsewhere would be a worse contract than the permissive body this
    // replaces: we told callers to stop using it, not that it would start erroring.
    const r = await post(INSTANCES.a, token, '/api/brain/similar', { space: SPACE, ...({
      entryId: '00000000-0000-4000-8000-000000000000', entryType: 'fact', crossSpace: false,
    }) });
    assert.notEqual(r.status, 400, `crossSpace was refused: ${JSON.stringify(r.body)}`);
  });
});

describe('MCP: query offers skip too, rather than it becoming REST-only', () => {
  it('advertises skip in the tool schema', async () => {
    const tool = (await session.listTools()).find(t => t.name === 'filter');
    assert.ok(tool, 'query tool missing');
    assert.ok(tool.inputSchema.properties.skip,
      'skip must be on the MCP schema as well — a parameter added to REST alone is how the capability map filled up');
  });

  it('honours it, and the pages tile', async () => {
    const call = (args) => session.callTool('filter', { space: SPACE, collection: 'facts', filter: {}, ...args });
    const all = JSON.parse((await call({ limit: 100 })).content[0].text);
    assert.equal(all.length, TOTAL);

    const stitched = [];
    for (let s = 0; s < TOTAL; s += 5) {
      stitched.push(...JSON.parse((await call({ limit: 5, skip: s })).content[0].text));
    }
    assert.deepEqual(stitched.map(d => d._id), all.map(d => d._id), 'MCP pages must tile exactly as REST does');
  });

  it('refuses a fractional skip', async () => {
    const r = await session.callTool('filter', { space: SPACE, collection: 'facts', filter: {}, skip: 1.5 });
    assert.ok(r?.isError, `a fractional skip was accepted: ${JSON.stringify(r)}`);
  });

  it('already refused unknown arguments, and still does', async () => {
    // `additionalProperties: false` was always there. Asserted so that a future relaxation of the schema shows up here
    // rather than as a silently ignored argument, which is the REST defect arriving on the other surface.
    const r = await session.callTool('filter', { space: SPACE, collection: 'facts', filter: {}, sort: { seq: 1 } });
    assert.ok(r?.isError, `MCP accepted an unknown argument: ${JSON.stringify(r)}`);
  });
});

describe('the match TOTAL and a caller-chosen order, on both surfaces', () => {
  it('REST reports total separately from the page count', async () => {
    // The number the fleet integrator had to fabricate: `count` is the page, `total` is the match. Without the second one a sweep
    // cannot tell a short last page from a truncated one except by making a request that returns nothing.
    const r = await query({ collection: 'facts', filter: {}, limit: 5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.count, 5, 'count is the page');
    assert.equal(r.body.total, TOTAL, 'total is every match');
  });

  it('total is unaffected by skip', async () => {
    const r = await query({ collection: 'facts', filter: {}, limit: 3, skip: 9 });
    assert.equal(r.body.total, TOTAL);
    assert.equal(r.body.count, 3);
  });

  it('total respects the filter', async () => {
    const r = await query({ collection: 'facts', filter: { fact: `paged 00 ${RUN}` } });
    assert.equal(r.body.total, 1, JSON.stringify(r.body));
  });

  it('REST orders by a chosen field and echoes it', async () => {
    const r = await query({ collection: 'facts', filter: {}, sort: 'createdAt', dir: 'asc', limit: 100 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sort, 'createdAt');
    assert.equal(r.body.dir, 'asc');
    const times = r.body.results.map(d => d.createdAt);
    assert.deepEqual(times, [...times].sort(), 'ascending must actually be ascending');
  });

  it('refuses an unsortable field and NAMES the sortable ones', async () => {
    // The same allowlist and the same message the brain list endpoints give, so a caller who knows one knows the other.
    const r = await query({ collection: 'facts', filter: {}, sort: 'fact' });
    assert.equal(r.status, 400, `sorting by an unlisted field was accepted: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /Sortable fields/);
  });

  it('refuses a bad dir', async () => {
    const r = await query({ collection: 'facts', filter: {}, sort: 'createdAt', dir: 'sideways' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('pages a custom order on a PROXY space in that order', async () => {
    // The comparator is built from the sort handed to Mongo. Hardcoded to the default keys it would merge the members by
    // the wrong order and return a page nobody asked for -- with a 200.
    const all = await query({ collection: 'facts', filter: {}, sort: 'createdAt', dir: 'asc', limit: 100 }, PROXY);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const times = all.body.results.map(d => d.createdAt);
    assert.deepEqual(times, [...times].sort(), 'a proxy page must honour the caller order across members');
    assert.equal(all.body.total, 12, 'and the total sums both members');
  });

  it('MCP carries the same total and takes the same sort', async () => {
    const r = await session.callTool('filter', {
      space: SPACE, collection: 'facts', filter: {}, limit: 4, sort: 'createdAt', dir: 'asc',
    });
    assert.ok(!r?.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.total, TOTAL, 'the total must be on the MCP surface too, not REST-only');
    assert.equal(r.structuredContent.count, 4);
    assert.equal(r.structuredContent.sort, 'createdAt');
    const times = JSON.parse(r.content[0].text).map(d => d.createdAt);
    assert.deepEqual(times, [...times].sort());
  });

  it('the ROWS are in structuredContent, not only in content', async () => {
    // A client that surfaces structuredContent in preference to content used to see
    // `{count, total, limit, skip}` and not one row — observed against Claude Code, four calls in a row,
    // while a tool returning no structuredContent rendered its whole body in the same session. That is the
    // worst shape available: the answer is absent while the metadata reports how many rows were returned,
    // so it reads as a thin page rather than as a dropped payload.
    const r = await session.callTool('filter', { space: SPACE, collection: 'facts', filter: {}, limit: 3 });
    assert.ok(!r?.isError, JSON.stringify(r));
    assert.ok(Array.isArray(r.structuredContent.results), 'structuredContent carries no rows at all');
    assert.equal(r.structuredContent.results.length, r.structuredContent.count,
      'count must describe the rows beside it, not rows the caller cannot see');
    // And the two views must be the same answer, or a caller gets a different result per client.
    assert.deepEqual(r.structuredContent.results, JSON.parse(r.content[0].text));
  });

  it('MCP refuses an unsortable field with the same message', async () => {
    const r = await session.callTool('filter', { space: SPACE, collection: 'facts', filter: {}, sort: 'fact' });
    assert.ok(r?.isError, `MCP accepted an unlisted sort field: ${JSON.stringify(r)}`);
    assert.match(JSON.stringify(r), /Sortable fields/);
  });
});

describe('paging PAST the window — the defect 2.8.0 shipped', () => {
  // The route fetched a window capped at 100 and then sliced it at `skip`, so every page past row 100 came back EMPTY
  // while `total` reported the true count. A caller sweeping a large collection stopped silently at 100.
  //
  // This has to run through HTTP. The same assertion against `queryBrain` directly PASSES on the broken code, because
  // that function pushes `skip` to MongoDB and is correct at any depth — the window only ever existed in the route. I
  // wrote that version first and the mutation test is what showed it guarded nothing.
  const DEEP = `qdeep-${RUN}`;
  const N = 120;

  before(async () => {
    await makeSpace(DEEP);
    for (let i = 0; i < N; i++) {
      const r = await post(INSTANCES.a, token, `/api/brain/spaces/${DEEP}/facts`, {
        fact: `deep ${String(i).padStart(3, '0')} ${RUN}`,
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
  });

  const q = (body) => post(INSTANCES.a, token, '/api/brain/filter', { space: DEEP, ...(body) });

  it('reports the real total', async () => {
    const r = await q({ collection: 'facts', filter: {}, limit: 5 });
    assert.equal(r.body.total, N, 'the total must be the whole match, which is what made the empty pages contradictory');
  });

  it('returns rows past row 100', async () => {
    for (const skip of [95, 100, 105, 119]) {
      const r = await q({ collection: 'facts', filter: {}, limit: 5, skip });
      assert.ok(r.body.results.length > 0,
        `skip=${skip} returned nothing on a ${N}-row collection while total says ${r.body.total}`);
    }
  });

  it('still tiles exactly across the boundary — no repeats, no gaps', async () => {
    // A deep page that returns SOMETHING is not enough: it has to return the right something. 120 rows in pages of 25
    // crosses the old window twice.
    const seen = [];
    for (let skip = 0; skip < N; skip += 25) {
      const r = await q({ collection: 'facts', filter: {}, limit: 25, skip });
      seen.push(...r.body.results.map(d => d._id));
    }
    assert.equal(seen.length, N, `expected ${N} rows across the pages, got ${seen.length}`);
    assert.equal(new Set(seen).size, N, 'every row exactly once');
  });

  it('past the END is still empty, so a paging loop terminates', async () => {
    const r = await q({ collection: 'facts', filter: {}, limit: 5, skip: N });
    assert.deepEqual(r.body.results, []);
    assert.equal(r.body.total, N, 'and the total still tells the caller where the end was');
  });

  it('HONOURS a page larger than the old cap, rather than clamping it silently', async () => {
    /*
     * INVERTED AT 5.0, deliberately. This case used to assert the clamp — `limit: 500` came back as
     * 100 rows with `limit: 100` echoed — on the reasoning that echoing the applied value tells the
     * caller it was clamped. It does not: `total` and `truncated` make a clamped page read exactly
     * like a correct short one, and `filter` is replacing list routes that serve 200 and 500.
     *
     * Owner, 2026-09-17: *"cap should be a parameter and default to 200"*. So the assertion is that
     * the caller gets what they asked for, against a space holding 120 real rows through HTTP —
     * which the old code could not have answered, since it stopped at 100.
     */
    const r = await q({ collection: 'facts', filter: {}, limit: 500 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.results.length, N,
      `asked for 500 over ${N} rows and got ${r.body.results.length} — the clamp is back`);
    assert.equal(r.body.limit, 500, 'the applied limit is echoed, and it is the one that was asked for');
    assert.equal(r.body.truncated, false, 'the whole collection fits, so nothing was trimmed');
  });

  it('and an omitted `limit` defaults to 200, not 20', async () => {
    // The other half of the owner's instruction. A default that is smaller than any door it replaces
    // makes a caller page for no reason.
    const r = await q({ collection: 'facts', filter: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.limit, 200, 'the default page size is 200 on this door');
    assert.equal(r.body.results.length, N, 'and 120 rows fit inside it');
  });
});
