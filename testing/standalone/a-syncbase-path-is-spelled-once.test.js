/**
 * The key `syncBase.<peer>` is spelled in ONE function, and every site that builds it calls that function (`Q-433`, plan rev 4
 * item 20).
 *
 * ## What it prevents
 *
 * A file row records, per peer, the hash both sides last agreed on, under `syncBase.<peer instance id>` — local state, never
 * replicated. The path is a string a Mongo filter or an update names, and it was built by hand at every site: a template in the
 * pull's read, another in the write that records the base after a transfer. `file_stamp_report` is the third caller (it asks
 * which rows carry a base for the peer being compared), and a third hand-written spelling is where the reader and the writer
 * stop agreeing — the next change to how the key is formed (a different id, an escaped character) lands in two of three
 * places, and a row looks unsynced to one of them and synced to the other. A report that finds no candidates for a peer that
 * has sixty is the kind of wrong nobody reports.
 *
 * ## The rule
 *
 * `syncBasePath(peerId)` (in `sync/file-sync.ts`, where the base is read and recorded) returns the path; nothing else in the server
 * writes `syncBase.` followed by an expression. This file derives that function from the source (the one module that exports it) and
 * sweeps the server for any other file that builds the key, in the spellings a path is built in: a template literal, a
 * concatenation, and an array joined with a dot. A string that merely CONTAINS the word (a log line, a doc) is not a spelling.
 * Comments are blanked first, so a docblock explaining the key is not a copy of it.
 *
 * ## Seen red
 *
 * Against the tree before the fold: `syncBasePath` does not exist and two sites in `sync/file-sync.ts` build the key. The
 * detector is held by planted copies of each spelling.
 *
 * Run: node --test testing/standalone/a-syncbase-path-is-spelled-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const SERVER_FLOOR = 300;

/** The spellings that BUILD the key from a peer id: a template, a concatenation, an array joined with a dot. */
const BUILDERS = [
  ['a template literal', /`syncBase\.\$\{/],
  ['a concatenation', /['"`]syncBase\.['"`]\s*\+|\+\s*['"`]syncBase\.['"`]/],
  ['a dotted join', /\[\s*['"`]syncBase['"`]\s*,[^\]]*\]\s*\.join\(\s*['"`]\.['"`]\s*\)/],
];

/** The files that declare the one function, found in the source: `{ file, text }` of each. */
const declaring = (sources) => sources.filter(({ text }) => /export\s+(?:async\s+)?function\s+syncBasePath\b|export\s+const\s+syncBasePath\b/.test(blankComments(text)));

/**
 * Every place in `sources` that builds the key, `[{ file, spelling }]`, EXCEPT inside `syncBasePath` itself: the function's own
 * body is where the spelling belongs, so it is removed from its file's text before the scan.
 */
export function keyBuilders(sources) {
  const out = [];
  for (const { file, text } of sources) {
    // `bodyOf` joins its window with LF, so a CRLF checkout must be compared as LF or the body is never removed.
    let code = blankComments(text).replace(/\r\n/g, '\n');
    if (declaring([{ file, text }]).length > 0) code = code.replace(bodyOf(code, 'syncBasePath', 'the declaration of syncBasePath'), '');
    for (const [spelling, re] of BUILDERS) if (re.test(code)) out.push({ file, spelling });
  }
  return out;
}

const server = () => readTrackedSources('server/src', { untracked: true, floor: SERVER_FLOOR });

describe('the syncBase path is spelled once', () => {
  it('exactly one module exports syncBasePath', () => {
    const where = declaring(server()).map(s => s.file);
    assert.equal(where.length, 1, `syncBasePath is exported by ${where.length} module(s): ${where.join(', ') || 'none'} — the one spelling of \`syncBase.<peer>\` does not exist`);
    assert.equal(where[0], 'server/src/sync/file-sync.ts', 'the path is built where the base is read and recorded');
  });

  it('no site in the server builds the key by hand', () => {
    const builders = keyBuilders(server());
    assert.deepEqual(builders.map(b => `${b.file} (${b.spelling})`), [],
      'a hand-built `syncBase.<peer>`: call syncBasePath(peerId) — the reader, the recorder and the stamp report must agree on what '
      + 'a peer id is turned into a key');
  });

  it('the function answers what the sites it replaced wrote', async () => {
    const { syncBasePath } = await import('../../server/dist/sync/file-sync.js');
    assert.equal(syncBasePath('peer-a'), 'syncBase.peer-a');
    assert.equal(syncBasePath('0b1c2d3e-4f50-6789-abcd-ef0123456789'), 'syncBase.0b1c2d3e-4f50-6789-abcd-ef0123456789');
  });
});

describe('the sweep sees what it claims to', () => {
  const planted = (text, file = 'server/src/sync/planted.ts') => keyBuilders([{ file, text }]).map(b => b.spelling);

  it('it finds each way of building the key', () => {
    assert.deepEqual(planted('const k = `syncBase.${peerId}`;'), ['a template literal']);
    assert.deepEqual(planted(`const k = 'syncBase.' + peerId;`), ['a concatenation']);
    assert.deepEqual(planted(`const k = "syncBase." + peer.instanceId;`), ['a concatenation']);
    assert.deepEqual(planted(`const k = peerId + 'syncBase.';`), ['a concatenation']);
    assert.deepEqual(planted(`const k = ['syncBase', peerId].join('.');`), ['a dotted join']);
  });

  it('it does not find the word in a comment, a message, or a read of the object', () => {
    assert.deepEqual(planted('// the base lives under `syncBase.${peer}`\nconst x = 1;'), []);
    assert.deepEqual(planted('const m = "the syncBase for the peer is missing";'), []);
    assert.deepEqual(planted('const held = row.syncBase?.[peerId];'), []);
    assert.deepEqual(planted(`const projection = { syncBase: 1 };`), []);
  });

  it('inside syncBasePath it is the one spelling; the same text anywhere else is a copy', () => {
    const body = 'export function syncBasePath(peerId: string): string {\n  return `syncBase.${peerId}`;\n}\n';
    assert.deepEqual(planted(body, 'server/src/sync/file-sync.ts'), [], 'the function\'s own body was reported');
    assert.deepEqual(planted(`${body}\nexport function other(peerId: string) {\n  return \`syncBase.\${peerId}\`;\n}\n`, 'server/src/sync/file-sync.ts'), ['a template literal'],
      'a second spelling in the SAME file as the function was not reported');
  });

  it('a second declaration of the function in another module is counted, so a copy cannot hide as "the function"', () => {
    const body = 'export function syncBasePath(peerId: string): string {\n  return `syncBase.${peerId}`;\n}\n';
    assert.equal(declaring([{ file: 'server/src/sync/file-sync.ts', text: body }, { file: 'server/src/sync/elsewhere.ts', text: body }]).length, 2);
  });
});
