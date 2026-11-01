/**
 * The act whose work is running now, carried by the async context rather than by an argument (bundle-40 R1 as amended by 2R3).
 *
 * ## What it prevents
 *
 * A body that writes its own space passes its entry id to the write gate (`except`), so the act's own writes pass while every other act of the
 * space still refuses them. An import lands its pages through the arrival writer, the embed queue and the file-meta writer, and threading an
 * `except` through every gate call those reach is thirty-odd sites, each of which a later change could forget - and a forgotten one refuses
 * the import's own write with the import's own `space_being_imported`. Here the runner sets the scope once around a body
 * ({@link withinSpaceActScope}) and the gate reads it ({@link spaceActInScope}); an explicit `except` still wins.
 *
 * A leaf module: the gate is imported by every writer and the runner by the gate, so neither may import the other for this.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<string>();

/** Run `body` as the work of act entry `entryId`: a write gate it reaches lets that act's own writes pass. */
export function withinSpaceActScope<T>(entryId: string, body: () => Promise<T>): Promise<T> {
  return scope.run(entryId, body);
}

/** The act entry whose work is running in this async context, or undefined outside every act's body. */
export function spaceActInScope(): string | undefined {
  return scope.getStore();
}
