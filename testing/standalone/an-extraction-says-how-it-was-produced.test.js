/**
 * An extraction records which prompt made it and whether anything was watching, and the corpus can tell when
 * it was made by two prompts.
 *
 * ## The two failures this is for, and both of them actually happened
 *
 * **One file tuned against a scoreboard, indistinguishable from nine that were not.** `conv-26` sat in the
 * extractions directory looking exactly like its neighbours. It had been written by hand while its author
 * watched the retrieval scores — the prompt changed, the numbers were read, the prompt changed again — which
 * is legitimate development and illegitimate evidence. Nothing in the file, the directory or any gate said
 * so. What caught it was somebody remembering, and the stopgap was a paragraph in `bench.mjs status` naming
 * that one conversation, which expired the moment its replacement landed.
 *
 * **A corpus made by two prompts.** Twice in one day. A rate limit killed a re-extraction round halfway, and
 * later two conversations were redone under a clarified rule while eight were not. Both times the hazard is
 * the same: every per-conversation difference afterwards is unattributable, and **nothing anywhere could see
 * it** — the files are individually perfect either way.
 *
 * ## Why a hash rather than a version string
 *
 * A version somebody types is a claim about the prompt. A hash of its bytes is the prompt. The run that
 * would misreport is the run that skips the step, so the field is required and `check` refuses a file
 * without it — a flag a caller may omit records nothing at all.
 *
 * Run: node --test testing/standalone/an-extraction-says-how-it-was-produced.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inputFingerprint, provenanceProblems, corpusProvenance }
  from '../../benchmarks/writer/extraction-provenance.mjs';

const EXTRACTIONS = 'benchmarks/locomo/extractions';
const SCHEMA = 'benchmarks/space/schema.json';
const ok = (over = {}) => ({ promptSha256: 'a'.repeat(64), schemaSha256: 'c'.repeat(64), unattended: true, ...over });

describe('the fingerprint is of the prompt itself', () => {
  it('is the hash of the file on disk, not a version somebody typed', () => {
    const a = inputFingerprint('benchmarks/prompt/extraction.md');
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, inputFingerprint('benchmarks/prompt/extraction.md'), 'it must be stable');
  });

  it('changes when the prompt changes by one character', () => {
    // The whole point. A version string stays put through an edit; this cannot.
    const src = readFileSync('benchmarks/prompt/extraction.md', 'utf8');
    assert.notEqual(inputFingerprint(null, src), inputFingerprint(null, src + ' '));
  });

  it('is the same on a CRLF checkout and an LF one', () => {
    // Not cosmetic. This repo checks out CRLF on Windows and LF in CI, so hashing the bytes as they sit on
    // disk would fingerprint the CHECKOUT: one prompt, two digests, and the corpus check below would report
    // "made by two prompts" permanently and on nothing. A permanent false alarm trains a reader to ignore
    // the one signal that means something.
    const lf = '# Extraction prompt\n\nA line.\nAnother.\n';
    assert.equal(inputFingerprint(null, lf), inputFingerprint(null, lf.replace(/\n/g, '\r\n')));
  });

  it('throws on a prompt that does not exist rather than hashing an empty string', () => {
    // A missing file hashing to the empty-string digest gives every run the same fingerprint, which is the
    // one value that makes the whole field useless while looking like it works.
    assert.throws(() => inputFingerprint('benchmarks/prompt/nope.md'), /cannot fingerprint/);
  });
});

describe('the SCHEMA is fingerprinted beside the prompt (`Q-27`)', () => {
  /*
   * `space/schema.json` is an input every extractor reads, exactly as the prompt is, and it was the one that
   * was not recorded. So a vocabulary change landing mid-round would leave half a corpus written against one
   * schema and half against another, with nothing in any file to say so — the hazard the prompt fingerprint
   * was built for, one input over.
   */
  it('the schema hashes like the prompt, through the same function', () => {
    const a = inputFingerprint(SCHEMA);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, inputFingerprint('benchmarks/prompt/extraction.md'), 'two inputs, two fingerprints');
  });

  it('a missing input is refused BY NAME, whichever input it is', () => {
    assert.throws(() => inputFingerprint('benchmarks/space/nope.json'), /nope\.json/);
  });

  it('a file with no schema fingerprint is refused, and so is a malformed one', () => {
    assert.ok(provenanceProblems({ producedBy: ok({ schemaSha256: undefined }) }).some(p => /schemaSha256/.test(p)));
    assert.ok(provenanceProblems({ producedBy: ok({ schemaSha256: 'v1' }) }).some(p => /schemaSha256/.test(p)));
  });

  it('a corpus made against two schemas is CAUGHT, and says which files used which', () => {
    const r = corpusProvenance([
      { conversationId: 'a', producedBy: ok() },
      { conversationId: 'b', producedBy: ok({ schemaSha256: 'd'.repeat(64) }) },
    ]);
    assert.equal(r.onePrompt, true, 'one prompt');
    assert.equal(r.oneSchema, false, 'two schemas');
    assert.deepEqual(r.schemas.find(x => x.sha === 'd'.repeat(64)).conversations, ['b']);
  });

  it('`bench.mjs merge` stamps the schema in the tree, as it stamps the prompt', () => {
    /*
     * Driven through the CLI rather than read out of its source, because a gate that finds the call cannot
     * see where it landed — a fingerprint computed and put on the wrong object passes every grep.
     */
    const dir = mkdtempSync(join(tmpdir(), 'q27-'));
    const part = join(dir, 'whole.json');
    writeFileSync(part, JSON.stringify({
      conversationId: 'conv-x', sessions: [], entities: [], chrono: [], edges: [], claims: [],
      producedBy: { unattended: true },
    }));
    const out = JSON.parse(execFileSync(process.execPath, ['benchmarks/bench.mjs', 'merge', part], { encoding: 'utf8' }));
    assert.equal(out.producedBy.schemaSha256, inputFingerprint(SCHEMA));
    assert.equal(out.producedBy.promptSha256, inputFingerprint('benchmarks/prompt/extraction.md'));
    assert.equal(out.producedBy.unattended, true);
  });
});

describe('what a file must say', () => {
  it('accepts a complete block', () => {
    assert.deepEqual(provenanceProblems({ producedBy: ok() }), []);
  });

  it('REFUSES a file with no producedBy at all', () => {
    const problems = provenanceProblems({});
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /producedBy/);
  });

  it('refuses a fingerprint that is not a sha256', () => {
    for (const bad of ['v2', '', 'abc', 'A'.repeat(64), 'a'.repeat(63)]) {
      assert.ok(provenanceProblems({ producedBy: ok({ promptSha256: bad }) }).length >= 1,
        `'${bad}' was accepted as a prompt fingerprint`);
    }
  });

  it('refuses a MISSING unattended flag, and accepts an honest false', () => {
    // The asymmetry is the design. Omitting the flag must not read as "unattended" — the run that would lie
    // is the run that leaves it out, so absence is refused and `false` is a legitimate, recorded answer.
    assert.ok(provenanceProblems({ producedBy: ok({ unattended: undefined }) }).length >= 1);
    assert.deepEqual(provenanceProblems({ producedBy: ok({ unattended: false }) }), []);
  });

  it('refuses a truthy non-boolean rather than coercing it', () => {
    // `unattended: "yes"` is how a field like this quietly becomes decorative.
    assert.ok(provenanceProblems({ producedBy: ok({ unattended: 'yes' }) }).length >= 1);
  });
});

describe('the corpus-level question, which is the one nothing could see', () => {
  it('reports agreement when every file names the same prompt', () => {
    const r = corpusProvenance([{ conversationId: 'a', producedBy: ok() }, { conversationId: 'b', producedBy: ok() }]);
    assert.equal(r.onePrompt, true);
    assert.equal(r.prompts.length, 1);
    assert.deepEqual(r.attended, []);
  });

  it('CATCHES a corpus made by two prompts, and says which files came from which', () => {
    const r = corpusProvenance([
      { conversationId: 'a', producedBy: ok() },
      { conversationId: 'b', producedBy: ok({ promptSha256: 'b'.repeat(64) }) },
      { conversationId: 'c', producedBy: ok({ promptSha256: 'b'.repeat(64) }) },
    ]);
    assert.equal(r.onePrompt, false);
    assert.equal(r.prompts.length, 2);
    const split = r.prompts.find(p => p.sha === 'b'.repeat(64));
    assert.deepEqual(split.conversations, ['b', 'c']);
  });

  it('names every file that was NOT produced unattended', () => {
    const r = corpusProvenance([
      { conversationId: 'a', producedBy: ok() },
      { conversationId: 'b', producedBy: ok({ unattended: false }) },
    ]);
    assert.deepEqual(r.attended, ['b']);
  });

  it('throws rather than reporting agreement over an empty corpus', () => {
    // "Every file names the same prompt" is vacuously true of no files, and that is the reading that turns
    // a broken directory read into a clean bill of health.
    assert.throws(() => corpusProvenance([]), /no extractions/);
  });
});

describe('the committed corpus', () => {
  it('every extraction says how it was produced', () => {
    const files = existsSync(EXTRACTIONS) ? readdirSync(EXTRACTIONS).filter(f => f.endsWith('.json')) : [];
    assert.ok(files.length >= 2, `only ${files.length} extractions found — the sweep would be vacuous`);
    for (const f of files) {
      const problems = provenanceProblems(JSON.parse(readFileSync(`${EXTRACTIONS}/${f}`, 'utf8')));
      assert.deepEqual(problems, [], `${f}: ${problems.join('; ')}`);
    }
  });

  it('and was produced against ONE schema', () => {
    const files = readdirSync(EXTRACTIONS).filter(f => f.endsWith('.json'));
    const r = corpusProvenance(files.map(f => JSON.parse(readFileSync(`${EXTRACTIONS}/${f}`, 'utf8'))));
    assert.equal(r.oneSchema, true, JSON.stringify(r.schemas));
  });
});
