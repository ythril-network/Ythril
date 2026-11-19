/**
 * The media worker's claim, held while the embedder is known to be unavailable.
 *
 * ## What it prevents
 *
 * A media job whose run found the embedder unavailable for the whole of it is handed back without spending an attempt, and without a cap on how
 * long it may wait (`job-queue.ts:handBackJob`). Without this gate the worker would claim every queued file in turn during an outage, and each
 * claim pays for its vision, speech-to-text or conversion work before it meets the embedder again. So a hand-back starts a pause, and the claim
 * claims nothing while it runs. When it has run out, the claim first PROBES the embedder with one short embed call: an answer ends the outage and
 * the claim goes on; an unavailable embedder starts the next, longer pause, and nothing is claimed. For the whole of an outage the cost is one
 * small embed call per pause step.
 *
 * ## What counts as an answer
 *
 * A vector, or a failure whose verdict (`classifyEmbedFailure`) is `record` or `ends`: the embedder spoke, and what it said is the request's or
 * the record's business. An `outage` (proven or by words) or a `lost` verdict is no answer: a probe lost with the inference process says nothing
 * about the next call.
 *
 * ## Its own pause
 *
 * The pause is a second instance of `createEmbedderOutagePause`, never the embed worker's: that one's ending is pinned to an embed that worked, and
 * a media run that never called the embedder must not end it, nor a stop of the media worker cancel it. The claim also waits out a restart of the
 * inference process (`waitOutLocalInferenceBackoff`), as the embed worker's claim does: every embed in that window is refused.
 *
 * During a known outage no media job is claimed, also one whose file takes no vector: the claim cannot know. It starts at the first answered
 * probe, at most one pause step after the embedder is back.
 */
import { classifyEmbedFailure, embedFailureMessage } from '../../brain/embed-errors.js';
import { createEmbedderOutagePause, type EmbedderOutagePause } from '../../brain/embedder-outage-pause.js';
import { embed } from '../../brain/embedding.js';
import { waitOutLocalInferenceBackoff } from '../../brain/local-inference.js';
import { mediaEmbedderProbesTotal } from '../../metrics/media-outage-metrics.js';
import { log, peerText } from '../../util/log.js';

/** What the probe embeds: short, so an outage costs as little as an embed call can. */
const PROBE_TEXT = 'ythril embedder probe';

/** The pause is said in seconds. */
const MS_PER_SECOND = 1_000;
const inSeconds = (ms: number): number => Math.round(ms / MS_PER_SECOND);

export interface MediaClaimGateDeps {
  /** The gate's own pause. */
  pause: EmbedderOutagePause;
  /** One short embed call; resolves when the embedder gave a vector, throws what the call threw. */
  probe(): Promise<unknown>;
  /** Resolves when the inference process is not being restarted. */
  waitOutRestart(): Promise<void>;
}

export interface MediaClaimGate {
  /**
   * Claim through `claimJob` unless the embedder is known to be unavailable: waits out the inference process's restart and the pause, probes when
   * an outage is known, and answers `null` (nothing claimed) when the probe was not answered or the worker stopped (`isRunning`) meanwhile.
   */
  claim<J>(claimJob: () => Promise<J | null>, isRunning: () => boolean): Promise<J | null>;
  /** A run was handed back: an outage is known, and the next pause starts. Returns the pause owed, ms. */
  noteHandBack(): number;
  /** How much of the pause is left, ms; 0 when there is none. */
  outageRemainingMs(): number;
  /** End the pause and forget the outage: for the worker's stop, so a pause never delays it. */
  cancel(): void;
}

/** Was the embedder heard from? A vector, or a failure that is the request's or the record's (`record`, `ends`). */
function answeredBy(failure: unknown): boolean {
  const verdict = classifyEmbedFailure(failure);
  return verdict.kind === 'record' || verdict.kind === 'ends';
}

/** One gate. The worker has one (`mediaClaimGate`); a test makes its own with a pause on a fake clock and a fake probe. */
export function createMediaClaimGate(deps: MediaClaimGateDeps): MediaClaimGate {
  let outageKnown = false;

  /** Probe once: true when the embedder answered (the outage is over), false when the next pause has started. */
  const probeAnswered = async (): Promise<boolean> => {
    try {
      await deps.probe();
    } catch (err) {
      if (!answeredBy(err)) {
        const owedMs = deps.pause.noteUnreachable();
        mediaEmbedderProbesTotal.labels({ outcome: 'unavailable' }).inc();
        log.warn(`Media worker: the embedder is still unavailable (${peerText(embedFailureMessage(err))}); nothing is claimed for ${inSeconds(owedMs)} s, then it is probed again`);
        return false;
      }
    }
    outageKnown = false;
    deps.pause.noteEmbedded();
    mediaEmbedderProbesTotal.labels({ outcome: 'answered' }).inc();
    log.info('Media worker: the embedder answered; media jobs are claimed again');
    return true;
  };

  return {
    async claim(claimJob, isRunning) {
      await deps.waitOutRestart();
      if (outageKnown) {
        await deps.pause.waitOut();
        // A stop cancels the pause: the wait ends, and a stopped worker neither probes nor claims.
        if (!isRunning() || !outageKnown) return null;
        if (!(await probeAnswered())) return null;
      }
      return isRunning() ? claimJob() : null;
    },
    noteHandBack() {
      outageKnown = true;
      const owedMs = deps.pause.noteUnreachable();
      log.warn(`Media worker: a run found the embedder unavailable throughout; nothing is claimed for ${inSeconds(owedMs)} s, then the embedder is probed`);
      return owedMs;
    },
    outageRemainingMs: () => deps.pause.remainingMs(),
    cancel() {
      outageKnown = false;
      deps.pause.cancel();
    },
  };
}

/** The media worker's gate: its own pause, a probe through the real embed call, and the inference host's restart wait. */
export const mediaClaimGate = createMediaClaimGate({
  pause: createEmbedderOutagePause(),
  probe: () => embed(PROBE_TEXT),
  waitOutRestart: waitOutLocalInferenceBackoff,
});
