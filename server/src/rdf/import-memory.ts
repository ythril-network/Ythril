/**
 * How much memory may one RDF import hold for its file on this instance, and does an import's need fit? (bundle-384, Q-983; owner's decision: the
 * fixed count of records per import becomes a bound by memory, as the type cap became a bound by size.)
 *
 * ## Why memory and not a count
 *
 * An import keeps, for the whole file, one entry per subject in its index, one per bare edge, and one per statement in its two digest sets; after the
 * translation one minted end per record and a copy of them for the plan; and, when a schema is inferred from the data, one entry per subject of the
 * inference. That is what bounds an import. A fixed count (it was 1 000 000) refused a benchmark whose records fit (BSBM at 10 000 products makes 1.7 to
 * 2.0 million) and, on a small instance, was not derived from memory at all. The figure is now what the process can give.
 *
 * ## What is charged to the room, and what sits outside it
 *
 * Every holder that grows with the file is charged to a meter of this room, or capped by a share of it, so none can spend it twice or outgrow it:
 *
 * - **Phase one of the act** (translation): the index with its bare edges and the two digest sets, one meter ({@link ImportMemoryMeter}); the door's
 *   count (`import-count.ts`) charges the same figures from the spool alone.
 * - **Phase two of the act** (plan and commit): the minted ends and their copy (`import-ends.ts`), a meter of their own room, since the index and the sets
 *   are gone by then ({@link MINTED_END_BYTES}, {@link ENDS_COPY_BYTES}). The door's count answers the larger of the two phases.
 * - **The door's inference from the data**: {@link INFER_SUBJECT_BYTES} a subject and {@link INFER_PAIR_BYTES} a repeated pair, from the spool's count
 *   of subjects, before a statement is read ({@link assertInferenceFits}, {@link inferencePairsRoom}). A door and an act can run at once, each within a room.
 * - **The group window** (`import-window.ts`): capped at `1/WINDOW_DIVISOR` of the room, not charged: a window ends at its share, and a group is held whole.
 *
 * Outside the meter, and bounded by something that does not grow with the file: one group, held whole (at most `RDF_IMPORT_MAX_SUBJECT_QUADS` quads and
 * `RDF_IMPORT_MAX_SUBJECT_CHARS` characters, about 40 MiB of heap at the most), the sort's runs (`RDF_IMPORT_SORT_RUN_BYTES` characters), the write
 * windows' operations, and what the rest of the instance holds (the SPARQL engine, the database driver, the embedding child). Every figure above is a
 * heap measurement taken after a full collection at the worse end of a Map's doubling (`the-import-memory-charges-what-an-entry-costs.test.js`,
 * `the-import-memory-charges-every-holder-of-the-import.test.js`, `the-import-group-window-ends-at-its-share-of-room.test.js`).
 *
 * ## The share, and its measurement
 *
 * A quarter of the smaller of the heap limit and half the container's limit stays the room, and the door and the act together may then hold half of
 * that: measured by `the-import-memory-room-keeps-the-process-alive-at-its-bound.test.js` and a probe in containers of 1, 2 and 4 GiB, with the door's
 * inference, the act's first phase (its window at its share) and then its second phase each filled to the room, each refused just past it, the process
 * alive. The heap peaked at 249 of 524 MiB (1 GiB container), 645 of 1 048 (2 GiB) and 1 273 of 2 096 (4 GiB), 0.48 to 0.62 of the limit, leaving the
 * rest for the instance's own heap, a collection and the memory outside the heap; a share above a quarter was not measured. An eighth would refuse
 * BSBM at 10 000 products at 4 GiB: its need by these charges is at most 357 MiB (the larger phase, the first: 326 255 subjects and at most 1 354 637
 * edge statements, counted from the file) against a room of 512 MiB, and the second phase and the inference need 80 and 120 MiB.
 *
 * ## The room
 *
 * `room = min(V8's heap limit, half the container's memory limit) / 4`. The heap limit is what the process can allocate before it dies; set above the
 * container it overstates what exists (measured: `--max-old-space-size=3000` in a 1 GiB container is killed by the container at about 4.1 million
 * records, so the container's half stays in the formula, leaving the rest for everything else the process holds). A quarter of that is one import's: two
 * holders can exist at once, the door that reads a file in and the act that translates it, so imports take at most half of it, and what is left is the
 * SPARQL engine's and the rest of the instance's.
 *
 * Past a 4 GiB container the heap limit is V8's own cap (2 096 MiB measured), so raising the container's memory stops raising the room: only
 * `--max-old-space-size` does (through `NODE_OPTIONS`), and the room then follows it.
 *
 * ## What it reads, and what it never does
 *
 * The container's limit is read like the CPU quota is (`util/cpu-budget.ts`): cgroup v2 `memory.max`, a number or `max`, then cgroup v1
 * `memory/memory.limit_in_bytes`, whose "no limit" is a number near 2^63. A missing file (not Linux, not a container), a reader that throws and text that
 * is no number are the heap limit alone. **It never throws**: an import must not fail on a file the operator never heard of. The heap limit and the
 * files are inputs, so every case is a pure call. **It is computed per import, never at module load**: a figure kept when the module loads is the figure
 * of the first container, and `DEFAULT_IMPORT_SPOOL_BOUNDS` was frozen so once.
 *
 * ## What an entry is charged
 *
 * Each entry is charged what it takes on the heap, with the headroom the tests state (`the-import-memory-charges-what-an-entry-costs.test.js` measures the
 * heap just after a Map doubles, when its table is half empty and an entry is dearest, and just before the next doubling, for each kind of id). An index
 * entry with a minted id (held as its 16 bytes) costs {@link MINTED_ENTRY_BYTES}; with a text id, {@link TEXT_ENTRY_BYTES} and a byte a character, or two
 * when one character of the id is above U+00FF (V8 holds the entry as a one-byte or a two-byte string); a statement of a digest set,
 * {@link SET_ENTRY_BYTES}. {@link ImportMemoryMeter} takes the charges and refuses the one that passes the room.
 */
import fs from 'node:fs';
import v8 from 'node:v8';
import { RdfImportBoundExceeded } from './import-bound.js';

/** One import holds a quarter of the memory budget: two holders can exist at once and the rest is the instance's. */
const ROOM_DIVISOR = 4;
/** The container's limit is halved before the heap limit is compared with it: the heap is not all the process holds. */
const CONTAINER_DIVISOR = 2;

/**
 * The heap bytes of an index entry whose id is minted (a UUID held as its 16 bytes), the digest key, the entry's check and the Map slot included.
 * Measured 153 just after the Map's table doubled (half empty, the dearest an entry is) and 110 just before the next doubling, so charged 160.
 */
export const MINTED_ENTRY_BYTES = 160;
/**
 * The heap bytes of an index entry whose id is text, before its characters: measured 121 just after a doubling and 92 just before, so charged 136.
 * Each character costs {@link ONE_BYTE_CHARACTER_BYTES} or {@link TWO_BYTE_CHARACTER_BYTES} on top.
 */
export const TEXT_ENTRY_BYTES = 136;
/** The heap bytes of each character of a text id that V8 holds as a one-byte string: every character at or below U+00FF (measured: 1.0 a character for 992). */
export const ONE_BYTE_CHARACTER_BYTES = 1;
/** The heap bytes of each character of a text id with one character above U+00FF: V8 then holds the whole entry as a two-byte string. */
export const TWO_BYTE_CHARACTER_BYTES = 2;
/**
 * The heap bytes of one statement of a digest set (the passes' asserted and reified sets): a 128-bit digest as a string and the Set's slot. Measured
 * 73.4 just after a doubling and 53.1 just before the next, so charged 78.
 */
export const SET_ENTRY_BYTES = 78;

/**
 * The heap bytes of one of the act's minted ends (`import-ends.ts`): a record's id and its kind and type, held after the translation for the dry plan
 * and the commit, the Map slot included. Measured 184 for an entity just after the Map's table doubled (its dearest), 156 just before the next
 * doubling and 145 for a fact, ids and types as the operation spool hands them back; charged a little above the dearest of these.
 */
export const MINTED_END_BYTES = 192;
/** The heap bytes of one entry of the copy the dry plan takes of the minted ends (the table only: the ids and kinds are shared). Measured at most 56 an entry, charged a little above. */
export const ENDS_COPY_BYTES = 64;
/**
 * The heap bytes the inference of a schema from the data keeps per subject while it reads the file: a typed subject's digest in the seen set and its
 * classes in the map (measured 313 just after the Maps doubled, 264 just before the next doubling), or a label-only subject's address and labels
 * (measured 374 with the address held once); charged the dearer of the two, rounded up.
 */
export const INFER_SUBJECT_BYTES = 392;
/** The heap bytes of one (subject, predicate) pair the second pass of the inference remembers: a string and its slot. Measured 136.9, charged a little above. */
export const INFER_PAIR_BYTES = 144;

/**
 * The inference of a schema from the data holds {@link INFER_SUBJECT_BYTES} for each of the file's subjects at most (a subject typed by no class of the
 * file holds nothing), which the sorted spool counts: throws {@link RdfImportBoundExceeded} naming the memory bound with the whole need, before the
 * inference reads a statement, when they cannot fit the room. The inference is the door's, and a door and an act can run at once, each within its own room.
 */
export function assertInferenceFits(subjects: number, room: number): void {
  const need = subjects * INFER_SUBJECT_BYTES;
  if (need > room) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_MEMORY', room, need, true);
}

/**
 * How many repeated (subject, predicate) pairs the inference's second pass may remember beside its `subjects` subjects within `room`: what is left of
 * the room, at most `asked` (the caller's own bound is never raised), never below zero.
 */
export function inferencePairsRoom(subjects: number, room: number, asked: number): number {
  return Math.max(0, Math.min(asked, Math.floor((room - subjects * INFER_SUBJECT_BYTES) / INFER_PAIR_BYTES)));
}

/** An id the instance mints: a UUID, which the index holds as its 16 bytes. */
export const MINTED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A text every character of which V8 can hold in one byte. */
const ONE_BYTE_TEXT = /^[\u0000-ÿ]*$/;

/** The heap bytes the index takes for an entry whose id is `id`: dearest for a text id with a character above U+00FF, whose characters cost two bytes. */
export function indexEntryBytes(id: string): number {
  if (MINTED_ID.test(id)) return MINTED_ENTRY_BYTES;
  return TEXT_ENTRY_BYTES + (ONE_BYTE_TEXT.test(id) ? ONE_BYTE_CHARACTER_BYTES : TWO_BYTE_CHARACTER_BYTES) * id.length;
}

const CGROUP_V2_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_V1_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

/** What {@link importMemoryRoom} reads: tests inject both. */
export interface ImportMemorySources {
  /** V8's heap limit in bytes; default `v8.getHeapStatistics().heap_size_limit`. */
  heapLimitBytes?: number;
  /** Reads a file as UTF-8; default `fs.readFileSync`. */
  readFile?: (path: string) => string;
}

/** The room and the figures it came from. */
export interface ImportMemoryRoom {
  /** What one import may hold for its file (each phase of it, and the inference), in bytes. */
  bytes: number;
  heapLimitBytes: number;
  /** The container's memory limit, or null when there is none this process can see. */
  containerLimitBytes: number | null;
}

/** A positive whole number of bytes, or null for anything else (`max`, garbage, zero, a "no limit" past what a number holds exactly). */
function limitOf(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The container's memory limit in bytes, or null. Tries cgroup v2 first, then v1; a file that is missing or unreadable is no limit. */
function containerLimit(readFile: (path: string) => string): number | null {
  for (const file of [CGROUP_V2_MAX, CGROUP_V1_LIMIT]) {
    try {
      const limit = limitOf(readFile(file));
      if (limit !== null) return limit;
    } catch { /* not a container, or not this cgroup version: the next file, then no limit */ }
  }
  return null;
}

/** How much memory one import may hold for its file here, read now. Never throws. */
export function importMemoryRoom({
  heapLimitBytes = v8.getHeapStatistics().heap_size_limit,
  readFile = (path) => fs.readFileSync(path, 'utf8'),
}: ImportMemorySources = {}): ImportMemoryRoom {
  const container = containerLimit(readFile);
  const budget = container === null ? heapLimitBytes : Math.min(heapLimitBytes, container / CONTAINER_DIVISOR);
  return { bytes: Math.floor(budget / ROOM_DIVISOR), heapLimitBytes, containerLimitBytes: container };
}

/**
 * What one import has spent of its room. {@link charge} takes bytes, or refuses the charge that would pass the room with
 * {@link RdfImportBoundExceeded} (`RDF_IMPORT_MAX_MEMORY`, the room as `limit`, what the import would then need as `need`) and takes nothing of it.
 * One meter serves the index, the sets and the pass-two bare edges of one import, so no holder can spend the room twice.
 */
export class ImportMemoryMeter {
  #used = 0;
  constructor(readonly room: number) {}

  get used(): number { return this.#used; }

  charge(bytes: number): void {
    const need = this.#used + bytes;
    if (need > this.room) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_MEMORY', this.room, need);
    this.#used = need;
  }
}
