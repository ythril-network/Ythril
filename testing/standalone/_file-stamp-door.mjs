/**
 * Arrange a file-stamp report's whole situation, in process, against a real Mongo and a fake peer — the question "what
 * does `file_stamp_report` say about THESE rows, given what THAT peer's file feed holds", answered once for every test
 * that asks it (`Q-433`).
 *
 * ## What it is
 *
 * A pull door (`_pull-door.mjs`: config, the server's Mongo layer, the engine's network config, and a fake peer on a
 * routable address) with the peer's record family `filemeta` served by the REAL page handler (`pageBySeq`, through
 * `serveFamily`), so what the report reads is what a real peer sends, down to `authoredKeys` and the local-only fields
 * removed. A row is seeded on both sides with `s1` (a stamp: authored here, created later than the peer's copy, the
 * peer's `syncBase` set) or one side at a time with `ours` and `peer`.
 *
 * ## The things a hand-written copy drops
 *
 * **A row whose every OTHER count qualifies.** The absence cases (a moved row, a deleted row, a peer-authored row) only
 * mean something when the row would be reported but for the one count under test. `ours` and `peer` default to a row
 * that passes every condition, so a case overrides ONE field and the rest stays qualifying.
 *
 * **The peer's own storage.** The peer's rows live under `peer-<space>` (`_pull-door.mjs` explains why a peer serving
 * the receiver's own collection would make every "was it read" assertion pass by construction).
 *
 * **The feed hook is re-armed after every `reset`.** `reset` clears `state.family`; a case that forgot to set it would
 * be served the fake peer's canned empty page and every "likely" would read as "the peer holds nothing".
 *
 * ## What it does not do
 *
 * It does not stub the report, the engine, the feed handler or the data layer. The report is imported lazily, so a
 * missing module fails the CASE that calls it, after its fixture has been built — a fixture that is wrong fails with
 * its own message, not with the module's.
 */
import { createHash } from 'node:crypto';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { build } from './_push-door.mjs';

export { PEER, PEER_AUTHOR };

export const sha256Of = (text) => createHash('sha256').update(text).digest('hex');

/** The peer created the file; this instance's row (the stamp) was written later. Months apart: far past any clock tolerance. */
export const PEER_CREATED = '2026-06-01T00:00:00.000Z';
export const OURS_CREATED = '2026-08-01T00:00:00.000Z';

/** The body every file in these cases has, so one hash is the one both rows carry. */
export const bytesOf = (path) => `bytes of ${path}`;

/**
 * @param {object} o
 * @param {string} o.suite  harness database slug
 * @param {string} o.space  the one local space the door carries (it is the network's id for it too)
 * @param {object} [o.pull]  further options for `openPullDoor` (`spaceMap`, `extraSpaces`, `type`, …)
 */
export async function openStampDoor({ suite, space, pull = {} }) {
  const door = await openPullDoor({
    suite, spaces: [space], files: true, meta: { [space]: { suppressEmbeddings: true } }, ...pull,
  });
  const loader = await import('../../server/dist/config/loader.js');
  const { fillFileMetaFromStray } = await import('../../server/dist/sync/fill-file-meta.js');
  const remote = door.remoteOf(space);
  const self = door.instanceId;
  const selfAuthor = { instanceId: self, instanceLabel: 'Receiver' };
  let n = 0;

  const files = () => door.coll(space, 'files');
  const peerFiles = () => door.mongo.col(`${door.peerSide(remote)}_files`);

  /** Serve the peer's file feed with the real handler; the one place a case's feed hook is armed. */
  const armFeed = () => { door.state.family = door.serveFamily; };
  armFeed();

  /** This instance's row of `path`, as a stamp leaves it: every condition of "likely" passes unless `over` breaks one. */
  async function ours(path, over = {}) {
    const doc = {
      _id: path, spaceId: space, path, tags: [], author: selfAuthor, deliveredBy: '',
      createdAt: OURS_CREATED, updatedAt: OURS_CREATED, seq: 1000 + (++n), sizeBytes: bytesOf(path).length,
      sha256: sha256Of(bytesOf(path)), syncBase: { [PEER]: sha256Of(bytesOf(path)) },
      ...over,
    };
    for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
    await files().insertOne(doc);
    return doc;
  }

  /** The peer's row of `path`, as its feed serves it: the peer is the author, created earlier, the same bytes. */
  async function peer(path, over = {}) {
    const doc = build.filemeta(remote, path, 5 + (++n), {
      author: PEER_AUTHOR, createdAt: PEER_CREATED, updatedAt: PEER_CREATED,
      sizeBytes: bytesOf(path).length, sha256: sha256Of(bytesOf(path)), ...over,
    });
    for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
    await door.seedPeerRecords(remote, 'filemeta', [doc]);
    return doc;
  }

  /** A stamp (S1): this instance's row and the peer's, both qualifying. */
  async function s1(path, { ours: o = {}, peer: p = {} } = {}) {
    return { ours: await ours(path, o), peer: await peer(path, p) };
  }

  /**
   * Fill a row this instance made by default from the peer's record, through the REAL `fillFileMetaFromStray` (what the
   * 5.6.3 stray-filemeta drain calls), so the row has exactly the content the drain leaves — the peer's description, tags
   * and properties, and NO `descriptionSource` — and not what a test thinks the drain leaves.
   */
  async function drained(path, stray) {
    const outcome = await fillFileMetaFromStray(space, { _id: path, seq: 1, ...stray });
    if (outcome !== 'merged') throw new Error(`the fixture's fill of ${path} came out '${outcome}', not 'merged': the row is not the drained one`);
    return files().findOne({ _id: path });
  }

  /** The report, imported when first asked for. */
  async function report(opts = {}) {
    const { fileStampReport } = await import('../../server/dist/files/file-stamp-report.js');
    return fileStampReport(space, { limit: 1000, ...opts });
  }

  /** A path's row in an answer, or undefined. */
  const rowOf = (answer, path) => (answer.rows ?? []).find(r => r.path === path);

  /** The fake peer's requests for its file feed since the last reset, as the receiver wrote them. */
  const feedRequests = () => door.state.familyRequests.filter(q => q.family === 'filemeta');

  /** Make the config carry the peer's token again, and the topology the door opened with. */
  async function reset() {
    await door.reset();
    loader.getSecrets().peerTokens[PEER] = 'pull-door-token';
    n = 0;
    armFeed();
  }

  return {
    door, space, remote, self, selfAuthor, files, peerFiles, ours, peer, s1, drained, report, rowOf, feedRequests, reset, armFeed,
    close: () => door.close(),
  };
}
