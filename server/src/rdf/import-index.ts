/**
 * The RDF import's index of subjects: for each subject of the file, the record kind it becomes, its id (minted by the instance or addressed in
 * the file) and whether that record is stored (bundle-270, plan question (b)).
 *
 * ## Why it is shaped so
 *
 * It is the one structure the import keeps in memory for the whole file, so its size per record is what bounds an import: the plan's figure is
 * about 200 bytes per record (1 000 000 records in about 200 MB), and its test measures it on the live heap. A foreign file's addresses may be
 * long, so a subject is held by a 128-bit digest of its key ({@link quadGroupKey} of `import-spool.ts`), never by its text: the size does not grow
 * with the address, and a collision among 10^6 keys is a 2^-88 chance. The value is one string: a code for kind and stored flag, then the id.
 *
 * ## What a caller cannot forget, because it is inside
 *
 * - **The record bound** ({@link RDF_IMPORT_MAX_RECORDS}): a new record past it is refused naming the bound, as is an index read back past it;
 *   setting a held record again is no new record. The door's subject bound (`RDF_IMPORT_MAX_SUBJECTS`) is this same constant, never a second
 *   literal, so a file of subjects alone never meets this refusal. An asserted triple no reifier names is an edge the index holds too (under its
 *   triplet key), so a file within the subject bound can still reach this one: the refusal is then the index's, by name, with the door's own error
 *   class (`RdfImportBoundExceeded`, a 413), and the importer builds the index before it registers an act (review U4).
 * - **Two subjects are never one entry** (review U7): a subject is looked up by its digest, and each entry carries a second, independent check of
 *   its key; a `set` whose digest is held by another key is refused, a `get` of a key that is not the one held answers nothing.
 * - **A resumed import finds the ids it minted**: {@link ImportIndex.write} writes the index whole (to a temporary name, then renamed), through
 *   the import folder's files (encrypted under a master secret), and {@link ImportIndex.read} reads it back equal; a missing index is an
 *   error, never an empty index that would mint every id again.
 * - Only record kinds the reverse addressing reads are taken, and an id is never empty.
 */
import crypto from 'node:crypto';
import type { RecordKind } from './term-iri.js';
import { recordKindsRead } from './term-reverse.js';
import { RDF_IMPORT_MAX_SUBJECTS, RdfImportBoundExceeded, readSpoolLines, writeWholeSpoolFile, type ImportFolder } from './import-spool.js';

/**
 * The records of one import: the plan's bound (question (b)), about 200 MB of index at 200 bytes per record. The door's subject bound, one
 * constant: the index holds a record per subject at least, so the two can never be set apart.
 */
export const RDF_IMPORT_MAX_RECORDS = RDF_IMPORT_MAX_SUBJECTS;

/** What the index says of one subject. */
export interface IndexedRecord { kind: RecordKind; id: string; stored: boolean }

/** Options of an index. `lookupDigest` is a seam for a test that forces two keys onto one digest: never set outside a test. */
export interface ImportIndexOptions { maxRecords?: number; lookupDigest?: (key: string) => string }

const KINDS: readonly RecordKind[] = recordKindsRead();
const INDEX_FILE = 'index.spool';
/** An entry's code is a printable character: `CODE_BASE + kind * KIND_STEP + STORED_BIT? + PACKED_BIT?`. */
const CODE_BASE = 48;
const KIND_STEP = 4;
const STORED_BIT = 2;
const PACKED_BIT = 1;
/** The bytes of a minted id, and of a subject's digest (128 bits). */
const UUID_BYTES = 16;
const DIGEST_BYTES = 16;
/** A digest as the written index spells it. */
const DIGEST_HEX = /^[0-9a-f]{32}$/;

const digest = (key: string): string => crypto.createHash('sha256').update(key, 'utf8').digest().subarray(0, DIGEST_BYTES).toString('latin1');
/** The bytes of the second check an entry carries beside its digest, from a hash of its own (never the lookup's bytes). */
const CHECK_BYTES = 8;
const checkOf = (key: string): string => crypto.createHash('sha256').update('check\u0000', 'utf8').update(key, 'utf8').digest().subarray(0, CHECK_BYTES).toString('latin1');

/** An id the instance mints: held as its 16 bytes. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The one string an entry is held as: the key's check (second, independent hash bytes), a code (kind, stored, packed) and the id, a minted id as
 * its 16 bytes. Built through a Buffer so it is a
 * flat string of its own: the caller's id string is never kept (a `crypto.randomUUID()` string costs about 500 bytes of heap, measured), and a
 * concatenation would keep both of its halves.
 */
function encode(record: IndexedRecord, check: string): string {
  const kind = KINDS.indexOf(record?.kind);
  if (kind < 0) throw new TypeError('an indexed record is of a record kind');
  if (typeof record.id !== 'string' || record.id === '') throw new TypeError('an indexed record has an id');
  if (typeof record.stored !== 'boolean') throw new TypeError('an indexed record says whether it is stored');
  const packed = UUID.test(record.id);
  const code = CODE_BASE + kind * KIND_STEP + (record.stored ? STORED_BIT : 0) + (packed ? PACKED_BIT : 0);
  if (packed) return Buffer.concat([Buffer.from(check, 'latin1'), Buffer.from([code]), Buffer.from(record.id.replaceAll('-', ''), 'hex')]).toString('latin1');
  return Buffer.from(check + String.fromCharCode(code) + record.id, 'utf16le').toString('utf16le');
}

function decode(value: string): IndexedRecord {
  const code = value.charCodeAt(0) - CODE_BASE;
  const kind = KINDS[Math.floor(code / KIND_STEP)];
  if (kind === undefined || code < 0 || value.length <= 1) throw new Error('An import index entry is malformed.');
  const stored = (code & STORED_BIT) === STORED_BIT;
  if ((code & PACKED_BIT) === 0) return { kind, id: value.slice(1), stored };
  if (value.length !== 1 + UUID_BYTES) throw new Error('An import index entry is malformed.');
  const hex = Buffer.from(value.slice(1), 'latin1').toString('hex');
  return { kind, id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`, stored };
}

/** The subjects of one import and the record each becomes. */
export class ImportIndex {
  readonly #records = new Map<string, string>();
  readonly #max: number;
  readonly #lookup: (key: string) => string;

  constructor(options: ImportIndexOptions = {}) {
    this.#max = options.maxRecords ?? RDF_IMPORT_MAX_RECORDS;
    this.#lookup = options.lookupDigest ?? digest;
  }

  get size(): number { return this.#records.size; }

  /** The entry held for `key` when it is `key`'s own: its digest is held and its check is `key`'s. */
  #held(key: string): string | undefined {
    const value = this.#records.get(this.#lookup(key));
    return value !== undefined && value.slice(0, CHECK_BYTES) === checkOf(key) ? value : undefined;
  }

  /**
   * Say what `key`'s subject becomes; a new subject past the record bound is refused, and so is a key whose digest another key holds (two
   * subjects are never one entry).
   */
  set(key: string, record: IndexedRecord): void {
    const check = checkOf(key);
    const value = encode(record, check);
    const at = this.#lookup(key);
    const present = this.#records.get(at);
    if (present !== undefined && present.slice(0, CHECK_BYTES) !== check) {
      throw new Error('Two subjects of the file have one digest in the import index: it cannot tell them apart, and nothing was imported.');
    }
    if (present === undefined && this.#records.size >= this.#max) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_RECORDS', this.#max);
    this.#records.set(at, value);
  }

  get(key: string): IndexedRecord | undefined {
    const value = this.#held(key);
    return value === undefined ? undefined : decode(value.slice(CHECK_BYTES));
  }

  has(key: string): boolean { return this.#held(key) !== undefined; }

  /** Write the whole index into `folder`, replacing an earlier one only once this one is whole. */
  async write(folder: ImportFolder): Promise<void> {
    const records = this.#records;
    await writeWholeSpoolFile(folder, INDEX_FILE, (function* lines() {
      for (const [at, value] of records) yield JSON.stringify([Buffer.from(at, 'latin1').toString('hex'), value]);
    })());
  }

  /** The index written into `folder`; throws when there is none, and refuses one past the record bound. */
  static async read(folder: ImportFolder, options: ImportIndexOptions = {}): Promise<ImportIndex> {
    const index = new ImportIndex(options);
    for await (const line of readSpoolLines(folder, INDEX_FILE)) {
      const entry: unknown = JSON.parse(line);
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !DIGEST_HEX.test(entry[0]) || typeof entry[1] !== 'string') {
        throw new Error('An import index entry is malformed.');
      }
      if (entry[1].length <= CHECK_BYTES) throw new Error('An import index entry is malformed.');
      decode(entry[1].slice(CHECK_BYTES));
      const at = Buffer.from(entry[0], 'hex').toString('latin1');
      if (!index.#records.has(at) && index.#records.size >= index.#max) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_RECORDS', index.#max);
      index.#records.set(at, entry[1]);
    }
    return index;
  }
}
