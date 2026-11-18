/**
 * Every module of the server loads when it is the FIRST module a process imports. Shard 11.
 *
 * What the gate prevents, why it is cut into shards and why it runs in CI only are in `every-server-entry-module-loads-1-of-12.test.js`; the cases of a
 * shard are `_entry-module-shard-cases.mjs`'s and the cut is `shardOf` in `_entry-module-load.mjs`. This file says which slice it loads.
 *
 * @ci-only
 *
 * Run: node --test testing/standalone/every-server-entry-module-loads-11-of-12.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import { availableParallelism } from 'node:os';
import { entryModules, shardOf, childWidth, SHARDS } from './_entry-module-load.mjs';
import { shardCases } from './_entry-module-shard-cases.mjs';

const SHARD = 10;
describe(`every server module loads as the first import of a process: shard ${SHARD + 1} of ${SHARDS}`, () => {
  for (const { name, options, run } of shardCases({ index: SHARD, modules: shardOf(entryModules(), SHARD, SHARDS), parallel: childWidth(availableParallelism()) })) it(name, options, run);
});
