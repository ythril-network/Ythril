import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { FORKS_PAGE_SIZE, ReviewForksState } from './review-forks-state';
import { ReviewForksComponent } from './review-forks.component';

/**
 * The Forks tab panel of Review: the intro, the refusal of the last resolve, the list or its loading, failed and empty states, and the pager
 * (bundle-81, design rev 8 section 5). The Review tab hosts it and owns the tab; this owns what the panel shows, so the tab, already the largest
 * page of the Brain, carries one tag for the whole section.
 *
 * Order matters in the states: a failed load is checked before the empty state, so a server that did not answer never reads as "no forks to
 * review", the friendliest sentence the panel has. A refusal stays until it is dismissed or the list is reloaded, as a refused merge does: it is
 * about one fork in a list the reviewer is working down.
 */
@Component({
  selector: 'app-review-forks-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, ErrorStateComponent, PhIconComponent, ReviewForksComponent],
  styles: [`
    :host { display: block; }
    .intro { color: var(--text-muted); font-size: 13px; margin: 0 0 16px; }
    .refusal { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; margin: 8px 0 12px; font-size: 13px; }
    .refusal-body { flex: 1 1 220px; min-width: 0; }
    .refusal-body p { margin: 0; overflow-wrap: anywhere; }
    .refusal-close { background: none; border: none; color: inherit; cursor: pointer; padding: 2px; line-height: 1; flex-shrink: 0; }
    .refusal-close:focus-visible, .pagination button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `],
  template: `
    <section role="tabpanel" id="review-panel-forks" aria-labelledby="review-tab-forks">
      <p class="intro">{{ 'brain.review.forks.intro' | transloco }}</p>

      @if (state().refusal(); as refusal) {
        <div class="alert alert-warning refusal" role="alert">
          <div class="refusal-body"><p>{{ refusal }}</p></div>
          <button class="btn btn-sm btn-secondary" type="button" (click)="state().reload(spaceId())">{{ 'brain.review.forks.refusal.reload' | transloco }}</button>
          <button class="refusal-close" type="button" [attr.aria-label]="'brain.review.forks.refusal.dismiss' | transloco" (click)="state().dismissRefusal()"><ph-icon name="x" [size]="14"/></button>
        </div>
      }

      @if (state().loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else if (state().loadError() !== null) {
        <app-error-state [message]="'brain.review.forks.loadError' | transloco" [reason]="state().loadError() ?? ''" (retry)="state().reload(spaceId())" />
      } @else if (noForks()) {
        <div class="empty-state">
          <div class="empty-state-icon"><ph-icon name="check-circle" [size]="48"/></div>
          <h3>{{ 'brain.review.forks.empty.title' | transloco }}</h3>
          <p>{{ 'brain.review.forks.empty.body' | transloco }}</p>
        </div>
      } @else {
        <app-review-forks [rows]="state().rows()" [counts]="state().counts()" [marked]="state().marked()" [kinds]="state().kinds()" [kind]="state().kind()"
                          [busy]="state().kindLoading()" [cap]="state().maxForksPerRecord()"
                          (kindChange)="state().selectKind(spaceId(), $event)" (resolve)="state().resolve(spaceId(), $event)" />
        @if (!state().kindLoading() && (state().hasPrevious() || state().hasNext())) {
          <div class="pagination">
            <button class="btn btn-sm btn-secondary" type="button" [disabled]="!state().hasPrevious()" (click)="state().load(spaceId(), state().skip() - pageSize)"><ph-icon name="arrow-left" [size]="14" style="display:inline-flex;vertical-align:middle;"/> {{ 'common.prev' | transloco }}</button>
            <span class="pager-info">{{ state().pagerText() }}</span>
            <button class="btn btn-sm btn-secondary" type="button" [disabled]="!state().hasNext()" (click)="state().load(spaceId(), state().skip() + pageSize)">{{ 'common.next' | transloco }} <ph-icon name="arrow-right" [size]="14" style="display:inline-flex;vertical-align:middle;"/></button>
          </div>
        }
      }
    </section>
  `,
})
export class ReviewForksPanelComponent {
  /** The space whose forks these are. */
  readonly spaceId = input.required<string>();
  /** The Review tab's forks state: its rows, page and refusal. */
  readonly state = input.required<ReviewForksState>();
  protected readonly pageSize = FORKS_PAGE_SIZE;

  /**
   * The space has no forks of any kind. The answer's counts say it when they are there: a kind with none is not an empty space, it is a kind the
   * switch says is empty, and offers the next. An answer without counts is judged by its rows.
   */
  protected noForks(): boolean {
    const total = this.state().total();
    return total === null ? this.state().rows().length === 0 : total === 0;
  }
}
