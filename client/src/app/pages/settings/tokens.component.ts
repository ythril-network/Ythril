import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, TokenRecord } from '../../core/api.service';

@Component({
  selector: 'app-tokens',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [`
    .token-value {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
      font-family: var(--font-mono);
      font-size: 13px;
      word-break: break-all;
      margin: 8px 0 12px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .token-value span { flex: 1; }
  `],
  template: `
    <div class="card" style="margin-bottom: 24px;">
      <div class="card-header">
        <div>
          <div class="card-title">Create token</div>
          <div class="card-subtitle">Tokens grant API and MCP access.</div>
        </div>
      </div>

      @if (newToken()) {
        <div class="alert alert-success">
          Token created. Copy it now — it won't be shown again.
        </div>
        <div class="token-value">
          <span>{{ newToken() }}</span>
          <button class="btn-ghost btn btn-sm" (click)="copyNew()">
            {{ copied() ? '✓ Copied' : 'Copy' }}
          </button>
        </div>
        <button class="btn-secondary btn btn-sm" (click)="clearNew()">Done</button>
      } @else {
        <form (ngSubmit)="createToken()" #f="ngForm" style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap;">
          <div class="field" style="flex:1; min-width:180px; margin-bottom:0;">
            <label>Label</label>
            <input type="text" [(ngModel)]="newName" name="name" placeholder="My CLI token" maxlength="200" required />
          </div>
          <div class="field" style="width:160px; margin-bottom:0;">
            <label>Expires (optional)</label>
            <input type="date" [(ngModel)]="newExpiry" name="expiry" />
          </div>
          <button class="btn-primary btn" type="submit" [disabled]="creating() || !newName.trim()">
            @if (creating()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
            Create
          </button>
        </form>
      }

      @if (createError()) {
        <div class="alert alert-error" style="margin-top:12px;">{{ createError() }}</div>
      }
    </div>

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
                  <td style="font-weight:500;">{{ t.name }}</td>
                  <td style="color:var(--text-muted)">{{ t.createdAt | date:'MMM d, y' }}</td>
                  <td style="color:var(--text-muted)">{{ t.lastUsed ? (t.lastUsed | date:'MMM d, y') : '—' }}</td>
                  <td>
                    @if (t.expiresAt) {
                      <span class="badge" [class.badge-red]="isExpired(t)" [class.badge-gray]="!isExpired(t)">
                        {{ t.expiresAt | date:'MMM d, y' }}
                      </span>
                    } @else {
                      <span style="color:var(--text-muted)">Never</span>
                    }
                  </td>
                  <td>
                    @if (!t.spaces || t.spaces.length === 0) {
                      <span class="badge badge-green">All</span>
                    } @else {
                      <span class="badge badge-gray">{{ t.spaces.join(', ') }}</span>
                    }
                  </td>
                  <td>
                    <button class="icon-btn danger" title="Revoke" (click)="revoke(t)">✕</button>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6">
                  <div class="empty-state" style="padding:24px;">
                    <h3>No tokens</h3>
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
  loading = signal(true);
  creating = signal(false);
  createError = signal('');
  newName = '';
  newExpiry = '';
  newToken = signal('');
  copied = signal(false);

  ngOnInit(): void { this.load(); }

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

    const body: { name: string; expiresAt?: string } = { name: this.newName.trim() };
    if (this.newExpiry) body.expiresAt = new Date(this.newExpiry).toISOString();

    this.api.createToken(body).subscribe({
      next: ({ token, plaintext }) => {
        this.creating.set(false);
        this.tokens.update(list => [token, ...list]);
        this.newToken.set(plaintext);
        this.newName = '';
        this.newExpiry = '';
      },
      error: (err) => {
        this.creating.set(false);
        this.createError.set(err.error?.error ?? 'Failed to create token');
      },
    });
  }

  revoke(t: TokenRecord): void {
    if (!confirm(`Revoke token "${t.name}"? This cannot be undone.`)) return;
    this.api.revokeToken(t.id).subscribe({
      next: () => this.tokens.update(list => list.filter(x => x.id !== t.id)),
    });
  }

  clearNew(): void { this.newToken.set(''); this.copied.set(false); }

  copyNew(): void {
    navigator.clipboard.writeText(this.newToken()).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    });
  }

  isExpired(t: TokenRecord): boolean {
    return !!(t.expiresAt && new Date(t.expiresAt) < new Date());
  }
}
