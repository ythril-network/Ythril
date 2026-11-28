/**
 * The groups an import holds at once end at a share of the import's room, not at 500 groups whatever they weigh (bundle-384, Q-983, fix round,
 * finding 1: vet amendment G2, "the group window ends a window when its summed characters pass a share of room").
 *
 * ## The defect it prevents
 *
 * Both passes of the act read the sorted file in windows of 500 groups and hold a whole window while they translate it. A group is held whole and is
 * bounded by quads and characters, not by bytes (up to 10 000 quads and 16 777 216 characters), so 500 groups were up to 8 GiB of text held with no
 * meter and no cap: a file of a few large subjects could take the instance down before any bound looked at it. The window now ends when the next group
 * would take it past its share of the room (`WINDOW_DIVISOR`, from `import-window.ts`); a group is never split, so one that alone passes the share is
 * a window of its own (its size is bounded by the sort's per-subject bounds, a fixed figure the room's share leaves space for).
 *
 * ## What it holds
 *
 * - the cost a group is charged is at least what its quads take on the heap, with the headroom the other charges state (measured on groups the
 *   spool hands back, one-byte and two-byte text), and at least 0.4 of it (a cost far above what a group takes shortens windows for nothing);
 * - a window ends at the share, takes the group that would pass it into the next one, never ends empty, holds at most `size` groups, and loses and
 *   reorders none;
 * - both passes of the act read their windows through it with the room's share (source gate).
 *
 * Run: node --test testing/standalone/the-import-group-window-ends-at-its-share-of-room.test.js (after the server build)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { importOrFail } from '../_shared/import-or-fail.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const liveHeap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };

const windowModule = () => importOrFail('server/dist/rdf/import-window.js', 'the import\'s group window and its share of the room (Q-983 fix round)');
const spoolModule = () => importOrFail('server/dist/rdf/import-spool.js', 'the door\'s sorted spool');
const reverseModule = () => importOrFail('server/dist/rdf/term-reverse.js', 'the reverse addressing');

const iri = (value) => ({ kind: 'iri', value });
const literal = (value) => ({ kind: 'literal', value });
const made = [];
after(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** A group of `quads` statements about one subject, each with a literal of `chars` characters. */
const groupOf = (i, quads, chars, wide = false) => {
  // Fixed-width numbers, so groups of one shape cost the same.
  const n = String(i).padStart(3, '0');
  const subject = iri(`http://www4.wiwiss.fu-berlin.de/bizer/bsbm/v01/instances/dataFromProducer${String(i % 97).padStart(2, '0')}/Product${n}`);
  return {
    key: subject.value, subject,
    quads: Array.from({ length: quads }, (_, q) => ({ subject, predicate: iri(`http://www4.wiwiss.fu-berlin.de/bizer/bsbm/vocab/v01/property${q}`), object: literal((wide ? '日' : 'x').repeat(chars) + n) })),
  };
};
async function* streamOf(groups) { for (const g of groups) yield g; }
const windows = async (module, groups, size, budget) => { const out = []; for await (const w of module.windowsOf(streamOf(groups), size, budget)) out.push(w); return out; };

describe('what a group is charged', { timeout: 120_000 }, () => {
  for (const [label, quads, chars, wide] of [['12 quads of 20 characters', 12, 20, false], ['100 quads of 200 characters', 100, 200, false], ['3 quads of 4 000 characters', 3, 4000, false], ['12 quads of 200 characters above U+00FF', 12, 200, true]]) {
    it(`${label}: the heap a window of such groups takes is within its cost and at least 0.4 of it`, async () => {
      const { groupBytes } = await windowModule();
      const { sortedSpool, openImportFolder } = await spoolModule();
      const { addressNames } = await reverseModule();
      const BASE = 'https://rdf.example.org/ld/notes/';
      const names = addressNames({ rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/` }, typeSchemas: {} });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b384-window-'));
      made.push(dir);
      // The groups come back from the spool as the act reads them: parsed from lines, each string its own.
      const spool = await sortedSpool(streamOf(Array.from({ length: 300 }, (_, i) => groupOf(i, quads, chars, wide)).flatMap(g => g.quads)), await openImportFolder(path.join(dir, 'f')), { names, bounds: { memoryBytes: Number.MAX_SAFE_INTEGER } });
      const before = liveHeap();
      const held = [];
      for await (const g of spool.groups()) held.push(g);
      const heap = liveHeap() - before;
      const cost = held.reduce((n, g) => n + groupBytes(g), 0);
      console.log(`window of ${held.length} groups, ${label}: ${heap} B on the heap, cost ${cost}`);
      assert.equal(held.length, 300);
      assert.ok(heap <= cost, `${held.length} groups take ${heap} bytes and are charged ${cost}: a window could outgrow its share`);
      assert.ok(heap >= 0.4 * cost, `${held.length} groups take ${heap} bytes and are charged ${cost}: too dear, windows end for nothing`);
    });
  }
});

describe('a window ends at its share of the room', () => {
  it('the share is a fixed fraction of the room, and a smaller room gives a smaller share', async () => {
    const m = await windowModule();
    assert.equal(m.windowBudgetOf(1 << 30), Math.floor((1 << 30) / m.WINDOW_DIVISOR));
    assert.ok(m.windowBudgetOf(1 << 26) < m.windowBudgetOf(1 << 30));
  });

  it('ends a window when the next group would pass the budget, before the size bound is reached, losing and reordering no group', async () => {
    const m = await windowModule();
    const groups = Array.from({ length: 40 }, (_, i) => groupOf(i, 10, 100));
    const one = m.groupBytes(groups[0]);
    assert.ok(groups.every(g => m.groupBytes(g) === one), 'the fixture\'s groups differ in cost');
    const out = await windows(m, groups, 500, 4 * one + one / 2);
    assert.deepEqual(out.map(w => w.length), Array(10).fill(4), 'a window did not end at the budget (4 groups fit, a fifth would pass it)');
    assert.deepEqual(out.flat().map(g => g.key), groups.map(g => g.key));
  });

  it('keeps the size bound too: at most `size` groups, whatever they cost', async () => {
    const m = await windowModule();
    const groups = Array.from({ length: 25 }, (_, i) => groupOf(i, 1, 1));
    const out = await windows(m, groups, 10, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(out.map(w => w.length), [10, 10, 5]);
  });

  it('never ends a window empty: a group that alone passes the budget is a window of its own, and its neighbours are not lost', async () => {
    const m = await windowModule();
    const small = (i) => groupOf(i, 2, 10);
    const huge = groupOf(99, 200, 5000);
    const budget = 3 * m.groupBytes(small(0));
    assert.ok(m.groupBytes(huge) > budget, 'the fixture\'s large group does not pass the budget');
    const out = await windows(m, [small(0), small(1), huge, small(2), small(3)], 500, budget);
    assert.deepEqual(out.map(w => w.map(g => g.key.split('/').pop())), [['Product000', 'Product001'], ['Product099'], ['Product002', 'Product003']]);
  });

  it('an empty file has no window', async () => {
    const m = await windowModule();
    assert.deepEqual(await windows(m, [], 500, 1000), []);
  });

  it('both passes of the act read their windows through it, with the share of the import\'s own room (source gate)', () => {
    const act = stripComments(fs.readFileSync(`${REPO_ROOT}/server/src/spaces/rdf-import-act.ts`, 'utf8'));
    const uses = act.match(/windowsOf\(run\.groups\(\)[^\n]*/g) ?? [];
    assert.equal(uses.length, 2, `the act reads its windows ${uses.length} times, not once per pass (index, translate)`);
    for (const use of uses) assert.match(use, /windowBudgetOf\(/, `a pass reads its window with no share of the room: ${use}`);
    assert.doesNotMatch(act, /async function\* windowsOf/, 'the act still defines its own window by count');
  });
});
