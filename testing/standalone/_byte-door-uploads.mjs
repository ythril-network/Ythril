/**
 * The two SHAPES of an upload to the file byte door — one request, and a chunked upload in two halves — answered once for
 * every test that asks what the door does with what ARRIVES at it (bundle-71, Q-348 and Q-404).
 *
 * ## Why a module
 *
 * `_byte-door.mjs` drives ONE request. The chunked shape is a sequence (a first half answered `202`, a last half whose
 * answer is the verdict), and a test that wrote the sequence by hand twice would drop the thing that makes it a test of
 * the chunked door: that BOTH halves are sent through the same handler a peer reaches, with a `Content-Range` that sums to
 * the declared total. A copy that split the body unevenly, or sent the halves in the wrong order, would pass a door that
 * only reads the last request.
 *
 * ## What it does not do
 *
 * It does not interpret an answer. The caller reads `code` and `body`: a shadowed arrival is `200 { tombstoned: true }`, a
 * stored one is `201`/`202`, and which of them a case expects is the case's rule.
 */

import { USER_TOKEN } from './_byte-door.mjs';
import { peerToken } from './_push-door.mjs';

/**
 * One request carrying the whole body.
 *
 * @param {{ post: (o: object) => Promise<{ code: number, body: any }> }} door  `openByteDoor()`'s result
 * @param {{ space: string, path: string, content: string | Buffer, token: object }} o
 */
export function postWhole(door, { space, path, content, token }) {
  return door.post({ space, path, bytes: Buffer.from(content), token });
}

/**
 * The same body as a chunked upload: two halves, in order, to the same path. Returns both answers; `last` is the verdict.
 *
 * @param {{ post: (o: object) => Promise<{ code: number, body: any }> }} door
 * @param {{ space: string, path: string, content: string | Buffer, token: object }} o
 */
export async function postInHalves(door, { space, path, content, token }) {
  const bytes = Buffer.from(content);
  if (bytes.length < 2) throw new Error('postInHalves: a body of fewer than two bytes has no two halves');
  const mid = Math.floor(bytes.length / 2);
  const first = await door.post({ space, path, bytes: bytes.subarray(0, mid), token, range: `bytes 0-${mid - 1}/${bytes.length}` });
  const last = await door.post({ space, path, bytes: bytes.subarray(mid), token, range: `bytes ${mid}-${bytes.length - 1}/${bytes.length}` });
  return { first, last };
}

/**
 * Every way bytes reach the byte door: who delivers them (a person authors, a peer's push is an ARRIVAL) crossed with the
 * shape of the upload (one request, or a chunked upload in two halves). A rule about what the door does with a file's bytes is
 * a rule about all four, and a case that drives one of them cannot tell a door that does it from a door that does it for that
 * caller (the same reason the helper takes the token as an argument). Derived here once so no case lists them by hand and
 * leaves the chunked peer out.
 *
 * `send` answers with the verdict only: the chunked shape's last half, the single shape's one answer.
 *
 * @type {ReadonlyArray<{ name: string, arrival: boolean, chunked: boolean,
 *   send: (door: { post: Function }, o: { space: string, path: string, content: string | Buffer, peer?: string }) => Promise<{ code: number, body: any }> }>}
 */
export const UPLOAD_DOORS = Object.freeze([
  { name: 'a person, one request', arrival: false, chunked: false, send: (door, o) => postWhole(door, { ...o, token: USER_TOKEN }) },
  { name: 'a person, chunked', arrival: false, chunked: true, send: async (door, o) => (await postInHalves(door, { ...o, token: USER_TOKEN })).last },
  { name: 'a peer, one request', arrival: true, chunked: false, send: (door, o) => postWhole(door, { ...o, token: peerToken(o.peer ?? 'upload-door-peer') }) },
  { name: 'a peer, chunked', arrival: true, chunked: true, send: async (door, o) => (await postInHalves(door, { ...o, token: peerToken(o.peer ?? 'upload-door-peer') })).last },
]);
