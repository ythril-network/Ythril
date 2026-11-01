/**
 * Read an export body from a file on disk without holding it: validate the whole of it in one pass, then hand out one family's documents
 * a page at a time, each repeated id once (bundle-40 R1, Q-267).
 *
 * ## What it prevents
 *
 * The import route sat behind the global JSON parser, which buffers a body and refuses one over 10 MB, so the backup of a large space
 * could be exported and never restored; and the importer held every family array at once. A reader that streams pages has two traps of
 * its own, and this module is where both are closed:
 *
 * - **A body that breaks after its first page.** A page that lands before the reader has seen the rest has written part of a body
 *   the door must refuse whole (400, nothing written). So {@link indexExportBody} reads the WHOLE body first and throws
 *   {@link ExportBodyMalformed} for any fault, and only then does anything land.
 * - **A repeated id across pages.** The writer keeps a repeated id's highest seq, and of equal seqs the earliest, but only within one
 *   call; across pages the later page would win. The index decides it for the whole body instead, WITHOUT holding the ids: per document it
 *   keeps an 8-byte hash of the id, its seq and its position (typed arrays), and only the hashes seen more than once get a second scan
 *   that reads their full ids, so a collision of two distinct ids is compared by text and never taken for a repeat.
 *
 * Keys are held in a `Map` and every lookup of a body key is `Map.get`/`Map.has`, never a plain object's: an id or a key named
 * `__proto__` is text like any other.
 *
 * ## Bounds
 *
 * One document is at most {@link MAX_DOCUMENT_BYTES} bytes and {@link MAX_DEPTH} levels deep; a key at most {@link MAX_KEY_BYTES}. The
 * document count is the caller's ceiling (`maxDocuments`, {@link ExportBodyTooLarge}). Every family key may appear once and must be an
 * array; a key the reader does not know is read (so a fault in it still refuses the body) and named, never landed.
 *
 * A spool written through the chunked secretbox envelope (`config/secretbox.ts`, a master secret configured) is read through its decryptor;
 * a plaintext one by byte range.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { isNewerCopy } from './held-tombstone-rules.js';
import { createChunkedDecryptor, isChunkedEnvelope, resolveMasterSecret } from '../config/secretbox.js';
import { REPLICATED_FAMILIES } from './replicated-families.js';

/** The longest one document of an export may be, in bytes. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** The deepest one value may nest. */
export const MAX_DEPTH = 64;
/** The longest key the body may carry, in bytes. */
export const MAX_KEY_BYTES = 4096;
/** How many unknown keys an index names (it counts them all). */
export const UNKNOWN_KEYS_NAMED = 10;

/** The body is not an export the import can read: answered 400, nothing written. The message is ours and names where. */
export class ExportBodyMalformed extends Error {
  override readonly name = 'ExportBodyMalformed';
}

/** The body holds more documents than the caller's ceiling: answered 413, nothing written. */
export class ExportBodyTooLarge extends Error {
  override readonly name = 'ExportBodyTooLarge';
}

/** One family of the body: where its array sits and which of its documents land. */
export interface FamilyIndex {
  /** Byte offset of the array's `[` in the plaintext body. */
  readonly start: number;
  /** Byte offset of the array's `]`. */
  end: number;
  /** Documents in the array, repeats included. */
  count: number;
  /** Per position, 1 when the document lands; null when every document does (no id was seen twice). */
  keep: Uint8Array | null;
}

/** What one read of the whole body learned. */
export interface ExportBodyIndex {
  /** Every key whose value is not an array, as parsed (`instanceId`, `spaceId`, `exportedAt`, ...). */
  readonly envelope: ReadonlyMap<string, unknown>;
  readonly families: ReadonlyMap<string, FamilyIndex>;
  /** Keys that are neither a family nor a scalar, the first {@link UNKNOWN_KEYS_NAMED}; `unknownKeysTotal` counts them all. */
  readonly unknownKeys: readonly string[];
  readonly unknownKeysTotal: number;
  /** Documents in every family, repeats included. */
  readonly documents: number;
}

export interface IndexOptions {
  /** The id's 8-byte hash. The default is the module's own; a test passes one that collides on purpose. */
  hashOf?: (id: string) => Buffer;
  /** The array keys that are families (default: every replicated family's collection). */
  families?: readonly string[];
  /** Refuse ({@link ExportBodyTooLarge}) a body of more documents than this. */
  maxDocuments?: number;
  /**
   * Does this document take part in the repeated-id rule? Default: an object with a non-empty string `_id` and a seq that is absent or a
   * non-negative integer. One the writer refuses must not win over a copy it would land (the writer refuses before it collapses).
   */
  competes?: (family: string, doc: Record<string, unknown>) => boolean;
}

const defaultHash = (id: string): Buffer => crypto.createHash('sha1').update(id, 'utf8').digest().subarray(0, 8);
const defaultCompetes = (_family: string, doc: Record<string, unknown>): boolean => {
  const seq = doc['seq'];
  return typeof doc['_id'] === 'string' && doc['_id'].length > 0
    && (seq === undefined || (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0));
};

// ── the scanner ─────────────────────────────────────────────────────────────────────────────────────────────────

const enum S { Start, KeyOrEnd, KeyNext, Colon, Value, ElemOrEnd, ElemNext, AfterElem, AfterValue, Done, Capture }
const enum Cap { Key, Value, Elem }
const enum Kind { Container, Str, Literal }

const isWs = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
const LITERAL_START = /[-0-9tfn]/;

interface ScanEvents {
  value(key: string, bytes: Buffer): void;
  arrayStart(key: string, offset: number): void;
  element(key: string, index: number, bytes: Buffer): void;
  arrayEnd(key: string, offset: number): void;
}

/**
 * The byte-level reader of one JSON object of the export's shape (`root: 'object'`), or of one array of it (`root: 'array'`, a family's
 * byte range). Every structural byte is ASCII, so a UTF-8 multibyte byte (>= 0x80) never matches one. Values are handed out as their bytes;
 * the caller parses them. Throws {@link ExportBodyMalformed}.
 */
class BodyScanner {
  private state: S = S.Start;
  private key = '';
  private arrayKey = '';
  private index = 0;
  private offset = 0;
  private cap: Cap = Cap.Value;
  private kind: Kind = Kind.Literal;
  private depth = 0;
  private inStr = false;
  private esc = false;
  private parts: Buffer[] = [];
  private bytes = 0;
  private capStart = -1;

  constructor(private readonly root: 'object' | 'array', private readonly on: ScanEvents, arrayKey = '') {
    this.arrayKey = arrayKey;
  }

  get done(): boolean { return this.state === S.Done; }
  /** Bytes fed so far. */
  get scanned(): number { return this.offset; }

  private fail(why: string): never {
    throw new ExportBodyMalformed(`the body is not a valid export: ${why} (at byte ${this.offset})`);
  }

  private begin(cap: Cap, c: number, i: number): void {
    this.cap = cap;
    this.parts = [];
    this.bytes = 0;
    this.capStart = i;
    this.inStr = false;
    this.esc = false;
    if (c === 0x7b || c === 0x5b) { this.kind = Kind.Container; this.depth = 1; } else if (c === 0x22) { this.kind = Kind.Str; this.inStr = true; } else if (LITERAL_START.test(String.fromCharCode(c))) { this.kind = Kind.Literal; } else this.fail(`unexpected '${String.fromCharCode(c)}'`);
    if (cap === Cap.Key && this.kind !== Kind.Str) this.fail('a key is not a string');
    this.state = S.Capture;
  }

  /** The capture ended at `end` (exclusive) of `chunk`: hand it out and move on. */
  private finish(chunk: Buffer, end: number): void {
    const piece = chunk.subarray(this.capStart, end);
    const bytes = this.parts.length === 0 ? piece : Buffer.concat([...this.parts, piece]);
    this.parts = [];
    this.capStart = -1;
    this.bound(bytes.length);
    if (this.cap === Cap.Key) {
      try { this.key = JSON.parse(bytes.toString('utf8')) as string; } catch { this.fail('a key is not a valid string'); }
      this.state = S.Colon;
    } else if (this.cap === Cap.Value) {
      this.on.value(this.key, bytes);
      this.state = S.AfterValue;
    } else {
      this.on.element(this.arrayKey, this.index++, bytes);
      this.state = S.AfterElem;
    }
  }

  private bound(n: number): void {
    const max = this.cap === Cap.Key ? MAX_KEY_BYTES : MAX_DOCUMENT_BYTES;
    if (n > max) this.fail(this.cap === Cap.Key ? `a key is over ${MAX_KEY_BYTES} bytes` : `a document is over ${MAX_DOCUMENT_BYTES} bytes`);
  }

  private endArray(i: number): void {
    this.on.arrayEnd(this.arrayKey, this.offset + i);
    this.state = this.root === 'array' ? S.Done : S.AfterValue;
  }

  feed(chunk: Buffer): void {
    const n = chunk.length;
    if (this.state === S.Capture) this.capStart = 0;
    let i = 0;
    while (i < n) {
      const c = chunk[i]!;
      switch (this.state) {
        case S.Start:
          if (isWs(c)) break;
          if (this.root === 'object' && c === 0x7b) this.state = S.KeyOrEnd;
          else if (this.root === 'array' && c === 0x5b) { this.on.arrayStart(this.arrayKey, this.offset + i); this.index = 0; this.state = S.ElemOrEnd; }
          else this.fail(this.root === 'object' ? 'the body is not one JSON object' : 'a family is not an array');
          break;
        case S.KeyOrEnd:
          if (isWs(c)) break;
          if (c === 0x7d) { this.state = S.Done; break; }
          this.begin(Cap.Key, c, i);
          break;
        case S.KeyNext:
          if (isWs(c)) break;
          this.begin(Cap.Key, c, i);
          break;
        case S.Colon:
          if (isWs(c)) break;
          if (c !== 0x3a) this.fail('a key is not followed by \':\'');
          this.state = S.Value;
          break;
        case S.Value:
          if (isWs(c)) break;
          if (c === 0x5b) {
            this.arrayKey = this.key;
            this.index = 0;
            this.on.arrayStart(this.key, this.offset + i);
            this.state = S.ElemOrEnd;
            break;
          }
          this.begin(Cap.Value, c, i);
          break;
        case S.ElemOrEnd:
          if (isWs(c)) break;
          if (c === 0x5d) { this.endArray(i); break; }
          this.begin(Cap.Elem, c, i);
          break;
        case S.ElemNext:
          if (isWs(c)) break;
          if (c === 0x5d) this.fail('an array ends with a comma');
          this.begin(Cap.Elem, c, i);
          break;
        case S.AfterElem:
          if (isWs(c)) break;
          if (c === 0x2c) this.state = S.ElemNext;
          else if (c === 0x5d) this.endArray(i);
          else this.fail('an array element is not followed by \',\' or \']\'');
          break;
        case S.AfterValue:
          if (isWs(c)) break;
          if (c === 0x2c) this.state = S.KeyNext;
          else if (c === 0x7d) this.state = S.Done;
          else this.fail('a value is not followed by \',\' or \'}\'');
          break;
        case S.Done:
          if (!isWs(c)) this.fail('there is more after the closing brace');
          break;
        case S.Capture:
          if (this.kind === Kind.Literal) {
            if (isWs(c) || c === 0x2c || c === 0x5d || c === 0x7d) { this.finish(chunk, i); continue; }
            break;
          }
          if (this.inStr) {
            if (this.esc) this.esc = false;
            else if (c === 0x5c) this.esc = true;
            else if (c === 0x22) {
              this.inStr = false;
              if (this.kind === Kind.Str) { this.finish(chunk, i + 1); i++; continue; }
            }
            break;
          }
          if (c === 0x22) { this.inStr = true; break; }
          if (c === 0x7b || c === 0x5b) { if (++this.depth > MAX_DEPTH) this.fail(`a value nests deeper than ${MAX_DEPTH} levels`); break; }
          if (c === 0x7d || c === 0x5d) { if (--this.depth === 0) { this.finish(chunk, i + 1); i++; continue; } }
          break;
      }
      i++;
    }
    if (this.state === S.Capture && this.capStart >= 0) {
      const rest = Buffer.from(chunk.subarray(this.capStart));
      this.parts.push(rest);
      this.bytes += rest.length;
      this.bound(this.bytes);
    }
    this.offset += n;
  }

  end(): void {
    if (this.state !== S.Done) this.fail('the body ends before it is closed');
  }
}

// ── reading the spool ───────────────────────────────────────────────────────────────────────────────────────────

/** The plaintext of `file` from byte `start`: a byte range of a plaintext spool, or the decrypted envelope with its first `start` bytes skipped. */
async function plainFrom(file: string, start: number): Promise<Readable> {
  const head = Buffer.alloc(128);
  const fd = await fs.promises.open(file, 'r');
  let read: number;
  let size: number;
  try { ({ bytesRead: read } = await fd.read(head, 0, head.length, 0)); size = (await fd.stat()).size; } finally { await fd.close(); }
  if (!isChunkedEnvelope(head.subarray(0, read), size)) return fs.createReadStream(file, { start, highWaterMark: 256 * 1024 });
  const plain = fs.createReadStream(file, { highWaterMark: 256 * 1024 }).pipe(createChunkedDecryptor(resolveMasterSecret()));
  if (start === 0) return plain;
  let skip = start;
  return Readable.from((async function* () {
    for await (const chunk of plain as AsyncIterable<Buffer>) {
      if (skip >= chunk.length) { skip -= chunk.length; continue; }
      yield skip > 0 ? chunk.subarray(skip) : chunk;
      skip = 0;
    }
  })());
}

function parseOrFail(bytes: Buffer, where: string): unknown {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new ExportBodyMalformed(`the body is not a valid export: ${where} is not valid JSON`); }
}

/** A typed array that grows by doubling. */
class Grow<T extends Float64Array | Uint32Array | Uint8Array> {
  constructor(private arr: T, private readonly make: (n: number) => T) {}
  set(i: number, v: number): void {
    if (i >= this.arr.length) { const next = this.make(Math.max(16, this.arr.length * 2)); next.set(this.arr); this.arr = next; }
    this.arr[i] = v;
  }
  get view(): T { return this.arr; }
}

interface FamilyTable { hi: Grow<Uint32Array>; lo: Grow<Uint32Array>; seq: Grow<Float64Array>; competes: Grow<Uint8Array> }

const seqOf = (v: number): number | undefined => (Number.isNaN(v) ? undefined : v);

/**
 * Read the whole body at `file` once: validate it (throws {@link ExportBodyMalformed}), count it against `maxDocuments` (throws
 * {@link ExportBodyTooLarge}), and decide, per family, which documents land — every id once, at its highest seq, and of equal seqs the
 * earliest. Ids whose hash was seen more than once are read again by their full text, so a hash collision never drops a document.
 */
export async function indexExportBody(file: string, opts: IndexOptions = {}): Promise<ExportBodyIndex> {
  const hashOf = opts.hashOf ?? defaultHash;
  const familyKeys = new Set(opts.families ?? REPLICATED_FAMILIES.map(f => f.collection));
  const competes = opts.competes ?? defaultCompetes;
  const max = opts.maxDocuments ?? Number.MAX_SAFE_INTEGER;
  const envelope = new Map<string, unknown>();
  const families = new Map<string, FamilyIndex>();
  const tables = new Map<string, FamilyTable>();
  const unknown: string[] = [];
  let unknownTotal = 0;
  let documents = 0;
  const nameUnknown = (k: string): void => { unknownTotal++; if (unknown.length < UNKNOWN_KEYS_NAMED) unknown.push(k.slice(0, 200)); };

  const scanner = new BodyScanner('object', {
    value(key, bytes) {
      const v = parseOrFail(bytes, `the value of '${key.slice(0, 200)}'`);
      if (familyKeys.has(key)) throw new ExportBodyMalformed(`'${key}' must be an array`);
      envelope.set(key, v);
    },
    arrayStart(key, offset) {
      if (!familyKeys.has(key)) { nameUnknown(key); return; }
      if (families.has(key)) throw new ExportBodyMalformed(`'${key}' appears more than once`);
      families.set(key, { start: offset, end: offset, count: 0, keep: null });
      tables.set(key, { hi: new Grow(new Uint32Array(64), n => new Uint32Array(n)), lo: new Grow(new Uint32Array(64), n => new Uint32Array(n)),
        seq: new Grow(new Float64Array(64), n => new Float64Array(n)), competes: new Grow(new Uint8Array(64), n => new Uint8Array(n)) });
    },
    element(key, index, bytes) {
      const doc = parseOrFail(bytes, `document ${index} of '${key.slice(0, 200)}'`);
      const fam = families.get(key);
      const t = tables.get(key);
      if (!fam || !t) return;
      if (++documents > max) throw new ExportBodyTooLarge(`the body holds more than ${max} documents`);
      fam.count = index + 1;
      const isDoc = doc !== null && typeof doc === 'object' && !Array.isArray(doc);
      if (isDoc && competes(key, doc as Record<string, unknown>)) {
        const h = hashOf((doc as { _id: string })._id);
        t.hi.set(index, h.readUInt32BE(0));
        t.lo.set(index, h.readUInt32BE(4));
        const s = (doc as { seq?: unknown }).seq;
        t.seq.set(index, typeof s === 'number' ? s : Number.NaN);
        t.competes.set(index, 1);
      } else {
        t.competes.set(index, 0);
      }
    },
    arrayEnd(key, offset) {
      const fam = families.get(key);
      if (fam) fam.end = offset;
    },
  });
  const stream = await plainFrom(file, 0);
  for await (const chunk of stream as AsyncIterable<Buffer>) scanner.feed(chunk);
  scanner.end();

  for (const [key, fam] of families) await decideRepeats(file, key, fam, tables.get(key)!);
  return { envelope, families, unknownKeys: unknown, unknownKeysTotal: unknownTotal, documents };
}

/** Mark, in `fam.keep`, the copies of a repeated id that do not land. Reads the family again only when a hash was seen twice. */
async function decideRepeats(file: string, key: string, fam: FamilyIndex, t: FamilyTable): Promise<void> {
  const n = fam.count;
  const hi = t.hi.view; const lo = t.lo.view; const comp = t.competes.view; const seq = t.seq.view;
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (comp[i] === 1) order.push(i);
  const sorted = Int32Array.from(order).sort((a, b) => (hi[a]! - hi[b]!) || (lo[a]! - lo[b]!) || (a - b));
  const twice = new Uint8Array(n);
  let any = false;
  for (let k = 1; k < sorted.length; k++) {
    const a = sorted[k - 1]!; const b = sorted[k]!;
    if (hi[a] === hi[b] && lo[a] === lo[b]) { twice[a] = 1; twice[b] = 1; any = true; }
  }
  if (!any) return;
  const keep = new Uint8Array(n).fill(1);
  const best = new Map<string, number>();
  for await (const [index, bytes] of elementsOf(file, key, fam)) {
    if (twice[index] !== 1) continue;
    const id = (JSON.parse(bytes.toString('utf8')) as { _id: string })._id;
    const held = best.get(id);
    if (held === undefined) { best.set(id, index); continue; }
    if (isNewerCopy(seqOf(seq[index]!), seqOf(seq[held]!))) { keep[held] = 0; best.set(id, index); } else keep[index] = 0;
  }
  fam.keep = keep;
}

/** Every element of one family's array, as its position and bytes, read from its byte range. */
async function* elementsOf(file: string, key: string, fam: FamilyIndex): AsyncGenerator<[number, Buffer]> {
  const pending: [number, Buffer][] = [];
  const scanner = new BodyScanner('array', {
    value() { /* an array holds no keyed value */ },
    arrayStart() { /* the range starts at it */ },
    element(_k, index, bytes) { pending.push([index, bytes]); },
    arrayEnd() { /* the range ends at it */ },
  }, key);
  const stream = await plainFrom(file, fam.start);
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const room = fam.end + 1 - fam.start - scanner.scanned;
      scanner.feed(room < chunk.length ? chunk.subarray(0, Math.max(0, room)) : chunk);
      while (pending.length > 0) yield pending.shift()!;
      if (scanner.done) break;
    }
  } finally {
    stream.destroy();
  }
  scanner.end();
}

/**
 * The documents of `family` that land, parsed, in body order, `pageSize` (default 500) at a time: only the winning copy of a repeated id
 * ({@link indexExportBody}). Nothing for a family the body does not hold.
 */
export async function* readFamilyPages(
  file: string, index: ExportBodyIndex, family: string, { pageSize = 500 }: { pageSize?: number } = {},
): AsyncGenerator<unknown[]> {
  const fam = index.families.get(family);
  if (!fam || fam.count === 0) return;
  let page: unknown[] = [];
  for await (const [i, bytes] of elementsOf(file, family, fam)) {
    if (fam.keep !== null && fam.keep[i] !== 1) continue;
    page.push(JSON.parse(bytes.toString('utf8')));
    if (page.length >= pageSize) { yield page; page = []; }
  }
  if (page.length > 0) yield page;
}
