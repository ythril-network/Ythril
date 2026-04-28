/**
 * Unit tests: Markdown normaliser, section chunker, paragraph chunker.
 * These tests run against the compiled server modules directly.
 * No running server or database needed.
 *
 * Run: node --test testing/standalone/file-conversion-unit.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseMarkdown } from '../../server/dist/files/converters/normaliser.js';
import { sectionChunk } from '../../server/dist/files/converters/section-chunker.js';
import { paragraphChunk } from '../../server/dist/files/converters/paragraph-chunker.js';
import { resolveInputFormat } from '../../server/dist/files/converters/pipeline.js';

describe('normaliseMarkdown', () => {
  it('strips page-number lines', () => {
    const input = 'Hello\nPage 1\n\nWorld\n---Page 2 of 10\n';
    const out = normaliseMarkdown(input);
    assert.ok(!out.includes('Page 1'));
    assert.ok(!out.includes('Page 2'));
    assert.ok(out.includes('Hello'));
    assert.ok(out.includes('World'));
  });

  it('collapses 3+ blank lines to 1', () => {
    const input = 'A\n\n\n\n\nB';
    const out = normaliseMarkdown(input);
    assert.ok(!out.match(/\n{4,}/));
  });

  it('shifts H1-only headings to H2', () => {
    const input = '# Title\n\nContent\n\n# Section Two\n\nMore content';
    const out = normaliseMarkdown(input);
    assert.ok(out.includes('## Title'));
    assert.ok(out.includes('## Section Two'));
    assert.ok(!out.match(/^# /m)); // no H1-level headings should remain
  });

  it('shifts H1/H2 document: H1→H2, H2→H3', () => {
    const input = '# Chapter\n\nText\n\n## Sub\n\nMore';
    const out = normaliseMarkdown(input);
    assert.ok(out.includes('## Chapter'));
    assert.ok(out.includes('### Sub'));
  });

  it('no-op when headings already start at H2', () => {
    const input = '## Section\n\nContent\n\n### Subsection\n\nMore';
    const out = normaliseMarkdown(input);
    assert.ok(out.includes('## Section'));
    assert.ok(out.includes('### Subsection'));
  });
});

describe('sectionChunk', () => {
  it('splits on H2 headings', () => {
    const md = '## Introduction\n\n' + 'a'.repeat(200) + '\n\n## Details\n\n' + 'b'.repeat(200);
    const chunks = sectionChunk(md, { minBodyLength: 50 });
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].headingText, 'Introduction');
    assert.equal(chunks[1].headingText, 'Details');
  });

  it('splits on H3 headings', () => {
    const md = '### Part A\n\n' + 'x'.repeat(200) + '\n\n### Part B\n\n' + 'y'.repeat(200);
    const chunks = sectionChunk(md, { minBodyLength: 50 });
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].headingText, 'Part A');
  });

  it('merges short chunk into previous', () => {
    const md = '## Big Section\n\n' + 'a'.repeat(300) + '\n\n## Tiny\n\nshort';
    const chunks = sectionChunk(md, { minBodyLength: 150 });
    assert.equal(chunks.length, 1);
  });

  it('does not split table across chunk boundaries', () => {
    const md = '## Section\n\n' + 'a'.repeat(200) + '\n\n<table><tr><td>Cell</td></tr></table>\n\n## Next\n\n' + 'b'.repeat(200);
    const chunks = sectionChunk(md, { minBodyLength: 50 });
    const tableInChunks = chunks.filter(c => c.content.includes('<table>'));
    assert.equal(tableInChunks.length, 1);
  });

  it('includes overlap from previous chunk', () => {
    const md = '## First\n\nFirst paragraph content here.\n\nSecond paragraph content here.\n\n## Second\n\n' + 'c'.repeat(200);
    const chunks = sectionChunk(md, { minBodyLength: 50 });
    assert.ok(chunks.length >= 2);
    if (chunks.length >= 2) {
      assert.ok(chunks[1].content.includes('paragraph'));
    }
  });

  it('assigns sequential chunkIndex values', () => {
    const md = '## A\n\n' + 'a'.repeat(200) + '\n\n## B\n\n' + 'b'.repeat(200) + '\n\n## C\n\n' + 'c'.repeat(200);
    const chunks = sectionChunk(md, { minBodyLength: 50 });
    chunks.forEach((c, i) => assert.equal(c.chunkIndex, i));
  });
});

describe('paragraphChunk', () => {
  it('splits on double newlines', () => {
    const text = 'a'.repeat(100) + '\n\n' + 'b'.repeat(100) + '\n\n' + 'c'.repeat(100);
    const chunks = paragraphChunk(text, { maxChunkLength: 150 });
    assert.ok(chunks.length >= 2);
  });

  it('sets headingText to null', () => {
    const text = 'Para one.\n\nPara two.';
    const chunks = paragraphChunk(text);
    for (const c of chunks) assert.equal(c.headingText, null);
  });

  it('concatenates paragraphs up to maxChunkLength', () => {
    const text = 'Short one.\n\nShort two.\n\nShort three.';
    const chunks = paragraphChunk(text, { maxChunkLength: 800 });
    assert.equal(chunks.length, 1);
  });
});

describe('resolveInputFormat', () => {
  it('"text" → "text"', () => {
    assert.equal(resolveInputFormat('doc.pdf', undefined, 'text'), 'text');
  });
  it('"auto" + .pdf extension → "pdf"', () => {
    assert.equal(resolveInputFormat('report.pdf', undefined, 'auto'), 'pdf');
  });
  it('"auto" + .md extension → "md"', () => {
    assert.equal(resolveInputFormat('readme.md', undefined, 'auto'), 'md');
  });
  it('"auto" + .txt extension → "txt"', () => {
    assert.equal(resolveInputFormat('notes.txt', undefined, 'auto'), 'txt');
  });
  it('"auto" + .html extension → "html"', () => {
    assert.equal(resolveInputFormat('page.html', undefined, 'auto'), 'html');
  });
  it('"auto" + unknown extension → "text" (bypass)', () => {
    assert.equal(resolveInputFormat('data.xyz', undefined, 'auto'), 'text');
  });
  it('MIME type overrides extension for auto', () => {
    assert.equal(resolveInputFormat('file.bin', 'application/pdf', 'auto'), 'pdf');
  });
  it('explicit "md" overrides extension', () => {
    assert.equal(resolveInputFormat('file.txt', undefined, 'md'), 'md');
  });
});
