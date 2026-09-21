/**
 * An extraction round survives the session that started it.
 *
 * ## What this is fixing, and it has now cost three rounds
 *
 * An extraction is written in parts of about ten sessions, and the parts lived in a per-session scratch
 * directory. A session scratch directory is wiped between sessions — which is exactly when the parts are
 * needed. So a round interrupted by a rate limit lost everything it had written and the next session
 * started at part 1 of conversation 1.
 *
 * Measured twice on 2026-09-20: ten extractors launched together exhausted the window in about twenty
 * minutes and produced **nothing at all**, every one dying between reading its conversation and writing its
 * file. Three at a time, with parts on disk, produced three finished conversations in the same wall-clock.
 *
 * Owner, the same day: *"make B-19 more session-limit-oriented with checkpoints and smaller packages at
 * once. when you always create 10 subagents for conv-processing the limits are hit way too fast and nothing
 * progresses and next session has to redo stuff."*
 *
 * ## The guard that makes resuming SAFE, which is the whole reason this is a module
 *
 * A directory of surviving parts is a directory of parts written at some earlier time — and the prompt may
 * have changed since. Merging those with parts written today produces one file, structurally perfect,
 * describing one conversation under two sets of rules, and **nothing anywhere could see it**. That is
 * `B-15`'s defect arriving one level down: the corpus-level check compares whole files, and a file spliced
 * from two prompts carries one fingerprint.
 *
 * So a part records the prompt it was written under, and a resume refuses a set that disagrees. The
 * checkpoint is only worth having if it cannot silently splice two rounds.
 *
 * Run: node --test testing/standalone/a-half-finished-extraction-resumes-where-it-stopped.test.js
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { partsDir, resumePoint, PARTS_ROOT } from '../../benchmarks/writer/extraction-parts.mjs';

const CONV = 'conv-test-resume';
const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

const write = (index, over = {}) => {
  const dir = partsDir(CONV);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `part${index}.json`), JSON.stringify({
    conversationId: CONV,
    part: { index, of: 4 },
    producedBy: { promptSha256: SHA, unattended: true },
    sessions: [], entities: [], chrono: [], edges: [], claims: [],
    ...over,
  }));
};

const wipe = () => { if (existsSync(partsDir(CONV))) rmSync(partsDir(CONV), { recursive: true, force: true }); };

beforeEach(wipe);
after(wipe);

describe('where the parts live', () => {
  it('is a directory that OUTLIVES the session, not a scratch path', () => {
    // The whole defect in one assertion. A per-session scratch directory is wiped between sessions, which
    // is the moment the parts matter; `benchmarks/.cache/` is gitignored and already holds the pinned
    // corpus, so it is where a thing that must survive and must not be committed already goes.
    assert.match(PARTS_ROOT.replace(/\\/g, '/'), /^benchmarks\/\.cache\//);
    assert.match(partsDir(CONV).replace(/\\/g, '/'), new RegExp(`/${CONV}$`));
  });
});

describe('the resume point', () => {
  it('with nothing written, starts at part 1', () => {
    const r = resumePoint(CONV, SHA);
    assert.deepEqual(r.done, []);
    assert.equal(r.next, 1);
    assert.equal(r.of, null, 'nothing has declared how many parts there are yet');
  });

  it('with parts 1 and 2 of 4, the next one is 3', () => {
    write(1); write(2);
    const r = resumePoint(CONV, SHA);
    assert.deepEqual(r.done, [1, 2]);
    assert.equal(r.of, 4);
    assert.equal(r.next, 3);
  });

  it('with a HOLE, the next one is the hole and not the end', () => {
    // A death between writing part 2 and part 3 is the ordinary case; a death that left 1 and 3 is rarer and
    // is the one a naive `max + 1` gets wrong, producing a merge that refuses with a missing part and a
    // reader who cannot tell which.
    write(1); write(3);
    assert.equal(resumePoint(CONV, SHA).next, 2);
  });

  it('says so when every part is there', () => {
    for (const i of [1, 2, 3, 4]) write(i);
    const r = resumePoint(CONV, SHA);
    assert.equal(r.next, null, 'nothing is left to write');
    assert.equal(r.complete, true);
  });
});

describe('the guard: a resume must not splice two rounds', () => {
  it('REFUSES parts written under a different prompt', () => {
    // The reason this is a module. Parts survive a session, so they survive a prompt change — and a merge
    // would stamp today's fingerprint on a file half of which was written under yesterday's rules.
    write(1);
    write(2, { producedBy: { promptSha256: OTHER_SHA, unattended: true } });
    assert.throws(() => resumePoint(CONV, SHA), /prompt/i);
  });

  it('refuses parts left over from an EARLIER round, even when they agree with each other', () => {
    // The commoner shape: nobody changed the prompt mid-round, but the directory still holds last week's
    // parts. They are internally consistent, which is what makes them dangerous.
    write(1); write(2);
    assert.throws(() => resumePoint(CONV, OTHER_SHA), /prompt/i);
  });

  it('refuses a part that names a different conversation', () => {
    write(1, { conversationId: 'conv-99' });
    assert.throws(() => resumePoint(CONV, SHA), /conv-99/);
  });

  it('refuses parts that disagree about how many there are', () => {
    write(1); write(2, { part: { index: 2, of: 3 } });
    assert.throws(() => resumePoint(CONV, SHA), /of 4|of 3/);
  });

  it('REFUSES a SHORTENED fingerprint, and says that is what it is', () => {
    /*
     * This happened, on the first real run, and the refusal that caught it was unreadable.
     *
     * `bench.mjs status` prints the fingerprint abbreviated for the table; two extractors copied what they
     * saw onto their parts. The check correctly refused them — and its message abbreviated BOTH sides to
     * twelve characters, so it read "written under prompt a3e8136cc402 and the prompt now is a3e8136cc402".
     * A reader cannot act on that; it reads as the check itself being broken.
     */
    write(1, { producedBy: { promptSha256: SHA.slice(0, 12), unattended: true } });
    assert.throws(() => resumePoint(CONV, SHA), (e) => {
      assert.match(e.message, /not a sha256/, 'a short value is malformed, not a different prompt');
      assert.match(e.message, new RegExp(SHA), 'the full current fingerprint must be in the message to copy');
      return true;
    });
  });

  it('a genuine mismatch prints BOTH in full, so the two can be told apart', () => {
    write(1, { producedBy: { promptSha256: OTHER_SHA, unattended: true } });
    assert.throws(() => resumePoint(CONV, SHA), (e) => {
      assert.match(e.message, new RegExp(OTHER_SHA));
      assert.match(e.message, new RegExp(SHA));
      return true;
    });
  });

  it('refuses a part with no provenance rather than assuming it is current', () => {
    // Absence must not read as "written under the current prompt" — the run that would misreport is the run
    // that leaves it out, which is the same asymmetry `producedBy.unattended` is built on.
    write(1, { producedBy: undefined });
    assert.throws(() => resumePoint(CONV, SHA), /prompt|producedBy/i);
  });

  it('refuses a part whose file is not readable as JSON, rather than skipping it', () => {
    // A truncated part is exactly what a killed process leaves behind, and skipping it would silently
    // restart that part while an unreadable file sat beside the good ones waiting to break the merge.
    mkdirSync(partsDir(CONV), { recursive: true });
    writeFileSync(join(partsDir(CONV), 'part1.json'), '{"conversationId": "conv-test-res');
    assert.throws(() => resumePoint(CONV, SHA), /part1|unreadable|JSON/i);
  });
});
