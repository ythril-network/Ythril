/**
 * What a CI run's timing files SAY — read whole, or refused.
 *
 * ## The question it answers
 *
 * "Give me every test event this run reported." Two checks of the aggregator ask it: `scripts/executed-tests.mjs` (which
 * tracked test file produced no event) and `scripts/unexpected-skips.mjs` (which event was a skip nobody expected). Both
 * read the same folder of `*.jsonl` files the timing reporter wrote (`testing/_shared/timing-reporter.mjs`), and both
 * would be wrong in the same way if the folder were not whole.
 *
 * ## What it prevents
 *
 * A reader that returns what it could parse is a reader that reports on part of a run as if it were the run. A results
 * folder that does not exist, one with no `*.jsonl`, one whose file lost its closing sentinel (a cut-off job, a torn
 * line), and one in which no test reported an event are each a run these checks cannot speak for, so each THROWS with
 * the cause — never returns `[]`. The caller maps a throw to exit 2 (the derivation failed), which is a different
 * answer from exit 1 (files named): "nobody knows" must not read as "nothing found" or as "something found".
 *
 * The guard is in here so that a caller cannot drop it; it looks like boilerplate from the outside.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readTimingLog } from '../../testing/_shared/timing-reporter.mjs';

/**
 * Every data line of every `*.jsonl` in `dir`, the sentinels left out.
 *
 * @param {string} dir
 * @returns {{ lines: object[], logs: number, events: number }} `events` counts the lines of `type: 'test'` naming a file
 * @throws when `dir` is missing, holds no results, holds an incomplete file, or holds no test event at all
 */
export function readTimingResults(dir) {
  if (!existsSync(dir)) throw new Error(`the results directory ${dir} does not exist — nothing ran, or nothing was kept`);
  const names = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  if (names.length === 0) throw new Error(`no *.jsonl results in ${dir}. An empty run is not a clean one`);
  const lines = [];
  const incomplete = [];
  for (const name of names) {
    const log = readTimingLog(readFileSync(join(dir, name), 'utf8'));
    if (!log.complete) { incomplete.push(name); continue; }
    lines.push(...log.lines);
  }
  if (incomplete.length > 0) {
    throw new Error(`incomplete results (no closing sentinel, a torn line, or a count that does not match): ${incomplete.join(', ')}. `
      + 'A cut-off run cannot say what it ran, so it is not read as a run that ran nothing, or nothing unexpected.');
  }
  const events = lines.filter(l => l.type === 'test' && typeof l.file === 'string' && l.file !== '').length;
  if (events === 0) throw new Error(`${names.length} results file(s) in ${dir} hold no test event at all — an empty run is not a clean one`);
  return { lines, logs: names.length, events };
}
