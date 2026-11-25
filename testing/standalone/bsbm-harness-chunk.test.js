/**
 * The subject-complete chunker (Q-759): a variant over the import's body bound is split so that no subject's
 * statements are divided, every chunk is under its bound, and no chunk holds an edge whose end comes in a later
 * chunk. Cases drive the planner over subjects (id, bytes, the subjects it points at) and the file writer over a
 * small N-Triples text.
 *
 * Run: node --test testing/standalone/bsbm-harness-chunk.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkFile, planChunks } from '../../benchmarks/rdf/chunk.mjs';

const s = (id, bytes, refs = []) => ({ id, bytes, refs });
const flat = (plan) => plan.chunks.flat();
const chunkOf = (plan) => new Map(plan.chunks.flatMap((c, i) => c.map((id) => [id, i])));

test('every subject lands in exactly one chunk, whole, and a chunk never exceeds the bound', () => {
  const subjects = Array.from({ length: 30 }, (_, i) => s(`s${i}`, 10 + (i % 7)));
  const plan = planChunks(subjects, 60);
  assert.deepEqual([...flat(plan)].sort(), subjects.map((x) => x.id).sort());
  const bytes = new Map(subjects.map((x) => [x.id, x.bytes]));
  for (const c of plan.chunks) assert.ok(c.reduce((n, id) => n + bytes.get(id), 0) <= 60, `chunk over bound: ${c}`);
  assert.ok(plan.chunks.length > 1);
});

test('an edge is never in an earlier chunk than its end, wherever the file lists the two', () => {
  // The file lists the edges first (offers, then reviews, then the products and producers they point at).
  const subjects = [
    s('offer1', 20, ['prod1', 'vendor1']), s('offer2', 20, ['prod2', 'vendor1']), s('review1', 20, ['prod1', 'person1']),
    s('prod1', 20, ['producer1']), s('prod2', 20, ['producer1']), s('producer1', 20), s('vendor1', 20), s('person1', 20),
  ];
  const plan = planChunks(subjects, 45);
  const at = chunkOf(plan);
  for (const x of subjects) for (const r of x.refs) assert.ok(at.get(r) <= at.get(x.id), `${x.id} is in chunk ${at.get(x.id)} before its end ${r} in chunk ${at.get(r)}`);
  assert.ok(plan.chunks.length >= 3);
});

test('the plan is the same on every run, and a file that fits the bound is one chunk', () => {
  const subjects = [s('b', 5, ['a']), s('a', 5), s('c', 5, ['b'])];
  assert.deepEqual(planChunks(subjects, 1000).chunks, planChunks(subjects, 1000).chunks);
  assert.equal(planChunks(subjects, 1000).chunks.length, 1);
});

test('subjects that point at each other stay together, in one chunk', () => {
  const subjects = [s('x', 10, ['y']), s('y', 10, ['x']), s('z', 10, ['x']), s('w', 25)];
  const plan = planChunks(subjects, 30);
  const at = chunkOf(plan);
  assert.equal(at.get('x'), at.get('y'));
  assert.ok(at.get('x') <= at.get('z'));
});

test('a subject, or a cycle of them, bigger than the bound is refused, naming it', () => {
  assert.throws(() => planChunks([s('big', 100), s('small', 1)], 50), /big/);
  assert.throws(() => planChunks([s('p', 30, ['q']), s('q', 30, ['p'])], 50), /p/);
});

test('a reference to something that is no subject of the file is no ordering constraint', () => {
  const plan = planChunks([s('a', 10, ['http://elsewhere/x']), s('b', 10)], 15);
  assert.deepEqual([...flat(plan)].sort(), ['a', 'b']);
});

const T = (id) => `<http://ex.test/${id}>`;
const P = '<http://ex.test/p>';
const lines = [
  `${T('offer1')} ${P} ${T('prod1')} .`, `${T('offer1')} ${P} "o1" .`,
  `${T('prod1')} ${P} ${T('producer1')} .`, `${T('prod1')} ${P} "p1" .`,
  `${T('offer2')} ${P} ${T('prod1')} .`, `${T('producer1')} ${P} "pr1" .`, `${T('offer1')} ${P} "again" .`,
];

test('the file writer divides a file by subject: no statement lost or doubled, no subject in two files, none over the bound', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b271-chunk-'));
  try {
    writeFileSync(join(dir, 'in.nt'), `${lines.join('\n')}\n`);
    const bound = 200;
    const out = chunkFile(join(dir, 'in.nt'), join(dir, 'chunks'), bound);
    const names = readdirSync(join(dir, 'chunks')).sort();
    assert.equal(names.length, out.files.length);
    assert.ok(out.files.length > 1, 'the bound is small enough to need more than one file');
    const seenIn = new Map();
    const all = [];
    names.forEach((n, i) => {
      const text = readFileSync(join(dir, 'chunks', n), 'latin1');
      assert.ok(Buffer.byteLength(text, 'latin1') <= bound, `${n} is over the bound`);
      for (const l of text.split('\n').filter(Boolean)) {
        all.push(l);
        const subject = l.slice(0, l.indexOf('>') + 1);
        assert.ok(!seenIn.has(subject) || seenIn.get(subject) === i, `${subject} is in two files`);
        seenIn.set(subject, i);
      }
    });
    assert.deepEqual(all.sort(), [...lines].sort());
    assert.ok(seenIn.get(T('producer1')) <= seenIn.get(T('prod1')));
    assert.ok(seenIn.get(T('prod1')) <= seenIn.get(T('offer1')));
    assert.ok(seenIn.get(T('prod1')) <= seenIn.get(T('offer2')));
    assert.deepEqual(out.files.map((f) => f.endsWith('.nt')), out.files.map(() => true));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
