/**
 * A tool answer crosses the wire within the budget it states (`Q-111`).
 *
 * ## What was measured
 *
 * Every tool answer was carried TWICE: over MCP as `content` text and again as `structuredContent`, and over the
 * REST tool door as `text` and again as `data`. So a 25 000-character MCP budget arrived as roughly 52 KB, and
 * `read_file` — which had no budget at all — sent a 2 MB document as 4.3 MB.
 *
 * ## The rule, per door
 *
 * - **MCP carries both, and the budget bounds the TOTAL.** A client may read only one of the two (`types.ts` keeps
 *   the rule that `structuredContent` carries the answer whenever `content` does, after a client that surfaced the
 *   structured half showed a page with no rows), so neither can be dropped. Each carriage is held to its share.
 * - **REST carries it once.** `data` IS the answer when a tool gives one; `text` is sent only when it does not.
 *
 * `read_file` is budgeted and paged the way `GET …/files/extract` pages its Markdown: whole paragraphs from a
 * character offset (`markdownSkip`), `markdownNextSkip` where the next window starts, never a gap or an overlap.
 *
 * Measured against a real MongoDB because `filter` reads one; `read_file` needs only the file store.
 *
 * Run: node --test testing/standalone/a-tool-answer-crosses-the-wire-within-its-budget-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-wire-budget-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config', 'config.json');
process.env['DATA_ROOT'] = tmpDir;
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['MODEL_CACHE_DIR'] = path.join(tmpDir, 'empty-model-cache');

/** The MCP default budget and the REST one — literal on purpose: the fixture must not read the code it tests. */
const MCP_DEFAULT = 25_000;
/** What the answer's own accounting fields (count, total, budget figures, nextSkip) may add on top of the rows. */
const ENVELOPE = 2_048;

const PARAGRAPH = `${'lorem ipsum dolor sit amet '.repeat(40)}\n\n`;
const BIG_FILE = PARAGRAPH.repeat(2000);

let mongo, filterTool, readFileTool, restBody;

const ctx = (name, args, transport) => ({
  args, name, transport, callSpace: SPACE, callSpaces: [SPACE], accessibleSpaceIds: [SPACE],
  accessibleSpaces: [{ id: SPACE, label: 'General' }], cfg: {}, rateKey: 'test',
});
const wireBytes = v => Buffer.byteLength(JSON.stringify(v), 'utf8');

describe('a tool answer crosses the wire within the budget it states', { skip }, () => {
  before(async () => {
    fs.mkdirSync(path.dirname(process.env['CONFIG_PATH']), { recursive: true });
    fs.mkdirSync(process.env['MODEL_CACHE_DIR'], { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'wire', instanceLabel: 'wire', spaces: [{ id: SPACE, label: 'General', folders: [] }], networks: [], tokens: [],
    }), { mode: 0o600 });
    fs.mkdirSync(path.join(tmpDir, 'files', SPACE), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'files', SPACE, 'big.md'), BIG_FILE);

    mongo = await openTestMongo('wirebudget');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    const now = new Date().toISOString();
    await mongo.col(`${SPACE}_facts`).insertMany(Array.from({ length: 400 }, (_, i) => ({
      _id: randomUUID(), spaceId: SPACE, fact: `fact ${i} ${'x'.repeat(480)}`, tags: [], seq: i + 1,
      author: { instanceId: 'wire', instanceLabel: 'wire' }, createdAt: now, updatedAt: now,
    })));
    ({ queryTool: filterTool } = await import('../../server/dist/mcp/tools/filter.js'));
    ({ read_fileTool: readFileTool } = await import('../../server/dist/mcp/tools/file.js'));
    ({ restToolBody: restBody } = await import('../../server/dist/api/tools.js'));
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('MCP: a filter page at the default budget is within that budget, both carriages together', async () => {
    const r = await filterTool.handle(ctx('filter', { space: SPACE, collection: 'facts', limit: 400 }, 'mcp'));
    const bytes = wireBytes(r);
    assert.ok(r.structuredContent.results.length > 0 && r.structuredContent.truncated === true,
      'the fixture must be larger than one budget, or this measures nothing');
    assert.ok(bytes <= MCP_DEFAULT + ENVELOPE, `an MCP filter page at the ${MCP_DEFAULT}-character default sent ${bytes} bytes`);
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent.results,
      'both carriages must still hold the whole page — a client reading either one gets every row');
  });

  it('MCP: an explicit maxChars bounds the total the same way', async () => {
    const r = await filterTool.handle(ctx('filter', { space: SPACE, collection: 'facts', limit: 400, maxChars: 10_000 }, 'mcp'));
    assert.ok(wireBytes(r) <= 10_000 + ENVELOPE, `maxChars 10 000 sent ${wireBytes(r)} bytes`);
  });

  it('REST: the tool door sends the answer once — `data` when there is one, `text` only when there is not', async () => {
    const r = await filterTool.handle(ctx('filter', { space: SPACE, collection: 'facts', limit: 400, maxChars: 20_000 }, 'rest'));
    assert.ok(restBody, 'api/tools exports no restToolBody — the REST envelope is not a function a test can hold');
    const body = restBody({ status: 200, result: r });
    assert.ok(typeof body.text === 'string' && body.text.length < 200,
      `the REST body still repeats the answer in \`text\` beside \`data\`, so the page crosses twice (${String(body.text).length} characters)`);
    assert.deepEqual(body.data.results, r.structuredContent.results);
    assert.ok(wireBytes(body) <= 20_000 + ENVELOPE, `REST maxChars 20 000 sent ${wireBytes(body)} bytes`);
    const textOnly = restBody({ status: 200, result: { content: [{ type: 'text', text: 'hello' }] } });
    assert.equal(textOnly.text, 'hello', 'a tool with no structured answer keeps its text');
  });

  it('read_file is budgeted: a 2 MB file at the MCP default arrives within the budget, and says where to go on', async () => {
    const r = await readFileTool.handle(ctx('read_file', { space: SPACE, path: 'big.md' }, 'mcp'));
    const bytes = wireBytes(r);
    assert.ok(bytes <= MCP_DEFAULT + ENVELOPE, `read_file sent ${bytes} bytes for a ${BIG_FILE.length}-character file`);
    assert.equal(r.structuredContent.truncated, true);
    assert.equal(typeof r.structuredContent.markdownNextSkip, 'number');
  });

  it('read_file pages the whole file with markdownSkip — no gap, no overlap — and the last page says it is the last', async () => {
    let at = 0;
    let text = '';
    for (let page = 0; page < 1000; page++) {
      const r = await readFileTool.handle(ctx('read_file', { space: SPACE, path: 'big.md', markdownSkip: at, maxChars: 200_000 }, 'mcp'));
      text += r.structuredContent.content;
      if (!r.structuredContent.truncated) break;
      at = r.structuredContent.markdownNextSkip;
    }
    assert.equal(text.length, BIG_FILE.length);
    assert.equal(text, BIG_FILE);
  });
});
