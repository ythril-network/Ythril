import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { forkJoin } from 'rxjs';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { ToastService } from '../../core/toast.service';
import { ViewsApi, viewRefusalText, type UnclaimedView, type ViewOrphans, type ViewsMigrationReport } from '../../core/views-api.service';
import { ViewsStore } from '../../core/views.store';

/**
 * What the 6.0 upgrade did with the proxy spaces, and the three instance-admin doors it leaves (Q-531, plan rev 3.2 "Client": the
 * orphan/claim/purge doors get an admin panel; "Migration notice: an in-app banner for admins after upgrade listing claimed/unclaimed
 * views and retired ids").
 *
 * ## Who sees it
 *
 * Only an instance admin: `retired` is `GET /api/spaces`' `retiredSpaceIds`, which the server serves to an admin alone, so `null` means "not
 * yours to see" and renders nothing, and asks the server nothing (the three doors would answer 403). An admin with no reserved id gets the
 * panel with its "nothing to report" sentence, because unclaimed definitions can outlive the ids.
 *
 * ## The three acts
 *
 * - **Claim** gives an unclaimed definition (kept because no admin token was live at the upgrade) to the calling admin as their own view.
 * - **Purge** drops the rows still stored under a reserved id and releases it. It is irreversible, so it is the type-the-id confirm; and
 *   the confirm says what the server's `confirmOidcClaims` is about (users whose OIDC claim still names the id will reach a space created
 *   under it), so sending it is the admin's stated word and not a flag the page sets on their behalf.
 * - The orphan list is COUNTS per kind of owner, never names: an admin reading it learns nothing about another token's views.
 */
@Component({
  selector: 'app-views-admin-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    @if (retired() !== null) {
      <section class="card" aria-labelledby="views-admin-title" style="margin-bottom:16px;">
        <div class="card-header"><div class="card-title" id="views-admin-title">{{ 'views.admin.title' | transloco }}</div></div>
        <p class="hint" style="margin:0 0 10px;">{{ 'views.admin.intro' | transloco }}</p>
        @if (failed()) { <div class="alert alert-error" role="alert">{{ 'views.admin.loadFailed' | transloco }}</div> }
        @if (error()) { <div class="alert alert-error" role="alert">{{ error() }}</div> }

        @if (migratedCount() > 0) {
          <p style="margin:0 0 10px;">{{ 'views.admin.migrated' | transloco: { count: migratedCount() } }}</p>
        }
        @if (networksLost().length > 0) {
          <h4 style="margin:12px 0 4px;font-size:13px;">{{ 'views.admin.networksTitle' | transloco }}</h4>
          <ul style="margin:0 0 10px;padding-left:18px;font-size:13px;">
            @for (n of networksLost(); track n.networkId) {
              <li>{{ 'views.admin.networksLine' | transloco: { network: n.label || n.networkId, ids: n.spaceIds.join(', ') } }}</li>
            }
          </ul>
        }

        @if (unclaimed().length > 0) {
          <h4 style="margin:12px 0 4px;font-size:13px;">{{ 'views.admin.unclaimedTitle' | transloco }}</h4>
          <p class="hint" style="margin:0 0 6px;">{{ 'views.admin.unclaimedHint' | transloco }}</p>
          <ul style="list-style:none;margin:0 0 10px;padding:0;">
            @for (u of unclaimed(); track u.name) {
              <li style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                <span class="mono">{{ '@' + u.name }}</span>
                <button class="btn btn-sm btn-secondary" type="button" [disabled]="busy() === 'claim:' + u.name" (click)="claim(u)">{{ 'views.admin.claim' | transloco: { name: u.name } }}</button>
              </li>
            }
          </ul>
        }

        @if (orphans().length > 0) {
          <h4 style="margin:12px 0 4px;font-size:13px;">{{ 'views.admin.orphansTitle' | transloco }}</h4>
          <ul style="margin:0 0 10px;padding-left:18px;font-size:13px;">
            @for (o of orphans(); track o.ownerKind) { <li>{{ 'views.admin.orphanLine' | transloco: { kind: o.ownerKind, count: o.count } }}</li> }
          </ul>
        }

        @if (reserved().length > 0) {
          <h4 style="margin:12px 0 4px;font-size:13px;">{{ 'views.admin.retiredTitle' | transloco }}</h4>
          <p class="hint" style="margin:0 0 6px;">{{ 'views.admin.retiredHint' | transloco }}</p>
          <ul style="list-style:none;margin:0;padding:0;">
            @for (id of reserved(); track id) {
              <li style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                <span class="mono">{{ id }}</span>
                <button class="btn btn-sm btn-secondary" type="button" [disabled]="busy() === 'purge:' + id" (click)="purge(id)">{{ 'views.admin.purge' | transloco: { id } }}</button>
              </li>
            }
          </ul>
        } @else if (loaded() && migratedCount() === 0 && unclaimed().length === 0 && orphans().length === 0 && networksLost().length === 0) {
          <p class="hint" style="margin:0;">{{ 'views.admin.none' | transloco }}</p>
        }
      </section>
    }
  `,
})
export class ViewsAdminPanelComponent {
  private readonly api = inject(ViewsApi);
  private readonly views = inject(ViewsStore);
  private readonly transloco = inject(TranslocoService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  /** The reserved ids, as `GET /api/spaces` served them; `null` when the caller is not an admin (nothing is shown or asked). */
  readonly retired = input<readonly string[] | null>(null);
  /** An id was purged: the page re-reads its space list (the id is free to create again). */
  readonly purged = output<string>();

  protected readonly report = signal<ViewsMigrationReport | null>(null);
  protected readonly orphanList = signal<ViewOrphans | null>(null);
  protected readonly loaded = signal(false);
  protected readonly failed = signal(false);
  protected readonly busy = signal('');
  protected readonly error = signal('');

  protected readonly reserved = computed(() => this.retired() ?? []);
  protected readonly migratedCount = computed(() => this.report()?.migrated?.length ?? 0);
  protected readonly networksLost = computed(() => this.report()?.networksLostIds ?? []);
  protected readonly orphans = computed(() => this.orphanList()?.orphans ?? []);
  /** Unclaimed definitions: the orphan door's list, which is the live one; the report's is what the upgrade left. */
  protected readonly unclaimed = computed<readonly UnclaimedView[]>(() => this.orphanList()?.unclaimed ?? this.report()?.unclaimed ?? []);

  constructor() {
    // Read once, when the page learns it is talking to an admin.
    effect(() => { if (this.retired() !== null) untracked(() => this.load()); });
  }

  private load(): void {
    forkJoin({ report: this.api.migration(), orphans: this.api.orphans() }).subscribe({
      next: ({ report, orphans }) => { this.report.set(report); this.orphanList.set(orphans); this.failed.set(false); this.loaded.set(true); },
      error: () => { this.failed.set(true); this.loaded.set(true); },
    });
  }

  protected claim(view: UnclaimedView): void {
    this.busy.set(`claim:${view.name}`);
    this.error.set('');
    this.api.claim(view.name).subscribe({
      next: () => {
        this.busy.set('');
        this.toast.success(this.transloco.translate('views.admin.claimed', { name: view.name }));
        this.views.load();
        this.load();
      },
      error: err => { this.busy.set(''); this.error.set(viewRefusalText(this.transloco, err)); },
    });
  }

  protected async purge(id: string): Promise<void> {
    this.error.set('');
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('views.admin.purgeTitle', { id }),
      message: `${this.transloco.translate('views.admin.purgeConfirm', { id })} ${this.transloco.translate('views.admin.purgeOidc', { id })}`,
      confirmLabel: this.transloco.translate('views.admin.purge', { id }),
      danger: true,
      requireText: id,
    });
    if (!ok) return;
    this.busy.set(`purge:${id}`);
    this.api.purgeRetired(id, true).subscribe({
      next: () => {
        this.busy.set('');
        this.toast.success(this.transloco.translate('views.admin.purged', { id }));
        this.purged.emit(id);
        this.load();
      },
      error: err => { this.busy.set(''); this.error.set(viewRefusalText(this.transloco, err)); },
    });
  }
}
