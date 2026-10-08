/**
 * The heartbeat, the lease check, and the route names — shared by every media embedder that has a long step.
 *
 * ## What was missing
 *
 * `worker.ts` builds both halves of the protocol the document pipeline uses: a `heartbeat` that stamps job
 * progress and answers whether the claim is still ours, and a `leaseLost` flag the long phases poll. It passed
 * them **only** to `runConversionPipeline`. The three media embedders got neither, and two of them call a model
 * once per item in a loop:
 *
 * - `audio-embedder.ts` transcribes one silence-delimited chunk at a time. An hour of speech is dozens of
 *   chunks at 300 s each — against a 450 s stall floor that bounds ONE call.
 * - `video-embedder.ts` captions one keyframe at a time, uncapped, one frame per 30 s of footage. An hour of
 *   video is 120 captions at 120 s: 14 400 s inside a step reporting nothing, against a 270 s floor.
 *
 * A hop budget bounds a single call. **A loop is N of them**, and no budget can describe N — which is why the
 * answer is to report progress rather than to raise a number.
 *
 * ## The half that corrupts rather than delays
 *
 * Stall recovery clears the claim token and hands the file to a second worker. Nothing in the media path polled
 * the lease, so the first run kept going: two runs transcribing the same audio, writing the same chunk ids,
 * competing for the same model. `worker.ts` documents that risk on `leaseLost` and it is why the document path
 * polls — the media path was never given the same protection.
 *
 * ## Why the step names live here
 *
 * The file manager draws one segment per entry in `steps`, and a `step` absent from its own `steps` array
 * renders as no segment at all — indistinguishable from a job that is not reporting. `embedVideo` calls
 * `embedAudio`, so the two would otherwise each name their own route and the bar would swap arrays halfway
 * through one job. The TOP-LEVEL caller picks the route; each embedder names only which stage it is in.
 */
import type { StepProgress } from '../converters/types.js';

export interface MediaProgressOpts {
  /** Stamp progress on the job row. Called once per item of a long loop, never once per job. */
  onProgress?: (p: StepProgress) => void;
  /** True once this run has lost its claim — a loop stops rather than duplicating a recovered job. */
  shouldStop?: () => boolean;
  /**
   * Aborted the moment this run loses its claim. `shouldStop` is polled BETWEEN steps; this reaches INTO one: every
   * ffmpeg step takes it, so a recovered job's process is killed rather than left running to its ten-minute bound.
   */
  signal?: AbortSignal;
  /**
   * Every stage this file's route will run, in order. Supplied by the caller that knows the whole route:
   * an audio file transcribes and embeds, a video does both of those AND captions between them.
   */
  steps?: readonly string[];
}

/** An audio file's route. */
export const AUDIO_STEPS = ['transcribe', 'embed'] as const;

/** A keyframed video's route — its audio track first, then the frames, then the combined re-embed. */
export const VIDEO_STEPS = ['transcribe', 'caption', 'embed'] as const;
