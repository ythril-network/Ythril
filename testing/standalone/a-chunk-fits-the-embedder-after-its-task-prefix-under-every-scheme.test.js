/**
 * What the embedder is SENT is under its ceiling for every prefix scheme and both tasks, and the text builder is one (Q-699, bundle-237).
 *
 * ## Why the prefix is part of the question
 *
 * `prepareInput` puts the task prefix in front of the text on the way out (`search_document: ` is 17 bytes; the `qwen` query instruction
 * is over a hundred). A chunker that stops at the ceiling and a sender that then adds the prefix is over the ceiling by exactly the
 * prefix, and the embedder refuses the longest chunks again, one prefix at a time. So the budget the chunks are split to is the
 * ceiling MINUS the largest prefix of the configured scheme (`embedTextBudget()`, `brain/embed-text.ts`), and this file holds that
 * from the other end: take every part the real conversion emits, run it through `prepareInput` under each scheme and each task, and
 * count the bytes.
 *
 * ## What is held
 *
 *  1. For each scheme (`none`, `nomic`, `qwen`, and `auto` with and without an HTTP endpoint) and both tasks, every chunk of a corpus
 *     that holds the two reported pages, a 16 KB section and a 30 KB fence is at most `embedding.maxInputBytes` (6,000) bytes after
 *     `prepareInput`.
 *  2. `embedTextBudget()` is the ceiling minus the largest prefix of the scheme the instance is configured with.
 *  3. `embedTextFor(heading, content)` is the ONE builder of what is embedded: `chunkEmbedText` when that fits the budget, otherwise a
 *     deterministic cut of it (the heading capped to a quarter of the budget first), never over the budget, never mid-pair.
 *  4. `embedInputCeiling()` is 6,000 with nothing configured.
 *
 * Red at the unchanged base: the corpus chunks are over the ceiling (behaviour), and the three accessors do not exist.
 *
 * Run: node --test testing/standalone/a-chunk-fits-the-embedder-after-its-task-prefix-under-every-scheme.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b237-scheme-'));
const CONFIG_PATH = path.join(scratch, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
delete process.env['EMBEDDING_URL'];
delete process.env['EMBEDDING_PREFIX_SCHEME'];

const CEILING = 6_000;
let loader, embedding, embedText, runConversionPipeline;

const configure = (embeddingBlock = {}) => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    spaces: [{ id: 'general', label: 'General' }], networks: [], tokens: [], embedding: embeddingBlock,
  }, null, 2));
  loader.loadConfig();
};
const bytes = (s) => Buffer.byteLength(s, 'utf8');

before(async () => {
  loader = await import('../../server/dist/config/loader.js');
  embedding = await import('../../server/dist/brain/embedding.js');
  embedText = await import('../../server/dist/brain/embed-text.js');
  ({ runConversionPipeline } = await import('../../server/dist/files/converters/pipeline.js'));
  configure();
});

const SCHEMES = [
  ['none', {}],
  ['nomic', {}],
  ['qwen', {}],
  ['auto (the bundled model: nomic)', { prefixScheme: 'auto' }],
  ['auto behind an HTTP endpoint (none)', { prefixScheme: 'auto', baseUrl: 'http://127.0.0.1:9/v1' }],
];
const schemeBlock = (name, extra) => (['none', 'nomic', 'qwen'].includes(name) ? { prefixScheme: name } : extra);

const FENCE = '```text\n' + Array.from({ length: 1_200 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'.'.repeat(15)}`).join('\n') + '\n```';
const corpus = () => {
  const root = process.cwd();
  return [
    ['16-mcp.md', fs.readFileSync(path.join(root, 'docs/integration-guide/16-mcp.md'), 'utf8')],
    ['11-setup-api.md', fs.readFileSync(path.join(root, 'docs/integration-guide/11-setup-api.md'), 'utf8')],
    ['02-hosting.md', fs.readFileSync(path.join(root, 'docs/integration-guide/02-hosting.md'), 'utf8')],
    ['a 30 KB fence', '## Fence\n\n' + FENCE + '\n'],
    ['a long heading over a long body', `## ${'H'.repeat(3_000)}\n\n` + FENCE + '\n'],
  ];
};

describe('every chunk, after the task prefix, is at most the ceiling — for every scheme and both tasks', () => {
  for (const [name, extra] of SCHEMES) {
    it(`${name}`, async () => {
      configure(schemeBlock(name, extra));
      const cfg = loader.getEmbeddingConfig();
      const offenders = [];
      let seen = 0;
      for (const [label, text] of corpus()) {
        const { chunks } = await runConversionPipeline(Buffer.from(text, 'utf8'), 'doc.md', 'md', {});
        for (const c of chunks) {
          seen++;
          for (const task of ['document', 'query']) {
            const sent = bytes(embedding.prepareInput(embedText.chunkEmbedText(c.headingText, c.content), task, cfg));
            if (sent > CEILING) offenders.push(`${label} #${c.chunkIndex} (${task}): ${sent} bytes`);
          }
        }
      }
      assert.ok(seen > 60,`the corpus came to only ${seen} chunks`);
      assert.deepEqual(offenders.slice(0, 12), [], `${offenders.length} chunk(s) reach the embedder over ${CEILING} bytes under ${name}`);
    });
  }
});

describe('the budget is the ceiling minus the largest prefix of the configured scheme', () => {
  it('embedInputCeiling() is 6,000 bytes with nothing configured', () => {
    configure();
    assert.equal(embedText.embedInputCeiling(), CEILING);
  });

  for (const [name, extra] of SCHEMES) {
    it(`${name}: embedTextBudget() = ceiling - the larger of the two prefixes`, () => {
      configure(schemeBlock(name, extra));
      const cfg = loader.getEmbeddingConfig();
      const largest = Math.max(...['document', 'query'].map(t => bytes(embedding.prepareInput('', t, cfg))));
      assert.equal(embedText.embedTextBudget(), CEILING - largest);
    });
  }
});

describe('embedTextFor is the one builder of what is embedded', () => {
  before(() => configure({ prefixScheme: 'nomic' }));

  it('is chunkEmbedText itself while that fits the budget — exactly at the budget too', () => {
    const budget = embedText.embedTextBudget();
    assert.equal(embedText.embedTextFor('Intro', 'the body'), 'Intro the body');
    assert.equal(embedText.embedTextFor(null, 'the body'), 'the body');
    const atBudget = 'x'.repeat(budget - 'H '.length);
    assert.equal(embedText.embedTextFor('H', atBudget), embedText.chunkEmbedText('H', atBudget));
    assert.equal(bytes(embedText.embedTextFor('H', atBudget)), budget);
  });

  it('is cut to the budget when it does not fit, keeping the start, and says nothing in the string about being cut', () => {
    const budget = embedText.embedTextBudget();
    const content = 'abcdefghij'.repeat(3_000);
    const out = embedText.embedTextFor('Intro', content);
    assert.ok(bytes(out) <= budget && bytes(out) > budget - 100, `${bytes(out)} bytes against a budget of ${budget}`);
    assert.ok(embedText.chunkEmbedText('Intro', content).startsWith(out), 'a cut keeps the beginning of the text');
  });

  it('caps a long heading to a quarter of the budget before it builds', () => {
    const budget = embedText.embedTextBudget();
    const heading = 'H'.repeat(7_000);
    const out = embedText.embedTextFor(heading, 'the body');
    assert.ok(bytes(out) <= budget);
    const lead = out.match(/^H+/)?.[0] ?? '';
    assert.ok(lead.length > 0 && lead.length <= budget / 4, `the heading kept ${lead.length} bytes`);
    assert.ok(out.endsWith('the body'), 'the body was cut instead of the heading');
  });

  it('counts bytes and never ends on half a pair', () => {
    const budget = embedText.embedTextBudget();
    const out = embedText.embedTextFor(null, '😀'.repeat(5_000));
    assert.ok(bytes(out) <= budget);
    assert.ok((out.charCodeAt(out.length - 1) & 0xfc00) !== 0xd800, 'ends on the first half of a surrogate pair');
  });
});
