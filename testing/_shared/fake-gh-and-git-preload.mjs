/**
 * `node --import <this file's URL> scripts/trade.mjs ...` runs the script against a fixture instead of GitHub and a real history:
 * every `gh` and the few `git` questions it asks are answered from a JSON file, and each call is written to a log.
 *
 * ## What it prevents
 *
 * `scripts/trade.mjs` reads Actions runs through `gh` and places their heads with `git`, both started by `execFileSync` with no
 * seam a child process can use: its `main` is not exported, and a fake `gh` on the PATH does not work on a machine where
 * `execFileSync('gh')` finds `gh.exe` only. A test of the CLI's exit codes, of what it sends to a Ythril instance and of the
 * environment its children get therefore needs the process boundary itself to be faked, once, here. Written per test file it
 * would be a second copy of "what does trade's gh say", and the copies would drift in the shape of a run.
 *
 * ## The contract (all of it comes from the environment of the child that loads this file)
 *
 * - `FAKE_GH_GIT_FIXTURE` the path of a JSON file: `{ listing, jobs, cutover, descends, unplaceable, budgetEndsAfterApiCalls }`.
 *   `listing` is what `gh run list --json databaseId,headBranch,headSha,createdAt,attempt` prints (cut to `-L`, as gh does);
 *   `jobs["<runId>/<attempt>"]` is what the attempts endpoint answers; `cutover` the one commit `git log` names (null: none);
 *   `descends` the heads that descend from it (every other head is a clean "no"); `unplaceable` the heads git cannot answer for;
 *   `budgetEndsAfterApiCalls` moves the clock ELEVEN MINUTES on after that many attempt reads, which is how a test reaches the
 *   script's ten-minute budget without waiting for it.
 * - `FAKE_GH_GIT_LOG` the path the calls are appended to, one JSON object per line: `{ file, args, inherited, envNames }`.
 *   `envNames` is the names of the environment the child would get: the `env` option when one was given, else this process's.
 * - A `gh` question the fixture does not know is thrown, naming it; a `git` question it does not know goes to the real git.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync, appendFileSync } from 'node:fs';

const fixturePath = process.env.FAKE_GH_GIT_FIXTURE;
const logPath = process.env.FAKE_GH_GIT_LOG;
if (!fixturePath || !logPath) throw new Error('fake-gh-and-git-preload: FAKE_GH_GIT_FIXTURE and FAKE_GH_GIT_LOG must name files');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const childProcess = createRequire(import.meta.url)('node:child_process');
const realExecFileSync = childProcess.execFileSync;
const realNow = Date.now;
let skewMs = 0;
let attemptReads = 0;
Date.now = () => realNow() + skewMs;

function fake(file, args = [], options = {}) {
  const env = options?.env;
  appendFileSync(logPath, `${JSON.stringify({ file, args, inherited: env === undefined, envNames: Object.keys(env ?? process.env) })}\n`);
  if (file === 'gh') {
    if (args[0] === 'run' && args[1] === 'list') {
      const limit = Number(args[args.indexOf('-L') + 1]);
      return JSON.stringify(fixture.listing.slice(0, limit));
    }
    const endpoint = args[0] === 'api' ? /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(args[1] ?? '') : null;
    if (endpoint) {
      const answer = fixture.jobs[`${endpoint[1]}/${endpoint[2]}`];
      if (!answer) throw new Error(`fake gh: the fixture holds no jobs for run ${endpoint[1]} attempt ${endpoint[2]}`);
      attemptReads += 1;
      if (fixture.budgetEndsAfterApiCalls !== undefined && attemptReads >= fixture.budgetEndsAfterApiCalls) skewMs = 11 * 60_000;
      return JSON.stringify(answer);
    }
    throw new Error(`fake gh: the fixture does not answer gh ${args.join(' ')}`);
  }
  if (file === 'git' && args[0] === 'log' && args.includes('origin/main')) return fixture.cutover ? `${fixture.cutover}\n` : '';
  if (file === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
    if ((fixture.unplaceable ?? []).includes(args[3])) throw Object.assign(new Error('fatal: bad object'), { status: 128 });
    if ((fixture.descends ?? []).includes(args[3])) return '';
    throw Object.assign(new Error('exit 1'), { status: 1 });
  }
  return realExecFileSync(file, args, options);
}

childProcess.execFileSync = fake;
syncBuiltinESMExports();
