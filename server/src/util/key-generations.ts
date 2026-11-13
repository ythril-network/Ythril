/**
 * A generation per key (a space id): a number that only moves forward, read by work before it starts and compared after it ends, so work that
 * began before a reset of its key does not write over what the reset cleared.
 *
 * ## The question it answers
 *
 * "Has this key been reset since I read its generation?" Three per-space counters asked it, each spelled by hand: the held-snapshot cache's
 * (`spaces/schema-stamp.ts`, moved by `forgetHeld`), a files sweep pass's (`files/sweep-pass.ts`, moved by a restart) and the file tombstones'
 * wipe (`files/tombstone-store.ts`). Each keeps what a reset of its own means; this module keeps only the counting.
 *
 * ## What it prevents
 *
 * A counter that goes back: a key never seen is generation 0, and {@link KeyGenerations.bump} only ever adds one, so work that read an older
 * generation never sees it again. Entries are never removed (one number per key ever bumped), so a key's generation cannot restart at 0.
 */
export class KeyGenerations {
  private readonly byKey = new Map<string, number>();

  /** The generation of `key`: 0 until it is first bumped. */
  of(key: string): number { return this.byKey.get(key) ?? 0; }

  /** Move each key of `keys` (one key, or a list) to its next generation: every work that began under an earlier one is stale. */
  bump(keys: string | readonly string[]): void {
    for (const key of typeof keys === 'string' ? [keys] : keys) this.byKey.set(key, this.of(key) + 1);
  }
}
