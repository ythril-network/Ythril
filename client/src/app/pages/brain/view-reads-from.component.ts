import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ActiveLanguage } from '../../core/active-language';
import { formatList } from '../../core/list-format';
import { listsEverySpace, type PersonalView } from '../../core/views-api.service';

/**
 * What an open personal view is reading right now, and what it left out (Q-531, ux S3, a11y S4).
 *
 * A view lists its members, and a member the caller can no longer read drops out of every read (rights are judged at read time, so a later
 * grant brings it back). "Reads from: a, b" alone is ambiguous between the listed members and the ones actually read, and a narrowed answer
 * that does not say so reads as "this is everything": so the line names the members read NOW, joined by the language's own list format, and
 * a second sentence names the ones dropped, in words. A view with nothing readable never says "Reads from:" with an empty list; it has its own
 * sentence and names what it lists.
 */
@Component({
  selector: 'app-view-reads-from',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <div class="view-reads" style="margin-bottom:12px;font-size:13px;color:var(--text-secondary);">
      @if (readable().length === 0) {
        <p style="margin:0;" role="status">{{ (listsAll() ? 'views.readsNothingAll' : 'views.readsNothing') | transloco: { members: listed() } }}</p>
      } @else {
        <p style="margin:0;">{{ (listsAll() ? 'views.readsFromAll' : 'views.readsFrom') | transloco: { members: readNow() } }}</p>
        @if (dropped().length > 0) {
          <p style="margin:4px 0 0;color:var(--warning);">{{ 'views.dropped' | transloco: { members: droppedList() } }}</p>
        }
      }
    </div>
  `,
})
export class ViewReadsFromComponent {
  /** The page's language, as a signal, so a language switch re-words the list ("a and b" / "a und b"). */
  private readonly lang = inject(ActiveLanguage).language;

  readonly view = input.required<PersonalView>();

  protected readonly listsAll = computed(() => listsEverySpace(this.view().members));
  protected readonly readable = computed(() => this.view().readable);
  /** Listed members the caller cannot read now, in the order the view lists them (every space lists none, so it drops none). */
  protected readonly dropped = computed(() => {
    const { members, readable } = this.view();
    return this.listsAll() ? [] : members.filter(m => !readable.includes(m));
  });
  protected readonly readNow = computed(() => formatList(this.readable(), this.lang()));
  protected readonly droppedList = computed(() => formatList(this.dropped(), this.lang()));
  /** What the view lists, for the sentence of a view that reads nothing. */
  protected readonly listed = computed(() => (this.listsAll() ? '' : formatList(this.view().members, this.lang())));
}
