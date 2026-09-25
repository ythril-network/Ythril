/**
 * No tracked source file contains mojibake — UTF-8 that was decoded as ANSI and re-encoded.
 *
 * ## How it gets in, and why nothing catches it
 *
 * PowerShell 5.1's `Get-Content` decodes a BOM-less UTF-8 file as ANSI, so every multi-byte character arrives
 * as its individual bytes. `Set-Content -Encoding utf8` then writes those bytes back out as characters. An
 * em-dash (E2 80 94) comes out as the three characters `â€”`.
 *
 * The file still parses. It still compiles. Every test still passes. The damage is invisible to `tsc` and to
 * every gate in this repo, because it is only ever inside comments and human-readable strings — which is
 * exactly where it does its harm: those strings are tool descriptions an agent READS.
 *
 * ## It has happened twice, both times to me, both times through the same shell idiom
 *
 * `(Get-Content f -Raw) -replace ... | Set-Content -Encoding utf8 f` corrupted `loop-check.test.js`, which
 * was caught in the same session and rewritten. It then corrupted `api/tokens.ts` during the space-admin
 * change and MERGED — 49 sequences, discovered only by scanning the tree afterwards.
 *
 * A rule against the idiom was not enough, and the second occurrence is what makes this a gate. Edit files
 * with a UTF-8-native tool; if a scripted rewrite is genuinely needed, do it in node.
 *
 * ## Detection is structural, after three misses from naming signatures
 *
 * This gate matched `â€`. Then `â”`/`â•` were added, after it passed a tree holding thousands of mis-decoded
 * box-drawing dividers across ten files. Then it was found still reporting clean while `api/tokens.ts`
 * carried `Ã—` — two characters, starting `Ã`, invisible to all three.
 *
 * Each addition was a correct fix to the instance and no fix at all to the class: a pattern that enumerates
 * the corruptions somebody has already tripped over is permanently one shape behind. `_mojibake.mjs` asks the
 * structural question instead — does this run, encoded back to cp1252, decode as valid UTF-8 into something
 * SHORTER — which is true of mis-decoded text and of nothing else.
 *
 * The old exclusion of a lone `Â ` is no longer a special case: a single non-breaking space does not shorten
 * under the round-trip, so it is not flagged, and there is nothing to tune.
 *
 * Run: node --test testing/standalone/no-source-file-carries-mojibake.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { findMojibake, mojibakeOf } from './_mojibake.mjs';
import { trackedSources } from './_sources.mjs';

/**
 * Detection is STRUCTURAL now, not a list of signatures — see `_mojibake.mjs` for why and how.
 *
 * The short version: this gate used to match `â€`, then `â”` and `â•` were added after a tree holding
 * thousands of them passed, and it still reported clean while `api/tokens.ts` carried `Ã—` — the
 * double-encoding of `×`, two characters long and starting with `Ã`. Three misses from one cause: a pattern
 * that names the instances somebody already tripped over is always one shape behind.
 *
 * `findMojibake` asks instead whether a run of non-ASCII, encoded back to cp1252, is valid UTF-8 that decodes
 * SHORTER. Only mis-decoded text does that, and the shortening requirement is what makes it safe to run over
 * every file rather than tuned per false positive.
 */
const MOJIBAKE = { test: (src) => findMojibake(src).length > 0 };

const tracked = (globs) => execSync(`git ls-files ${globs}`, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  .split('\n').map(s => s.trim()).filter(Boolean);

describe('no source file carries mis-decoded UTF-8', () => {
  it('scans a meaningful number of files — the gate before the property', () => {
    // An empty file list passes silently and would hide the exact defect this exists for.
    const files = tracked('"server/src/**/*.ts" "client/src/**/*.ts"');
    assert.ok(files.length > 200, `only enumerated ${files.length} source files — the walk is broken`);
  });

  it('server and client sources are clean', () => {
    const offenders = tracked('"server/src/**/*.ts" "client/src/**/*.ts"')
      .filter(f => MOJIBAKE.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, [], 'these were written by a tool that decoded UTF-8 as ANSI:\n  '
      + offenders.join('\n  ') + '\nRepair with node, not PowerShell.');
  });

  it('the SHIPPED DOCS are clean — a customer reads these', () => {
    // Added 2026-08-16: the gate covered only `.ts`, so the integration guide and the user guide — the two
    // things read by people who are not us — were never checked at all. They are clean today; this keeps
    // them that way, and it is the cheapest possible check on the most visible surface.
    //
    // `CHANGELOG.md` is deliberately NOT in scope. It carries one legitimate occurrence: the entry
    // announcing the mojibake repair quotes the corruption it fixed, which is the correct way to write that
    // entry and would make this assertion permanently red. Scoping to `docs/` rather than exempting a file
    // by name keeps the rule "what we publish is clean" instead of "everything except the file that annoys
    // the gate".
    const docs = tracked('"docs/**/*.md" "docs/*.md"');
    assert.ok(docs.length > 20, `only enumerated ${docs.length} doc files — the walk is broken`);
    const offenders = docs.filter(f => MOJIBAKE.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, [],
      'these ship to customers and were written by a tool that decoded UTF-8 as ANSI:\n  '
      + offenders.join('\n  ') + '\nRepair with node, not PowerShell.');
  });

  it('the test suites are clean — a test title is what a failing run prints', () => {
    // The detector's own module and this gate carry mojibake on purpose, as the thing they detect.
    const files = trackedSources('testing', {
      ext: ['.js', '.mjs', '.cjs', '.ts'],
      floor: 300,
      exclude: ['testing/standalone/_mojibake.mjs', 'testing/standalone/no-source-file-carries-mojibake.test.js'],
    });
    const offenders = files.filter(f => MOJIBAKE.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, [], 'these were written by a tool that decoded UTF-8 as ANSI:\n  '
      + offenders.join('\n  ') + '\nRepair with node, not PowerShell.');
  });

  it('MCP tool descriptions especially — an agent reads these', () => {
    // Narrowed on purpose as well as covered above: a corrupted comment is ugly, and a corrupted tool
    // description is a reference an agent constructs arguments from.
    const offenders = tracked('"server/src/mcp/**/*.ts"')
      .filter(f => MOJIBAKE.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
  });

  it('the detector actually detects', () => {
    // Mutation-proof for the regex itself: a gate whose pattern never matches passes everything.
    assert.ok(MOJIBAKE.test('capability documentation â€” every route'), 'the pattern must match real mojibake');
    assert.ok(!MOJIBAKE.test('capability documentation — every route'), 'and must not match the correct text');
  });

  it('detects every shape that has actually bitten, generated rather than typed', () => {
    // set-claim: fixture INPUTS, each one a character that actually mis-decoded in this repo, and each
    // built from the correct character rather than typed. A record of misses, not a copy of a set.
    // Fixtures are BUILT from the correct character, because typing them is unreliable: `═` mis-decodes to
    // `â•` plus U+0090, an invisible control character, and a hand-written version silently omitted it —
    // producing an assertion that tested a string which cannot occur, and failing a detector that was right.
    //
    // Each of these was a separate miss for the old signature list:
    //   `—`  the original case             `─` `═`  box drawing, added after ten files passed the gate
    //   `×`  TWO characters, starts `Ã`, and sat in merged source while this gate was green
    for (const ch of ['—', '─', '═', '×', '…', '→', '’', '“']) {
      assert.ok(MOJIBAKE.test(`a ${mojibakeOf(ch)} b`), `${ch} mis-decoded must be detected`);
      assert.ok(!MOJIBAKE.test(`a ${ch} b`), `${ch} itself must stay clean`);
    }
  });

  it('names what the text SHOULD be, so a failure is actionable', () => {
    // A gate that only says "there is mojibake here" leaves the repair to guesswork — and guessing put a
    // U+2010 where a U+2014 belonged. The detector already computes the answer; reporting it costs nothing.
    for (const ch of ['×', '—', '═']) {
      const [hit] = findMojibake(`a ${mojibakeOf(ch)} b`);
      assert.equal(hit.shouldBe, ch, 'the repair is derived, not guessed');
    }
  });

  it('does not fire on ordinary accented text', () => {
    // The false-positive floor. These are real words, and a detector that flags them would be tuned away
    // rather than fixed — which is how the signature list started.
    for (const s of ['naïve café', 'Müller GmbH', 'attaché', 'ÅÄÖ', 'σ = 0.5', '→ next', '±3']) {
      assert.ok(!MOJIBAKE.test(s), `${s} is correct text and must not be flagged`);
    }
  });
});
