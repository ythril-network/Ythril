import { Component, inject, signal, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Network, Space } from '../../core/api.types';
import { NetworksApi } from '../../core/networks-api.service';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';
import { refusalText } from '../../core/refusal-text';

/**
 * Create-network dialog, extracted from the (large) NetworksComponent as the first slice of taming that
 * 1261-line file (PR-U3). Owns the whole create form — label / type / space selection (with a
 * comma-separated fallback when the spaces list can't load) and the voting-deadline field — and performs
 * the `createNetwork` API call itself, emitting the created `Network` to the host (which appends it and
 * closes the dialog). Behaviour is unchanged from the inline version; the create characterization tests
 * moved here with it (network-create-dialog.component.spec.ts).
 *
 * Host renders it gated: `@if (showCreateDialog()) { <app-network-create-dialog … /> }`, so this
 * component is only alive while open and needs no visibility state of its own.
 */
@Component({
  selector: 'app-network-create-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent, ModalDirective, HscrollTopDirective],
  styles: [`
    .dialog-backdrop {
      position: fixed;
      inset: 0;
      background: var(--bg-scrim);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .dialog {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      width: 90%;
      max-width: 600px;
      max-height: 90vh;
      overflow-y: auto;
    }
    .dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
  `],
  template: `
    <div class="dialog-backdrop">
      <div class="dialog" [appModal]="'networks.dialog.create.title' | transloco" (dismiss)="close.emit()" (click)="$event.stopPropagation()">
        <div class="dialog-header">
          <div class="card-title">{{ 'networks.dialog.create.title' | transloco }}</div>
          <button class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="close.emit()"><ph-icon name="x" [size]="14"/></button>
        </div>

        @if (createError()) { <div class="alert alert-error">{{ createError() }}</div> }

        <form (ngSubmit)="createNetwork()" style="display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:end;">
          <div class="field" style="margin-bottom:0;">
            <label>{{ 'networks.dialog.create.label' | transloco }}</label>
            <input type="text" [(ngModel)]="form.label" name="label" [placeholder]="'networks.dialog.create.labelPlaceholder' | transloco" required />
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>{{ 'networks.dialog.create.type' | transloco }}</label>
            <select [(ngModel)]="form.type" name="type">
              <option value="closed">{{ 'networks.type.closed' | transloco }}</option>
              <option value="democratic">{{ 'networks.type.democratic' | transloco }}</option>
              <option value="club">{{ 'networks.type.club' | transloco }}</option>
              <option value="braintree">{{ 'networks.type.braintree' | transloco }}</option>
              <option value="pubsub">{{ 'networks.type.pubsub' | transloco }}</option>
            </select>
          </div>
          <div class="field" style="margin-bottom:0; grid-column:span 2;">
            <label>{{ 'networks.dialog.create.spaces' | transloco }}</label>
            @if (spacesLoadFailed()) {
              <div class="alert alert-error" style="margin-bottom:6px; font-size:12px;">{{ 'networks.dialog.create.spacesLoadFailed' | transloco }}</div>
              <input type="text" [(ngModel)]="networkSpacesFallback" name="spaces" [placeholder]="'networks.dialog.create.spacesFallbackPlaceholder' | transloco" />
            } @else if (availableSpaces().length === 0) {
              <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">{{ 'networks.dialog.create.loadingSpaces' | transloco }}</div>
            } @else {
              <div class="table-wrapper" hscrollTop style="max-height:200px; overflow-y:auto; border:1px solid var(--border); border-radius:var(--radius-sm);">
                <table style="margin:0;">
                  <thead>
                    <tr>
                      <th style="width:40px; text-align:center;">
                        <input type="checkbox" [checked]="networkSelectAll" (change)="toggleNetworkSelectAll()" [attr.title]="'networks.dialog.create.allSpacesTitle' | transloco" />
                      </th>
                      <th>{{ 'spaces.table.column.label' | transloco }}</th>
                      <th>{{ 'spaces.table.column.id' | transloco }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of availableSpaces(); track s.id) {
                      <tr style="cursor:pointer;" (click)="toggleNetworkSpace(s.id)">
                        <td style="text-align:center;">
                          <input type="checkbox" [checked]="isNetworkSpaceSelected(s.id)" (click)="$event.stopPropagation()" (change)="toggleNetworkSpace(s.id)" />
                        </td>
                        <td>{{ s.label }}</td>
                        <td><span class="badge badge-gray mono">{{ s.id }}</span></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </div>
          @if (form.type !== 'pubsub') {
            <div class="field" style="margin-bottom:0; grid-column:span 2;">
              <label>{{ 'networks.dialog.create.votingDeadline' | transloco }}</label>
              <input type="number" [(ngModel)]="form.votingDeadlineHours" name="deadline" min="1" max="72" />
            </div>
          }
          <div style="grid-column:span 2; display:flex; gap:8px; justify-content:flex-end;">
            <button class="btn-secondary btn" type="button" (click)="close.emit()">{{ 'common.cancel' | transloco }}</button>
            <button class="btn-primary btn" type="submit" [disabled]="creating() || !form.label.trim()">
              @if (creating()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
              {{ 'networks.dialog.create.submitButton' | transloco }}
            </button>
          </div>
        </form>
      </div>
    </div>
  `,
})
export class NetworkCreateDialogComponent {
  private networksApi = inject(NetworksApi);
  private transloco = inject(TranslocoService);

  /** Local spaces to offer for selection (resolved by the host). */
  readonly availableSpaces = input<Space[]>([]);
  /** When the host's spaces list failed to load, fall back to a comma-separated ids field. */
  readonly spacesLoadFailed = input(false);

  /** Emitted with the newly-created network — the host appends it and closes this dialog. */
  readonly created = output<Network>();
  /** Emitted when the user cancels/dismisses. */
  readonly close = output<void>();

  form = { label: '', type: 'closed', votingDeadlineHours: 48 };
  networkSpacesFallback = '';
  networkSelectedSpaces: string[] = [];
  networkSelectAll = false;
  creating = signal(false);
  createError = signal('');

  createNetwork(): void {
    if (!this.form.label.trim()) return;
    this.creating.set(true);
    this.createError.set('');

    let spaces: string[];
    if (this.spacesLoadFailed()) {
      spaces = this.networkSpacesFallback.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      spaces = [...this.networkSelectedSpaces];
    }

    this.networksApi.createNetwork({
      label: this.form.label.trim(),
      type: this.form.type,
      spaces,
      votingDeadlineHours: this.form.votingDeadlineHours,
    }).subscribe({
      next: (net) => {
        this.creating.set(false);
        this.created.emit(net);
      },
      error: (err) => {
        this.creating.set(false);
        this.createError.set(refusalText(this.transloco, err, 'networks.error.createFailed'));
      },
    });
  }

  isNetworkSpaceSelected(id: string): boolean {
    return this.networkSelectedSpaces.includes(id);
  }

  toggleNetworkSpace(id: string): void {
    if (this.networkSelectedSpaces.includes(id)) {
      this.networkSelectedSpaces = this.networkSelectedSpaces.filter(s => s !== id);
    } else {
      this.networkSelectedSpaces = [...this.networkSelectedSpaces, id];
    }
    this.networkSelectAll = this.networkSelectedSpaces.length === this.availableSpaces().length;
  }

  toggleNetworkSelectAll(): void {
    this.networkSelectAll = !this.networkSelectAll;
    if (this.networkSelectAll) {
      this.networkSelectedSpaces = this.availableSpaces().map(s => s.id);
    } else {
      this.networkSelectedSpaces = [];
    }
  }
}
