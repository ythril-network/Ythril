/**
 * A file's converted Markdown comes back whole, or in whole paragraphs that page to the end (`Q-128`).
 *
 * The extract read answered `text.slice(0, 262144)` — cut mid-sentence, under a constant named for BYTES that sliced
 * UTF-16 characters. Now a window is whole paragraphs from `skip`, `nextSkip` says where the next one starts, and the
 * pages joined back together are the document, character for character.
 *
 * Run: npm run build -w server && node --test testing/standalone/an-extract-returns-whole-paragraphs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { markdownWindow } from '../../server/dist/files/markdown-window.js';

const doc = Array.from({ length: 40 }, (_, i) => `## Part ${i}\n\n${'Sentence of part ' + i + '. '.repeat(1)}${'x'.repeat(200)}`).join('\n\n');

describe('an extract returns whole paragraphs', () => {
  it('a document that fits comes back whole, untruncated', () => {
    const w = markdownWindow('# Title\n\nshort', 0, 10_000);
    assert.equal(w.markdown, '# Title\n\nshort');
    assert.equal(w.truncated, false);
    assert.equal(w.nextSkip, undefined);
  });

  it('a long document pages by whole paragraphs, and the pages are the document again', () => {
    let skip = 0; const pages = [];
    for (let n = 0; n < 200; n++) {
      const w = markdownWindow(doc, skip, 1_500);
      pages.push(w.markdown);
      assert.ok(w.markdown.length <= 1_500 || w.parts === 1, 'a window stays under its cap unless one paragraph alone exceeds it');
      if (!w.truncated) break;
      assert.ok(w.nextSkip > skip, 'paging moves forward');
      skip = w.nextSkip;
    }
    assert.equal(pages.join(''), doc, 'joined, the windows are the document character for character');
    for (const p of pages.slice(0, -1)) assert.match(p, /\n\n$/, 'a window ends at a paragraph boundary');
  });

  it('a single paragraph larger than the cap is split within it, and the windows still join into the document', () => {
    // It was returned whole, past the cap, until `Q-111` made the cap the budget an answer is held to.
    const doc = 'a'.repeat(5_000) + '\n\nb';
    const w = markdownWindow(doc, 0, 1_000);
    assert.equal(w.markdown.length, 1_000);
    assert.equal(w.truncated, true);
    let at = 0;
    let joined = '';
    for (let i = 0; i < 20; i++) {
      const page = markdownWindow(doc, at, 1_000);
      joined += page.markdown;
      if (!page.truncated) break;
      at = page.nextSkip;
    }
    assert.equal(joined, doc);
  });

  it('a split prefers a line break, and a byte cap binds too', () => {
    const doc = `${'x'.repeat(600)}\n${'y'.repeat(600)}\n\nz`;
    assert.equal(markdownWindow(doc, 0, 1_000).markdown, `${'x'.repeat(600)}\n`);
    const wide = 'é'.repeat(900);
    const w = markdownWindow(wide, 0, 1_000, 1_000);
    assert.ok(Buffer.byteLength(w.markdown, 'utf8') <= 1_000, 'a byte ceiling was exceeded');
  });
});
