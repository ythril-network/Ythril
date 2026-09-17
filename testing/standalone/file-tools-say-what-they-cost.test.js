/**
 * The file tools say what a call COSTS and what an empty answer means.
 *
 * ## X-2, the file family
 *
 * `read_file` said *"Read the text contents of a file in the space file store."* and `write_file` the
 * matching one line. Both are accurate and neither tells a caller the two things that decide how to use them.
 *
 * ## Cost, because a file is the largest thing stored
 *
 * A read is the whole file — no paging — and a passage body is by far the biggest field any result carries.
 * The cheap flow is `recall` with `includeFileContent: false` to find WHICH file and WHICH passage, then read
 * only if the rest is needed. That flow already exists and `recall`'s own schema describes it; the file tool
 * never pointed at it, so a caller reaching for a file first pays for a document to answer a sentence.
 *
 * ## Empty means several different things
 *
 * A file whose extraction has not finished reads as empty. So does one whose type yields no text. So does an
 * actually-empty file. Without being told, all three look like "the document is blank" — and the first is a
 * wait, not a fact.
 *
 * ## And a write is a REPLACE
 *
 * There is no append and no patch. Writing an existing path overwrites it silently, which is the destructive
 * default a caller should be told about before discovering it.
 *
 * Run: node --test testing/standalone/file-tools-say-what-they-cost.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('server/src/mcp/tools/file.ts', 'utf8');
const tool = (name) => {
  const at = SRC.indexOf(`name: '${name}'`);
  assert.ok(at > 0, `${name} was not found — the scanner is wrong, not the code`);
  const next = SRC.indexOf("name: '", at + 20);
  return next === -1 ? SRC.slice(at) : SRC.slice(at, next);
};

const READ = tool('read_file');
const WRITE = tool('write_file');

describe('read_file states the cost and points at the cheaper flow', () => {
  it('says it is the whole file with no paging', () => {
    assert.match(READ, /Whole file, no paging/,
      'a caller sizing a request needs to know there is no window');
  });

  it('names the two-phase alternative rather than just warning', () => {
    assert.match(READ, /includeFileContent: false/,
      'point at the flow that answers the question cheaply — a warning with no remedy is half an answer');
  });

  it('distinguishes pending extraction from an empty document', () => {
    // Three different things read as empty, and one of them is a wait.
    assert.match(READ, /pending or unextractable/,
      'an empty read is not evidence the document is blank');
  });

  it('says an unknown path is an error, not an empty result', () => {
    assert.match(READ, /not a search/, 'a path lookup and a search fail differently');
  });
});

describe('write_file states that it replaces', () => {
  it('says there is no append and no patch', () => {
    assert.match(WRITE, /REPLACES THE WHOLE FILE/, 'the destructive default must be stated, not discovered');
    assert.match(WRITE, /overwrites it without asking/, 'and that an existing path is taken silently');
  });

  it('explains chunking, because it is why recall returns passages', () => {
    assert.match(WRITE, /CHUNKED/, 'a file is stored as chunks and each is embedded separately');
    assert.match(WRITE, /Structure the text with headings/,
      'the actionable half: a chunk under a heading carries it, which is what makes a hit locatable');
  });

  it('warns that embedding is asynchronous here too', () => {
    // Same trap as `saveFact`, and a caller who learned it there should find it confirmed here rather than
    // having to assume it generalises.
    assert.match(WRITE, /ASYNCHRONOUS/, 'the write returns before the chunks are searchable');
    assert.match(WRITE, /Rewriting a file resets its embedding/,
      'new content is new content — a previous embedding failure is not carried forward');
  });
});
