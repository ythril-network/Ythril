/**
 * Deleting a file removes EVERYTHING that follows it: its conversion's records two levels down, the sidecar rows a peer's
 * bytes created, the queued jobs of its extracted images — and nothing of what only looks like its own (bundle-71, Q-349).
 *
 * ## The defect
 *
 * The delete removes the rows whose `parentFileId` is the file, and the sidecar BYTES (`_converted/<f>.md`,
 * `_extracted/<f>/`). It does not remove:
 *
 *  - the caption chunk and the face chunks of an extracted image: their `parentFileId` is `_extracted/<f>/x.jpg`, the
 *    image, not the file — two levels down, found by nothing the delete looks at;
 *  - the TOP-LEVEL row an arrived sidecar made (`recordArrivedFile`: no `parentFileId`, seq 0, authored by the peer whose
 *    bytes landed first), because derived rows never replicate and a receiver that never converted holds the sidecar as an
 *    ordinary file;
 *  - the queued media job of an extracted image, which then retries for ever against a path nothing holds.
 *
 * And it removes too much in one case: a DIRECTORY `g.md/` has its sidecar tree at `_converted/g.md/`, which is exactly the
 * path the converted Markdown of a FILE `g` would have — the delete took the tree of a directory it never named.
 *
 * ## The rule, on all three doors a file is deleted by (REST, MCP, the TTL sweep: one cascade, `deleteFileCascade`)
 *
 *  1. every artefact of the file is gone: its row, its chunk rows, its sidecar bytes and rows (derived, or arrived), the rows
 *     under an extracted image, and the image's queued job
 *  2. nothing that is not the file's goes: a name-prefix neighbour's sidecars and chunks, and — for a file with no
 *     `_converted/<f>.md` of its own — the sidecar tree of a directory `<f>.md/` standing beside it
 *  3. with `softDeleteFileMeta` an arrived sidecar row is treated as the file's own row is (flagged, never left live), and a
 *     derived row is removed as ever
 *  4. the delete still publishes ONE tombstone, for the file: the sidecars' deletion is their parent's, so none is written
 *     for them (a control: green on the base, and it must stay so)
 *
 * Run: node --test testing/standalone/a-file-delete-removes-what-its-conversion-and-its-peers-left-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'sidecardel';
const T0 = '2026-09-01T00:00:00.000Z';
const sha = (s) => createHash('sha256').update(s).digest('hex');
/** The peer whose bytes landed first: the author and deliverer of an arrived sidecar's row. */
const ARRIVER = { instanceId: 'arriving-peer', instanceLabel: 'Arriving peer' };

let acts, door, ttl, loader;

const rowOf = (id) => door.coll(S, 'files').findOne({ _id: id });
/** A row that counts as still there: present, and not flagged deleted. */
const live = async (id) => { const r = await rowOf(id); return r !== null && r.deletedAt === undefined; };
const jobOf = (id) => door.coll(S, 'media_jobs').findOne({ _id: id });

/** Bytes on this instance's disk, as a conversion or an arrival left them. */
function put(rel, content = `bytes of ${rel}`) {
  const abs = path.join(acts.root(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
const onDisk = (rel) => acts.onDisk(rel);

/** A file's own row, as an upload left it: a version, a content hash. */
const fileRow = (id, content, extra = {}) => build.filemeta(S, id, 3, { sizeBytes: content.length, sha256: sha(content), ...extra });
/** A row a conversion wrote: derived, pointing at its parent. */
const derived = (id, parentFileId, extra = {}) => build.filemeta(S, id, 4, { parentFileId, ...extra });
/** The row an ARRIVED sidecar made: top-level (no `parentFileId`), seq 0, authored and delivered by the peer whose bytes landed. */
const arrived = (id, extra = {}) => build.filemeta(S, id, 0, { author: ARRIVER, deliveredBy: ARRIVER.instanceId, sizeBytes: 9, ...extra });

/**
 * File `f` as a converting instance that ALSO received a sidecar from a peer holds it. Returns every id the file owns,
 * by kind, so a failure names what was left.
 */
async function seedFileWithEverything(f, { expired = false } = {}) {
  const bytes = `content of ${f}`;
  put(f, bytes);
  const converted = `_converted/${f}.md`;
  const img = `_extracted/${f}/x.jpg`;
  const arrivedImg = `_extracted/${f}/arrived.png`;
  put(converted); put(img); put(arrivedImg);
  const ids = {
    file: f,
    chunk: `${f}#chunk-0`,                 // one level down: the delete already took these
    converted,                              // an ARRIVED top-level row (the file has no conversion of its own at this instance)
    image: img,                             // derived: parentFileId = f
    arrivedImage: arrivedImg,               // an ARRIVED top-level row
    caption: `${img}#media-chunk0`,         // two levels down: parentFileId = the image
    face: `${img}#face-chunk0`,             // two levels down
  };
  await door.coll(S, 'files').insertMany([
    fileRow(f, bytes, expired ? { _expireAt: new Date('2026-01-01T00:00:00Z') } : {}),
    derived(ids.chunk, f),
    arrived(converted),
    derived(img, f),
    arrived(arrivedImg),
    derived(ids.caption, img, { content: 'a caption' }),
    derived(ids.face, img, { faceEmbedding: [0.1, 0.2] }),
  ]);
  await door.coll(S, 'media_jobs').insertOne({ _id: img, spaceId: S, status: 'pending' });
  return ids;
}

/** Everything of the file that is still here, by name. */
async function leftOf(ids, f) {
  const left = [];
  for (const [name, id] of Object.entries(ids)) if (await live(id)) left.push(`row:${name}`);
  if (onDisk(f)) left.push('bytes:file');
  for (const rel of [ids.converted, ids.image, ids.arrivedImage]) if (onDisk(rel)) left.push(`bytes:${rel}`);
  if (await jobOf(ids.image)) left.push('job:image');
  return left;
}

/** A neighbour whose name merely starts with the file's: its sidecars, chunks and job must survive the delete. */
async function seedNeighbour(n) {
  put(n, `content of ${n}`);
  put(`_converted/${n}.md`); put(`_extracted/${n}/y.jpg`);
  const img = `_extracted/${n}/y.jpg`;
  const ids = [n, `${n}#chunk-0`, `_converted/${n}.md`, img, `${img}#media-chunk0`];
  await door.coll(S, 'files').insertMany([
    fileRow(n, `content of ${n}`), derived(ids[1], n), arrived(ids[2]), derived(img, n), derived(ids[4], img),
  ]);
  await door.coll(S, 'media_jobs').insertOne({ _id: img, spaceId: S, status: 'pending' });
  return { ids, disk: [n, `_converted/${n}.md`, img], job: img };
}
async function lostOfNeighbour(nb) {
  const lost = [];
  for (const id of nb.ids) if (!(await live(id))) lost.push(`row:${id}`);
  for (const rel of nb.disk) if (!onDisk(rel)) lost.push(`bytes:${rel}`);
  if (!(await jobOf(nb.job))) lost.push(`job:${nb.job}`);
  return lost;
}

const DOORS = {
  REST: { seedOpts: {}, async del(f) { const a = await acts.del('REST', f); assert.ok(!acts.failed(a), `REST delete: ${JSON.stringify(a.body)}`); } },
  MCP: { seedOpts: {}, async del(f) { const a = await acts.del('MCP', f); assert.ok(!acts.failed(a), `MCP delete_file: ${a.text}`); } },
  'TTL sweep': { seedOpts: { expired: true }, async del() { await ttl.sweepExpired(new Date()); } },
};

describe('deleting a file removes what its conversion and its peers left, and only that', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'sidecardel', space: S });
    ({ door } = acts);
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
    loader = await import('../../server/dist/config/loader.js');
  });
  after(async () => {
    if (loader) loader.getConfig().softDeleteFileMeta = false;
    await acts?.close();
  });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['media_jobs', 'file_hashes']) await door.coll(S, part).deleteMany({});
    loader.getConfig().softDeleteFileMeta = false;
  });

  for (const [name, d] of Object.entries(DOORS)) {
    it(`${name}: every artefact of the file goes, a name-prefix neighbour's stays`, async () => {
      const f = 'docs/f.txt';
      const ids = await seedFileWithEverything(f, d.seedOpts);
      const neighbour = await seedNeighbour('docs/f.txtx');
      const before = await leftOf(ids, f);
      // seven rows, the file's bytes and three sidecars' bytes, one queued job
      assert.equal(before.length, 7 + 4 + 1, `fixture: the file does not have everything it is meant to (${before})`);
      await d.del(f);
      assert.deepEqual({ left: await leftOf(ids, f), neighbourLost: await lostOfNeighbour(neighbour) }, { left: [], neighbourLost: [] },
        'left = what the delete of the file left behind (rows two levels down, the arrived sidecars\' top-level rows, an image\'s job); '
        + 'neighbourLost = what it took from a file whose name only starts with the same letters');
    });

    it(`${name}: the sidecar tree of a directory beside the file survives the file's delete`, async () => {
      // `g` has NO converted Markdown, so `_converted/g.md` is not its sidecar: it is the tree of the DIRECTORY `g.md/`.
      const g = 'docs/g';
      const dirFile = 'docs/g.md/inner.txt';
      put(g, 'content of g'); put(dirFile);
      put('_converted/docs/g.md/inner.txt.md'); put('_extracted/docs/g.md/pic.jpg');
      put(`_extracted/${g}/own.jpg`);
      await door.coll(S, 'files').insertMany([
        fileRow(g, 'content of g', d.seedOpts.expired ? { _expireAt: new Date('2026-01-01T00:00:00Z') } : {}),
        derived(`_extracted/${g}/own.jpg`, g),
        fileRow(dirFile, `bytes of ${dirFile}`),
        arrived('_converted/docs/g.md/inner.txt.md'),
        derived('_extracted/docs/g.md/pic.jpg', dirFile),
      ]);
      await d.del(g);
      assert.ok(!onDisk(g) && !onDisk(`_extracted/${g}/own.jpg`) && !(await live(`_extracted/${g}/own.jpg`)), 'the delete did not remove the file\'s own artefacts');
      const lost = [];
      for (const rel of [dirFile, '_converted/docs/g.md/inner.txt.md', '_extracted/docs/g.md/pic.jpg']) if (!onDisk(rel)) lost.push(`bytes:${rel}`);
      for (const id of [dirFile, '_converted/docs/g.md/inner.txt.md', '_extracted/docs/g.md/pic.jpg']) if (!(await live(id))) lost.push(`row:${id}`);
      assert.deepEqual(lost, [], 'deleting the file `docs/g` removed the sidecar tree of the directory `docs/g.md/`, which it never named');
    });
  }

  it('with softDeleteFileMeta an arrived sidecar row is flagged like the file\'s own, and a derived row is removed', async () => {
    loader.getConfig().softDeleteFileMeta = true;
    const f = 'docs/soft.txt';
    const ids = await seedFileWithEverything(f);
    const a = await acts.del('REST', f);
    assert.ok(!acts.failed(a), JSON.stringify(a.body));
    const fileRowNow = await rowOf(f);
    assert.equal(typeof fileRowNow?.deletedAt, 'string', 'fixture: the soft delete did not flag the file\'s own row');
    // `live` reads a flagged row as gone, so what is listed is a row nobody flagged or removed, and bytes still on disk.
    assert.deepEqual(await leftOf(ids, f), [],
      'artefacts of the file survived a soft delete (an arrived sidecar row left LIVE, or a derived row two levels down)');
    for (const id of [ids.chunk, ids.image, ids.caption, ids.face]) {
      assert.equal(await rowOf(id), null, `the derived row ${id} was kept: derived rows are removed whatever the setting`);
    }
  });

  it('the delete publishes one tombstone, for the file: its sidecars are its parent\'s deletion and get none (control)', async () => {
    const f = 'docs/one.txt';
    await seedFileWithEverything(f);
    const a = await acts.del('REST', f);
    assert.ok(!acts.failed(a), JSON.stringify(a.body));
    assert.deepEqual(await acts.published(), { served: [f], pushed: [f] },
      'a delete of a converted file must publish its own path only');
  });
});
