import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ActiveLanguage } from '../../core/active-language';
import type { VoteRound } from '../../core/api.types';
import { formatList } from '../../core/list-format';
import { PluralText } from '../../core/plural-text.service';
import type { ConversionStep } from '../../core/conversion.types';
import { orderedConversionSteps, roundTypeKey, voteTally } from '../../core/vote-round-view';
import { InstantComponent } from '../../shared/instant.component';
import { VoteConversionBlockComponent } from './vote-conversion-block.component';

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
 *
 * ## The conversion that rides with a schema round
 *
 * A round can carry the steps of a record conversion (`convertRecords`), and a yes is a yes to them. When it carries some, the row shows
 * them under the summary through `app-vote-conversion-block`, with this instance's own record counts for the round's local space. A round
 * with no steps renders exactly as it did before conversions: no block, no request.
 */
@Component({
  selector: 'app-network-vote-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, InstantComponent, VoteConversionBlockComponent],
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
      @if (changesLine(); as line) {
        <div class="vote-summary" data-testid="vote-changes">{{ line }}</div>
      } @else if (round().summary) {
        <div class="vote-summary">{{ round().summary }}</div>
      }
      @if (conversionSteps(); as steps) {
        <app-vote-conversion-block [steps]="steps" [localSpaceId]="round().localSpaceId" />
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

  private readonly plural = inject(PluralText);
  private readonly language = inject(ActiveLanguage).language;

  protected typeKey = () => roundTypeKey(this.round().type);
  protected tally = () => voteTally(this.round());
  /**
   * For a schema change that carries a conversion, which types it changes, as drawn ("Changes to the type person."; several: one counted sentence),
   * from the round's own `changedTypes` (`kind:type`). It stands where the server's summary would, which for such a round only says that someone
   * proposes to update the schema. Null for any other round, or one that names no type: its summary is shown as before.
   */
  protected changesLine = (): string | null => {
    const r = this.round();
    if (r.type !== 'meta_change' || !r.convertRecords) return null;
    const names = [...new Set((r.changedTypes ?? []).map(t => t.slice(t.indexOf(':') + 1)).filter(n => n !== ''))];
    if (names.length === 0) return null;
    return this.plural.text('networks.network.votes.convert.changes', names.length, { types: formatList(names, this.language()) });
  };

  /** The steps of the conversion the round carries, or null when it carries none a voter can read: the row is then as it was before conversions. */
  protected conversionSteps = (): readonly ConversionStep[] | null => {
    const steps = this.round().convertRecords?.steps;
    return steps && orderedConversionSteps(steps).length > 0 ? steps : null;
  };
}
