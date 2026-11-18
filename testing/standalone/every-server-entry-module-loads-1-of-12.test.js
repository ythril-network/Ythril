/**
 * Every module of the server loads when it is the FIRST module a process imports (Q-624, design rev 4 section 2, section 16 test 19). Shard 1.
 *
 * ## The defect this prevents
 *
 * A static import cycle is harmless until a module reads a binding of the other while it is being evaluated, and whether it does depends on
 * which module the process imported first. A cycle through the space hash and the planner failed all 271 entry modules with a
 * temporal-dead-zone error (the Q-624 revision 2 probe), and not one existing test imports a module as its own entry: they all import
 * the one module under test, in a process that has often loaded half the server already. `no-runtime-import-cycles` finds the cycle in
 * the source graph; this finds what a cycle does, because a cycle that survives erasure and is never read at load is not a defect and a
 * check for cycles alone cannot tell.
 *
 * ## What it does
 *
 * Every built module that has a source in `server/src` (derived from the tracked tree, never listed) is imported in a FRESH node process,
 * as that process's only import, with a time bound. A load error or a hang is a finding, with the first line of the error.
 *
 * ## One gate, `SHARDS` files (Q-871)
 *
 * The whole tree in one file took 120 to 204 s on CI, past the 60 s a file may take. The modules are cut into `SHARDS` files by one function of the sorted
 * list (`shardOf`, `_entry-module-load.mjs`), each file loads its slice with half the CPUs as children (`childWidth`) so the shards a batch starts
 * together do not overload the runner, and the children share a compile cache for the run. The cases of a shard are `_entry-module-shard-cases.mjs`'s;
 * this file, the one with index 0, also holds the cases about the whole tree (the loader suite, the floor, the exemption check). That the slices are
 * the whole list, with no overlap, is `an-entry-module-load-finds-a-hang-and-the-shards-partition-the-modules.test.js`'s.
 *
 * ## The one exemption, with its reason
 *
 * A module that is a process's own program and refuses to be imported (`brain/embed-process.ts` is started by the server over an IPC
 * channel and exits when it has none). A stale entry fails, and an entry that loads now fails too: an exemption outlives nothing.
 *
 * ## Red on the unchanged code
 *
 * It loads on b857da8f, which is the point: it is the guard for the change that moves the schemas and the hash into two leaves. What is red
 * there is the floor of what it must cover, `sync/incoming-schemas` and `sync/authored-content`, which do not exist yet. Seen red by hand
 * for the load rule (put back by hand): a `throw` added at the top of one built module, and an import cycle with a top-level read.
 *
 * ## Where it runs, and why (parent decision, 2026-10-25)
 *
 * A process per module, so it is CI-only: preflight's pure batches skip it, CI's `standalone-pure` job runs it. Run beside the other 600 pure files on a loaded
 * machine the whole gate exceeded its own 30 s per-module bound and reported a load failure that was not one. A cycle itself is still found at every push by
 * `no-runtime-import-cycles` (the source graph); this finds what a cycle does at load.
 *
 * @ci-only
 *
 * Run: node --test testing/standalone/every-server-entry-module-loads-1-of-12.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import { availableParallelism } from 'node:os';
import { entryModules, shardOf, childWidth, SHARDS } from './_entry-module-load.mjs';
import { shardCases } from './_entry-module-shard-cases.mjs';

const SHARD = 0;
describe(`every server module loads as the first import of a process: shard ${SHARD + 1} of ${SHARDS}`, () => {
  for (const { name, options, run } of shardCases({ index: SHARD, modules: shardOf(entryModules(), SHARD, SHARDS), parallel: childWidth(availableParallelism()) })) it(name, options, run);
});
