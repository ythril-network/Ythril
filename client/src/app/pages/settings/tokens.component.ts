import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, TokenRecord } from '../../core/api.service';

@Component({
  selector: 'app-tokens',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [`
    .new-token-banner {
      background: rgba(63, 185, 80, 0.08);
      border: 2px solid rgba(63, 185, 80, 0.5);
      border-radius: var(--radius-md);
      padding: 20px;
      margin-bottom: 20px;
    }
    .new-token-banner-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--success);
      margin-bottom: 4px;
    }
    .new-token-banner-warn {
      font-size: 12px;
      color: var(--text-secondary);
      margin-bottom: 12px;
    }
    .token-copy-row {
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
    }
    .token-copy-value {
      flex: 1;
      font-family: var(--font-mono);
      font-size: 13px;
      word-break: break-all;
      color: var(--text-primary);
    }
    .btn-copy-prominent {
      background: var(--success);
      color: #fff;
      border: none;
      border-radius: var(--radius-sm);
      padding: 8px 18px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: opacity var(--transition);
    }
    .btn-copy-prominent:hover { opacity: 0.88; }
    .scope-hint {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 3px;
    }
    .badge-admin {
      background: rgba(63, 185, 80, 0.15);
      color: var(--success);
      border: 1px solid rgba(63, 185, 80, 0.3);
      border-radius: 4px;
      padding: 1px 7px;
      font-size: 0.73rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .badge-readonly {
      background: rgba(210, 153, 34, 0.15);
      color: var(--warning);
      border: 1px solid rgba(210, 153, 34, 0.3);
      border-radius: 4px;
      padding: 1px 7px;
      font-size: 0.73rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 160px;
      gap: 12px;
      align-items: start;
    }
    .form-grid-bottom {
      display: flex;
      gap: 12px;
      align-items: flex-end;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .checkbox-field {
      display: flex;
      align-items: center;
      gap: 6px;
      padding-bottom: 6px;
    }
    .checkbox-field label {
      margin: 0;
      font-size: 13px;
      color: var(--text-secondary);
      text-transform: none;
      letter-spacing: 0;
      font-weight: 400;
    }
    .token-status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 5px;
      flex-shrink: 0;
    }
    .dot-active { background: var(--success); }
    .dot-expired { background: var(--error); }
    .dot-never-used { background: var(--text-muted); }
  `],
  template: `
    <!-- New token success banner -->
    @if (newToken()) {
      <div class="new-token-banner" role="alert">
        <div class="new-token-banner-title">✓ Token created successfully</div>
        <div class="new-token-banner-warn">⚠️ Copy this token now — it will <strong>not</strong> be shown again after you dismiss this.</div>
        <div class="token-copy-row">
          <span class="token-copy-value" aria-label="New token value">{{ newToken() }}</span>
          <button class="btn-copy-prominent" aria-label="Copy new token" (click)="copyNew()">
            @if (copied()) { ✓ Copied } @else { 📋 Copy token }
          </button>
        </div>
        <button class="btn-secondary btn btn-sm" style="margin-top:12px;" (click)="clearNew()">I've copied it — dismiss</button>
      </div>
    }

    <!-- Rotated token banner -->
    @if (regenToken()) {
      <div class="new-token-banner" role="alert">
        <div class="new-token-banner-title">↺ Token rotated — new secret</div>
        <div class="new-token-banner-warn">⚠️ The old secret is now invalid. Copy this one before dismissing.</div>
        <div class="token-copy-row">
          <span class="token-copy-value" aria-label="Rotated token value">{{ regenToken() }}</span>
          <button class="btn-copy-prominent" aria-label="Copy rotated token" (click)="copyRegen()">
            @if (copiedRegen()) { ✓ Copied } @else { 📋 Copy token }
          </button>
        </div>
        <button class="btn-secondary btn btn-sm" style="margin-top:12px;" (click)="clearRegen()">I've copied it — dismiss</button>
      </div>
    }

    <!-- Create token form -->
    <div class="card" style="margin-bottom: 24px;">
      <div class="card-header">
        <div>
          <div class="card-title">Create token</div>
          <div class="card-subtitle">API tokens grant programmatic access to this brain. Keep them secret.</div>
        </div>
      </div>

      @if (createError()) {
        <div class="alert alert-error" style="margin-bottom:16px;">{{ createError() }}</div>
      }

      <form (ngSubmit)="createToken()" #f="ngForm">
        <div class="form-grid">
          <div class="field" style="margin-bottom:0;">
            <label>Label</label>
            <input type="text" [(ngModel)]="newName" name="name" placeholder="My CLI token" maxlength="200" required />
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Expires (optional)</label>
            <input type="date" [(ngModel)]="newExpiry" name="expiry" />
          </div>
        </div>

        <div class="field" style="margin-top:12px; margin-bottom:0;">
          <label>Spaces (optional)</label>
          <input type="text" [(ngModel)]="newSpaces" name="spaces" placeholder="Comma-separated space IDs, e.g. general, project-x — leave blank to allow all spaces" />
          <div class="scope-hint">Leave blank to grant access to all spaces.</div>
        </div>

        <div class="form-grid-bottom" style="margin-top:12px;">
          @if (selfToken()?.admin) {
            <div class="checkbox-field">
              <input type="checkbox" [(ngModel)]="newAdmin" name="admin" id="newAdmin" style="width:16px;height:16px;margin:0;" />
              <label for="newAdmin">Admin</label>
              <span class="scope-hint" style="margin-top:0; margin-left:2px;">— may manage tokens, spaces, networks</span>
            </div>
          }
          <div class="checkbox-field">
            <input type="checkbox" [(ngModel)]="newReadOnly" name="readOnly" id="newReadOnly" style="width:16px;height:16px;margin:0;" />
            <label for="newReadOnly">Read-only</label>
            <span class="scope-hint" style="margin-top:0; margin-left:2px;">— blocks all write operations</span>
          </div>
          <button class="btn-primary btn" type="submit" style="margin-left:auto;" [disabled]="creating() || !newName.trim()">
            @if (creating()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
            Create token
          </button>
        </div>
      </form>
    </div>

    <!-- Token list -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">Active tokens</div>
        <button class="btn-secondary btn btn-sm" (click)="load()">Refresh</button>
      </div>

      @if (loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else {
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Label</th><th>Created</th><th>Last used</th><th>Expires</th><th>Spaces</th><th></th>
              </tr>
            </thead>
            <tbody>
              @for (t of tokens(); track t.id) {
                <tr>
                  <td style="font-weight:500;">
                    <span class="token-status-dot" [class.dot-active]="!isExpired(t)" [class.dot-expired]="isExpired(t)"></span>
                    {{ t.name }}
                    @if (t.admin) { <span class="badge-admin" style="margin-left:6px;">admin</span> }
                    @if (t.readOnly) { <span class="badge-readonly" style="margin-left:6px;">read-only</span> }
                    @if (t.id === selfToken()?.id) { <span style="margin-left:6px;font-size:0.75rem;color:var(--text-muted);">(current session)</span> }
                  </td>
                  <td style="color:var(--text-muted)">{{ t.createdAt | date:'MMM d, y' }}</td>
                  <td style="color:var(--text-muted)">
                    @if (t.lastUsed) {
                      {{ t.lastUsed | date:'MMM d, y' }}
                    } @else {
                      <span style="font-style:italic;">Never used</span>
                    }
                  </td>
                  <td>
                    @if (t.expiresAt) {
                      <span class="badge" [class.badge-red]="isExpired(t)" [class.badge-gray]="!isExpired(t)">
                        {{ isExpired(t) ? 'Expired' : '' }} {{ t.expiresAt | date:'MMM d, y' }}
                      </span>
                    } @else {
                      <span class="badge badge-green">No expiry</span>
                    }
                  </td>
                  <td>
                    @if (!t.spaces || t.spaces.length === 0) {
                      <span class="badge badge-green">All spaces</span>
                    } @else {
                      <span class="badge badge-gray">{{ t.spaces.join(', ') }}</span>
                    }
                  </td>
                  <td style="white-space:nowrap; display:flex; gap:6px; align-items:center;">
                    <button class="icon-btn" title="Rotate secret" aria-label="Rotate token secret" (click)="regenerate(t)" style="font-size:14px;">↺</button>
                    <button class="icon-btn danger" title="Revoke" aria-label="Revoke token" (click)="revoke(t)">✕</button>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6">
                  <div class="empty-state" style="padding:24px;">
                    <h3>No tokens yet</h3>
                  </div>
                </td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class TokensComponent implements OnInit {
  private api = inject(ApiService);

  tokens = signal<TokenRecord[]>([]);
  selfToken = signal<TokenRecord | null>(null);
  loading = signal(true);
  creating = signal(false);
  createError = signal('');
  newName = '';
  newExpiry = '';
  newAdmin = false;
  newReadOnly = false;
  newSpaces = '';
  newToken = signal('');
  copied = signal(false);
  regenToken = signal('');
  copiedRegen = signal(false);

  ngOnInit(): void {
    this.api.getMe().subscribe({ next: (t) => this.selfToken.set(t), error: () => {} });
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.listTokens().subscribe({
      next: ({ tokens }) => { this.tokens.set(tokens); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  createToken(): void {
    if (!this.newName.trim()) return;
    this.creating.set(true);
    this.createError.set('');

    const body: { name: string; expiresAt?: string; admin?: boolean; readOnly?: boolean; spaces?: string[] } = { name: this.newName.trim() };
    if (this.newExpiry) body.expiresAt = new Date(this.newExpiry).toISOString();
    if (this.newAdmin) body.admin = true;
    if (this.newReadOnly) body.readOnly = true;
    const spaceIds = this.newSpaces.split(',').map(s => s.trim()).filter(Boolean);
    if (spaceIds.length) body.spaces = spaceIds;

    this.api.createToken(body).subscribe({
      next: ({ token, plaintext }) => {
        this.creating.set(false);
        this.tokens.update(list => [token, ...list]);
        this.newToken.set(plaintext);
        this.newName = '';
        this.newExpiry = '';
        this.newAdmin = false;
        this.newReadOnly = false;
        this.newSpaces = '';
      },
      error: (err) => {
        this.creating.set(false);
        this.createError.set(err.error?.error ?? 'Failed to create token');
      },
    });
  }

  regenerate(t: TokenRecord): void {
    if (!confirm(`Rotate secret for "${t.name}"?\n\nThe current token will stop working immediately. Copy the new secret before closing this dialog.`)) return;
    this.clearRegen();
    this.api.regenerateToken(t.id).subscribe({
      next: ({ plaintext }) => this.regenToken.set(plaintext),
      error: () => alert('Failed to regenerate token.'),
    });
  }

  revoke(t: TokenRecord): void {
    if (!confirm(`Revoke token "${t.name}"? This cannot be undone.`)) return;
    this.api.revokeToken(t.id).subscribe({
      next: () => this.tokens.update(list => list.filter(x => x.id !== t.id)),
      error: () => alert('Failed to revoke token.'),
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

  isExpired(t: TokenRecord): boolean {
    return !!(t.expiresAt && new Date(t.expiresAt) < new Date());
  }
}
