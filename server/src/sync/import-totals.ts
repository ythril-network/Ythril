/**
 * What a whole import came to, every family together: the counts an import's audit row carries (`ImportTotals`), apart from the import itself.
 *
 * ## What it prevents
 *
 * **The audit allowlist drawing the importer into the server's largest import cycle.** `audit/audit-changes.ts` holds its list of import totals
 * to this shape at compile time, so a new total cannot miss the allowlist. When the shape lived in `sync/space-import.ts`, that type-only import made
 * the allowlist reach the whole importer (the arrival writer, the file repairs, the snapshot import) and back, so every tool module that records audit
 * changes, and a dozen modules besides, sat in the cycle whose size `check-i-architecture-dependency-direction` holds to a ceiling that only goes down.
 * This module imports nothing, so naming the shape costs nothing. `sync/space-import.ts` builds the totals (`importTotals`) and re-exports the type
 * for its own readers.
 */

/** What a whole import came to, every family together: the counts its audit row carries, never an id or a name. */
export interface ImportTotals {
  inserted: number;
  updated: number;
  refused: number;
  deletedOnRestore: number;
  due: number;
  /** Snapshot rows the import inserted, and elements it skipped; present when the result says what it did with snapshots. */
  snapshotsLanded?: number;
  snapshotsRefused?: number;
  /** Array keys of the body not read (the answer's `unknownKeysTotal`); present when the result counts them. Named apart from it because an audit field name must not read as a credential. */
  unreadArraysTotal?: number;
}
