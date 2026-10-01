/**
 * Tab 2 — Pipelines. What actually runs, drawn as the real step chain.
 *
 * Five pipelines (Documents · Images · Audio · Video · Text), each with the actor named under every
 * step and that pipeline's knobs attached to it rather than pooled in one "Advanced" block at the
 * bottom of the page. Pooling them is what made the old page unreadable: a render-DPI field sitting
 * next to a worker-concurrency field tells you nothing about which pipeline either belongs to.
 *
 * Three rules from the approved layout, and what each is for:
 *
 *   - **Conditional steps are dashed, always-run steps are solid.** A repair pass that only engages
 *     when a repair model is wired in is not the same kind of thing as OCR, and drawing them alike
 *     is how an operator concludes a stage ran when it never could.
 *   - **The actor names the model, never the state — the dot is the state.** Writing "off" where a
 *     model name belongs conflates what a step *is* with whether it is *working*.
 *   - **Each pipeline carries its own instance ceiling** — the most any space may do with that class,
 *     not a default a space inherits. Lowering one silently caps every space above it, and "off"
 *     takes the class offline everywhere — so both facts are stated at the control, not in a doc.
 */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../../shared/ph-icon.component';
import { StatusPillComponent } from '../../../shared/status-pill.component';
import { HealthDotComponent } from './health-dot.component';
import { HscrollTopDirective } from '../../../shared/hscroll-top.directive';
import { MediaProcessingStateService, PipeId } from './media-processing-state.service';
import { PipelineStatusService } from './pipeline-status.service';
import { HealthState, MODE_STAGES, IMAGE_LEVELS, AUDIO_LEVELS, VIDEO_LEVELS, TEXT_LEVELS, MediaClass } from './media-processing.types';

/** One drawn step. `actor` is a model or tool name; `health` is looked up from the status payload. */
interface Step {
  key: string;
  /** i18n key for the step's name. */
  name: string;
  actor: string;
  health: HealthState | null;
  /** The stage's `detail`, handed to the dot, which shows it only while the step is not ok. */
  detail?: string | null;
  /** Dashed when true — the step only runs under some configurations. */
  conditional: boolean;
  /** The Models-tab card this actor is configured on. Anchors the deep-link (landing in a later PR). */
  cardId?: string;
}

@Component({
  selector: 'app-pipelines-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, FormsModule, TranslocoPipe, PhIconComponent, StatusPillComponent, HealthDotComponent, HscrollTopDirective],
  styles: [`
    :host { display: block; }
    .pipe-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px;
      margin-bottom: 16px; overflow: hidden; }
    .pipe-h { display: flex; align-items: center; gap: 12px; padding: 14px 18px; }
    .ic { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; flex: none;
      background: var(--bg-elevated); border: 1px solid var(--border); color: var(--accent); }
    .pipe-h .t { flex: 1; min-width: 0; }
    .pipe-h h3 { margin: 0; font-size: 14.5px; font-weight: 620; }
    .pipe-h p { margin: 2px 0 0; font-size: 12.5px; color: var(--text-secondary); }

    /* The chain scrolls inside itself rather than widening the page — this has to survive an iframe. */
    .chain { display: flex; gap: 0; padding: 4px 18px 16px; overflow-x: auto; }
    .step { flex: 1 0 auto; min-width: 108px; max-width: 190px; position: relative; padding: 2px 5px; }
    .step + .step::before { content: "→"; position: absolute; left: -6px; top: 26px;
      color: var(--text-muted); font-size: 12px; }
    .box { border: 1px solid var(--border); background: var(--bg-primary); border-radius: 9px;
      padding: 9px 10px; height: 100%; }
    .step.cond .box { border-style: dashed; }
    .step.dim .box { opacity: .42; }
    /* The extraction mode marks the steps it actually runs: an accent border + faint tint, so the live
       path stands out from the dimmed ones at a glance. */
    .step.active .box { border-color: var(--accent);
      box-shadow: inset 0 0 0 1px var(--accent); background: color-mix(in srgb, var(--accent) 7%, var(--bg-primary)); }
    .nm { font-size: 12px; font-weight: 620; display: flex; align-items: center; gap: 6px; }
    /* The actor is the model, the dot is the state — kept visually separate on purpose. */
    .actor { font-size: 10.5px; color: var(--text-muted); margin-top: 3px;
      font-family: var(--font-mono, monospace); }
    /* Model ids are long and their TAIL is the identifying part: "nomic-ai/nomic-embed-text-v1.5" is
       told apart from its siblings by the version, not the vendor. So this truncates from the START.
       direction:rtl puts the overflow (and therefore the ellipsis) on the left; the value itself is
       wrapped in <bdi> so it still reads left-to-right instead of being reordered by the rtl context.
       Previously this wrapped (overflow-wrap:anywhere) and spilled out of the fixed-height box. */
    .actor .val { display: block; direction: rtl; text-align: left;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    /* A configurable step's actor is a link back to the Models-tab card that configures it. A real
       button (not an anchor) so keyboard + screen readers get it for free. */
    .actor button.link { background: none; border: 0; padding: 0; font: inherit; text-align: left;
      color: var(--text-secondary); text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
      display: block; max-width: 100%; }
    .actor button.link.infra { text-decoration-style: dotted; }
    .actor button.link:hover { color: var(--text-primary); }
    .actor button.link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

    .knobs { border-top: 1px solid var(--border-muted); padding: 14px 18px; }
    .knobs-h { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em;
      color: var(--text-muted); margin-bottom: 10px; }
    .modeseg { display: inline-flex; background: var(--bg-primary); border: 1px solid var(--border);
      border-radius: 9px; padding: 3px; gap: 2px; flex-wrap: wrap; }
    .modeseg button { border: 0; background: transparent; color: var(--text-secondary); font: inherit;
      font-size: 12.5px; font-weight: 600; padding: 6px 13px; border-radius: 6px; cursor: pointer; }
    .modeseg button.on { background: var(--accent); color: var(--accent-text, #0d1117); }
    .modeseg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .modedesc { font-size: 12.5px; color: var(--text-secondary); margin: 11px 0 0; }
    .modedesc ::ng-deep b { color: var(--text-primary); }

    .ceiling { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12.5px;
      color: var(--text-secondary); margin-bottom: 9px; }
    .ceiling:last-child { margin-bottom: 0; }
    .ceiling > label { min-width: 108px; font-weight: 500; }
    /* The global select rule sets width:100%, which would take the whole row and wrap the label above
       it — these read as a labelled row, not a stack of full-width fields. */
    .ceiling select { background: var(--bg-primary); color: var(--text-primary); font-size: 13px;
      border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px;
      width: auto; min-width: 190px; max-width: 260px; }
    .ceiling select:disabled { opacity: .6; cursor: not-allowed; }
    .ceiling-hint { font-size: 12px; color: var(--text-muted); margin: 0 0 11px; max-width: 70ch; }
    /* Each pipeline's own Save, appearing only when that pipeline changed — same contract as the
       Models cards. Right-aligned inside the knobs block so it reads as belonging to it. */
    .pipe-save { display: flex; justify-content: flex-end; margin-top: 12px; }
    /* Hoisted to the top of the tab: needs the breathing room a knobs block used to give it. */
    .tab-hint { margin: 0 0 16px; }
    /* Not a warning box: choosing "off" is legitimate. It states the blast radius, which is easy to
       miss when the control sits next to three that only affect thoroughness. */
    .ceiling-warn { color: var(--warning); font-size: 11.5px; }

    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px 16px; margin-top: 14px; }
    .field > label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 5px; font-weight: 500; }
    /* Geometry comes from the ONE input rule in styles.scss. This was a second, identical copy of the block that
       models-tab also had — including the same wrong 8px radius. The re-measurement is what found it: inputs still
       reported 38px after the first copy was removed, because both tabs render on the Models page. */
    .field input:disabled { opacity: .6; cursor: not-allowed; }
    .warnline { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 10px 12px;
      border-radius: 9px; font-size: 12.5px; border: 1px solid var(--warning-border); background: var(--warning-bg); }
    .warnline ph-icon { flex: none; margin-top: 1px; }
    .statuswarn { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; padding: 10px 12px;
      border-radius: 9px; font-size: 12.5px; border: 1px solid var(--border); background: var(--bg-surface);
      color: var(--text-secondary); }
  `],
  template: `
    @if (pipeline.error(); as e) {
      <!-- A failed status fetch must not read as "everything is off" — say which it is. -->
      <div class="statuswarn">
        <ph-icon name="warning" [size]="15"/>
        <span>{{ 'mediaProcessing.pipelines.statusUnavailable' | transloco: { detail: e } }}</span>
      </div>
    }

    <!-- The ceiling rule is one rule for the whole tab, so it is stated once here rather than repeated
         under every pipeline's ceiling control — five copies of the same paragraph is noise a reader
         learns to skip, which defeats the point of explaining it at all. -->
    <p class="ceiling-hint tab-hint">{{ 'mediaProcessing.pipelines.ceilingHint' | transloco }}</p>

    <!-- ── Text (first: the poorest medium) ───────────────────────────── -->
    @for (p of textPipeline(); track p.id) {
      <ng-container [ngTemplateOutlet]="pipeCard" [ngTemplateOutletContext]="{ $implicit: p }"/>
    }

    <!-- ── Documents ──────────────────────────────────────────────────── -->
    <section class="pipe-card">
      <header class="pipe-h">
        <span class="ic"><ph-icon name="file" [size]="17"/></span>
        <div class="t">
          <h3>{{ 'mediaProcessing.pipelines.documents' | transloco }}</h3>
          <p>{{ s.docSummary().key | transloco: s.docSummary().params }}</p>
        </div>
        <app-status-pill [variant]="s.docVariant()" [dot]="true">{{ s.docPillLabelKey() | transloco }}</app-status-pill>
      </header>

      <div class="chain" hscrollTop>
        @for (st of documentSteps(); track st.key) {
          <div class="step" [class.cond]="st.conditional" [class.dim]="stepDim(st.key)" [class.active]="stepActive(st.key)">
            <div class="box">
              <div class="nm">{{ st.name | transloco }}<app-health-dot [state]="st.health" [detail]="st.detail" [subject]="st.name | transloco"/></div>
              <div class="actor">
                @if (st.cardId; as cid) {
                  <button type="button" class="link" [class.infra]="isInfra(cid)" (click)="s.requestFocusCard(cid)"
                    [attr.title]="st.actor" [attr.aria-label]="('mediaProcessing.pipelines.configureLink' | transloco) + ': ' + st.actor"><span class="val"><bdi>{{ st.actor }}</bdi></span></button>
                } @else {
                  <span class="val" [attr.title]="st.actor"><bdi>{{ st.actor }}</bdi></span>
                }
              </div>
            </div>
          </div>
        }
      </div>

      <div class="knobs">
        <div class="knobs-h">{{ 'mediaProcessing.pipelines.extractionMode' | transloco }}</div>
        <div class="modeseg" role="group" [attr.aria-label]="'mediaProcessing.pipelines.extractionMode' | transloco">
          @for (m of s.MODES; track m) {
            <button type="button" [class.on]="s.docMode() === m" [attr.aria-pressed]="s.docMode() === m" (click)="s.setMode(m)" [disabled]="s.managed">
              {{ 'mediaProcessing.mode.' + m | transloco }}
            </button>
          }
        </div>
        <p class="modedesc"><b>{{ 'mediaProcessing.mode.' + s.docMode() | transloco }}</b> — {{ s.modeDescKey() | transloco }}</p>

        <!-- The "no vision model configured, falls back to OCR" case is already carried by the header
             pill ("OCR fallback") and the pipeline summary line, so the extra warning box was redundant
             noise — removed per owner feedback. -->

        <div class="grid">
          <div class="field">
            <label for="dp-dpi">{{ 'mediaProcessing.knob.renderDpi' | transloco }}</label>
            <input id="dp-dpi" type="number" min="72" max="600" [(ngModel)]="s.form.documentProcessing!.renderDpi" [disabled]="s.managed" />
          </div>
          <div class="field">
            <label for="dp-maxpages">{{ 'mediaProcessing.knob.maxPages' | transloco }}</label>
            <input id="dp-maxpages" type="number" min="1" max="2000" [(ngModel)]="s.form.documentProcessing!.maxPages" [disabled]="s.managed" />
          </div>
          <div class="field">
            <label for="dp-pagetimeout">{{ 'mediaProcessing.knob.pageTimeout' | transloco }}</label>
            <input id="dp-pagetimeout" type="number" min="1000" max="600000" [(ngModel)]="s.form.documentProcessing!.pageTimeoutMs" [disabled]="s.managed" />
          </div>
          <div class="field">
            <label for="dp-concurrency">{{ 'mediaProcessing.knob.pageConcurrency' | transloco }}</label>
            <input id="dp-concurrency" type="number" min="1" max="8" [(ngModel)]="s.form.documentProcessing!.concurrency" [disabled]="s.managed" />
          </div>
          <div class="field">
            <label for="dp-ocrtimeout">{{ 'mediaProcessing.knob.ocrTimeout' | transloco }}</label>
            <input id="dp-ocrtimeout" type="number" min="10000" max="1800000" [(ngModel)]="s.form.documentProcessing!.ocrTimeoutMs" [disabled]="s.managed" />
          </div>
        </div>
        @if (s.pipeDirty('pipe-documents')) {
          <div class="pipe-save">
            <button class="btn btn-sm btn-primary" type="button"
              [disabled]="s.saving()" (click)="s.savePipe('pipe-documents')">
              {{ (s.saving() ? 'common.saving' : 'common.save') | transloco }}
            </button>
          </div>
        }
      </div>
    </section>

    <!-- ── Images / Audio / Video / Text ──────────────────────────────── -->
    <!-- One card definition, instantiated twice: Text renders ABOVE the document pipeline and the rest
         below it, so the page reads poor → rich media. Documents cannot join the list because its
         control is an extraction mode rather than a class ceiling. -->
    <ng-template #pipeCard let-p>
      <section class="pipe-card">
        <header class="pipe-h">
          <span class="ic"><ph-icon [name]="p.icon" [size]="17"/></span>
          <div class="t">
            <h3>{{ p.title | transloco }}</h3>
            <p>{{ p.purpose | transloco }}</p>
          </div>
        </header>

        <div class="chain" hscrollTop>
          @for (st of p.steps; track st.key) {
            <!-- dim/active, same as the document pipeline. Without these the four media pipelines showed
                 availability only: green dots everywhere and no indication of which steps the chosen
                 rung actually executes. -->
            <div class="step" [class.cond]="st.conditional"
                 [class.dim]="mediaStepDim(p.id, st.key)" [class.active]="mediaStepActive(p.id, st.key)">
              <div class="box">
                <div class="nm">{{ st.name | transloco }}<app-health-dot [state]="st.health" [detail]="st.detail" [subject]="st.name | transloco"/></div>
                <div class="actor">
                  @if (st.cardId; as cid) {
                    <button type="button" class="link" [class.infra]="isInfra(cid)" (click)="s.requestFocusCard(cid)"
                      [attr.title]="st.actor" [attr.aria-label]="('mediaProcessing.pipelines.configureLink' | transloco) + ': ' + st.actor"><span class="val"><bdi>{{ st.actor }}</bdi></span></button>
                  } @else {
                    <span class="val" [attr.title]="st.actor"><bdi>{{ st.actor }}</bdi></span>
                  }
                </div>
              </div>
            </div>
          }
        </div>

        <div class="knobs">
          <div class="knobs-h">{{ 'mediaProcessing.pipelines.ceiling' | transloco }}</div>
          @for (c of p.ceilings; track c.cls) {
            <div class="ceiling">
              <label>{{ 'mediaProcessing.class.' + c.cls | transloco }}</label>
              <!-- Every media pipeline is single-class, so each uses the same segmented buttons as the
                   document extraction mode — one control vocabulary across all of them. -->
              <div class="modeseg" role="group" [attr.aria-label]="'mediaProcessing.class.' + c.cls | transloco">
                @for (rung of c.ladder; track rung) {
                  <button type="button" [class.on]="ceilingOf(c.cls) === rung" [attr.aria-pressed]="ceilingOf(c.cls) === rung" (click)="setCeiling(c.cls, rung)"
                    [disabled]="rungDisabled(c.cls, rung, p.steps)">
                    {{ 'mediaProcessing.level.' + rung | transloco }}
                  </button>
                }
              </div>
              @if (s.isLocked('levels.' + c.cls)) { <app-status-pill variant="env">{{ 'mediaProcessing.pill.env' | transloco }}</app-status-pill> }
              @if (firstStepUnavailable(p.steps)) {
                <!-- Say WHY the rungs are greyed out. A disabled control with no explanation is read as
                     a bug, and the operator's next move is on the Models tab, not here. -->
                <span class="ceiling-warn">{{ 'mediaProcessing.pipelines.firstStepDown' | transloco }}</span>
              }
              @if (ceilingOf(c.cls) === 'off') {
                <!-- "off" is a floor as well as a ceiling: it takes the class offline for every space,
                     whatever that space asked for. Worth saying where it is chosen, not in a doc. -->
                <span class="ceiling-warn">{{ 'mediaProcessing.pipelines.ceilingOffWarning' | transloco }}</span>
              }
            </div>
          }
          <!-- This pipeline's own Save, shown only when this pipeline changed. -->
          @if (s.pipeDirty(pipeIdOf(p.id))) {
            <div class="pipe-save">
              <button class="btn btn-sm btn-primary" type="button"
                [disabled]="s.saving()" (click)="s.savePipe(pipeIdOf(p.id))">
                {{ (s.saving() ? 'common.saving' : 'common.save') | transloco }}
              </button>
            </div>
          }
        </div>
      </section>
    </ng-template>

    <!-- The rest of the media pipelines, after Documents. -->
    @for (p of otherPipelines(); track p.id) {
      <ng-container [ngTemplateOutlet]="pipeCard" [ngTemplateOutletContext]="{ $implicit: p }"/>
    }
  `,
})
export class PipelinesTabComponent {
  readonly s = inject(MediaProcessingStateService);
  readonly pipeline = inject(PipelineStatusService);

  /** Which document stages the current mode actually runs — dims the rest rather than hiding them. */
  activeStages = computed(() => MODE_STAGES[this.s.docMode()]);

  /**
   * Whether a step is drawn as not-running.
   *
   * `MODE_STAGES` only describes the six EXTRACTION stages, so it cannot be consulted directly: a step
   * outside that vocabulary — Embed, which always runs on whatever text comes out — is absent from
   * every set and would be dimmed under every mode, saying the brain never gets the document. Steps
   * the mode does not govern are only dimmed when the whole pipeline is off.
   */
  stepDim(key: string): boolean {
    if (this.s.docMode() === 'off') return true;          // nothing in this pipeline runs at all
    if (!MODE_STAGES['auto'].has(key)) return false;      // not a mode-governed stage
    return !this.activeStages().has(key);
  }

  /**
   * Whether a step is on the path the current extraction mode actually runs — the inverse of dim while
   * the pipeline is on. Used to mark (border) the live steps in the viz so the chosen mode reads at a
   * glance; when the pipeline is off, nothing is marked.
   */
  stepActive(key: string): boolean {
    return this.s.docMode() !== 'off' && !this.stepDim(key);
  }

  // ── What the MEDIA pipelines actually run ───────────────────────────────────
  //
  // The document pipeline has had dim/active markings since it shipped. The other four never did: their
  // steps rendered with `cond` alone, so nothing was ever highlighted and the traffic lights reported
  // only what was *available*, never what the configured level would actually execute. Owner, 2026-07-30:
  // "i can see with the traffic light what is available but not what is actually used in the pipeline."
  //
  // The rung governs it, and the mapping is per class rather than generic because the ladders mean
  // genuinely different things — `audio` on the video ladder is "run the audio pipeline and skip the
  // vision model", which no shared rule would guess.

  /** Steps a class runs at a given rung. `auto` resolves to the class's fullest rung. */
  private static readonly RUNS: Record<string, Record<string, readonly string[]>> = {
    images: {
      off: [],
      caption: ['caption', 'img-embed'],
      recognition: ['caption', 'img-embed', 'faces'],
    },
    audio: {
      off: [],
      on: ['transcribe', 'aud-embed'],
    },
    video: {
      off: [],
      // "audio" means take the audio track only — ffmpeg splits, STT transcribes, and the vision model
      // is not called at all.
      audio: ['vid-split', 'vid-transcribe', 'vid-embed'],
      full: ['vid-split', 'vid-transcribe', 'vid-keyframe', 'vid-embed'],
    },
    text: {
      off: [],
      // `embed` produces one vector for the whole document; only `chunk` splits it first.
      embed: ['txt-embed'],
      chunk: ['chunk', 'txt-embed'],
    },
  };

  /** The rung `auto` resolves to — the fullest one, since auto means "no ceiling of my own". */
  private static readonly AUTO_RUNG: Record<string, string> = {
    images: 'recognition', audio: 'on', video: 'full', text: 'chunk',
  };

  private runsAt(cls: string): readonly string[] {
    const rung = this.ceilingOf(cls as MediaClass);
    const resolved = rung === 'auto' ? PipelinesTabComponent.AUTO_RUNG[cls] ?? 'off' : rung;
    return PipelinesTabComponent.RUNS[cls]?.[resolved] ?? [];
  }

  /** True when this class runs nothing at all — the whole card reads as inert. */
  mediaOff(cls: string): boolean { return this.runsAt(cls).length === 0; }

  /** Drawn as not-running: the class is off, or this rung skips the step. */
  mediaStepDim(cls: string, key: string): boolean { return !this.runsAt(cls).includes(key); }

  /** On the path the current rung executes — mirrors `stepActive` on the document pipeline. */
  mediaStepActive(cls: string, key: string): boolean { return this.runsAt(cls).includes(key); }

  // ── Gating a pipeline whose first step cannot run ───────────────────────────

  /** Health states that mean the step cannot do its job right now. */
  private static readonly UNAVAILABLE = new Set(['down', 'blocked', 'unconfigured']);

  /**
   * Whether a pipeline's FIRST step is unavailable.
   *
   * Everything downstream consumes its output, so if step one cannot run the rest cannot either, and
   * offering rungs that promise captioning or transcription is a promise the instance cannot keep.
   * Owner, 2026-07-30: "if step one of a pipeline is not available only allow state off and auto (=off)
   * on toggles."
   */
  firstStepUnavailable(steps: readonly Step[]): boolean {
    const first = steps[0];
    if (!first || first.health == null) return false;   // no endpoint to be down (in-process step)
    return PipelinesTabComponent.UNAVAILABLE.has(first.health);
  }

  /**
   * Which rungs stay selectable when step one is down: only `off` and `auto`.
   *
   * `auto` is kept because it is not a promise — it means "no ceiling of my own", and with the first
   * step unavailable it resolves to nothing running, exactly like `off`. Removing it too would strand an
   * operator whose stored value IS `auto` on a control with no valid option.
   */
  rungDisabled(cls: MediaClass, rung: string, steps: readonly Step[]): boolean {
    if (this.s.isLocked('levels.' + cls) || this.s.managed) return true;
    if (!this.firstStepUnavailable(steps)) return false;
    return rung !== 'off' && rung !== 'auto';
  }

  private notSet = '—';

  /** Cards rendered as infra (env-owned, read-only) on the Models tab — their actor links get the
   *  dotted underline that marks "you can see it here but change it in the environment". */
  private readonly infraCards = new Set(['doc-render', 'unstructured']);
  isInfra(cardId: string): boolean { return this.infraCards.has(cardId); }

  /** Map a pipeline card's id to its config section, so each card can own its own Save. */
  pipeIdOf(id: string): PipeId { return `pipe-${id}` as PipeId; }

  /** The stored ceiling for a class, defaulting to `auto` (no policy limit of its own). */
  ceilingOf(cls: MediaClass): string { return (this.s.form.levels ?? {})[cls] ?? 'auto'; }

  /**
   * Set one class's ceiling. Writes only that class, mirroring the server's per-class merge — the
   * whole `levels` block is sent on save, so replacing the object here would be harmless, but keeping
   * the two sides shaped the same way is what stops them drifting apart later.
   */
  setCeiling(cls: MediaClass, value: string): void {
    this.s.form.levels = { ...(this.s.form.levels ?? {}), [cls]: value };
    this.s.touched.set(true);
  }

  /**
   * A step's state AND its detail, read together, so a step cannot be given the colour without the reason. The
   * dot shows the detail only while the step is not ok (Q-99: "Embed: not responding", with the load error that
   * explained it sitting unread in the payload).
   */
  private stage(kind: 'model' | 'sidecar', key: string): Pick<Step, 'health' | 'detail'> {
    const ps = this.pipeline;
    return kind === 'model'
      ? { health: ps.modelState(key), detail: ps.modelDetail(key) }
      : { health: ps.sidecarState(key), detail: ps.sidecarDetail(key) };
  }

  documentSteps = computed<Step[]>(() => {
    const doc = this.s.docCfg();
    return [
      { key: 'ocr', name: 'mediaProcessing.step.ocr', actor: 'Tesseract', ...this.stage('sidecar', 'unstructured'), conditional: false, cardId: 'unstructured' },
      { key: 'render', name: 'mediaProcessing.step.render', actor: 'doc-render', ...this.stage('sidecar', 'doc-render'), conditional: true, cardId: 'doc-render' },
      { key: 'vlm', name: 'mediaProcessing.step.vlm', actor: doc.vlmModel || this.notSet, ...this.stage('model', 'doc-vlm'), conditional: true, cardId: 'doc-vlm' },
      // Validate is pure in-process arithmetic (does the VLM output cover the OCR text?), so it has no
      // endpoint and therefore no dot to report — undefined health, not a green one it has not earned.
      { key: 'validate', name: 'mediaProcessing.step.validate', actor: 'in-process', health: null, conditional: true },
      { key: 'repair', name: 'mediaProcessing.step.repair', actor: doc.repairModel || doc.vlmModel || this.notSet, ...this.stage('model', 'doc-repair'), conditional: true, cardId: 'doc-repair' },
      { key: 'verify', name: 'mediaProcessing.step.verify', actor: doc.verifyModel || this.notSet, ...this.stage('model', 'doc-verify'), conditional: true, cardId: 'doc-verify' },
      { key: 'embed', name: 'mediaProcessing.step.embed', actor: this.s.embedding.model || this.notSet, ...this.stage('model', 'embedding'), conditional: false, cardId: 'embedding' },
    ];
  });

  /**
   * Ordered poor → rich media, from the reader's point of view: Text, Documents, Images, Audio, Video.
   *
   * Owner, 2026-07-30. Documents sits second even though it is by far the most complicated pipeline —
   * the ordering principle is how rich the *medium* is, not how hard it is to process, and a document is
   * text with structure. Sorting by implementation difficulty would put Documents last and make the list
   * incoherent to anyone who has not read the code.
   *
   * Documents renders between `textPipeline` and `otherPipelines` in the template because its control is
   * an extraction MODE rather than a class ceiling, so it does not fit this list's shape.
   */
  textPipeline = computed(() => this.mediaPipelines().filter(p => p.id === 'text'));
  otherPipelines = computed(() => this.mediaPipelines().filter(p => p.id !== 'text'));

  mediaPipelines = computed(() => {
    const ps = this.pipeline;
    const embedModel = this.s.embedding.model || this.notSet;
    return [
      {
        id: 'images', icon: 'image', title: 'mediaProcessing.pipelines.images', purpose: 'mediaProcessing.pipelines.imagesPurpose',
        ceilings: [{ cls: 'images' as MediaClass, ladder: IMAGE_LEVELS }],
        steps: [
          { key: 'caption', name: 'mediaProcessing.step.caption', actor: this.s.form.vision?.model || this.notSet, ...this.stage('model', 'vision'), conditional: false, cardId: 'vision' },
          { key: 'img-embed', name: 'mediaProcessing.step.embed', actor: embedModel, ...this.stage('model', 'embedding'), conditional: false, cardId: 'embedding' },
          // Only at the `recognition` rung, and only when faceRecognition is enabled — genuinely conditional.
          { key: 'faces', name: 'mediaProcessing.step.faces', actor: 'BlazeFace + FaceRes', health: ps.status()?.faceRecognition.state ?? null, conditional: true, cardId: 'face' },
        ] as Step[],
      },
      {
        id: 'audio', icon: 'microphone', title: 'mediaProcessing.pipelines.audio', purpose: 'mediaProcessing.pipelines.audioPurpose',
        ceilings: [{ cls: 'audio' as MediaClass, ladder: AUDIO_LEVELS }],
        steps: [
          { key: 'transcribe', name: 'mediaProcessing.step.transcribe', actor: this.s.form.stt?.model || this.notSet, ...this.stage('model', 'stt'), conditional: false, cardId: 'stt' },
          { key: 'aud-embed', name: 'mediaProcessing.step.embed', actor: embedModel, ...this.stage('model', 'embedding'), conditional: false, cardId: 'embedding' },
        ] as Step[],
      },
      {
        // Video is its own pipeline. It ALWAYS extracts the audio track and runs the audio pipeline
        // (ffmpeg → transcribe → embed); at the `full`/`auto` level it ALSO captions keyframes with the
        // vision model. The `audio` level is "take the audio pipeline instead of a model" — the keyframe
        // step is skipped (conditional). ffmpeg + the chunker are bundled/in-process, so they report 'ok'.
        id: 'video', icon: 'video-camera', title: 'mediaProcessing.pipelines.video', purpose: 'mediaProcessing.pipelines.videoPurpose',
        ceilings: [{ cls: 'video' as MediaClass, ladder: VIDEO_LEVELS }],
        steps: [
          { key: 'vid-split', name: 'mediaProcessing.step.split', actor: 'ffmpeg', health: 'ok', conditional: false },
          { key: 'vid-transcribe', name: 'mediaProcessing.step.transcribe', actor: this.s.form.stt?.model || this.notSet, ...this.stage('model', 'stt'), conditional: false, cardId: 'stt' },
          // Only at the `full`/`auto` rung — at `audio` the vision model is not called.
          { key: 'vid-keyframe', name: 'mediaProcessing.step.keyframe', actor: this.s.form.vision?.model || this.notSet, ...this.stage('model', 'vision'), conditional: true, cardId: 'vision' },
          { key: 'vid-embed', name: 'mediaProcessing.step.embed', actor: embedModel, ...this.stage('model', 'embedding'), conditional: false, cardId: 'embedding' },
        ] as Step[],
      },
      {
        id: 'text', icon: 'text-align-left', title: 'mediaProcessing.pipelines.text', purpose: 'mediaProcessing.pipelines.textPurpose',
        ceilings: [{ cls: 'text' as MediaClass, ladder: TEXT_LEVELS }],
        steps: [
          // Chunking only happens at the `chunk` rung; `embed` produces one vector for the whole
          // document. The chunker is bundled and always available in-process, so it reports 'ok'.
          { key: 'chunk', name: 'mediaProcessing.step.chunk', actor: 'text chunker', health: 'ok', conditional: true },
          { key: 'txt-embed', name: 'mediaProcessing.step.embed', actor: embedModel, ...this.stage('model', 'embedding'), conditional: false, cardId: 'embedding' },
        ] as Step[],
      },
    ];
  });
}
