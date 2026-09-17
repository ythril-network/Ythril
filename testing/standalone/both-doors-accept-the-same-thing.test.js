/**
 * Where the two doors differ, the difference is the NARROWING — not the vocabulary, and not an omission.
 *
 * `CLAUDE.md`'s first rule: MCP and REST are one API with two doors, taking the same parameters, defaults,
 * caps, refusals and error text. The guideline audit found seven places where one door quietly accepted less
 * than the other, or described something neither door does. This gate holds each of them.
 *
 * ## The one that made a parameter inert
 *
 * `includeFreshWrites` exists for one purpose: find the record you just wrote, before the vector index has
 * it. It was forwarded only on the space-scoped branch. Omitting `space` — which the tool's own text
 * promotes, and which `saveFact` and `write_file` both point callers at after a write — took the
 * cross-space path, where the option was dropped and the underlying call had no such field. A 200, and the
 * flag did nothing.
 *
 * The existing test could not see it: it drives REST, where the space is in the path and the branch cannot
 * be reached.
 *
 * ## The one that returns fewer records than it was asked for
 *
 * `minScore` was applied AFTER the cut to `topK`, so `topK: 10, minScore: 0.7` could return three while
 * forty records cleared the threshold — the window was chosen from the unfiltered ranking and then thinned.
 * `similar` applies it inside its selection loop, so the same parameter behaved differently on two
 * tools, and the guide documented the `similar` behaviour for both.
 *
 * ## And the shape that recurs: a refusal one door states and the other does not
 *
 * Same cap, two behaviours is worse than either alone, because it makes the answer depend on which client
 * the caller happened to pick. `CLAUDE.md` says so in as many words.
 *
 * Run: node --test testing/standalone/both-doors-accept-the-same-thing.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { statementAround } from './_structural-window.mjs';

const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types-knowledge.js');

const MCP_SEARCH = 'server/src/mcp/tools/search.ts';
const REST_SEARCH = 'server/src/api/brain/search.ts';
const RECALL = 'server/src/brain/recall.ts';
const SHAPE = 'server/src/brain/recall-shape.ts';
const CHRONO = 'server/src/mcp/tools/chrono.ts';
const HELP = 'server/src/mcp/tools/help-sections.ts';
const I18N = 'client/public/assets/i18n/en.json';
const code = (f) => stripComments(readFileSync(f, 'utf8'));

describe('the cross-space branch forwards every option the space-scoped one does', () => {
  /*
   * WHAT THIS USED TO BE, and why the rule outlived its example.
   *
   * It asserted that `includeFreshWrites` reached the `recallGlobal(` call. That parameter is gone — the
   * scan it gated runs on every recall since 5.0 — but the defect it was written for is structural and
   * still live: `recallGlobal` spreads `opts` into each per-space call, so a field its signature does not
   * declare is silently dropped on the cross-space branch while working perfectly on the single-space one.
   *
   * And the cross-space branch is the one a caller takes by OMITTING `space`, which is the form this tool's
   * own first paragraph promotes. So the wrong half is the half most people use, and it answers 200.
   *
   * The rule, derived rather than exemplified: the two calls pass the same option keys, and `recallGlobal`
   * declares every key it is passed.
   */
  /**
   * The keys of the OPTIONS literal — the last `{…}` in the call, which is where `opts` always sits.
   *
   * Anchored on the last brace rather than on a neighbouring word. The first version started at the first
   * `{` after `filter`, and the space-scoped call is inside a `.map(mid => recall(…))`, so it found a brace
   * belonging to the arrow function and parsed one key. A gate that reports "the parser is stale" about
   * correct code is the failure this whole file is about, one level up.
   */
  const optionKeys = (call) => {
    const open = call.lastIndexOf('{');
    if (open < 0) return new Set();
    let depth = 0;
    const keys = new Set();
    for (let i = open; i < call.length; i++) {
      const c = call[i];
      if (c === '{') depth++;
      else if (c === '}') { if (--depth === 0) break; }
      else if (depth === 1 && /[a-zA-Z]/.test(c)) {
        /*
         * Only at the START of a property — the preceding non-space character is `{` or `,`.
         *
         * Without that test, `maxTimeMS: recallMaxTimeMS` contributes BOTH names: the scan resumes on the
         * value and `recallMaxTimeMS` matches the same pattern. It was then reported as an option
         * `recallGlobal` does not accept, which is a finding about a variable name.
         */
        const before = call.slice(open, i).trimEnd().slice(-1);
        if (before !== '{' && before !== ',') continue;
        const m = /^([a-zA-Z][a-zA-Z0-9]*)\s*[,:}]/.exec(call.slice(i));
        // A bare `{ maxPerType, … }` shorthand counts as passing that key, same as `maxPerType: x`.
        if (m) { keys.add(m[1]); i += m[1].length - 1; }
      }
    }
    return keys;
  };

  it('both recall calls in the tool pass the same options', () => {
    const src = code(MCP_SEARCH);
    const scoped = src.indexOf('recall(mid,');
    const global = src.indexOf('recallGlobal(');
    assert.ok(scoped > 0 && global > 0, 'one of the two recall calls is gone — re-point this gate');
    const a = optionKeys(src.slice(scoped, src.indexOf(');', scoped) + 2));
    const b = optionKeys(src.slice(global, src.indexOf(');', global) + 2));
    assert.ok(a.size >= 3, `parsed only ${a.size} options off the space-scoped call — the parser is stale`);
    assert.deepEqual([...a].filter(k => !b.has(k)), [],
      'the cross-space branch drops an option the space-scoped one passes, so it does nothing on the '
      + 'idiomatic MCP call — omitting `space` is the form the tool promotes');
  });

  it('and recallGlobal DECLARES every one of them, so forwarding is not a silent drop', () => {
    const src = code(RECALL);
    const at = src.indexOf('export async function recallGlobal');
    assert.ok(at > 0, 'recallGlobal is gone — re-point this gate');
    const sig = src.slice(at, src.indexOf('): Promise', at));
    const mcp = code(MCP_SEARCH);
    const global = mcp.indexOf('recallGlobal(');
    const passed = optionKeys(mcp.slice(global, mcp.indexOf(');', global) + 2));
    // `\\b` and `\\s`, doubled: inside a template literal a single `\b` is a BACKSPACE character, so the
    // first version built a regex that could never match and reported every option as undeclared.
    const undeclared = [...passed].filter(k => !new RegExp(`\\b${k}\\s*[?:]`).test(sig));
    assert.deepEqual(undeclared, [],
      `recallGlobal does not accept ${undeclared.join(', ')}, so forwarding drops it on the floor`);
  });
});

describe('minScore is applied before the cut to topK, not after', () => {
  it('the threshold filters the ranked set, not the already-truncated window', () => {
    /*
     * `final.filter(r => (r.score ?? 0) >= minScore)` ran on a list already sliced to `topK`. The fix has to
     * thin BEFORE the slice, so `topK` is filled from records that clear the threshold — the same guarantee
     * `filter` already makes and states.
     */
    const src = code(SHAPE);
    assert.doesNotMatch(src, /final\s*\.?\s*filter\(r => \(r\.score \?\? 0\) >= minScore\)/,
      'minScore still thins the window after it was chosen, so a filtered recall returns fewer records than '
      + 'it could — ask the same question of the ranked set instead');
  });
});

describe('the parity gaps, one case each', () => {
  it('minPerType is validated on MCP like the maxPerType beside it', () => {
    // Its schema admitted a negative and a fraction while `maxPerType` on the next line declared `minimum: 1`
    // — an omission rather than a policy, and REST 400s on both.
    const src = code(MCP_SEARCH);
    const at = src.indexOf('minPerType: {');
    assert.ok(at > 0, 'minPerType is gone from the MCP schema — re-point this gate');
    const block = src.slice(at, src.indexOf('}', src.indexOf('additionalProperties', at)) + 1);
    assert.match(block, /minimum: 0/, 'the MCP schema must refuse a negative floor, as REST does');
  });

  it('topK has no ceiling on EITHER door, and the work it drives has one', () => {
    /*
     * Owner's ruling on `P-34`, 2026-09-04: *"why do we need a cap? Only thing that matters is we only get
     * full records and it warns when anything is truncated … And yes same treatment at both doors."*
     *
     * Both premises were checked rather than taken: `applyBudget` emits whole records only, and `truncated`
     * is on every response whether it bit or not, with `nextSkip` when it did. So the ANSWER never needed a
     * cap — REST clamped silently to 100 while MCP declared none, which is the worst of the three options
     * because the caller is told nothing and believes they have the top 500.
     *
     * What a cap did bound is WORK, and that bound now lives where the work is rather than on the request.
     * Asserting both halves: a ceiling reappearing on either door is the divergence returning, and a
     * per-type fetch or graph walk that scales without its own limit is an oversized request becoming an
     * oversized query.
     */
    assert.doesNotMatch(code(REST_SEARCH), /Math\.min\(Math\.max\(topK, 1\), 100\)/,
      'REST clamps topK again, silently, while the other door does not');
    /*
     * `statementAround` rather than a character window. My first version read 120 characters past the
     * property name, and `gates-bound-their-subject-structurally` refused it — the same ratchet I widened
     * this morning, applied to me. A property declaration is a statement, so that is the bound.
     */
    const mcp = code(MCP_SEARCH);
    const at = mcp.indexOf("name: 'recall'");
    const topK = statementAround(mcp, mcp.indexOf('topK:', at), "recall's topK declaration");
    assert.doesNotMatch(topK, /maximum:/, 'MCP declares a ceiling REST does not apply');

    assert.match(code('server/src/brain/recall.ts'), /MAX_PER_TYPE_CANDIDATES/,
      'the per-type over-fetch scales with topK and has no absolute bound');
    assert.match(code(REST_SEARCH), /MAX_GRAPH_NODES/,
      'the graph walk scales with topK and has no absolute bound');
  });

  it('and the FORM is not the narrowest door of the three', () => {
    /*
     * Found by walking the five places rather than the two: `topK` had a THIRD gatekeeper, the number input
     * on the recall form, carrying `max="100"`. Removing the cap from both APIs and leaving it there is the
     * same divergence one layer out — an operator is told 100 is the limit while a script beside them asks
     * for 500 and gets it. The browser silently refuses the submit, so nothing reports it.
     */
    const form = code('client/src/app/pages/brain/recall-form.component.ts');
    const at = form.indexOf('name="recallTopK"');
    assert.ok(at > 0, 'the topK input is gone — re-point this gate');
    const input = form.slice(form.lastIndexOf('<input', at), form.indexOf('/>', at) + 2);
    assert.doesNotMatch(input, /max=/,
      'the recall form caps topK while neither API door does, so the UI is the narrowest way in');
  });
  /*
   * The case that WAS here demanded `maximum: 100` on MCP, and the reason it is gone is a correction to my
   * own reasoning.
   *
   * REST clamps it to 100 silently and this door declares no maximum at all, saying "no hard cap" — a
   * real divergence. I wrote a case demanding `maximum: 100` on the strength of `similar` capping on
   * both doors. It does not: `similar` REFUSES on MCP and CLAMPS on REST, so it is the same split one
   * tool along rather than the precedent that settles this one.
   *
   * Aligning it removes a capability whichever way it goes — refusing breaks an MCP caller passing more
   * than 100 today, clamping narrows one silently — so it is the owner's, parked as `P-34`. A gate that
   * pinned my guess would have made a product decision look like a fixed defect.
   */
  it('the query collection refusal names every collection there is', () => {
    // MCP hardcoded five while the enum admits six, so a mistyped call was handed a list excluding a legal
    // value. REST builds the same sentence from the real list.
    const src = code(MCP_SEARCH);
    for (const c of BRAIN_COLLECTIONS) {
      const at = src.indexOf('collection must be one of');
      assert.ok(at > 0, 'the refusal is gone — re-point this gate');
      const msg = src.slice(at, src.indexOf('`', at + 30) + 1);
      assert.ok(msg.includes(c) || /BRAIN_COLLECTIONS|validCollections/.test(msg),
        `the refusal omits ${c} — derive it from the list rather than writing the names out`);
    }
  });
});

describe('a tool that promises a field returns it', () => {
  it('a cross-space read carries the space each row came from', () => {
    /*
     * THE RULE OUTLIVED THE TOOL IT WAS WRITTEN FOR. This checked `list_chrono`, whose description promised
     * *"Results carry their space"* while its rows omitted it — so on the one tool built for cross-space
     * triage, every row was one the caller could not act on, because `update_chrono` and `delete_chrono`
     * both REQUIRE a space.
     *
     * `list_chrono` folded into `filter` at 5.0, and `filter` is now the tool that reads across spaces when
     * the space is omitted — so the same defect is available in the same shape, one tool along.
     */
    const rec = readFileSync('server/src/brain/query.ts', 'utf8');
    assert.match(rec, /spaceId/,
      'a row must name the space it came from, or a cross-space result cannot be acted on');
  });
});

describe('help() does not narrow what the caller has', () => {
  it('projection is named on every tool that takes it', () => {
    // It said `projection` was "the only field-selection lever there is" about `query`; recall and
    // find_similar both take it and apply it through `_graph`. A caller reached for `includeFileContent: false`
    // on an entity search, where it does nothing.
    assert.doesNotMatch(readFileSync(HELP, 'utf8'), /The only field-selection lever there is/,
      'help() still claims projection exists only on query');
  });

  it('and find_similar is in the omit-space set it belongs to', () => {
    // `spaceRequired: false`, with its own description telling callers to omit it.
    assert.match(readFileSync(HELP, 'utf8'), /find_similar[^\n]*across|across[^\n]*find_similar/,
      'help() lists the omit-space tools and leaves out find_similar');
  });
});

describe('the network type picker names the rule it applies', () => {
  it('club does not claim a supermajority', () => {
    /*
     * `club` passes on ONE yes with no veto — its own code comment says *"only the inviter/publisher (first
     * yes voter) decides"* — and the label read "Club (supermajority)". The userguide and README are both
     * correct; the wrong copy was the one shown at the moment of choosing a trust boundary.
     */
    /*
     * ALL THREE LOCALES, because the label is one claim written three times — and all three said it wrong:
     * `Supermehrheit` and `przewaga większości` are the same assertion as `supermajority`. Checking only
     * English would have left two thirds of the readers looking at the wrong trust boundary while the gate
     * reported it fixed.
     */
    for (const loc of ['en', 'de', 'pl']) {
      const j = JSON.parse(readFileSync(`client/public/assets/i18n/${loc}.json`, 'utf8'));
      const label = j['networks.type.club'];
      assert.ok(label, `the club label is gone from ${loc} — re-point this gate`);
      assert.doesNotMatch(label, /supermajority|supermehrheit|przewaga większości/i,
        `the ${loc} club label reads ${JSON.stringify(label)}, and ONE yes with no veto carries a club round`);
    }
  });
});
