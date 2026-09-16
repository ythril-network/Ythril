/**
 * Sync REPORTS a schema mismatch and REFUSES a record nobody could read. Those are different things.
 *
 * ## What it was
 *
 * Five ingest paths in `api/sync/docs.ts`, and exactly **one** schema check between them: the chrono type
 * allowlist on the single-record route. Which was wrong twice over — it covered one field of one record type,
 * and it sat on the path a peer barely uses, because a sync cycle ships records through `batch-upsert`. That
 * path checked nothing at all.
 *
 * And the one check that existed **refused**, with a `400`.
 *
 * ## Why refusing is the wrong answer here specifically
 *
 * Owner's ruling, 2026-08-29 (P-21 = C). A peer validated these records against ITS schema, which may differ
 * from the receiver's — so a refusal discards data the sender believes it delivered, on the receiver's opinion
 * of rules the sender never agreed to. Validate, accept, and report.
 *
 * ## The count is not decoration
 *
 * The ruling's stated cost was that a report nobody reads is the do-nothing option with extra steps. So this
 * asserts the violations reach the CALLER, not a log line — `schemaViolations` on each per-type stat, and beside
 * the document on the single-record route.
 *
 * Run: node --test testing/standalone/sync-reports-schema-mismatch-and-refuses-nonsense.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, statementAround } from './_structural-window.mjs';

const DOCS = 'server/src/api/sync/docs.ts';
const SHARED = 'server/src/api/sync/_shared.ts';
const docs = stripComments(readFileSync(DOCS, 'utf8'));
const shared = stripComments(readFileSync(SHARED, 'utf8'));

const TYPES = ['fact', 'entity', 'edge', 'chrono'];

describe('sync reports a schema mismatch and refuses nonsense', () => {
  it('one helper answers for every record type', () => {
    // A per-type copy is how the old single check drifted into being the only one. The helper must cover all
    // four, or the next type added quietly gets nothing.
    assert.match(shared, /export function violationsAgainstLocalSchema/, 'no shared validation helper');
    for (const t of TYPES) {
      assert.match(
        shared, new RegExp(`case '${t}'`),
        `the helper does not handle '${t}', so that type ingests unchecked`,
      );
    }
  });

  it('every batch loop checks what it is about to store', () => {
    for (const t of TYPES) {
      assert.match(
        docs, new RegExp(`violationsAgainstLocalSchema\\(spaceId, '${t}'`),
        `batch-upsert stores '${t}' records without checking them. This is the path a real peer uses — a sync `
        + 'cycle ships records in batches — so a check that skips it protects almost nothing.',
      );
    }
  });

  it('every per-type stat that CAN carry a violation count does', () => {
    /*
     * Named per stat rather than counted. A first version asserted "at least five mentions of
     * schemaViolations" and SURVIVED its own mutant — deleting the single-record route's report left four,
     * which still cleared the bar. A total says nothing about which one went missing.
     *
     * ## And the list was hard-coded at four when there are six (`Q-5`)
     *
     * This read `['memStats', 'entStats', 'edgeStats', 'chronoStats']` under the title *"every per-type
     * stat"*. `linkStats` and `fileMetaStats` exist and were in neither, so the title was a claim about the
     * whole set made by a loop over two thirds of it — the shape `CLAUDE.md` now has a section for.
     *
     * **Both omissions are correct, and that is exactly why they have to be stated.** A schema violation is
     * measured against a type schema, and neither of those two records has a type to look one up by: a link
     * is a pair of ids and a label, and a FILE has no `type` at all, which is the same fact that gives a
     * file two suppression tiers rather than three. Absent from a hand-written list that reads as an
     * oversight; declared as an exemption it reads as the decision it is — and the day either gains a type,
     * this goes red instead of staying silent.
     */
    const NO_TYPE_SCHEMA = new Set([
      // A link is a pair of ids and a label. There is no type to validate against.
      'linkStats',
      // A file has no `type` field, so there is no per-type schema for it to violate.
      'fileMetaStats',
    ]);

    const found = [...docs.matchAll(/const ([a-zA-Z]+Stats) = \{/g)].map(m => m[1]);
    assert.ok(found.length >= 6,
      `only ${found.length} per-type stat objects found in the ingest router (${found.join(', ') || 'none'}) — `
      + 're-anchor this gate rather than trusting the sweep below');

    for (const stat of found) {
      const at = docs.indexOf(`const ${stat} = {`);
      const decl = docs.slice(at, docs.indexOf('\n', at));
      if (NO_TYPE_SCHEMA.has(stat)) {
        assert.doesNotMatch(decl, /schemaViolations/,
          `${stat} now carries a violation count, but its record type has no type schema to violate. Either `
          + 'that changed — in which case remove it from NO_TYPE_SCHEMA — or the field is a counter that can '
          + 'only ever read zero.');
        continue;
      }
      assert.match(
        decl, /schemaViolations/,
        `${stat} does not carry a violation count, so what it skipped never reaches the caller`,
      );
    }
  });

  it('EVERY single-record route reports what it accepted out of shape', () => {
    /*
     * Windowed on `/chrono` alone at first, which is how three of the four shipped without the check.
     *
     * The narrow window was not merely incomplete — it was **shaped like the bug**. `/chrono` was the route
     * that used to answer 400, so it was the one on my mind while writing both the fix and the gate; the other
     * three stored the peer's record and answered `{ status: 'ok' }` with nothing computed, and no assertion
     * looked at them. A gate that inspects only the route you were already thinking about cannot tell you
     * about the ones you were not.
     *
     * So the routes are ENUMERATED from source. A sixth ingest route added later is covered on the commit
     * that adds it, rather than when someone remembers to widen a slice.
     */
    const routes = [...docs.matchAll(/syncDocsRouter\.post\('\/([\w-]+)'/g)]
      .map(m => ({ name: m[1], at: m.index }))
      .filter(r => r.name !== 'batch-upsert');       // the batch path is covered by the per-type stats below
    assert.ok(
      routes.length >= 4,
      `expected the four single-record ingest routes, found ${routes.map(r => r.name).join(', ') || 'none'}`,
    );

    const silent = [];
    for (const [i, r] of routes.entries()) {
      // Bounded by the NEXT route registration, whichever it is — not by one hardcoded successor, which is a
      // fixed slice wearing a structural disguise and breaks the moment the routes are reordered.
      const next = routes[i + 1]?.at ?? docs.indexOf("syncDocsRouter.post('/batch-upsert'");
      const body = docs.slice(r.at, next > r.at ? next : docs.length);
      if (!/withSchemaViolations\(/.test(body)) silent.push(`/${r.name}`);
    }
    assert.deepEqual(
      silent, [],
      'These single-record ingest routes store a peer record and say nothing about whether it fits the local '
      + 'schema, while the SAME records through `batch-upsert` are counted. One rule, two implementations, the '
      + 'weaker one winning silently — and a peer that ships records one at a time gets the weaker one.',
    );
  });

  it('the report is attached by one shared helper, not spelled out per route', () => {
    // Four inline spreads is what produced the split above: the rule existed four times and was written once.
    // A route hand-rolling the ternary again is the regression, and it reads as perfectly reasonable code.
    assert.doesNotMatch(
      docs, /\.\.\.\([\w]*[Vv]iolations\.length > 0 \?/,
      'a route is spelling out the attach-if-non-empty rule inline again — use withSchemaViolations()',
    );
    const shared = stripComments(readFileSync('server/src/api/sync/_shared.ts', 'utf8'));
    assert.match(shared, /export function withSchemaViolations/, 'the helper must exist in _shared.ts');
    // The helper's own body, not a capped gap after a marker. A character cap here would be a guess at how
    // much of the function fits, and it can only make the check see less as the helper grows —
    // `gates-bound-their-subject-structurally` refuses one, and counts them on the RAW source deliberately,
    // so even naming the shape in a comment costs an allowance. Bounded by the declaration instead.
    const body = bodyOf(shared, 'withSchemaViolations');
    assert.match(
      body, /violations\.length > 0 \?/,
      'the helper must omit the field when there are no violations, so a clean ingest keeps its response '
      + 'byte for byte and a present `schemaViolations` always means something to look at',
    );
    assert.match(body, /schemaViolations: violations/, 'and must attach the violations when there are some');
  });

  it('a PROPERTY mismatch is counted, never refused', () => {
    /*
     * The distinction this file exists for, and the one I got wrong first: a property that breaks the local
     * schema is a DISAGREEMENT between two instances' rules, and the sender validated against its own. Refusing
     * discards data over an opinion the sender never agreed to — so it is counted and kept.
     */
    /*
     * EVERY per-collection stats block the ingest declares, swept rather than named.
     *
     * Four were named and there are six. The other two are exempt for a reason that is a fact about the
     * records rather than an oversight: a LINK is a pair of ids, and a FILE's metadata has no type schema —
     * neither can violate one. Named here with that reason, so a seventh block has to decide which it is
     * instead of being quietly outside a list.
     */
    const NO_SCHEMA = {
      linkStats: 'a link is a pair of ids — there is no type schema for it to violate',
      fileMetaStats: 'a file has no type, so no type schema, so nothing to count',
    };
    const blocks = [...docs.matchAll(/const (\w+Stats) = \{/g)].map(m => m[1]);
    assert.ok(blocks.length >= 6, `only ${blocks.length} stats block(s) found — the sweep is wrong, not the code`);
    for (const stat of blocks) {
      const at = docs.indexOf(`const ${stat} = {`);
      const decl = docs.slice(at, docs.indexOf('\n', at));
      if (stat in NO_SCHEMA) {
        assert.doesNotMatch(decl, /schemaViolations/,
          `${stat} counts schema violations, and ${NO_SCHEMA[stat]} — so the count can only ever read zero, `
          + 'which an operator reads as "no disagreements here"');
        continue;
      }
      assert.match(decl, /schemaViolations/, `${stat} must COUNT the mismatch`);
    }
    /*
     * Every 400 in the file is inspected, rather than a capped window after the helper call. A
     * `doesNotMatch` over a fixed character budget passes by looking at LESS, which is the failure direction
     * that makes a negative assertion worthless — and this repo has a gate refusing the shape outright.
     */
    let at = docs.indexOf('res.status(400)');
    while (at !== -1) {
      const stmt = statementAround(docs, at, 'a 400 statement');
      assert.doesNotMatch(
        stmt, /violationsAgainstLocalSchema|schemaViolations/,
        "a property mismatch must never produce a 400 — that is the receiver overruling the sender's own "
        + `schema, which the sender never agreed to.

${stmt}`,
      );
      at = docs.indexOf('res.status(400)', at + 1);
    }
  });

  it('a chrono type nobody understands IS refused, on BOTH paths', () => {
    /*
     * Not the same thing. A `type` outside the product's vocabulary AND outside anything the space declared is
     * not non-conforming, it is meaningless to every reader — and `IncomingChronoDoc` types the field as any
     * non-empty string, so nothing else would catch it. I removed this check with the property one and CI
     * caught it; that over-correction is what this assertion prevents repeating.
     *
     * On BOTH paths is the W-4 defect: the rule existed only on the single-record route, while the batch route
     * is what a real peer uses.
     */
    const single = docs.slice(docs.indexOf("syncDocsRouter.post('/chrono'"), docs.indexOf("syncDocsRouter.post('/batch-upsert'"));
    assert.match(single, /getAllowedChronoTypes/, 'the single-record route lost its vocabulary check');
    assert.match(single, /res\.status\(400\)/, 'an unreadable type must still be refused');

    const batch = docs.slice(docs.indexOf("syncDocsRouter.post('/batch-upsert'"));
    assert.match(
      batch, /allowedChronoTypes/,
      'the batch route does not check the chrono vocabulary, so the rule applies only on the path a peer '
      + 'barely uses — which is exactly the defect W-4 recorded',
    );
    assert.match(
      batch, /unknownType/,
      'the batch route must COUNT what it skipped rather than dropping it silently; a 400 there would abandon '
      + 'every other record in the batch',
    );
  });
});
