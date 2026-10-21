import { getConfig, isConfigLoaded } from '../config/loader.js';
import type { SpaceConfig } from '../config/types.js';

/**
 * The configured spaces, as a fresh array: every entry of `config.spaces`, and nothing else.
 *
 * ## Why this exists (`Q-98`, kept by Q-531)
 *
 * *"For each configured space"* was written by hand at every sweep, scanner, prune and metrics collector, and about half of those had their
 * own `try { getConfig() } catch` for the pre-setup case. Before 6.0 the list also had to skip proxy spaces, which own no collections; a
 * proxy is a personal view now and is never in `config.spaces`, so every entry here owns collections and the skip is gone. What stays is
 * what a hand-written copy dropped:
 *
 *   - **Pre-setup is an empty list**, answered here once. Only the not-loaded case: any other failure of the config still throws, because
 *     an empty answer where there should have been an error moves the bug.
 *   - **A snapshot.** The array is new, so a reload during the caller's awaits cannot change what it walks. The SpaceConfig objects in it are
 *     the live ones and become detached by a reload: read them freely, but a caller that WRITES a space's config re-resolves it by id inside
 *     the write, as `renameSpace` does.
 */
export function configuredSpaces(): SpaceConfig[] {
  if (!isConfigLoaded()) return [];
  return [...getConfig().spaces];
}

/** The ids of {@link configuredSpaces}, in its order, as a fresh array: for a walk that needs only the ids. */
export function configuredSpaceIds(): string[] {
  return configuredSpaces().map(s => s.id);
}

/** Get the SpaceConfig for a given id, or undefined. */
export function findSpace(spaceId: string): SpaceConfig | undefined {
  return getConfig().spaces.find(s => s.id === spaceId);
}

/**
 * Whether a space enforces that a reference field actually contains record IDs.
 *
 * **Defaults to ON** - absent means strict. It used to default off, which meant the safe behaviour was the one nobody opted into: a name
 * (or a typo, or an id from another space) landed in `entityIds` unvalidated, the write returned success, and the missing link only
 * surfaced later as a traversal that quietly returned nothing.
 *
 * The opt-out survives for the case that justified it: importing records whose targets do not exist yet, where refs are resolved in a later
 * pass. Turning it off is a deliberate, per-space choice to accept dangling references - not something you get by saying nothing.
 */
export function isStrictLinkage(spaceId: string): boolean {
  return findSpace(spaceId)?.meta?.strictLinkage !== false;
}
