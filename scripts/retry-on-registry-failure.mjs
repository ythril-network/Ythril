/**
 * Run a command again when the REGISTRY did not answer, and only then: `node scripts/retry-on-registry-failure.mjs -- docker pull <image>`
 * (Q-145).
 *
 * ## Why this exists
 *
 * PR #1450, run 36529590490 (2026-09-29): `Build & Test` failed in `Set up Docker Buildx` with
 * `Get https://registry-1.docker.io/v2/: context deadline exceeded` before any test ran, and the rerun passed the same step. Every
 * pull of a CI run (the BuildKit image, the stack's database image, the base images of a build) goes to Docker Hub, and one
 * answer that does not come fails the run for a reason that has nothing to do with the change. This wraps those commands:
 * a bounded number of attempts, a longer wait before each, and nothing else retried.
 *
 * ## What it prevents
 *
 * - A retry that hides a real failure. A failure is run again only when its output says the registry (or the way to it) did not
 *   answer: a timeout, a reset, a 5xx, a rate limit, a name that did not resolve. `manifest unknown`, `denied`, `unauthorized`
 *   and a failing build step are returned at once with the command's own exit status: a wrong digest must fail on the first
 *   attempt, not after three. This is not the retry the install steps decline (the CUDA download in `ci.yml`): that one hid a
 *   dependency on a host nothing here could use, this one meets a host the run cannot do without.
 * - A retry with no end. The bound is `attempts` (default 3), the waits grow (`delay`, then four times it, ...) and add to well under
 *   five minutes for the defaults; a registry that is down stays a failure, with the last attempt's own output and status.
 * - A swallowed log. The command's output is passed through as it is printed, and each retry says so on stderr, once, naming the
 *   attempt, so the run's log shows that the registry hiccuped and the step did not.
 *
 * ## The command line
 *
 * `node scripts/retry-on-registry-failure.mjs [--attempts <n>] [--delay-seconds <n>] -- <command> [args...]` exits with the
 * command's own status; 2 when the line itself is wrong (no `--`, nothing after it, a flag it does not know, a bound that is not a
 * number). The command is run with an argument array and no shell.
 */
import { spawn } from 'node:child_process';
import { isEntryPoint, readFlags } from './_shared/script-cli.mjs';

/** The default bound on attempts, including the first. */
export const DEFAULT_ATTEMPTS = 3;
/** The default wait before the second attempt, in seconds; each later wait is four times the one before. */
export const DEFAULT_DELAY_SECONDS = 10;
/** The longest a single wait may be, in seconds: a long bound is a hung step, not a patient one. */
const MAX_WAIT_SECONDS = 120;
/** How much of a command's output is kept to decide on, in characters (the end of it: that is where a failure is printed). */
const KEEP = 16 * 1024;

/**
 * What a registry, or the way to it, prints when it did not answer. Each row is a text docker, containerd or buildx really prints.
 * Matched on the output of a FAILED command only; a pattern here is one more case in which a failure is run again, so a pattern
 * that is also part of a permanent failure's text (a bare `not found`) does not belong.
 */
const TRANSIENT = [
  /context deadline exceeded/i,
  /Client\.Timeout exceeded/i,
  /TLS handshake timeout/i,
  /i\/o timeout/i,
  /connection reset by peer/i,
  /connection refused/i,
  /\bunexpected EOF\b/i,
  /received unexpected HTTP status: 5\d\d/i,
  /\b(?:502|503|504)\s+(?:Bad Gateway|Service Unavailable|Gateway Time-?out)/i,
  /toomanyrequests/i,
  /\b429 Too Many Requests/i,
  /no such host/i,
  /server misbehaving/i,
  /temporary failure in name resolution/i,
  /net\/http: request canceled/i,
];

/** Does this output of a failed command say the registry did not answer? */
export function isRegistryTransient(output) {
  const text = String(output ?? '');
  return TRANSIENT.some((re) => re.test(text));
}

/** The seconds to wait after attempt `n` (1-based): `delay`, then four times it, and so on, never more than the cap. */
const waitAfter = (n, delay) => Math.min(MAX_WAIT_SECONDS, delay * 4 ** (n - 1));

/**
 * Run `command args` until it succeeds, fails for a reason that is not the registry's, or the attempts are used.
 *
 * @param {object} p
 * @param {string} p.command
 * @param {string[]} p.args
 * @param {number} [p.attempts]       whole number of at least 1, the first attempt included
 * @param {number} [p.delay]          seconds before the second attempt
 * @param {(command: string, args: string[]) => Promise<{ status: number, output: string }>} [p.run]
 * @param {(seconds: number) => Promise<void>} [p.sleep]
 * @param {(line: string) => void} [p.log]  where the "retrying" line goes
 * @returns {Promise<number>} the exit status of the last attempt
 */
export async function retryOnRegistryFailure({ command, args = [], attempts = DEFAULT_ATTEMPTS, delay = DEFAULT_DELAY_SECONDS, run = runPassingOutput, sleep = sleepSeconds, log = (l) => process.stderr.write(`${l}\n`) }) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error(`attempts must be a whole number of at least 1, got ${JSON.stringify(attempts)}`);
  if (typeof command !== 'string' || command === '') throw new Error('command is empty: there is nothing to run');
  if (typeof delay !== 'number' || !(delay >= 0)) throw new Error(`delay must be a number of seconds, got ${JSON.stringify(delay)}`);
  let last = { status: 1, output: '' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await run(command, args);
    if (last.status === 0) return 0;
    if (!isRegistryTransient(last.output) || attempt === attempts) break;
    const wait = waitAfter(attempt, delay);
    log(`retry-on-registry-failure: attempt ${attempt} of ${attempts} failed, the registry did not answer; waiting ${wait} s: ${command} ${args.join(' ')}`);
    // waits-differently: a production backoff between two attempts of a command, not a test waiting for a condition.
    await sleep(wait);
  }
  return last.status === 0 ? 1 : last.status;
}

// waits-differently: a production backoff before the next attempt of a command; what it waits for is time, for the registry to recover.
const sleepSeconds = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));

/** The real run: the command's output is passed through as it is printed, and its last `KEEP` characters kept to decide on. */
function runPassingOutput(command, args) {
  return new Promise((resolve) => {
    let tail = '';
    const keep = (chunk) => { tail = (tail + chunk.toString('utf8')).slice(-KEEP); };
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => { process.stdout.write(c); keep(c); });
    child.stderr.on('data', (c) => { process.stderr.write(c); keep(c); });
    child.on('error', (e) => resolve({ status: 127, output: `retry-on-registry-failure: could not start ${command}: ${e.message}` }));
    child.on('close', (code) => resolve({ status: code ?? 1, output: tail }));
  });
}

/** The command line, parsed: `{ attempts, delay, command, args }` or `{ error }`. */
export function parseCommandLine(argv) {
  const split = argv.indexOf('--');
  if (split < 0) return { error: 'no `--`: the command to run goes after it' };
  const rest = argv.slice(split + 1);
  if (rest.length === 0) return { error: 'nothing after `--`: there is no command to run' };
  const { values, stray } = readFlags(argv.slice(0, split), ['--attempts', '--delay-seconds']);
  if (stray.length > 0) return { error: `not understood before \`--\`: ${stray.join(' ')}` };
  const number = (flag, fallback) => (values[flag] === undefined ? fallback : /^\d+$/.test(values[flag]) ? Number(values[flag]) : NaN);
  const attempts = number('--attempts', DEFAULT_ATTEMPTS);
  const delay = number('--delay-seconds', DEFAULT_DELAY_SECONDS);
  if (!Number.isInteger(attempts) || attempts < 1) return { error: `--attempts is a whole number of at least 1, got ${values['--attempts']}` };
  if (!Number.isInteger(delay)) return { error: `--delay-seconds is a whole number of seconds, got ${values['--delay-seconds']}` };
  return { attempts, delay, command: rest[0], args: rest.slice(1) };
}

if (isEntryPoint(import.meta.url)) {
  const parsed = parseCommandLine(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`retry-on-registry-failure: ${parsed.error}\nusage: node scripts/retry-on-registry-failure.mjs [--attempts <n>] [--delay-seconds <n>] -- <command> [args...]\n`);
    process.exit(2);
  }
  process.exit(await retryOnRegistryFailure(parsed));
}
