import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { finalize } from 'rxjs';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { DIALOG_STYLES } from '../settings/dialog.styles';
import { ViewsStore } from '../../core/views.store';
import { EVERY_SPACE, viewRefusalText, type PersonalView } from '../../core/views-api.service';

/** The shape of a space as this picker needs it: an id, and the label to show beside it. */
export interface ViewMemberChoice { id: string; label: string }

let nextDialogId = 0;

/**
 * Create a personal view: a name, and the spaces it reads (Q-531, plan rev 3.2 "Client").
 *
 * ## The member picker
 *
 * `spaces` is the spaces the CALLER reads, never the instance's whole list: the server refuses a member its owner cannot read, so offering one
 * would invite a form that can only fail. Every checkbox is named for its space by a bound `<label>` (a screen reader says "Quality, qa,
 * checkbox" and not "checkbox, not checked" N times). The label WRAPS its checkbox, so the name needs no id to bind by and two open dialogs
 * cannot cross their labels.
 * "All spaces I can read" is a choice between two modes (a radio pair), not a checkbox among the spaces: it means every space the caller
 * reads, including ones added later, which no list of ticked boxes can say.
 *
 * It does not offer a view as a member: a view is not a space, and the server refuses a member that is itself a view.
 */
@Component({
  selector: 'app-view-create-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslocoPipe, PhIconComponent, ModalDirective],
  styles: [DIALOG_STYLES, `
    :host { --dialog-max-width: 520px; }
    .members { max-height: 240px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 10px; margin: 6px 0 0; }
    .member { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-weight: normal; cursor: pointer; }
    .member .mono { color: var(--text-muted); font-size: 12px; }
    fieldset { border: none; padding: 0; margin: 0 0 14px; }
    legend { font-size: 13px; font-weight: 500; margin-bottom: 4px; padding: 0; }
    .mode { display: flex; align-items: center; gap: 8px; font-weight: normal; cursor: pointer; padding: 2px 0; }
  `],
  template: `
<div class="dialog-backdrop">
  <div class="dialog" [appModal]="'views.create.title' | transloco" (dismiss)="closed.emit()">
    <div class="dialog-header">
      <div class="card-title">{{ 'views.create.title' | transloco }}</div>
      <button class="icon-btn" type="button" [attr.aria-label]="'common.close' | transloco" (click)="closed.emit()"><ph-icon name="x" [size]="14"/></button>
    </div>
    <p class="hint">{{ 'views.create.hint' | transloco }}</p>
    @if (error()) { <div class="alert alert-error" role="alert">{{ error() }}</div> }
    <form (ngSubmit)="submit()">
      <div class="field">
        <label [for]="id + '-name'">{{ 'views.create.name' | transloco }}</label>
        <input type="text" [id]="id + '-name'" name="name" [(ngModel)]="name" maxlength="40" pattern="[a-z0-9-]+" required
          [attr.aria-describedby]="id + '-name-hint'" [placeholder]="'views.create.namePlaceholder' | transloco" />
        <div class="hint" [id]="id + '-name-hint'">{{ 'views.create.nameHint' | transloco }}</div>
      </div>

      <fieldset>
        <legend>{{ 'views.create.members' | transloco }}</legend>
        <label class="mode"><input type="radio" name="mode" value="some" [ngModel]="mode()" (ngModelChange)="mode.set($event)" /> {{ 'views.create.modeSome' | transloco }}</label>
        <label class="mode"><input type="radio" name="mode" value="all" [ngModel]="mode()" (ngModelChange)="mode.set($event)" /> {{ 'views.create.modeAll' | transloco }}</label>
        @if (mode() === 'some') {
          @if (spaces().length === 0) {
            <div class="hint">{{ 'views.create.noSpaces' | transloco }}</div>
          } @else {
            <div class="members">
              @for (s of spaces(); track s.id) {
                <label class="member">
                  <input type="checkbox" [checked]="chosen().has(s.id)" (change)="toggle(s.id)" />
                  <span>{{ s.label }} <span class="mono">{{ s.id }}</span></span>
                </label>
              }
            </div>
          }
        }
      </fieldset>

      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button class="btn btn-secondary" type="button" (click)="closed.emit()">{{ 'common.cancel' | transloco }}</button>
        <button class="btn btn-primary" type="submit" [disabled]="!canSubmit() || saving()" [attr.aria-busy]="saving() ? 'true' : null">
          @if (saving()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'views.create.submit' | transloco }}
        </button>
      </div>
    </form>
  </div>
</div>
  `,
})
export class ViewCreateDialogComponent {
  private readonly views = inject(ViewsStore);
  private readonly transloco = inject(TranslocoService);

  /** The spaces the caller reads: the only members this dialog offers. */
  readonly spaces = input.required<readonly ViewMemberChoice[]>();
  readonly created = output<PersonalView>();
  readonly closed = output<void>();

  protected readonly id = `view-create-${nextDialogId++}`;
  name = '';
  protected readonly mode = signal<'some' | 'all'>('some');
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());
  protected readonly saving = signal(false);
  protected readonly error = signal('');

  protected readonly canSubmit = computed(() => this.mode() === 'all' || this.chosen().size > 0);

  protected toggle(spaceId: string): void {
    this.chosen.update(set => { const next = new Set(set); if (!next.delete(spaceId)) next.add(spaceId); return next; });
  }

  protected submit(): void {
    const name = this.name.trim();
    if (!name || !this.canSubmit() || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    const members = this.mode() === 'all' ? EVERY_SPACE : this.spaces().map(s => s.id).filter(id => this.chosen().has(id));
    this.views.create({ name, members }).pipe(finalize(() => this.saving.set(false))).subscribe({
      next: view => this.created.emit(view),
      error: err => this.error.set(viewRefusalText(this.transloco, err)),
    });
  }
}
