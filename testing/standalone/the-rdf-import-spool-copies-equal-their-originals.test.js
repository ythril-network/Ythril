/**
 * The RDF import's spool holds two copies of private code, and a test holds each equal to its original (bundle-270, slice S6, G9).
 *
 * ## What it prevents
 *
 * `rdf/import-spool.ts` writes and reads its files through the chunked envelope, as the stored bytes and the export spool do. Two small rules
 * of those originals are copied there because exporting them from their modules would join the spool to the server's largest import cycle
 * (`check-i-architecture-dependency-direction`, a ratchet that only goes down: `files/stored-bytes.ts` and `sync/export-stream.ts` are members
 * and the spool is not):
 *
 * - **The derived key is cached by the secret's identity**: `stored-bytes.ts` keeps one `{ id, dk }` and derives again only when the id
 *   changes, the id being a sha256 over the secret's bytes and its kind. A copy that hashed less (the kind left out) would keep the key of
 *   a passphrase for a key of the same bytes; a copy that derived on every call would cost a scrypt per spool file.
 * - **A file is an envelope when its head says so, read at the envelope's own header size**: `sync/export-stream.ts` reads the head and asks
 *   `isChunkedEnvelope(head, size)`. A copy that read a shorter head than the header would call an envelope plain and hand ciphertext on as lines.
 *
 * Each rule is compared as source text with its identifiers named alike, so a change to the original that the copy does not follow is red here
 * and names both files. The comparison itself is held by planting a changed copy.
 *
 * Run: `node --test testing/standalone/the-rdf-import-spool-copies-equal-their-originals.test.js`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const SPOOL = 'server/src/rdf/import-spool.ts';
const STORED_BYTES = 'server/src/files/stored-bytes.ts';
const EXPORT_STREAM = 'server/src/sync/export-stream.ts';
const SECRETBOX = 'server/src/config/secretbox.ts';

const code = (file) => stripComments(readFileSync(join(REPO_ROOT, file), 'utf8').replace(/\r/g, ''));

/** `text` squeezed to single spaces. */
const squeeze = (text) => text.replace(/\s+/g, ' ').trim();

/** The first capture of `pattern` in `src`, squeezed, with `names` each replaced by its stand-in; throws naming the file when it is not there. */
function capture(file, src, pattern, names) {
  const m = pattern.exec(src);
  assert.ok(m, `${file} no longer holds the code this test reads (${pattern}): the rule moved or was reworded; read both sides and update the pattern`);
  return Object.entries(names).reduce((text, [name, standIn]) => text.replace(new RegExp(`\\b${name}\\b`, 'g'), standIn), squeeze(m[1]));
}

/** The one question: do the two readings say the same? Names the files so a red line says where to look. */
function assertSame(what, [fileA, a], [fileB, b]) {
  assert.equal(a, b, `${what}: ${fileA} says\n  ${a}\nbut ${fileB} says\n  ${b}\nOne of them changed without the other.`);
}

const KEY_ID = /(crypto\.createHash\('\w+'\)\.update\([^;]*?\)\.update\(\w+\.kind\)\.digest\('hex'\));/;
const KEY_CACHE = /(if \(!\w+ \|\| \w+\.id !== id\) \w+ = \{ id, dk: deriveKey\(\w+\) \};)/;
const HEAD_ASK = /(isChunkedEnvelope\(head\.subarray\(0, read\), size\))/;

/** The two readings of the key cache's rules in a stored-bytes source and a spool source. */
function keyRules(storedBytes, spool) {
  return {
    id: [
      [STORED_BYTES, capture(STORED_BYTES, storedBytes, KEY_ID, { s: 'S' })],
      [SPOOL, capture(SPOOL, spool, KEY_ID, { secret: 'S' })],
    ],
    cache: [
      [STORED_BYTES, capture(STORED_BYTES, storedBytes, KEY_CACHE, { writer: 'CACHE', secret: 'S', s: 'S' })],
      [SPOOL, capture(SPOOL, spool, KEY_CACHE, { writerKey: 'CACHE', secret: 'S' })],
    ],
  };
}

describe('the import spool holds each copy of an original\'s private rule equal to it', () => {
  const storedBytes = code(STORED_BYTES);
  const spool = code(SPOOL);
  const exportStream = code(EXPORT_STREAM);

  it('derived key: one id over the secret\'s bytes and its kind, derived again only when the id changes', () => {
    const { id, cache } = keyRules(storedBytes, spool);
    assertSame('the id a derived key is cached under', ...id);
    assertSame('when the derived key is derived again', ...cache);
  });

  it('envelope detection on read: the head is asked as the export spool asks it, and read at the envelope\'s own header size', () => {
    assertSame('how a head is asked whether it is an envelope', [EXPORT_STREAM, capture(EXPORT_STREAM, exportStream, HEAD_ASK, {})], [SPOOL, capture(SPOOL, spool, HEAD_ASK, {})]);
    assert.match(spool, /Buffer\.alloc\(CHUNKED_MAX_HEADER_BYTES\)/, `${SPOOL} reads its head at something other than the envelope's header size`);
    const headBytes = Number(/const head = Buffer\.alloc\((\d+)\)/.exec(exportStream)?.[1]);
    const headerBytes = readFileSync(join(REPO_ROOT, SECRETBOX), 'utf8').match(/CHUNKED_MAX_HEADER_BYTES\s*=\s*([^;]+);/)?.[1];
    assert.ok(Number.isInteger(headBytes) && headerBytes, 'the head sizes could not be read');
    const header = [...headerBytes.matchAll(/[A-Z_]+|\d+/g)].map(m => m[0]).reduce((sum, term) => {
      if (/^\d+$/.test(term)) return sum + Number(term);
      const n = Number(new RegExp(`const ${term}\\s*=\\s*(\\d+)`).exec(readFileSync(join(REPO_ROOT, SECRETBOX), 'utf8'))?.[1]);
      assert.ok(Number.isInteger(n), `${SECRETBOX}: ${term} is not a plain number this test can read`);
      return sum + n;
    }, 0);
    assert.ok(headBytes >= header, `${EXPORT_STREAM} reads ${headBytes} bytes of head but an envelope's header is ${header}: its copy in ${SPOOL} reads the whole header, this one would not`);
  });

  it('the comparison is red when a copy differs (a changed copy planted in memory)', () => {
    const changed = spool.replace("crypto.createHash('sha256').update(secret.kind", "crypto.createHash('sha1').update(secret.kind");
    assert.notEqual(changed, spool, 'the planted change found nothing to change: the spool no longer spells its id as this test expects');
    const { id } = keyRules(storedBytes, changed);
    assert.throws(() => assertSame('the id a derived key is cached under', ...id), /One of them changed without the other/);
    const slower = spool.replace('if (!writerKey || writerKey.id !== id) writerKey = ', 'writerKey = ');
    assert.notEqual(slower, spool);
    assert.throws(() => keyRules(storedBytes, slower), /no longer holds the code this test reads/);
  });
});
