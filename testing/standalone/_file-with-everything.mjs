/**
 * A file as an instance that converted it holds it — every row and every byte that follows it — seeded once, for the suites that
 * ask what an act on that file takes with it (bundle-71 Q-349: the delete; bundle-44 Q-314: the move).
 *
 * ## Why a module
 *
 * The delete's suite wrote this fixture and the move's suite needed the identical one: the second site, so it is extracted. The
 * reason it is shared and not copied is the question both ask — "what does a file leave behind / carry along" — which is only
 * answerable when both suites mean the same set by "everything". A fixture that grew a row in one suite and not the other would
 * let the two acts disagree about a file's set and each suite would still read green.
 *
 * ## What "everything" is
 *
 * The file's own row and chunk, its converted Markdown, two extracted images, and the caption and face rows under the first
 * image (two levels down: their `parentFileId` is the image) — every sidecar row DERIVED, as this instance's own pipeline writes
 * them; or, with `arrivedSidecars`, the converted Markdown and the second image as the TOP-LEVEL rows a peer's bytes made before
 * sidecars became instance-local (no `parentFileId`, seq 0, the peer as author). `arrivedChild` adds a derived row under the
 * ARRIVED second image: what an arrived sidecar's own conversion left, reachable only through the arrived row.
 *
 * ## What is keyed by the file's paths besides its rows (bundle-111, Q-459)
 *
 * Opt-in, so a suite that does not ask about them reads exactly the set it always read. `queued` queues an embed job for EVERY row of
 * the file — its own, the chunk, each sidecar and the rows under the image — through the queue's own sweep lane (`enqueueEmbedJobs`),
 * so the job ids are the queue's spelling (`embedJobId`) and never a hand-written `file:` prefix. `cached` writes the manifest's hash
 * cache entry for every row that HAS bytes ({@link BYTE_KINDS}), keyed by the path and carrying the bytes' real size and mtime, so the
 * next manifest walk reuses it — with a SENTINEL hash ({@link sentinelSha}) the bytes do not have: a manifest that answers the sentinel
 * for a path read the cache entry, and one that answers the real hash re-read the bytes. That is how "the entry was carried, not
 * re-hashed" is told from the store, without a spy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from './_push-door.mjs';

/** The peer whose bytes landed first: the author and deliverer of an arrived sidecar's row. */
export const ARRIVER = Object.freeze({ instanceId: 'arriving-peer', instanceLabel: 'Arriving peer' });
export const sha = (s) => createHash('sha256').update(s).digest('hex');
/** The hash a `cached` seed writes for `id`: a valid-looking sha256 that no seeded bytes have. */
export const sentinelSha = (id) => sha(`a cached entry, never these bytes: ${id}`);
/** The kinds of `seedFileWithEverything`'s ids that have bytes on disk, so a hash cache entry. The rest are rows only. */
export const BYTE_KINDS = Object.freeze(['file', 'converted', 'image', 'secondImage']);

/**
 * @param {string} S  the space the rows and bytes live in
 * @param {() => {door: any, root: () => string}} acts  a getter, because the doors are opened in the suite's `before`
 *   (an `openFileActDoors` result: `.door` for the collections, `.root()` for the files tree)
 */
export function fileWithEverything(S, acts) {
  /** Bytes on this instance's disk, as a conversion or an arrival left them. */
  function put(rel, content = `bytes of ${rel}`) {
    const abs = path.join(acts().root(), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  /** A file's own row, as an upload left it: a version, a content hash. */
  const fileRow = (id, content, extra = {}) => build.filemeta(S, id, 3, { sizeBytes: content.length, sha256: sha(content), ...extra });
  /** A row a conversion wrote: derived, pointing at its parent. */
  const derived = (id, parentFileId, extra = {}) => build.filemeta(S, id, 4, { parentFileId, ...extra });
  /** The row an ARRIVED sidecar made: top-level (no `parentFileId`), seq 0, authored and delivered by the peer whose bytes landed. */
  const arrived = (id, extra = {}) => build.filemeta(S, id, 0, { author: ARRIVER, deliveredBy: ARRIVER.instanceId, sizeBytes: 9, ...extra });

  /**
   * File `f` with everything (see the module docblock). Returns every id the file owns, by kind, so a failure names what was left.
   * `expired` stamps the retention window a TTL sweep reads; `derivedUpdatedAt` stores that `updatedAt` on every derived row;
   * `queued` and `cached` seed the embed jobs and the hash cache entries (see the module docblock).
   */
  async function seedFileWithEverything(f, { expired = false, arrivedSidecars = false, arrivedChild = false, derivedUpdatedAt, queued = false, cached = false } = {}) {
    const { door } = acts();
    const bytes = `content of ${f}`;
    put(f, bytes);
    const converted = `_converted/${f}.md`;
    const img = `_extracted/${f}/x.jpg`;
    const secondImg = `_extracted/${f}/second.png`;
    put(converted); put(img); put(secondImg);
    const ids = {
      file: f,
      chunk: `${f}#chunk-0`,                 // one level down
      converted,                              // derived (parentFileId = f), or an ARRIVED top-level row
      image: img,                             // derived: parentFileId = f
      secondImage: secondImg,                 // derived, or an ARRIVED top-level row
      caption: `${img}#media-chunk0`,         // two levels down: parentFileId = the image
      face: `${img}#face-chunk0`,             // two levels down
      ...(arrivedChild ? { secondCaption: `${secondImg}#media-chunk0` } : {}),   // under the second image, whose own row may be an arrival's
    };
    const stamp = derivedUpdatedAt === undefined ? {} : { updatedAt: derivedUpdatedAt };
    const d = (id, parent, extra = {}) => derived(id, parent, { ...stamp, ...extra });
    const sidecarRow = (id) => (arrivedSidecars ? arrived(id) : d(id, f));
    await door.coll(S, 'files').insertMany([
      fileRow(f, bytes, expired ? { _expireAt: new Date('2026-01-01T00:00:00Z') } : {}),
      d(ids.chunk, f),
      sidecarRow(converted),
      d(img, f),
      sidecarRow(secondImg),
      d(ids.caption, img, { content: 'a caption' }),
      d(ids.face, img, { faceEmbedding: [0.1, 0.2] }),
      ...(arrivedChild ? [d(ids.secondCaption, secondImg, { content: 'a second caption' })] : []),
    ]);
    await door.coll(S, 'media_jobs').insertOne({ _id: img, spaceId: S, status: 'pending' });
    if (queued) {
      const { enqueueEmbedJobs, EMBED_PRIORITY } = await import('../../server/dist/brain/embed-queue.js');
      await enqueueEmbedJobs(S, 'file', Object.values(ids), { priority: EMBED_PRIORITY.background });
    }
    if (cached) {
      await door.coll(S, 'file_hashes').insertMany(BYTE_KINDS.map(kind => {
        const st = fs.statSync(path.join(acts().root(), ids[kind]));
        return { _id: ids[kind], size: st.size, mtimeMs: st.mtimeMs, sha256: sentinelSha(ids[kind]), plainSize: st.size };
      }));
    }
    return ids;
  }

  /** A neighbour whose name merely starts with the file's: its sidecars, chunks and job must survive an act on the file. Its sidecars are its own conversion's: derived rows. */
  async function seedNeighbour(n) {
    const { door } = acts();
    put(n, `content of ${n}`);
    put(`_converted/${n}.md`); put(`_extracted/${n}/y.jpg`);
    const img = `_extracted/${n}/y.jpg`;
    const ids = [n, `${n}#chunk-0`, `_converted/${n}.md`, img, `${img}#media-chunk0`];
    await door.coll(S, 'files').insertMany([
      fileRow(n, `content of ${n}`), derived(ids[1], n), derived(ids[2], n), derived(img, n), derived(ids[4], img),
    ]);
    await door.coll(S, 'media_jobs').insertOne({ _id: img, spaceId: S, status: 'pending' });
    return { ids, disk: [n, `_converted/${n}.md`, img], job: img };
  }

  return { put, fileRow, derived, arrived, seedFileWithEverything, seedNeighbour };
}
