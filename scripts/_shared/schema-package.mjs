/**
 * The schema package's own manifest, read once: its name, its version and its `exports` (Q-683, the bundle-225 diff pass).
 *
 * ## The question it answers
 *
 * "What is the workspace package that holds the space-schema vocabulary called, which version is it at, and which entries does it
 * export?" `scripts/publish-schema.mjs` publishes by this name and `testing/standalone/_relative-specifier.mjs` builds every gate's
 * specifier pattern from it, so neither spells the name and a rename follows the manifest.
 *
 * ## What it prevents
 *
 * Each side read `schema/package.json` and checked the name by hand. A copy that skipped the check would publish, or build a gate
 * pattern, from `undefined`: the publish would name no workspace, and a pattern built from an empty name matches nothing, so every
 * gate built on it passes about nothing. Here an unreadable manifest, or one that names no package, THROWS, never returns an empty
 * name.
 */
import { readFileSync } from 'node:fs';

/**
 * @returns {{ name: string, version: string | undefined, exports: Record<string, unknown> | undefined }}
 * @throws when `schema/package.json` is unreadable, is not JSON, or carries no `name`
 */
export function readSchemaPackage() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(new URL('../../schema/package.json', import.meta.url), 'utf8'));
  } catch (error) {
    throw new Error(`the schema package's manifest (schema/package.json) cannot be read, so its name is unknown: ${error.message}`);
  }
  if (typeof manifest?.name !== 'string' || !manifest.name) throw new Error('schema/package.json has no name: the schema package has no name to publish or build gates from');
  return { name: manifest.name, version: manifest.version, exports: manifest.exports };
}
