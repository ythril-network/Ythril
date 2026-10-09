import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { VoteRound } from '../../core/api.types';
import { roundTypeKey, voteTally } from '../../core/vote-round-view';
import { InstantComponent } from '../../shared/instant.component';

/**
 * One open vote round on a network card: what it is, when it opened and closes, where the count stands, what it
 * proposes, and the Yes / Veto buttons.
 *
 * ## Why it is a component of its own
 *
 * `networks.component.ts` is on the god-file ratchet, and a row that grew a second line, two times, two accessible
 * names and a busy state is its own unit. It owns presentation only: the cast, its confirmation and what follows it
 * stay with the page, which holds the cache of rounds the card, the header pill and the summary strip all read.
 *
 * ## What it does not do
 *
 * `summary` and `subject` are text another instance's operator wrote, and this row asks a person to APPROVE what they
 * say. Both are shown by interpolation, which escapes — never as markup. The summary keeps its line breaks
 * (`pre-line`), breaks inside a long unbroken word (`overflow-wrap: anywhere`) and is never cut off: a voter who
 * cannot read the whole proposal cannot meaningfully approve it.
 */
@Component({
  selector: 'app-network-vote-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, InstantComponent],
  styles: [`
    .vote-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 10px;
      background: var(--bg-elevated);
      border-radius: var(--radius-sm);
      margin-bottom: 8px;
      font-size: 13px;
    }
    .vote-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .vote-title { flex: 1 1 14em; min-width: 0; overflow-wrap: anywhere; }
    .vote-meta { font-size: 11px; color: var(--text-muted); }
    .vote-summary { font-size: 12px; color: var(--text-secondary); white-space: pre-line; overflow-wrap: anywhere; }
  `],
  template: `
    <div class="vote-row">
      <div class="vote-line">
        <span class="vote-title"><strong>{{ typeKey() | transloco }}</strong>: {{ round().subject }}</span>
        <span class="vote-meta">
          {{ 'networks.network.votes.opened' | transloco }} <app-instant [value]="round().openedAt" variant="datetime" />
          · {{ 'networks.network.votes.deadline' | transloco }} <app-instant [value]="round().deadline" variant="datetime" />
        </span>
        <span class="num vote-meta">
          {{ 'networks.network.votes.tally' | transloco: { yes: tally().yes, veto: tally().veto } }}
        </span>
        <button class="btn-primary btn btn-sm" [disabled]="busy()" [attr.aria-busy]="busy()"
                [attr.aria-label]="'networks.network.votes.yesAria' | transloco: { type: (typeKey() | transloco), subject: round().subject }"
                (click)="cast.emit('yes')">
          @if (busy()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
          {{ 'networks.network.votes.yes' | transloco }}
        </button>
        <button class="btn-danger btn btn-sm" [disabled]="busy()" [attr.aria-busy]="busy()"
                [attr.aria-label]="'networks.network.votes.vetoAria' | transloco: { type: (typeKey() | transloco), subject: round().subject }"
                (click)="cast.emit('veto')">{{ 'networks.network.votes.veto' | transloco }}</button>
      </div>
      @if (round().summary) {
        <div class="vote-summary">{{ round().summary }}</div>
      }
    </div>
  `,
})
export class NetworkVoteRowComponent {
  round = input.required<VoteRound>();
  /** A cast on this round is in flight. */
  busy = input(false);
  /** The voter's choice; the page confirms a veto and posts it. */
  cast = output<'yes' | 'veto'>();

  protected typeKey = () => roundTypeKey(this.round().type);
  protected tally = () => voteTally(this.round());
}
