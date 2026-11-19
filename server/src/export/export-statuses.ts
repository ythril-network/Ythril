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
