/**
 * The doors a peer-bound token may call: the one answer to "is this request one the sync protocol makes?" (bundle-47, Q-244).
 *
 * ## What it prevents
 *
 * A peer token is a peer's SYNC credential, minted with write on every area of the network's spaces so the sync doors can take its
 * pushes. Read by the rest of the API as an ordinary token, those rights let a pub/sub subscriber write its publisher's records and
 * files, a braintree child write its parent, and a peer that left one of two shared networks keep reading the space it left, through
 * any route or tool its matrix reached. Every guard resolves its token through one function (`resolveAuthTimed`), which asks this one
 * and answers the refusal below ({@link PEER_DOOR_STATUS}, {@link PEER_DOOR_CODE}) everywhere else, so a route added later is closed to peers by default rather than open.
 *
 * ## The doors, and where they come from
 *
 * Every request the sync engine sends a peer with the token that peer issued it (`peerSafeFetch` in `sync/`, `networks/`, `files/`),
 * unchanged since v6.0.0:
 * - anything under `/api/sync/` (pages, pushes, tombstones, manifest, merkle, meta, the governance relay);
 * - `GET` and `POST /api/files/:spaceId`: file sync's list, download and upload, which also ask the sync doors' reach and direction
 *   guards for a peer (`refusePeerFileDoor`);
 * - `POST /api/notify`: a member's notice.
 *
 * The invite handshake's proof (`/api/invite/apply`) reads its bearer itself and never resolves through the guards, so it is not here.
 * Imports nothing, so the auth middleware reaches it without a cycle.
 */

/** The file door's path: `/api/files/<one segment>`, the space, and nothing below it. */
const FILE_DOOR = /^\/api\/files\/[^/]+\/?$/;

/**
 * May a peer-bound token make this request? `path` is the request's path without its query (Express `req.path` as mounted at the app,
 * i.e. `originalUrl` cut at `?`).
 */
export function peerDoorAdmits(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (path === '/api/sync' || path.startsWith('/api/sync/')) return true;
  if (FILE_DOOR.test(path)) return m === 'GET' || m === 'HEAD' || m === 'POST';
  if (path === '/api/notify' || path === '/api/notify/') return m === 'POST';
  return false;
}

/** The refusal's code, for a client that branches on it. */
export const PEER_DOOR_CODE = 'peer_door';

/** The refusal's status: the token is authenticated and not permitted here (RFC 9110 15.5.4). */
export const PEER_DOOR_STATUS = 403;

/** The refusal's words: what the token is for, and what to use instead. */
export const PEER_DOOR_MESSAGE = 'This token is bound to a peer (a sync credential) and reaches only the sync doors: '
  + '/api/sync/*, the file door\'s list, download and upload, and POST /api/notify. Use an operator token.';
