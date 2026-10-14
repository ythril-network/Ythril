import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { AdminApi } from '../../core/admin-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { SummaryStripComponent, SummaryItem } from '../../shared/summary-strip.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { RelativeTimeComponent } from '../../shared/relative-time.component';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';
import {
  Space, WebhookSubscription, WebhookDelivery, WebhookEventType, WEBHOOK_EVENT_GROUPS,
} from '../../core/api.types';
import { refusalText } from '../../core/refusal-text';

/** Editable form model for the create/edit dialog. */
interface WebhookForm {
  id: string | null;          // null = creating
  url: string;
  secret: string;             // write-only; blank on edit = keep existing
  enabled: boolean;
  allEvents: boolean;         // true = subscribe to every event (sends events: [])
  events: Set<WebhookEventType>;
  allSpaces: boolean;         // true = all spaces (sends spaces: [])
  spaces: Set<string>;
}

@Component({
  selector: 'app-webhooks',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent, ModalDirective, ErrorStateComponent,
            SummaryStripComponent, StatusPillComponent, RelativeTimeComponent, HscrollTopDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .dialog-backdrop { position:fixed; inset:0; background:var(--bg-scrim); display:flex; align-items:center; justify-content:center; z-index:100; }
    .dialog { background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-lg); padding:24px; width:92vw; max-width:560px; max-height:88vh; overflow-y:auto; }
    .dialog.wide { max-width:760px; }
    .dialog-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; }
    .url-cell { font-family:var(--font-mono); font-size:12px; word-break:break-all; max-width:320px; }
    .ev-group { margin-bottom:10px; }
    .ev-group-label { font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--text-muted); margin-bottom:4px; }
    .ev-check { display:inline-flex; align-items:center; gap:5px; margin:2px 12px 2px 0; font-size:12px; font-family:var(--font-mono); }
    .del-ok { color:var(--success, #16a34a); }
    .del-fail { color:var(--danger); }
    .muted { color:var(--text-muted); }
  `],
  template: `
    <!-- CREATE / EDIT DIALOG -->
    @if (form(); as f) {
      <div class="dialog-backdrop">
        <div class="dialog" [appModal]="(f.id ? 'webhooks.dialog.editTitle' : 'webhooks.dialog.createTitle') | transloco" (dismiss)="closeForm()" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <div class="card-title">{{ (f.id ? 'webhooks.dialog.editTitle' : 'webhooks.dialog.createTitle') | transloco }}</div>
            <button class="icon-btn" type="button" [attr.aria-label]="'common.close' | transloco" (click)="closeForm()"><ph-icon name="x" [size]="16"/></button>
          </div>

          @if (formError()) { <div class="alert alert-error" style="margin-bottom:14px;">{{ formError() }}</div> }

          <div class="field" style="margin-bottom:14px;">
            <label>{{ 'webhooks.field.url' | transloco }}</label>
            <input type="url" [(ngModel)]="f.url" placeholder="https://example.com/hook" />
            <span class="muted" style="font-size:11px;">{{ 'webhooks.field.urlHint' | transloco }}</span>
          </div>

          <div class="field" style="margin-bottom:14px;">
            <label>{{ 'webhooks.field.secret' | transloco }}</label>
            <input type="password" [(ngModel)]="f.secret" autocomplete="new-password"
              [placeholder]="(f.id ? 'webhooks.field.secretKeep' : 'webhooks.field.secretPlaceholder') | transloco" />
            <span class="muted" style="font-size:11px;">{{ 'webhooks.field.secretHint' | transloco }}</span>
          </div>

          <div class="field" style="margin-bottom:14px;">
            <label style="display:flex;align-items:center;gap:6px;">
              <input type="checkbox" [(ngModel)]="f.allEvents" /> {{ 'webhooks.field.allEvents' | transloco }}
            </label>
            @if (!f.allEvents) {
              <div style="margin-top:8px;">
                @for (g of eventGroups; track g.group) {
                  <div class="ev-group">
                    <div class="ev-group-label">{{ 'webhooks.eventGroup.' + g.group | transloco }}</div>
                    @for (ev of g.events; track ev) {
                      <label class="ev-check">
                        <input type="checkbox" [checked]="f.events.has(ev)" (change)="toggleEvent(f, ev)" /> {{ ev }}
                      </label>
                    }
                  </div>
                }
              </div>
            }
          </div>

          <div class="field" style="margin-bottom:14px;">
            <label style="display:flex;align-items:center;gap:6px;">
              <input type="checkbox" [(ngModel)]="f.allSpaces" /> {{ 'webhooks.field.allSpaces' | transloco }}
            </label>
            @if (!f.allSpaces) {
              <div style="margin-top:8px;">
                @for (s of spaces(); track s.id) {
                  <label class="ev-check">
                    <input type="checkbox" [checked]="f.spaces.has(s.id)" (change)="toggleSpace(f, s.id)" /> {{ s.label }}
                  </label>
                } @empty { <span class="muted" style="font-size:12px;">{{ 'webhooks.field.noSpaces' | transloco }}</span> }
              </div>
            }
          </div>

          <div class="field" style="margin-bottom:20px;">
            <label style="display:flex;align-items:center;gap:6px;">
              <input type="checkbox" [(ngModel)]="f.enabled" /> {{ 'webhooks.field.enabled' | transloco }}
            </label>
          </div>

          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn btn-secondary btn-sm" type="button" (click)="closeForm()">{{ 'common.cancel' | transloco }}</button>
            <button class="btn btn-primary" type="button" (click)="save(f)" [disabled]="saving()">
              @if (saving()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
              {{ (f.id ? 'common.save' : 'webhooks.dialog.createButton') | transloco }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- DELIVERIES DIALOG -->
    @if (deliveriesFor(); as d) {
      <div class="dialog-backdrop">
        <div class="dialog wide" [appModal]="'webhooks.deliveries.title' | transloco" appModalCloseOnBackdrop (dismiss)="deliveriesFor.set(null)" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <div class="card-title">{{ 'webhooks.deliveries.title' | transloco }}</div>
            <button class="icon-btn" type="button" [attr.aria-label]="'common.close' | transloco" (click)="deliveriesFor.set(null)"><ph-icon name="x" [size]="16"/></button>
          </div>
          <div class="url-cell muted" style="margin-bottom:12px;">{{ d.url }}</div>
          @if (deliveriesLoading()) {
            <div style="text-align:center;padding:16px;"><span class="spinner"></span></div>
          } @else if (deliveries().length === 0) {
            <p class="muted" style="font-size:13px;">{{ 'webhooks.deliveries.empty' | transloco }}</p>
          } @else {
            <div class="table-wrapper" hscrollTop>
              <table>
                <thead><tr>
                  <th>{{ 'webhooks.deliveries.event' | transloco }}</th>
                  <th>{{ 'webhooks.deliveries.status' | transloco }}</th>
                  <th>{{ 'webhooks.deliveries.latency' | transloco }}</th>
                  <th>{{ 'webhooks.deliveries.when' | transloco }}</th>
                </tr></thead>
                <tbody>
                  @for (dl of deliveries(); track dl.id) {
                    <tr>
                      <td style="font-family:var(--font-mono);font-size:12px;">{{ dl.event }}</td>
                      <td [class]="dl.success ? 'del-ok' : 'del-fail'">
                        {{ dl.responseStatus || '—' }}
                        @if (!dl.success && dl.error) { <span class="muted" style="font-size:11px;"> · {{ dl.error }}</span> }
                      </td>
                      <td style="font-variant-numeric:tabular-nums;">{{ dl.latencyMs }} ms</td>
                      <td class="muted" style="font-size:12px;"><app-relative-time [value]="dl.timestamp"/></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>
      </div>
    }

    <!-- PAGE -->
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">{{ 'webhooks.title' | transloco }}</div>
          <div class="card-subtitle">{{ 'webhooks.subtitle' | transloco }}</div>
        </div>
        <button class="btn btn-primary btn-sm" (click)="openCreate()">{{ 'webhooks.createButton' | transloco }}</button>
      </div>

      @if (loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else if (loadError()) {
        <app-error-state [message]="'webhooks.loadError' | transloco" (retry)="load()" />
      } @else if (webhooks().length === 0) {
        <div class="empty-state" style="padding:32px;"><h3>{{ 'webhooks.empty.title' | transloco }}</h3><p>{{ 'webhooks.empty.body' | transloco }}</p></div>
      } @else {
        <app-summary-strip [heading]="'webhooks.title' | transloco" [items]="summary()" style="display:block;margin:0 0 16px;"/>
        <div class="table-wrapper" hscrollTop>
          <table>
            <thead><tr>
              <th>{{ 'webhooks.col.url' | transloco }}</th>
              <th>{{ 'webhooks.col.events' | transloco }}</th>
              <th>{{ 'webhooks.col.spaces' | transloco }}</th>
              <th>{{ 'webhooks.col.status' | transloco }}</th>
              <th></th>
            </tr></thead>
            <tbody>
              <!-- failing hooks sorted to the top so an operational problem reads first -->
              @for (w of sortedWebhooks(); track w.id) {
                <tr>
                  <td class="url-cell">{{ w.url }}</td>
                  <td style="font-size:12px;">{{ w.events.length ? w.events.length + ' ' + ('webhooks.selected' | transloco) : ('webhooks.all' | transloco) }}</td>
                  <td style="font-size:12px;">{{ w.spaces.length ? w.spaces.length + ' ' + ('webhooks.selected' | transloco) : ('webhooks.all' | transloco) }}</td>
                  <td>
                    <span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;">
                      <app-status-pill [variant]="statusVariant(w.status)" [dot]="true">{{ 'webhooks.status.' + w.status | transloco }}</app-status-pill>
                      @if (w.consecutiveFailures > 0) {
                        <span class="muted" style="font-size:11px;">{{ 'webhooks.failures' | transloco: { n: w.consecutiveFailures } }}</span>
                      }
                    </span>
                  </td>
                  <td>
                    <div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
                      <button class="btn btn-secondary btn-sm" type="button" (click)="test(w)" [disabled]="testingIds().has(w.id)" [attr.title]="'webhooks.action.test' | transloco">
                        @if (testingIds().has(w.id)) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                        {{ 'webhooks.action.test' | transloco }}
                      </button>
                      <button class="btn btn-secondary btn-sm" type="button" (click)="openDeliveries(w)" [attr.title]="'webhooks.action.deliveries' | transloco"><ph-icon name="list-bullets" [size]="14"/></button>
                      <button class="btn btn-secondary btn-sm" type="button" (click)="openEdit(w)" [attr.title]="'common.edit' | transloco"><ph-icon name="pencil-simple" [size]="14"/></button>
                      <button class="btn btn-secondary btn-sm danger" type="button" (click)="remove(w)" [attr.title]="'common.delete' | transloco"><ph-icon name="trash" [size]="14"/></button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class WebhooksComponent implements OnInit {
  private admin = inject(AdminApi);
  private spacesApi = inject(SpacesApi);
  private toast = inject(ToastService);
  private confirmDialog = inject(ConfirmDialogService);
  private transloco = inject(TranslocoService);

  readonly eventGroups = WEBHOOK_EVENT_GROUPS;

  webhooks = signal<WebhookSubscription[]>([]);
  spaces = signal<Space[]>([]);
  loading = signal(true);
  loadError = signal(false);

  form = signal<WebhookForm | null>(null);
  saving = signal(false);
  formError = signal('');

  deliveriesFor = signal<WebhookSubscription | null>(null);
  deliveries = signal<WebhookDelivery[]>([]);
  deliveriesLoading = signal(false);

  /** Per-row in-flight state for the Test action (spinner + disabled while queuing). */
  testingIds = signal<ReadonlySet<string>>(new Set());

  /** Failing first, then disabled, then active — an operational problem should read at the top. */
  sortedWebhooks = computed(() => {
    const rank: Record<WebhookSubscription['status'], number> = { failing: 0, disabled: 1, active: 2 };
    return [...this.webhooks()].sort((a, b) => rank[a.status] - rank[b.status]);
  });

  /** Operator health rollup: total endpoints + failing/disabled counts (shown only when > 0). */
  summary = computed<SummaryItem[]>(() => {
    const ws = this.webhooks();
    const failing = ws.filter(w => w.status === 'failing').length;
    const disabled = ws.filter(w => w.status === 'disabled').length;
    const tr = (k: string) => this.transloco.translate(k);
    const items: SummaryItem[] = [{ label: tr('webhooks.summary.endpoints'), value: ws.length }];
    if (failing) items.push({ label: tr('webhooks.summary.failing'), value: failing, variant: 'error' });
    if (disabled) items.push({ label: tr('webhooks.summary.disabled'), value: disabled, variant: 'off' });
    return items;
  });

  statusVariant(s: WebhookSubscription['status']): 'active' | 'error' | 'off' {
    return s === 'failing' ? 'error' : s === 'disabled' ? 'off' : 'active';
  }

  ngOnInit(): void {
    this.load();
    this.spacesApi.listSpaces().subscribe({ next: ({ spaces }) => this.spaces.set(spaces), error: () => {} });
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.admin.listWebhooks().subscribe({
      next: ({ webhooks }) => { this.webhooks.set(webhooks); this.loading.set(false); },
      error: () => { this.loadError.set(true); this.loading.set(false); },
    });
  }

  openCreate(): void {
    this.formError.set('');
    this.form.set({ id: null, url: '', secret: '', enabled: true, allEvents: true, events: new Set(), allSpaces: true, spaces: new Set() });
  }

  openEdit(w: WebhookSubscription): void {
    this.formError.set('');
    this.form.set({
      id: w.id, url: w.url, secret: '', enabled: w.enabled,
      allEvents: w.events.length === 0, events: new Set(w.events),
      allSpaces: w.spaces.length === 0, spaces: new Set(w.spaces),
    });
  }

  closeForm(): void { this.form.set(null); }

  toggleEvent(f: WebhookForm, ev: WebhookEventType): void {
    f.events.has(ev) ? f.events.delete(ev) : f.events.add(ev);
  }

  toggleSpace(f: WebhookForm, id: string): void {
    f.spaces.has(id) ? f.spaces.delete(id) : f.spaces.add(id);
  }

  save(f: WebhookForm): void {
    this.saving.set(true);
    this.formError.set('');
    const body = {
      url: f.url.trim(),
      events: f.allEvents ? [] : [...f.events],
      spaces: f.allSpaces ? [] : [...f.spaces],
      enabled: f.enabled,
      // Only send the secret when the user typed one (server never returns it, so blank on edit = keep).
      ...(f.secret ? { secret: f.secret } : {}),
    };
    const req$ = f.id ? this.admin.updateWebhook(f.id, body) : this.admin.createWebhook(body);
    req$.subscribe({
      next: () => {
        this.saving.set(false);
        this.toast.success(this.transloco.translate(f.id ? 'webhooks.toast.updated' : 'webhooks.toast.created'));
        this.closeForm();
        this.load();
      },
      error: (err) => { this.saving.set(false); this.formError.set(refusalText(this.transloco, err, 'webhooks.toast.saveFailed')); },
    });
  }

  test(w: WebhookSubscription): void {
    this.testingIds.update(s => new Set(s).add(w.id));
    this.admin.testWebhook(w.id).subscribe({
      next: () => { this.clearTesting(w.id); this.toast.success(this.transloco.translate('webhooks.toast.testQueued')); },
      error: (err) => { this.clearTesting(w.id); this.toast.error(refusalText(this.transloco, err, 'webhooks.toast.testFailed')); },
    });
  }

  private clearTesting(id: string): void {
    this.testingIds.update(s => { const n = new Set(s); n.delete(id); return n; });
  }

  async remove(w: WebhookSubscription): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('webhooks.delete.title'),
      message: this.transloco.translate('webhooks.delete.message', { url: w.url }),
      confirmLabel: this.transloco.translate('common.delete'),
      danger: true,
    });
    if (!ok) return;
    this.admin.deleteWebhook(w.id).subscribe({
      next: () => { this.toast.success(this.transloco.translate('webhooks.toast.deleted')); this.load(); },
      error: (err) => this.toast.error(refusalText(this.transloco, err, 'webhooks.toast.deleteFailed')),
    });
  }

  openDeliveries(w: WebhookSubscription): void {
    this.deliveriesFor.set(w);
    this.deliveries.set([]);
    this.deliveriesLoading.set(true);
    this.admin.getWebhookDeliveries(w.id).subscribe({
      next: ({ deliveries }) => { this.deliveries.set(deliveries); this.deliveriesLoading.set(false); },
      error: () => { this.deliveriesLoading.set(false); this.toast.error(this.transloco.translate('webhooks.toast.deliveriesFailed')); },
    });
  }
}
