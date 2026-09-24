/**
 * The Schema Library entries the product ships, and which of them a library still lacks.
 *
 * `ingest` refuses a space that does not declare every type of the `conversation` group, and the way a space gets
 * them is the library's group apply. That only works if the entries ARE in the library — they were files in the
 * source tree that nothing loaded, so the refusal pointed at an apply with nothing to apply.
 *
 * Read from the build output (`scripts/copy-src-assets.mjs` puts them there), and a read that finds none THROWS:
 * an empty list would seed nothing, pass every check written over it, and leave ingest refusing every space.
 *
 * Seeding is by NAME and additive only. An operator who edited a shipped entry keeps the edit; one who deleted it
 * gets it back on the next start, because the extractor's contract is these types and a library without them
 * cannot run it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SchemaLibraryEntry } from './types.js';
import { getSchemaLibrary, saveSchemaLibrary } from './loader.js';

const SHIPPED_DIRS = [join(dirname(fileURLToPath(import.meta.url)), '..', 'extractor', 'conversation', 'schemas')];

let cached: SchemaLibraryEntry[] | undefined;

export function shippedLibraryEntries(): SchemaLibraryEntry[] {
  if (cached) return cached;
  const entries = SHIPPED_DIRS.flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.json')).sort()
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as SchemaLibraryEntry));
  if (entries.length === 0) throw new Error(`no shipped Schema Library entries under ${SHIPPED_DIRS.join(', ')} — the build did not copy them`);
  cached = entries;
  return entries;
}

/** The shipped entries whose name `library` does not hold. */
export function entriesMissingFrom(library: SchemaLibraryEntry[]): SchemaLibraryEntry[] {
  const held = new Set(library.map(e => e.name));
  return shippedLibraryEntries().filter(e => !held.has(e.name));
}

/** Add the missing shipped entries to this instance's library. Returns how many were added. */
export function seedShippedLibraryEntries(): number {
  const library = getSchemaLibrary();
  const missing = entriesMissingFrom(library);
  if (missing.length) saveSchemaLibrary([...library, ...missing]);
  return missing.length;
}
