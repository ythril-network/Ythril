/**
 * The room one import is given keeps the process alive when every holder of two imports that can exist at once stands at its bound, in a container of
 * one size (bundle-384, Q-983, fix round, finding 1: the drive imported BSBM at 10 000 products at 4 GiB and the process held 1.47 GiB resident
 * while the meter charged at most 512 MiB; "a file a little larger, or a smaller container, can then exhaust the heap before the meter refuses").
 *
 * ## What it holds
 *
 * A child process gets the heap limit V8 gives a container of that size (524, 1 048 and 2 096 MiB, measured in the design probe,
 * `log/q983/design/probe-results.md`) and fills, to the room the instance computes for that container (`importMemoryRoom`, the container's size
 * injected), the holders of the worst moment: the door's inference of a schema from the data (its subject maps), the act's first phase (the index with
 * its subjects and bare edges, the two digest sets, a window of groups at its share), and then, the first phase gone, the act's second phase (the
 * minted ends and their copy). Each holder ends by the room's refusal just past its bound, and the process lives through all of it with the heap
 * not above 85 per cent of its limit: past that a collection that cannot free enough kills the process, and the container's memory beyond the heap
 * (the stack, buffers, the embedding child, the database driver) is what the room's other three quarters are for.
 *
 * ## Why one file per size
 *
 * The three sizes in one file ran 89 s on main CI (46112179133), over the 60 s a file may take, and one process cannot spread them; a file per
 * size (`the-import-memory-room-keeps-the-process-alive-at-<n>-gib.test.js`) lets the runner spread them. {@link ALIVE_SIZES} is the one list:
 * the 1 GiB file asserts every size has its file, so a size added here without a file, or a file removed, fails.
 *
 * The family is held beside `the-import-memory-room-follows-the-instance` (how the room is read) and `the-import-memory-charges-every-holder-of-the-import`
 * (what each entry is charged); this one holds that the figures together keep the process alive.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const GiB = 2 ** 30;
const MiB = 2 ** 20;
/** The heap limit V8 picks for a container of each size (design probe, node 22): the figure `v8.getHeapStatistics()` reports there. */
const HEAP_LIMIT_MIB = { 1: 524, 2: 1048, 4: 2096 };
/** The container sizes, GiB, each with its own test file. */
export const ALIVE_SIZES = Object.keys(HEAP_LIMIT_MIB).map(Number);
/** `--max-old-space-size` sets the old generation: the reported limit adds the young generation's three semi-spaces of 16 MiB. */
const YOUNG_MIB = 48;
const MOST_OF_THE_HEAP = 0.85;
/** The longest the child may fill for, ms: the file's own timeout is above it. */
export const ALIVE_CHILD_MS = 270_000;

/** The test file of container size `gib`. */
export const aliveFileOf = (gib) => `the-import-memory-room-keeps-the-process-alive-at-${gib}-gib.test.js`;

/** Fill every holder to the room of a `gib` GiB container in a child process with that container's heap, and assert it lives and each holder is refused. */
export async function assertAliveAtBound(gib) {
  const heap = HEAP_LIMIT_MIB[gib];
  if (heap === undefined) throw new Error(`no heap limit is measured for a ${gib} GiB container: measure it and add it to HEAP_LIMIT_MIB`);
  let line;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [`--max-old-space-size=${heap - YOUNG_MIB}`, '--expose-gc', path.join(here, '_import-memory-fill.mjs'), String(gib * GiB)],
      { maxBuffer: 1 << 20, timeout: ALIVE_CHILD_MS });
    line = stdout.trim().split('\n').pop();
  } catch (err) {
    assert.fail(`the process died before every holder reached its bound (exit ${err.code ?? err.signal}): ${String(err.stderr ?? err.message).split('\n').filter(l => /heap|memory|Error/i.test(l)).slice(0, 3).join(' | ')}`);
  }
  const out = JSON.parse(line);
  console.log(`${gib} GiB: ${line}`);
  assert.equal(out.heapLimitMiB, heap, 'the child did not get the heap limit of this container');
  assert.equal(out.door.refused, true, 'the door\'s inference was not refused by the room');
  assert.equal(out.actFirst.refused, true, 'the act\'s first phase was not refused by the room');
  assert.equal(out.actSecond.refused, true, 'the act\'s second phase was not refused by the room');
  assert.ok(out.door.kept > 1000 && out.actFirst.kept > 1000 && out.actSecond.kept > 1000, 'a holder was refused before it held anything: the probe proves nothing');
  assert.ok(out.actFirst.window > 0, 'no window was held beside the index');
  assert.ok(out.peakHeapMiB <= MOST_OF_THE_HEAP * heap, `the heap peaked at ${out.peakHeapMiB} MiB of ${heap}: the room leaves no headroom for a collection (${line})`);
  assert.ok(out.roomMiB * MiB > 0 && out.roomMiB <= heap / 4 + 0.1, 'the room is more than a quarter of the heap');
}
