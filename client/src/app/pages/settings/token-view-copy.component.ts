import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ViewsApi, viewRefusalText } from '../../core/views-api.service';
import { ViewsStore } from '../../core/views.store';

/** What copying one view said, kept so the manager sees the name the receiver will find. */
interface CopyOutcome {
  /** The id the copy landed under (`@name`), shown as its own element: a name is data, not part of a translated sentence. */
  id: string;
  /** True when it is not the source's name: the receiver already had a view called that. */
  renamed: boolean;
}

/**
 * "Copy personal views to this token": the one way a view reaches another token (Q-531, owner ruling 0050bb1e: a caller who may manage
 * another token may give it a COPY, owned by the receiver; nothing is shared).
 *
 * ## Who is offered it
 *
 * Only a caller who may manage the target token. The server's copy door uses the same check as token management (and the same MFA step-up),
 * so a control shown to anyone else could only produce a 403; `mayManage` is that guard, handed in by the host that already knows (the token
 * editor opens only for a caller the token list answered). Without it the component renders nothing at all and asks the server nothing.
 *
 * ## What it says back
 *
 * A copy whose name the receiver already held is given the next free `-N`; the answer's `view.id` then differs from the source's. The
 * manager is told the new name, so what the receiver will see is never a surprise. A copy keeps only the spaces the RECEIVER can read; one
 * that would be left with none is refused in words by the server's code.
 */
@Component({
  selector: 'app-token-view-copy',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PhIconComponent],
  template: `
    @if (mayManage()) {
      <section class="view-copy" aria-labelledby="view-copy-title" style="margin-top:20px;">
        <div class="section-title" id="view-copy-title">{{ 'views.copy.title' | transloco }}</div>
        <p class="hint" style="margin:4px 0 8px;">{{ 'views.copy.hint' | transloco }}</p>
        @if (error()) { <div class="alert alert-error" role="alert">{{ error() }}</div> }
        @if (store.views().length === 0) {
          <p class="hint">{{ 'views.copy.none' | transloco }}</p>
        } @else {
          <ul style="list-style:none;margin:0;padding:0;">
            @for (v of store.views(); track v.id) {
              <li style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
                <span>{{ v.name }}</span>
                <span class="mono" style="color:var(--text-muted);font-size:12px;">{{ v.id }}</span>
                <button class="btn btn-sm btn-secondary" type="button" [disabled]="copying() === v.id"
                  [attr.aria-label]="'views.copy.action' | transloco: { name: v.name }" (click)="copy(v.id)">
                  <ph-icon name="copy" [size]="13" style="margin-right:4px;vertical-align:-2px;"/>{{ 'views.copy.button' | transloco }}
                </button>
                @if (outcomes()[v.id]; as o) {
                  <span role="status" style="font-size:12.5px;">
                    <span class="mono">{{ o.id }}</span>
                    {{ (o.renamed ? 'views.copy.renamed' : 'views.copy.done') | transloco: { original: v.name } }}
                  </span>
                }
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
})
export class TokenViewCopyComponent {
  protected readonly store = inject(ViewsStore);
  private readonly api = inject(ViewsApi);
  private readonly transloco = inject(TranslocoService);

  /** The token that receives the copies. */
  readonly targetTokenId = input.required<string>();
  /** The caller may manage that token (the same guard as token management); without it nothing is offered. */
  readonly mayManage = input(false);

  protected readonly copying = signal('');
  protected readonly error = signal('');
  protected readonly outcomes = signal<Record<string, CopyOutcome>>({});

  /** Copy the view `viewId` (`@name`) to the target token. */
  copy(viewId: string): void {
    if (!this.mayManage() || this.copying()) return;
    this.copying.set(viewId);
    this.error.set('');
    this.api.copy(viewId, this.targetTokenId()).subscribe({
      next: ({ view }) => {
        this.copying.set('');
        this.outcomes.update(o => ({ ...o, [viewId]: { id: view.id, renamed: view.id !== viewId } }));
      },
      error: err => {
        this.copying.set('');
        this.error.set(viewRefusalText(this.transloco, err));
      },
    });
  }
}
