/**
 * The one driver-internal file the server imports: the connection class, which the package does not export
 * (`abandoned-reply-guard.ts`, `Q-715`). The driver ships no types for it, so this says only what the guard reads.
 * `Connection` is typed as possibly absent on purpose: the guard checks for it and throws when an upgrade moved it.
 */
declare module 'mongodb/lib/cmap/connection.js' {
  export const Connection: { prototype: object } | undefined;
}
