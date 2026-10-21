import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { DateFormatService } from '../../core/date-format.service';
import type { OwedSpaceAct } from '../../core/space-act-outcome';
import { actKindKey, actRowView, actWhenText } from '../../core/space-act-view';
import { StatusPillComponent } from '../../shared/status-pill.component';

/**
 * The deletions and wipes this instance still owes one network (Q-535), on that network's card: the space, the act, its state, how many
 * tries it has had and when the next one is. Only an instance administrator is served the list, so the card shows this only when the
 * network carries a non-empty `owedSpaceActs`; absent means "not yours to see" and is never drawn as "none owed".
 *
 * Its own component because the Networks page sits at its size ceiling, and the words for one act come from `space-act-view`, the same
 * module the danger tab uses, so one debt is never described in two vocabularies.
 */
@Component({
  selector: 'app-network-owed-acts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, StatusPillComponent],
  template: `
<div style="margin-bottom:16px;">
  <h4 class="section-title" style="margin:0 0 6px;">{{ 'networks.owedActs.title' | transloco }}</h4>
  <ul style="list-style:none;margin:0;padding:0;">
    @for (act of acts(); track act.entryId) {
      <li style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
        <span style="font-weight:500;">{{ act.localSpaceId }}</span>
        <span>{{ actKindKey(act.kind) | transloco }}</span>
        @let row = rowView(act);
        <app-status-pill [variant]="row.variant" [dot]="true">{{ row.stateKey | transloco }}</app-status-pill>
        @if (row.showsAttempts) { <span style="color:var(--text-muted);">{{ 'spaces.dangerZone.act.attempts' | transloco: { count: act.attempts } }}</span> }
        @if (row.showsNextTry) { <span style="color:var(--text-muted);">{{ 'networks.owedActs.nextTry' | transloco: { when: whenText(act.nextRetryAt) } }}</span> }
        @if (act.needsAbandon) { <span style="flex-basis:100%;color:var(--text-secondary);">{{ 'spaces.dangerZone.act.needsAbandon' | transloco }}</span> }
      </li>
    }
  </ul>
</div>
`,
})
export class NetworkOwedActsComponent {
  readonly acts = input.required<OwedSpaceAct[]>();

  private readonly transloco = inject(TranslocoService);
  private readonly dates = inject(DateFormatService);
  protected readonly rowView = actRowView;
  protected readonly actKindKey = actKindKey;
  /** When an owed act's next try is, in words (see `actWhenText`); read against the clock at each render. */
  whenText(retryAt: string | undefined): string { return actWhenText(this.transloco, this.dates, retryAt, Date.now()); }
}
