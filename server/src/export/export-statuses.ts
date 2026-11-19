/**
 * The HTTP statuses the exports of the `export_*` family answer (Q-750, Q-751), named once: every act and door of the family states a status
 * through these, so no status is a bare number at a site and a refusal's status reads as what it means. A leaf: it imports nothing.
 */
export const EXPORT_OK = 200;
export const EXPORT_BAD_REQUEST = 400;
export const EXPORT_FORBIDDEN = 403;
export const EXPORT_NOT_FOUND = 404;
export const EXPORT_NOT_ACCEPTABLE = 406;
export const EXPORT_CONFLICT = 409;
export const EXPORT_BUSY = 429;
export const EXPORT_UNAVAILABLE = 503;

/**
 * The `Vary` of every export answer, the same whatever the format: the answer is chosen by `Accept` and may be compressed by
 * `Accept-Encoding`. The compression layer adds `Accept-Encoding` only for the media types it compresses, so without this a cache would key
 * a TriG or N-Quads answer differently from a Turtle one (bundle-269 drive, finding 12).
 */
export const EXPORT_VARY = 'Accept, Accept-Encoding';
