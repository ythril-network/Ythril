/**
 * The index-readiness poll must list search indexes UNFILTERED and match by name.
 *
 * ## The evidence
 *
 * A deployment reported **~67 seconds per index on an instance with almost no data** — the same cost as
 * one with thirteen full spaces. Five spaces in, 24 indexes, ~27 minutes. A build that is genuinely
 * instant cannot take a fixed 67s. That is the 60s timeout expiring every single time, which means the
 * poll never observed READY at all, on indexes that were fine.
 *
 * The cause is one overload. `ensureVectorIndex` lists **without** a filter and finds by name, and that
 * call demonstrably works — it is how an existing index is detected for the update path. The two callers
 * that used `listSearchIndexes(indexName)` are exactly the two that misbehaved:
 *
 *   - `pollVectorIndexReady` — never saw READY, so every wait ran to timeout.
 *   - `pipeline-status` — `found[0]?.status` was always null, and `deriveLiveIndexState` turns a null
 *     status into **missing**, so the Indexing panel declared every index absent on a healthy instance.
 *
 * Listing all and matching by name is a strict superset of the filtered behaviour, so it cannot be worse
 * on a deployment where the filter did work.
 *
 * ## Why a source-level gate
 *
 * Reproducing it needs a live mongot that behaves this way, which CI's Atlas Local may or may not. The
 * regression is a one-token change back to the filtered overload, and its symptom is a *slow* run rather
 * than a failing one — the signature that let it survive two rounds of investigation.
 *
 * Run: node --test testing/standalone/index-ready-poll.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { enclosingBlockAround, bodyOfEndingWith, bodyOf, statementAround, statementFrom }
  from './_structural-window.mjs';

const ROOT = 'server/src';

function sources(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) { sources(p, out); continue; }
    if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Source with comment lines stripped — the fix is explained in comments that name the banned call. */
function codeOf(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
    .join('\n');
}

describe('search-index listing is never name-filtered', () => {
  it('no caller passes a name to listSearchIndexes', () => {
    const all = sources();
    // Floor the enumeration. Without this a broken walk yields no files, no offenders, and a green gate that
    // examined nothing — the exact failure this lens pass went looking for.
    assert.ok(all.length > 100, `only walked ${all.length} source files`);
    const offenders = [];
    for (const f of all) {
      const code = codeOf(f);
      code.split('\n').forEach((line, i) => {
        // Anything other than an empty argument list.
        const m = /listSearchIndexes\(\s*[^)\s]/.exec(line);
        if (m) offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(offenders, [],
      'the name-filtered overload returned nothing on a real deployment, so readiness polls ran to ' +
      'timeout every time and the index panel reported every index missing. List unfiltered and match ' +
      'by name:\n' + offenders.join('\n'));
  });

  it('the poll matches by name and accepts queryable as ready', () => {
    const src = readFileSync(`${ROOT}/spaces/vector-index.ts`, 'utf8');
    /*
     * Bounded STRUCTURALLY — the whole function, to the next top-level declaration — rather than by `at + 3000`.
     * A character window spans different lines on CRLF than on LF, and it silently shrinks whenever the function
     * grows: adding the terminal-absence branch pushed the statement below past 3000 characters and this assertion
     * started failing on code that was correct.
     *
     * This is now the SHARED bound. The loop that used to sit here was one of three independent hand-rolls of it,
     * written within hours of each other, which is what `_structural-window.mjs` was extracted for. `bodyOf` alone
     * would do; `bodyOfEndingWith` also carries the "the window reached the end of its subject" assertion that used
     * to be spelled out below, and having it inside the helper means every caller gets it.
     */
    const body = bodyOfEndingWith(src, 'pollVectorIndexReady', 'gave up after');
    assert.match(body, /all\.find\(i => i\.name === indexName\)/);
    // `queryable` is the property recall actually depends on; a mongot reporting it without a READY
    // status would otherwise poll forever.
    assert.match(body, /current\.status === 'READY' \|\| current\.queryable === true/);
  });

  it('the poll reports WHAT it saw, not just that it gave up', () => {
    // Two rounds of this bug produced no evidence about the cause, because the poll swallowed every
    // observation and logged only "did not reach READY within 60s". The operator could see the cost and
    // never the reason.
    const src = readFileSync(`${ROOT}/spaces/vector-index.ts`, 'utf8');
    assert.match(src, /lastSeen/);
    assert.match(src, /still waiting after/);
    assert.match(src, /gave up after/);
    assert.match(src, /index not present/,
      '"index missing" and "index not ready" are different failures and must not read the same');
  });

  it('pipeline-status lists each collection once, not once per expected index', () => {
    // `files` carries two indexes (embedding + faceEmbedding); listing it per-entry doubled the mongot
    // round-trips for no benefit.
    const src = readFileSync(`${ROOT}/api/pipeline-status.ts`, 'utf8');
    assert.match(src, /byCollection/);
    assert.match(src, /all\.find\(i => i\.name === e\.indexName\)/);
  });

  it('a backend that reports NO lifecycle fields is probed, not failed', () => {
    // The 2.2.1 report. On a self-hosted replica set the index document is found by name and carries
    // neither `status` nor `queryable` — their log said `status=undefined queryable=undefined`, which
    // is only reachable AFTER the name match. The exit condition was `status === 'READY' || queryable
    // === true`, so that backend could never satisfy it: 600 s per index, then every space on a
    // five-instance fleet marked failed while recall returned genuine scores and /ready passed.
    //
    // Absence of a status field is not evidence of an unready index. It is the same mistake the
    // model-enumeration check used to make one layer up, where "not listed" was read as "not present".
    const src = readFileSync(`${ROOT}/spaces/vector-index.ts`, 'utf8');
    assert.match(src, /current\.status === undefined && current\.queryable === undefined/,
      'the poll must recognise a backend that reports neither field');
    assert.match(src, /await indexServes\(/,
      'and answer the question directly instead of waiting for a field that will never arrive');
  });

  it('the probe asks the question recall asks', () => {
    // Not a metadata read dressed up as a probe: it runs `$vectorSearch` against the index by name. That
    // is what recall depends on, and it is Verify's philosophy applied one layer down — send one real
    // request rather than infer from a status field.
    const src = readFileSync(`${ROOT}/spaces/vector-index.ts`, 'utf8');
    // `indexOf(…) + 900` is the same magic window with the anchor inlined, and the ratchet's pattern did not match
    // it because the pattern required a bare identifier on both sides. Widened, and this is the bound it wanted.
    // The question is asked by `askIndexOnce` (Q-696: it keeps the count of records the index served), and `indexServes` is the
    // poll's reading of that one answer: so the shape is pinned on the former, and the latter must be built on it.
    const fn = bodyOf(src, 'askIndexOnce');
    assert.match(bodyOf(src, 'indexServes'), /await askIndexOnce\(/, 'the poll must ask the one probe, not spell a second copy of it');
    assert.match(fn, /\$vectorSearch/, 'the probe must be a real vector query');
    assert.match(fn, /index: indexName/, 'against the index being polled, by name');
    assert.match(fn, /limit: 1/, 'and cheap — this is a liveness question, not a search');
    // AND ABOUT THE RIGHT FIELD. This file passed for five releases with the three assertions above and
    // without this one, which is the whole lesson: "a real vector query, cheap, against the named index"
    // was true of a probe that could never succeed. A satisfied check is the strongest reason not to look
    // further. See the block at the bottom of this file.
    assert.match(fn, /path: target\.vectorPath/,
      'the probe must ask about the field the index indexes, not about a literal');
  });

  it('the probe runs ONLY when both fields are absent', () => {
    // A backend that does report them must pay nothing. The reporter's platform instance has 65 indexes;
    // a probe each at boot is not free, and the cheap path is still correct where it works.
    const src = readFileSync(`${ROOT}/spaces/vector-index.ts`, 'utf8');
    const readyExit = src.indexOf("current.status === 'READY' || current.queryable === true");
    const probeGuard = src.indexOf('current.status === undefined && current.queryable === undefined');
    assert.ok(readyExit > 0 && probeGuard > readyExit,
      'the fast path must be tried first, and the probe reached only when neither field is present');
  });

  it('the boot summary cannot claim success while a space failed', () => {
    // `Vector index readiness confirmed for all spaces.` printed unconditionally — on their deployment,
    // immediately after two lines saying the opposite. A log that contradicts itself two lines apart
    // does not merely fail to inform; it teaches the operator that this log is not worth reading.
    // Comments stripped first: the prose ABOVE the fix quotes the old wording, so a naive search
    // finds the explanation rather than the code and reports the fix as missing.
    const src = readFileSync(`${ROOT}/spaces/lifecycle.ts`, 'utf8')
      .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const at = src.indexOf('readiness confirmed for all');
    assert.ok(at > 0, 'the summary line should still exist for the all-good case');
    // The branch the summary sits in, INCLUDING the line that opened it — the condition is the whole subject here,
    // and it lives outside the braces. A count backwards could start inside the block and miss it.
    const before = enclosingBlockAround(src, at, 'the all-good summary branch');
    assert.match(before, /failed\.length === 0/,
      'the success wording must be conditional on nothing having failed');
    assert.match(src, /did not reach ready for \$\{failed\.length\}/,
      'and the failure case must name how many, and which');
  });
});

/**
 * The probe asks about the field the index INDEXES, and at the width it was BUILT at.
 *
 * ## The defect, and how a passing spec hid it
 *
 * `indexServes` hardcoded `path: 'embedding'` and took its width from `getEmbeddingConfig().dimensions`.
 * Correct for the five text indexes. Wrong for the face gallery, which indexes `faceEmbedding` at 128. So on
 * every space, every second, for the full 600 s window:
 *
 *     Vector search index <space>_files_faceEmbedding: gave up after 600s
 *       — probe did not serve: ... :: caused by :: embedding is not indexed as vector
 *
 * **The probe could not succeed, so its answer carried no information.** The canary operator read those lines
 * off a live pod on 2026-08-20, concluded no face index had ever been built, and stopped a configuration
 * change on it. The index may have been READY the whole time.
 *
 * The test above asserted the probe was "a real vector query, against the named index, cheap". All three were
 * true. None of them is the question. That is why this block asserts the FIELD and the WIDTH, and asserts them
 * per call site rather than once: the bug was not in the probe's shape, it was in what two callers failed to
 * tell it.
 *
 * `ensureVectorSearchIndex` had both values — it built the definition from them — and did not pass them on.
 * Worth naming as a shape: the caller held the answer and the callee guessed.
 */
describe('the probe is told what to ask about, per call site', () => {
  const src = readFileSync(`${ROOT}/spaces/vector-index.ts`, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('nothing hardcodes a vector path in the probe path any more', () => {
    // Comments stripped above, deliberately: the account of the defect quotes the old literal, and a naive
    // search would find the explanation and report the fix as missing.
    assert.doesNotMatch(src, /path: 'embedding'/,
      "a literal path in this file is the defect returning — pass a ProbeTarget");
    for (const probe of ['askIndexOnce', 'indexServes']) {
      assert.doesNotMatch(bodyOf(src, probe), /getEmbeddingConfig\(\)/,
        `the probe (${probe}) must not reach for the TEXT embedding width; the face gallery is not that width`);
    }
  });

  it('the target is REQUIRED, not defaulted', () => {
    // A default would be the bug again, silently: the face caller would inherit `embedding`/768 and go back to
    // reporting a working index as failed. Required means a new index whose path nobody thought about fails to
    // compile rather than fails to probe.
    const sig = bodyOf(src, 'pollVectorIndexReady');
    assert.match(sig, /target: ProbeTarget,/,
      'pollVectorIndexReady must take a ProbeTarget with no default');
    assert.doesNotMatch(sig, /target: ProbeTarget = /, 'a default here reintroduces the silent inheritance');
  });

  it('every call site names its target — none is left to guess', () => {
    /*
     * PER SITE, not two global counts. The first version of this counted `pollVectorIndexReady(` against
     * `vectorPath:` and was wrong in both directions at once: the count of calls included the function's own
     * DECLARATION, and the count of targets included the `ProbeTarget` interface field plus missed the two
     * sites that pass the shorthand `{ vectorPath, dims: numDimensions }` — no colon, same argument.
     *
     * Two totals that happen to match prove nothing about which site matched which. Resolving each call's own
     * statement asks the question directly, and the anti-vacuity floor below is what stops it passing on zero.
     */
    // A NEGATIVE LOOKBEHIND, not a backwards slice. The first version wrote
    // `src.slice(Math.max(0, m.index - 20), m.index)` to skip the declaration — which is precisely the
    // backwards magic window `gates-bound-their-subject-structurally` refuses, and it refused this file. A
    // lookbehind asks the same question with no number in it.
    const calls = [...src.matchAll(/(?<!function )pollVectorIndexReady\(/g)];
    assert.ok(calls.length >= 4,
      `expected the poll to be called from several places, found ${calls.length}`);
    const guessing = calls
      .filter(m => !/vectorPath/.test(statementFrom(src, m.index, 'a pollVectorIndexReady call')))
      .map(m => `line ${src.slice(0, m.index).split('\n').length}`);
    assert.deepEqual(guessing, [],
      'these calls do not name the field to probe, so the probe guesses — and guessing wrong is the defect '
      + `this gate exists for:\n  ${guessing.join('\n  ')}`);
  });

  it('the FACE caller names faceEmbedding, which is the whole point', () => {
    const at = src.indexOf("pollVectorIndexReady(spaceId, 'files', faceIndexName");
    assert.ok(at > -1, 'the face gallery poll is gone — re-anchor this gate');
    // The statement the call sits in, bounded structurally: a character window could not tell "this call's
    // argument" from "a faceEmbedding mentioned on the next line", and those differ by exactly the defect.
    assert.match(statementAround(src, at, 'the face gallery poll'), /vectorPath: 'faceEmbedding'/,
      'the face poll must probe faceEmbedding — probing `embedding` is what made it always fail');
  });

  it('and the face width comes from the same two places the INDEX is built from', () => {
    // `initSpace` builds at `space.faceDescriptorDims ?? FACE_DESCRIPTOR_DIMS`. The probe must resolve the
    // width identically or it asks about a real field with a wrong-width vector, which fails just as
    // uninformatively. Two copies of one resolution is this repo's most-produced defect, so both are pinned.
    const at = src.indexOf('faceDims');
    assert.ok(at > -1, 'the face width is no longer resolved for the probe');
    const resolution = statementAround(src, at, 'the face width resolution');
    assert.match(resolution, /faceDescriptorDims/, "it must read the space's own width");
    assert.match(resolution, /FACE_DESCRIPTOR_DIMS/, 'and fall back to the same constant initSpace does');
  });
});
