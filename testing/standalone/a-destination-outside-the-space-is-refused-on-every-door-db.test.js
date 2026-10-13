/**
 * A destination that leaves the space writes nothing outside it, on every door that places bytes or a directory (Q-351).
 *
 * ## The rule
 *
 * A caller's destination is a path INSIDE the space, and no spelling of one reaches anything else on the host. Three spellings are
 * held, each against every door that can be asked to place something at a caller's path:
 *
 * - a `..` segment that climbs out of the space (`../outside/x`, and `a/../../outside/x`, where the climb comes after a descent);
 * - an ABSOLUTE destination (a drive-lettered path on Windows, a leading-slash path elsewhere): never written where it names. A
 *   leading slash is read as space-relative (`/x` is `x`), so on a platform where that is what the path is, the answer is a success
 *   INSIDE the space; where it names another drive it is refused. Either way nothing outside the space changes;
 * - a destination whose ANCESTOR is a symlink (a junction on Windows, which needs no privilege) pointing outside the space.
 *
 * A refusal is the caller's (`4xx`, never `5xx`), names no path of the server's own, and leaves the source's bytes and record, the
 * tombstones and everything outside the space exactly as they were.
 *
 * ## Doors held
 *
 * REST `PATCH /api/files`, `POST /api/move_file` and MCP `move_file`; REST upload, `POST /api/write_file` and MCP `write_file`; REST
 * `mkdir`, `POST /api/create_dir` and MCP `create_dir`. The doors are the real handlers (`_file-act-doors.mjs`); only auth is skipped.
 * "Nothing outside the space" is a listing of the whole data root before and after, less the space's own tree.
 *
 * Run: node --test testing/standalone/a-destination-outside-the-space-is-refused-on-every-door-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'destoutside';
const T0 = '2026-09-01T00:00:00.000Z';

let acts, outside;

/** The answer of any door as `{ status, wire }`: the status, and every byte of text the answer carried. */
function normalised(answer) {
  if ('code' in answer) return { status: answer.code, wire: JSON.stringify({ body: answer.body, headers: answer.headers }) };
  return { status: answer.status, wire: JSON.stringify({ text: answer.text, sc: answer.sc }) };
}

/** Each door that can be asked to place something at `dst`; `run(dst)` answers normalised. A move's source is `s.txt`. */
const DOORS = () => [
  { name: 'REST PATCH /api/files (move)', move: true, run: async (dst) => normalised(await acts.rest('PATCH', { path: 's.txt' }, { destination: dst })) },
  { name: 'POST /api/move_file', move: true, run: async (dst) => normalised(await acts.tool('move_file', { src: 's.txt', dst })) },
  { name: 'MCP move_file', move: true, run: async (dst) => normalised(await acts.mcp('move_file', { src: 's.txt', dst })) },
  { name: 'REST upload', run: async (dst) => normalised(await acts.post('upload', { query: { path: dst }, body: { content: 'hello' }, headers: { 'content-type': 'application/json' } })) },
  { name: 'POST /api/write_file', run: async (dst) => normalised(await acts.tool('write_file', { path: dst, content: 'hello' })) },
  { name: 'MCP write_file', run: async (dst) => normalised(await acts.mcp('write_file', { path: dst, content: 'hello' })) },
  { name: 'REST mkdir', dir: true, run: async (dst) => normalised(await acts.post('mkdir', { query: { path: dst } })) },
  { name: 'POST /api/create_dir', dir: true, run: async (dst) => normalised(await acts.tool('create_dir', { path: dst })) },
  { name: 'MCP create_dir', dir: true, run: async (dst) => normalised(await acts.mcp('create_dir', { path: dst })) },
];

/** Every path under the data root, with its size, except the space's own tree: what "outside the space" holds. */
function outsideTheSpace() {
  const dataRoot = process.env['DATA_ROOT'];
  const spaceTree = path.join(dataRoot, 'files', S);
  const seen = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (abs === spaceTree) continue;
      const stat = fs.lstatSync(abs);
      seen.push(`${path.relative(dataRoot, abs).replaceAll('\\', '/')}${entry.isDirectory() ? '/' : ` ${stat.size}`}`);
      if (entry.isDirectory()) walk(abs);
    }
  };
  walk(dataRoot);
  return seen.sort();
}

/** Whether a link to a directory can be made here: a junction on Windows (no privilege needed), a symlink elsewhere. */
function linkTo(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** What a refused act must have left alone, inside the space and out of it. */
async function assertNothingWritten(door, before, { move }) {
  assert.deepEqual(outsideTheSpace(), before, `${door}: something outside the space changed`);
  assert.deepEqual(await acts.raw(), [], `${door}: a refused destination left a tombstone behind`);
  if (move) {
    assert.equal(fs.readFileSync(path.join(acts.root(), 's.txt'), 'utf8'), 'content of s.txt', `${door}: the source's bytes are not where they were`);
    const row = await acts.door.coll(S, 'files').findOne({ _id: 's.txt' });
    assert.ok(row && row.updatedAt === T0, `${door}: the source's record is gone or was rewritten`);
  }
}

/** A refusal is the caller's and says nothing of the server's own paths. */
function assertRefusedAsTheCallers(door, a) {
  assert.ok(a.status >= 400 && a.status < 500, `${door}: a destination outside the space answered ${a.status}, not a 4xx — ${a.wire}`);
  const root = process.env['DATA_ROOT'];
  for (const form of [root, root.replaceAll('\\', '\\\\'), root.replaceAll('\\', '/')]) {
    assert.ok(!a.wire.includes(form), `${door}: the answer carries the server's data root: ${a.wire}`);
  }
}

describe('a destination that leaves the space writes nothing outside it', { skip }, () => {
  before(async () => { acts = await openFileActDoors({ suite: 'destoutside', space: S }); });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    // A neighbour of the space under the data root, with something in it: what an escape would write into.
    outside = path.join(process.env['DATA_ROOT'], 'files', 'outside');
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched');
    await acts.seed('s.txt');
  });

  describe('a `..` segment that climbs out of the space', () => {
    for (const spelling of ['../outside/escaped', 'sub/../../outside/escaped', '../../../escaped']) {
      for (const d of DOORS()) {
        it(`${d.name}: ${spelling} is refused, and nothing is written anywhere`, async () => {
          const before = outsideTheSpace();
          assertRefusedAsTheCallers(d.name, await d.run(spelling));
          await assertNothingWritten(d.name, before, { move: !!d.move });
        });
      }
    }
  });

  describe('an absolute destination', () => {
    for (const d of DOORS()) {
      it(`${d.name}: the named place outside the space is never written`, async () => {
        const named = path.join(outside, 'escaped');
        const before = outsideTheSpace();
        const a = await d.run(named);
        assert.ok(a.status < 500, `${d.name}: an absolute destination answered ${a.status} — ${a.wire}`);
        assert.deepEqual(outsideTheSpace(), before, `${d.name}: something outside the space changed`);
        assert.ok(!fs.existsSync(path.join(outside, 'escaped')), `${d.name}: the absolute destination was written where it names`);
      });

      it(`${d.name}: a leading slash is the space's own root, not the host's`, async () => {
        const before = outsideTheSpace();
        const a = await d.run('/outside/escaped');
        assert.ok(a.status < 500, `${d.name}: a leading-slash destination answered ${a.status} — ${a.wire}`);
        assert.deepEqual(outsideTheSpace(), before, `${d.name}: something outside the space changed`);
        assert.ok(!fs.existsSync(path.join(outside, 'escaped')), `${d.name}: a leading slash reached the host's /outside`);
      });
    }
  });

  describe('a destination whose ancestor is a symlink pointing outside the space', () => {
    let linked = false;
    beforeEach(() => {
      linked = false;
      try { linkTo(outside, path.join(acts.root(), 'link')); linked = true; } catch (err) {
        // Only the platform's refusal to make a link skips this: the cases below say so, they do not pass silently.
        if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(err?.code)) throw err;
      }
    });
    for (const d of DOORS()) {
      it(`${d.name}: link/escaped is refused, and nothing is written through the link`, async (t) => {
        if (!linked) return t.skip('this machine cannot create a symbolic link or junction here (EPERM/EACCES), so the case cannot be set up');
        const before = outsideTheSpace();
        assertRefusedAsTheCallers(d.name, await d.run('link/escaped'));
        await assertNothingWritten(d.name, before, { move: !!d.move });
        assert.deepEqual(fs.readdirSync(outside), ['keep.txt'], `${d.name}: something was written through the link`);
      });
    }
  });
});
