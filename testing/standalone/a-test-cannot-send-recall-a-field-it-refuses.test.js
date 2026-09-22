/**
 * No test sends `recall` a field the tool would refuse — because a refused setup call looks like a skip.
 *
 * ## What happened, and why nothing reported it
 *
 * `a-traversed-recall-returns-whole-graphs.test.js` sent `includeFreshWrites: true` on every recall. 5.0
 * removed that parameter, so every one of those calls answered **400** — and the file's own fixture guard
 * turned that into a skip: it set its budget only `if (full.status === 200)`, and `ready()` skipped each
 * case when the budget was still zero, saying *"could not measure the full traversed answer"*.
 *
 * So an entire integration file stopped testing anything on the day 5.0 shipped, reported itself as
 * skipped for a reason that reads like an unavailable fixture, and no gate said a word. **A test that
 * skips is indistinguishable from one that passes in every summary anybody reads.**
 *
 * ## Why the rule is the FIELD and not the skip
 *
 * "A fixture must not skip on a refusal" is the honest rule and it is not derivable — a skip is a
 * judgement about what the fixture needs, and a gate that banned them would be wrong more often than
 * right. What IS derivable is the thing that made this one unreachable: the request was rejected before
 * any of it ran, for a name that stopped existing.
 *
 * ## Where the allowed names come from
 *
 * `POST /api/brain/recall` hands its body straight to `callTool`, whose validator enforces the `recall`
 * tool's `inputSchema` with `additionalProperties: false`. **So the tool's schema IS the REST body's
 * schema**, and this reads it from the registry rather than keeping a list — the list is what went stale
 * in the first place. A parameter renamed or removed next year is covered by this gate as it stands.
 *
 * ## The window is the CALL, and the keys are its top level
 *
 * `filter: { _id: … }` and `projection: { name: 1 }` are legitimate, and their inner keys are data rather
 * than parameters — a sweep that collected every `key:` in the region would report `_id` as an unknown
 * recall field. `argumentsOf` splits the call's arguments at depth zero, so only the body object's own
 * keys are read.
 *
 * Run: node --test testing/standalone/a-test-cannot-send-recall-a-field-it-refuses.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { argumentsOf } from './_structural-window.mjs';

/** The call sites this sweep is about, in the order a reader would look for them. */
const ANCHORS = ["'/api/brain/recall'", '"/api/brain/recall"'];

let allowed;

/** Every tracked test source. Derived from git, never from a directory walk — `todo/` is gitignored. */
function trackedTests() {
  const out = execFileSync('git', ['ls-files', 'testing'], { encoding: 'utf8' })
    .split('\n').map(l => l.trim()).filter(l => /\.(test\.)?m?js$/.test(l));
  assert.ok(out.length >= 100, `expected the test tree, found ${out.length} files`);
  return out;
}

/**
 * The top-level keys of each recall body literal in one file, with the line it sits on.
 *
 * A call whose body is a variable rather than a literal contributes nothing, and that is correct: this
 * gate reads what a test SAYS, and a computed body is not something a regex should pretend to know.
 */
function recallBodyKeys(src) {
  const found = [];
  for (const anchor of ANCHORS) {
    let at = src.indexOf(anchor);
    while (at > -1) {
      // The enclosing call's own paren, which is the one before the anchor on the same expression.
      const open = src.lastIndexOf('(', at);
      if (open > -1) {
        let args = null;
        try { args = argumentsOf(src, open, 'recall call'); } catch { args = null; }
        const body = args?.find(a => a.trimStart().startsWith('{'));
        if (body) {
          // Depth-one keys only: `filter: { _id }` must contribute `filter`, never `_id`.
          let depth = 0;
          let key = '';
          for (let i = 0; i < body.length; i++) {
            const c = body[i];
            if (c === '{' || c === '[' || c === '(') { depth++; continue; }
            if (c === '}' || c === ']' || c === ')') { depth--; continue; }
            if (depth !== 1) continue;
            if (c === ':' && key.trim()) { found.push({ key: key.trim(), line: lineOf(src, at) }); key = ''; continue; }
            if (c === ',') { key = ''; continue; }
            key += c;
          }
        }
      }
      at = src.indexOf(anchor, at + anchor.length);
    }
  }
  // Spreads and computed keys read as noise rather than as parameters; a name is what this gate judges.
  return found.filter(f => /^[A-Za-z_$][\w$]*$/.test(f.key));
}

const lineOf = (src, at) => src.slice(0, at).split('\n').length;

describe('a test cannot send recall a field it refuses', () => {
  before(async () => {
    const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
    const recall = ALL_TOOLS.find(t => t.name === 'recall');
    assert.ok(recall, 'the recall tool is not registered — this gate is blind');

    /*
     * `inputSchema` is a FUNCTION, not an object: a tool builds its schema per connection, because the
     * `space` enum is the spaces that connection can reach. Reading `.properties` off the function gives
     * `undefined`, and a gate that then looped over nothing would report every test clean.
     *
     * The parameter NAMES do not depend on the argument, so an empty context is the honest call here.
     */
    const schema = recall.inputSchema({});
    assert.ok(schema?.properties, 'recall built no schema — this gate is blind');
    assert.equal(schema.additionalProperties, false,
      'recall accepts unknown fields, so this gate is asserting a rule the server does not enforce');
    allowed = new Set(Object.keys(schema.properties));
  });

  it('reads the schema and finds the call sites (the check itself works)', () => {
    /*
     * Two floors. An empty schema would admit every name, and an empty sweep would pass over nothing —
     * the two ways this gate can report clean about something it never looked at.
     */
    assert.ok(allowed.size >= 8, `recall declares ${allowed.size} parameters — the schema stopped resolving`);

    const sites = trackedTests()
      .map(f => [f, recallBodyKeys(readFileSync(f, 'utf8'))])
      .filter(([, keys]) => keys.length > 0);
    assert.ok(sites.length >= 5,
      `found recall bodies in ${sites.length} test file(s) — the anchor has stopped matching`);
  });

  it('every field a test sends to recall is one the tool declares', () => {
    const offenders = [];
    for (const file of trackedTests()) {
      for (const { key, line } of recallBodyKeys(readFileSync(file, 'utf8'))) {
        if (!allowed.has(key)) offenders.push(`${file}:${line} sends \`${key}\``);
      }
    }
    assert.deepEqual(offenders, [],
      'These tests send recall a field its schema does not declare, so the call is a 400 before the test '
      + 'runs. That is worse than a failure: a fixture that cannot build usually SKIPS, and a skipped '
      + 'file is indistinguishable from a passing one in every summary anybody reads — which is how '
      + '`includeFreshWrites` left a whole integration file inert for a release.\n      Allowed: '
      + `${[...allowed].sort().join(', ')}`);
  });
});
