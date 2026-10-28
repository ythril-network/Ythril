/**
 * `read_file` takes the extract route's `limit`, `skip`, `imagesLimit` and `imagesSkip`, with the same defaults, caps, refusals and
 * answer shape (Q-647).
 *
 * ## What was missing
 *
 * `GET /api/brain/spaces/:spaceId/files/extract` pages a file's chunks (`limit`/`skip`) and its extracted images
 * (`imagesLimit`/`imagesSkip`); `read_file`, the capability map's tool for that route, took only the Markdown window
 * (`markdownSkip` and the budget). An agent could read a long document's text and could not reach its 101st chunk, or the images a
 * conversion extracted from it. `a-tool-and-its-route-take-the-same-parameters` found it from the route's side once the pairing
 * stopped putting `read_file` beside the bytes download.
 *
 * ## What this holds
 *
 * - the tool declares the four, WITHOUT a `minimum` or `maximum` (the dispatcher would refuse what the route clamps or refuses in
 *   its own words);
 * - asked, the answer carries the route's own fields: `chunks`, `chunkTotal`, `limit`, `skip`, `images`, `imagesTotal`,
 *   `imagesTruncated`, `imagesNextSkip`, from the ONE module both doors read them through (`files/extract-listing.ts`);
 * - `limit` is held to 500 and echoed as the limit that applied, `imagesLimit` to 200, a bad value is refused in the route's words;
 * - not asked, the answer is what it always was: the text window and nothing else.
 *
 * Run: node --test testing/standalone/read-file-takes-the-extract-listing-parameters-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-read-file-listing-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config', 'config.json');
process.env['DATA_ROOT'] = tmpDir;

const PARENT = 'doc.md';
const CHUNKS = 7;
const IMAGES = 5;

let mongo, readFileTool;

const ctx = (args, transport = 'mcp') => ({
  args: { space: SPACE, ...args }, name: 'read_file', transport, callSpace: SPACE, callSpaces: [SPACE], accessibleSpaceIds: [SPACE],
  viewReads: new Map(), accessibleSpaces: [{ id: SPACE, label: 'General' }], cfg: {}, rateKey: 'test',
});
const meta = (id, extra = {}) => ({ _id: id, spaceId: SPACE, path: id, sizeBytes: 10, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', seq: 1, ...extra });

describe('read_file takes the extract route\'s listing parameters', { skip }, () => {
  before(async () => {
    fs.mkdirSync(path.dirname(process.env['CONFIG_PATH']), { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'rf', instanceLabel: 'rf', spaces: [{ id: SPACE, label: 'General', folders: [] }], networks: [], tokens: [],
    }), { mode: 0o600 });
    fs.mkdirSync(path.join(tmpDir, 'files', SPACE), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'files', SPACE, PARENT), '# Title\n\nfirst paragraph\n\nsecond paragraph\n');
    mongo = await openTestMongo('readfilelisting');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    const docs = [
      meta(PARENT, { embeddingStatus: 'complete' }),
      ...Array.from({ length: CHUNKS }, (_, i) => meta(`${PARENT}#chunk${i}`, { parentFileId: PARENT, chunkIndex: i, content: `chunk ${i}`, headingText: `H${i}` })),
      ...Array.from({ length: IMAGES }, (_, i) => meta(`_extracted/${PARENT}/img${i}.png`, { parentFileId: PARENT, description: `image ${i}` })),
    ];
    await mongo.col(`${SPACE}_files`).insertMany(docs);
    ({ read_fileTool: readFileTool } = await import('../../server/dist/mcp/tools/file.js'));
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the tool declares limit, skip, imagesLimit and imagesSkip as integers with no bounds the route does not have', () => {
    const props = readFileTool.inputSchema({ requiredSpace: { type: 'string' } }).properties;
    for (const k of ['limit', 'skip', 'imagesLimit', 'imagesSkip']) {
      assert.equal(props[k]?.type, 'integer', `\`${k}\` is not declared`);
      assert.equal(props[k].maximum, undefined, `a \`maximum\` on ${k} would refuse what the route clamps`);
      assert.equal(props[k].minimum, undefined, `a \`minimum\` on ${k} would refuse in the schema's words and not the route's`);
    }
  });

  it('chunks page with limit and skip, in document order, with the route\'s own fields', async () => {
    const r = await readFileTool.handle(ctx({ path: PARENT, limit: 3, skip: 2 }));
    const s = r.structuredContent;
    assert.deepEqual(s.chunks.map(c => c.index), [2, 3, 4]);
    assert.equal(s.chunkTotal, CHUNKS);
    assert.equal(s.limit, 3);
    assert.equal(s.skip, 2);
    assert.equal(s.chunks[0].content, 'chunk 2');
    assert.equal(s.chunks[0].headingText, 'H2');
    assert.ok(s.content.includes('first paragraph'), 'the text window is still there beside the listing');
  });

  it('images page with imagesLimit and imagesSkip and say when they were cut and where to go on', async () => {
    const r = await readFileTool.handle(ctx({ path: PARENT, imagesLimit: 2, imagesSkip: 1 }));
    const s = r.structuredContent;
    assert.deepEqual(s.images.map(i => i.path), [`_extracted/${PARENT}/img1.png`, `_extracted/${PARENT}/img2.png`]);
    assert.equal(s.imagesTotal, IMAGES);
    assert.equal(s.imagesTruncated, true);
    assert.equal(s.imagesNextSkip, 3);
    assert.ok(Array.isArray(s.chunks), 'asking for any one of the four brings the whole listing, defaults for the rest');
    assert.equal(s.limit, 100, 'the route\'s default page of chunks');
  });

  it('limit is held to the route\'s ceiling and echoed as the limit that applied; imagesLimit to its own', async () => {
    const r = await readFileTool.handle(ctx({ path: PARENT, limit: 100000, imagesLimit: 100000 }));
    assert.equal(r.structuredContent.limit, 500);
    assert.equal(r.structuredContent.images.length, IMAGES);
  });

  it('a bad imagesLimit or imagesSkip is refused in the route\'s words, before anything is read', async () => {
    await assert.rejects(readFileTool.handle(ctx({ path: PARENT, imagesLimit: 0 })), /`imagesLimit` must be a positive integer/);
    await assert.rejects(readFileTool.handle(ctx({ path: PARENT, imagesSkip: -1 })), /`imagesSkip` must be a non-negative integer/);
  });

  it('a file with no metadata record is the route\'s 404 when a listing is asked for', async () => {
    fs.writeFileSync(path.join(tmpDir, 'files', SPACE, 'bare.md'), 'x');
    await assert.rejects(readFileTool.handle(ctx({ path: 'bare.md', limit: 5 })), /File metadata record not found/);
  });

  it('with none of the four stated the answer is what it always was: the text window, no listing', async () => {
    const r = await readFileTool.handle(ctx({ path: PARENT }));
    for (const k of ['chunks', 'chunkTotal', 'images', 'imagesTotal', 'limit']) {
      assert.equal(k in r.structuredContent, false, `\`${k}\` appeared in an answer that asked for no listing`);
    }
    assert.ok(r.structuredContent.content.includes('first paragraph'));
  });
});
