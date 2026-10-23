/**
 * `scripts/test-times.mjs --record` keeps the payload on disk when the record lock cannot be placed (Q-590 pre-ship lens, L1).
 *
 * ## What this prevents
 *
 * The recorder's promise is that a recording problem loses nothing: with no URL, an instance that answers 500 or one that is not
 * there, the payload is written to `test-results/unrecorded/`, one exact line says why, and the next `--record` drains it. The
 * lock moved into the git common dir, whose path is asked of git. When git cannot answer, `withRecordLock` throws, and that
 * throw reached the catch that prints `not recorded: <why>` and returns, with NO file written: the one failure whose record was
 * dropped. A lock that cannot be placed is a lock problem like a lock held too long, and both keep the payload.
 *
 * The scene is made with `fake-gh-and-git-preload.mjs`, whose `commonDir: null` answers `git rev-parse --git-common-dir` as git
 * does outside a repository; every other git question (the run's commit, branch and cleanliness) goes to the real git of the
 * scratch repository.
 *
 * Run: node --test testing/standalone/test-times-keeps-a-record-when-the-lock-cannot-be-placed.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeYthril } from '../_shared/fake-ythril-tool-server.mjs';
import { makeWorkdir, writeResults, runTimes, everything, T } from '../_shared/test-times-harness.mjs';

const PRELOAD = pathToFileURL(resolve(import.meta.dirname, '..', '_shared', 'fake-gh-and-git-preload.mjs')).href;

describe('a recording whose lock cannot be placed', () => {
  it('keeps the payload in test-results/unrecorded and says so in the one exact line, exit 0, nothing sent', async () => {
    const server = await startFakeYthril();
    const work = makeWorkdir();
    const scratch = mkdtempSync(join(tmpdir(), 'test-times-no-lock-'));
    try {
      const fixture = join(scratch, 'fixture.json');
      writeFileSync(fixture, JSON.stringify({ commonDir: null }));
      writeResults(work.dir, { suite: 'standalone', batch: 'pure', files: [{ file: 'testing/standalone/a.test.js', ms: 1000, tests: [T('t1', 1000)] }] });
      const r = await runTimes(['--record'], {
        cwd: work.dir, nodeArgs: ['--import', PRELOAD],
        env: { YTHRIL_TEST_RUNS_URL: server.url, YTHRIL_TEST_RUNS_TOKEN: server.token, FAKE_GH_GIT_FIXTURE: fixture, FAKE_GH_GIT_LOG: join(scratch, 'calls.jsonl') },
      });
      assert.equal(r.code, 0, everything(r));
      const folder = join(work.dir, 'test-results', 'unrecorded');
      assert.ok(existsSync(folder), `nothing was kept: ${everything(r)}`);
      const kept = readdirSync(folder).filter(f => f.endsWith('.json'));
      assert.equal(kept.length, 1, 'one payload per suite');
      const line = everything(r).split(/\r?\n/).find(l => /^test-times: not recorded: /.test(l) && l.includes('kept'));
      assert.match(line ?? '', /^test-times: not recorded: \S.*; kept test-results\/unrecorded\/\S+\.json$/, everything(r));
      assert.ok(line.includes(kept[0]), 'the line names the file that exists');
      assert.deepEqual(server.calls, [], 'nothing reached the instance');
    } finally {
      await server.close();
      work.cleanup();
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
