/**
 * Every JSON API route returns `{ error }` — and the two surfaces that deliberately do not are named.
 *
 * ## The stated contract
 *
 * `docs/integration-guide/03-auth-and-limits.md`, under **Error Format**:
 *
 * > All errors return JSON:
 * > `{ "error": "Human-readable message" }`
 *
 * ## The finding was the documentation, not the code
 *
 * The contract is held everywhere it should be — every route handler, the API 404, all six rate limiters (each
 * with `message: { error }` and a handler that JSONs it), and the global error middleware. Two surfaces return
 * something else, **both correctly**:
 *
 *  - `api/metrics.ts` — a `401` and a `500` as Prometheus comment lines. A scraper does not parse JSON, and `#`
 *    is a comment in the exposition format, so the error degrades into something the consumer can read.
 *  - `setup/routes.ts` — a `404` and a `400` as text/HTML. First-run setup WAS a server-rendered flow that
 *    existed *before* the SPA did; its consumer was a browser, and a JSON body would have rendered as raw text.
 *    **4.0 removed that form**, so this file answers only in JSON now and its exemption is gone. It is left
 *    described here because the reasoning is what a future exemption gets judged against.
 *
 * So "all errors return JSON" was simply false, and the fix was to say what is actually true. The word "all" in a
 * contract is the part an integrator relies on.
 *
 * ## Why the gate is the more valuable half
 *
 * The two exceptions are fine. A **third** one appearing without anybody deciding it should is not — that is how
 * a contract erodes: each individual case is defensible in isolation, and no one is looking at the set. This gate
 * makes the exemption list the place that decision has to be written down.
 *
 * Run: node --test testing/standalone/error-shape-is-json.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DOC = 'docs/integration-guide/03-auth-and-limits.md';

/**
 * Surfaces allowed to answer an error with something other than JSON, and why.
 *
 * The reason is part of the entry on purpose: an exemption whose justification is not written down is
 * indistinguishable from an oversight the next reader will preserve out of caution.
 */
const NOT_JSON = [
  {
    file: 'server/src/api/metrics.ts',
    why: 'Prometheus exposition format — a scraper does not parse JSON, and `#` is a comment line, so the error '
      + 'degrades into something the consumer can actually read',
  },
  /*
   * `server/src/setup/routes.ts` used to be here, and its exemption was genuine: first-run setup was a
   * server-rendered HTML flow whose consumer was a browser, so a JSON body would have rendered as raw text.
   *
   * 4.0 removed the form. What is left — `GET /status` and `POST /json` — has only ever answered in JSON,
   * so the exemption stopped being true rather than stopped being needed. Removing it is the interesting
   * direction for a list like this: an exemption that is no longer earned is a hole nobody is watching,
   * because a file on this list is a file the rule does not apply to.
   */
];

/**
 * Every .ts under server/src, tracked and untracked-but-not-ignored.
 *
 * It used to spell two pathspecs, because `server/src/**` requires at least one directory level and a single
 * pattern silently excluded `server/src/app.ts` and `server/src/index.ts` — where the global error middleware
 * and half the admin handlers live. The gate reported clean while never looking at them. A directory rather
 * than a glob has no such edge, and the shared helper is now the one place that has to know it.
 */
function sourceFiles() {
  return trackedSources(SERVER_CODE_ROOTS, { untracked: true });
}

/** Comments stripped line-first, so the gate cannot fire on the prose that documents it. */
function code(path) {
  return readFileSync(join(ROOT, path), 'utf8')
    .split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/**
 * `res.status(4xx|5xx)` followed by anything other than `.json(`.
 *
 * **A FUNCTION, not a shared const, and that is load-bearing.** The first version was a module-level global
 * regex. `assert.match` calls `RegExp.prototype.test`, which advances `lastIndex` on a `/g` regex, and
 * `String.matchAll` copies `lastIndex` into its clone — so the three assertions in the detector self-test left
 * the cursor mid-string and the sweep that ran next started from there and found nothing.
 *
 * The gate reported clean on a real injected violation because of it. **The self-test poisoned the very sweep it
 * existed to validate**, which is only detectable by mutation: every test passed, on code with a planted bug.
 */
const nonJsonError = () => /res\s*\.\s*status\(\s*[45]\d\d\s*\)\s*\.\s*(send|end|type|sendFile|render)\b/g;

describe('the sweep works before it is trusted', () => {
  it('the detector can see a non-JSON error response', () => {
    // A gate whose detector is never exercised passes because it found nothing, which is indistinguishable from
    // passing because there was nothing to find.
    assert.match("res.status(500).send('nope');", nonJsonError());
    assert.doesNotMatch("res.status(500).json({ error: 'nope' });", nonJsonError());
    // A 2xx send is not an error response and must not be flagged.
    assert.doesNotMatch("res.status(200).send('<html>');", nonJsonError());
  });

  it('every exempted file exists and still contains a non-JSON error', () => {
    // An exemption for something that has been fixed is an exemption that will one day cover something else.
    for (const { file } of NOT_JSON) {
      const src = code(file);
      assert.ok(src.length > 0, `${file} is exempted here but does not exist`);
      assert.match(src, nonJsonError(),
        `${file} no longer returns a non-JSON error — remove it from the exemption list`);
    }
  });

  it('every exemption states a reason', () => {
    for (const e of NOT_JSON) {
      assert.ok(e.why && e.why.length > 40,
        `${e.file} is exempted without a real reason; an unjustified exemption reads as an oversight`);
    }
  });
});

describe('every JSON API route answers an error with { error }', () => {
  it('no unexempted file returns a non-JSON error response', () => {
    const exempt = new Set(NOT_JSON.map(e => e.file));
    const offenders = [];
    for (const f of sourceFiles()) {
      if (exempt.has(f)) continue;
      const src = code(f);
      for (const m of src.matchAll(nonJsonError())) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${f}:${line} — .${m[1]}()`);
      }
    }
    assert.deepEqual(offenders, [], 'these answer an error with something other than JSON, which the integration '
      + `guide says never happens:\n  ${offenders.join('\n  ')}\n\n`
      + 'Either return `{ error }`, or add the file to NOT_JSON in this test **with the reason** — that list is '
      + 'where the decision has to be written down.');
  });
});

describe('the contract and the gate move together', () => {
  it('the guide states the shape and does NOT claim it is universal', () => {
    const doc = readFileSync(join(ROOT, DOC), 'utf8');
    assert.match(doc, /\{ "error": "Human-readable message" \}/,
      'the documented error shape is gone, but this gate still enforces it');
    // The original wording was "All errors return JSON", which was false for two surfaces. A contract an
    // integrator relies on must not overclaim — the word "all" was the whole problem.
    assert.doesNotMatch(doc, /^All errors return JSON/m,
      'the guide claims ALL errors are JSON again. /metrics returns Prometheus text and first-run setup returns '
      + 'HTML, both deliberately — so the universal claim is false and an integrator would code against it');
  });

  it('the guide names both exceptions, so the gate is not the only place they are recorded', () => {
    const doc = readFileSync(join(ROOT, DOC), 'utf8');
    assert.match(doc, /\/metrics/, 'the guide does not mention that /metrics answers in Prometheus text');
    assert.match(doc, /setup/i, 'the guide does not mention that first-run setup answers in HTML');
  });
});
