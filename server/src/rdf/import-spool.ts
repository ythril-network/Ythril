/**
 * The RDF import's files on disk: the quads of an uploaded file sorted by graph and subject (pass 0 of the import), and its operations spooled
 * per record kind (bundle-270, plan question (b), amendments A1 and A6).
 *
 * ## Why a sort on disk
 *
 * A record's quads may be anywhere in a foreign file, and the export itself writes an asserted edge apart from its reifier, so the translator can
 * only see a record whole once the file is grouped by subject. The file may be larger than memory, so {@link sortedSpool} sorts it as an external
 * merge sort: runs of at most `runBytes` characters are sorted in memory and written, then merged (at most {@link SORT_FAN_IN} at a time) into
 * one sorted file, which {@link SortedSpool.groups} reads back one group at a time.
 *
 * ## What a caller cannot forget, because it is inside
 *
 * - **The bounds are counted in the pass that reads the file**, before it returns, so "too large" is the door's answer (413) and never an
 *   act's halfway through a held space. Over a bound the pass throws {@link RdfImportBoundExceeded} naming the bound, having removed every file
 *   it wrote; a reader that throws is cleaned up the same way and its own error comes through. The bytes the pass writes are bounded as it
 *   writes them ({@link RDF_IMPORT_MAX_SPOOL_BYTES}), since the subject bounds are only seen once every run is on disk.
 * - **One order on every machine**: graph, then subject, each compared by UTF-16 code unit (never by locale), and stable for equal keys (a run's
 *   sort is stable, a merge prefers the earlier run), so the quads of one subject keep the order they arrived in and two runs agree byte for byte.
 * - **A blank node is keyed with its graph**, so one label in two graphs is two subjects.
 * - **A record's parts come with their record**: an address the reverse addressing reads as a record part (a chrono interval's `#start` and
 *   `#end` time nodes) is grouped under its record, and counts toward its record's bounds.
 * - **Any literal survives the line format**: a line is JSON fields joined by tabs, and JSON escapes every newline, tab and lone surrogate.
 * - **Nothing is on disk in plain under a master secret**: every file is written through the chunked envelope of `config/secretbox.ts`, as the
 *   admin import's spool is, and read back by detecting the envelope. (This is not upload staging in the sense of `files/stored-bytes.ts`:
 *   nothing here enters the files tree.)
 * - **Every file lives in one folder the caller names, and one call removes them** ({@link removeImportFolder}), also after a crash, without
 *   the handle that wrote them. It removes only the files this module names (`*.spool`) and refuses a folder holding anything else, so a wrong
 *   path never loses a caller's files.
 */
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  createChunkedDecryptor, createChunkedEncryptor, deriveKey, isChunkedEnvelope, resolveMasterSecret, CHUNKED_MAX_HEADER_BYTES,
  type DerivedKey, type MasterSecret,
} from '../config/secretbox.js';
import { FILE_MODE, mkdirPrivate } from '../util/fs-modes.js';
import { isMissingPath } from '../util/path-present.js';
import { renameOverSync } from '../util/rename-over.js';
import type { BlankTerm, IriTerm, Quad, Term } from './literals.js';
import { recordOfAddress, type AddressNames } from './term-reverse.js';

// ── Bounds ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The quads of one file: the parser's inflated cap (1 GiB) at about 100 bytes per N-Quads line. */
export const RDF_IMPORT_MAX_QUADS = 10_000_000;
/** The distinct subjects of one file: the index's record bound, so the index can never be refused after the door let a file in. */
export const RDF_IMPORT_MAX_SUBJECTS = 1_000_000;
/** The quads of one subject: room for a record's links of every kind (1 000 each), its tags (100) and its properties; a group is held whole. */
export const RDF_IMPORT_MAX_SUBJECT_QUADS = 10_000;
/** The characters of one subject's quads (every string they carry): a group is held whole in memory while it is translated. */
export const RDF_IMPORT_MAX_SUBJECT_CHARS = 16_777_216;
/**
 * The bytes the first pass writes in all (every spool line and its line end): what bounds the sort's disk. A quad's line carries its subject
 * twice and its predicate, object and graph once as JSON, so it is several times the quad's text, and a prefix declaration lets six input
 * characters expand into a line of tens of thousands: a bound on the quads or on the input cannot hold the disk (review F1), and the subject
 * bounds are only seen in the final merge, after every run is written. The file the parser admits is 1 GiB inflated, whose lines are about four
 * times that; the sort holds its runs and its sorted file at once, so one import writes at most twice this bound.
 */
export const RDF_IMPORT_MAX_SPOOL_BYTES = 8 * 1024 ** 3;
/** The characters of line text one sort run holds in memory before it is written: what bounds the sort's memory. */
export const RDF_IMPORT_SORT_RUN_BYTES = 33_554_432;
/** The runs one merge reads at once: one open file and one buffered line each. */
export const SORT_FAN_IN = 32;

/** The bounds of one pass over a file; `runBytes` bounds memory and refuses nothing. */
export interface ImportSpoolBounds {
  maxQuads: number; maxSubjects: number; maxSubjectQuads: number; maxSubjectChars: number; maxSpoolBytes: number; runBytes: number;
}

export const DEFAULT_IMPORT_SPOOL_BOUNDS: Readonly<ImportSpoolBounds> = Object.freeze({
  maxQuads: RDF_IMPORT_MAX_QUADS,
  maxSubjects: RDF_IMPORT_MAX_SUBJECTS,
  maxSubjectQuads: RDF_IMPORT_MAX_SUBJECT_QUADS,
  maxSubjectChars: RDF_IMPORT_MAX_SUBJECT_CHARS,
  maxSpoolBytes: RDF_IMPORT_MAX_SPOOL_BYTES,
  runBytes: RDF_IMPORT_SORT_RUN_BYTES,
});

/** The name of a bound an import refuses at: the constant's own name. */
export type ImportBoundName =
  | 'RDF_IMPORT_MAX_QUADS' | 'RDF_IMPORT_MAX_SUBJECTS' | 'RDF_IMPORT_MAX_SUBJECT_QUADS' | 'RDF_IMPORT_MAX_SUBJECT_CHARS'
  | 'RDF_IMPORT_MAX_SPOOL_BYTES' | 'RDF_IMPORT_MAX_RECORDS';

/** A file, or the import's index, over a named bound: the door's 413. */
export class RdfImportBoundExceeded extends Error {
  readonly code = 'rdf_bound_exceeded' as const;
  constructor(readonly bound: ImportBoundName, readonly limit: number) {
    super(`The file is over the import's bound ${bound} (${limit}); nothing was imported.`);
    this.name = 'RdfImportBoundExceeded';
  }
}

// ── The folder ────────────────────────────────────────────────────────────────────────────────────────────────

/** Every file this module writes is named so: what {@link removeImportFolder} may remove. */
const MODULE_FILE = /^[a-z0-9-]+\.spool$/;

/** The folder of one import's files. */
export interface ImportFolder {
  readonly dir: string;
  /** Remove every file of the import and the folder ({@link removeImportFolder}). */
  remove(): Promise<void>;
}

function absoluteDir(dir: string): string {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new TypeError('an import folder is named by an absolute path');
  return path.resolve(dir);
}

/** Make (private) or open the folder `dir` for one import's files. */
export async function openImportFolder(dir: string): Promise<ImportFolder> {
  const at = absoluteDir(dir);
  await mkdirPrivate(at);
  return { dir: at, remove: () => removeImportFolder(at) };
}

/**
 * Remove every file of the import in `dir`, then the folder; a folder that is not there is no failure. Refuses, removing nothing, a folder
 * that holds anything this module did not name.
 */
export async function removeImportFolder(dir: string): Promise<void> {
  const at = absoluteDir(dir);
  let names: string[];
  try { names = await fsp.readdir(at); } catch (err) { if (isMissingPath(err)) return; throw err; }
  const foreign = names.filter(n => !MODULE_FILE.test(n));
  if (foreign.length > 0) throw new Error(`The import folder holds ${foreign.length} file(s) the import did not write; nothing was removed.`);
  for (const name of names) await fsp.rm(path.join(at, name), { force: true });
  try { await fsp.rmdir(at); } catch (err) { if (!isMissingPath(err)) throw err; }
}

function fileIn(folder: ImportFolder, name: string): string {
  if (!MODULE_FILE.test(name)) throw new TypeError('not a name of the import\'s files');
  return path.join(folder.dir, name);
}

// ── Lines on disk ─────────────────────────────────────────────────────────────────────────────────────────────

let writerKey: { id: string; dk: DerivedKey } | null = null;
/** The writer's key, derived once per process and secret (a passphrase costs a scrypt, and a sort writes many files). */
function keyFor(secret: MasterSecret): DerivedKey {
  const id = crypto.createHash('sha256').update(secret.kind === 'key' ? secret.key : Buffer.from(secret.passphrase)).update(secret.kind).digest('hex');
  if (!writerKey || writerKey.id !== id) writerKey = { id, dk: deriveKey(secret) };
  return writerKey.dk;
}

const WRITE_BATCH_CHARS = 65_536;

/** A file of lines being written: encrypted when a master secret is configured. */
export interface SpoolLineWriter {
  write(line: string): Promise<void>;
  /** Flush and close; the file is whole when this resolves. */
  close(): Promise<void>;
  /** Stop writing and close; the file is left for the caller to remove. */
  abort(): Promise<void>;
}

/** Open the new file `name` of `folder` for lines (never an existing one). */
export function openSpoolLineWriter(folder: ImportFolder, name: string): SpoolLineWriter {
  const sink = fs.createWriteStream(fileIn(folder, name), { flags: 'wx', mode: FILE_MODE });
  const secret = resolveMasterSecret();
  const enc = secret ? createChunkedEncryptor(keyFor(secret)) : null;
  const head: Writable = enc ?? sink;
  // `finished` settles however the writing ends: a destroyed plain stream emits only `close`, and an abort waits on it.
  const finished = enc
    ? pipeline(enc, sink)
    : new Promise<void>((resolve, reject) => { sink.once('finish', resolve); sink.once('close', resolve); sink.once('error', reject); });
  let failure: unknown = null;
  finished.catch((err: unknown) => { failure = err; });
  let batch = '';
  const flush = async (): Promise<void> => {
    if (failure) throw failure;
    if (batch === '') return;
    const text = batch;
    batch = '';
    if (!head.write(text)) await once(head, 'drain');
  };
  return {
    async write(line) {
      batch += line + '\n';
      if (batch.length >= WRITE_BATCH_CHARS) await flush();
    },
    async close() {
      await flush();
      head.end();
      await finished;
    },
    async abort() {
      batch = '';
      head.destroy();
      sink.destroy();
      await finished.catch(() => undefined);
    },
  };
}

/** The lines of file `name` of `folder`, decrypted when it is an envelope. A file that ends inside a line is refused (it was cut short). */
export async function* readSpoolLines(folder: ImportFolder, name: string): AsyncGenerator<string, void, undefined> {
  const file = fileIn(folder, name);
  const head = Buffer.alloc(CHUNKED_MAX_HEADER_BYTES);
  const fd = await fsp.open(file, 'r');
  let read: number;
  let size: number;
  try { ({ bytesRead: read } = await fd.read(head, 0, head.length, 0)); size = (await fd.stat()).size; } finally { await fd.close(); }
  const source = fs.createReadStream(file, { highWaterMark: 65_536 });
  let plain: Readable = source;
  if (isChunkedEnvelope(head.subarray(0, read), size)) {
    const dec = createChunkedDecryptor(resolveMasterSecret());
    source.on('error', err => dec.destroy(err));
    plain = source.pipe(dec);
  }
  const decoder = new StringDecoder('utf8');
  let rest = '';
  try {
    for await (const chunk of plain as AsyncIterable<Buffer>) {
      rest += decoder.write(chunk);
      let start = 0;
      for (let at = rest.indexOf('\n'); at >= 0; at = rest.indexOf('\n', start)) {
        yield rest.slice(start, at);
        start = at + 1;
      }
      rest = rest.slice(start);
    }
    rest += decoder.end();
    if (rest !== '') throw new Error('An import spool file ends inside a line: it was cut short.');
  } finally {
    source.destroy();
    plain.destroy();
  }
}

// ── Keys ──────────────────────────────────────────────────────────────────────────────────────────────────────

const subjectPart = (subject: IriTerm | BlankTerm): string => (subject.kind === 'iri' ? `i${subject.value}` : `b${subject.id}`);
const keyOfParts = (graph: string, subject: string): string => JSON.stringify([graph, subject]);

/** The key of a subject in a graph (the default graph when none): what a group carries and the import's index is keyed by. */
export function quadGroupKey(subject: IriTerm | BlankTerm, graph?: IriTerm): string {
  return keyOfParts(graph?.value ?? '', subjectPart(subject));
}

/** The address of the record `address` is a part of, or null when it is no record part. */
function ownerOf(address: string, names: AddressNames): string | null {
  if (!address.includes('#')) return null;
  const read = recordOfAddress(address, names);
  return read.answer === 'record-part' ? address.slice(0, address.length - read.part.length - 1) : null;
}

/** The characters a term counts toward its subject's bound: every string it carries. */
function termChars(term: Term | undefined): number {
  if (!term) return 0;
  switch (term.kind) {
    case 'iri': return term.value.length;
    case 'blank': return term.id.length;
    case 'literal': return term.value.length + (term.datatype?.length ?? 0) + (term.language?.length ?? 0);
    case 'triple': return termChars(term.subject) + termChars(term.predicate) + termChars(term.object);
    case 'list': return term.items.reduce((n, item) => n + termChars(item), 0);
  }
}

/** A line of the sort: graph and subject (JSON strings, so no raw tab), the quad's characters, the quad. */
interface Entry { g: string; s: string; line: string }

function entryOf(line: string): Entry {
  const a = line.indexOf('\t');
  const b = line.indexOf('\t', a + 1);
  if (a < 0 || b < 0) throw new Error('An import spool line is malformed.');
  return { g: JSON.parse(line.slice(0, a)) as string, s: JSON.parse(line.slice(a + 1, b)) as string, line };
}

/** Graph, then subject, by UTF-16 code unit. */
const compare = (x: Entry, y: Entry): number => (x.g < y.g ? -1 : x.g > y.g ? 1 : x.s < y.s ? -1 : x.s > y.s ? 1 : 0);

function charsOf(line: string): number {
  const a = line.indexOf('\t');
  const b = line.indexOf('\t', a + 1);
  return Number(line.slice(b + 1, line.indexOf('\t', b + 1)));
}

function quadOf(line: string): Quad {
  const a = line.indexOf('\t');
  const b = line.indexOf('\t', a + 1);
  return JSON.parse(line.slice(line.indexOf('\t', b + 1) + 1)) as Quad;
}

/**
 * Write `lines` as the whole file `name` of `folder`, replacing an earlier one only once this one is whole (a crash mid-write leaves the
 * earlier file as it was): the index and an import's state are each one such file.
 */
export async function writeWholeSpoolFile(folder: ImportFolder, name: string, lines: Iterable<string>): Promise<void> {
  const tmp = name.replace(/\.spool$/, '-tmp.spool');
  await fsp.rm(fileIn(folder, tmp), { force: true });
  const writer = openSpoolLineWriter(folder, tmp);
  try {
    for (const line of lines) await writer.write(line);
    await writer.close();
  } catch (err) {
    await writer.abort();
    await fsp.rm(fileIn(folder, tmp), { force: true });
    throw err;
  }
  renameOverSync(fileIn(folder, tmp), fileIn(folder, name));
}

/** Remove every operation file of `folder` (a translation that runs again starts its operations afresh). */
export async function removeOperations(folder: ImportFolder): Promise<void> {
  for (const name of await fsp.readdir(folder.dir)) if (OPS_FILE.test(name)) await fsp.rm(path.join(folder.dir, name), { force: true });
}

// ── The sort ──────────────────────────────────────────────────────────────────────────────────────────────────

/** All quads of one subject in one graph, a record's parts with it. */
export interface QuadGroup {
  /** {@link quadGroupKey} of the subject and graph. */
  key: string;
  graph?: IriTerm;
  /** The subject, or the record whose parts the group also holds. */
  subject: IriTerm | BlankTerm;
  quads: Quad[];
}

/** A file sorted on disk; its counts were held to the bounds. */
export interface SortedSpool {
  readonly quads: number;
  readonly subjects: number;
  readonly largestSubjectQuads: number;
  /** The groups in key order; may be read any number of times. */
  groups(): AsyncGenerator<QuadGroup, void, undefined>;
}

/** Options of {@link sortedSpool}. */
export interface SortedSpoolOptions {
  /** The reverse addressing's names of the space (and source): which addresses are a record's parts. */
  names: AddressNames;
  bounds?: Partial<ImportSpoolBounds>;
}

/**
 * Read `quads` once and sort them into `folder` by graph and subject, held to the bounds; over one it throws {@link RdfImportBoundExceeded}
 * and removes every file it wrote, as it does when the reader throws (with the reader's own error).
 */
export async function sortedSpool(quads: AsyncIterable<Quad>, folder: ImportFolder, options: SortedSpoolOptions): Promise<SortedSpool> {
  const bounds: ImportSpoolBounds = { ...DEFAULT_IMPORT_SPOOL_BOUNDS, ...options.bounds };
  const { names } = options;
  const nonce = crypto.randomBytes(6).toString('hex');
  const created = new Set<string>();
  const open = new Set<SpoolLineWriter>();
  let serial = 0;
  const newFile = (): { name: string; writer: SpoolLineWriter } => {
    serial += 1;
    const name = `sort-${nonce}-${String(serial).padStart(6, '0')}.spool`;
    created.add(name);
    const writer = openSpoolLineWriter(folder, name);
    open.add(writer);
    return { name, writer };
  };
  const finish = async (writer: SpoolLineWriter): Promise<void> => { await writer.close(); open.delete(writer); };
  const drop = async (name: string): Promise<void> => { await fsp.rm(fileIn(folder, name), { force: true }); created.delete(name); };

  try {
    // Pass 0a: runs of at most `runBytes` characters, each sorted (stably) and written.
    let runs: string[] = [];
    let run: Entry[] = [];
    let runChars = 0;
    let total = 0;
    let written = 0;
    const writeRun = async (): Promise<void> => {
      if (run.length === 0) return;
      run.sort(compare);
      const { name, writer } = newFile();
      for (const entry of run) await writer.write(entry.line);
      await finish(writer);
      runs.push(name);
      run = [];
      runChars = 0;
    };
    for await (const quad of quads) {
      total += 1;
      if (total > bounds.maxQuads) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_QUADS', bounds.maxQuads);
      const owner = quad.subject.kind === 'iri' ? ownerOf(quad.subject.value, names) : null;
      const g = JSON.stringify(quad.graph?.value ?? '');
      const s = JSON.stringify(owner === null ? subjectPart(quad.subject) : `i${owner}`);
      const chars = termChars(quad.subject) + termChars(quad.predicate) + termChars(quad.object) + termChars(quad.graph);
      const line = `${g}\t${s}\t${chars}\t${JSON.stringify(quad)}`;
      // Charged as the line is made, before it is held or written: a quad whose line is far larger than its text meets the bound at its line.
      written += Buffer.byteLength(line, 'utf8') + 1;
      if (written > bounds.maxSpoolBytes) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_SPOOL_BYTES', bounds.maxSpoolBytes);
      run.push(entryOf(line));
      runChars += line.length;
      if (runChars >= bounds.runBytes) await writeRun();
    }
    await writeRun();

    // Pass 0b: merge contiguous runs, the earlier first on equal keys, until one merge can take them all.
    const merge = async (inputs: string[], out: SpoolLineWriter, each?: (entry: Entry) => void): Promise<void> => {
      const readers = inputs.map(name => readSpoolLines(folder, name));
      try {
        const heads: (Entry | null)[] = [];
        for (const reader of readers) { const next = await reader.next(); heads.push(next.done ? null : entryOf(next.value)); }
        for (;;) {
          let min = -1;
          for (let i = 0; i < heads.length; i += 1) {
            const h = heads[i];
            if (h && (min < 0 || compare(h, heads[min]!) < 0)) min = i;
          }
          if (min < 0) break;
          const entry = heads[min]!;
          each?.(entry);
          await out.write(entry.line);
          const next = await readers[min]!.next();
          heads[min] = next.done ? null : entryOf(next.value);
        }
      } finally {
        for (const reader of readers) await reader.return(undefined);
      }
    };
    while (runs.length > SORT_FAN_IN) {
      const merged: string[] = [];
      for (let at = 0; at < runs.length; at += SORT_FAN_IN) {
        const inputs = runs.slice(at, at + SORT_FAN_IN);
        const { name, writer } = newFile();
        await merge(inputs, writer);
        await finish(writer);
        for (const input of inputs) await drop(input);
        merged.push(name);
      }
      runs = merged;
    }

    // The last merge counts the subjects and the largest subject: the bounds a run cannot see.
    let subjects = 0;
    let largest = 0;
    let groupQuads = 0;
    let groupChars = 0;
    let prev: Entry | null = null;
    const { name: sorted, writer } = newFile();
    await merge(runs, writer, (entry) => {
      if (!prev || compare(prev, entry) !== 0) {
        subjects += 1;
        if (subjects > bounds.maxSubjects) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_SUBJECTS', bounds.maxSubjects);
        groupQuads = 0;
        groupChars = 0;
      }
      prev = entry;
      groupQuads += 1;
      groupChars += charsOf(entry.line);
      if (groupQuads > bounds.maxSubjectQuads) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_SUBJECT_QUADS', bounds.maxSubjectQuads);
      if (groupChars > bounds.maxSubjectChars) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_SUBJECT_CHARS', bounds.maxSubjectChars);
      largest = Math.max(largest, groupQuads);
    });
    await finish(writer);
    for (const input of runs) await drop(input);
    return { quads: total, subjects, largestSubjectQuads: largest, groups: () => groupsOf(folder, sorted) };
  } catch (err) {
    for (const writer of open) await writer.abort();
    for (const name of [...created]) await drop(name);
    throw err;
  }
}

/** The name every file of a sort carries (its runs and its sorted result). */
const SORT_FILE = /^sort-[0-9a-f]{12}-\d{6}\.spool$/;

/**
 * The groups of the sorted file a finished {@link sortedSpool} left in `folder`, for an import resumed after a restart: read as the first run
 * read them, any number of times. A finished sort leaves exactly one file of its own (its runs are removed as they merge, and a failed sort
 * removes everything it wrote), so a folder holding none or several is not one a finished sort left, and it throws.
 */
export async function reopenSortedSpool(folder: ImportFolder): Promise<() => AsyncGenerator<QuadGroup, void, undefined>> {
  const sorted = (await fsp.readdir(folder.dir)).filter(n => SORT_FILE.test(n));
  if (sorted.length !== 1) throw new Error(`The import folder holds ${sorted.length} sorted files; a finished sort leaves exactly one.`);
  const name = sorted[0]!;
  return () => groupsOf(folder, name);
}

async function* groupsOf(folder: ImportFolder, sorted: string): AsyncGenerator<QuadGroup, void, undefined> {
  let current: { entry: Entry; quads: Quad[] } | null = null;
  const groupOf = (c: { entry: Entry; quads: Quad[] }): QuadGroup => {
    const g = c.entry.g;
    const s = c.entry.s;
    const subject: IriTerm | BlankTerm = s.startsWith('i') ? { kind: 'iri', value: s.slice(1) } : { kind: 'blank', id: s.slice(1) };
    return g === ''
      ? { key: keyOfParts(g, s), subject, quads: c.quads }
      : { key: keyOfParts(g, s), graph: { kind: 'iri', value: g }, subject, quads: c.quads };
  };
  for await (const line of readSpoolLines(folder, sorted)) {
    const entry = entryOf(line);
    if (current && compare(current.entry, entry) === 0) { current.quads.push(quadOf(line)); continue; }
    if (current) yield groupOf(current);
    current = { entry, quads: [quadOf(line)] };
  }
  if (current) yield groupOf(current);
}

// ── Operations, per kind ──────────────────────────────────────────────────────────────────────────────────────

/** A kind's name: a plain lowercase word, so it can name a file. */
const KIND_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const OPS_FILE = /^ops-([a-z][a-z0-9-]*)-(\d{6})-(\d{6})\.spool$/;

/** Operations spooled one file per kind, read back kind by kind in the caller's order (the store's order of kinds). */
export interface OperationSpool {
  /** Append `op` (any JSON value) to `kind`'s operations. */
  append(kind: string, op: unknown): Promise<void>;
  /** Flush and close what is open; a later append starts a new file of its kind. */
  close(): Promise<void>;
  /**
   * Every operation, kind by kind in `order`, each kind in arrival order; what was appended and not closed is flushed first. Refuses an order
   * that names a kind twice or leaves out a kind the spool holds, so no operation is dropped.
   */
  read(order: readonly string[]): AsyncGenerator<{ kind: string; op: unknown }, void, undefined>;
}

function assertKindName(kind: unknown): asserts kind is string {
  if (typeof kind !== 'string' || !KIND_NAME.test(kind)) throw new TypeError('an operation kind is a plain lowercase word of at most 64 characters');
}

/** Open the operations of `folder`; a second session (a resumed import) appends after what is there. */
export async function openOperationSpool(folder: ImportFolder): Promise<OperationSpool> {
  const opsFiles = async (): Promise<{ name: string; kind: string }[]> =>
    (await fsp.readdir(folder.dir)).flatMap((name) => { const m = OPS_FILE.exec(name); return m ? [{ name, kind: m[1]! }] : []; }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sessions = (await opsFiles()).map(f => Number(OPS_FILE.exec(f.name)![2]));
  const session = String(sessions.reduce((n, s) => Math.max(n, s), 0) + 1).padStart(6, '0');
  let segment = 1;
  const writers = new Map<string, SpoolLineWriter>();

  const close = async (): Promise<void> => {
    const open = [...writers.values()];
    writers.clear();
    if (open.length > 0) segment += 1;
    for (const writer of open) await writer.close();
  };

  return {
    async append(kind, op) {
      assertKindName(kind);
      const line = JSON.stringify(op);
      if (typeof line !== 'string') throw new TypeError('an operation is a JSON value');
      let writer = writers.get(kind);
      if (!writer) {
        writer = openSpoolLineWriter(folder, `ops-${kind}-${session}-${String(segment).padStart(6, '0')}.spool`);
        writers.set(kind, writer);
      }
      await writer.write(line);
    },
    close,
    async *read(order) {
      for (const kind of order) assertKindName(kind);
      if (new Set(order).size !== order.length) throw new TypeError('the order of kinds names a kind twice');
      await close();
      const files = await opsFiles();
      const missing = [...new Set(files.map(f => f.kind))].filter(k => !order.includes(k));
      if (missing.length > 0) throw new Error(`The order of kinds leaves out ${missing.join(', ')}, which the spool holds.`);
      for (const kind of order) {
        for (const file of files) {
          if (file.kind !== kind) continue;
          for await (const line of readSpoolLines(folder, file.name)) yield { kind, op: JSON.parse(line) as unknown };
        }
      }
    },
  };
}
