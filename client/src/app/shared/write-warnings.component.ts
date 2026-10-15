import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { describeWarnings, type WireRow } from '../core/refusal-text';
import { PhIconComponent } from './ph-icon.component';

/**
 * The warnings of a write that SUCCEEDED, kept on screen (bundle-23, R6-14).
 *
 * Under `warn` mode (and for a violation a strict space does not block) the server stores the record and answers it with
 * `warnings`. No editor read the field, so the one signal that says "this record breaks the schema" was dropped by exactly the
 * screens a record is written from. A toast goes in seconds, and a warning is about a record that stays wrong until someone fixes
 * it, so it is a persistent inline notice: `role="status"` (heard politely, not as an interruption), one line per warning, and
 * a close button. The host replaces the list with each save's warnings and empties it when a save carries none; this component
 * only shows what it is given and says when it is dismissed.
 */
@Component({
  selector: 'app-write-warnings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PhIconComponent],
  styles: [`
    :host { display: block; }
    .alert { display: flex; gap: 8px; align-items: flex-start; margin-block-end: 12px; font-size: 13px; }
    .body { flex: 1; min-width: 0; }
    .title { margin: 0; font-weight: 600; }
    ul { margin: 4px 0 0; padding-inline-start: 18px; }
    li { margin-block: 2px; overflow-wrap: anywhere; }
    .more { margin: 6px 0 0; }
    .dismiss { background: none; border: none; color: inherit; cursor: pointer; padding: 2px; line-height: 1; flex-shrink: 0; }
  `],
  template: `
    @if (rows().length) {
      <div class="alert alert-warning" role="status" data-testid="write-warnings">
        <div class="body">
          <p class="title">{{ 'writeWarnings.title' | transloco }}</p>
          <ul>
            @for (row of rows(); track $index) { <li> {{ row.text }} </li> }
          </ul>
          @if (truncated()) { <p class="more" data-testid="write-warnings-more">{{ 'writeWarnings.more' | transloco }}</p> }
        </div>
        <button type="button" class="dismiss" data-testid="write-warnings-dismiss"
          [attr.aria-label]="'writeWarnings.dismiss' | transloco" [attr.title]="'writeWarnings.dismiss' | transloco"
          (click)="dismissed.emit()"><ph-icon name="x" [size]="14" /></button>
      </div>
    }
  `,
})
export class WriteWarningsComponent {
  private readonly transloco = inject(TranslocoService);

  /** The `warnings` of the last successful write, as the server wrote them. */
  readonly warnings = input<readonly WireRow[] | null | undefined>(null);
  /** The server cut the list (`warningsTruncated`): rows were left out, and the notice says so rather than present the cut list as the whole. */
  readonly truncated = input<boolean>(false);
  /** The reader closed the notice. */
  readonly dismissed = output<void>();

  protected readonly rows = computed(() => describeWarnings(this.transloco, '', this.warnings() ?? []));
}
