/**
 * Standalone unit tests: getMediaEmbeddingConfig() resolution tiers and
 * lockedByInfra reporting.
 *
 * These tests run against the compiled server modules directly.
 * No running server, database, or filesystem writes are required.
 *
 * Run: node --test testing/standalone/media-config.test.js
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ── Module import helpers ─────────────────────────────────────────────────────
// loader.ts imports CONFIG_PATH from env at module-evaluation time.
// We point it at a temp file before loading the module.
//
// In the OS temp directory, never beside this file: a gate that walks the tree's untracked files (preflight runs them
// in parallel) stat'ed this file between its listing and its read while this test deleted it, and failed with ENOENT.

const TEMP_CONFIG = path.join(os.tmpdir(), `ythril-media-config-test-${process.pid}.json`);

const BASE_CONFIG = {
  instanceId: 'test-instance',
  instanceName: 'Test',
  spaces: [],
  tokens: [],
  networks: [],
};

// Set by before() once the module is imported; used by writeConfig() to keep
// in-memory config in sync with each test's disk write.
let _reloadConfig;

function writeConfig(extra = {}) {
  fs.writeFileSync(TEMP_CONFIG, JSON.stringify({ ...BASE_CONFIG, ...extra }, null, 2));
  // Reload in-memory config after writing so getMediaEmbeddingConfig() sees the new values.
  _reloadConfig?.();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getMediaEmbeddingConfig', () => {
  let getMediaEmbeddingConfig;
  let getDocumentProcessingConfig;
  let getDocAssistApiKey;
  let getEmbeddingConfig;
  let getEmbeddingApiKey;

  const ENV_KEYS = [
    'MEDIA_EMBEDDING_ENABLED', 'VISION_PROVIDER', 'STT_PROVIDER',
    'VISION_BASE_URL', 'VISION_MODEL', 'VISION_API_KEY',
    'STT_BASE_URL', 'STT_MODEL', 'STT_API_KEY',
    'WORKER_CONCURRENCY', 'WORKER_POLL_INTERVAL_MS', 'WORKER_MAX_POLL_INTERVAL_MS',
    'MEDIA_EMBEDDING_FALLBACK_TO_EXTERNAL', 'MAX_FILE_SIZE_BYTES', 'STALLED_JOB_TIMEOUT_MS',
    'DOC_ASSIST_URL', 'DOC_ASSIST_MODEL', 'DOC_ASSIST_API_KEY',
    'DOC_VERIFY_MODEL', 'DOC_VERIFY_URL',
    'YTHRIL_MEDIA_INFRA_MANAGED',
    'DOC_OCR_TIMEOUT_MS',
    'EMBEDDING_PROVIDER', 'EMBEDDING_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS', 'EMBEDDING_API_KEY',
    // Added when the face block became operator-settable. These were absent while nothing in this
    // file set them; a leaked FACE_RECOGNITION_* pin shows up as an unrelated lockedByInfra test
    // failing several cases later, which is a confusing way to learn about it.
    'FACE_RECOGNITION_ENABLED', 'FACE_RECOGNITION_CONFIDENCE_THRESHOLD',
    'FACE_RECOGNITION_MIN_FACE_SIZE_FRACTION', 'FACE_RECOGNITION_MODEL_PATH',
    'FACE_RECOGNITION_PERSON_ENTITY_TYPES', 'FACE_RECOGNITION_REPROCESS_SYNCED_IMAGES',
  ];

  function clearEnv() {
    for (const k of ENV_KEYS) delete process.env[k];
  }

  before(async () => {
    clearEnv();
    fs.writeFileSync(TEMP_CONFIG, JSON.stringify(BASE_CONFIG, null, 2));
    process.env['CONFIG_PATH'] = TEMP_CONFIG;
    // Dynamic import AFTER env is set so CONFIG_PATH is read at correct time.
    const mod = await import('../../server/dist/config/loader.js');
    getMediaEmbeddingConfig = mod.getMediaEmbeddingConfig;
    getDocumentProcessingConfig = mod.getDocumentProcessingConfig;
    getDocAssistApiKey = mod.getDocAssistApiKey;
    getEmbeddingConfig = mod.getEmbeddingConfig;
    getEmbeddingApiKey = mod.getEmbeddingApiKey;
    _reloadConfig = mod.reloadConfig;
    // Must call loadConfig() once to initialise _config before any test runs.
    mod.loadConfig();
  });

  after(() => {
    clearEnv();
    if (fs.existsSync(TEMP_CONFIG)) fs.unlinkSync(TEMP_CONFIG);
  });

  afterEach(() => {
    clearEnv();
    // Reset in-memory config after each test so env-var changes don't bleed.
    _reloadConfig?.();
  });

  describe('defaults', () => {
    it('is always on: no `enabled` field; levels default to auto EXCEPT images', () => {
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal('enabled' in cfg, false, 'the master switch was removed');
      // Images deliberately start one rung below `auto`. `auto` resolves to `recognition`, which detects
      // faces and stores face embeddings — biometric data — so it is opted into, never defaulted into.
      // The classes with no comparable rung keep `auto`.
      assert.deepEqual(cfg.levels, { images: 'caption', audio: 'auto', video: 'auto', text: 'auto' });
    });

    it('returns visionProvider=local by default', () => {
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.visionProvider, 'local');
    });

    it('returns sttProvider=local by default', () => {
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.sttProvider, 'local');
    });

    it('returns default Ollama URL', () => {
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.vision?.baseUrl, 'http://ollama:11434');
    });

    it('returns default Whisper URL', () => {
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.stt?.baseUrl, 'http://whisper:8000');
    });

    it('returns default workerConcurrency=2', () => {
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.workerConcurrency, 2);
    });

    it('returns default maxFileSizeBytes=524288000', () => {
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.maxFileSizeBytes, 524_288_000);
    });

    it('lockedByInfra is empty with no env vars', () => {
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.deepEqual(cfg.lockedByInfra, []);
    });
  });

  describe('env var override tier', () => {
    it('MEDIA_EMBEDDING_ENABLED is removed (breaking): it no longer produces an `enabled` field', () => {
      // The master switch is gone; the env var is dead. Setting it must NOT reintroduce `enabled`
      // nor otherwise change the resolved config — media is controlled per class via `levels`.
      process.env['MEDIA_EMBEDDING_ENABLED'] = 'false';
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal('enabled' in cfg, false);
      assert.deepEqual(cfg.lockedByInfra, [], 'the dead env var does not lock anything');
      delete process.env['MEDIA_EMBEDDING_ENABLED'];
    });

    it('VISION_BASE_URL overrides default vision URL', () => {
      // Was `OLLAMA_URL`, which 4.0 removed — it is now refused at boot rather than resolved, so a case
      // using it here would be asserting that a removed name still configures something.
      process.env['VISION_BASE_URL'] = 'http://custom-vision:11434';
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.vision?.baseUrl, 'http://custom-vision:11434');
    });

    it('VISION_MODEL overrides default model', () => {
      process.env['VISION_MODEL'] = 'llava:13b';
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.vision?.model, 'llava:13b');
    });

    it('defaults the vision model to `moondream` (the real Ollama registry name)', () => {
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.vision?.model, 'moondream');
    });

    it('heals the invalid legacy vision model `moondream2` → `moondream` from saved config', () => {
      // `moondream2` is not a real Ollama model (a pull 404s); an install that saved it
      // must self-heal so image captioning works without a manual config edit.
      writeConfig({ mediaEmbedding: { vision: { model: 'moondream2' } } });
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.vision?.model, 'moondream');
    });

    it('heals `moondream2` from the VISION_MODEL env var too', () => {
      process.env['VISION_MODEL'] = 'moondream2';
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.vision?.model, 'moondream');
    });

    it('STT_BASE_URL overrides default STT URL', () => {
      process.env['STT_BASE_URL'] = 'http://custom-stt:8000';
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.stt?.baseUrl, 'http://custom-stt:8000');
    });

    it('WORKER_CONCURRENCY is parsed as a number', () => {
      process.env['WORKER_CONCURRENCY'] = '4';
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.workerConcurrency, 4);
    });
  });

  describe('config.json override tier', () => {
    it('config.json mediaEmbedding.levels override the defaults per class', () => {
      writeConfig({ mediaEmbedding: { levels: { images: 'off', audio: 'on' } } });
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.levels?.images, 'off');
      assert.equal(cfg.levels?.audio, 'on');
      // classes the block omits keep the default rather than dropping out
      assert.equal(cfg.levels?.video, 'auto');
      assert.equal(cfg.levels?.text, 'auto');
    });

    it('config.json vision.baseUrl is used when no env var', () => {
      writeConfig({ mediaEmbedding: { vision: { baseUrl: 'http://from-config:11434' } } });
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.vision?.baseUrl, 'http://from-config:11434');
    });

    it('env var takes priority over config.json value', () => {
      // The precedence being pinned is env-over-config, not which spelling: `VISION_BASE_URL` since 4.0.
      process.env['VISION_BASE_URL'] = 'http://env-url:11434';
      writeConfig({ mediaEmbedding: { vision: { baseUrl: 'http://config-url:11434' } } });
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.vision?.baseUrl, 'http://env-url:11434');
    });
  });

  describe('face recognition is surfaced, not just locked', () => {
    it('reports the resolved faceRecognition block so a UI can render a real control', () => {
      // Before the operator control existed, the API reported which face fields were LOCKED but
      // never their values — so the Models card could show a padlock and not what it padlocked.
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.ok(cfg.faceRecognition, 'faceRecognition block missing from the resolved config');
      for (const field of ['enabled', 'confidenceThreshold', 'minFaceSizeFraction', 'personEntityTypes']) {
        assert.ok(field in cfg.faceRecognition, `${field} not surfaced`);
      }
      assert.ok(Array.isArray(cfg.faceRecognition.personEntityTypes));
    });

    it('the surfaced value reflects the env pin, not the config file', () => {
      // The block the UI renders is RESOLVED (env → config → default). If it showed the config-file
      // value while the env pin won, the control would display the opposite of what actually runs.
      process.env['FACE_RECOGNITION_ENABLED'] = 'true';
      writeConfig({ mediaEmbedding: { faceRecognition: { enabled: false } } });
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.faceRecognition.enabled, true);
      assert.ok(cfg.lockedByInfra?.includes('faceRecognition.enabled'));
    });
  });

  describe('lockedByInfra reporting', () => {
    it('VISION_BASE_URL adds vision.baseUrl to lockedByInfra', () => {
      process.env['VISION_BASE_URL'] = 'http://vision:11434';
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.ok(cfg.lockedByInfra?.includes('vision.baseUrl'), 'Expected vision.baseUrl in lockedByInfra');
    });

    it('VISION_MODEL adds vision.model to lockedByInfra', () => {
      process.env['VISION_MODEL'] = 'moondream2';
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.ok(cfg.lockedByInfra?.includes('vision.model'), 'Expected vision.model in lockedByInfra');
    });

    it('VISION_API_KEY adds vision.apiKey to lockedByInfra', () => {
      process.env['VISION_API_KEY'] = 'sk-secret';
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.ok(cfg.lockedByInfra?.includes('vision.apiKey'), 'Expected vision.apiKey in lockedByInfra');
    });

    it('STT_BASE_URL adds stt.baseUrl to lockedByInfra', () => {
      process.env['STT_BASE_URL'] = 'http://stt:8000';
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.ok(cfg.lockedByInfra?.includes('stt.baseUrl'), 'Expected stt.baseUrl in lockedByInfra');
    });

    it('no env vars → empty lockedByInfra array', () => {
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.equal(cfg.lockedByInfra?.length, 0);
    });

    it('multiple env vars → all appear in lockedByInfra', () => {
      process.env['VISION_BASE_URL'] = 'http://vision:11434';
      process.env['VISION_MODEL'] = 'llava';
      process.env['STT_BASE_URL'] = 'http://stt:8000';
      writeConfig();
      const cfg = getMediaEmbeddingConfig();
      assert.ok(cfg.lockedByInfra?.includes('vision.baseUrl'));
      assert.ok(cfg.lockedByInfra?.includes('vision.model'));
      assert.ok(cfg.lockedByInfra?.includes('stt.baseUrl'));
    });
  });

  // ── F11-b: external assist model ──────────────────────────────────────────────
  describe('assist model (F11-b)', () => {
    it('absent by default → empty block, no key, no lock', () => {
      writeConfig();
      const dp = getDocumentProcessingConfig();
      assert.equal(dp.assistModel.baseUrl, undefined);
      assert.equal(getDocAssistApiKey(), undefined);
      assert.equal(getMediaEmbeddingConfig().lockedByInfra?.includes('documentProcessing.assistModel'), false);
    });

    // `uses` is retired: the assist model serves the repair pass, so the extraction rung is the switch and
    // `acknowledgedHost` is the gate the runtime actually checks. A stale `uses` key in an old config.json
    // is simply ignored — asserted here so nobody resurrects it as a second switch.
    it('resolves baseUrl/model/acknowledgedHost from config.json and ignores a legacy uses key', () => {
      writeConfig({ mediaEmbedding: { documentProcessing: { assistModel: {
        baseUrl: 'https://api.example.com', model: 'big-llm', uses: ['repair'], acknowledgedHost: 'api.example.com',
      } } } });
      const dp = getDocumentProcessingConfig();
      assert.equal(dp.assistModel.baseUrl, 'https://api.example.com');
      assert.equal(dp.assistModel.model, 'big-llm');
      assert.equal(dp.assistModel.acknowledgedHost, 'api.example.com');
    });

    it('DOC_ASSIST_URL / DOC_ASSIST_MODEL env override config and lock the block', () => {
      process.env['DOC_ASSIST_URL'] = 'https://env.example.com';
      process.env['DOC_ASSIST_MODEL'] = 'env-model';
      writeConfig({ mediaEmbedding: { documentProcessing: { assistModel: { baseUrl: 'https://cfg.example.com', model: 'cfg-model' } } } });
      const dp = getDocumentProcessingConfig();
      assert.equal(dp.assistModel.baseUrl, 'https://env.example.com', 'env baseUrl wins');
      assert.equal(dp.assistModel.model, 'env-model', 'env model wins');
      assert.ok(getMediaEmbeddingConfig().lockedByInfra?.includes('documentProcessing.assistModel'));
    });

    it('getDocAssistApiKey reads DOC_ASSIST_API_KEY from env', () => {
      process.env['DOC_ASSIST_API_KEY'] = 'sk-env-123';
      writeConfig();
      assert.equal(getDocAssistApiKey(), 'sk-env-123');
      assert.ok(getMediaEmbeddingConfig().lockedByInfra?.includes('documentProcessing.assistModel'));
    });
  });

  // ── F11-d: consensus / verify model ───────────────────────────────────────────
  describe('verify model (F11-d)', () => {
    it('empty by default → no consensus pass', () => {
      writeConfig();
      const dp = getDocumentProcessingConfig();
      assert.equal(dp.verifyModel, '');
      assert.equal(dp.verifyBaseUrl, '');
    });

    it('resolves verifyModel/verifyBaseUrl from config.json', () => {
      writeConfig({ mediaEmbedding: { documentProcessing: { verifyModel: 'second-vlm', verifyBaseUrl: 'http://ollama2:11434' } } });
      const dp = getDocumentProcessingConfig();
      assert.equal(dp.verifyModel, 'second-vlm');
      assert.equal(dp.verifyBaseUrl, 'http://ollama2:11434');
    });

    it('DOC_VERIFY_MODEL / DOC_VERIFY_URL env override config', () => {
      process.env['DOC_VERIFY_MODEL'] = 'env-vlm';
      process.env['DOC_VERIFY_URL'] = 'http://env-ollama:11434';
      writeConfig({ mediaEmbedding: { documentProcessing: { verifyModel: 'cfg-vlm' } } });
      const dp = getDocumentProcessingConfig();
      assert.equal(dp.verifyModel, 'env-vlm');
      assert.equal(dp.verifyBaseUrl, 'http://env-ollama:11434');
    });
  });

  // ── configurable OCR-sidecar timeout ─────────────────────────────────────────
  describe('OCR timeout', () => {
    it('defaults to 120000 (2 min)', () => {
      writeConfig();
      assert.equal(getDocumentProcessingConfig().ocrTimeoutMs, 120_000);
    });

    it('resolves ocrTimeoutMs from config.json', () => {
      writeConfig({ mediaEmbedding: { documentProcessing: { ocrTimeoutMs: 300_000 } } });
      assert.equal(getDocumentProcessingConfig().ocrTimeoutMs, 300_000);
    });

    it('DOC_OCR_TIMEOUT_MS env overrides config', () => {
      process.env['DOC_OCR_TIMEOUT_MS'] = '450000';
      writeConfig({ mediaEmbedding: { documentProcessing: { ocrTimeoutMs: 300_000 } } });
      assert.equal(getDocumentProcessingConfig().ocrTimeoutMs, 450_000);
    });
  });

  // ── text embedding provider (SSRF follow-up part 2) ──────────────────────────
  describe('embedding config', () => {
    it('defaults to provider=local with no apiKey', () => {
      writeConfig();
      const e = getEmbeddingConfig();
      assert.equal(e.provider, 'local');
      assert.equal(e.apiKey, undefined);
      assert.equal(getEmbeddingApiKey(), undefined);
    });

    it('a PARTIAL stored block still yields complete config (model/dimensions never undefined)', () => {
      // Regression: a PATCH that wrote only { provider } left cfg.embedding partial; getEmbeddingConfig used
      // `cfg.embedding ?? defaults`, so model/dimensions went undefined and vector-index creation broke.
      writeConfig({ embedding: { provider: 'local' } });
      const e = getEmbeddingConfig();
      assert.equal(e.provider, 'local');
      assert.equal(e.model, 'nomic-ai/nomic-embed-text-v1.5');
      assert.equal(e.dimensions, 768);
      assert.equal(e.similarity, 'cosine');
    });

    it('resolves provider/baseUrl/model/dimensions from config.json', () => {
      writeConfig({ embedding: { provider: 'external', baseUrl: 'https://emb.example.com', model: 'text-embed-3', dimensions: 1536, similarity: 'cosine' } });
      const e = getEmbeddingConfig();
      assert.equal(e.provider, 'external');
      assert.equal(e.baseUrl, 'https://emb.example.com');
      assert.equal(e.dimensions, 1536);
    });

    it('EMBEDDING_* env pins override config and appear in lockedByInfra', () => {
      process.env['EMBEDDING_PROVIDER'] = 'external';
      process.env['EMBEDDING_URL'] = 'https://env-emb.example.com';
      process.env['EMBEDDING_MODEL'] = 'env-model';
      writeConfig({ embedding: { provider: 'local', baseUrl: 'https://cfg.example.com', model: 'cfg-model', dimensions: 768, similarity: 'cosine' } });
      const e = getEmbeddingConfig();
      assert.equal(e.provider, 'external');
      assert.equal(e.baseUrl, 'https://env-emb.example.com');
      assert.equal(e.model, 'env-model');
      const locked = getMediaEmbeddingConfig().lockedByInfra ?? [];
      assert.ok(locked.includes('embedding.provider'));
      assert.ok(locked.includes('embedding.baseUrl'));
      assert.ok(locked.includes('embedding.model'));
    });

    it('EMBEDDING_API_KEY resolves via getEmbeddingApiKey and locks the field', () => {
      process.env['EMBEDDING_API_KEY'] = 'sk-emb-env';
      writeConfig();
      assert.equal(getEmbeddingApiKey(), 'sk-emb-env');
      assert.ok((getMediaEmbeddingConfig().lockedByInfra ?? []).includes('embedding.apiKey'));
    });
  });

  // ── infra-managed lock (like YTHRIL_MONGO_INFRA_MANAGED) ──────────────────────
  describe('infra-managed media config', () => {
    it('defaults to not infra-managed', () => {
      writeConfig();
      assert.equal(getMediaEmbeddingConfig().infraManaged, false);
    });

    it('mediaEmbedding.infraManaged: true in config.json marks it managed', () => {
      writeConfig({ mediaEmbedding: { infraManaged: true } });
      assert.equal(getMediaEmbeddingConfig().infraManaged, true);
    });

    it('YTHRIL_MEDIA_INFRA_MANAGED=true env marks it managed even without the config flag', () => {
      process.env['YTHRIL_MEDIA_INFRA_MANAGED'] = 'true';
      writeConfig();
      assert.equal(getMediaEmbeddingConfig().infraManaged, true);
    });
  });
});
