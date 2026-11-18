/**
 * A document's text window that was cut names the ceiling that cut it (`Q-173`).
 *
 * `read_file` and `GET …/files/extract` answer a document's text a window at a time, held to the same three ceilings every other
 * budgeted answer is held to: `maxChars` (or `maxTokens`, converted) and `maxBytes`. Every other budgeted answer names the ceiling
 * that stopped it as `budgetBoundBy` (`a-truncated-answer-names-its-ceiling.test.js`); the window said `truncated: true` and
 * `markdownNextSkip` and nothing about WHICH of the three to raise. With non-ASCII text that matters most: a byte ceiling binds
 * before the character ceiling, and a caller who raises `maxChars` gets the same window back.
 *
 * What this pins, from the rule and not from the code:
 *  - a window that was cut carries `budgetBoundBy`, the parameter whose ceiling the next paragraph (or, for a first paragraph larger
 *    than the window, the next character) would have passed; both are named when it would have passed both;
 *  - the key is absent on a window that was not cut, and on the last page of a paged read;
 *  - `read_file` is driven for real against the file store, on both transports, and the route that answers the same window is held
 *    to the same call (it needs Mongo for the file's record, so only its source is read here, as `extract-view.test.js` reads it).
 *
 * Run: npm run build -w server && node --test testing/standalone/a-cut-text-window-names-its-ceiling.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SPACE = 'general';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-window-ceiling-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config', 'config.json');
process.env['DATA_ROOT'] = tmpDir;

/** Thirty paragraphs of 101 characters each: 99 letters and the blank line that ends the paragraph. */
const ascii = `${'a'.repeat(99)}\n\n`.repeat(30);
/** The same, in ü: 101 characters, 200 bytes a paragraph, so a byte ceiling binds at about half the characters. */
const german = `${'ü'.repeat(99)}\n\n`.repeat(30);
/** One paragraph with no line break, larger than every window below. */
const longUmlauts = 'ü'.repeat(3000);

const FILES = { 'ascii.md': ascii, 'german.md': german, 'long.md': longUmlauts, 'short.md': 'one short paragraph\n' };

let readFile, windowModule;

const ctx = (args, transport) => ({
  args: { space: SPACE, ...args }, name: 'read_file', transport, callSpace: SPACE, callSpaces: [SPACE], accessibleSpaceIds: [SPACE],
  viewReads: new Map(), accessibleSpaces: [{ id: SPACE, label: 'General' }], cfg: {}, rateKey: 'test',
});
const read = async (file, args, transport = 'rest') => (await readFile.handle(ctx({ path: file, ...args }, transport))).structuredContent;

describe('a cut text window names the ceiling that cut it', () => {
  before(async () => {
    fs.mkdirSync(path.dirname(process.env['CONFIG_PATH']), { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'window', instanceLabel: 'window', spaces: [{ id: SPACE, label: 'General', folders: [] }], networks: [], tokens: [],
    }), { mode: 0o600 });
    fs.mkdirSync(path.join(tmpDir, 'files', SPACE), { recursive: true });
    for (const [name, text] of Object.entries(FILES)) fs.writeFileSync(path.join(tmpDir, 'files', SPACE, name), text);
    (await import('../../server/dist/config/loader.js')).loadConfig();
    ({ read_fileTool: readFile } = await import('../../server/dist/mcp/tools/file.js'));
    windowModule = await import('../../server/dist/files/markdown-window.js');
  });

  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('a character ceiling that cut the window is named maxChars', async () => {
    const a = await read('ascii.md', { maxChars: 1000 });
    assert.equal(a.truncated, true, 'fixture: thirty 101-character paragraphs are cut by a 1000-character ceiling');
    assert.deepEqual(a.budgetBoundBy, ['maxChars']);
  });

  it('the token ceiling, when its conversion is the lower character ceiling, is named maxTokens', async () => {
    // 400 tokens are 1400 characters, the lower of the two; a budget below 1000 characters is raised to 1000, so the fixture stays above it.
    const a = await read('ascii.md', { maxChars: 5000, maxTokens: 400 });
    assert.equal(a.truncated, true);
    assert.deepEqual(a.budgetBoundBy, ['maxTokens']);
  });

  it('a byte ceiling is named maxBytes when ASCII text passes it first', async () => {
    const a = await read('ascii.md', { maxChars: 5000, maxBytes: 500 });
    assert.equal(a.truncated, true);
    assert.deepEqual(a.budgetBoundBy, ['maxBytes']);
  });

  it('with non-ASCII text the byte ceiling binds before the character ceiling, and only it is named', async () => {
    const a = await read('german.md', { maxChars: 1000, maxBytes: 1000 });
    assert.equal(a.truncated, true);
    assert.equal(a.markdownChars, german.length);
    assert.deepEqual(a.budgetBoundBy, ['maxBytes'], 'five 200-byte paragraphs fill 1000 bytes in 505 characters: raising maxChars would change nothing');
  });

  it('with non-ASCII text and no byte ceiling the character ceiling is the one named', async () => {
    const a = await read('german.md', { maxChars: 1000 });
    assert.deepEqual(a.budgetBoundBy, ['maxChars']);
  });

  it('both are named when the next paragraph would pass both ceilings', async () => {
    const a = await read('ascii.md', { maxChars: 1000, maxBytes: 1000 });
    assert.deepEqual([...a.budgetBoundBy].sort(), ['maxBytes', 'maxChars']);
  });

  it('a first paragraph larger than the window is split, and the ceiling that stopped the split is named', async () => {
    const bytes = await read('long.md', { maxChars: 1000, maxBytes: 1000 });
    assert.equal(bytes.truncated, true);
    assert.ok(bytes.content.length < 1000, `the byte ceiling binds at 500 ü, the window held ${bytes.content.length}`);
    assert.deepEqual(bytes.budgetBoundBy, ['maxBytes']);
    const chars = await read('long.md', { maxChars: 1000, maxBytes: 5000 });
    assert.equal(chars.content.length, 1000);
    assert.deepEqual(chars.budgetBoundBy, ['maxChars']);
  });

  it('MCP carries the answer twice and holds each copy to half the stated budget, and still names the parameter the caller stated', async () => {
    const a = await read('ascii.md', { maxChars: 2000 }, 'mcp');
    assert.equal(a.truncated, true);
    assert.equal(a.budgetChars, 2000);
    assert.deepEqual(a.budgetBoundBy, ['maxChars']);
    const b = await read('german.md', { maxChars: 4000, maxBytes: 2000 }, 'mcp');
    assert.deepEqual(b.budgetBoundBy, ['maxBytes']);
  });

  it('a window that was not cut carries no budgetBoundBy, and neither does the last page of a paged read', async () => {
    for (const [file, args] of [['short.md', {}], ['ascii.md', {}], ['ascii.md', { maxChars: 1000, maxBytes: 1000, markdownSkip: ascii.length - 101 }]]) {
      const a = await read(file, args);
      assert.equal(a.truncated, false, `fixture: ${file} ${JSON.stringify(args)} must be read whole`);
      assert.equal('budgetBoundBy' in a, false, `${file} ${JSON.stringify(args)} was not cut, so no ceiling cut it`);
    }
  });

  it('a paged read names a ceiling on every page but the last, and the pages join into the file', async () => {
    let at = 0;
    let text = '';
    const named = [];
    for (let i = 0; i < 20; i++) {
      // 600 bytes hold three 200-byte paragraphs, so the thirty paragraphs come in ten windows, the tenth filling the ceiling exactly.
      const a = await read('german.md', { maxChars: 1000, maxBytes: 600, markdownSkip: at });
      text += a.content;
      named.push(a.truncated ? JSON.stringify(a.budgetBoundBy) : 'last');
      if (!a.truncated) break;
      at = a.markdownNextSkip;
    }
    assert.equal(text, german);
    assert.deepEqual(named, [...Array.from({ length: 9 }, () => '["maxBytes"]'), 'last']);
  });

  it('the window module names the ceiling from the slicer, in the one function both doors call', () => {
    const { markdownWindow, windowCeilingFields } = windowModule;
    assert.equal(typeof windowCeilingFields, 'function', 'markdown-window.ts exports no windowCeilingFields');
    const budget = { chars: 1000, bytes: 1000, charsFrom: 'maxTokens' };
    assert.deepEqual(windowCeilingFields(markdownWindow(ascii, 0, 1000, 1000), budget), { budgetBoundBy: ['maxTokens', 'maxBytes'] });
    assert.deepEqual(windowCeilingFields(markdownWindow(german, 0, 1000, 1000), budget), { budgetBoundBy: ['maxBytes'] });
    assert.deepEqual(windowCeilingFields(markdownWindow('short\n', 0, 1000, 1000), budget), {});
  });

  it('both doors that answer the window spread that one function, from the budget they cut it with', () => {
    const strip = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const tool = strip(fs.readFileSync('server/src/mcp/tools/file.ts', 'utf8'));
    const route = strip(fs.readFileSync('server/src/api/brain/file-meta.ts', 'utf8'));
    assert.match(tool, /\.\.\.windowCeilingFields\(w, window\.budget\)/, 'read_file does not name the ceiling that cut its window');
    assert.match(route, /\.\.\.windowCeilingFields\(w, textWindow\.budget\)/, 'the extract route does not name the ceiling that cut its window');
  });
});
