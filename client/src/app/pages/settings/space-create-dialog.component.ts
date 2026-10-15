/**
 * Create-space dialog — label/id/quota, proxy targets, and the initial schema/purpose.
 *
 * Extracted from SpacesComponent (A17.8b). It appends the new space through SpacesStore rather
 * than handing it back to a parent, so the only output is `closed` — the dialog's visibility is
 * genuinely the page's view state, not the dialog's.
 */
import { Component, ChangeDetectionStrategy, inject, signal, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { finalize, timeout, TimeoutError } from 'rxjs';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { SPACE_DIALOG_STYLES } from './space-dialog.styles';
import { SpacesStore } from './spaces-store.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { SpaceMeta, ValidationMode } from '../../core/api.types';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';
import { refusalText } from '../../core/refusal-text';

@Component({
  selector: 'app-space-create-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent, ModalDirective, HscrollTopDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [SPACE_DIALOG_STYLES],
  template: `
<div class="dialog-backdrop">
  <div class="dialog" [appModal]="'spaces.create.title' | transloco" (dismiss)="closed.emit()" (click)="$event.stopPropagation()">
    <div class="dialog-header">
      <div class="card-title">{{ 'spaces.create.title' | transloco }}</div>
      <button class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="closed.emit()"><ph-icon name="x" [size]="14"/></button>
    </div>
    @if (createError()) { <div class="alert alert-error">{{ createError() }}</div> }
    <form (ngSubmit)="createSpace()" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
      <div class="field" style="flex:1;min-width:140px;margin-bottom:0;">
        <label>{{ 'spaces.create.label' | transloco }}</label>
        <input type="text" [(ngModel)]="form.label" name="label" [placeholder]="'spaces.create.labelPlaceholder' | transloco" maxlength="200" required />
      </div>
      <div class="field" style="width:140px;margin-bottom:0;">
        <label>{{ 'spaces.create.id' | transloco }}</label>
        <input type="text" [(ngModel)]="form.id" name="id" [placeholder]="'spaces.create.idPlaceholder' | transloco" pattern="[a-z0-9-]+" />
      </div>
      <div class="field" style="width:120px;margin-bottom:0;">
        <label>{{ 'spaces.create.maxGiB' | transloco }}</label>
        <input type="number" [(ngModel)]="form.maxGiB" name="maxGiB" min="0" step="0.1" placeholder="—" />
      </div>
      <div style="display:flex;gap:12px;flex-basis:100%;align-items:stretch;">
        <div class="field" style="flex:1;margin-bottom:0;display:flex;flex-direction:column;">
          <label>{{ 'spaces.create.purpose' | transloco }}</label>
          <textarea [(ngModel)]="form.purpose" name="purpose" maxlength="4000" rows="8" style="resize:vertical;flex:1;min-height:160px;" [placeholder]="'spaces.create.purposePlaceholder' | transloco"></textarea>
        </div>
        <div class="field" style="flex:1;margin-bottom:0;display:flex;flex-direction:column;">
          <label>{{ 'spaces.create.proxyFor' | transloco }}</label>
          @if (store.spaces().length > 0) {
            <div class="table-wrapper" hscrollTop style="flex:1;min-height:160px;max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm);">
              <table style="margin:0;">
                <thead><tr><th style="width:40px;"></th><th>{{ 'spaces.table.column.label' | transloco }}</th><th>{{ 'spaces.table.column.id' | transloco }}</th></tr></thead>
                <tbody>
                  <tr style="cursor:pointer;background:var(--bg-elevated);" (click)="toggleProxyForAll()">
                    <td style="text-align:center;"><input type="checkbox" [checked]="proxyForAll" (click)="$event.stopPropagation()" (change)="toggleProxyForAll()" /></td>
                    <td colspan="2" style="font-style:italic;color:var(--text-muted);">{{ 'spaces.create.proxyForAll' | transloco }}</td>
                  </tr>
                  @for (s of store.spaces(); track s.id) {
                    <tr style="cursor:pointer;" [class.text-muted]="proxyForAll" (click)="!proxyForAll && toggleProxyFor(s.id)">
                      <td style="text-align:center;"><input type="checkbox" [checked]="proxyForAll || isProxyForSelected(s.id)" [disabled]="proxyForAll" (click)="$event.stopPropagation()" (change)="!proxyForAll && toggleProxyFor(s.id)" /></td>
                      <td>{{ s.label }}</td>
                      <td><span class="badge badge-gray mono">{{ s.id }}</span></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">{{ 'spaces.create.noExistingSpaces' | transloco }}</div>
          }
        </div>
      </div>
      <div style="display:flex;gap:12px;flex-basis:100%;align-items:flex-end;">
        <div class="field" style="margin-bottom:0;">
          <label>{{ 'spaces.create.validationMode' | transloco }}</label>
          <select [(ngModel)]="form.validationMode" name="validationMode" style="width:140px;">
            <option value="off">{{ 'spaces.settings.validation.off' | transloco }}</option><option value="warn">{{ 'spaces.settings.validation.warn' | transloco }}</option><option value="strict">{{ 'spaces.settings.validation.strict' | transloco }}</option>
          </select>
        </div>
        <label class="field" style="margin-bottom:0;display:flex;flex-direction:row;align-items:center;gap:8px;font-weight:normal;cursor:pointer;height:34px;">
          <input type="checkbox" [(ngModel)]="form.strictLinkage" name="strictLinkage" />{{ 'spaces.create.strictLinkage' | transloco }}
        </label>
        <button class="btn btn-primary" type="submit" style="margin-left:auto;" [disabled]="creating()||!form.label.trim()">
          @if (creating()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.create.submitButton' | transloco }}
        </button>
      </div>
    </form>
  </div>
</div>
  `,
})
export class SpaceCreateDialogComponent {
  readonly store = inject(SpacesStore);
  private spacesApi = inject(SpacesApi);
  private transloco = inject(TranslocoService);

  /** The page owns whether this dialog is shown; tell it to close. */
  readonly closed = output<void>();

  // create dialog
  creating         = signal(false);

  createError      = signal('');

  proxyForSelected: string[] = [];

  proxyForAll = false;

  // The Purpose field starts empty — it used to pre-fill a long MCP tool listing, which the owner
  // never wanted persisted (it is exposed over MCP anyway). Validation defaults to the fully-strict
  // posture, matching the server's new-space default (#400), so the form never understates what will
  // actually be created.
  form = {
    label: '', id: '', maxGiB: null as number | null,
    purpose: '',
    validationMode: 'strict' as ValidationMode,
    strictLinkage: true,
  };

  isProxyForSelected(id: string): boolean { return this.proxyForSelected.includes(id); }

  toggleProxyFor(id: string): void {
    if (this.proxyForAll) return;
    this.proxyForSelected = this.proxyForSelected.includes(id)
      ? this.proxyForSelected.filter(s => s !== id)
      : [...this.proxyForSelected, id];
  }

  toggleProxyForAll(): void {
    this.proxyForAll = !this.proxyForAll;
    if (this.proxyForAll) this.proxyForSelected = [];
  }

  createSpace(): void {
    if (!this.form.label.trim()) return;
    this.creating.set(true);
    this.createError.set('');
    const body: Parameters<SpacesApi['createSpace']>[0] = { label: this.form.label.trim() };
    if (this.form.id.trim()) body.id = this.form.id.trim();
    if (this.form.maxGiB) body.maxGiB = this.form.maxGiB;
    if (this.proxyForAll) body.proxyFor = ['*'];
    else if (this.proxyForSelected.length) body.proxyFor = [...this.proxyForSelected];
    // Send the validation choices EXPLICITLY, always. The server now defaults a new space to a
    // fully-strict posture when they are omitted (#400); if the form quietly dropped an 'off'/unchecked
    // choice it would create a strict space while showing the user 'off' — so the form must be
    // authoritative over its own visible values.
    const meta: Partial<SpaceMeta> = {
      validationMode: this.form.validationMode,
      strictLinkage: this.form.strictLinkage,
    };
    if (this.form.purpose.trim()) meta.purpose = this.form.purpose.trim();
    body.meta = meta;
    this.spacesApi.createSpace(body).pipe(
      timeout(30_000),
      finalize(() => this.creating.set(false)),
    ).subscribe({
      next: ({ space }) => {
        this.closed.emit();
        this.store.spaces.update(list => [...list, space]);
        this.form = { label: '', id: '', maxGiB: null, purpose: '', validationMode: 'strict', strictLinkage: true };
        this.proxyForSelected = [];
        this.proxyForAll = false;
        // Vector indexes finish building server-side (B1); poll so the "preparing
        // indexes" badge clears on its own when the space is ready.
        if (space.indexStatus === 'building') this.store.pollIndexStatus();
      },
      error: (err) => {
        if (err instanceof TimeoutError) {
          // The server persists the space even if the response was slow — refetch so
          // it appears instead of silently vanishing, and show a soft note.
          this.createError.set(this.transloco.translate('spaces.error.createTimeout'));
          this.store.load();
          this.store.pollIndexStatus();
        } else {
          this.createError.set(refusalText(this.transloco, err, 'spaces.error.createFailed'));
        }
      },
    });
  }
}
