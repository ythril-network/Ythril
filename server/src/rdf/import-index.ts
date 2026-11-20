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
 *   setting a held record again is no new record. The door's subject bound (`RDF_IMPORT_MAX_SUBJECTS`) is the same number, so a file the door
 *   let in never meets this refusal.
 * - **A resumed import finds the ids it minted**: {@link ImportIndex.write} writes the index whole (to a temporary name, then renamed), through
 *   the import folder's files (encrypted under a master secret), and {@link ImportIndex.read} reads it back equal; a missing index is an
 *   error, never an empty index that would mint every id again.
 * - Only record kinds the reverse addressing reads are taken, and an id is never empty.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { renameOverSync } from '../util/rename-over.js';
import type { RecordKind } from './term-iri.js';
import { recordKindsRead } from './term-reverse.js';
import { RdfImportBoundExceeded, openSpoolLineWriter, readSpoolLines, type ImportFolder } from './import-spool.js';

/** The records of one import: the plan's bound (question (b)), about 200 MB of index at 200 bytes per record. */
export const RDF_IMPORT_MAX_RECORDS = 1_000_000;

/** What the index says of one subject. */
export interface IndexedRecord { kind: RecordKind; id: string; stored: boolean }

/** Options of an index. */
export interface ImportIndexOptions { maxRecords?: number }

const KINDS: readonly RecordKind[] = recordKindsRead();
const INDEX_FILE = 'index.spool';
const INDEX_TMP = 'index-writing.spool';
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

/** An id the instance mints: held as its 16 bytes. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The one string an entry is held as: a code (kind, stored, packed) and the id, a minted id as its 16 bytes. Built through a Buffer so it is a
 * flat string of its own: the caller's id string is never kept (a `crypto.randomUUID()` string costs about 500 bytes of heap, measured), and a
 * concatenation would keep both of its halves.
 */
function encode(record: IndexedRecord): string {
  const kind = KINDS.indexOf(record?.kind);
  if (kind < 0) throw new TypeError('an indexed record is of a record kind');
  if (typeof record.id !== 'string' || record.id === '') throw new TypeError('an indexed record has an id');
  if (typeof record.stored !== 'boolean') throw new TypeError('an indexed record says whether it is stored');
  const packed = UUID.test(record.id);
  const code = CODE_BASE + kind * KIND_STEP + (record.stored ? STORED_BIT : 0) + (packed ? PACKED_BIT : 0);
  if (packed) return Buffer.concat([Buffer.from([code]), Buffer.from(record.id.replaceAll('-', ''), 'hex')]).toString('latin1');
  return Buffer.from(String.fromCharCode(code) + record.id, 'utf16le').toString('utf16le');
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

  constructor(options: ImportIndexOptions = {}) {
    this.#max = options.maxRecords ?? RDF_IMPORT_MAX_RECORDS;
  }

  get size(): number { return this.#records.size; }

  /** Say what `key`'s subject becomes; a new subject past the record bound is refused. */
  set(key: string, record: IndexedRecord): void {
    const value = encode(record);
    const at = digest(key);
    if (!this.#records.has(at) && this.#records.size >= this.#max) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_RECORDS', this.#max);
    this.#records.set(at, value);
  }

  get(key: string): IndexedRecord | undefined {
    const value = this.#records.get(digest(key));
    return value === undefined ? undefined : decode(value);
  }

  has(key: string): boolean { return this.#records.has(digest(key)); }

  /** Write the whole index into `folder`, replacing an earlier one only once this one is whole. */
  async write(folder: ImportFolder): Promise<void> {
    await fsp.rm(path.join(folder.dir, INDEX_TMP), { force: true });
    const writer = openSpoolLineWriter(folder, INDEX_TMP);
    try {
      for (const [at, value] of this.#records) await writer.write(JSON.stringify([Buffer.from(at, 'latin1').toString('hex'), value]));
      await writer.close();
    } catch (err) {
      await writer.abort();
      await fsp.rm(path.join(folder.dir, INDEX_TMP), { force: true });
      throw err;
    }
    renameOverSync(path.join(folder.dir, INDEX_TMP), path.join(folder.dir, INDEX_FILE));
  }

  /** The index written into `folder`; throws when there is none, and refuses one past the record bound. */
  static async read(folder: ImportFolder, options: ImportIndexOptions = {}): Promise<ImportIndex> {
    const index = new ImportIndex(options);
    for await (const line of readSpoolLines(folder, INDEX_FILE)) {
      const entry: unknown = JSON.parse(line);
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !DIGEST_HEX.test(entry[0]) || typeof entry[1] !== 'string') {
        throw new Error('An import index entry is malformed.');
      }
      decode(entry[1]);
      const at = Buffer.from(entry[0], 'hex').toString('latin1');
      if (!index.#records.has(at) && index.#records.size >= index.#max) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_RECORDS', index.#max);
      index.#records.set(at, entry[1]);
    }
    return index;
  }
}
