/**
 * The progress bar for a file being processed — sections, not a spinner.
 *
 * Replaces a badge with a spinning dot in it, which said "something is happening" for as long as the
 * job ran and looked identical whether the job was working or wedged. Each section is a stage of
 * THAT document's route (routes differ per file and per extraction level), the active one fills as
 * its units land, and the whole thing degrades to a plain bar when the route has one stage.
 *
 * All of the judgement lives in `step-progress.model.ts`; this component draws what it is given.
 *
 * **Accessibility is not decoration here.** A bar that communicates only by width communicates
 * nothing to a screen reader, and "is this file done?" is exactly the question a progress indicator
 * exists to answer. It carries `role="progressbar"` with real values, plus a text label naming the
 * stage and its position — the same rule the pipeline health dots follow.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { buildBarModel, isStale, StepProgress } from './step-progress.model';

@Component({
  selector: 'app-step-progress-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  styles: [`
    :host { display: block; min-width: 120px; }
    .wrap { display: flex; flex-direction: column; gap: 3px; }
    .track { display: flex; gap: 2px; height: 6px; border-radius: 3px; overflow: hidden; }
    .seg { position: relative; background: var(--bg-elevated); border-radius: 2px; overflow: hidden; }
    .seg .fill { position: absolute; inset: 0 auto 0 0; background: var(--accent); border-radius: 2px; }
    .seg.done .fill { width: 100%; }
    /* The active segment animates its width so the bar moves rather than teleporting between ticks. */
    .seg.active .fill { transition: width .4s ease; }
    .seg.stale .fill { background: var(--warning); }
    @media (prefers-reduced-motion: reduce) { .seg.active .fill { transition: none; } }

    .label { font-size: 10px; color: var(--text-muted); display: flex; gap: 5px; align-items: baseline; }
    .label .step { color: var(--text-secondary); font-weight: 550; }
    .label.stale { color: var(--warning); }
  `],
  template: `
    <div class="wrap">
      <!-- The accessible name is built HERE, through the pipe, not in a computed: a computed would
           put the raw i18n key into aria-valuetext and re-translate never. -->
      <div class="track" role="progressbar"
        [attr.aria-valuemin]="0" [attr.aria-valuemax]="100"
        [attr.aria-valuenow]="percent()"
        [attr.aria-valuetext]="stale() ? ('files.progress.stalled' | transloco) : ((stepLabel() | transloco) + suffix())"
        [attr.aria-label]="stale() ? ('files.progress.stalled' | transloco) : ((stepLabel() | transloco) + suffix())">
        @if (model().segmented) {
          @for (s of model().segments; track $index) {
            <div class="seg" [class]="s.state" [class.stale]="stale()" [style.flex]="s.weight">
              <div class="fill" [style.width.%]="s.fill * 100"></div>
            </div>
          }
        } @else {
          <!-- One stage, or a shape we cannot describe: a plain bar rather than a single box that
               implies there are other sections still to come. -->
          <div class="seg active" [class.stale]="stale()" style="flex:1">
            <div class="fill" [style.width.%]="(model().overall ?? 0) * 100"></div>
          </div>
        }
      </div>
      <div class="label" [class.stale]="stale()">
        @if (stale()) {
          {{ 'files.progress.stalled' | transloco }}
        } @else {
          <span class="step">{{ stepLabel() | transloco }}</span>
          @if (unitText(); as u) { <span>{{ u }}</span> }
        }
      </div>
    </div>
  `,
})
export class StepProgressBarComponent {
  progress = input<StepProgress | null | undefined>(null);
  /** A key that names the stage in the caller's own words (a set that ended: Completed, Abandoned), in place of the pipeline stage's. */
  stageLabelKey = input<string | null>(null);
  /** ISO8601 of the job's last report, for the stalled check. */
  progressAt = input<string | null | undefined>(null);
  /** Instance stall timeout. Default matches the server's own default. */
  stallTimeoutMs = input<number>(300_000);

  model = computed(() => buildBarModel(this.progress()));
  stale = computed(() => isStale(this.progressAt(), this.stallTimeoutMs()));

  percent = computed(() => {
    const o = this.model().overall;
    return o === null ? null : Math.round(o * 100);
  });

  /** i18n key for the running stage. Unknown stages fall back to a generic "working" rather than
   *  rendering a raw internal identifier at the user. */
  stepLabel = computed(() => {
    const named = this.stageLabelKey();
    if (named) return named;
    const step = this.progress()?.step;
    if (!step) return 'files.progress.working';
    return KNOWN_STEPS.has(step) ? `mediaProcessing.step.${step}` : 'files.progress.working';
  });

  /** "12 / 40" for a countable stage, else empty — never a fabricated count. */
  unitText = computed(() => {
    const p = this.progress();
    if (!p || typeof p.done !== 'number' || typeof p.total !== 'number' || p.total <= 0) return '';
    return `${Math.min(p.done, p.total)} / ${p.total}`;
  });

  /** Everything after the translated stage name: " 12 / 40 — 45%". Joined in the template. */
  suffix = computed(() => {
    const pct = this.percent();
    const units = this.unitText();
    return `${units ? ' ' + units : ''}${pct === null ? '' : ` — ${pct}%`}`;
  });
}

/**
 * Stage names that have a translated label (`mediaProcessing.step.*`).
 *
 * Keep this in step with what the pipeline can actually report. A stage that runs but is missing here does
 * NOT error — it silently renders as the generic "working", which is indistinguishable from a job whose
 * stage is genuinely unknown. `faces` was in exactly that state: translated in all three locales, absent
 * from this set. `step-progress-bar.component.spec.ts` now asserts every pipeline stage resolves to its
 * own label.
 */
const KNOWN_STEPS = new Set([
  'ocr', 'render', 'vlm', 'validate', 'repair', 'verify',
  'embed', 'chunk', 'caption', 'transcribe', 'split', 'faces',
]);
