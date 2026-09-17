/**
 * The MCP door's default byte budget is LOWER than REST's, and the divergence is stated on both doors.
 *
 * ## Why a divergence needs its own gate
 *
 * `CLAUDE.md`'s first rule is that MCP and REST are one API with two doors, taking the same parameters — and
 * that the half which hides is the parameters, not the capabilities. This change deliberately breaks symmetry
 * on one value, so it is exactly the shape that rule exists to catch. The defence is that the divergence is
 * *the narrowing itself*: both doors accept `maxBytes` with the same floor, ceiling and refusal, and only the
 * number applied when the caller says nothing differs.
 *
 * That defence is only true while three things hold, and none of them holds by itself:
 *
 *  1. the MCP default is genuinely lower, not merely different;
 *  2. every MCP call site uses it — one site left on the REST default would make the behaviour depend on which
 *     tool the caller picked, which is worse than either number;
 *  3. both doors SAY so, in the surface a caller reads while constructing arguments.
 *
 * ## The measurement behind it
 *
 * The canary operator, 2026-08-20T0925Z: a recall answered `bytesReturned: 98356` against `budgetBytes: 100000`,
 * correct and fully specified, and their MCP client refused it outright and spilled it to a local file. Their
 * own diagnosis is why the answer is a lower default rather than better docs: *"the old 25-record cap had been
 * acting as the de facto size guard on the MCP door, and removing it removed that guard along with the cliff
 * we were complaining about."*
 *
 * ## What this gate does NOT assert
 *
 * The exact number. 25 000 is chosen from the safe side of ONE refusal — we have no measurement of where any
 * client's ceiling actually is — so pinning it would be pinning a guess. What is pinned is the ORDERING and the
 * disclosure, which are the parts a future edit can break silently.
 *
 * Run: node --test testing/standalone/mcp-recall-budget-is-lower-than-rest.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statementFrom } from './_structural-window.mjs';

const MCP = readFileSync('server/src/mcp/tools/search.ts', 'utf8');
const REST = readFileSync('server/src/api/brain/search.ts', 'utf8');

let DEFAULT_MAX_CHARS, MCP_DEFAULT_MAX_CHARS, MIN_MAX_BYTES, MAX_MAX_BYTES, resolveBudget;
before(async () => {
  ({ DEFAULT_MAX_CHARS, MCP_DEFAULT_MAX_CHARS, MIN_MAX_BYTES, MAX_MAX_BYTES, resolveBudget } =
    await import('../../server/dist/brain/result-budget.js'));
});

describe('the two defaults', () => {
  it('are both defined, and MCP is the lower one', () => {
    assert.equal(typeof DEFAULT_MAX_CHARS, 'number');
    assert.equal(typeof MCP_DEFAULT_MAX_CHARS, 'number');
    assert.ok(MCP_DEFAULT_MAX_CHARS < DEFAULT_MAX_CHARS,
      `the MCP default (${MCP_DEFAULT_MAX_CHARS}) must be below the REST default (${DEFAULT_MAX_CHARS}) — `
      + 'the whole point is that an agent\'s tool result has a ceiling a REST caller does not');
  });

  it('the MCP default is still inside the range a caller may ask for', () => {
    // A default below the floor would be clamped up and the constant would be a lie; above the ceiling, clamped
    // down. Either way the number a caller reads in the schema would not be the number applied.
    assert.ok(MCP_DEFAULT_MAX_CHARS >= MIN_MAX_BYTES && MCP_DEFAULT_MAX_CHARS <= MAX_MAX_BYTES);
    const resolved = resolveBudget({}, MCP_DEFAULT_MAX_CHARS);
    // The defaults are CHARACTER ceilings now, and `maxBytes` deliberately has none — see B-1. This used
    // to read `{ok: true, bytes: …}` because one number was doing both jobs, badly.
    assert.deepEqual(resolved, { ok: true, chars: MCP_DEFAULT_MAX_CHARS, bytes: null },
      'the default must survive the clamp unchanged, or the documented number is not the applied one');
  });

  it('a caller who ASKS gets the same answer on either door', () => {
    // The parameter is not narrowed — only the default is. `maxBytes: 400000` must resolve identically no
    // matter which default was in play, or the divergence has leaked from the default into the parameter.
    // The BYTE ceiling, specifically. Since B-1 a resolution carries two, and the character one still
    // differs by the door's default — correctly, because stating a byte ceiling says nothing about
    // characters. Comparing the whole object would assert that the documented difference does not exist.
    for (const asked of [MIN_MAX_BYTES, 40_000, 400_000, MAX_MAX_BYTES]) {
      assert.equal(
        resolveBudget({ maxBytes: asked }, MCP_DEFAULT_MAX_CHARS).bytes,
        resolveBudget({ maxBytes: asked }, DEFAULT_MAX_CHARS).bytes,
        `maxBytes: ${asked} must resolve the same on both doors`);
    }
    // And the same for the character parameter, which is the one the defaults are about.
    for (const asked of [MIN_MAX_BYTES, 40_000, 400_000, MAX_MAX_BYTES]) {
      assert.equal(
        resolveBudget({ maxChars: asked }, MCP_DEFAULT_MAX_CHARS).chars,
        resolveBudget({ maxChars: asked }, DEFAULT_MAX_CHARS).chars,
        `maxChars: ${asked} must resolve the same on both doors`);
    }
  });

  it('and the refusal is identical on both doors', () => {
    const a = resolveBudget({ maxBytes: 'plenty' }, MCP_DEFAULT_MAX_CHARS);
    const b = resolveBudget({ maxBytes: 'plenty' }, DEFAULT_MAX_CHARS);
    assert.equal(a.ok, false);
    assert.deepEqual(a, b, 'a bad value must be refused with the same text whichever door it arrived at');
  });
});

describe('every call site uses its own door\'s default', () => {
  it('every tool call site resolves the default from the DOOR, never from a constant', () => {
    /*
     * This case used to read *"both MCP recall paths pass the MCP default"*, and asserted that each
     * `resolveBudget` in the tool module named `MCP_DEFAULT_MAX_CHARS`. That was right while MCP was the
     * only door those modules had, and `B-9` ended it: every tool is also `POST /api/<tool-name>`, the same
     * module reached by plain HTTP. Naming the constant then meant a curl caller's answer silently halved
     * depending on which URL they typed — 50 000 through `POST /api/brain/recall`, 25 000 through
     * `POST /api/recall`.
     *
     * So the claim inverted, and this is the positive half of it: not merely that nobody hard-codes a
     * number (`the-byte-budget-follows-the-door-not-the-module` asserts that), but that every site
     * genuinely goes through the resolver. `CLAUDE.md` holds the divergence to three conditions and this is
     * the second — *every MCP call site resolves through it rather than one remembering to*.
     */
    const calls = [...MCP.matchAll(/resolveBudget\(/g)];
    assert.ok(calls.length >= 2, `expected the tool module to resolve a budget in several tools, found ${calls.length}`);
    const missing = calls
      .filter(m => !/defaultBudgetChars\(\s*ctx\.transport\s*\)/.test(statementFrom(MCP, m.index, 'a resolveBudget call')))
      .map(m => `line ${MCP.slice(0, m.index).split('\n').length}`);
    assert.deepEqual(missing, [],
      'these tool call sites choose a budget default themselves instead of asking which door called, so the '
      + `size a caller gets depends on the URL rather than on who is reading:\n  ${missing.join('\n  ')}`);
  });

  it('REST keeps the operator default, and does not reach for the MCP one', () => {
    // `POST /api/brain/recall` delegates to `callTool` and resolves nothing of its own, so the count is
    // lower than it was. The claim is unchanged: no REST handler may name the agent's number.
    assert.ok([...REST.matchAll(/resolveBudget\(/g)].length >= 1, 'the REST door must still resolve a budget');
    assert.doesNotMatch(REST, /MCP_DEFAULT_MAX_CHARS/,
      'the REST door must not take the MCP default — 100 KB is unremarkable in a REST body');
  });
});

describe('both doors say so, in the surface a caller reads', () => {
  it('the MCP schema names its own default AND the other door\'s', () => {
    /*
     * `help()` tells callers the tool schema IS the authoritative reference, and CLAUDE.md records what a
     * stale sentence there cost: The fleet integrator read "filter applied after vector search", believed it, and built a
     * skill that avoided filtered recall. A default that differs per door and is stated on neither is the same
     * failure waiting — a caller measures 25000, concludes it is the product's limit, and designs around it.
     */
    // The default lives on `maxChars` now — it is the ceiling that carries one, and `maxBytes` deliberately
    // has none, so a per-door default stated on `maxBytes` would be naming a number that does not exist.
    const hits = [...MCP.matchAll(/DEFAULT 25000 ON THIS DOOR/g)];
    assert.ok(hits.length >= 2,
      `both maxChars descriptions must state this door's default; found ${hits.length}`);
    assert.match(MCP, /50000 on REST/, 'and name the other door\'s, so the difference is discoverable');
    assert.match(MCP, /NO DEFAULT/,
      '`maxBytes` must say it has none — a caller who assumes one designs around a ceiling that is not there');
    assert.match(MCP, /RAISE IT IF YOUR CLIENT CAN TAKE MORE/,
      'and say what to do about it — a limit with no lever reads as a product ceiling');
  });

  it('the integration guide states both numbers', () => {
    const guide = readFileSync('docs/integration-guide/04a-recall-api.md', 'utf8');
    // On `maxChars`, which is the ceiling that has defaults. `maxBytes` has none, deliberately.
    assert.match(guide, /`50000` REST \/ `25000` MCP/, 'the parameter table must carry both');
    assert.match(guide, /50 000 over REST, 25 000 over MCP/, 'and so must the prose that explains the budget');
  });

  it('the userguide says the browser gets the LARGER one, and why', () => {
    // The operator-facing half, and the one that would otherwise read as a bug report: a search that answers
    // whole in the UI can come back shortened for an agent asking the same question.
    const ug = readFileSync('docs/userguide/02-brain.md', 'utf8');
    assert.match(ug, /The default\s+here is the\s+larger one/,
      'the Search page must say which side of the divergence it is on');
    assert.match(ug, /deliberate rather/,
      'and say it is deliberate, or the next person to notice files it as an inconsistency');
  });

  it('no surface still claims the answer spills at a RECORD count', () => {
    // The byte budget replaced a 25-record cap in 3.2.0 and `topK`'s description still said "past roughly 25
    // results the answer spills". A schema description is the authoritative reference — a stale sentence there
    // is invisible, because nobody reports a limit they were told they had.
    assert.doesNotMatch(MCP, /past roughly 25 results the answer spills/,
      'this sentence predates the byte budget and describes a cap that no longer exists');
  });
});
