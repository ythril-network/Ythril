/**
 * `npm run test:all:core` — the whole local run: the three stack suites, then the standalone suite, EVERY one run,
 * and each one's status reported (bundle-56).
 *
 * ## What it prevents
 *
 * The script was `npm run test:integration && npm run test:sync && npm run test:redteam && npm run test:standalone`.
 * `&&` stops at the first failure, so a red integration suite hid whether sync, red-team and standalone were red
 * too, and the answer to "what is broken" took one full run per suite. Here every suite runs, a summary line
 * names each one's status, and the exit status is non-zero when any was.
 *
 * Each suite is its own npm script, so what a suite MEANS stays in one place (`package.json`), and this file
 * only sequences them. Needs the test stack up, like the suites themselves.
 */
import { spawnSync } from 'node:child_process';

/** In the order the suites have always run. */
const SCRIPTS = ['test:integration', 'test:sync', 'test:redteam', 'test:standalone'];

const results = [];
for (const script of SCRIPTS) {
  console.log(`\n=== npm run ${script} ===`);
  const r = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: true, env: process.env });
  const status = r.error ? 1 : (r.status ?? 1);
  if (r.error) console.error(`${script} did not run: ${r.error.message}`);
  results.push({ script, status });
}

console.log('\n=== test:all:core ===');
for (const { script, status } of results) console.log(`  ${status === 0 ? 'ok    ' : 'FAILED'}  ${script}${status === 0 ? '' : ` (exit ${status})`}`);
const failed = results.filter(r => r.status !== 0);
if (failed.length > 0) {
  console.error(`test:all:core: ${failed.length} of ${results.length} suite(s) failed`);
  process.exit(1);
}
