/**
 * The assist model's API kind, token budget and fallback (`F-33`, `F-33.1`) — inside its card on the Models tab.
 *
 * Owner, 2026-09-24: a big hosted model with x tokens every y hours, and a local LLM when it is unreachable or
 * spent. And 2026-09-25: the assist slot can be a Claude model through the Claude API. The API kind sits here with
 * the rest because the endpoint's wire decides how its key is sent and how its usage is counted.
 *
 * What the card shows is what the server decides: `assist` on the pipeline status says which endpoint answers each
 * use now and what the window has spent, so the operator sees a spent budget or a cooling primary instead of
 * inferring it from slower answers.
 *
 * Its own component because `models-tab.component.ts` is frozen at its size (`no-new-god-files`). The styles are
 * restated rather than inherited: view encapsulation scopes the tab's rules to elements in the TAB's template.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { StatusPillComponent } from '../../../shared/status-pill.component';
import { MediaProcessingStateService } from './media-processing-state.service';
import { PipelineStatusService } from './pipeline-status.service';
import { hostOf, isLocalEndpoint } from './assist-extras';
import type { AssistBudgetCfg, AssistFallbackCfg } from './media-processing.types';

@Component({
  selector: 'app-assist-extras',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Default,
  imports: [FormsModule, TranslocoPipe, StatusPillComponent],
  styles: [`
    :host { display: block; }
    .field input[data-mono] { font-family: var(--font-mono, monospace); }
    .field input:disabled, .field select:disabled { opacity: .6; cursor: not-allowed; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
    @media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
    .hint { font-size: 11.5px; color: var(--text-muted); margin: 5px 0 8px; }
    .section { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
    .section h4 { margin: 0 0 8px; font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; min-height: 34px; }
  `],
  template: `
    <div class="field">
      <label for="assist-api">{{ 'mediaProcessing.assist.apiLabel' | transloco }}</label>
      <select id="assist-api" [(ngModel)]="s.assist.api" [disabled]="s.assistLocked()">
        <option [ngValue]="undefined">{{ 'mediaProcessing.assist.apiOpenai' | transloco }}</option>
        <option ngValue="anthropic">{{ 'mediaProcessing.assist.apiAnthropic' | transloco }}</option>
      </select>
      @if (s.assist.api === 'anthropic') {
        <div class="hint">{{ 'mediaProcessing.assist.apiAnthropicHint' | transloco }}</div>
      }
    </div>

    <div class="section">
      <h4>{{ 'mediaProcessing.assist.budgetTitle' | transloco }}</h4>
      <div class="hint">{{ 'mediaProcessing.assist.budgetHint' | transloco }}</div>
      <div class="grid2">
        <div class="field">
          <label for="assist-budget-tokens">{{ 'mediaProcessing.assist.budgetTokens' | transloco }}</label>
          <input id="assist-budget-tokens" type="number" min="1" step="1000" [disabled]="s.assistLocked()"
            [ngModel]="budget().tokens || null" (ngModelChange)="setBudget({ tokens: +$event || 0 })" />
        </div>
        <div class="field">
          <label for="assist-budget-hours">{{ 'mediaProcessing.assist.budgetHours' | transloco }}</label>
          <input id="assist-budget-hours" type="number" min="1" max="720" step="1" [disabled]="s.assistLocked()"
            [ngModel]="budget().perHours || null" (ngModelChange)="setBudget({ perHours: +$event || 0 })" />
        </div>
      </div>
      @if (pipeline.status()?.assist; as st) {
        <div class="row">
          <app-status-pill [variant]="st.answeredBy.repair === 'fallback' || st.answeredBy.conversations === 'fallback' ? 'warn' : 'ok'">
            {{ 'mediaProcessing.assist.answeringNow' | transloco: { repair: whoKey(st.answeredBy.repair) | transloco, conversations: whoKey(st.answeredBy.conversations) | transloco } }}
          </app-status-pill>
          @if (st.budget) {
            <span class="hint">{{ 'mediaProcessing.assist.spent' | transloco: { spent: st.spent, tokens: st.budget.tokens, hours: st.budget.perHours } }}</span>
          }
          @if (st.primaryCoolingDown) {
            <app-status-pill variant="warn">{{ 'mediaProcessing.assist.coolingDown' | transloco }}</app-status-pill>
          }
        </div>
      }
    </div>

    <div class="section">
      <h4>{{ 'mediaProcessing.assist.fallbackTitle' | transloco }}</h4>
      <div class="hint">{{ 'mediaProcessing.assist.fallbackHint' | transloco }}</div>
      <div class="field">
        <label for="assist-fb-api">{{ 'mediaProcessing.assist.apiLabel' | transloco }}</label>
        <select id="assist-fb-api" [ngModel]="fallback().api" (ngModelChange)="setFallback({ api: $event })" [disabled]="s.assistLocked()">
          <option [ngValue]="undefined">{{ 'mediaProcessing.assist.apiOpenai' | transloco }}</option>
          <option ngValue="anthropic">{{ 'mediaProcessing.assist.apiAnthropic' | transloco }}</option>
        </select>
      </div>
      <div class="field">
        <label for="assist-fb-endpoint">{{ 'mediaProcessing.assist.endpointLabel' | transloco }}</label>
        <input id="assist-fb-endpoint" data-mono type="url" placeholder="http://ollama:11434/v1" [disabled]="s.assistLocked()"
          [ngModel]="fallback().baseUrl" (ngModelChange)="setFallback({ baseUrl: $event })" />
      </div>
      <div class="grid2">
        <div class="field">
          <label for="assist-fb-model">{{ 'mediaProcessing.field.model' | transloco }}</label>
          <input id="assist-fb-model" data-mono [disabled]="s.assistLocked()"
            [ngModel]="fallback().model" (ngModelChange)="setFallback({ model: $event })" />
        </div>
        <div class="field">
          <label for="assist-fb-key">{{ 'mediaProcessing.field.apiKey' | transloco }}</label>
          <input id="assist-fb-key" type="password" [(ngModel)]="s.assistFallbackApiKeyInput" [disabled]="s.assistLocked()"
            [placeholder]="(s.assistFallbackKeySet ? 'mediaProcessing.field.apiKeyKeep' : 'mediaProcessing.field.apiKeyOptional') | transloco" />
        </div>
      </div>
      @if (fallbackHost() && !fallbackLocal()) {
        <div class="hint">{{ 'mediaProcessing.assist.fallbackExternal' | transloco: { host: fallbackHost() } }}</div>
        <div class="row">
          @if (fallback().acknowledgedHostForConversations === fallbackHost()) {
            <app-status-pill variant="ok">{{ 'mediaProcessing.assist.pillConversations' | transloco: { host: fallbackHost() } }}</app-status-pill>
            <button class="btn btn-sm btn-secondary" type="button" [disabled]="s.assistLocked()"
              (click)="setFallback({ acknowledgedHostForConversations: undefined })">{{ 'mediaProcessing.assist.conversationsWithdraw' | transloco }}</button>
          } @else {
            <button class="btn btn-sm btn-secondary" type="button" [disabled]="s.assistLocked()"
              (click)="setFallback({ acknowledgedHostForConversations: fallbackHost() })">{{ 'mediaProcessing.assist.conversationsAllow' | transloco }}</button>
          }
        </div>
      }
      @if (fallback().baseUrl) {
        <div class="row">
          <button class="btn btn-sm btn-secondary" type="button" (click)="s.testConnection('assist-fallback')"
            [disabled]="s.testOf('assist-fallback')?.loading">
            {{ (s.testOf('assist-fallback')?.loading ? 'mediaProcessing.action.testing' : 'mediaProcessing.action.test') | transloco }}
          </button>
          @if (s.testOf('assist-fallback')?.res; as r) {
            <app-status-pill [variant]="s.testPillVariant(r)" [dot]="true">{{ s.testPillLabelKey(r) | transloco }}</app-status-pill>
            <span class="hint" [attr.title]="r.detail || null">{{ r.detail || (r.latencyMs + ' ms') }}</span>
          }
          <button class="btn btn-sm btn-secondary" type="button" [attr.title]="'mediaProcessing.verify.hint' | transloco"
            [disabled]="s.verifyOf('assist-fallback')?.loading" (click)="s.verifyModel('assist-fallback')">
            {{ (s.verifyOf('assist-fallback')?.loading ? 'mediaProcessing.verify.running' : 'mediaProcessing.verify.action') | transloco }}
          </button>
          @if (s.verifyOf('assist-fallback')?.res; as v) {
            <app-status-pill [variant]="s.verifyPillVariant(v)" [dot]="true">{{ s.verifyPillLabelKey(v) | transloco }}</app-status-pill>
          }
        </div>
      }
    </div>
  `,
})
export class AssistExtrasComponent {
  readonly s = inject(MediaProcessingStateService);
  readonly pipeline = inject(PipelineStatusService);

  budget(): Partial<AssistBudgetCfg> { return this.s.assist.budget ?? {}; }
  setBudget(patch: Partial<AssistBudgetCfg>): void {
    const next = { tokens: 0, perHours: 0, ...this.s.assist.budget, ...patch };
    this.s.assist.budget = next.tokens > 0 || next.perHours > 0 ? next : null;
  }

  fallback(): AssistFallbackCfg { return this.s.assist.fallback ?? {}; }
  setFallback(patch: Partial<AssistFallbackCfg>): void {
    const next: AssistFallbackCfg = { ...this.s.assist.fallback, ...patch };
    // A new host withdraws both consents: they name the host they were given for.
    if ('baseUrl' in patch && hostOf(patch.baseUrl) !== hostOf(this.s.assist.fallback?.baseUrl)) {
      delete next.acknowledgedHost;
      delete next.acknowledgedHostForConversations;
    }
    if ('acknowledgedHostForConversations' in patch && !patch.acknowledgedHostForConversations) delete next.acknowledgedHostForConversations;
    this.s.assist.fallback = next;
  }
  fallbackHost(): string { return hostOf(this.s.assist.fallback?.baseUrl); }
  fallbackLocal(): boolean { return isLocalEndpoint(this.s.assist.fallback?.baseUrl); }

  whoKey(which: 'primary' | 'fallback' | null): string {
    return which === 'primary' ? 'mediaProcessing.assist.whoPrimary'
      : which === 'fallback' ? 'mediaProcessing.assist.whoFallback' : 'mediaProcessing.assist.whoNone';
  }
}
