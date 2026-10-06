/**
 * `YTHRIL_PINNED_FIELDS` fixes a field at its RESOLVED value, and a typo cannot look like a pin.
 *
 * ## The request
 *
 * The canary operator, twice, 2026-08-12T1238Z (Q3): *"once the URL is infra-pinned to an in-cluster unauthenticated
 * endpoint, an editable key field is a control with nothing behind it. Empty is the CORRECT value, and we would
 * like to pin the correct value."* Owner ruled **A** — an explicit list — on 2026-08-19.
 *
 * ## Why not the value channel, which is the thing not to re-derive
 *
 * An empty env var deliberately does NOT pin. `docker compose` passes `${VAR:-}` and leaves a variable
 * defined-but-empty when the operator set nothing, so reading "defined" as "pinned" locks every field on every
 * Compose deployment. All twenty pins were converted to presence checks before `face-recognition-env.test.js`
 * failed with that reasoning, and it was reverted. A separate list cannot be produced by a Compose default, which
 * is the entire argument for it.
 *
 * ## The half that carries the risk
 *
 * A pin that names nothing is worse than no pin, because the operator believes the field is fixed. So an
 * unrecognised entry is reported in `pinnedUnknown` — which the admin API returns and the UI can render — as well
 * as warned at boot. Reporting only in the log would put the one thing they need to see where they are not looking.
 *
 * Run: node --test testing/standalone/pinned-fields.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// In the OS temp directory, never beside this file: a gate walking the tree's untracked files in parallel can list it
// and find it deleted before it reads it (media-config.test.js did exactly that, bundle-53 preflight).
const TEMP_CONFIG = path.join(os.tmpdir(), `ythril-pinned-fields-test-${process.pid}.json`);
const BASE_CONFIG = {
  instanceId: 'test-instance', instanceName: 'Test', spaces: [], tokens: [], networks: [],
};

let parsePinnedFields, PINNABLE_FIELD_PATHS, getMediaEmbeddingConfig, reloadConfig;

before(async () => {
  fs.writeFileSync(TEMP_CONFIG, JSON.stringify(BASE_CONFIG, null, 2));
  process.env['CONFIG_PATH'] = TEMP_CONFIG;
  // Imported AFTER CONFIG_PATH is set — the loader reads it at module evaluation.
  ({ parsePinnedFields, PINNABLE_FIELD_PATHS } = await import('../../server/dist/config/pinned-fields.js'));
  const loader = await import('../../server/dist/config/loader.js');
  getMediaEmbeddingConfig = loader.getMediaEmbeddingConfig;
  reloadConfig = loader.reloadConfig ?? loader.loadConfig;
  reloadConfig?.();
});

after(() => { try { fs.unlinkSync(TEMP_CONFIG); } catch { /* already gone */ } });

beforeEach(() => { delete process.env['YTHRIL_PINNED_FIELDS']; });

describe('parsing the variable', () => {
  it('accepts the paths the request actually asked for', () => {
    const r = parsePinnedFields('rerank.apiKey,nli.apiKey,faceRecognition.externalModel');
    assert.deepEqual(r.paths, ['rerank.apiKey', 'nli.apiKey', 'faceRecognition.externalModel']);
    assert.deepEqual(r.unknown, []);
  });

  it('a typo is REPORTED, not silently dropped and not silently accepted', () => {
    // The whole failure mode: a control that looks fixed and is not.
    const r = parsePinnedFields('rerank.apiKay');
    assert.deepEqual(r.paths, []);
    assert.deepEqual(r.unknown, ['rerank.apiKay']);
  });

  it('one typo does not discard the pins that were spelled correctly', () => {
    // Refusing the whole list would make one bad character disable every pin, which is a worse failure than the
    // one being prevented — and the good pins are exactly what the operator was relying on.
    const r = parsePinnedFields('rerank.apiKey,nli.apiKay,stt.apiKey');
    assert.deepEqual(r.paths, ['rerank.apiKey', 'stt.apiKey']);
    assert.deepEqual(r.unknown, ['nli.apiKay']);
  });

  it('tolerates the whitespace and trailing commas a Helm manifest produces', () => {
    assert.deepEqual(parsePinnedFields(' rerank.apiKey , , nli.apiKey , ').paths,
      ['rerank.apiKey', 'nli.apiKey']);
  });

  it('is case-SENSITIVE, because the field paths are', () => {
    /*
     * A case-insensitive match would accept `rerank.APIKEY` and then report a pin on a path no other code
     * recognises — so the UI would grey out nothing and the 403 would never fire, while the variable looked right.
     */
    assert.deepEqual(parsePinnedFields('rerank.APIKEY').unknown, ['rerank.APIKEY']);
    assert.deepEqual(parsePinnedFields('Rerank.apiKey').unknown, ['Rerank.apiKey']);
  });

  it('a bare block name is not a path', () => {
    // `rerank` is not something the loader can lock, so accepting it would put a value in `lockedByInfra` that
    // nothing else understands. Rejecting it says so instead.
    assert.deepEqual(parsePinnedFields('rerank').unknown, ['rerank']);
  });

  it('deduplicates, because the UI reads this list to decide what to grey out', () => {
    assert.deepEqual(parsePinnedFields('rerank.apiKey,rerank.apiKey').paths, ['rerank.apiKey']);
    assert.deepEqual(parsePinnedFields('a.b,a.b').unknown, ['a.b']);
  });

  it('unset and empty are both "no pins", not an error', () => {
    for (const raw of [undefined, '', '   ', ',', ' , ']) {
      const r = parsePinnedFields(raw);
      assert.deepEqual(r, { paths: [], unknown: [] }, `raw=${JSON.stringify(raw)}`);
    }
  });
});

describe('the pin reaches lockedByInfra, which is what makes it a pin', () => {
  it('a field with NO env var of its own becomes locked', () => {
    /*
     * The requested case, end to end. `RERANK_API_KEY` is unset — the key resolves to nothing, which is the
     * correct value — and the field still has to report as read-only. Before this, the only way to lock it was to
     * give it a value, which is the opposite of what was asked for.
     */
    delete process.env['RERANK_API_KEY'];
    process.env['YTHRIL_PINNED_FIELDS'] = 'rerank.apiKey';
    const cfg = getMediaEmbeddingConfig();
    assert.ok(cfg.lockedByInfra.includes('rerank.apiKey'),
      `rerank.apiKey not locked: ${JSON.stringify(cfg.lockedByInfra)}`);
  });

  it('several at once, including a face field', () => {
    process.env['YTHRIL_PINNED_FIELDS'] = 'nli.apiKey,faceRecognition.externalModel';
    const locked = getMediaEmbeddingConfig().lockedByInfra;
    for (const p of ['nli.apiKey', 'faceRecognition.externalModel']) {
      assert.ok(locked.includes(p), `${p} not locked: ${JSON.stringify(locked)}`);
    }
  });

  it('an unknown entry locks nothing and is reported on the config', () => {
    process.env['YTHRIL_PINNED_FIELDS'] = 'rerank.apiKay';
    const cfg = getMediaEmbeddingConfig();
    assert.ok(!cfg.lockedByInfra.includes('rerank.apiKay'));
    assert.deepEqual(cfg.pinnedUnknown, ['rerank.apiKay'],
      'an unrecognised pin must be visible where an operator looks, not only in the log');
  });

  it('`pinnedUnknown` is ABSENT when everything resolved', () => {
    // A field that is an empty array on every healthy instance is a field readers learn to skip — which is exactly
    // when it needs to be noticed.
    process.env['YTHRIL_PINNED_FIELDS'] = 'rerank.apiKey';
    assert.equal(getMediaEmbeddingConfig().pinnedUnknown, undefined);
    delete process.env['YTHRIL_PINNED_FIELDS'];
    assert.equal(getMediaEmbeddingConfig().pinnedUnknown, undefined);
  });

  it('does not disturb the pins an env var already produced', () => {
    // It ADDS. A field pinned by its own variable must stay pinned whether or not the list mentions it.
    process.env['RERANK_MODEL'] = 'some-model';
    process.env['YTHRIL_PINNED_FIELDS'] = 'nli.apiKey';
    const locked = getMediaEmbeddingConfig().lockedByInfra;
    delete process.env['RERANK_MODEL'];
    assert.ok(locked.includes('rerank.model'), 'the env-var pin was lost');
    assert.ok(locked.includes('nli.apiKey'), 'the listed pin was lost');
  });

  it('a field pinned BOTH ways appears once', () => {
    process.env['RERANK_MODEL'] = 'some-model';
    process.env['YTHRIL_PINNED_FIELDS'] = 'rerank.model';
    const locked = getMediaEmbeddingConfig().lockedByInfra;
    delete process.env['RERANK_MODEL'];
    assert.equal(locked.filter(p => p === 'rerank.model').length, 1,
      `duplicated: ${JSON.stringify(locked)}`);
  });

  it('reads the environment per call, not once at module load', () => {
    // The loader is a long-lived module and this list is read from `process.env` on every resolution. A
    // module-scope snapshot would make whichever test ran first decide the answer for all the others — and in
    // production it would ignore a variable set by a restart-free config reload.
    process.env['YTHRIL_PINNED_FIELDS'] = 'stt.apiKey';
    assert.ok(getMediaEmbeddingConfig().lockedByInfra.includes('stt.apiKey'));
    process.env['YTHRIL_PINNED_FIELDS'] = 'vision.apiKey';
    const second = getMediaEmbeddingConfig().lockedByInfra;
    assert.ok(second.includes('vision.apiKey'));
    assert.ok(!second.includes('stt.apiKey'), 'the first value was cached');
  });
});

describe('the vocabulary', () => {
  it('covers every family a pin could name', () => {
    // set-claim: the provider FAMILIES a pin can name -- a product decision about which config blocks are
    // infra-pinnable, not a copy of the media config's block list, which also holds `levels`.
    const blocks = new Set(PINNABLE_FIELD_PATHS.filter(p => p.includes('.')).map(p => p.split('.')[0]));
    for (const b of ['vision', 'stt', 'nli', 'rerank', 'embedding', 'documentProcessing', 'faceRecognition']) {
      assert.ok(blocks.has(b), `${b} has no pinnable paths`);
    }
    assert.ok(PINNABLE_FIELD_PATHS.includes('maxFileSizeBytes'), 'top-level fields must be pinnable too');
  });

  it('has no duplicates, or the same path would be offered twice', () => {
    assert.equal(new Set(PINNABLE_FIELD_PATHS).size, PINNABLE_FIELD_PATHS.length);
  });
});
