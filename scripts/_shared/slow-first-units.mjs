/**
 * The slowest test files each run alone, and first (Q-869).
 *
 * ## The question it answers
 *
 * "In what units, and in what order, does a pool run these test files so the slowest ones start first and wait behind nothing?"
 * Asked by `scripts/preflight.mjs` for its pure standalone files, which the shared split's `offlineRuns` cuts into batches by the
 * length of their path text and which `runTestUnits` runs a few at a time.
 *
 * ## What it prevents
 *
 * The wall time of a pool is at least its slowest unit. A cut by path length knows no times, so one batch held the slowest file together
 * with its neighbours in name order and ran as long as all of them: measured over five CI runs the stage took 301 s where the slowest
 * single file takes 250 s. Each file the recorded times put at {@link SLOW_FILE_MS} or more is a unit of its own, slowest first, at the
 * front (at most `maxSlow` of them, so the units that run alone do not outnumber the workers); the other files stay in the batches they
 * were cut into, in their order, after them. Four ways this goes wrong are closed here, none left to the caller:
 *
 * - **A file lost or run twice.** The result is asserted to be a partition of the files the runs held, and the runs themselves to hold no
 *   file twice (checked before anything else, so a duplicate cannot hide as two units of one file).
 * - **A unit with no file.** `node --test` with no file runs node's own discovery, which is everything. A batch the slow files empty is
 *   dropped, and every unit is asserted non-empty.
 * - **A file the runs never held.** The times come from a snapshot written from records on an instance; a key in it that names no input
 *   file (a `@ci-only` file the preflight leaves out, a file that is gone) is never added to the plan. A time is read only from a key the
 *   snapshot holds itself, so `constructor` or `__proto__` is no time for a file of that name.
 * - **No times is not a failure.** With no times, none that is slow, or `maxSlow` 0, the units are exactly the input runs.
 *
 * Built-ins only.
 */

/** A file whose recorded time is at least this many milliseconds (15 s) is slow: it runs in a unit of its own. */
export const SLOW_FILE_MS = 15_000;

const ownTime = (times, file) => {
  const files = times?.files;
  if (typeof files !== 'object' || files === null || Array.isArray(files) || !Object.hasOwn(files, file)) return undefined;
  const ms = files[file];
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : undefined;
};

/**
 * @param {Array<{ files: string[], args?: string[] }>} runs the batches, in the order they run today (`offlineRuns`' pure runs)
 * @param {{ files?: Record<string, number> } | null | undefined} times the file-times snapshot (`readFileTimes(...).times`), or none
 * @param {{ maxSlow: number }} options the most slow files that become units of their own
 * @returns {Array<{ files: string[], args: string[], slow: boolean }>} the units in the order to run them: the slow files each alone,
 *   slowest first (`slow: true`), then the other batches in their order with the slow files taken out (`slow: false`)
 * @throws when the runs hold a file twice, or the result would not be the files exactly once each, none empty
 */
export function slowFirstUnits(runs, times, { maxSlow }) {
  if (!Number.isInteger(maxSlow) || maxSlow < 0) throw new TypeError(`slowFirstUnits: maxSlow must be a whole number of 0 or more, not ${String(maxSlow)}`);
  if (!Array.isArray(runs)) throw new TypeError('slowFirstUnits: the runs must be an array');

  const input = runs.flatMap(r => r.files);
  const seen = new Set();
  for (const f of input) {
    if (seen.has(f)) throw new Error(`slowFirstUnits: ${f} is in the runs more than once, so the units could not be a partition of the files`);
    seen.add(f);
  }

  const slowest = input
    .map((file, order) => ({ file, order, ms: ownTime(times, file) }))
    .filter(x => x.ms !== undefined && x.ms >= SLOW_FILE_MS)
    .sort((a, b) => b.ms - a.ms || a.order - b.order)
    .slice(0, maxSlow);
  const alone = new Set(slowest.map(x => x.file));
  const argsOf = new Map();
  for (const r of runs) for (const f of r.files) argsOf.set(f, r.args ?? []);

  const units = [
    ...slowest.map(x => ({ files: [x.file], args: [...argsOf.get(x.file)], slow: true })),
    ...runs.map(r => ({ files: r.files.filter(f => !alone.has(f)), args: [...(r.args ?? [])], slow: false })).filter(u => alone.size === 0 || u.files.length > 0),
  ];

  const out = units.flatMap(u => u.files);
  const placed = new Set(out);
  const lost = input.filter(f => !placed.has(f));
  if (units.some(u => u.files.length === 0) || out.length !== input.length || lost.length > 0) {
    throw new Error(`slowFirstUnits: the units are not a partition of the files given (${lost.length} file(s) lost, ${out.length} of ${input.length} in the units, an empty unit is ${units.some(u => u.files.length === 0)})`);
  }
  return units;
}
