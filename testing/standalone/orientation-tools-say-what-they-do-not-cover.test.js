/**
 * The two orientation tools say what their answer is NOT.
 *
 * These are the tools an agent calls before it knows anything, so a gap here becomes a wrong conclusion that
 * gets reported outward as a missing feature.
 *
 * ## `help` — the tool list is filtered, and nothing said so
 *
 * `toolIsVisible` filters `tools/list` and `help()` alike: a read-only token sees no mutating tools, a
 * non-admin sees no admin tools. That is correct and deliberate. What was missing is the consequence — a tool
 * absent from the reply means THIS TOKEN cannot invoke it, never that the instance lacks the capability.
 *
 * This is not hypothetical. `mcp-help.test.js` refused three of this session's own drafts for naming a
 * mutating tool in a read-only description, and the reason it exists at all is that advertising an
 * unreachable tool produces exactly the wrong bug report. The same sentence had to be written into
 * `list_embed_jobs`, `find_entities_by_name` and `list_dir` one at a time, because the one place it really
 * belonged — `help` itself — did not carry it.
 *
 * ## `space_meta` — declared, not actual
 *
 * It returns what MAY exist. `er_model` returns what DOES. A space can declare twenty types and hold three,
 * and a caller who reads the declaration as an inventory plans against types with no records in them.
 *
 * Run: node --test testing/standalone/orientation-tools-say-what-they-do-not-cover.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

const description = (file, name) => {
  const s = src(file);
  const at = s.indexOf(`name: '${name}'`);
  assert.ok(at > 0, `${name} not found in ${file} — the scanner is wrong, not the code`);
  const d = s.indexOf('description:', at);
  const end = s.slice(d).search(/\n {2,}(mutating|spaceRequired|admin|spaceAdmin|skipSchemaValidation|inputSchema|async handle):/);
  assert.ok(end > 0, `could not find the end of ${name}'s description`);
  return s.slice(d, d + end);
};

const HELP = description('server/src/mcp/tools/help.ts', 'help');
const META = description('server/src/mcp/tools/spaces.ts', 'space_meta');

describe('help says its own tool list is filtered', () => {
  it('says the list is scoped to the calling token', () => {
    assert.match(HELP, /FILTERED TO WHAT YOUR TOKEN CAN REACH/,
      'the most important property of this answer, and it was unstated');
  });

  it('spells out the wrong conclusion so it is not drawn', () => {
    // The whole point. "There is no way to do X here" is unsupportable from a filtered list, and it is
    // exactly what gets reported outward.
    assert.match(HELP, /does NOT mean the instance lacks/, 'name the false inference');
    assert.match(HELP, /THIS TOKEN cannot invoke it/, 'and the true one');
  });

  it('and the filtering really is per token', () => {
    assert.match(src('server/src/mcp/tool-visibility.ts'), /export function toolIsVisible/,
      'the predicate this paragraph describes');
    assert.match(src('server/src/mcp/tool-visibility.ts'), /if \(tool\.mutating\) return canWriteAnywhere/,
      'read-only tokens really are shown fewer tools');
  });

  it('points at the tool schemas as the authoritative reference', () => {
    // CLAUDE.md: a stale sentence in a schema is invisible, because nobody reports a capability they were
    // told they did not have. help() saying the schemas are authoritative is what makes them get read.
    assert.match(HELP, /AUTHORITATIVE REFERENCE/, 'say which source wins');
    assert.match(HELP, /inputSchema/, 'and name it precisely');
  });

  it('says query narrows rather than broadens', () => {
    assert.match(HELP, /NARROW/, 'ALL words must appear, so more words find less');
  });
});

describe('space_meta distinguishes declared from actual', () => {
  /*
   * THE RULE SURVIVED THE MERGE; THE SENTENCE DID NOT. This required the words *"DECLARED, NOT ACTUAL"*
   * and a pointer at `er_model`, which was the right demand while the actual shape lived in a second
   * tool: a declaration read as an inventory produces plans against empty types.
   *
   * At 5.0 `er_model` folded in, so the warning is no longer “this is not the inventory, go elsewhere” but
   * “both are here and they are different things”. What must still be true is that a caller cannot read one
   * as the other.
   */
  it('says both words, so neither half can be read as the other', () => {
    assert.match(META, /DECLARED/, 'a declaration read as an inventory produces plans against empty types');
    assert.match(META, /ACTUAL/i, 'and the actual shape must be named as its own thing');
  });

  it('names the field the actual shape arrives in', () => {
    assert.match(META, /actualSchema/,
      'the caller needs to know where the actual shape lives — it used to be a tool, now it is a field');
  });

  it('explains what each validation mode does to a WRITE', () => {
    // set-claim: the three validation modes, which are a closed ladder (off, warn, strict) rather than a
    // growable set -- a fourth would be a different feature, not another value.
    for (const mode of ['off', 'warn', 'strict']) {
      assert.match(META, new RegExp('`' + mode + '`'), `${mode} must be explained, not just listed`);
    }
    assert.match(META, /strictLinkage/, 'and the linkage flag beside it');
  });

  it('pre-empts "strict plus an empty schema must be a bug"', () => {
    assert.match(META, /not a contradiction/,
      'a new space is strict AND accepts everything, which reads as broken until explained');
  });

  it('says strict refuses what your change breaks, not what was already broken', () => {
    // Shipped in this release (#920), so nobody has prior knowledge of it.
    assert.match(META, /BREAKS, not what was already broken/, 'the P-6 behaviour');
  });

  it('explains needsReindex as a QUALITY signal, not an outage', () => {
    assert.match(META, /degrade quietly rather than erroring/,
      'recall still answers, which is why nobody notices');
  });

  it('and still does not name the repair tool, which a read-only token cannot call', () => {
    // The constraint the original comment recorded, kept through the rewrite: naming the STATE is both
    // allowed and more useful to a reader who cannot perform the repair.
    assert.doesNotMatch(META, /\breindex\b/, 'read-only help must not advertise a mutating tool');
    assert.match(META, /needsReindex/, 'the field name is not the tool name and stays');
  });
});
