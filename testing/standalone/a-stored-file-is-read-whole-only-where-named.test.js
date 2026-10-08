/**
 * A stored file is read WHOLE only where a reason says it must be (bundle-48, Q-296, design D8).
 *
 * ## The defect
 *
 * A file's bytes reach this instance by streams in some places (the download route pipes `openStoredRead`, the manifest hashes
 * it chunk by chunk) and by one `Buffer` in others: the sync pull held the peer's whole body (`dl.arrayBuffer()`), the sync
 * push held the whole stored file (`readStored`) and sent it as one body, `read_file` and the REST extract read a whole
 * document to return one window of it. Each is correct for a small file and a memory failure for a large one, and the large
 * file is the one a peer syncs and an agent reads. Nothing said which of them was a decision and which was a habit, so the
 * next whole read looked exactly like the last.
 *
 * ## The rule, over the whole set
 *
 * Every whole-file read of stored bytes under `server/src` is a SITE, and every site is named in `NAMED` below, with the
 * reason it holds the file whole. A site outside the list fails; a name whose site is gone fails too (a reason nobody
 * can check is a claim that outlives the code it was about).
 *
 * What a site IS, derived from the syntax tree (so a comment, a string and a rename of a local cannot move it):
 *
 *  - `readStored(...)`: the whole-file read of the one door to stored bytes;
 *  - `readFile(...)` / `readFileBytes(...)` imported from `files/files.ts`: the same read, one wrapper out, and what
 *    `read_file` and the REST extract call;
 *  - `.arrayBuffer()`: a response or blob body buffered whole, which is what the sync pull did with a peer's file download;
 *  - a function that opens `openStoredRead(...)` AND collects what it yields (`Buffer.concat`, `.toArray()`, a stream
 *    consumer's `buffer`): a stream read whole by another spelling.
 *
 * A site's identity is its file, the named function it is in, and its kind. Never a line number (a line moves with every
 * edit above it) and never a count (a count passes when one site is traded for another).
 *
 * Not sites, on purpose: `fs.readFile` of a configuration or state file (not stored bytes: the file door is how a USER's
 * bytes are read), and the derived frame and audio temp files of the media embedders (a frame is a derived artefact of a
 * stream, read once, bounded by the extractor's own limits).
 *
 * ## Seen red
 *
 * On the base this fails on the sync pull (`arrayBuffer`), the sync push (`readStored`), `read_file` and the REST
 * extract (`readFile`), and on the peer fetch's own buffering of every non-redirect response (`ssrfSafeFetch`), which is
 * why a pull that streams cannot go through it unchanged. The self-test at the end feeds the detector one source of each
 * kind, so the gate is also seen to FIND each kind, not only to pass over today's tree.
 *
 * Run: node --test testing/standalone/a-stored-file-is-read-whole-only-where-named.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { ts, parseSource, lineOf } from '../_shared/syntax-tree.mjs';

/** The wrappers of `files/files.ts` that read a stored file whole, by the name a caller imports. */
const WRAPPERS = new Set(['readFile', 'readFileBytes']);
/** What collects a stream into one buffer, by callee text. */
const COLLECTORS = ['Buffer.concat', 'consumers.buffer', 'buffer'];

/**
 * The sites that hold a stored file (or a body) whole ON PURPOSE, with the reason. `key` is `file :: function :: kind`.
 * Adding a row is the decision this gate exists to make visible: say why a window or a stream does not do.
 */
const NAMED = [
  { key: 'server/src/files/files.ts :: readFile :: readStored',
    why: 'the wrapper itself: it reads whole by contract and every CALLER of it is a site of its own, named or failing here' },
  { key: 'server/src/files/files.ts :: readFileBytes :: readStored',
    why: 'the wrapper itself: it reads whole by contract and every CALLER of it is a site of its own, named or failing here' },
  { key: 'server/src/files/chunks.ts :: verifiedChunks :: readStored',
    why: 'one staged chunk at a time, each at most the upload body limit (maxUploadBodyBytes); the file is never held whole' },
  { key: 'server/src/files/media/worker.ts :: processJob :: readStored',
    why: 'the embedders of an image, a clip or a recording take a Buffer by their provider contract; held for the length of one job' },
  { key: 'server/src/util/ssrf.ts :: serialiseMultipart :: arrayBuffer',
    why: 'an OUTBOUND multipart body is assembled in memory by contract: the blob was built from bytes its caller already holds' },
];

/** The enclosing named function of a node: a declaration, a method, or a `const f = () =>` / `key: () =>` binding. */
function enclosingName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n.parent) {
      const p = n.parent;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
      if (ts.isPropertyAssignment(p) && p.name) return p.name.getText();
    }
  }
  return '<module>';
}

/** The names a source imports from a module whose specifier ends `files/files.js` or is `./files.js`. */
function wrapperImports(sf) {
  const names = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (!(spec.endsWith('/files/files.js') || spec === './files.js')) continue;
    for (const el of st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings) ? st.importClause.namedBindings.elements : []) {
      const local = el.name.text;
      if (WRAPPERS.has((el.propertyName ?? el.name).text)) names.add(local);
    }
  }
  return names;
}

/**
 * Every whole-read site of one source: `{ key, line, kind }`. The ONE detector, so the self-test and the sweep read the
 * same rule.
 */
export function wholeReadSites(file, text) {
  const sf = parseSource(file, text);
  const wrappers = wrapperImports(sf);
  const sites = [];
  const add = (node, kind) => sites.push({ key: `${file} :: ${enclosingName(node)} :: ${kind}`, line: lineOf(sf, node), kind });
  const openers = new Map(); // function node -> true when it calls openStoredRead
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (callee.text === 'readStored') add(node, 'readStored');
        else if (wrappers.has(callee.text)) add(node, 'readFile');
        else if (callee.text === 'openStoredRead') {
          for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) { openers.set(n, true); break; }
        }
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'arrayBuffer' && node.arguments.length === 0) {
        add(node, 'arrayBuffer');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // A function that opens a stored stream and then collects: the same read, spelled as a loop.
  for (const fn of openers.keys()) {
    const collect = (node) => {
      if (ts.isCallExpression(node)) {
        const text = node.expression.getText(sf);
        if (COLLECTORS.includes(text) || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toArray')) {
          add(node, 'stream-collected');
        }
      }
      ts.forEachChild(node, collect);
    };
    ts.forEachChild(fn, collect);
  }
  return sites;
}

const SOURCES = trackedSources('server/src', { floor: 300 });
const sweep = SOURCES.flatMap(file => wholeReadSites(file, readFileSync(join(REPO_ROOT, file), 'utf8')));
const named = new Map(NAMED.map(n => [n.key, n.why]));

describe('a stored file is read whole only where a reason names it', () => {
  it('the sweep reaches the sources and finds the sites it is known to have', () => {
    // A floor over what was DERIVED: an empty or broken scan passes every loop below.
    assert.ok(SOURCES.length >= 300, `only ${SOURCES.length} server sources listed`);
    assert.ok(sweep.length >= NAMED.length, `the detector found ${sweep.length} whole-read sites, fewer than the ${NAMED.length} named: it is not reaching the code`);
    for (const key of ['server/src/files/files.ts :: readFile :: readStored', 'server/src/files/chunks.ts :: verifiedChunks :: readStored']) {
      assert.ok(sweep.some(s => s.key === key), `the sweep did not find the site it must: ${key}`);
    }
  });

  it('the stream readers are reached, so "no collected stream" is a finding and not an unread file', () => {
    const openers = SOURCES.filter(f => /openStoredRead\(/.test(readFileSync(join(REPO_ROOT, f), 'utf8')) && f !== 'server/src/files/stored-bytes.ts');
    assert.ok(openers.length >= 2, `only ${openers.length} callers of openStoredRead found (the download route and the manifest hash are two)`);
  });

  it('every whole-file read of stored bytes is named, with a reason', () => {
    const unnamed = sweep.filter(s => !named.has(s.key));
    assert.deepEqual(unnamed.map(s => `${s.key} (line ${s.line})`).sort(), [],
      'a stored file (or a body) is held whole here, and nothing says why a stream or a window will not do. Stream it, or name it in NAMED with the reason it must be whole. '
      + 'A sync pull or push of a large file, read_file and the REST extract are the sites this was written for.');
  });

  it('every named site still exists (a reason for code that is gone is a claim nobody can check)', () => {
    const live = new Set(sweep.map(s => s.key));
    assert.deepEqual(NAMED.filter(n => !live.has(n.key)).map(n => n.key), [],
      'a named whole read is no longer in the code: remove its row, and the reason with it');
    for (const n of NAMED) assert.ok(n.why.length > 40, `${n.key}: a reason is a sentence, not a label`);
  });

  describe('the detector finds each kind (it is seen to find, not only to pass)', () => {
    const kinds = (src, file = 'server/src/x/probe.ts') => wholeReadSites(file, src).map(s => s.kind).sort();
    it('readStored, a files.ts wrapper, arrayBuffer, and a collected stored stream', () => {
      assert.deepEqual(kinds(`import { readStored } from '../files/stored-bytes.js'; export async function f(p) { return readStored(p); }`), ['readStored']);
      assert.deepEqual(kinds(`import { readFile as rf } from '../files/files.js'; export async function f() { return rf('s', 'p'); }`), ['readFile']);
      assert.deepEqual(kinds(`export async function f(r) { return Buffer.from(await r.arrayBuffer()); }`), ['arrayBuffer']);
      assert.deepEqual(kinds(`export async function f(p) { const parts = []; for await (const c of await openStoredRead(p)) parts.push(c); return Buffer.concat(parts); }`), ['stream-collected']);
    });
    it('a comment, a string and a stream hashed chunk by chunk are not sites', () => {
      assert.deepEqual(kinds(`// readStored(p) and r.arrayBuffer()\nexport const s = 'readStored(p)';`), []);
      assert.deepEqual(kinds(`export async function h(p, hash) { for await (const c of await openStoredRead(p)) hash.update(c); }`), []);
      assert.deepEqual(kinds(`import { readFile } from 'node:fs/promises'; export const r = (p) => readFile(p);`), [], 'node:fs readFile is not the files.ts wrapper');
    });
    it('a site is keyed by its function, so a second one in the same file is a second finding', () => {
      const keys = wholeReadSites('server/src/x/probe.ts', `import { readStored } from '../files/stored-bytes.js';
        export async function a(p) { return readStored(p); }
        export async function b(p) { return readStored(p); }`).map(s => s.key);
      assert.deepEqual(keys.sort(), ['server/src/x/probe.ts :: a :: readStored', 'server/src/x/probe.ts :: b :: readStored']);
    });
  });
});
