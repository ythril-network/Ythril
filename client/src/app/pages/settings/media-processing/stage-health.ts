/**
 * How a pipeline stage's health reads on the screen, beyond the dot's colour.
 *
 * Two rules with one reason: the dot, the card's reason line and a card's provider pill are three surfaces
 * showing ONE stage, and each was free to disagree. Found driving Q-99 (2026-10-01): the bundled embedding
 * model could not load, the server said `down` with the load error as `detail`, and the card showed a red dot
 * titled "not responding", no reason anywhere, beside a GREEN pill. Every surface that shows a stage reads it
 * through here, so a fourth one cannot drop the guard.
 */
import { HealthState } from './media-processing.types';
import { StatusVariant } from '../../../shared/status-pill.component';

/**
 * The text that explains a stage that is NOT ok, or null.
 *
 * The guard is the point: an ok stage carries a `detail` too (`in-process` on the bundled embedder), and that is
 * a fact about the configuration, not a reason anything is wrong -- shown beside a green dot it reads as a warning.
 * `null` (status not loaded) has nothing to explain either.
 */
export function problemDetail(state: HealthState | null | undefined, detail: string | null | undefined): string | null {
  if (state === null || state === undefined || state === 'ok') return null;
  const text = detail?.trim();
  return text ? text : null;
}

/**
 * A provider pill's colour, given the colour it has when the stage is fine.
 *
 * The pill names WHAT is configured (bundled, HTTP, external) and its colour said "good" unconditionally. A stage
 * that cannot serve overrides that: red when down, amber when degraded or refused by policy. Every other state
 * keeps the pill's own colour, because off and unconfigured are not faults.
 */
export function stagePillVariant(base: StatusVariant, state: HealthState | null | undefined): StatusVariant {
  if (state === 'down') return 'error';
  if (state === 'degraded' || state === 'blocked') return 'warn';
  return base;
}
