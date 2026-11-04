/**
 * `embedding.maxInputBytes`: the embedder's input ceiling is one setting, with one range, on the doors that exist (Q-699, bundle-237).
 *
 * ## What the setting is
 *
 * The most UTF-8 bytes one embedder request may carry, task prefix included; default 6,000. An embedder with a small context (512
 * tokens) needs it lower; the board asked "which setting?" and there was none. It is set in `config.json` or through
 * `PATCH /api/admin/media-config` (admin, MFA), beside `embedding.model` and `embedding.baseUrl`, which are the embedder's own
 * configuration: no environment variable, no MCP door, no UI field (said in the docs, like `embedConcurrency`'s absent field).
 *
 * ## What is held
 *
 *  1. Range: the PATCH door takes integers 512 … 65,536 and refuses 511, 65,537, a fraction and a numeric string; the range lives in
 *     `config/setting-bounds.ts` and the schema reads it through `bounded()`, never inline (`one-setting-one-range`'s rule).
 *  2. The reader never means "no limit": a stored value that is absent, zero, negative, a string, a fraction, below 512 or above 65,536
 *     (a hand-edited `config.json` is not validated at load) gives 6,000, not the clamp to the edge and never an unbounded ceiling.
 *  3. A valid stored value is honoured by `getEmbeddingConfig()` and by the reader, and the chunker splits to it.
 *  4. The loader and the PATCH door are the only writers: no env var maps to it; it is pinnable (`PINNABLE_FIELD_PATHS`) so an operator
 *     can pin it against UI/PATCH writes like its sisters.
 *  5. It is documented: the 05b config table names `embedding.maxInputBytes`, and every key the embedding PATCH accepts is named in
 *     the docs (a nested-key sweep, because `config-key-docs-coverage` reads top-level fields only).
 *
 * Red at the unchanged base: the schema is `.strict()` and refuses the key, nothing reads it, and the chunks do not follow it.
 *
 * Run: node --test testing/standalone/the-embedder-ceiling-is-one-setting-with-one-range.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_strip-comments.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b237-setting-'));
const CONFIG_PATH = path.join(scratch, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
delete process.env['EMBEDDING_URL'];
const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

let loader, embedText, embedding, mediaConfig, bounds, pinned, runConversionPipeline;

const configure = (embeddingBlock) => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    spaces: [{ id: 'general', label: 'General' }], networks: [], tokens: [],
    ...(embeddingBlock === undefined ? {} : { embedding: embeddingBlock }),
  }, null, 2));
  loader.loadConfig();
};

before(async () => {
  loader = await import('../../server/dist/config/loader.js');
  embedText = await import('../../server/dist/brain/embed-text.js');
  embedding = await import('../../server/dist/brain/embedding.js');
  mediaConfig = await import('../../server/dist/api/media-config.js');
  bounds = await import('../../server/dist/config/setting-bounds.js');
  pinned = await import('../../server/dist/config/pinned-fields.js');
  ({ runConversionPipeline } = await import('../../server/dist/files/converters/pipeline.js'));
  configure();
});

describe('the PATCH door takes 512 … 65,536 whole bytes and nothing else', () => {
  const ok = (v) => mediaConfig.EmbeddingPatchSchema.safeParse({ maxInputBytes: v }).success;
  it('accepts the ends of the range and a usual value', () => {
    for (const v of [512, 1_024, 6_000, 65_536]) assert.equal(ok(v), true, `${v} was refused`);
  });
  it('refuses just outside it, a fraction, a numeric string, zero, a negative, null and a boolean', () => {
    for (const v of [511, 65_537, 1_024.5, '1024', 0, -6_000, null, true, Number.NaN, Infinity]) {
      assert.equal(ok(v), false, `${String(v)} was accepted`);
    }
  });
  it('the whole media-config patch takes it under embedding, and still refuses a misspelt sibling', () => {
    assert.equal(mediaConfig.MediaConfigPatchSchema.safeParse({ embedding: { maxInputBytes: 2_048 } }).success, true);
    assert.equal(mediaConfig.MediaConfigPatchSchema.safeParse({ embedding: { maxInputByte: 2_048 } }).success, false);
  });
});

describe('the range is written once, in setting-bounds, and read by the schema through bounded()', () => {
  it('DUAL_DOOR_BOUNDS holds embedding.maxInputBytes as 512 … 65,536 with a words-for-an-operator description', () => {
    const row = bounds.DUAL_DOOR_BOUNDS['embedding.maxInputBytes'];
    assert.ok(row, 'setting-bounds has no row for embedding.maxInputBytes');
    assert.equal(row.min, 512);
    assert.equal(row.max, 65_536);
    assert.ok(typeof row.what === 'string' && row.what.length > 10);
  });
  it('the schema line reads it through bounded(), not inline numbers', () => {
    const src = stripComments(read('server/src/api/media-config.ts'));
    assert.match(src, /\bmaxInputBytes\s*:\s*bounded\(\s*'embedding\.maxInputBytes'\s*\)/);
  });
  it('no environment variable writes it', () => {
    assert.ok(!Object.values(bounds.ENV_TO_CONFIG_PATH).includes('embedding.maxInputBytes'), 'an env door exists for a setting that is the embedder\'s own configuration');
    const readers = [read('server/src/config/loader.ts'), read('server/src/config/setting-bounds.ts')].map(stripComments).join('\n');
    assert.ok(!/process\.env\[\s*'[A-Z_]*MAX_INPUT[A-Z_]*'\s*\]/.test(readers), 'an environment variable for the ceiling is read');
    assert.ok(!/'[A-Z_]*MAX_INPUT_BYTES'\s*:/.test(readers), 'an environment variable for the ceiling is mapped');
  });
  it('it is pinnable like its sisters', () => {
    assert.ok(pinned.PINNABLE_FIELD_PATHS.includes('embedding.maxInputBytes'));
  });
});

describe('the reader never means "no limit"', () => {
  const CASES = [
    ['absent', undefined], ['zero', 0], ['negative', -1], ['a string', '6000'], ['a fraction', 1_024.5], ['below the range', 100],
    ['above the range', 70_000], ['null', null], ['an array', [1_024]], ['an object', {}],
  ];
  for (const [name, value] of CASES) {
    it(`${name} gives 6,000`, () => {
      configure(value === undefined ? {} : { maxInputBytes: value });
      assert.equal(embedText.embedInputCeiling(), 6_000);
    });
  }

  it('a valid stored value is the ceiling, at the ends of the range too', () => {
    for (const v of [512, 1_024, 65_536]) {
      configure({ maxInputBytes: v });
      assert.equal(embedText.embedInputCeiling(), v);
    }
  });

  it('getEmbeddingConfig() carries the stored value', () => {
    configure({ maxInputBytes: 2_048 });
    assert.equal(loader.getEmbeddingConfig().maxInputBytes, 2_048);
  });

  it('the budget follows the setting: ceiling minus the largest prefix of the scheme', () => {
    configure({ maxInputBytes: 1_024, prefixScheme: 'nomic' });
    assert.equal(embedText.embedTextBudget(), 1_024 - Buffer.byteLength('search_document: '));
  });
});

describe('the chunker and embed() read the same value', () => {
  it('with 1,024 configured every conversion chunk is at most 1,024 bytes after the prefix', async () => {
    configure({ maxInputBytes: 1_024, prefixScheme: 'nomic' });
    const cfg = loader.getEmbeddingConfig();
    const md = '## Big\n\n```text\n' + Array.from({ length: 600 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'.'.repeat(15)}`).join('\n') + '\n```\n';
    const { chunks } = await runConversionPipeline(Buffer.from(md, 'utf8'), 'doc.md', 'md', {});
    assert.ok(chunks.length >= 10, `a 15 KB fence at a 1,024-byte ceiling came back as ${chunks.length} chunk(s)`);
    for (const c of chunks) {
      for (const task of ['document', 'query']) {
        const sent = Buffer.byteLength(embedding.prepareInput(`${c.headingText} ${c.content}`, task, cfg));
        assert.ok(sent <= 1_024, `chunk ${c.chunkIndex} (${task}) sends ${sent} bytes against a ceiling of 1,024`);
      }
    }
  });

  it('an invalid stored value chunks to the default, not to no limit', async () => {
    configure({ maxInputBytes: 0 });
    const md = '## Big\n\n' + 'z'.repeat(30_000) + '\n';
    const { chunks } = await runConversionPipeline(Buffer.from(md, 'utf8'), 'doc.md', 'md', {});
    assert.ok(chunks.length >= 5 && chunks.every(c => Buffer.byteLength(c.content) <= 6_000), `${chunks.length} chunks, the largest ${Math.max(...chunks.map(c => c.content.length))} characters`);
  });
});

describe('it is documented, and the embedding keys are documented one by one', () => {
  const doc = () => read('docs/integration-guide/05b-media-embedding.md');
  it('05b names embedding.maxInputBytes in its config table, with its default and range', () => {
    const row = doc().split('\n').find(l => l.startsWith('|') && l.includes('`embedding.maxInputBytes`'));
    assert.ok(row, '05b-media-embedding.md has no config-table row for `embedding.maxInputBytes`');
    assert.match(row, /6,?000/);
    assert.match(row, /512/);
    assert.match(row, /65,?536/);
  });
  it('every key the embedding PATCH accepts is named as `embedding.<key>` in the docs (nested keys; config-key-docs-coverage reads top-level only)', () => {
    const missing = Object.keys(mediaConfig.EmbeddingPatchSchema.shape).filter(k => !doc().includes(`embedding.${k}`));
    assert.deepEqual(missing, [], `the embedding keys the docs never name: ${missing.join(', ')}`);
  });
});
