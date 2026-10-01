/**
 * A background config write survives a transient read error instead of abandoning what it was recording.
 *
 * ## What happened
 *
 * `finalizeSpaceIndexReady` waits for a new space's vector indexes and then records `indexStatus: 'ready'` with
 * `mutateConfig`, which re-reads config.json first so an edit made while it polled is not erased. On Docker
 * Desktop the config is a bind mount, and a read that lands while the host is rewriting the file fails with
 * `ENODATA`. The finalisation took that first failure as final: the space stayed `building` until the next
 * restart, and `config-write-safety`'s readiness case failed every time the timing lined up (verifying `Q-99`
 * part 3, 2026-10-01: 1 in 6 on a fresh stack, every run after the full suites).
 *
 * ## The rule
 *
 * A read error that a concurrent writer causes is retried, a bounded number of times; any other error is
 * thrown at once, because retrying a real fault only delays reporting it. And the background writers that
 * record a status go through the retrying form — asserted on the one that failed, by its call.
 *
 * Run: node --test testing/standalone/a-config-write-outlasts-a-transient-read-error.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-config-transient-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let loader, retrying;
const realRead = fs.readFileSync;
let failNext = 0;
let failCode = 'ENODATA';

function transientError(code) {
  const err = new Error(`${code}: no data available, read`);
  err.code = code;
  return err;
}

describe('a config write outlasts a transient read error', () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'transient-read-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    retrying = await import('../../server/dist/config/mutate-config-retrying.js');
    fs.readFileSync = function maybeFail(p, ...rest) {
      if (failNext > 0 && path.resolve(String(p)) === path.resolve(CONFIG_PATH)) {
        failNext -= 1;
        throw transientError(failCode);
      }
      return realRead.call(this, p, ...rest);
    };
  });

  after(() => {
    fs.readFileSync = realRead;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a read that fails with ENODATA twice is retried, and the change is written', async () => {
    failNext = 2; failCode = 'ENODATA';
    await retrying.mutateConfigRetrying(cfg => { cfg.spaces[0].label = 'Written after two failed reads'; });
    assert.equal(failNext, 0, 'the simulated failures were not reached — the test checks nothing');
    const stored = JSON.parse(realRead(CONFIG_PATH, 'utf8'));
    assert.equal(stored.spaces[0].label, 'Written after two failed reads',
      'a transient read error abandoned the write');
  });

  it('a fault that is not transient is thrown at once, not retried into a delay', async () => {
    failNext = 1; failCode = 'EACCES';
    await assert.rejects(retrying.mutateConfigRetrying(() => {}), /EACCES/);
    assert.equal(failNext, 0);
  });

  it('a transient error that does not clear is reported, not retried for ever', async () => {
    failNext = 1000; failCode = 'ENODATA';
    await assert.rejects(retrying.mutateConfigRetrying(() => {}), /ENODATA/);
    assert.ok(failNext > 900, `it retried ${1000 - failNext} times — the retries are not bounded`);
    failNext = 0;
  });

  it('the index-readiness finalisation records its status through the retrying form', () => {
    const src = stripComments(fs.readFileSync('server/src/spaces/vector-index.ts', 'utf8'));
    const body = bodyOf(src, 'finalizeSpaceIndexReady');
    assert.match(body, /\bmutateConfigRetrying\(/,
      'finalizeSpaceIndexReady writes its status with a bare mutateConfig — one ENODATA leaves the space building');
    assert.doesNotMatch(body, /(?<!\w)mutateConfig\(/, 'and no bare mutateConfig beside it');
  });
});
