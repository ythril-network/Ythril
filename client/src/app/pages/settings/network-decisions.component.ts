import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, inject, input, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoPipe } from '@jsverse/transloco';
import type { VoteOutcomeEntry } from '../../core/api.types';
import { NetworksApi } from '../../core/networks-api.service';
import { httpErrorReason } from '../../core/http-error';
import { outcomeKey, outcomeWord, roundSubject, roundTypeKey, type OutcomeWord } from '../../core/vote-round-view';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { InstantComponent } from '../../shared/instant.component';
import { StatusPillComponent, type StatusVariant } from '../../shared/status-pill.component';

/** How an outcome is coloured. The WORD is always shown beside it — a colour alone says nothing to a screen reader. */
const VARIANT: Record<OutcomeWord, StatusVariant> = { passed: 'ok', vetoed: 'error', expired: 'off', ended: 'off' };

/** The time an entry concluded, or null for one that has none (concluded before outcomes were recorded) or an unreadable one. */
const concludedMs = (e: VoteOutcomeEntry): number | null => {
  const ms = e.concludedAt ? Date.parse(e.concludedAt) : NaN;
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Newest first by `concludedAt`; an entry with no readable time goes last, in the order the server sent it. The page
 * decides what "newest" means — the wire order is not relied on.
 */
export function newestDecisionsFirst(entries: readonly VoteOutcomeEntry[]): VoteOutcomeEntry[] {
  return entries
    .map((entry, at) => ({ entry, at, ms: concludedMs(entry) }))
    .sort((a, b) => (a.ms === null ? (b.ms === null ? a.at - b.at : 1) : b.ms === null ? -1 : b.ms - a.ms))
    .map(x => x.entry);
}

/**
 * "Recent decisions" on a network card: the rounds this instance has seen conclude, how each ended, and what it
 * proposed.
 *
 * ## Why it stands outside the open-votes block
 *
 * A round that has ended is exactly the one nobody can vote on any more, so a list that only lived beside open votes
 * would vanish at the moment it has something to say. The card therefore always carries it, whether or not a vote is
 * open. It asks for the log when the card is opened (the component is created then) and again after any cast, because a
 * cast is what usually ends a round.
 *
 * ## What it refuses to blur
 *
 * Loading, empty and failed are three different states: a failed read must never read as "no decisions yet" — that
 * would tell an operator that nothing was ever decided. And an outcome is a WORD first (translated, in every
 * language), with a status colour on top. The stored summary is peer-authored text and is shown by interpolation, never
 * as markup.
 */
@Component({
  selector: 'app-network-decisions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, ErrorStateComponent, InstantComponent, StatusPillComponent],
  styles: [`
    .decisions { margin-top: 16px; }
    .section-title:focus { outline: none; }
    .section-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .muted { padding: 8px 0; color: var(--text-muted); font-size: 12px; }
    .decision-list { list-style: none; margin: 0; padding: 0; }
    .decision { padding: 8px 10px; background: var(--bg-elevated); border-radius: var(--radius-sm); margin-bottom: 8px; font-size: 13px; }
    .decision-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .decision-title { flex: 1 1 14em; min-width: 0; overflow-wrap: anywhere; }
    .decision-meta { font-size: 11px; color: var(--text-muted); }
    .decision-summary { margin-top: 4px; font-size: 12px; color: var(--text-secondary); white-space: pre-line; overflow-wrap: anywhere; }
  `],
  template: `
    <div class="decisions">
      <div class="section-title" tabindex="-1" #heading>{{ 'networks.decisions.title' | transloco }}</div>
      @if (error() !== null) {
        <app-error-state [message]="'networks.decisions.loadError' | transloco" [reason]="error() ?? ''" [icon]="28" (retry)="reload()" />
      } @else if (entries() === null) {
        <div class="muted">{{ 'networks.decisions.loading' | transloco }}</div>
      } @else if (entries()!.length === 0) {
        <div class="muted">{{ 'networks.decisions.empty' | transloco }}</div>
      } @else {
        <ul class="decision-list">
          @for (d of entries(); track d.roundId) {
            <li class="decision">
              <div class="decision-line">
                <app-status-pill [variant]="variantOf(d)">{{ outcomeKeyOf(d) | transloco }}</app-status-pill>
                <span class="decision-title"><strong>{{ typeKeyOf(d) | transloco }}</strong>: {{ subjectOf(d) }}</span>
                <span class="decision-meta">
                  @if (d.concludedAt) {
                    {{ 'networks.decisions.concluded' | transloco }} <app-instant [value]="d.concludedAt" variant="datetime" />
                  }
                </span>
                <span class="num decision-meta">
                  @if (d.yes !== undefined && d.veto !== undefined) {
                    {{ 'networks.network.votes.tally' | transloco: { yes: d.yes, veto: d.veto } }}
                  }
                  @if (d.eligible !== undefined) {
                    · {{ 'networks.decisions.eligible' | transloco: { eligible: d.eligible } }}
                  }
                </span>
              </div>
              @if (d.summary) {
                <div class="decision-summary">{{ d.summary }}</div>
              }
            </li>
          }
        </ul>
        @if (total() > entries()!.length) {
          <div class="muted">{{ 'networks.decisions.shown' | transloco: { shown: entries()!.length, total: total() } }}</div>
        }
      }
    </div>
  `,
})
export class RecentDecisionsComponent implements OnInit {
  private readonly api = inject(NetworksApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  networkId = input.required<string>();

  /** Null until the first answer: that is what tells "loading" from "empty". A later reload keeps what is shown. */
  protected entries = signal<VoteOutcomeEntry[] | null>(null);
  protected total = signal(0);
  /** Null until a read failed — checked before the empty state, so a failure never reads as "no decisions". */
  protected error = signal<string | null>(null);
  /** Answers are applied in the order they were ASKED: a slow earlier answer must not replace a later one. */
  private asked = 0;

  protected variantOf = (d: VoteOutcomeEntry): StatusVariant => VARIANT[outcomeWord(d.outcome)];
  protected outcomeKeyOf = (d: VoteOutcomeEntry): string => outcomeKey(d.outcome);
  protected typeKeyOf = (d: VoteOutcomeEntry): string => roundTypeKey(d.type);
  protected subjectOf = (d: VoteOutcomeEntry): string => roundSubject(d.space, d.subjectLabel ?? '');

  ngOnInit(): void { this.reload(); }

  /**
   * Ask for the log again. `focus` moves keyboard focus to this section's heading: a cast that ended its round removes
   * the row the voter's focus was on, and focus on a removed element falls back to the page body.
   */
  reload(focus = false): void {
    const mine = ++this.asked;
    this.error.set(null);
    this.api.listVoteOutcomes(this.networkId()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ outcomes, total }) => {
        if (mine !== this.asked) return;
        this.entries.set(newestDecisionsFirst(outcomes ?? []));
        this.total.set(total ?? (outcomes ?? []).length);
      },
      error: err => { if (mine === this.asked) this.error.set(httpErrorReason(err)); },
    });
    if (focus) this.heading()?.nativeElement.focus();
  }
}
