/**
 * A test run's summary as markdown — the page the advisory job of CI shows, and what `test-times.mjs --summary` prints.
 *
 * ## The question it answers
 *
 * "Given what a run measured, what does a person want to read?" Pure: figures in, text out. Reading the results, counting
 * and talking to GitHub are `scripts/test-times.mjs`'s; none of it is here, so the page cannot disagree with the recorder
 * about a count (it is handed the recorder's own).
 *
 * ## What it shows, and why each part
 *
 *  - **A row per suite**, with `outcome`: a suite whose results were cut off says `incomplete`, never `passed`.
 *  - **The slowest files and tests**: where the minutes went.
 *  - **Every skip with its reason**, the ones CI did not expect marked `UNEXPECTED` — the same verdict the aggregator
 *    gives, so the page and the gate cannot tell two stories.
 *  - **The failures** with the first line of their message.
 *  - **The baseline**: files and suites slower than the last runs of main, or one line saying why there is no baseline.
 *    A baseline that could not be read is a line here, never a missing page.
 */

/** A duration as the run's pages and the trend print it: `12.3 s`. One spelling, so a figure reads alike on every page. */
export const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
/** A table cell: no pipe or newline may break the row. */
const cell = (v) => String(v ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const row = (...cells) => `| ${cells.map(cell).join(' | ')} |`;
const table = (head, rows) => [row(...head), row(...head.map(() => '---')), ...rows.map(r => row(...r))].join('\n');
const code = (v) => `\`${String(v).replace(/`/g, "'")}\``;

/**
 * @typedef {{ file: string, test: string, reason: string, expected: boolean }} Skip
 * @typedef {{ suite: string, tests: number, passed: number, failed: number, skipped: number, files: number, ms: number,
 *   wallMs?: number, outcome: string, fileTimes: Array<{ file: string, ms: number }>,
 *   slowestTests: Array<{ file: string, test: string, ms: number }>, skips: Skip[],
 *   failures: Array<{ file: string, test: string, message: string|null }> }} SuiteFigures
 */

/**
 * @param {object} p
 * @param {SuiteFigures[]} p.suites
 * @param {{ passed: number, failed: number, tests: number, skips: Skip[] }|null} [p.client] null when there is no client report
 * @param {string} [p.clientNote] why there is none
 * @param {string[]} p.baseline lines about the baseline: flags, or why there is none
 * @param {number} [p.top] how many of the slowest to list
 */
export function renderRunSummary({ suites, client = null, clientNote = '', baseline, top = 10 }) {
  const out = ['## Test run summary', ''];
  const rows = suites.map(s => [s.suite, s.tests, s.passed, s.failed, s.skipped, s.files, seconds(s.ms),
    s.wallMs === undefined ? '' : seconds(s.wallMs), s.outcome]);
  if (client) rows.push(['client', client.tests, client.passed, client.failed, client.skips.length, '', '', '', client.failed ? 'failed' : 'passed']);
  out.push(table(['suite', 'tests', 'passed', 'failed', 'skipped', 'files', 'test time', 'wall', 'outcome'], rows));
  if (!client && clientNote) out.push('', `Client results: ${clientNote}`);

  const files = suites.flatMap(s => s.fileTimes.map(f => ({ suite: s.suite, ...f }))).sort((a, b) => b.ms - a.ms).slice(0, top);
  if (files.length) out.push('', '### Slowest files', '', table(['file', 'suite', 'time'], files.map(f => [code(f.file), f.suite, seconds(f.ms)])));
  const tests = suites.flatMap(s => s.slowestTests.map(t => ({ suite: s.suite, ...t }))).sort((a, b) => b.ms - a.ms).slice(0, top);
  if (tests.length) out.push('', '### Slowest tests', '', table(['test', 'file', 'suite', 'time'], tests.map(t => [t.test, code(t.file), t.suite, seconds(t.ms)])));

  const skips = [...suites.flatMap(s => s.skips), ...(client?.skips ?? [])];
  out.push('', '### Skips', '');
  if (!skips.length) out.push('None.');
  for (const k of skips) {
    out.push(`- ${code(k.file)} — ${JSON.stringify(k.test)}: ${k.reason === '' ? '(no reason given)' : k.reason}${k.expected ? ' (expected on CI)' : ' **UNEXPECTED**'}`);
  }

  const failures = suites.flatMap(s => s.failures);
  if (failures.length) {
    out.push('', '### Failures', '');
    for (const f of failures) out.push(`- ${code(f.file)} — ${JSON.stringify(f.test)}${f.message ? `: ${f.message}` : ''}`);
  }

  out.push('', '### Against the last runs of main', '', ...baseline.map(l => `- ${l}`));
  return `${out.join('\n')}\n`;
}
