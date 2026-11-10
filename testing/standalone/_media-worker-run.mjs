/**
 * Run the real media worker until one job ends, and when it does not, say why.
 *
 * ## What it prevents
 *
 * A worker wait that times out naming only the job row. `an-arrived-image-gets-faces-only-when-synced-images-are-reprocessed-db`
 * failed once in CI with `pending, attempts 0, claimedAt null` (Q-729): the job was never claimed, and nothing in the run said
 * whether the worker never reached a claim, skipped the space in quarantine, found the store down, or probed the space before
 * the job was claimable and stopped asking. The worker says each of those in its log, and the test's capture kept those lines
 * from the console and dropped them with the throw.
 *
 * So a timeout here carries the worker's lines from the run (every level, from the log ring) and the claim walk's view of the
 * space: whether it means to probe it before the next full scan, and which spaces sit in quarantine.
 *
 * The console is silenced while the worker runs, as `_log-lines.mjs` does; the lines are returned, so a case asks them what
 * happened instead of the report. `_log-lines.mjs` answers only once its function returns, which a failed wait never does.
 */
import { waitFor } from '../_shared/wait-for.mjs';

/** How many of the run's last log lines a timeout message carries. */
const LINES_IN_FAILURE = 80;

let mods;
async function load() {
  mods ??= {
    log: await import('../../server/dist/util/log.js'),
    queue: await import('../../server/dist/files/media/job-queue.js'),
    walk: await import('../../server/dist/util/housekeeping-walk.js'),
  };
  return mods;
}

/**
 * Start `worker`, wait until the job `id` of `space` has ended (`until`: the statuses that end it, or a predicate over the job
 * row), stop the worker, and return the job row and every log line emitted meanwhile. `whileRunning()` runs alongside the
 * worker and is awaited after the wait.
 *
 * @param {{ worker: { startMediaEmbeddingWorker(): void, stopMediaEmbeddingWorker(): void },
 *   jobOf: (id: string) => Promise<object | null>, space: string, id: string,
 *   until?: string[] | ((job: object | null) => boolean), timeoutMs?: number, whileRunning?: () => Promise<unknown> }} opts
 * @returns {Promise<{ job: object | null, lines: string[] }>}
 */
export async function runWorkerUntil({ worker, jobOf, space, id, until = ['complete', 'failed'], timeoutMs = 30_000, whileRunning }) {
  const { log, queue, walk } = await load();
  const lines = [];
  const stop = log.subscribeLogLines(l => lines.push(l));
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    worker.startMediaEmbeddingWorker();
    try {
      const running = whileRunning ? whileRunning() : Promise.resolve();
      const ended = typeof until === 'function' ? until : (job) => until.includes(job?.status);
      await waitFor(async () => ended(await jobOf(id)), timeoutMs, 100, async () =>
        `the worker never ended the job for ${space}/${id}: ${JSON.stringify(await jobOf(id))}; `
        + `claim walk: ${queue.mediaSpaceIsHinted(space) ? 'probes' : 'does not probe'} ${space} before the next full scan, `
        + `quarantined [${walk.quarantinedSpaces().join(', ')}]; the worker's log while it ran `
        + `(last ${Math.min(lines.length, LINES_IN_FAILURE)} of ${lines.length}):\n${lines.slice(-LINES_IN_FAILURE).join('\n')}`);
      await running;
    } finally {
      worker.stopMediaEmbeddingWorker();
    }
  } finally {
    Object.assign(console, saved);
    stop();
  }
  return { job: await jobOf(id), lines };
}
