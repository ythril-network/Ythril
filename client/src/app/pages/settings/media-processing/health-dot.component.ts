/**
 * The health dot on a pipeline step.
 *
 * Glassy per the owner's spec — lit from the top-left, tinted ring, soft bloom — with one exception
 * that is deliberate: the `off` state stays matte. An off component is not unhealthy, and giving it
 * the same glow as a live one would make "deliberately disabled" and "running" look alike at a glance,
 * which is the failure this screen exists to end.
 *
 * **Colour is never the only carrier.** Every dot has an accessible name and a `title`, because the
 * entire purpose of this component is reporting status and a status a screen-reader user cannot hear
 * is not reported. `unknown` (status not loaded, or the fetch failed) stays a distinct *state* — "we
 * could not tell" and "it is switched off" are different facts, and the accessible name/title still
 * says so. Its *visual* now matches `off`/`unconfigured` (a plain grey bead) rather than a dashed
 * hollow ring: per owner review the inactive dots must read as one uniform grey, not a grey-vs-empty
 * mix, so the distinction lives in the name a screen reader announces, not in a second dot shape.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { HealthState } from './media-processing.types';
import { problemDetail } from './stage-health';

@Component({
  selector: 'app-health-dot',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  styles: [`
    :host { display: inline-flex; align-items: center; }
    .dot {
      width: 10px; height: 10px; border-radius: 50%; flex: none; position: relative;
      background: radial-gradient(circle at 32% 28%, var(--hi), var(--base) 62%);
      box-shadow: 0 0 0 2.5px var(--ring), 0 0 7px 1px var(--bloom), inset 0 -1px 1.5px rgba(0,0,0,.28);
    }
    /* The specular highlight is what makes it read as a lit bead rather than a flat circle. */
    .dot::after {
      content: ''; position: absolute; inset: 1px 1px auto 1.5px; height: 38%; border-radius: 50%;
      background: linear-gradient(180deg, rgba(255,255,255,.72), rgba(255,255,255,0));
      pointer-events: none;
    }
    /* Built from the semantic tokens rather than fixed hex, so an embedder overriding --success /
       --warning / --error restyles the dots along with everything else. The highlight and bloom are
       derived from the same base colour, which is also what keeps the four states consistent. */
    .ok       { --base: var(--success); }
    .degraded { --base: var(--warning); }
    .down     { --base: var(--error); }
    .blocked  { --base: var(--accent); }
    .ok, .degraded, .down, .blocked {
      --hi:    color-mix(in srgb, var(--base) 45%, white);
      --ring:  color-mix(in srgb, var(--base) 20%, transparent);
      --bloom: color-mix(in srgb, var(--base) 42%, transparent);
    }
    /* Matte: no bloom, no highlight, flat fill. Deliberately not a colour variant of the others.
       off / unconfigured / unknown share one grey bead — inactive dots read as a single uniform grey
       (owner review); the states stay distinct only in the accessible name, not a second dot shape. */
    .off, .unknown, .unconfigured {
      background: var(--bg-elevated); box-shadow: inset 0 0 0 1px var(--border);
    }
    .off::after, .unknown::after, .unconfigured::after { display: none; }
    @media (prefers-reduced-motion: reduce) { .dot { box-shadow: 0 0 0 2.5px var(--ring); } }
  `],
  template: `
    <span class="dot" [class]="cls()" role="img"
      [attr.aria-label]="prefix() + ('mediaProcessing.health.' + cls() | transloco) + suffix()"
      [attr.title]="prefix() + ('mediaProcessing.health.' + cls() | transloco) + suffix()"></span>
  `,
})
export class HealthDotComponent {
  /** null = status not loaded yet, or the fetch failed. Drawn as `unknown`, never as `off`. */
  state = input<HealthState | null>(null);
  /** Prepended to the accessible name, so a dot says WHAT is healthy, not just that something is. */
  subject = input<string>('');
  /**
   * The stage's `detail` from the status payload. Appended to the name only while the stage is not ok
   * (`problemDetail`): "not responding" alone sent an operator to Verify for a reason the payload already had.
   */
  detail = input<string | null | undefined>(null);

  cls = computed(() => this.state() ?? 'unknown');
  // Built in the template via the pipe rather than in a computed, so the name re-translates when the
  // active language changes instead of freezing at whatever it was when the dot was first drawn.
  prefix = computed(() => this.subject() ? `${this.subject()}: ` : '');
  suffix = computed(() => { const d = problemDetail(this.state(), this.detail()); return d ? ` — ${d}` : ''; });
}
