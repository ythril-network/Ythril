/**
 * Tab 1 — Models. Anything you or infra can set.
 *
 * Seven cards, all through `app-model-provider-card`, all in one field order:
 * **provider → endpoint → model → credential → test**. The four configurable ones (embedding, vision,
 * speech-to-text, assist) previously each chose their own order inside one big file; the three
 * infra-owned ones (page renderer, document converter, face recognition) had no card at all — the
 * renderer and converter were a caption, and face recognition was absent from the admin surface
 * entirely, which is why it still shows here as read-only until it gets a real control.
 *
 * Rows that do not apply are omitted rather than dashed, per the owner's option B.
 */
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../../shared/ph-icon.component';
import { StatusPillComponent } from '../../../shared/status-pill.component';
import { ModelProviderCardComponent } from './model-provider-card.component';
import { CardSaveComponent } from './card-save.component';
import { AssistEgressConsentComponent } from './assist-egress-consent.component'; import { AssistExtrasComponent } from './assist-extras.component';
import { DecisionModelCardComponent } from './decision-model-card.component';
import { SidecarCardComponent } from './sidecar-card.component';
import { MediaProcessingStateService } from './media-processing-state.service';
import { PipelineStatusService } from './pipeline-status.service';
import { SchemaApi } from '../../../core/schema-api.service';
import { TestTarget } from './media-processing.types';

@Component({
  selector: 'app-models-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslocoPipe, PhIconComponent, StatusPillComponent, ModelProviderCardComponent, CardSaveComponent, DecisionModelCardComponent, AssistEgressConsentComponent, AssistExtrasComponent, SidecarCardComponent],
  styles: [`
    :host { display: block; }
    /* align-items: stretch is what pins every footer to a shared baseline (owner's point 4). */
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
      gap: 16px; align-items: stretch; }
    .field { margin-bottom: 13px; }
    .field:last-child { margin-bottom: 0; }
    .field > label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 5px; font-weight: 500; }
    /* Geometry comes from the ONE input rule in styles.scss. This used to restate it — and got the radius wrong,
       hardcoding 8px where every other input uses var(--radius-sm) — which is how the product ended up with four
       different inputs. */
    .field input[data-mono] { font-family: var(--font-mono, monospace); }
    .field input:disabled, .field select:disabled { opacity: .6; cursor: not-allowed; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
    /* Each field stacks label / input / hint. Left to themselves the two columns lay those out
       independently, so as soon as one label wraps to a second line and its neighbour does not, the
       two inputs sit at different heights. Subgrid makes both columns share the SAME three rows, so
       the inputs line up whatever the labels do -- at any width, in any language. Row alignment is the
       fix; nudging margins only moves the mismatch to the next viewport width. */
    .grid2 > .field { display: grid; grid-template-rows: subgrid; grid-row: span 3; margin-bottom: 0;
      align-content: start; }
    @media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
    .hint { font-size: 11.5px; color: var(--text-muted); margin-top: 5px; }
    .ro { font-family: var(--font-mono, monospace); font-size: 12.5px; color: var(--text-primary);
      background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
      overflow-wrap: anywhere; }
    .warnline { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 10px 12px;
      border-radius: 9px; font-size: 12.5px; border: 1px solid var(--warning-border); background: var(--warning-bg); }
    .warnline ph-icon { flex: none; margin-top: 1px; }
    .checkrow { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px;
      color: var(--text-secondary); font-weight: normal;
      /* Undo the global ".field label" caption styling (uppercase + tracking) — a checkbox's own
         label is a normal sentence, not a field caption. */
      text-transform: none; letter-spacing: normal; }
    /* width:auto keeps a checkbox in a checkrow from being stretched to 100% by the .field input
       rule when the checkrow sits inside a .field (assist card's repair-pass toggle). */
    .checkrow input { margin-top: 2px; flex: none; width: auto; }
    /* Person-type chips: the selected library entity types, each removable. */
    .ptype-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 7px; }
    .ptype-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; padding: 2px 4px 2px 9px;
      border-radius: 6px; border: 1px solid var(--border); background: var(--bg-primary);
      font-family: var(--font-mono, monospace); }
    .ptype-rm { display: inline-flex; align-items: center; background: none; border: 0; padding: 2px; cursor: pointer;
      color: var(--text-muted); border-radius: 4px; }
    .ptype-rm:hover { color: var(--error); }
    .switchrow { margin-bottom: 13px; }
    .switchrow .hint { margin-left: 22px; }   /* line up under the label, not the checkbox */
    /* The row WRAPS, and that is a deliberate reversal (B.3).
       It was nowrap to keep pressing Test from jolting the equal-height card row by a line. But nothing
       in the row could shrink except the hint, so once a status pill appeared beside a second one the
       fixed widths outgrew the card and pushed the **Verify button out of it, unclickable** — making the
       feature one-shot per page load, and it is the feature the reporter most wanted. A row one line
       taller after you click something is a far smaller cost than an action you cannot reach.
       The detail still truncates with an ellipsis (full text on hover), so the common case stays on one
       line; the pill labels were shortened to keep it that way, with the reason living in the hint. */
    .testrow { display: flex; gap: 10px; row-gap: 8px; align-items: center; flex-wrap: wrap; min-height: 34px; }
    .testrow > :not(.hint) { flex: none; }
    .testrow .hint { margin: 0; min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* THE BUTTONS DO NOT MOVE WHEN A RESULT ARRIVES.
       A test result is rendered where it belongs in the DOM — next to the button that produced it, which is
       what a screen reader should hear — and that put a pill and a detail line BETWEEN Test and Verify. So
       clicking Test pushed Verify sideways, out from under the pointer that had just been over it: the next
       click landed on whatever had slid into that spot. Visual order is a layout concern, so it is fixed
       here rather than by reordering the markup: actions are laid out first, results after them. Wrapping the
       results in a div instead would also change what assistive tech reads, which is not the bug. */
    .testrow > button { order: 0; }
    .testrow > app-status-pill, .testrow > .hint { order: 1; }
    /* Save belongs to the card it sits in and appears only when that card has an unsaved change, so it
       is pushed to the far end of the row rather than sitting beside Test as a peer action. That rule now
       lives in card-save.component.ts, with the button: view encapsulation scopes these styles to elements
       written in THIS template, so a copy here would match nothing and only look reassuring. */
  `],
  template: `
    <div class="cards">
      <!-- ── Text embedding ─────────────────────────────────────────────── -->
      <app-model-provider-card id="embedding" icon="database"
        [heading]="'mediaProcessing.embedding.title' | transloco"
        [purpose]="'mediaProcessing.embedding.purpose' | transloco"
        [health]="pipeline.modelState('embedding')">
        <app-status-pill pill [variant]="s.embedding.provider === 'external' ? 'active' : 'ok'">
          {{ (s.embedding.provider === 'external' ? 'mediaProcessing.embedding.pillExternal'
              : (s.embedding.baseUrl ? 'mediaProcessing.embedding.pillLocalHttp' : 'mediaProcessing.embedding.pillBundled')) | transloco }}
        </app-status-pill>
        @if (s.embeddingLocked('model')) { <app-status-pill pill variant="env">{{ 'mediaProcessing.pill.env' | transloco }}</app-status-pill> }

        <div class="field">
          <label for="emb-provider">{{ 'mediaProcessing.field.provider' | transloco }}</label>
          <select id="emb-provider" [(ngModel)]="s.embedding.provider" [disabled]="s.embeddingLocked('provider')">
            <option value="local">{{ 'mediaProcessing.embedding.optLocal' | transloco }}</option>
            <option value="external">{{ 'mediaProcessing.embedding.optExternal' | transloco }}</option>
          </select>
        </div>
        <div class="field">
          <label for="emb-endpoint">{{ 'mediaProcessing.field.endpoint' | transloco }}</label>
          <input id="emb-endpoint" data-mono type="url" [(ngModel)]="s.embedding.baseUrl"
            [disabled]="s.embeddingLocked('baseUrl')" [placeholder]="'mediaProcessing.embedding.endpointPlaceholder' | transloco" />
          <div class="hint">{{ 'mediaProcessing.embedding.endpointHint' | transloco }}</div>
        </div>
        <div class="field">
          <label for="emb-model">{{ 'mediaProcessing.field.model' | transloco }}</label>
          <input id="emb-model" data-mono [(ngModel)]="s.embedding.model" [disabled]="s.embeddingLocked('model')" placeholder="nomic-embed-text" />
        </div>
        <div class="grid2">
          <div class="field">
            <label for="emb-dims">{{ 'mediaProcessing.field.dimensions' | transloco }}</label>
            <input id="emb-dims" type="number" min="1" max="16384" [(ngModel)]="s.embedding.dimensions" [disabled]="s.embeddingLocked('dimensions')" />
          </div>
          <div class="field">
            <label for="emb-sim">{{ 'mediaProcessing.field.similarity' | transloco }}</label>
            <select id="emb-sim" [(ngModel)]="s.embedding.similarity" [disabled]="s.embeddingLocked('model')">
              <option value="cosine">cosine</option>
              <option value="dotProduct">dotProduct</option>
              <option value="euclidean">euclidean</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label for="emb-prefix">{{ 'mediaProcessing.embedding.prefixSchemeLabel' | transloco }}</label>
          <select id="emb-prefix" [(ngModel)]="s.embedding.prefixScheme" [disabled]="s.embeddingLocked('prefixScheme')">
            <option value="auto">{{ 'mediaProcessing.embedding.prefixAuto' | transloco }}</option>
            <option value="none">{{ 'mediaProcessing.embedding.prefixNone' | transloco }}</option>
            <option value="nomic">{{ 'mediaProcessing.embedding.prefixNomic' | transloco }}</option>
            <option value="qwen">{{ 'mediaProcessing.embedding.prefixQwen' | transloco }}</option>
          </select>
          <!-- innerHTML, because all three translations of this string carry a <b> around the mode name.
               Interpolated, the reader saw the literal tags: "<b>Auto</b> reproduces what this instance
               did…". Found by looking at a screenshot of this card, not by any test. The reindex warning
               below already renders the same way. -->
          <div class="hint" [innerHTML]="'mediaProcessing.embedding.prefixSchemeHint' | transloco"></div>
        </div>
        @if (s.embeddingLocked('prefixScheme')) { <app-status-pill pill variant="env">{{ 'mediaProcessing.pill.env' | transloco }}</app-status-pill> }
        <div class="field">
          <label for="emb-key">{{ 'mediaProcessing.field.apiKeyExternal' | transloco }}</label>
          <input id="emb-key" type="password" [(ngModel)]="s.embeddingApiKeyInput" [disabled]="s.embeddingLocked('apiKey')"
            [placeholder]="(s.embedding.apiKey ? 'mediaProcessing.field.apiKeyKeep' : 'mediaProcessing.field.apiKeyOptional') | transloco" />
        </div>
        @if (s.embeddingNeedsReindex()) {
          <div class="warnline">
            <ph-icon name="warning" [size]="15"/>
            <span [innerHTML]="'mediaProcessing.embedding.reindexWarning' | transloco"></span>
          </div>
        }

        <div footer class="testrow">
          <button class="btn btn-sm btn-secondary" type="button" (click)="s.testConnection('embedding')"
            [disabled]="s.testOf('embedding')?.loading || !s.embedding.baseUrl">
            {{ (s.testOf('embedding')?.loading ? 'mediaProcessing.action.testing' : 'mediaProcessing.action.test') | transloco }}
          </button>
          <!-- B.4: a dead button and a broken button look identical. With no endpoint the embedder IS the
               bundled in-process model, so there is nothing to probe — a fact about the configuration,
               not a fault, and the same thing classifyStage reports as in-process on the health dot.
               Verify still works: it embeds the word ping locally. -->
          @if (!s.embedding.baseUrl) {
            <!-- Titled, because the row truncates it: the card is narrow enough that the reason reads
                 "In-process mod…", and an explanation you cannot finish reading is the same failure this
                 line exists to fix. -->
            <span class="hint" [attr.title]="'mediaProcessing.test.inProcess' | transloco">{{ 'mediaProcessing.test.inProcess' | transloco }}</span>
          }
          @if (s.testOf('embedding')?.res; as r) {
            <app-status-pill [variant]="s.testPillVariant(r)" [dot]="true">{{ s.testPillLabelKey(r) | transloco }}</app-status-pill>
            <span class="hint" [attr.title]="r.detail || null">{{ r.detail || (r.latencyMs + ' ms') }}</span>
          }
          @if (s.verifyOf('embedding')?.res; as v) {
            <app-status-pill [variant]="s.verifyPillVariant(v)" [dot]="true">{{ s.verifyPillLabelKey(v) | transloco }}</app-status-pill>
            <span class="hint" [attr.title]="v.detail || v.sample || null">{{ v.sample || v.detail || (v.latencyMs + ' ms') }}</span>
          }
          <button class="btn btn-sm btn-secondary" type="button"
            [attr.title]="'mediaProcessing.verify.hint' | transloco"
            [disabled]="s.verifyOf('embedding')?.loading"
            (click)="s.verifyModel('embedding')">
            {{ (s.verifyOf('embedding')?.loading ? 'mediaProcessing.verify.running' : 'mediaProcessing.verify.action') | transloco }}
          </button>
          <app-card-save card="embedding"/>
        </div>
      </app-model-provider-card>

      <!-- ── Reranker ───────────────────────────────────────────────────── -->
      <app-model-provider-card id="rerank" icon="sort-descending"
        [heading]="'mediaProcessing.rerank.title' | transloco"
        [purpose]="'mediaProcessing.rerank.purpose' | transloco"
        [health]="pipeline.modelState('rerank')">
        <app-status-pill pill [variant]="s.rerankConfigured() ? 'active' : 'off'">
          {{ (s.rerankConfigured() ? 'mediaProcessing.rerank.pillOn' : 'mediaProcessing.rerank.pillOff') | transloco }}
        </app-status-pill>
        @if (s.rerankLocked('baseUrl')) { <app-status-pill pill variant="env">{{ 'mediaProcessing.pill.env' | transloco }}</app-status-pill> }

        <div class="field">
          <label for="rr-endpoint">{{ 'mediaProcessing.field.endpoint' | transloco }}</label>
          <input id="rr-endpoint" data-mono type="url" [(ngModel)]="s.rerank.baseUrl"
            [disabled]="s.rerankLocked('baseUrl')" [placeholder]="'mediaProcessing.rerank.endpointPlaceholder' | transloco" />
          <!-- Second instance of the same defect as the task-prefix hint above: this translation marks the
               two URL shapes with <b>, and interpolated they printed as literal tags. Enumerated by
               i18n-markup-rendering.test.js rather than found by eye a second time. -->
          <div class="hint" [innerHTML]="'mediaProcessing.rerank.endpointHint' | transloco"></div>
        </div>
        <div class="field">
          <label for="rr-model">{{ 'mediaProcessing.field.model' | transloco }}</label>
          <input id="rr-model" data-mono [(ngModel)]="s.rerank.model" [disabled]="s.rerankLocked('model')"
            placeholder="BAAI/bge-reranker-v2-m3" />
        </div>
        <div class="field">
          <label for="rr-mult">{{ 'mediaProcessing.rerank.multiplierLabel' | transloco }}</label>
          <input id="rr-mult" type="number" min="2" max="10" [(ngModel)]="s.rerank.candidateMultiplier"
            [disabled]="s.rerankLocked('candidateMultiplier')" />
          <div class="hint">{{ 'mediaProcessing.rerank.multiplierHint' | transloco }}</div>
        </div>
        <div class="field">
          <label for="rr-key">{{ 'mediaProcessing.field.apiKeyExternal' | transloco }}</label>
          <input id="rr-key" type="password" [(ngModel)]="s.rerankApiKeyInput" [disabled]="s.rerankLocked('apiKey')"
            [placeholder]="(s.rerank.apiKey ? 'mediaProcessing.field.apiKeyKeep' : 'mediaProcessing.field.apiKeyOptional') | transloco" />
        </div>
        @if (s.rerankIsExternal()) {
          <div class="warnline">
            <ph-icon name="warning" [size]="15"/>
            <span [innerHTML]="'mediaProcessing.rerank.egressWarning' | transloco"></span>
          </div>
        }

        <div footer class="testrow">
          <button class="btn btn-sm btn-secondary" type="button" (click)="s.testConnection('rerank')"
            [disabled]="s.testOf('rerank')?.loading || !s.rerank.baseUrl">
            {{ (s.testOf('rerank')?.loading ? 'mediaProcessing.action.testing' : 'mediaProcessing.action.test') | transloco }}
          </button>
          @if (s.testOf('rerank')?.res; as r) {
            <app-status-pill [variant]="s.testPillVariant(r)" [dot]="true">{{ s.testPillLabelKey(r) | transloco }}</app-status-pill>
            <span class="hint" [attr.title]="r.detail || null">{{ r.detail || (r.latencyMs + ' ms') }}</span>
          }
          <app-card-save card="rerank"/>
        </div>
      </app-model-provider-card>

      <!-- ── Contradiction judge (NLI) ──────────────────────────────────── -->
      <!-- Configurable by env and config.json since F-REVIEW shipped, and never reachable from the admin
           API or this screen — so the one page that claims to list what the pipeline calls was missing
           it, and an operator had no way to discover why the Contradictions view stayed empty. -->
      <app-model-provider-card id="nli" icon="check-circle"
        [heading]="'mediaProcessing.nli.title' | transloco"
        [purpose]="'mediaProcessing.nli.purpose' | transloco"
        [health]="pipeline.modelState('nli')">
        <app-status-pill pill [variant]="s.nliConfigured() ? 'active' : 'off'">
          {{ (s.nliConfigured() ? 'mediaProcessing.nli.pillOn' : 'mediaProcessing.nli.pillOff') | transloco }}
        </app-status-pill>
        @if (s.nliLocked('baseUrl')) { <app-status-pill pill variant="env">{{ 'mediaProcessing.pill.env' | transloco }}</app-status-pill> }

        <div class="field">
          <label for="nli-endpoint">{{ 'mediaProcessing.field.endpoint' | transloco }}</label>
          <input id="nli-endpoint" data-mono type="url" [(ngModel)]="s.nli.baseUrl"
            [disabled]="s.nliLocked('baseUrl')" [placeholder]="'mediaProcessing.nli.endpointPlaceholder' | transloco" />
          <div class="hint">{{ 'mediaProcessing.nli.endpointHint' | transloco }}</div>
        </div>
        <div class="field">
          <label for="nli-model">{{ 'mediaProcessing.field.model' | transloco }}</label>
          <input id="nli-model" data-mono [(ngModel)]="s.nli.model" [disabled]="s.nliLocked('model')"
            placeholder="MoritzLaurer/deberta-v3-base-zeroshot-v2.0" />
        </div>
        <div class="field">
          <label for="nli-key">{{ 'mediaProcessing.field.apiKeyExternal' | transloco }}</label>
          <input id="nli-key" type="password" [(ngModel)]="s.nliApiKeyInput" [disabled]="s.nliLocked('apiKey')"
            [placeholder]="(s.nli.apiKey ? 'mediaProcessing.field.apiKeyKeep' : 'mediaProcessing.field.apiKeyOptional') | transloco" />
        </div>
        @if (s.nliIsExternal()) {
          <div class="warnline">
            <ph-icon name="warning" [size]="15"/>
            <span [innerHTML]="'mediaProcessing.nli.egressWarning' | transloco"></span>
          </div>
        }

        <div footer class="testrow">
          <button class="btn btn-sm btn-secondary" type="button" (click)="s.testConnection('nli')"
            [disabled]="s.testOf('nli')?.loading || !s.nli.baseUrl">
            {{ (s.testOf('nli')?.loading ? 'mediaProcessing.action.testing' : 'mediaProcessing.action.test') | transloco }}
          </button>
          @if (s.testOf('nli')?.res; as r) {
            <app-status-pill [variant]="s.testPillVariant(r)" [dot]="true">{{ s.testPillLabelKey(r) | transloco }}</app-status-pill>
            <span class="hint" [attr.title]="r.detail || null">{{ r.detail || (r.latencyMs + ' ms') }}</span>
          }
          <app-card-save card="nli"/>
        </div>
      </app-model-provider-card>

      <!-- ── Vision ─────────────────────────────────────────────────────── -->
      <app-model-provider-card id="vision" icon="image"
        [heading]="'mediaProcessing.vision.title' | transloco"
        [purpose]="'mediaProcessing.vision.purpose' | transloco"
        [health]="pipeline.modelState('vision')">
        <app-status-pill pill [variant]="s.mediaClassOn('images') ? 'active' : 'off'">
          {{ (s.form.visionProvider === 'external' ? 'mediaProcessing.pill.external' : 'mediaProcessing.vision.pillLocal') | transloco }}
        </app-status-pill>
        @if (s.isLocked('visionProvider')) { <app-status-pill pill variant="env">{{ 'mediaProcessing.pill.env' | transloco }}</app-status-pill> }

        <div class="field">
          <label for="vis-provider">{{ 'mediaProcessing.field.provider' | transloco }}</label>
          <select id="vis-provider" [(ngModel)]="s.form.visionProvider" [disabled]="s.isLocked('visionProvider')">
            <option value="local">{{ 'mediaProcessing.vision.optLocal' | transloco }}</option>
            <option value="external">{{ 'mediaProcessing.opt.externalOpenAi' | transloco }}</option>
          </select>
        </div>
        <div class="field">
          <label for="vis-endpoint">{{ 'mediaProcessing.field.endpoint' | transloco }}</label>
          <input id="vis-endpoint" data-mono type="url" [(ngModel)]="s.form.vision!.baseUrl" [disabled]="s.isLocked('vision.baseUrl')" placeholder="http://ollama:11434" />
        </div>
        <div class="field">
          <label for="vis-model">{{ 'mediaProcessing.field.model' | transloco }}</label>
          <input id="vis-model" data-mono [(ngModel)]="s.form.vision!.model" [disabled]="s.isLocked('vision.model')" placeholder="moondream" />
        </div>
        <div class="field">
          <label for="vis-key">{{ 'mediaProcessing.field.apiKeyExternal' | transloco }}</label>
          <input id="vis-key" type="password" [(ngModel)]="s.visionApiKeyInput" [disabled]="s.isLocked('vision.apiKey')"
            [placeholder]="'mediaProcessing.field.apiKeyKeep' | transloco" />
        </div>

        <div footer class="testrow">
          <button class="btn btn-sm btn-secondary" type="button" (click)="s.testConnection('vision')" [disabled]="s.testOf('vision')?.loading">
            {{ (s.testOf('vision')?.loading ? 'mediaProcessing.action.testing' : 'mediaProcessing.action.test') | transloco }}
          </button>
          @if (s.testOf('vision')?.res; as r) {
            <app-status-pill [variant]="s.testPillVariant(r)" [dot]="true">{{ s.testPillLabelKey(r) | transloco }}</app-status-pill>
            <span class="hint" [attr.title]="r.detail || null">{{ r.detail || (r.latencyMs + ' ms') }}</span>
          }
          @if (s.verifyOf('vision')?.res; as v) {
            <app-status-pill [variant]="s.verifyPillVariant(v)" [dot]="true">{{ s.verifyPillLabelKey(v) | transloco }}</app-status-pill>
            <span class="hint" [attr.title]="v.detail || v.sample || null">{{ v.sample || v.detail || (v.latencyMs + ' ms') }}</span>
          }
          <button class="btn btn-sm btn-secondary" type="button"
            [attr.title]="'mediaProcessing.verify.hint' | transloco"
            [disabled]="s.verifyOf('vision')?.loading"
            (click)="s.verifyModel('vision')">
            {{ (s.verifyOf('vision')?.loading ? 'mediaProcessing.verify.running' : 'mediaProcessing.verify.action') | transloco }}
          </button>
          <app-card-save card="vision"/>
        </div>
      </app-model-provider-card>

      <!-- ── Speech-to-text ─────────────────────────────────────────────── -->
      <app-model-provider-card id="stt" icon="microphone"
        [heading]="'mediaProcessing.stt.title' | transloco"
        [purpose]="'mediaProcessing.stt.purpose' | transloco"
        [health]="pipeline.modelState('stt')">
        <app-status-pill pill [variant]="s.mediaClassOn('audio') ? 'active' : 'off'">
          {{ (s.form.sttProvider === 'external' ? 'mediaProcessing.pill.external' : 'mediaProcessing.stt.pillLocal') | transloco }}
        </app-status-pill>
        @if (s.isLocked('sttProvider')) { <app-status-pill pill variant="env">{{ 'mediaProcessing.pill.env' | transloco }}</app-status-pill> }

        <div class="field">
          <label for="stt-provider">{{ 'mediaProcessing.field.provider' | transloco }}</label>
          <select id="stt-provider" [(ngModel)]="s.form.sttProvider" [disabled]="s.isLocked('sttProvider')">
            <option value="local">{{ 'mediaProcessing.stt.optLocal' | transloco }}</option>
            <option value="external">{{ 'mediaProcessing.opt.externalOpenAi' | transloco }}</option>
          </select>
        </div>
        <div class="field">
          <label for="stt-endpoint">{{ 'mediaProcessing.field.endpoint' | transloco }}</label>
          <input id="stt-endpoint" data-mono type="url" [(ngModel)]="s.form.stt!.baseUrl" [disabled]="s.isLocked('stt.baseUrl')" placeholder="http://whisper:8000" />
        </div>
        <div class="field">
          <label for="stt-model">{{ 'mediaProcessing.field.model' | transloco }}</label>
          <input id="stt-model" data-mono [(ngModel)]="s.form.stt!.model" [disabled]="s.isLocked('stt.model')" placeholder="base" />
        </div>
        <div class="field">
          <label for="stt-key">{{ 'mediaProcessing.field.apiKeyExternal' | transloco }}</label>
          <input id="stt-key" type="password" [(ngModel)]="s.sttApiKeyInput" [disabled]="s.isLocked('stt.apiKey')"
            [placeholder]="'mediaProcessing.field.apiKeyKeep' | transloco" />
        </div>

        <div footer class="testrow">
          <button class="btn btn-sm btn-secondary" type="button" (click)="s.testConnection('stt')" [disabled]="s.testOf('stt')?.loading">
            {{ (s.testOf('stt')?.loading ? 'mediaProcessing.action.testing' : 'mediaProcessing.action.test') | transloco }}
          </button>
          @if (s.testOf('stt')?.res; as r) {
            <app-status-pill [variant]="s.testPillVariant(r)" [dot]="true">{{ s.testPillLabelKey(r) | transloco }}</app-status-pill>
            <span class="hint" [attr.title]="r.detail || null">{{ r.detail || (r.latencyMs + ' ms') }}</span>
          }
          @if (s.verifyOf('stt')?.res; as v) {
            <app-status-pill [variant]="s.verifyPillVariant(v)" [dot]="true">{{ s.verifyPillLabelKey(v) | transloco }}</app-status-pill>
            <span class="hint" [attr.title]="v.detail || v.sample || null">{{ v.sample || v.detail || (v.latencyMs + ' ms') }}</span>
          }
          <button class="btn btn-sm btn-secondary" type="button"
            [attr.title]="'mediaProcessing.verify.hint' | transloco"
            [disabled]="s.verifyOf('stt')?.loading"
            (click)="s.verifyModel('stt')">
            {{ (s.verifyOf('stt')?.loading ? 'mediaProcessing.verify.running' : 'mediaProcessing.verify.action') | transloco }}
          </button>
          <app-card-save card="stt"/>
        </div>
      </app-model-provider-card>

      <!-- ── External assist model ──────────────────────────────────────── -->
      <app-model-provider-card id="assist" icon="globe"
        [heading]="'mediaProcessing.assist.title' | transloco"
        [purpose]="'mediaProcessing.assist.purpose' | transloco"
        [health]="pipeline.modelState('assist')">
        <app-status-pill pill [variant]="s.assistLocked() ? 'env' : (s.assistInUse() ? 'active' : 'off')">
          {{ (s.assistLocked() ? 'mediaProcessing.pill.env' : (s.assistInUse() ? 'mediaProcessing.assist.pillInUse' : 'mediaProcessing.assist.pillUnset')) | transloco }}
        </app-status-pill>
        <!-- Moved out of the footer, where it was effectively invisible. -->
        @if (s.assist.acknowledgedHost && !s.assistNeedsAck()) {
          <app-status-pill pill variant="ok">{{ 'mediaProcessing.assist.pillAcknowledged' | transloco: { host: s.assist.acknowledgedHost } }}</app-status-pill>
        }

        <div class="field">
          <label for="assist-endpoint">{{ 'mediaProcessing.assist.endpointLabel' | transloco }}</label>
          <input id="assist-endpoint" data-mono type="url" [(ngModel)]="s.assist.baseUrl" [disabled]="s.assistLocked()" placeholder="https://api.example.com" />
        </div>
        <div class="field">
          <label for="assist-model">{{ 'mediaProcessing.field.model' | transloco }}</label>
          <input id="assist-model" data-mono [(ngModel)]="s.assist.model" [disabled]="s.assistLocked()"
            [placeholder]="'mediaProcessing.assist.modelPlaceholder' | transloco" />
        </div>
        <div class="field">
          <label for="assist-key">{{ 'mediaProcessing.field.apiKey' | transloco }}</label>
          <input id="assist-key" type="password" [(ngModel)]="s.assistApiKeyInput" [disabled]="s.assistLocked()"
            [placeholder]="(s.assist.apiKey ? 'mediaProcessing.field.apiKeyKeep' : 'mediaProcessing.field.apiKeyOptional') | transloco" />
        </div>
        <!-- Documents: the extraction rung is the switch — raise Document extraction to repair (or auto) and
             the documents acknowledgement is demanded. Conversations are consented below, on their own (F-35). -->
        <div class="hint" style="margin-bottom:10px;">{{ 'mediaProcessing.assist.gatedByPipeline' | transloco }}</div>
        <app-assist-egress-consent /><app-assist-extras />

        <div footer class="testrow">
          <button class="btn btn-sm btn-secondary" type="button" (click)="s.testConnection('assist')"
            [disabled]="s.testOf('assist')?.loading || !s.assist.baseUrl">
            {{ (s.testOf('assist')?.loading ? 'mediaProcessing.action.testing' : 'mediaProcessing.action.test') | transloco }}
          </button>
          @if (s.testOf('assist')?.res; as r) {
            <app-status-pill [variant]="s.testPillVariant(r)" [dot]="true">{{ s.testPillLabelKey(r) | transloco }}</app-status-pill>
            <span class="hint" [attr.title]="r.detail || null">{{ r.detail || (r.latencyMs + ' ms') }}</span>
          }
          @if (s.verifyOf('assist')?.res; as v) {
            <app-status-pill [variant]="s.verifyPillVariant(v)" [dot]="true">{{ s.verifyPillLabelKey(v) | transloco }}</app-status-pill>
            <span class="hint" [attr.title]="v.detail || v.sample || null">{{ v.sample || v.detail || (v.latencyMs + ' ms') }}</span>
          }
          <button class="btn btn-sm btn-secondary" type="button"
            [attr.title]="'mediaProcessing.verify.hint' | transloco"
            [disabled]="s.verifyOf('assist')?.loading"
            (click)="s.verifyModel('assist')">
            {{ (s.verifyOf('assist')?.loading ? 'mediaProcessing.verify.running' : 'mediaProcessing.verify.action') | transloco }}
          </button>
          <app-card-save card="assist"/>
        </div>
      </app-model-provider-card>
      <app-decision-model-card/>

      <!-- ── Document VLM / repair / verify (env-only) ──────────────────── -->
      <!-- These had NO cards. A customer's ticket enumerated nine model endpoints from this screen and
           missed vlmModel, which is the tenth — and the Pipelines tab pointed its step at the VISION
           card, showing a different value, so the tenth was displayed as if it were one of the nine.
           Their MODEL and ENDPOINT are env-only (no PATCH schema accepts them), so those render read-only
           with the env badge, the way the storage pins do: visible even when unsettable. Their per-slot
           budget and reasoning effort are NOT env-only -- there is deliberately no environment variable for
           those at all -- so the card renders its slot control and a Save for it. One flag was answering
           both questions, which left three of the ten slot budgets with no door anywhere. -->
      <!-- Written out rather than looped: the completeness gate greps for a literal card element with a
           literal id attribute, and a card that only exists behind a binding is a card the gate cannot
           see. Three repetitions is a fair price for a check that cannot be fooled.
           (No backticks anywhere in this comment - one would terminate the inline template literal, and
           the resulting error points at the decorator rather than at the comment.) -->
      <app-model-provider-card id="doc-vlm" icon="file-image"
        [heading]="'mediaProcessing.docVlm.title' | transloco"
        [purpose]="'mediaProcessing.docVlm.purpose' | transloco"
        [health]="pipeline.modelState('doc-vlm')"
        [infra]="true" envVar="DOC_VLM_MODEL">
        <div class="field">
          <label>{{ 'mediaProcessing.field.model' | transloco }}</label>
          <div class="ro">{{ s.docCfg().vlmModel || ('mediaProcessing.docSlot.notSet' | transloco) }}</div>
        </div>
        <div class="field">
          <label>{{ 'mediaProcessing.field.endpoint' | transloco }}</label>
          <div class="ro">{{ s.docCfg().vlmBaseUrl || ('mediaProcessing.docSlot.inheritsVision' | transloco) }}</div>
        </div>
              <div footer class="testrow">
          <app-card-save card="doc-vlm"/>
        </div>
      </app-model-provider-card>

      <app-model-provider-card id="doc-repair" icon="file-image"
        [heading]="'mediaProcessing.docRepair.title' | transloco"
        [purpose]="'mediaProcessing.docRepair.purpose' | transloco"
        [health]="pipeline.modelState('doc-repair')"
        [infra]="true" envVar="DOC_REPAIR_MODEL">
        <div class="field">
          <label>{{ 'mediaProcessing.field.model' | transloco }}</label>
          <div class="ro">{{ s.docCfg().repairModel || s.docCfg().vlmModel || ('mediaProcessing.docSlot.notSet' | transloco) }}</div>
        </div>
        <div class="field">
          <label>{{ 'mediaProcessing.field.endpoint' | transloco }}</label>
          <div class="ro">{{ s.docCfg().repairBaseUrl || s.docCfg().vlmBaseUrl || ('mediaProcessing.docSlot.inheritsVision' | transloco) }}</div>
        </div>
              <div footer class="testrow">
          <app-card-save card="doc-repair"/>
        </div>
      </app-model-provider-card>

      <app-model-provider-card id="doc-verify" icon="file-image"
        [heading]="'mediaProcessing.docVerify.title' | transloco"
        [purpose]="'mediaProcessing.docVerify.purpose' | transloco"
        [health]="pipeline.modelState('doc-verify')"
        [infra]="true" envVar="DOC_VERIFY_MODEL">
        <div class="field">
          <label>{{ 'mediaProcessing.field.model' | transloco }}</label>
          <div class="ro">{{ s.docCfg().verifyModel || ('mediaProcessing.docSlot.notSet' | transloco) }}</div>
        </div>
        <div class="field">
          <label>{{ 'mediaProcessing.field.endpoint' | transloco }}</label>
          <div class="ro">{{ s.docCfg().verifyBaseUrl || s.docCfg().vlmBaseUrl || ('mediaProcessing.docSlot.inheritsVision' | transloco) }}</div>
        </div>
              <div footer class="testrow">
          <app-card-save card="doc-verify"/>
        </div>
      </app-model-provider-card>

      <!-- ── Sidecars (infra): one line each, so a new one cannot ship without its card ── -->
      <app-sidecar-card id="doc-render" icon="file-image" copy="render" envVar="RENDER_SIDECAR_URL"/>
      <!-- "stack": the registry has no Office glyph, and an unregistered ph-icon name renders nothing. -->
      <app-sidecar-card id="doc-office" icon="stack" copy="office" envVar="RENDER_OFFICE_SIDECAR_URL"/>
      <app-sidecar-card id="unstructured" icon="file" copy="converter" envVar="CONVERSION_SIDECAR_URL"/>
      <app-sidecar-card id="doc-nlp" icon="text-align-left" copy="nlp" envVar="NLP_SIDECAR_URL"/>

      <!-- ── Face recognition ───────────────────────────────────────────── -->
      <!-- The one model in the pipeline an operator could not switch off: it was absent from the
           client entirely and from the PATCH schema, so opting out meant filesystem access. For a
           feature that detects and embeds people's faces that was the wrong default. -->
      <app-model-provider-card id="face" icon="user"
        [heading]="'mediaProcessing.face.title' | transloco"
        [purpose]="'mediaProcessing.face.purpose' | transloco"
        [health]="faceState()"
        [infra]="s.faceExternalLocked()" envVar="FACE_RECOGNITION_EXTERNAL_MODEL">

        <!-- Two decisions, labelled separately. See FACE_CARD_NOTES above the class. -->
        <!-- No enable switch: face recognition is turned on by raising the IMAGE pipeline to its
             recognition rung (instance ceiling here, then per space), so the ladder is the single
             control. faceRecognition.enabled still exists as an infra/env pin, deliberately not
             editable here. -->
        <div class="hint" style="margin-bottom:12px;">{{ 'mediaProcessing.face.gatedByPipeline' | transloco }}</div>

        @if (s.faceLocked('enabled')) {
          <div class="hint" style="margin-bottom:12px;">
            {{ 'mediaProcessing.face.enabledPinned' | transloco }}
          </div>
        }

        @if (s.faceAwaitingAcknowledgment()) {
          <div class="warnline">
            <ph-icon name="warning" [size]="15"/>
            <span>{{ 'mediaProcessing.face.awaitingAck' | transloco: { host: s.faceExternalHost() } }}</span>
          </div>
        }

        <!-- Optional external provider. In-process (BlazeFace + FaceRes) stays the default and the
             fallback, so leaving this empty changes nothing. -->
        <div class="field">
          <label for="face-endpoint">{{ 'mediaProcessing.face.endpoint' | transloco }}</label>
          <input id="face-endpoint" data-mono type="url" [(ngModel)]="s.faceExternal.baseUrl"
            [disabled]="s.faceExternalLocked() || s.managed" placeholder="https://faces.example.com/embed" />
          <div class="hint">{{ 'mediaProcessing.face.endpointHint' | transloco }}</div>
        </div>
        @if (s.faceExternalConfigured()) {
          <div class="grid2">
            <div class="field">
              <label for="face-ext-model">{{ 'mediaProcessing.face.externalModelName' | transloco }}</label>
              <input id="face-ext-model" data-mono [(ngModel)]="s.faceExternal.model"
                [disabled]="s.faceExternalLocked() || s.managed" />
            </div>
            <div class="field">
              <label for="face-key">{{ 'mediaProcessing.face.apiKey' | transloco }}</label>
              <input id="face-key" type="password" [(ngModel)]="s.faceApiKeyInput"
                [disabled]="s.faceExternalLocked() || s.managed"
                [placeholder]="'mediaProcessing.face.apiKeyPlaceholder' | transloco" />
            </div>
          </div>
          @if (s.faceExternalNeedsAck()) {
            <div class="alert alert-warning" style="font-size:12px;margin-bottom:12px;">
              {{ 'mediaProcessing.face.egressPending' | transloco: { host: s.faceExternalHost() } }}
            </div>
          } @else {
            <app-status-pill [variant]="'ok'">{{ 'mediaProcessing.face.egressAcknowledged' | transloco: { host: s.faceExternal.acknowledgedHost } }}</app-status-pill>
          }
        }

        <div class="grid2">
          <div class="field">
            <label for="face-conf">{{ 'mediaProcessing.face.confidence' | transloco }}</label>
            <input id="face-conf" type="number" min="0" max="1" step="0.05"
              [(ngModel)]="s.face.confidenceThreshold" [disabled]="s.faceLocked('confidenceThreshold') || s.managed" />
            <div class="hint">{{ 'mediaProcessing.face.confidenceHint' | transloco }}</div>
          </div>
          <div class="field">
            <label for="face-minsize">{{ 'mediaProcessing.face.minSize' | transloco }}</label>
            <input id="face-minsize" type="number" min="0" max="1" step="0.01"
              [(ngModel)]="s.face.minFaceSizeFraction" [disabled]="s.faceLocked('minFaceSizeFraction') || s.managed" />
            <div class="hint">{{ 'mediaProcessing.face.minSizeHint' | transloco }}</div>
          </div>
        </div>

        <div class="field">
          <label>{{ 'mediaProcessing.face.personTypes' | transloco }}</label>
          @if (s.face.personEntityTypes?.length) {
            <div class="ptype-chips">
              @for (t of s.face.personEntityTypes; track t) {
                <span class="ptype-chip">{{ t }}
                  @if (!(s.faceLocked('personEntityTypes') || s.managed)) {
                    <button type="button" class="ptype-rm" [attr.aria-label]="'common.remove' | transloco" (click)="removePersonType(t)"><ph-icon name="x" [size]="11"/></button>
                  }
                </span>
              }
            </div>
          }
          @if (!(s.faceLocked('personEntityTypes') || s.managed)) {
            @if (availablePersonTypes().length) {
              <select [ngModel]="''" (ngModelChange)="addPersonType($event)" [attr.aria-label]="'mediaProcessing.face.personTypesAdd' | transloco">
                <option value="" disabled>{{ 'mediaProcessing.face.personTypesAdd' | transloco }}</option>
                @for (t of availablePersonTypes(); track t) { <option [value]="t">{{ t }}</option> }
              </select>
            } @else if (!libEntityTypes().length) {
              <div class="hint">{{ 'mediaProcessing.face.personTypesEmpty' | transloco }}</div>
            }
          }
          <div class="hint">{{ 'mediaProcessing.face.personTypesHint' | transloco }}</div>
        </div>

        <div class="field" style="margin-bottom:0;">
          <label>{{ 'mediaProcessing.face.actorLabel' | transloco }}</label>
          <div class="ro">BlazeFace + FaceRes</div>
        </div>
        <div footer class="testrow">
          <app-card-save card="face"/>
        </div>
      </app-model-provider-card>
    </div>
  `,
})
/**
 * FACE_CARD_NOTES — why the face card labels two things separately, and the two prose rules above it.
 *
 * ## PROSE RULES INSIDE THE TEMPLATE, both load-bearing
 *
 * **No backtick.** The inline template is a template literal, so one backtick ends the string and the error
 * lands on `@Component`, nowhere near the line that caused it.
 *
 * **No apostrophe.** The markup walk in `_structural-window.mjs` lexes quotes, so a stray `'` in a comment
 * opened a phantom string that swallowed the braces after it. That is how a comment edit here silently blinded
 * `infra-managed-locks-every-field` to two enclosing `@if` guards, after which it reported a correctly guarded
 * control as a defect. The walk now skips comments, so the hazard is gone — but long prose belongs in a JS
 * comment like this one regardless, where it is neither lexed as markup nor counted as code.
 *
 * ## The card names what it EDITS, which is the endpoint
 *
 * It used to pass `faceLocked('enabled')` as its whole-card infra flag, so pinning `FACE_RECOGNITION_ENABLED`
 * dimmed the entire card to 62% and labelled it "Set by infra" while every control inside stayed operable and
 * governed by a different variable. An operator read that as "none of this is mine" and reported the endpoint
 * as unconfigurable. The assist card — the direct analogue — has never claimed whole-card ownership from a
 * field it does not edit.
 *
 * Owner ruling P-12 (A), 2026-08-20: *"may this instance use faces"* belongs to infra, *"may crops leave for
 * this host"* belongs to the operator. So the enable pin gets its own line saying what it does and does not
 * reach, and the card's dimming follows the endpoint lock.
 *
 * ## And the awaiting-acknowledgement notice
 *
 * Configured, stored, and NOT IN USE — a state that became reachable when consent moved to gating USE rather
 * than the validity of the config. It is silent by nature: faces fall back to the in-process model exactly as
 * they would for an unreachable endpoint. Quiet is right for *unreachable*, which nobody chose, and wrong for
 * *unacknowledged*, which is a decision waiting on a person. So the card says so rather than letting it be met
 * as a refusal.
 */
export class ModelsTabComponent implements OnInit {
  readonly s = inject(MediaProcessingStateService);
  readonly pipeline = inject(PipelineStatusService);
  private schemaApi = inject(SchemaApi);

  /** Face recognition runs in-process, so its only health is enabled/disabled. */
  faceState = computed(() => this.pipeline.status()?.faceRecognition.state ?? null);

  /** Entity type names defined in the Schema Library — the source for the person-types picker. */
  readonly libEntityTypes = signal<string[]>([]);

  ngOnInit(): void {
    // Load the library once so the person-types picker can offer known entity types by name.
    this.schemaApi.listSchemaLibrary().subscribe({
      next: ({ entries }) => this.libEntityTypes.set(
        [...new Set(entries.filter(e => e.knowledgeType === 'entity').map(e => e.typeName))].sort(),
      ),
      error: () => this.libEntityTypes.set([]),
    });
  }

  /**
   * Person entity types govern the face gallery: only entities of these types are ever auto-labelled.
   * They are picked from the Schema Library's entity types (below), but any value already stored — e.g.
   * from before this was library-backed, or a type since removed from the library — stays selectable
   * and removable so nothing silently drops.
   */
  private personTypes(): string[] { return this.s.face.personEntityTypes ?? []; }

  /**
   * Library entity types not already selected — the options the "add" dropdown offers. Deliberately a
   * method, not a computed: `s.face.personEntityTypes` is a plain field (not a signal), so a computed
   * would never re-run when the selection changes; a method re-evaluates every change-detection pass.
   */
  availablePersonTypes(): string[] {
    const selected = new Set(this.s.face.personEntityTypes ?? []);
    return this.libEntityTypes().filter(t => !selected.has(t));
  }

  addPersonType(type: string): void {
    const t = type.trim();
    if (!t || this.personTypes().includes(t)) return;
    this.s.face.personEntityTypes = [...this.personTypes(), t];
    this.s.touched.set(true);   // programmatic change — the page's input listener won't see it
  }

  removePersonType(type: string): void {
    this.s.face.personEntityTypes = this.personTypes().filter(t => t !== type);
    this.s.touched.set(true);
  }



  /** Narrows the string union for `testConnection` call sites in the template. */
  target(t: TestTarget): TestTarget { return t; }
}
