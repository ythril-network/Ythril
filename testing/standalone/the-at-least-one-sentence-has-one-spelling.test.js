/**
 * The "at least one field must be provided" sentence has ONE spelling, and the test for it ONE implementation, on every brain
 * write door (Q-320, bundle-128, design-v3 section 2.3 and 8.2 G7).
 *
 * ## What went wrong, and what the rule is
 *
 * Four REST PATCH routes said `At least one field must be provided` and four MCP update tools each hand-listed the fields they
 * would accept — and every list omitted `superseded`. Chrono's REST route tested its body against a hand list
 * (`PATCHABLE_FIELDS`) that also omitted it, so `PATCH {superseded:true}` was a 400 on REST while `update_chrono` accepted it.
 * Two doors, two lists, the weaker wins silently. The plan derives both from the one accepted set: one sentence
 * (`atLeastOneFieldRefusal(operation)` -> `At least one of <sorted accepted keys> must be provided`) and one predicate
 * (`carriesAnyAcceptedField(body, operation)`).
 *
 * So the gate asserts three things, each over a DERIVED set of files:
 *   1. no brain write door (a REST file or MCP tool file of a `BRAIN_WRITE_PAIRS` pair) spells the sentence itself, in either the
 *      REST wording or the MCP wording, and none keeps a hand list of patchable fields;
 *   2. each of the four record update doors on both REST and MCP asks the shared function for the sentence and the shared
 *      predicate for "is there anything to update";
 *   3. the sentence is produced in exactly one place, `contract/write-accepts.ts`.
 *
 * Out of scope on purpose, with the reason: `update_space`, `schema_update` and `body-schemas.ts` have their own "at least one of"
 * refusals. They are SPACE SETTINGS doors, not brain writes, and design-v3 section 11 (N3) leaves their wording alone.
 *
 * Seen red on the unchanged base: the eight hand-written sentences and chrono's `PATCHABLE_FIELDS` are present, the doors call
 * neither shared function, and `contract/write-accepts.ts` does not exist.
 *
 * Run: node --test testing/standalone/the-at-least-one-sentence-has-one-spelling.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { BRAIN_WRITE_PAIRS, RECORD_PAIRS, restHandlerOf, toolHandlerOf } from './_brain-write-pairs.mjs';

const read = (f) => stripComments(readFileSync(f, 'utf8'));

/** Every file that holds one of the doors of a brain write: derived from the pairs, never listed. */
const doorFiles = () => {
  const rest = new Set(BRAIN_WRITE_PAIRS.map(p => restHandlerOf(p).file.replace(/\\/g, '/')));
  const tools = new Set(BRAIN_WRITE_PAIRS.map(p => toolHandlerOf(p.tool).file.replace(/\\/g, '/')));
  return { rest, tools };
};

/** The four record kinds whose PATCH and update tool refuse a body with nothing to change. */
const UPDATES_WITH_A_REFUSAL = RECORD_PAIRS.filter(p => /^(fact|entity|edge|chrono)\.update$/.test(p.op));

describe('no brain write door spells the sentence or keeps a patchable-field list', () => {
  it('derives its subjects, with a floor', () => {
    const { rest, tools } = doorFiles();
    assert.ok(rest.size >= 6, `only ${rest.size} REST door files derived`);
    assert.ok(tools.size >= 6, `only ${tools.size} MCP door files derived`);
    assert.equal(UPDATES_WITH_A_REFUSAL.length, 4, 'the four record update pairs were not all found');
  });

  it('no door says "At least one field" or "At least one of …" in its own words', () => {
    const { rest, tools } = doorFiles();
    const offenders = [];
    for (const f of [...rest, ...tools]) {
      const s = read(f);
      for (const m of s.matchAll(/At least one (?:of |field)[^'"`\n]*/g)) offenders.push(`${f}: "${m[0].trim()}"`);
    }
    assert.deepEqual(offenders, [], 'a hand-written sentence is a second list of the accepted fields, and every one of them omitted `superseded`');
  });

  it('no door keeps a hand list of patchable fields', () => {
    const { rest, tools } = doorFiles();
    const offenders = [];
    for (const f of [...rest, ...tools]) {
      const s = read(f);
      for (const m of s.matchAll(/\bconst\s+(\w*(?:PATCHABLE|UPDATABLE)\w*)\s*(?::[^=]+)?=\s*[\[(]/g)) offenders.push(`${f}: ${m[1]}`);
    }
    assert.deepEqual(offenders, [], 'a hand list of patchable fields is what chrono PATCH used, and it omitted `superseded`');
  });
});

describe('every record update door asks the shared function and the shared predicate', () => {
  for (const pair of UPDATES_WITH_A_REFUSAL) {
    it(`${pair.op}: REST route and ${pair.tool}`, () => {
      for (const [door, source] of [['REST', restHandlerOf(pair).source], [pair.tool, toolHandlerOf(pair.tool).handle]]) {
        assert.match(source, /\batLeastOneFieldRefusal\(/, `${pair.op} on ${door} words its own "nothing to update" refusal`);
        assert.match(source, /\bcarriesAnyAcceptedField\(/, `${pair.op} on ${door} decides "is there anything to update" by itself`);
      }
    });
  }
});

describe('the sentence is made in one place', () => {
  it('only contract/write-accepts.ts builds "At least one of" for a brain write', () => {
    const makers = trackedSources(['server/src'], { floor: 100 })
      .filter(f => /At least one of \$\{|At least one of '\s*\+|At least one of `/.test(read(f)))
      // The two space-settings doors are out of scope (see the header): their own sentences are their own rule.
      .filter(f => !/mcp\/tools\/spaces\.ts$|spaces\/body-schemas\.ts$/.test(f));
    assert.deepEqual(makers, ['server/src/contract/write-accepts.ts'],
      'the sentence must be built in exactly one module, and that module is the judge\'s');
  });
});