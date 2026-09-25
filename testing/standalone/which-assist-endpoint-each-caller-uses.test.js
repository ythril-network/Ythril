/**
 * Which endpoint each assist-model caller sends to, for a given configuration — pinned BEFORE `F-33` moves the
 * decision into one resolver (characterization; the flow's `gate-characterization-tests`).
 *
 * F-33 rewrites how the callers pick the assist model: today each reads `documentProcessing.assistModel` and checks
 * its per-use consent itself; after it, they ask `config/assist-backend.ts`. This file states what the callers do
 * now, through their exported entry points and a real loaded config, so the rewrite can be held to it: with no
 * budget and no fallback configured, every answer here must be the same afterwards.
 *
 * - the describe step (`describeTarget`) uses the assist model only under its DOCUMENTS consent;
 * - the extractor's writer (`generationBackend`) and its decision fallback (`decisionBackend`) only under its
 *   CONVERSATIONS consent, and refuse, naming the setting, without it;
 * - a consent for the other use never stands in (F-35).
 *
 * The repair pass in `vlm-extract.ts` makes the same documents-consent choice inline, inside a function that needs a
 * rendered document to reach; it is covered by the source gate `an-assist-model-use-is-consented-on-its-own`.
 *
 * Run: node --test testing/standalone/which-assist-endpoint-each-caller-uses.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// CONFIG_PATH is read when the loader is first evaluated, so it is set at module scope, before any import of it.
const cfgDir = mkdtempSync(join(tmpdir(), 'ythril-assist-'));
const CFG = join(cfgDir, 'config.json');
process.env['CONFIG_PATH'] = CFG;
process.env['DOC_ASSIST_API_KEY'] = 'k-assist';
const HOST = 'llm.example.com';
const BASE = `https://${HOST}/v1`;

function writeConfig(assistModel) {
  writeFileSync(CFG, JSON.stringify({
    instanceId: 'assist-test', instanceLabel: 'test', tokens: [], networks: [], spaces: [],
    ...(assistModel ? { mediaEmbedding: { documentProcessing: { assistModel } } } : {}),
  }, null, 2), { mode: 0o600 });
}
writeConfig(undefined);

let loadConfig, describeTarget, decisionBackend, DecisionUnavailableError, generationBackend, GenerationUnavailableError;
before(async () => {
  ({ loadConfig } = await import('../../server/dist/config/loader.js'));
  ({ describeTarget } = await import('../../server/dist/files/converters/describe.js'));
  ({ decisionBackend, DecisionUnavailableError } = await import('../../server/dist/extractor/decide.js'));
  ({ generationBackend, GenerationUnavailableError } = await import('../../server/dist/extractor/generate.js'));
});

const withAssist = (assistModel) => { writeConfig(assistModel); loadConfig(); };
const documentsOnly = { baseUrl: BASE, model: 'big', acknowledgedHost: HOST };
const conversationsOnly = { baseUrl: BASE, model: 'big', acknowledgedHostForConversations: HOST };
const both = { ...documentsOnly, acknowledgedHostForConversations: HOST };

describe('the describe step', () => {
  it('uses the assist model under its documents consent, as an external endpoint with its key', () => {
    withAssist(documentsOnly);
    const t = describeTarget();
    assert.equal(t?.slot, 'assist');
    assert.equal(t?.baseUrl, BASE);
    assert.equal(t?.model, 'big');
    assert.equal(t?.external, true);
    assert.equal(t?.apiKey, 'k-assist');
  });

  it('does not use it under a conversations consent alone', () => {
    withAssist(conversationsOnly);
    assert.notEqual(describeTarget()?.slot, 'assist');
  });

  it('does not use it with no consent, nor when none is configured', () => {
    withAssist({ baseUrl: BASE, model: 'big' });
    assert.notEqual(describeTarget()?.slot, 'assist');
    withAssist(undefined);
    assert.notEqual(describeTarget()?.slot, 'assist');
  });

  it('does not use it once the endpoint moves off the acknowledged host', () => {
    withAssist({ ...both, baseUrl: 'https://elsewhere.example.org/v1' });
    assert.notEqual(describeTarget()?.slot, 'assist');
  });
});

describe('the extractor writer and its decision fallback', () => {
  it('both use the assist model under its conversations consent', () => {
    withAssist(conversationsOnly);
    const g = generationBackend();
    assert.equal(g.baseUrl, BASE);
    assert.equal(g.model, 'big');
    assert.equal(g.apiKey, 'k-assist');
    const d = decisionBackend();
    assert.equal(d.kind, 'assist');
    assert.equal(d.model, 'big');
  });

  it('both refuse, naming the setting, under a documents consent alone', () => {
    withAssist(documentsOnly);
    assert.throws(() => generationBackend(), GenerationUnavailableError);
    assert.throws(() => decisionBackend(), DecisionUnavailableError);
  });

  it('both refuse with no assist model at all', () => {
    withAssist(undefined);
    assert.throws(() => generationBackend(), GenerationUnavailableError);
    assert.throws(() => decisionBackend(), DecisionUnavailableError);
  });
});
