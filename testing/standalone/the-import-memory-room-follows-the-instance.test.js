/**
 * How much memory one RDF import's index and record sets may hold is read from the instance, never fixed (bundle-384, Q-983).
 *
 * ## The rule
 *
 * A fixed count of records per import refused a benchmark that fits and, on a small instance, let one import exhaust the heap: the real limit is
 * the memory the import's index holds. `importMemoryRoom` answers how much that is here: a quarter of `min(V8's heap limit, half the container's
 * memory limit)` (two holders can exist at once, the door and the act, so imports take at most half of it). It is read like the CPU quota is
 * (`util/cpu-budget.ts`): a cgroup v2 number, v2 `max` (none), a v1 number or its "no limit" sentinel, a missing file (not Linux, not a container)
 * and text that is no number are each a row below, and none of them throws. The heap limit and the cgroup text are inputs, so each row is pure.
 *
 * `ImportMemoryMeter` is what an import spends it with: `charge()` refuses the charge that would pass the room, naming `RDF_IMPORT_MAX_MEMORY`,
 * the room (`limit`) and what the import then needs (`need`), and takes nothing of the refused charge.
 *
 * Also held: the room is computed per call, never kept at module load (a source gate over every module that asks), and a real read on this
 * machine is above zero and at most a quarter of the heap limit.
 *
 * Run: node --test testing/standalone/the-import-memory-room-follows-the-instance.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import fs from 'node:fs';
import { importOrFail } from '../_shared/import-or-fail.mjs';
import { stripComments } from './_strip-comments.mjs';
import { REPO_ROOT, SERVER_CODE_ROOTS, trackedSources } from './_sources.mjs';

const memory = () => importOrFail('server/dist/rdf/import-memory.js', 'the import\'s memory room (Q-983)');

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const HEAP = 2096 * MiB;
const V2 = '/sys/fs/cgroup/memory.max';
const V1 = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
const V1_NO_LIMIT = '9223372036854771712';
const QUARTER = 4;
const HALF = 2;

/** A filesystem that holds only `files`; any other path is missing, as on a machine with no such cgroup file. */
const filesystem = (files) => (path) => {
  if (Object.hasOwn(files, path)) return files[path];
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
};

describe('the room one import has follows the instance', () => {
  const rows = [
    ['cgroup v2 number below the heap limit', { [V2]: `${GiB}\n` }, HEAP, Math.floor(Math.min(HEAP, GiB / HALF) / QUARTER), GiB],
    ['cgroup v2 number above the heap limit', { [V2]: `${8 * GiB}\n` }, HEAP, Math.floor(HEAP / QUARTER), 8 * GiB],
    ['cgroup v2 "max" (no limit)', { [V2]: 'max\n' }, HEAP, Math.floor(HEAP / QUARTER), null],
    ['cgroup v1 number below the heap limit', { [V1]: `${2 * GiB}\n` }, HEAP, Math.floor(Math.min(HEAP, GiB) / QUARTER), 2 * GiB],
    ['cgroup v1 "no limit" sentinel', { [V1]: `${V1_NO_LIMIT}\n` }, HEAP, Math.floor(HEAP / QUARTER), null],
    ['both cgroup files missing (not a container, not Linux)', {}, HEAP, Math.floor(HEAP / QUARTER), null],
    ['cgroup text that is no number', { [V2]: 'unlimited-ish\n' }, HEAP, Math.floor(HEAP / QUARTER), null],
    ['a small heap limit under a large container', { [V2]: `${64 * GiB}\n` }, 300 * MiB, Math.floor((300 * MiB) / QUARTER), 64 * GiB],
  ];
  for (const [what, files, heapLimitBytes, expected, container] of rows) {
    it(`${what}: ${expected} bytes`, async () => {
      const { importMemoryRoom } = await memory();
      const answer = importMemoryRoom({ heapLimitBytes, readFile: filesystem(files) });
      assert.equal(answer.bytes, expected);
      assert.equal(answer.heapLimitBytes, heapLimitBytes, 'the figure says which heap limit it was computed from');
      assert.equal(answer.containerLimitBytes, container, 'the figure says which container limit it was computed from');
    });
  }

  it('never throws: a reader that throws something that is no error is the heap limit alone', async () => {
    const { importMemoryRoom } = await memory();
    const answer = importMemoryRoom({ heapLimitBytes: HEAP, readFile: () => { throw 'not an Error'; } });
    assert.equal(answer.bytes, Math.floor(HEAP / QUARTER));
  });

  it('is computed per call: the same process answers differently for different inputs, so nothing is kept at load', async () => {
    const { importMemoryRoom } = await memory();
    const small = importMemoryRoom({ heapLimitBytes: HEAP, readFile: filesystem({ [V2]: `${GiB}` }) }).bytes;
    const large = importMemoryRoom({ heapLimitBytes: HEAP, readFile: filesystem({ [V2]: `${8 * GiB}` }) }).bytes;
    assert.ok(small < large, `two calls answered ${small} and ${large}`);
  });

  it('a real read on this machine is above zero and at most a quarter of the heap limit', async () => {
    const { importMemoryRoom } = await memory();
    const answer = importMemoryRoom();
    const heap = v8.getHeapStatistics().heap_size_limit;
    assert.ok(answer.bytes > 0, `the room is ${answer.bytes}`);
    assert.ok(answer.bytes <= heap / QUARTER, `the room ${answer.bytes} is over a quarter of the heap limit ${heap}`);
  });

  it('no module asks for the room at load: every call sits inside a function (a room kept at load is frozen at the first container)', () => {
    const asking = [];
    for (const file of trackedSources(SERVER_CODE_ROOTS, { untracked: true })) {
      const text = stripComments(fs.readFileSync(`${REPO_ROOT}/${file}`, 'utf8').replaceAll('\r\n', '\n'));
      if (!text.includes('importMemoryRoom(')) continue;
      asking.push(file);
      // A statement that starts in column 0 and calls it, other than the declaration itself: a call made when the module loads.
      const atLoad = text.split('\n').filter(l => /^\S/.test(l) && l.includes('importMemoryRoom(') && !/^export function importMemoryRoom\(/.test(l));
      assert.deepEqual(atLoad, [], `${file} asks for the room when the module loads`);
    }
    assert.ok(asking.includes('server/src/rdf/import-index.ts'), 'the index asks for the room when no meter or budget is handed to it (a probe that finds no asker proves nothing)');
    assert.ok(asking.includes('server/src/rdf/import-spool.ts'), 'the spool asks for the room when no budget is handed to it');
  });
});

describe('the meter refuses the charge that passes the room', () => {
  it('takes charges up to the room exactly, then refuses naming the bound, the room and the need, and takes nothing of the refusal', async () => {
    const { ImportMemoryMeter } = await memory();
    const meter = new ImportMemoryMeter(1000);
    meter.charge(600);
    meter.charge(400);
    assert.equal(meter.used, 1000);
    assert.throws(() => meter.charge(1), (err) => {
      assert.equal(err?.name, 'RdfImportBoundExceeded');
      assert.equal(err.code, 'rdf_bound_exceeded');
      assert.equal(err.bound, 'RDF_IMPORT_MAX_MEMORY');
      assert.equal(err.limit, 1000);
      assert.equal(err.need, 1001);
      return true;
    });
    assert.equal(meter.used, 1000, 'a refused charge was taken');
  });

  it('the refusal says what the file needs and what one import is given, in the words a caller can act on, and names no instance figure', async () => {
    const { ImportMemoryMeter } = await memory();
    const meter = new ImportMemoryMeter(8 * MiB);
    const err = (() => { try { meter.charge(20 * MiB); } catch (e) { return e; } return null; })();
    assert.ok(err, 'the charge was taken');
    assert.match(err.message, /needs at least 20(\.\d+)? MiB for the import's index and record sets/);
    assert.match(err.message, /gives one import 8(\.\d+)? MiB \(a quarter of the smaller of its heap limit and half its container's limit\)/);
    assert.match(err.message, /nothing was imported/i);
    assert.doesNotMatch(err.message, /heap limit (of|is|\()\s*\d/i, 'the instance\'s own heap figure was named');
    assert.doesNotMatch(err.message, /RDF_IMPORT_MAX_(SUBJECTS|RECORDS)/, 'a retired bound name was sent');
  });
});
