/**
 * `/query` answers within a size budget, like every other read path.
 *
 * ## What it had instead
 *
 * `limit` (max 100 rows) and `projection`, and nothing else. A page of file records — or a hundred entities
 * with long descriptions — had no size ceiling at all, on the one read route a fleet actually pages through.
 * Every other read path takes `maxChars`/`maxBytes`/`maxTokens` and reports what it applied.
 *
 * Owner's decision of 2026-08-30 (option C) covered this alongside the unit fix; the unit fix shipped first
 * because it corrected a defect, and this ADDS a ceiling.
 *
 * ## What that costs a caller, stated rather than discovered
 *
 * Truncation arrives on a path whose callers have never had to check for it. `count` is documented as "this
 * page", so it becomes the number actually returned and keeps matching `results.length` — a caller reading
 * either one is right. `total` still reports the whole match, so nothing that sized a sweep from it changes.
 * `truncated` and `nextSkip` are what say the page was cut and where to continue.
 *
 * ## No `remainderDump` here, deliberately
 *
 * On `recall` that flag writes the tail to a file because a ranked answer has no other continuation. `/query`
 * has REAL paging — `skip` is a database skip over a total order — so `nextSkip` is a complete answer and a
 * file would be a write on a read path that nobody needs.
 *
 * Run: node --test testing/standalone/a-query-page-has-a-size-ceiling.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const ROUTE = 'server/src/api/brain/search.ts';
const FIELDS = 'server/src/brain/query.ts';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

/** The `/query` handler, bounded by the next route registration. */
function queryHandler() {
  const body = src(ROUTE);
  const at = body.indexOf("Router.post('/filter'");
  assert.ok(at > 0, 'could not find the query route — re-point this gate');
  const rest = body.slice(at + 20);
  const next = rest.search(/Router\.(post|get|patch|delete|put)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

let QUERY_BODY_FIELDS;

describe('the query route takes a budget', () => {
  before(async () => {
    ({ QUERY_BODY_FIELDS } = await import('../../server/dist/brain/query.js'));
  });

  it('the field set is reachable (the suite cannot pass by importing nothing)', () => {
    assert.ok(QUERY_BODY_FIELDS instanceof Set && QUERY_BODY_FIELDS.size > 0);
  });

  it('accepts every budget parameter the other read routes do', async () => {
    /*
     * The body is STRICT, so a parameter absent from this set is a 400 rather than a silent drop — which is
     * the right failure, and exactly why the set has to be widened in the same change as the handler.
     *
     * The names come from `BUDGET_REQUEST_FIELDS`, in the module that owns the vocabulary. They were written
     * out here AND at three doors in `query.ts`, so a fifth budget parameter would have been accepted by
     * `resolveBudget` and refused with a 400 by three read routes, with this case reporting the old four
     * present and nothing describing the gap.
     */
    const { BUDGET_REQUEST_FIELDS } = await import('../../server/dist/brain/result-budget.js');
    // A floor of three, not four: `charsPerToken` was removed at 5.0 — it did nothing unless `maxTokens`
    // was also set. The floor exists so an empty import cannot pass the loop below, not to pin the count.
    assert.ok(BUDGET_REQUEST_FIELDS.length >= 3,
      `only ${BUDGET_REQUEST_FIELDS.length} budget field(s) — the import is stale and this loop checks little`);
    for (const k of BUDGET_REQUEST_FIELDS) {
      assert.ok(QUERY_BODY_FIELDS.has(k), `POST /filter refuses \`${k}\`, which every other read route takes`);
    }
  });

  it('and does NOT accept remainderDump, which would be a write on a read path', () => {
    /*
     * `recall` writes the tail to a file because a ranked answer has no other continuation. `/query` pages for
     * real — `skip` is a database skip over a total order — so `nextSkip` is the whole answer here. Accepting
     * the flag and ignoring it would be the silent-drop defect this route was made strict to prevent.
     */
    assert.ok(!QUERY_BODY_FIELDS.has('remainderDump'),
      'query accepts remainderDump, which it does not implement — accept it or refuse it, not both');
  });

  it('the handler resolves a budget and applies it', () => {
    const h = queryHandler();
    assert.match(h, /resolveBudget\(/, 'the query route computes no budget, so a page has no size ceiling');
    assert.match(h, /applyBudget\(/, 'a budget that is resolved and not applied is a number in a response');
  });

  it('and reports both ceilings and both figures, plus where to continue', () => {
    // Same envelope as every other budgeted response. Reporting a subset is how a caller ends up interpreting
    // an absence, which is what `budgetFields` exists to make impossible.
    assert.match(queryHandler(), /budgetFields\(/,
      'the query response assembles its own accounting fields, so they can drift from every other route\'s');
  });

  it('`budgetFields` really does report a `count`, so the strip is not decoration', async () => {
    // The behavioural half. Without it the source assertion below pins a strip whose necessity nobody has
    // checked — and a `budgetFields` that stopped reporting `count` would leave a dead destructure and a
    // green gate.
    const { budgetFields, applyBudget } = await import('../../server/dist/brain/result-budget.js');
    const outcome = applyBudget([{ a: 1 }], { chars: 1e6, bytes: null });
    const fields = budgetFields(outcome, 99, { chars: 1e6, bytes: null }, 0);
    assert.equal(fields.count, 99,
      'budgetFields no longer reports the TOTAL as `count` — if that changed deliberately, the strip in the'
      + ' query route is now dead code and should go with it');
  });

  it('and the budget accounting does not overwrite `count`', () => {
    /*
     * `count` means different things on two routes: the TOTAL on the recall paths, and the PAGE on `/query`,
     * documented that way with `total` beside it. Spreading `budgetFields` wholesale silently adopted the
     * recall meaning — a caller asking for `limit: 3` got `count: 12`, which is the fabricated-number defect
     * this route was reported for in the first place.
     *
     * CI caught it, not preflight: the case that holds it is a Docker integration suite.
     *
     * Asserted as a NAMED strip rather than by spread order, because ordering works and is one careless
     * reorder away from bringing it back.
     */
    assert.match(queryHandler(), /const \{ count: _budgetTotal, \.\.\.budgetAccounting \} = budgetFields\(/,
      'the budget accounting is spread wholesale, so `count` becomes the total and stops meaning the page');
  });

  it('the continuation is absolute, not page-relative', () => {
    /*
     * `/query` already has a real `skip`, so a `nextSkip` computed from the page alone would send a caller
     * back to the start of page two forever. `budgetFields` takes the offset for exactly this reason — the
     * bug it prevents is a paging loop that never advances, which is how `skip` came to be reported in the
     * first place.
     */
    assert.match(queryHandler(), /budgetFields\([^)]*safeSkip\)/,
      'budgetFields is called without the page offset, so nextSkip restarts the page instead of advancing');
  });
});

describe('the guide says so', () => {
  it('the accepted-field row lists the budget parameters', async () => {
    // `client-bodies-match-server.test.js` checks this table against the field set; asserted here too because
    // that gate reports the row as a whole and this one names the reason.
    const doc = readFileSync('docs/integration-guide/04d-brain-ops-api.md', 'utf8');
    const row = doc.split('\n').find(l => l.startsWith('| `POST /filter` |'));
    assert.ok(row, 'no accepted-fields row for POST /filter');
    /*
     * DERIVED from the module rather than listed, which is the whole point of `BUDGET_REQUEST_FIELDS`
     * existing. This spelled the four names out and went red when `charsPerToken` was removed — reporting
     * a documentation gap about a parameter that no longer exists.
     */
    const { BUDGET_REQUEST_FIELDS: fields } = await import('../../server/dist/brain/result-budget.js');
    for (const k of fields) {
      assert.ok(row.includes(`\`${k}\``), `the table does not list ${k} for POST /filter`);
    }
    assert.ok(!row.includes('`charsPerToken`'),
      'the table still lists charsPerToken, which is an unknown field since 5.0 — a documented parameter '
      + 'that 400s is worse than an undocumented one');
  });
});
