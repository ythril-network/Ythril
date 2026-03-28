import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { ApiService } from '../../core/api.service';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  styles: [`
    :host { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

    .topbar {
      height: var(--topbar-height);
      min-height: var(--topbar-height);
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      padding: 0 20px;
      gap: 16px;
      z-index: 10;
    }

    .topbar-logo {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.03em;
      display: flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
    }

    .topbar-logo-dot {
      width: 7px;
      height: 7px;
      background: var(--accent);
      border-radius: 50%;
      flex-shrink: 0;
    }

    .topbar-spacer { flex: 1; }

    .topbar-logout {
      background: none;
      border: none;
      color: var(--text-secondary);
      font-size: 13px;
      cursor: pointer;
      padding: 5px 10px;
      border-radius: var(--radius-sm);
      transition: color var(--transition), background var(--transition);
      font-family: var(--font);
    }
    .topbar-logout:hover { color: var(--text-primary); background: var(--bg-elevated); }

    .layout {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    .sidebar {
      width: var(--sidebar-width);
      min-width: var(--sidebar-width);
      background: var(--bg-surface);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      padding: 16px 12px;
    }

    .nav-section-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      padding: 4px 8px;
      margin-bottom: 4px;
      margin-top: 12px;
    }

    .nav-section-label:first-child { margin-top: 0; }

    .nav-link {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 10px;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 500;
      text-decoration: none;
      transition: color var(--transition), background var(--transition);
      cursor: pointer;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      font-family: var(--font);
    }

    .nav-link:hover { color: var(--text-primary); background: var(--bg-elevated); }

    .nav-link.active {
      color: var(--text-primary);
      background: var(--bg-elevated);
    }

    .nav-link .nav-icon {
      width: 16px;
      text-align: center;
      opacity: 0.8;
    }

    .nav-badge {
      margin-left: auto;
      background: var(--danger, #e53e3e);
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      border-radius: 999px;
      padding: 1px 6px;
      min-width: 18px;
      text-align: center;
      line-height: 16px;
    }

    .main {
      flex: 1;
      overflow-y: auto;
      padding: 28px 32px;
    }

    @media (max-width: 768px) {
      .sidebar { display: none; }
      .main { padding: 20px 16px; }
    }
  `],
  template: `
    <!-- Top bar -->
    <header class="topbar">
      <a class="topbar-logo" routerLink="/">
        <span class="topbar-logo-dot"></span>
        ythril
      </a>
      <span class="topbar-spacer"></span>
      <button class="topbar-logout" (click)="logout()">Sign out</button>
    </header>

    <div class="layout">
      <!-- Sidebar navigation -->
      <nav class="sidebar">
        <span class="nav-section-label">Workspace</span>
        <a class="nav-link" routerLink="/brain" routerLinkActive="active">
          <span class="nav-icon">🧠</span>Brain
        </a>
        <a class="nav-link" routerLink="/files" routerLinkActive="active"
           [routerLinkActiveOptions]="{ exact: true }">
          <span class="nav-icon">📁</span>Files
        </a>
        @if (conflictCount() > 0) {
          <a class="nav-link" routerLink="/files/conflicts" routerLinkActive="active">
            <span class="nav-icon">⚠️</span>Conflicts
            <span class="nav-badge">{{ conflictCount() }}</span>
          </a>
        }

        <span class="nav-section-label">Admin</span>
        <a class="nav-link" routerLink="/settings/tokens" routerLinkActive="active">
          <span class="nav-icon">🔑</span>Tokens
        </a>
        <a class="nav-link" routerLink="/settings/spaces" routerLinkActive="active">
          <span class="nav-icon">📦</span>Spaces
        </a>
        <a class="nav-link" routerLink="/settings/storage" routerLinkActive="active">
          <span class="nav-icon">💾</span>Storage
        </a>
        <a class="nav-link" routerLink="/settings/networks" routerLinkActive="active">
          <span class="nav-icon">🔗</span>Networks
        </a>
        <a class="nav-link" routerLink="/settings/mfa" routerLinkActive="active">
          <span class="nav-icon">🔐</span>MFA
        </a>
        <a class="nav-link" routerLink="/settings/about" routerLinkActive="active">
          <span class="nav-icon">ℹ️</span>About
        </a>
      </nav>

      <!-- Page content -->
      <main class="main">
        <router-outlet />
      </main>
    </div>
  `,
})
export class ShellComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  private api = inject(ApiService);

  conflictCount = signal(0);

  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.loadConflictCount();
    // Refresh badge every 60 s so it tracks new conflicts without a page reload
    this._pollTimer = setInterval(() => this.loadConflictCount(), 60_000);
  }

  private loadConflictCount(): void {
    this.api.listConflicts().subscribe({
      next: ({ conflicts }) => this.conflictCount.set(conflicts.length),
      error: () => { /* non-fatal — badge stays at last known value */ },
    });
  }

  logout(): void {
    if (this._pollTimer !== null) clearInterval(this._pollTimer);
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
