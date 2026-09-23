/**
 * The Models tab's card for the extractors' decision model (`F-31`).
 *
 * The model the extractors ask their judgement questions — *which of these people is "she"*, *is this turn
 * pasted material*. It defaults to TypeSafe's System One (`https://api.typesafe.ai`, `jev-latest`); without
 * consent to its host the extractors fall back to the assist model, and with neither they refuse to run.
 *
 * Its own component because `models-tab.component.ts` is frozen at its size (`no-new-god-files`), and a card
 * is the natural unit to move out: it owns its fields, its consent notice and its Save. The styles below are
 * the few it uses, restated rather than inherited — view encapsulation scopes the tab's rules to elements
 * written in the TAB's template, so without these the fields would render unstyled and look broken.
 *
 * `:host { display: contents }` so the provider card inside is the grid item, like every sibling card, and
 * the row keeps its shared footer baseline.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../../shared/ph-icon.component';
import { StatusPillComponent } from '../../../shared/status-pill.component';
import { ModelProviderCardComponent } from './model-provider-card.component';
import { CardSaveComponent } from './card-save.component';
import { MediaProcessingStateService } from './media-processing-state.service';

@Component({
  selector: 'app-decision-model-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Default,
  imports: [FormsModule, TranslocoPipe, PhIconComponent, StatusPillComponent, ModelProviderCardComponent, CardSaveComponent],
  styles: [`
    :host { display: contents; }
    .field { margin-bottom: 13px; }
    .field > label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 5px; font-weight: 500; }
    .field input[data-mono] { font-family: var(--font-mono, monospace); }
    .field input:disabled { opacity: .6; cursor: not-allowed; }
    .hint { font-size: 11.5px; color: var(--text-muted); margin-top: 5px; }
    .warnline { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 10px 12px;
      border-radius: 9px; font-size: 12.5px; border: 1px solid var(--warning-border); background: var(--warning-bg); }
    .warnline ph-icon { flex: none; margin-top: 1px; }
    .testrow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; min-height: 34px; }
  `],
  template: `
    <app-model-provider-card id="decision" icon="question"
      [heading]="'mediaProcessing.decision.title' | transloco"
      [purpose]="'mediaProcessing.decision.purpose' | transloco">
      <app-status-pill pill [variant]="s.decisionLocked() ? 'env' : (s.decisionInUse() ? 'active' : 'off')">
        {{ (s.decisionLocked() ? 'mediaProcessing.pill.env' : (s.decisionInUse() ? 'mediaProcessing.decision.pillInUse' : 'mediaProcessing.decision.pillUnset')) | transloco }}
      </app-status-pill>
      @if (s.decisionInUse()) {
        <app-status-pill pill variant="ok">{{ 'mediaProcessing.assist.pillAcknowledged' | transloco: { host: s.decision.acknowledgedHost } }}</app-status-pill>
      }

      <div class="field">
        <label for="decision-endpoint">{{ 'mediaProcessing.decision.endpointLabel' | transloco }}</label>
        <input id="decision-endpoint" data-mono type="url" [(ngModel)]="s.decision.baseUrl" [disabled]="s.decisionLocked()"
          placeholder="https://api.typesafe.ai" />
      </div>
      <div class="field">
        <label for="decision-model">{{ 'mediaProcessing.field.model' | transloco }}</label>
        <input id="decision-model" data-mono [(ngModel)]="s.decision.model" [disabled]="s.decisionLocked()" placeholder="jev-latest" />
      </div>
      <div class="field">
        <label for="decision-key">{{ 'mediaProcessing.field.apiKey' | transloco }}</label>
        <input id="decision-key" type="password" [(ngModel)]="s.decisionApiKeyInput" [disabled]="s.decisionLocked()"
          [placeholder]="(s.decisionKeySet() ? 'mediaProcessing.field.apiKeyKeep' : 'mediaProcessing.field.apiKeyOptional') | transloco" />
      </div>
      <div class="hint">{{ 'mediaProcessing.decision.fallback' | transloco }}</div>
      <div class="warnline">
        <ph-icon name="warning" [size]="15"/>
        <span>
          {{ 'mediaProcessing.decision.egressWarning' | transloco }}
          @if (s.decisionNeedsAck()) { {{ 'mediaProcessing.assist.egressPending' | transloco: { host: s.decisionHost() } }} }
        </span>
      </div>

      <div footer class="testrow">
        <app-card-save card="decision"/>
      </div>
    </app-model-provider-card>
  `,
})
export class DecisionModelCardComponent {
  readonly s = inject(MediaProcessingStateService);
}
