/**
 * Every network type the server has, read out of the registry, with the floor built in.
 *
 * ## What it answers
 *
 * *"Which network types exist?"* — read from `export type NetworkType = …` in `server/src/config/types-networks.ts`,
 * because there is no runtime list of them and a gate that keeps its own is one new type behind. A table written
 * over this set covers a sixth type the day it is added.
 *
 * ## What it prevents
 *
 * An empty parse passes every loop written over it, so it throws when the declaration has moved or changed shape
 * rather than returning `[]`, and it asserts the directional pair is still inside the registry (a rename of
 * `pubsub` would otherwise leave every table asking about a type that no longer exists).
 *
 * `DIRECTIONAL_TYPES` is the owner's word for the two types with a position above this instance (a subscriber has a
 * publisher, a tree node a parent). It is a fixed pair on purpose: it is the oracle the truth tables are written
 * against, so it must not be derived from the code the tables test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';

export const DIRECTIONAL_TYPES = Object.freeze(['pubsub', 'braintree']);

export const NETWORK_TYPES = (() => {
  const src = readFileSync(join(REPO_ROOT, 'server/src/config/types-networks.ts'), 'utf8');
  const m = /export type NetworkType\s*=\s*([^;]+);/.exec(src);
  if (!m) throw new Error('NetworkType is no longer an `export type NetworkType = …;` union in config/types-networks.ts');
  const types = [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]);
  if (types.length < 5) throw new Error(`read only ${types.length} network types out of types-networks.ts: ${types}`);
  for (const d of DIRECTIONAL_TYPES) {
    if (!types.includes(d)) throw new Error(`the directional type '${d}' is not in the registry any more — the tables built over it are stale`);
  }
  return Object.freeze(types);
})();

export const NON_DIRECTIONAL_TYPES = Object.freeze(NETWORK_TYPES.filter(t => !DIRECTIONAL_TYPES.includes(t)));
