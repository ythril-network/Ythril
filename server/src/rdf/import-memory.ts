/**
 * How much memory may one RDF import's index and record sets hold on this instance, and does an import's need fit? (bundle-384, Q-983; owner's
 * decision: the fixed count of records per import becomes a bound by memory, as the type cap became a bound by size.)
 *
 * ## Why memory and not a count
 *
 * An import keeps one entry per subject in its index, one per bare edge, and one per statement in its two digest sets, for the whole file: that is what
 * bounds an import. A fixed count (it was 1 000 000) refused a benchmark whose records fit (BSBM at 10 000 products makes 1.7 to 2.0 million) and, on a
 * small instance, was not derived from memory at all. The figure is now what the process can give.
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
  /** What one import's index and record sets may hold, in bytes. */
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

/** How much memory one import's index and record sets may hold here, read now. Never throws. */
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
