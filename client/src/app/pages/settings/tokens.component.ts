import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Space, TokenRecord } from '../../core/api.types';
import { AuthApi } from '../../core/auth-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { TranslocoPipe } from '@jsverse/transloco';
import { TranslocoService } from '@jsverse/transloco';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { computed } from '@angular/core';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { SummaryStripComponent, SummaryItem } from '../../shared/summary-strip.component';
import { TokenCreateDialogComponent } from './token-create-dialog.component';
import { TokenRightsDialogComponent } from './token-rights-dialog.component';
import { OwnTokenRightsComponent } from './own-token-rights.component';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { httpErrorReason } from '../../core/http-error';
import { TOKENS_PAGE_STYLES } from './tokens.styles';
import { TokenTableComponent } from './token-table.component';
import { filterTokens, sortTokens, isExpired, isExpiringSoon } from './token-table';
import type { TokenSortField, SortDir } from './token-table';

@Component({
  selector: 'app-tokens',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent, ModalDirective,
            SummaryStripComponent, ErrorStateComponent, TokenCreateDialogComponent,
            TokenRightsDialogComponent, OwnTokenRightsComponent, TokenTableComponent],
  styles: [TOKENS_PAGE_STYLES],
  template: `
    <!-- New token success banner -->
    @if (newToken()) {
      <div class="new-token-banner" role="alert">
        <div class="new-token-banner-title">{{ 'tokens.created.title' | transloco }}</div>
        <div class="new-token-banner-warn">{{ 'tokens.created.warning' | transloco }}</div>
        <div class="token-copy-row">
          <span class="token-copy-value" [attr.aria-label]="'tokens.created.newTokenValueAria' | transloco">{{ newToken() }}</span>
          <button class="btn-copy-prominent" [attr.aria-label]="'tokens.created.copyNewAria' | transloco" (click)="copyNew()">
            @if (copied()) { {{ 'common.copied' | transloco }} } @else { {{ 'tokens.created.copyButton' | transloco }} }
          </button>
        </div>
        <button class="btn-secondary btn btn-sm" style="margin-top:12px;" (click)="clearNew()">{{ 'tokens.created.dismissButton' | transloco }}</button>
      </div>
    }

    <!-- Rotated token banner -->
    @if (regenToken()) {
      <div class="new-token-banner" role="alert">
        <div class="new-token-banner-title">{{ 'tokens.rotated.title' | transloco }}</div>
        <div class="new-token-banner-warn">{{ 'tokens.rotated.warning' | transloco }}</div>
        <div class="token-copy-row">
          <span class="token-copy-value" [attr.aria-label]="'tokens.rotated.tokenValueAria' | transloco">{{ regenToken() }}</span>
          <button class="btn-copy-prominent" [attr.aria-label]="'tokens.rotated.copyAria' | transloco" (click)="copyRegen()">
            @if (copiedRegen()) { {{ 'common.copied' | transloco }} } @else { {{ 'tokens.created.copyButton' | transloco }} }
          </button>
        </div>
        <button class="btn-secondary btn btn-sm" style="margin-top:12px;" (click)="clearRegen()">{{ 'tokens.created.dismissButton' | transloco }}</button>
      </div>
    }

    @if (editRightsFor(); as t) {
      <app-token-rights-dialog
        [token]="t"
        [availableSpaces]="availableSpaces()"
        (close)="editRightsFor.set(null)"
        (saved)="onRightsSaved($event)"
        (rotate)="dangerFromEditor(t, 'rotate')"
        (revoke)="dangerFromEditor(t, 'revoke')"/>
    }

    <!-- The create dialog lives in TokenCreateDialogComponent. It was over a quarter of this file and
         is a self-contained flow with thirteen pieces of its own state; leaving it here is what kept
         this component over the god-file ceiling. -->
    @if (showCreateDialog()) {
      <app-token-create-dialog
        [availableSpaces]="availableSpaces()"
        [spacesLoadFailed]="spacesLoadFailed()"
        (close)="showCreateDialog.set(false)"
        (created)="onTokenCreated($event)"/>
    }

    <!-- Operator summary -->
    @if (!loading() && tokens().length) {
      <app-summary-strip [heading]="'tokens.list.title' | transloco" [items]="summary()" style="display:block;margin-bottom:16px;"/>
    }

    <!-- Token list -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">{{ 'tokens.list.title' | transloco }}</div>
        <div style="display:flex; gap:8px;">
          <button class="btn-primary btn btn-sm" (click)="showCreateDialog.set(true)">{{ 'tokens.list.createButton' | transloco }}</button>
          <button class="btn-secondary btn btn-sm" (click)="load()">{{ 'tokens.list.refreshButton' | transloco }}</button>
        </div>
      </div>

      <!-- Your own rights, always, above the list. The list needs admin and 403s for everyone else, so without
           this a non-admin opening this page saw an error where their own access should be. Rendered outside the
           loading branch because it does not depend on the list request at all. -->
      <app-own-token-rights/>

      @if (loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else if (loadError() !== null) {
        <!-- The full list is admin-only. That is not a fault to retry your way out of, so it is said plainly
             here rather than left as a bare 403 reason. -->
        <app-error-state [message]="'tokens.loadError' | transloco" [reason]="loadError() ?? ''" (retry)="load()" />
        <p style="font-size:12.5px;color:var(--text-muted);margin-top:8px;">{{ 'tokens.listNeedsAdmin' | transloco }}</p>
      } @else {
        <app-token-table
          [rows]="visibleTokens()"
          [sortField]="sortField()"
          [sortDir]="sortDir()"
          [labelFilter]="labelFilter()"
          [spacesFilter]="spacesFilter()"
          [filtered]="isFiltered()"
          [editingId]="editingId() ?? ''"
          [selfTokenId]="selfToken()?.id ?? ''"
          [(editLabelValue)]="editLabelModel"
          (sort)="setSort($event)"
          (labelFilterChange)="labelFilter.set($event)"
          (spacesFilterChange)="spacesFilter.set($event)"
          (clearFilters)="clearFilters()"
          (editLabelStart)="startEditLabel($event)"
          (editLabelSave)="saveLabel($event)"
          (editLabelCancel)="cancelEditLabel()"
          (editRights)="editRightsFor.set($event)"
          (rotate)="regenerate($event)"
          (revoke)="revoke($event)"
          (create)="showCreateDialog.set(true)" />
      }
    </div>
  `,
})
export class TokensComponent implements OnInit {
  private authApi = inject(AuthApi);
  private spacesApi = inject(SpacesApi);
  private transloco = inject(TranslocoService);
  private toast = inject(ToastService);
  private confirmDialog = inject(ConfirmDialogService);

  tokens = signal<TokenRecord[]>([]);
  selfToken = signal<TokenRecord | null>(null);
  availableSpaces = signal<Space[]>([]);
  loading = signal(true);
  /** Null until the last load failed — checked before the empty state, so a failure never reads as "no tokens". */
  loadError = signal<string | null>(null);
  showCreateDialog = signal(false);
  /** The token whose rights are being edited, or null. Holding the RECORD rather than an id keeps the dialog
   *  from having to look it up again and disagreeing with the row that opened it. */
  /**
   * A credential's timestamps are absolute, not relative.
   *
   * These read "3 days ago" until 3.0.1. That answers how long, when the question an operator auditing
   * access actually asks is WHEN — which log line, which incident, which deploy. "14 days ago" also
   * quietly rounds: a token expiring in 23 hours and one expiring in 47 both read "tomorrow".
   *
   * Rendered in the VIEWER's locale and timezone by the platform, so it needs no timezone label of its own.
   */
  editRightsFor = signal<TokenRecord | null>(null);

  /**
   * Whether the operator switched from the legacy permission control to the per-space matrix.
   *
   * Not a view toggle — the two are mutually exclusive on the wire, and the server refuses a body carrying
   * both rather than silently preferring one. So this decides WHICH field the create request sends.
   */
  /** Just the ids, because the matrix keys rows by id and does not need the rest of a space. */

  /** Second factor for the token being created. `inherit` is today's behaviour for every existing token. */
  spacesLoadFailed = signal(false);
  newToken = signal('');
  copied = signal(false);
  regenToken = signal('');
  copiedRegen = signal(false);
  /** Inline label edit: the id of the token whose label is being edited (null = none), + its draft. */
  editingId = signal<string | null>(null);
  /*
   * A signal rather than a plain string, because the table is a child component now and binds it two-way. The
   * page keeps owning the value — it is what `saveLabel` sends — and only the editing happens elsewhere.
   */
  editLabelModel = signal('');

  /**
   * Which column the list is ordered by, and which way.
   *
   * Client-side, deliberately: `listTokens()` returns every token in one response and there is no paged token
   * endpoint, so there is nothing to ask the server for. `token-table.ts` says why that is not a shortcut.
   *
   * The default is the order the server sent, so the page looks exactly as it did until a header is clicked —
   * `''` is not a column, and `sortTokens` is only reached once one is chosen.
   */
  sortField = signal<TokenSortField | ''>('');
  sortDir = signal<SortDir>('asc');

  /** The two searchable columns the owner asked for. */
  labelFilter = signal('');
  spacesFilter = signal('');

  isFiltered = computed(() => !!(this.labelFilter().trim() || this.spacesFilter().trim()));

  /**
   * What the table renders: filtered, then sorted.
   *
   * That order matters and is not interchangeable. Sorting first would order rows that are about to be thrown
   * away, which is only wasted work — but filtering first also means the sort sees exactly the rows on screen,
   * so a column's blanks-last rule is true of what the operator is looking at rather than of the whole list.
   */
  visibleTokens = computed<TokenRecord[]>(() => {
    const narrowed = filterTokens(this.tokens(), { label: this.labelFilter(), spaces: this.spacesFilter() });
    const field = this.sortField();
    return field ? sortTokens(narrowed, field, this.sortDir()) : narrowed;
  });

  /**
   * Click a header: sort by it, or flip the direction if it is already the active column.
   *
   * A third click does NOT clear back to the server's order, which the Brain tables do. There it is worth
   * having, because their order comes from Mongo and is meaningful; here the unsorted order is the order the
   * rows happened to be returned in, and offering a click that returns to it would be offering a state nobody
   * wants. Reload is what gets it back.
   */
  setSort(field: string): void {
    if (this.sortField() === field) {
      this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : 'asc');
      return;
    }
    this.sortField.set(field as TokenSortField);
    this.sortDir.set('asc');
  }

  clearFilters(): void {
    this.labelFilter.set('');
    this.spacesFilter.set('');
  }


  ngOnInit(): void {
    this.authApi.getMe().subscribe({ next: (t) => this.selfToken.set(t), error: () => {} });
    this.spacesApi.listSpaces().subscribe({
      next: ({ spaces }) => this.availableSpaces.set(spaces),
      error: () => this.spacesLoadFailed.set(true),
    });
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.authApi.listTokens().subscribe({
      next: ({ tokens }) => { this.tokens.set(tokens); this.loading.set(false); },
      error: (err) => { this.loadError.set(httpErrorReason(err)); this.loading.set(false); },
    });
  }


  /** The dialog owns the create flow; the page owns the list and the one-time plaintext reveal. */
  onRightsSaved(updated: TokenRecord): void {
    this.editRightsFor.set(null);
    this.tokens.update(list => list.map(t => (t.id === updated.id ? updated : t)));
    this.toast.success(this.transloco.translate('tokens.rights.saved'));
  }

  onTokenCreated(e: { token: TokenRecord; plaintext: string }): void {
    this.showCreateDialog.set(false);
    this.tokens.update(list => [e.token, ...list]);
    this.newToken.set(e.plaintext);
  }




  /**
   * A danger action asked for from inside the editor.
   *
   * The editor emits rather than doing it: this page already owns the confirm dialog, the toast on failure,
   * the list removal, and — the part that decides the shape — the **copy-once banner** that rotate's new
   * secret appears in. A second implementation inside the modal would mean a second banner, and a secret is
   * shown exactly once.
   *
   * The editor CLOSES first, and that is not tidiness: the banner renders on this page, behind the modal. A
   * rotate that left the dialog open would put the only copy of a new credential underneath it.
   */
  dangerFromEditor(t: TokenRecord, action: 'rotate' | 'revoke'): void {
    this.editRightsFor.set(null);
    if (action === 'rotate') void this.regenerate(t);
    else void this.revoke(t);
  }

  async regenerate(t: TokenRecord): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('tokens.confirm.rotateTitle'),
      message: this.transloco.translate('tokens.confirm.rotate', { name: t.name }),
      confirmLabel: this.transloco.translate('tokens.rotateButton'),
      danger: true,
    });
    if (!ok) return;
    this.clearRegen();
    this.authApi.regenerateToken(t.id).subscribe({
      next: ({ plaintext }) => this.regenToken.set(plaintext),
      error: () => this.toast.error(this.transloco.translate('tokens.error.rotateFailed')),
    });
  }

  async revoke(t: TokenRecord): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('tokens.confirm.revokeTitle'),
      message: this.transloco.translate('tokens.confirm.revoke', { name: t.name }),
      confirmLabel: this.transloco.translate('common.revoke'),
      danger: true,
    });
    if (!ok) return;
    this.authApi.revokeToken(t.id).subscribe({
      next: () => this.tokens.update(list => list.filter(x => x.id !== t.id)),
      error: () => this.toast.error(this.transloco.translate('tokens.error.revokeFailed')),
    });
  }

  startEditLabel(t: TokenRecord): void {
    this.editingId.set(t.id);
    this.editLabelModel.set(t.name);
  }

  cancelEditLabel(): void {
    this.editingId.set(null);
    this.editLabelModel.set('');
  }

  saveLabel(t: TokenRecord): void {
    const name = this.editLabelModel().trim();
    // A blank or unchanged label is a no-op, not a request — just close the editor.
    if (!name || name === t.name) { this.cancelEditLabel(); return; }
    this.authApi.renameToken(t.id, name).subscribe({
      next: ({ token }) => {
        this.tokens.update(list => list.map(x => x.id === t.id ? { ...x, name: token.name } : x));
        this.cancelEditLabel();
      },
      error: () => this.toast.error(this.transloco.translate('tokens.error.renameFailed')),
    });
  }

  clearNew(): void { this.newToken.set(''); this.copied.set(false); }
  clearRegen(): void { this.regenToken.set(''); this.copiedRegen.set(false); }

  copyNew(): void {
    navigator.clipboard.writeText(this.newToken()).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    });
  }

  copyRegen(): void {
    navigator.clipboard.writeText(this.regenToken()).then(() => {
      this.copiedRegen.set(true);
      setTimeout(() => this.copiedRegen.set(false), 2000);
    });
  }

  /*
   * Both predicates live in `token-table.ts` now, because the table's badges and this page's rollup are two
   * consumers of one rule. A copy on each would let the badge and the count disagree about the same token, and
   * that would read as a rendering glitch rather than as two implementations of one thing.
   */
  isExpired = isExpired;
  isExpiringSoon = isExpiringSoon;

  /** Operator-first rollup: active / expiring-soon / expired counts (warn/error only shown when > 0). */
  summary = computed<SummaryItem[]>(() => {
    const ts = this.tokens();
    const expired = ts.filter(t => this.isExpired(t)).length;
    const expiring = ts.filter(t => this.isExpiringSoon(t)).length;
    const tr = (k: string) => this.transloco.translate(k);
    const items: SummaryItem[] = [{ label: tr('tokens.summary.active'), value: ts.length - expired }];
    if (expiring) items.push({ label: tr('tokens.summary.expiring'), value: expiring, variant: 'warn' });
    if (expired) items.push({ label: tr('tokens.summary.expired'), value: expired, variant: 'error' });
    return items;
  });
}
