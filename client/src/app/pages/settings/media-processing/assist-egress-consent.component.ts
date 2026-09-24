/**
 * What the External assist model sends, and the consent for each use (`F-35`) — inside its card on the Models tab.
 *
 * The assist model does two jobs that send different things — the document repair pass, and conversation work
 * for ingest. Each is consented on its own: this control allows or withdraws conversations, and allowing opens a
 * dialog naming what they send; the documents warning above it says what the repair pass sends, and is
 * acknowledged on the card's save when the extraction rung reaches the endpoint. A button rather than a checkbox, because allowing is asked first and a checkbox
 * would show "on" while the operator is still deciding.
 *
 * Its own component because `models-tab.component.ts` is frozen at its size (`no-new-god-files`). The styles are
 * restated rather than inherited: view encapsulation scopes the tab's rules to elements in the TAB's template.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../../shared/ph-icon.component';
import { StatusPillComponent } from '../../../shared/status-pill.component';
import { MediaProcessingStateService } from './media-processing-state.service';

@Component({
  selector: 'app-assist-egress-consent',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Default,
  imports: [TranslocoPipe, PhIconComponent, StatusPillComponent],
  styles: [`
    :host { display: block; }
    .hint { font-size: 11.5px; color: var(--text-muted); margin: 10px 0 6px; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; min-height: 34px; }
    .warnline { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 10px 12px;
      border-radius: 9px; font-size: 12.5px; border: 1px solid var(--warning-border); background: var(--warning-bg); }
    .warnline ph-icon { flex: none; margin-top: 1px; }
  `],
  template: `
    <div class="warnline">
      <ph-icon name="warning" [size]="15"/>
      <span>
        {{ 'mediaProcessing.assist.egressWarning' | transloco }}
        @if (s.assistNeedsAck()) { {{ 'mediaProcessing.assist.egressPending' | transloco: { host: s.assistHost() } }} }
      </span>
    </div>
    @if (s.assistHost()) {
      <div class="hint">{{ 'mediaProcessing.assist.conversationsHint' | transloco: { host: s.assistHost() } }}</div>
      <div class="row">
        @if (s.assistConversationsConsented()) {
          <app-status-pill variant="ok">{{ 'mediaProcessing.assist.pillConversations' | transloco: { host: s.assistHost() } }}</app-status-pill>
          <button class="btn btn-sm btn-secondary" type="button" [disabled]="s.assistLocked()"
            (click)="s.setAssistConversations(false)">{{ 'mediaProcessing.assist.conversationsWithdraw' | transloco }}</button>
        } @else {
          <button class="btn btn-sm btn-secondary" type="button" [disabled]="s.assistLocked()"
            (click)="s.setAssistConversations(true)">{{ 'mediaProcessing.assist.conversationsAllow' | transloco }}</button>
        }
      </div>
    }
  `,
})
export class AssistEgressConsentComponent {
  readonly s = inject(MediaProcessingStateService);
}
