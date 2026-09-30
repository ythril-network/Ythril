/**
 * The ONE place that loads the local model, now that it loads in another process.
 *
 * ## What moved, and what must not change when it moves
 *
 * `getLocalPipeline` lived in `embedding.ts`, read `process.env` and the loaded config, and logged through the
 * server's logger. `brain/local-pipeline.ts` is what the inference CHILD calls, so it takes its three inputs as
 * arguments (`{ modelId, cacheDir, offline }`) because the child has no loaded config, and reports through a
 * `log(level, message)` callback because a console line written in the child would bypass the main process's
 * redacting logger. Everything else is moved unchanged, and the parts an operator depends on are pinned here with
 * the REAL loader (`@huggingface/transformers` is installed; no model is needed, because every case below is one
 * where loading is refused before any download could start):
 *
 *  - the error text for a blocked miss, which operators have in runbooks and which the queue must NOT treat as
 *    transient (a job for a model that cannot load ends `failed`, visibly);
 *  - `env.cacheDir` and `env.allowRemoteModels` are set from the ARGUMENTS on the library's per-process `env`;
 *  - the progress lines go to the callback.
 *
 * What is NOT run offline: a load that succeeds (needs the 274 MB model; Docker suites cover it) and a cache miss
 * with downloads allowed (it would download). The egress ordering for that case is pinned statically by
 * `no-runtime-model-egress.test.js`.
 *
 * Run: node --test testing/standalone/local-pipeline-loader.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let loadLocalPipeline, isTransientEmbedError, transformersEnv;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-local-pipeline-'));
const emptyCache = path.join(tmp, 'empty-cache');
fs.mkdirSync(emptyCache, { recursive: true });

before(async () => {
  ({ loadLocalPipeline } = await import('../../server/dist/brain/local-pipeline.js'));
  ({ isTransientEmbedError } = await import('../../server/dist/brain/embed-queue.js'));
  ({ env: transformersEnv } = await import('@huggingface/transformers'));
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('loadLocalPipeline with downloads forbidden and nothing cached', () => {
  const MODEL = 'nobody/no-such-embedding-model';

  it('refuses with the operator-facing text, naming the cache and the flags, and never transient', async () => {
    const lines = [];
    const err = await loadLocalPipeline({ modelId: MODEL, cacheDir: emptyCache, offline: true }, (l, m) => lines.push([l, m]))
      .then(() => null, e => e);
    assert.ok(err instanceof Error, 'a load that cannot succeed must throw');

    assert.ok(err.message.includes(`Embedding model '${MODEL}' is not in the model cache (${emptyCache})`), err.message);
    assert.ok(err.message.includes('runtime downloads are disabled by HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE / YTHRIL_MODELS_OFFLINE'));
    assert.ok(err.message.includes('docs/integration-guide/02-hosting.md'));
    assert.ok(err.message.includes('Underlying error:'), 'the library\'s own reason stays available after ours');
    assert.equal(isTransientEmbedError(err.message), false,
      'a model that cannot load is deterministic: the job must end failed after its attempts, not retry for ever');
  });

  it('reports progress through the callback and through nothing else', async () => {
    const lines = [];
    const writes = [];
    const real = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = (...a) => { writes.push(String(a[0])); return true; };
    process.stderr.write = (...a) => { writes.push(String(a[0])); return true; };
    try {
      await loadLocalPipeline({ modelId: MODEL, cacheDir: emptyCache, offline: true }, (l, m) => lines.push([l, m])).catch(() => {});
    } finally { process.stdout.write = real.out; process.stderr.write = real.err; }

    assert.ok(lines.some(([l, m]) => l === 'info' && m.includes(`Loading embedding model ${MODEL}`) && m.includes(emptyCache) && /offline/.test(m)),
      `the load was not announced through the callback: ${JSON.stringify(lines)}`);
    assert.deepEqual(writes.filter(w => w.includes(MODEL)), [], 'the loader wrote to a stream the main process does not redact');
  });

  it('sets the library\'s cache directory and remote-model switch from its ARGUMENTS', async () => {
    const other = path.join(tmp, 'another-cache');
    fs.mkdirSync(other, { recursive: true });
    transformersEnv.allowRemoteModels = true;
    await loadLocalPipeline({ modelId: MODEL, cacheDir: other, offline: true }, () => {}).catch(() => {});
    assert.equal(transformersEnv.cacheDir, other);
    assert.equal(transformersEnv.allowRemoteModels, false,
      'offline: true must switch the library\'s runtime download off, whatever its default is');
  });

  it('takes the log callback as optional', async () => {
    const err = await loadLocalPipeline({ modelId: MODEL, cacheDir: emptyCache, offline: true }).then(() => null, e => e);
    assert.ok(err instanceof Error);
  });
});
