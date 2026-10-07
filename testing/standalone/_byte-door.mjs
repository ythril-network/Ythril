/**
 * Drive the file BYTE door — `POST /api/files/:spaceId?path=` — in-process, as a peer or as a person would reach it, and
 * read what it answered: the question "what does this instance do with bytes that ARRIVE at the upload door", answered
 * once for every test that asks it (bundle-51, Q-229).
 *
 * ## Why a module
 *
 * The byte door is the third way a file's content arrives (after the manifest pull and the metadata batch), and the one
 * that carries TWO callers with opposite rules: a peer pushing a file it holds delivers an ARRIVAL (a deleted file's bytes
 * must not come back through it), while a person re-uploading the same bytes is authoring a new version and must always
 * succeed. A test that drives one caller and not the other cannot tell a door that refuses peers from one that refuses
 * everybody, so the helper takes the token as an argument and the two are one call apart.
 *
 * ## What a hand-written copy drops
 *
 * **The route's own handler, not a fake of it.** It is the LAST layer on the router's `POST /:spaceId` — past rate limit,
 * space auth and the raw-body parser, which a request built here replaces by handing the body in as a Buffer. The chunked
 * upload is the same handler reached with a `Content-Range`, so both shapes go through the code a peer reaches.
 *
 * It does not stub the writer, the quota, the chunk assembly or the metadata layer. Models are offline (`YTHRIL_MODELS_OFFLINE`)
 * so a stored file is queued and never embedded.
 */
import assert from 'node:assert/strict';

process.env['YTHRIL_MODELS_OFFLINE'] = '1';

/**
 * @returns {Promise<{ post: (o: object) => Promise<{ code: number, body: any }> }>}
 */
export async function openByteDoor() {
  const { fileStoreRouter } = await import('../../server/dist/api/files.js');
  const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods['post']);
  assert.ok(layer, 'no POST /:spaceId on the file router — re-anchor _byte-door.mjs');
  const handle = layer.route.stack.at(-1).handle;

  /**
   * POST bytes to the door.
   *
   * @param {object} o
   * @param {string} o.space
   * @param {string} o.path
   * @param {Buffer} o.bytes  the body (a chunk's bytes when `range` is given)
   * @param {object} o.token  the caller: `peerToken(id)` for a peer, a token with no `peerInstanceId` for a person
   * @param {string} [o.range]  a `Content-Range` header: the request is one chunk of a chunked upload
   */
  async function post({ space, path, bytes, token, range }) {
    const req = {
      method: 'POST', params: { spaceId: space }, query: { path }, body: bytes, authToken: token,
      headers: { 'content-type': 'application/octet-stream', ...(range ? { 'content-range': range } : {}) },
      get: () => undefined, is: () => false,
    };
    const res = {
      code: 200, body: undefined, headersSent: false, headers: {},
      status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; },
    };
    await handle(req, res);
    assert.ok(res.headersSent, `POST /api/files/${space} settled without answering`);
    return { code: res.code, body: res.body };
  }

  return { post };
}

/** A caller with no peer identity — a person's token. Whatever it uploads is authored here, never an arrival. */
export const USER_TOKEN = Object.freeze({
  name: 'a person',
  rights: { instanceAdmin: true, perSpace: {}, spaceAdmin: { floor: true, spaces: [] } },
});
