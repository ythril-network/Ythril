/**
 * Drive the absent-bytes sweep and read what it did — the question "what did the sweep stamp, remove, keep and say", answered once for
 * every test that asks it (bundle-70, Q-337, slice S4).
 *
 * ## Why a module
 *
 * Three suites ask about the sweep (what it removes, what the doors say of a record waiting for its bytes, what a byte writer does to the
 * stamp) and each needs the same things: the pass, the instants a pass runs at, a record whose bytes are gone, the seam that lands a
 * re-upload inside a pass, and the audit entry it wrote. The second suite that needed them was about to copy them, and the copy that
 * drifts is the one whose case passes for the wrong reason.
 *
 * ## The part a hand-written copy drops
 *
 * **The pass is run through `sweepExpired(now)` and nothing else** (as `_leaked-rows-repair.mjs` runs its repair): the sweep is a step of
 * the TTL sweep, so a test that called the sweep's own entry would pass for a step the sweep never runs.
 *
 * **`now` is a parameter, and time moves by passing a later `now`, never by waiting.** Removal takes TWO passes by the design: one
 * stamps and counts (the mass-loss hold is judged on the LAST COMPLETE pass), the next removes. {@link passesAt} runs passes at the
 * instants it is given, a day and a bit apart, which is also how far apart a scan may restart.
 *
 * **A record whose bytes are gone is a row with no file** ({@link orphan}); a record that is merely a row of a healthy space is
 * {@link present}. The healthy rows matter: a space whose every row is absent is held as a missing volume, so a case that expects a
 * removal needs at least as many present rows as absent ones (exactly half is not held).
 *
 * ## The contract this module assumes of the implementation
 *
 *  - the sweep is a step of `brain/ttl-sweep.ts`'s `sweepExpired(now)`;
 *  - it stamps the local row field `bytesAbsentSince` (an ISO string, the pass's `now`), and a retired row leaves a feed marker (or, with
 *    `softDeleteFileMeta`, the soft flag) carrying `retiredBy: 'bytes-lost'`; the file change feed answers it `{ deleted: true, reason: 'bytes_lost' }`;
 *  - `setAbsentBytesSweepStepsForTest(steps | null)` is exported by exactly one module of `server/dist`, with `steps.beforeRemove({ spaceId, paths })`
 *    (runs after the sweep decided a batch is due, its re-check done, and before the retire is issued: the interval a re-upload can land in),
 *    `steps.pageSize` and `steps.pagesPerTick`;
 *  - `FILES_ABSENT_BYTES_SWEEP_OPERATION` is exported by `audit/middleware.ts`: the audit entry of a batch that removed rows, one per space per pass,
 *    naming the paths it really retired.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { REPO_ROOT } from './_sources.mjs';

export const DAY = 86_400_000;
export const WAIT_DAYS = 30;
/** The instant the first pass runs at. */
export const NOW = new Date('2026-10-01T00:00:00.000Z');
/** `NOW` moved by `ms`. */
export const after = (ms) => new Date(NOW.getTime() + ms);
/** A row's own time stamps: older than every pass. */
export const OLD = '2026-06-01T00:00:00.000Z';
export const SHA_ORPHAN = 'ab'.repeat(32);
export const SHA_PRESENT = 'cd'.repeat(32);

/** Run one TTL sweep at `now`: the one entry the sweep is reached by. */
export async function runPass(now = NOW) {
  const ttl = await import('../../server/dist/brain/ttl-sweep.js');
  return ttl.sweepExpired(now);
}
/** Run a pass at each instant, in order. The first stamps and counts; the later ones may remove. */
export async function passesAt(...instants) {
  for (const t of instants) await runPass(t);
}
/** The instants of the usual removal: stamp at NOW, then a day and a bit later, then the next day (a scan restarts no sooner than a day). */
export const THE_TWO_PASSES = Object.freeze([NOW, after(DAY + 3_600_000)]);

/** Where `setAbsentBytesSweepStepsForTest` is exported, found in the built server: a test may not know which module the sweep lives in. */
export function sweepSeamFiles() {
  const root = path.join(REPO_ROOT, 'server', 'dist');
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /export\s+(?:async\s+)?function\s+setAbsentBytesSweepStepsForTest\b/.test(fs.readFileSync(full, 'utf8'))) found.push(full);
    }
  };
  walk(root);
  return found;
}
/** The seam of the sweep, or the plain failure that it has none. */
export async function sweepSteps() {
  const files = sweepSeamFiles();
  assert.equal(files.length, 1, `exactly one module of server/dist must export setAbsentBytesSweepStepsForTest (the step seam of the absent-bytes sweep: beforeRemove, pageSize, pagesPerTick); found ${files.length}`);
  const mod = await import(`file://${files[0].split(path.sep).join('/')}`);
  return mod.setAbsentBytesSweepStepsForTest;
}
/** Put the real behaviour back, whether or not the seam exists. */
export async function resetSweepSteps() { (await sweepSteps().catch(() => null))?.(null); }

/** The operation the sweep's audit entry names, read from the build. */
export async function sweepOperation() {
  const m = await import('../../server/dist/audit/middleware.js');
  assert.equal(typeof m.FILES_ABSENT_BYTES_SWEEP_OPERATION, 'string', 'audit/middleware.ts exports no FILES_ABSENT_BYTES_SWEEP_OPERATION (the operation of the absent-bytes sweep\'s audit entry)');
  return m.FILES_ABSENT_BYTES_SWEEP_OPERATION;
}

/** A top-level file row as an upload leaves it, in `space`. */
export const fileRow = (space, p, extra = {}) =>
  ({ _id: p, spaceId: space, path: p, tags: [], sizeBytes: 12, createdAt: OLD, updatedAt: OLD, seq: 1, ...extra });
/** A record whose bytes are gone: a row and no file. */
export const orphan = (space, p, extra = {}) => fileRow(space, p, { sha256: SHA_ORPHAN, ...extra });

/** Whether `row` is gone as a file: no row, or exactly a feed marker, or (soft delete) a flagged row. */
export const retired = (row) => row === null || row.feedMarker === true || row.deletedAt !== undefined;
