/**
 * The assist model's fallback answers the SAME call the primary could not, and a spent budget moves calls to it
 * (`F-33`) — through a loaded config, the way the callers meet it.
 *
 * `viaAssist` is where the three parts a hand-written copy drops live: the charge, the cooldown, the second attempt.
 * A primary that answers "not now" (unreachable, 429, 529, a 5xx) is passed over and the call is made again on the
 * fallback; one that answers "not this" (a 4xx) is the request's fault, so it is thrown as it came and nothing
 * switches. A success is charged to the budget, and a budget spent inside its window hands calls to the fallback.
 *
 * And the stall floor: a step that can try the primary and then the fallback costs BOTH, as the media provider chain
 * does (`a-fallback-chain-is-one-hop`), so `hopBudgets()` must be fed the chain, not one leg.
 *
 * Run: node --test testing/standalone/the-assist-model-answers-on-its-fallback.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripComments } from './_strip-comments.mjs';

// CONFIG_PATH is read when the loader is first evaluated: set it, and the data root the usage lives in, first.
const dir = mkdtempSync(join(tmpdir(), 'ythril-assist-fb-'));
process.env['CONFIG_PATH'] = join(dir, 'config.json');
process.env['DATA_ROOT'] = dir;
const HOST = 'api.example.com';
writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
  instanceId: 'assist-fb', instanceLabel: 'test', tokens: [], networks: [], spaces: [],
  mediaEmbedding: { documentProcessing: { assistModel: {
    baseUrl: `https://${HOST}/v1`, model: 'big', acknowledgedHost: HOST, acknowledgedHostForConversations: HOST,
    budget: { tokens: 1000, perHours: 1 },
    fallback: { baseUrl: 'http://ollama:11434', model: 'small' },
  } } },
}, null, 2), { mode: 0o600 });

let viaAssist, assistBackend, recordAssistOutcome, assistHopMs, PRIMARY_COOLDOWN_MS;
before(async () => {
  (await import('../../server/dist/config/loader.js')).loadConfig();
  ({ viaAssist, assistBackend, recordAssistOutcome, assistHopMs, PRIMARY_COOLDOWN_MS } =
    await import('../../server/dist/config/assist-backend.js'));
});

const fail = (status) => Object.assign(new Error(`HTTP ${status}`), status === undefined ? {} : { status });

describe('the budget', () => {
  it('a success is charged, and a budget spent in the window hands calls to the fallback', () => {
    const t = Date.now() + 10 * 60_000;                   // clear of any cooldown the other cases set
    assert.equal(assistBackend('conversations', t)?.which, 'primary');
    recordAssistOutcome({ which: 'primary' }, { ok: true, usage: { total_tokens: 1200 }, chars: 0 }, t);
    assert.equal(assistBackend('conversations', t)?.which, 'fallback');
    assert.equal(assistBackend('conversations', t + 2 * 3_600_000)?.which, 'primary', 'the window rolls on');
  });

  it('a fallback call costs the budget nothing', () => {
    const t = Date.now() + 5 * 3_600_000;
    recordAssistOutcome({ which: 'fallback' }, { ok: true, usage: { total_tokens: 1_000_000 }, chars: 0 }, t);
    assert.equal(assistBackend('conversations', t)?.which, 'primary');
  });
});

describe('one call, two endpoints', () => {
  it('"not now" from the primary: the same call is answered by the fallback, and the primary cools down', async () => {
    const seen = [];
    const value = await viaAssist('conversations', { which: 'primary', baseUrl: `https://${HOST}/v1`, model: 'big' }, async ep => {
      seen.push(ep.which);
      if (ep.which === 'primary') throw fail(529);
      return { value: `from ${ep.model}`, chars: 10 };
    });
    assert.equal(value, 'from small');
    assert.deepEqual(seen, ['primary', 'fallback']);
    assert.equal(assistBackend('conversations')?.which, 'fallback', 'the primary is passed over while it cools down');
    assert.equal(assistBackend('conversations', Date.now() + PRIMARY_COOLDOWN_MS + 1_000)?.which, 'primary');
  });

  it('unreachable counts as "not now" too', async () => {
    const seen = [];
    await viaAssist('repair', { which: 'primary', baseUrl: `https://${HOST}/v1`, model: 'big' }, async ep => {
      seen.push(ep.which);
      if (ep.which === 'primary') throw fail(undefined);
      return { value: 'ok', chars: 1 };
    });
    assert.deepEqual(seen, ['primary', 'fallback']);
  });

  it('"not this" (a 4xx) is thrown as it came, and the fallback is never asked', async () => {
    const seen = [];
    await assert.rejects(viaAssist('conversations', { which: 'primary', baseUrl: `https://${HOST}/v1`, model: 'big' }, async ep => {
      seen.push(ep.which);
      throw fail(422);
    }), /HTTP 422/);
    assert.deepEqual(seen, ['primary']);
  });
});

describe('the stall floor sees the chain', () => {
  it('a step that can try both endpoints costs both', () => {
    assert.equal(assistHopMs(60_000, true), 120_000);
    assert.equal(assistHopMs(60_000, false), 60_000);
  });

  it('hopBudgets feeds the chain for the assist slot and the describe step', () => {
    const src = stripComments(readFileSync('server/src/files/media/worker.ts', 'utf8'));
    assert.match(src, /assistMs:\s*assistHopMs\(/, 'the assist slot is fed one leg while a step can cost two');
    assert.match(src, /describeTimeoutMs:\s*assistHopMs\(/, 'the describe step is fed one leg while it can cost two');
  });
});
