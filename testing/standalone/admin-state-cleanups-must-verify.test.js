/**
 * A cleanup that restores INSTANCE-WIDE state may not swallow its own failure.
 *
 * ## The measured cost
 *
 * `ensureMaintenanceOff` in `db-migration.test.js` was `await adminPost(...).catch(() => {})`. Under CPU
 * contention that request did not get through, the suite exited reporting success, and the 60
 * `pubsub-topology` runs that followed all died at `Create space on A` with
 * `503 System is in maintenance mode`. Sixty runs of a measurement against a stack that could not answer.
 *
 * A suite does not get its own instance. Every suite in a CI job runs against the same stack, so a restore that
 * silently does not happen is not a lost test — it is a later suite failing for a reason that has nothing to do
 * with what it tests, and looking like a catastrophic regression while it does.
 *
 * ## What is banned, and what is deliberately NOT
 *
 * `testing/` holds well over three hundred swallowed cleanups and the overwhelming majority are *delete the
 * record I just made*. Swallowing is CORRECT there: a leftover record costs nothing and the next run uses fresh
 * ids. Converting them would be noise, and noise in a gate is how a gate stops being read.
 *
 * What this refuses is a swallowed write to an `/api/admin/` path — instance-wide configuration — where the
 * blast radius is the whole job. `restoreOrFail` in `testing/sync/helpers.js` is the replacement: it applies,
 * re-reads, retries, and throws with a label naming what could not be restored.
 *
 * ## Why a ratchet rather than an absolute
 *
 * Because it is one now, and the eighth is how the first was found. If a future admin cleanup genuinely must
 * tolerate failure, it goes in the list with the reason beside it — which is a decision somebody made rather
 * than a `.catch(() => {})` nobody noticed.
 *
 * Run: node --test testing/standalone/admin-state-cleanups-must-verify.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { statementAround } from './_structural-window.mjs';
import { stripComments } from './_strip-comments.mjs';
import { restoreOrFail } from '../sync/helpers.js';

/**
 * Files still allowed a swallowed `/api/admin/` write in a cleanup, with how many. **May only shrink.**
 *
 * EMPTY. All seven are converted — six in `media-config.test.js` (vision model, documentProcessing twice,
 * embedding provider/baseUrl, embedding apiKey, assist apiKey) and the backup config in
 * `db-backup-offsite.test.js`, whose own comment had argued it was safe because "the test stack will be re-built
 * before the next run anyway" — true between runs and false within one job, which is where it matters.
 */
const GRANDFATHERED = new Map([
  /*
   * `config-loader.test.js` — `POST /api/admin/reload-config`, and this one is CORRECT as written.
   *
   * The cleanup writes the original config to disk unconditionally FIRST, then asks the instance to reload it.
   * The reload is best-effort on purpose, and the comment beside it says why: the suite deliberately tests
   * configs with the tokens array stripped, so the reload can legitimately answer 401 with auth broken by what
   * the test just did. Throwing there would fail a suite for a state it created on purpose — and the durable
   * half of the restore, the file on disk, has already happened and survives to the next container start.
   *
   * Kept as a row rather than excluded by a pattern, because "a reload is exempt" as a RULE would also exempt
   * the next one that is not.
   */
  ['testing/standalone/config-loader.test.js', 1],
]);

/** Every tracked test file, so a new one cannot arrive unscanned. */
function testFiles() {
  return execFileSync('git', ['ls-files', 'testing'], { encoding: 'utf8' })
    .split('\n')
    .map(f => f.trim())
    .filter(f => /\.(test|spec)\.(js|mjs|ts)$/.test(f));
}

/**
 * Swallowed calls whose STATEMENT touches an `/api/admin/` path.
 *
 * Bounded by the statement rather than by a character window, so a call spread over four lines — which is what
 * these look like after a prettier pass — is still seen whole. The path and the `.catch` are frequently on
 * different lines, and that is exactly the case a proximity window gets wrong.
 */
function swallowedAdminWrites(raw) {
  /*
   * COMMENTS STRIPPED FIRST. This suite documents its own lessons by quoting the banned shape, and the
   * `db-migration.test.js` fix quotes `adminPost(...).catch(() => {})` in the doc comment explaining why it was
   * wrong. Scanning raw source reported that explanation as the defect.
   */
  const src = stripComments(raw);
  const out = [];
  for (const m of src.matchAll(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/g)) {
    /*
     * An anchor inside a STRING is not code and cannot be a swallowed call.
     *
     * `statementAround` refuses an unreachable index rather than guessing, which is right for a gate pointed at
     * one subject and wrong for a sweep over a whole tree: `red-team-tests/file-hardening.test.js` contains the
     * shape inside a string literal, and one such literal aborted the entire scan. Skipping is safe here for a
     * reason worth stating — the strings this can match are test fixtures and assertion text, never a call.
     */
    let stmt;
    try {
      stmt = statementAround(src, m.index, 'a swallowed call');
    } catch {
      continue;
    }
    if (!/['"`]\/api\/admin\//.test(stmt)) continue;
    /*
     * A MUTATION OF A CONFIGURATION VALUE — and `del` is deliberately not one of them.
     *
     * `DELETE /api/admin/webhooks/{id}` is a RECORD delete that happens to sit under an admin path: the test
     * created a webhook and is removing it, so a leftover costs nothing and the next run makes its own. The
     * blast radius this gate is about comes from a VALUE left changed — a model, a mode, a schedule, a flag —
     * which only a patch/put/post can do. Including `del` made the gate report two correct cleanups, and a gate
     * that reports correct code is a gate people learn to override.
     *
     * A read is excluded for the same reason: a failed read gives the caller undefined and the assertion says so.
     */
    if (!/\b(patch|put|post|adminPost|adminPut|adminPatch)\s*\(/.test(stmt)) continue;
    out.push(stmt.replace(/\s+/g, ' ').slice(0, 120));
  }
  return out;
}

describe('the scan works before anything is concluded from it', () => {
  it('walks a real tree', () => {
    const files = testFiles();
    assert.ok(files.length >= 80, `only enumerated ${files.length} test files — the walk is broken`);
  });

  it('recognises the shape it is about, and leaves a READ alone', () => {
    // Proven against literals, so a pattern that silently stopped matching cannot pass as "none left".
    const bad = "await patch(A, tok, '/api/admin/media-config', { vision: {} }).catch(() => {});";
    assert.equal(swallowedAdminWrites(bad).length, 1, 'the banned shape is no longer recognised');

    for (const ok of [
      // A record delete: swallowing is right, and there are hundreds of these.
      "await del(A, tok, `/api/brain/spaces/general/facts/${id}`).catch(() => {});",
      // An admin READ: a failure gives undefined and the assertion says so.
      "const r = await get(A, tok, '/api/admin/media-config').catch(() => {});",
      // The replacement.
      "await restoreOrFail('vision.model', () => patch(A, tok, '/api/admin/media-config', {}), verify);",
    ]) {
      assert.deepEqual(swallowedAdminWrites(ok), [], `false positive on: ${ok}`);
    }
  });
});

describe('no swallowed admin-state cleanup', () => {
  it('every file carrying one is grandfathered, and none has more than its entry', () => {
    const problems = [];
    for (const file of testFiles()) {
      const key = file.replaceAll('\\', '/');
      // This file quotes the banned shape as a fixture; scanning it would force that proof to be deleted.
      if (key.endsWith('admin-state-cleanups-must-verify.test.js')) continue;
      const found = swallowedAdminWrites(readFileSync(file, 'utf8'));
      const allowed = GRANDFATHERED.get(key) ?? 0;
      if (found.length > allowed) {
        problems.push(`${key}: ${found.length} swallowed admin write(s), allowed ${allowed}\n    ${found.join('\n    ')}`);
      }
    }
    assert.deepEqual(problems, [],
      'a cleanup writes instance-wide configuration and discards its own failure. Every suite in a CI job shares\n'
      + 'one stack, so a restore that silently does not happen makes a LATER suite fail for a reason unrelated to\n'
      + 'what it tests. Use `restoreOrFail(label, apply, verify)` from `testing/sync/helpers.js` — it applies,\n'
      + 're-reads, retries and throws naming what it could not restore.\n'
      + problems.join('\n'));
  });

  it('the list only shrinks', () => {
    const stale = [];
    for (const [file, allowed] of GRANDFATHERED) {
      const actual = swallowedAdminWrites(readFileSync(file, 'utf8')).length;
      if (actual < allowed) stale.push(`${file}: allowed ${allowed}, now has ${actual} — lower or remove it`);
    }
    assert.deepEqual(stale, [], 'the grandfathered list is above reality:\n' + stale.join('\n'));
  });
});

describe('the replacement is EXERCISED, not read', () => {
  /*
   * Behaviour, not source text. The first version of this asserted that the string `throw new Error(...Could not
   * restore...` was present — and mutation testing put `if (false)` in front of that throw, which left the text
   * exactly where it was and the gate green. A source-reading assertion about control flow cannot see a guard;
   * a call can.
   */

  it('REJECTS when the value does not come back, naming what it was', async () => {
    let applied = 0;
    await assert.rejects(
      () => restoreOrFail('the thing', async () => { applied++; }, async () => false, { attempts: 2, delayMs: 1 }),
      /Could not restore the thing/,
      'a restore that never takes must fail the suite that broke it',
    );
    assert.equal(applied, 2, 'it must have tried every attempt before giving up');
  });

  it('a failure quotes WHAT it re-read, when the verify says so', async () => {
    /*
     * The instrumentation this exists for. `verify still false after attempt 4` cannot tell a `200` that left the
     * value unchanged from a write that never landed — and on 2026-08-28 a CI failure on a prose-only diff left
     * exactly that message and nothing to work from. A `verify` returning `{ ok, saw }` gets `saw` quoted.
     */
    await assert.rejects(
      () => restoreOrFail('the thing',
        async () => {},
        async () => ({ ok: false, saw: { status: 200, mode: 'ocr', wanted: 'vlm' } }),
        { attempts: 1, delayMs: 1 }),
      err => {
        assert.match(err.message, /re-read/, 'the failure must say it re-read something');
        assert.match(err.message, /"mode":"ocr"/, 'and quote the value, or the next reader has nothing');
        assert.match(err.message, /"wanted":"vlm"/, 'including what it wanted, so the two can be compared');
        return true;
      });
  });

  it('a bare boolean still works, and `{ ok: true }` is a pass', async () => {
    // Most call sites have nothing interesting to report, and forcing an object on all of them would be noise.
    await assert.doesNotReject(() => restoreOrFail('bare true', async () => {}, async () => true));
    await assert.doesNotReject(() => restoreOrFail('object ok', async () => {}, async () => ({ ok: true })));
  });

  it('a TRUTHY object with ok:false is a failure, not a pass', async () => {
    /*
     * The bug an `if (verdict)` would introduce the moment a call site returns `{ ok: false, saw: … }`: an object
     * is truthy, so the helper would report success on the exact shape added to report failure. Pinned because it
     * is invisible — every call site would look correct and every cleanup would silently pass.
     */
    await assert.rejects(
      () => restoreOrFail('truthy but not ok', async () => {}, async () => ({ ok: false, saw: 'nope' }),
        { attempts: 1, delayMs: 1 }),
      /Could not restore truthy but not ok/);
  });


  it('RESOLVES as soon as the verify passes, and stops trying', async () => {
    let applied = 0;
    await restoreOrFail('the thing', async () => { applied++; }, async () => applied >= 2,
      { attempts: 5, delayMs: 1 });
    assert.equal(applied, 2, 'it must stop at the first successful verify, not run every attempt');
  });

  it('a THROWING apply is retried rather than escaping', async () => {
    // The observed failure was a request that did not get through, which is what a retry is for.
    let applied = 0;
    await restoreOrFail('the thing',
      async () => { applied++; if (applied < 3) throw new Error('connection reset'); },
      async () => applied >= 3, { attempts: 5, delayMs: 1 });
    assert.equal(applied, 3);
  });

  it('a 200 that changed nothing is a FAILURE, which is the whole point', async () => {
    /*
     * `reqJson` resolves for every response — it returns `{status, body}` and never rejects on a 4xx/5xx — so
     * "the apply did not throw" is not "the value is back". The first draft of the maintenance fix relied on a
     * try/catch alone and would have read a 503 as a successful restore: the same silence, one layer in.
     */
    await assert.rejects(
      () => restoreOrFail('a value the server ignored', async () => { /* answered 200 */ }, async () => false,
        { attempts: 1, delayMs: 1 }),
      /Could not restore a value the server ignored/,
    );
  });
});
