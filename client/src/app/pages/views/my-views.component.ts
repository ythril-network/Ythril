import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { finalize } from 'rxjs';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { ToastService } from '../../core/toast.service';
import { ViewsStore } from '../../core/views.store';
import { viewRefusalText, type PersonalView } from '../../core/views-api.service';
import { ViewCreateDialogComponent, type ViewMemberChoice } from '../brain/view-create-dialog.component';

/**
 * My personal views: the caller's own views on the Brain page, with create, rename and delete (Q-531, plan rev 3.2 "Client").
 *
 * ## Why it is not under `pages/brain/`
 *
 * `every-write-control-asks-is-view.spec.ts` derives every component of `pages/brain` and `pages/files` that renders a write (a handler named
 * rename, remove, create...) and holds it to the one `isView` flag, because those controls write RECORDS and FILES of the open space and a
 * view never does. These controls write the caller's own view definitions, which is the one thing a caller may do while a view is open
 * (rename or delete the view you are looking at), so asking `isView` of them would be wrong. They live beside the Brain page's other views
 * code in a folder of their own so that gate keeps meaning what it says.
 *
 * A view is personal: only its owner sees it here, and it goes away with the owner's token, so this list is the whole of it and there is no
 * admin copy of it elsewhere. It lives on the Brain page and not under Settings (which is the Admin nav) because every token owns views.
 *
 * Each entry carries the words "personal view" as VISIBLE text, not an aria-label on an empty span: a sighted user and a screen reader get the
 * same word, and it tells a view from a space in a strip where both are chips. Deleting says what goes ("the view only, no data").
 */
@Component({
  selector: 'app-my-views',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslocoPipe, PhIconComponent, ViewCreateDialogComponent],
  styles: [`
    :host { display: block; margin-bottom: 20px; }
    .head { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
    .title { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
    .list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
    .item { display: flex; align-items: center; gap: 2px; }
    .chip { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 6px 12px; min-width: 110px; max-width: 220px;
      border: 1px dashed var(--border); border-radius: 4px; background: var(--bg-surface); color: var(--text-secondary); cursor: pointer; font-size: 12px; }
    .chip:hover { border-color: var(--accent); color: var(--text-primary); }
    .chip.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
    .chip .name { font-size: 13px; font-weight: 500; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chip .id { font-size: 10px; color: var(--text-muted); }
    .chip .marker { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; color: var(--text-muted); }
    .chip.active .marker { color: var(--accent); }
    .rename { display: flex; align-items: center; gap: 4px; }
    .rename input { width: 150px; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `],
  template: `
    <section aria-labelledby="my-views-title">
      <div class="head">
        <h3 class="title" id="my-views-title">{{ 'views.title' | transloco }}</h3>
        <button class="btn btn-sm btn-secondary" type="button" (click)="creating.set(true)">
          <ph-icon name="plus" [size]="13" style="margin-right:4px;vertical-align:-2px;"/>{{ 'views.create.open' | transloco }}
        </button>
      </div>
      @if (store.loadFailed()) {
        <div class="alert alert-error" role="alert">
          {{ 'views.loadFailed' | transloco }}
          <button class="btn btn-sm btn-secondary" type="button" style="margin-left:8px;" (click)="store.load()">{{ 'common.retry' | transloco }}</button>
        </div>
      }
      @if (error()) { <div class="alert alert-error" role="alert">{{ error() }}</div> }
      @if (store.loaded() && store.views().length === 0 && !store.loadFailed()) {
        <p class="hint" style="margin:0;">{{ 'views.empty' | transloco }}</p>
      }
      <ul class="list">
        @for (v of store.views(); track v.id) {
          <li class="item">
            @if (renaming() === v.id) {
              <form class="rename" (ngSubmit)="saveRename(v)">
                <label class="sr" [for]="'view-rename-' + v.name">{{ 'views.rename.label' | transloco: { name: v.name } }}</label>
                <input type="text" [id]="'view-rename-' + v.name" name="rename" [(ngModel)]="draft" maxlength="40" pattern="[a-z0-9-]+" required />
                <button class="btn btn-sm btn-primary" type="submit" [disabled]="!draft.trim() || draft.trim() === v.name || busy().has(v.id)" [attr.aria-busy]="busy().has(v.id) ? 'true' : null">{{ 'common.save' | transloco }}</button>
                <button class="btn btn-sm btn-secondary" type="button" (click)="renaming.set('')">{{ 'common.cancel' | transloco }}</button>
              </form>
            } @else {
              <button class="chip" type="button" [class.active]="activeId() === v.id" [attr.aria-current]="activeId() === v.id ? 'true' : null" [title]="v.id" (click)="opened.emit(v.id)">
                <span class="name">{{ v.name }}</span>
                <span class="id">{{ v.id }}</span>
                <span class="marker"><ph-icon name="eye" [size]="11"/>{{ 'views.marker' | transloco }}</span>
              </button>
              <button class="icon-btn" type="button" [attr.aria-label]="'views.rename.action' | transloco: { name: v.name }" [attr.title]="'views.rename.action' | transloco: { name: v.name }" (click)="startRename(v)"><ph-icon name="pencil-simple" [size]="14"/></button>
              <button class="icon-btn" type="button" [attr.aria-label]="'views.delete.action' | transloco: { name: v.name }" [attr.title]="'views.delete.action' | transloco: { name: v.name }" [disabled]="busy().has(v.id)" [attr.aria-busy]="busy().has(v.id) ? 'true' : null" (click)="remove(v)"><ph-icon name="trash" [size]="14"/></button>
            }
          </li>
        }
      </ul>
    </section>
    @if (creating()) {
      <!-- The dialog is only ever opened on a click, so its code is not part of the Brain page's first load. -->
      @defer (on immediate) {
        <app-view-create-dialog [spaces]="spaces()" (created)="onCreated($event)" (closed)="creating.set(false)" />
      }
    }
  `,
})
export class MyViewsComponent {
  protected readonly store = inject(ViewsStore);
  private readonly transloco = inject(TranslocoService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  /** The spaces the caller reads: the members the create dialog offers. */
  readonly spaces = input.required<readonly ViewMemberChoice[]>();
  /** The id the page has open, so its entry reads as current. */
  readonly activeId = input('');
  /** The caller chose to open a view (or just made one). */
  readonly opened = output<string>();
  /** A view was renamed: the page's open id changes with its name when it was the open one. */
  readonly renamed = output<{ from: string; to: string }>();
  /** A view was deleted: the page leaves it when it was the open one. */
  readonly removed = output<string>();

  protected readonly creating = signal(false);
  protected readonly renaming = signal('');
  protected readonly error = signal('');
  protected draft = '';
  /** The views with a rename or delete in flight: their controls are disabled and busy, so a double submit sends one write. */
  protected readonly busy = signal<ReadonlySet<string>>(new Set());
  private hold(id: string): void { this.busy.update(s => new Set(s).add(id)); }
  private release(id: string): void { this.busy.update(s => { const next = new Set(s); next.delete(id); return next; }); }

  protected onCreated(view: PersonalView): void {
    this.creating.set(false);
    this.toast.success(this.transloco.translate('views.created', { name: view.name }));
    this.opened.emit(view.id);
  }

  protected startRename(view: PersonalView): void {
    this.error.set('');
    this.draft = view.name;
    this.renaming.set(view.id);
  }

  protected saveRename(view: PersonalView): void {
    const name = this.draft.trim();
    if (!name || name === view.name || this.busy().has(view.id)) return;
    this.hold(view.id);
    this.store.rename(view.id, name).pipe(finalize(() => this.release(view.id))).subscribe({
      next: renamed => { this.renaming.set(''); this.renamed.emit({ from: view.id, to: renamed.id }); },
      error: err => this.error.set(viewRefusalText(this.transloco, err)),
    });
  }

  protected async remove(view: PersonalView): Promise<void> {
    if (this.busy().has(view.id)) return;
    this.error.set('');
    // Held from the question on, so a second click while the dialog is open or the delete is in flight sends nothing more.
    this.hold(view.id);
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('views.delete.title', { name: view.name }),
      message: this.transloco.translate('views.delete.confirm', { name: view.name }),
      confirmLabel: this.transloco.translate('views.delete.button'),
      danger: true,
    }).catch(() => false);
    if (!ok) { this.release(view.id); return; }
    this.store.remove(view.id).pipe(finalize(() => this.release(view.id))).subscribe({
      next: () => { this.toast.success(this.transloco.translate('views.deleted', { name: view.name })); this.removed.emit(view.id); },
      error: err => this.error.set(viewRefusalText(this.transloco, err)),
    });
  }
}
