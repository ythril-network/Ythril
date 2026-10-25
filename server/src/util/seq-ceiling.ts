/**
 * The protocol sequence ceiling: the highest `seq` any document on the wire may carry.
 *
 * The one definition. The `Incoming*` schemas (`sync/incoming-schemas.ts`) validate against it (`<= 2^50`), and it had a
 * second copy in `api/sync/_shared.ts` until `Q-107`. A document at or above this cannot be represented, so it is never a
 * legitimate value on the wire. Kept within safe-integer arithmetic so a version can never round. Every position of the
 * clock band is above it (`util/position-clock.ts`).
 *
 * ## Why it is a module of its own
 *
 * It lived in `util/seq.ts`, which imports the store and the config loader. The schema leaf must load without a database
 * (`the-schema-leaf-imports-no-sync-machinery`), so the number moved to a module that imports nothing, and `util/seq.ts`
 * re-exports it. Keep it that way: an import added here is an import every schema consumer pays.
 */
export const MAX_SYNC_SEQ = 2 ** 50;
