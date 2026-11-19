/**
 * Was a media run cut short by, or did it meet throughout, an UNAVAILABLE embedder, so that its job waits for the embedder instead of spending an
 * attempt?
 *
 * ## What it prevents
 *
 * A run whose every embed met an unreachable embedder (or a status of the wait set, or an inference process that was lost before the request was
 * sent) was failed like a file that cannot be processed: three attempts in about two and a half minutes, then `failed`, shorter than a restart of
 * the embedder. The run now says so by throwing {@link EmbedderUnavailableForRun}, and the worker hands the job back (`job-queue.ts:handBackJob`).
 *
 * ## Only for the whole run, or a run cut short
 *
 * One busy answer for one passage of a long document is not this: the other passages are stored, and the file ends `partial` as before. Each
 * producer decides at the end of its run, from what it counted: a document when every passage failed and every failure was an unavailable embedder,
 * OR when it skipped any passage because the embedder already looked dead ({@link embedderLooksDead}), whatever a call still in flight brought back
 * afterwards: a run cut short never ends `partial` with passages it never sent, which nothing would retry. Audio, when at least one embed was
 * ATTEMPTED and every attempted one was unavailable (a silent chunk is no attempt, and a failed transcription is not the embedder's). An image's one
 * embed call reaches the worker unchanged, and {@link waitsForEmbedder} asks it of that failure directly. The hand-back limit bounds all of them.
 */
import { isEmbedderUnavailable } from '../../brain/embed-errors.js';

/**
 * A run cut short by an unavailable embedder, or one that met it for all of its embeds. Thrown by the producer that counted it; the worker asks
 * {@link waitsForEmbedder}.
 */
export class EmbedderUnavailableForRun extends Error {
  constructor(what: string, lastCause: string) {
    super(`The embedder was unavailable for ${what}; the file waits for it without spending an attempt. Last cause: ${lastCause}`);
    this.name = 'EmbedderUnavailableForRun';
  }
}

/** Does this failure of a run mean its job waits for the embedder: the run said so, or its one embed call met an unavailable embedder. */
export function waitsForEmbedder(failure: unknown): boolean {
  return failure instanceof EmbedderUnavailableForRun || isEmbedderUnavailable(failure);
}

/**
 * The tally of one run's embed calls, for a producer that makes many: what was attempted, what met an unavailable embedder, and the last such cause.
 * `deadAfter` says when to stop calling: as many unavailable failures as `limit` with nothing embedded, so a dead embedder is not called once per
 * passage, each a timeout.
 */
export interface EmbedTally {
  attempted: number;
  unavailable: number;
  embedded: number;
  lastCause: string;
}

export function newEmbedTally(): EmbedTally {
  return { attempted: 0, unavailable: 0, embedded: 0, lastCause: '' };
}

/** Count one embed call's outcome: `failure` undefined when it gave a vector. */
export function tallyEmbed(tally: EmbedTally, failure?: unknown): void {
  tally.attempted++;
  if (failure === undefined) { tally.embedded++; return; }
  if (isEmbedderUnavailable(failure)) {
    tally.unavailable++;
    tally.lastCause = failure instanceof Error ? failure.message : String(failure);
  }
}

/** Has this run met an unavailable embedder `limit` times with nothing embedded: the rest of it is not worth a call. */
export function embedderLooksDead(tally: EmbedTally, limit: number): boolean {
  return tally.embedded === 0 && tally.unavailable >= limit;
}

/** Was every attempted embed of this run an unavailable embedder, and at least one attempted. */
export function unavailableThroughout(tally: EmbedTally): boolean {
  return tally.attempted > 0 && tally.unavailable === tally.attempted;
}
