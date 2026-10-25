/**
 * A fork resolved on one instance is a decision owed on every other instance whose authority declined the removal, and each instance decides
 * its own copy (Q-624 design §9a, M4, test 24; the owner's E1 decision of 2026-10-25).
 *
 * ## The experiment, as the design states it (M4's "disproved by")
 *
 * THREE instances A, B and C, every pair peered in one mesh (a club network: only the `issuer` ground exists, no upstream). The fork F is
 * a copy that C authored, stored on all three. For every forking kind, facts included (they fork as built in bundle-81):
 *
 *  1. F is stored on A, B and C.
 *  2. Resolve F on A with `keep: 'parent'`. A no longer holds F and holds a tombstone it issued. After a cycle B and C each STILL hold F
 *     (A's tombstone is declined `not_author`: A is not F's author) and each lists F in Review as `resolvedElsewhere: [{ by: A }]`,
 *     the side kept being `'original'` once A's new parent version has landed there.
 *  3. Resolve F on B with `keep: 'parent'`. B's copy goes, and only B's. After a cycle C still lists F, marked as resolved on A and on B.
 *  5. Resolve F on C. F is gone on all three and the space's merkle root is equal on all three.
 *
 * It is repeated under three cycle schedules and the outcome must be the same: every pair; A reaching C before B; and C reached only
 * through B. (Step 4, the restart and export/restore of the mark, is held by `a-declined-fork-tombstone-marks-the-fork-db` for the
 * module sets: an instance here is a process on a database the harness drops on start, so it cannot be restarted.)
 *
 * ## A design gap this test makes visible
 *
 * "C reached only through B" asks C to learn of A's resolve through B. B DECLINED A's tombstone, and §9a writes a mark and stores nothing,
 * so B has no tombstone to serve on to C. Either B must relay what it declined, or the third schedule's outcome cannot equal the others'.
 * The test holds the design's sentence as written; if the design chooses the other answer, this schedule's assertion changes with it.
 *
 * ## How three instances exist
 *
 * Three child processes (`_q624-mesh-instance.mjs`), each the real push handlers over its own harness database; a cycle carries a served page
 * from one to the next through the receiver's own routes with the sender's peer identity. See that file for what is and is not real.
 *
 * Run: node --test testing/standalone/a-fork-resolved-elsewhere-is-decided-here-mesh-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const S = 'q624mesh';
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The parent only DERIVES ids (never loads a config), but the server modules read CONFIG_PATH when imported.
process.env.CONFIG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'q624-mesh-parent-')), 'config.json');
const fixtures = await import('./_q624-fork-fixtures.mjs');

const NAMES = ['a', 'b', 'c'];
const idOf = (n) => `q624t3_mesh_${n}-receiver`;
const SCHEDULES = {
  'every pair': [['a', 'b'], ['b', 'a'], ['a', 'c'], ['c', 'a'], ['b', 'c'], ['c', 'b']],
  'A reaches C before B': [['a', 'c'], ['c', 'a'], ['a', 'b'], ['b', 'a'], ['b', 'c'], ['c', 'b']],
  'C is reached only through B': [['a', 'b'], ['b', 'a'], ['b', 'c'], ['c', 'b']],
};

/** A club network over the three instances, as instance `me` sees it: the other two are its members. */
const networksFor = (me) => [{
  id: 'q624-mesh-net', label: 'Mesh', type: 'club', origin: 'joined', votes: [], votingDeadlineHours: 24, spaces: [S],
  members: NAMES.filter(n => n !== me).map(n => ({ instanceId: idOf(n), label: n.toUpperCase(), url: 'http://192.0.2.1:9', tokenHash: 'x', direction: 'both' })),
}];

class Instance {
  constructor(name) { this.name = name; this.id = idOf(name); this.pending = new Map(); this.serial = 0; }
  async start() {
    this.child = spawn(process.execPath, [path.join(HERE, '_q624-mesh-instance.mjs')], {
      env: { ...process.env, MESH_SUITE: `q624t3_mesh_${this.name}`, MESH_SPACE: S, MESH_NETWORKS: JSON.stringify(networksFor(this.name)) },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const rl = readline.createInterface({ input: this.child.stdout });
    await new Promise((resolve, reject) => {
      this.child.once('exit', (code) => reject(new Error(`instance ${this.name} exited ${code} before it was ready`)));
      rl.on('line', (line) => {
        let msg; try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) { resolve(); return; }
        const p = this.pending.get(msg.rid);
        if (p) { this.pending.delete(msg.rid); if (msg.error) p.reject(new Error(`${this.name}: ${msg.error}`)); else p.resolve(msg.result); }
      });
    });
  }
  call(op, args = {}) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      // A call that is never answered must fail by name, not hold the run until the runner's own clock.
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`instance ${this.name} did not answer '${op}' in 60 s`)); }, 60_000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.child.stdin.write(`${JSON.stringify({ rid: id, op, ...args })}\n`);
    });
  }
  async stop() { this.child?.stdin.end(); await new Promise(r => { this.child?.once('exit', r); setTimeout(r, 5000); }); }
}

describe('a fork resolved elsewhere is decided here', { skip }, () => {
  const inst = {};
  before(async () => {
    await fixtures.initForkFixtures();
    for (const n of NAMES) inst[n] = new Instance(n);
    await Promise.all(NAMES.map(n => inst[n].start()));
  });
  after(async () => { await Promise.all(NAMES.map(n => inst[n]?.stop())); });

  /** One cycle of a schedule: every listed (from, to) carries the sender's rows and tombstones through the receiver's own routes. */
  async function cycle(schedule, families) {
    for (const [from, to] of SCHEDULES[schedule]) {
      for (const family of families) {
        const docs = await inst[from].call('serve', { family });
        if (docs.length > 0) await inst[to].call('receive', { from: inst[from].id, family, docs });
      }
      const tombs = await inst[from].call('serveTombstones');
      if (tombs.length > 0) await inst[to].call('receiveTombstones', { from: inst[from].id, tombs });
    }
  }

  /** Subject P (authored by A, on all three) and the fork F of it that C authored (on C): ids that verify. */
  async function setup(kind) {
    const k = fixtures.FORK_KINDS[kind];
    for (const n of NAMES) await inst[n].call('wipe');
    const idn = kind === 'edge' ? { from: 'ea', to: 'eb', label: 'knows' } : {};
    let pId = 'p-subject';
    if (kind === 'edge') {
      const { edgeIdFor } = await import('../../server/dist/brain/edge-id.js');
      pId = edgeIdFor('ea', 'eb', 'knows', 'entity', 'entity');
    }
    const author = (n) => ({ instanceId: idOf(n), instanceLabel: n.toUpperCase() });
    const parent = k.row(S, pId, 5, { ...idn, author: author('a'), pos: 5, posAtSeq: 5 });
    const fork = { ...k.row(S, 'x', 5, { ...idn, ...k.alt, author: author('c'), pos: 5, posAtSeq: 5 }), forkOf: pId };
    fork._id = fixtures.forkIdOf(k.family, pId, fork);
    for (const n of NAMES) await inst[n].call('seed', { family: k.family, rows: n === 'c' ? [parent, fork] : [parent] });
    return { k, parentId: pId, forkId: fork._id };
  }
  const marksOn = async (n, kind, forkId) => (await inst[n].call('list', { kind })).find(r => r.forkId === forkId)?.resolvedElsewhere;
  const byOf = (marks) => (marks ?? []).map(m => m.by).sort();

  for (const kind of Object.keys(fixtures.FORK_KINDS)) {
    for (const schedule of Object.keys(SCHEDULES)) {
      it(`${kind}, ${schedule}: each instance decides its own copy, and the marks name who decided`, async () => {
        const { k, forkId } = await setup(kind);
        const A = inst.a.id; const B = inst.b.id;

        // 1. F reaches every instance.
        await cycle(schedule, [k.family]); await cycle(schedule, [k.family]);
        for (const n of schedule === 'C is reached only through B' ? NAMES : NAMES) assert.ok(await inst[n].call('has', { family: k.family, id: forkId }), `${n.toUpperCase()} does not hold F after the cycles`);

        // 2. Resolve on A: A's copy goes behind a tombstone issued here; B and C keep theirs, marked.
        const r2 = await inst.a.call('resolve', { kind, forkId, keep: 'parent' });
        assert.ok(r2.ok, `resolve on A refused: ${r2.sentence}`);
        assert.equal(await inst.a.call('has', { family: k.family, id: forkId }), false, 'A still holds F after resolving it');
        assert.equal((await inst.a.call('serveTombstones')).some(t => t._id === forkId && t.instanceId === A), true, 'A holds no tombstone it issued for F');
        await cycle(schedule, [k.family]);
        for (const n of ['b', 'c']) {
          assert.ok(await inst[n].call('has', { family: k.family, id: forkId }), `${n.toUpperCase()} lost F to a tombstone its authority declines: nothing is deleted on a peer's word that the authority refused`);
          const marks = await marksOn(n, kind, forkId);
          assert.deepEqual(byOf(marks), [A], `${n.toUpperCase()} lists F marked ${JSON.stringify(marks)}, expected resolved on A`);
          assert.equal(marks[0].kept, 'original', `${n.toUpperCase()}: A kept the original, but the row says '${marks[0].kept}'`);
        }

        // 3. Resolve on B: B's copy goes and only B's; C then lists F resolved on A and on B.
        const r3 = await inst.b.call('resolve', { kind, forkId, keep: 'parent' });
        assert.ok(r3.ok, `resolve on B refused: ${r3.sentence}`);
        await cycle(schedule, [k.family]);
        assert.equal(await inst.b.call('has', { family: k.family, id: forkId }), false, 'B still holds F after resolving it');
        assert.ok(await inst.c.call('has', { family: k.family, id: forkId }), 'resolving on B removed C\'s copy against C\'s authority');
        assert.deepEqual(byOf(await marksOn('c', kind, forkId)), [A, B].sort(), 'C does not list F resolved on both A and B');

        // 5. Resolve on C: F is gone on all three and the three agree on the space's hash.
        const r5 = await inst.c.call('resolve', { kind, forkId, keep: 'parent' });
        assert.ok(r5.ok, `resolve on C refused: ${r5.sentence}`);
        await cycle(schedule, [k.family]); await cycle(schedule, [k.family]);
        for (const n of NAMES) assert.equal(await inst[n].call('has', { family: k.family, id: forkId }), false, `${n.toUpperCase()} still holds F after every instance resolved it`);
        const roots = await Promise.all(NAMES.map(n => inst[n].call('root')));
        assert.deepEqual([...new Set(roots.map(r => JSON.stringify(r)))].length, 1, `the three instances disagree on the space's merkle root: ${JSON.stringify(roots)}`);
      });
    }
  }
});
