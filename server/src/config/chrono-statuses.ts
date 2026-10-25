/**
 * The statuses a chrono entry may carry.
 *
 * A TUPLE, and the type below derives from it — because the five names were also written out as a `Set` in
 * `api/brain/chrono.ts` and again in `brain/bulk.ts`, and a fourth copy in the shared write-shape table got
 * two of them wrong. A union type cannot be iterated at run time, so every door that had to CHECK a status
 * built its own list from the same five words, and nothing compared them.
 */
export const CHRONO_STATUSES = ['upcoming', 'active', 'completed', 'overdue', 'cancelled'] as const;

/**
 * Defined here, in a module that imports nothing, and re-exported from `config/types.ts`: the `Incoming*` schema leaf (`sync/incoming-schemas.ts`) reads the list and
 * must load without the config loader and the store that `config/types.ts` reaches through its imports.
 */
