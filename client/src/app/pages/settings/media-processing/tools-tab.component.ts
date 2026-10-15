/**
 * Tab 3 — Tools. Things that run, with nothing to set.
 *
 * They exist here so every pipeline step leads somewhere: a chain that names `ffmpeg` and `text
 * chunker` as actors and then offers no page for either leaves the reader wondering whether those are
 * real components or labels. More importantly, this tab is "is it working?" for exactly the class of
 * component that has no settings screen — which is the class whose failure went unnoticed for months.
 *
 * **The vector index table now carries a per-row Rebuild button.** This table is the one place drift
 * is actually visible — `config.json` recording a space as `ready` while the database has no such index
 * — so it is also where the repair belongs, right next to the row that shows the problem. It is the
 * SAME rebuild the space's Danger Zone offers (`rebuildSpaceIndexes` → `POST .../rebuild-indexes`), with
 * the same guard: a confirm that spells out that recall returns empty until the rebuild finishes. It
 * rebuilds the missing `$vectorSearch` index; it is not the config-change reindex that re-embeds the
 * brain, and it touches no records. Rebuild — not reindex — is what fixes the drift this table surfaces.
 *
 * The drift row is the reason `GET /api/admin/pipeline-status` exists. `config.json` recording a
 * space as `ready` while the database has no such index is invisible everywhere else in the product —
 * recall simply returns nothing, forever, with no error anywhere.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../../shared/ph-icon.component';
import { StatusPillComponent, StatusVariant } from '../../../shared/status-pill.component';
import { HealthDotComponent } from './health-dot.component';
import { ModelProviderCardComponent } from './model-provider-card.component';
import { HscrollTopDirective } from '../../../shared/hscroll-top.directive';
import { PipelineStatusService } from './pipeline-status.service';
import { SpaceIndexStatus } from './media-processing.types';
import { SpacesApi } from '../../../core/spaces-api.service';
import { ToastService } from '../../../core/toast.service';
import { ConfirmDialogService } from '../../../core/confirm-dialog.service';
import { refusalText, RefusalSource } from '../../../core/refusal-text';

@Component({
  selector: 'app-tools-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PhIconComponent, StatusPillComponent, HealthDotComponent, ModelProviderCardComponent, HscrollTopDirective],
  styles: [`
    :host { display: block; }
    /* Splitter + chunker sit side by side as model-style cards, matching the Models tab grid. */
    .tools-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 16px; margin-bottom: 16px; align-items: stretch; }
    .tool { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px;
      margin-bottom: 16px; overflow: hidden; }
    .tool-h { display: flex; align-items: center; gap: 12px; padding: 14px 18px; }
    .ic { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; flex: none;
      background: var(--bg-elevated); border: 1px solid var(--border); color: var(--accent); }
    .tool-h .t { flex: 1; min-width: 0; }
    .tool-h h3 { margin: 0; font-size: 14.5px; font-weight: 620; display: flex; align-items: center; gap: 8px; }
    .tool-h p { margin: 2px 0 0; font-size: 12.5px; color: var(--text-secondary); }
    .tool-b { border-top: 1px solid var(--border-muted); padding: 12px 18px 16px; }
    .meta { font-size: 12.5px; color: var(--text-secondary); }
    .meta code { font-family: var(--font-mono, monospace); font-size: 11.5px; }

    /* Wide content scrolls inside its own box — the page body must never scroll sideways. */
    .tablewrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; min-width: 420px; }
    th { text-align: left; font-weight: 600; color: var(--text-muted); font-size: 11px;
      text-transform: uppercase; letter-spacing: .06em; padding: 6px 10px 6px 0; }
    td { padding: 7px 10px 7px 0; border-top: 1px solid var(--border-muted); vertical-align: top; }
    td.space { font-weight: 550; }
    /* The "Recorded" header carries a tooltip; the dotted underline advertises it. */
    .th-hint { cursor: help; text-decoration: underline dotted; text-underline-offset: 2px; }
    /* Action column: right-aligned Rebuild button, never wraps its label. */
    th.act-h, td.act { text-align: right; white-space: nowrap; padding-right: 0; }
    td.act .btn { display: inline-flex; align-items: center; gap: 6px; }
    td.act .spinner { width: 12px; height: 12px; border-width: 2px; }
    /* Visually-hidden accessible label for the action column header. */
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

    .drift { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 14px; padding: 11px 13px;
      border-radius: 9px; font-size: 12.5px; border: 1px solid var(--error-border); background: var(--error-bg); }
    .drift ph-icon { flex: none; margin-top: 1px; }
    .drift b { color: var(--text-primary); }
    .empty { font-size: 12.5px; color: var(--text-muted); }
  `],
  template: `
    <!-- ── Media splitter + Text chunker ──────────────────────────────────
         Both are in-process, nothing-to-set tools, so they now ride the same
         app-model-provider-card as the Models tab (in a 2-up grid) rather than a
         bespoke card, for one card vocabulary across all three Models tabs. -->
    <div class="tools-grid">
      <app-model-provider-card id="splitter" icon="scissors"
        [heading]="'mediaProcessing.tools.splitter' | transloco"
        [purpose]="'mediaProcessing.tools.splitterPurpose' | transloco"
        [health]="'ok'">
        <app-status-pill pill variant="ok">ffmpeg</app-status-pill>
        <div class="meta">{{ 'mediaProcessing.tools.splitterDetail' | transloco }}</div>
      </app-model-provider-card>

      <app-model-provider-card id="chunker" icon="text-align-left"
        [heading]="'mediaProcessing.tools.chunker' | transloco"
        [purpose]="'mediaProcessing.tools.chunkerPurpose' | transloco"
        [health]="'ok'">
        <app-status-pill pill variant="ok">{{ 'mediaProcessing.tools.inProcess' | transloco }}</app-status-pill>
        <div class="meta">{{ 'mediaProcessing.tools.chunkerDetail' | transloco }}</div>
      </app-model-provider-card>
    </div>

    <!-- ── Vector index ───────────────────────────────────────────────── -->
    <section class="tool">
      <header class="tool-h">
        <span class="ic"><ph-icon name="database" [size]="17"/></span>
        <div class="t">
          <h3>
            {{ 'mediaProcessing.tools.vectorIndex' | transloco }}
            <app-health-dot [state]="indexHealth()" [subject]="'mediaProcessing.tools.vectorIndex' | transloco"/>
          </h3>
          <p>{{ 'mediaProcessing.tools.vectorIndexPurpose' | transloco }}</p>
        </div>
      </header>
      <div class="tool-b">
        @if (drifted().length) {
          <div class="drift">
            <ph-icon name="warning" [size]="16"/>
            <span>
              <b>{{ 'mediaProcessing.tools.driftTitle' | transloco: { count: drifted().length } }}</b>
              {{ 'mediaProcessing.tools.driftBody' | transloco }}
            </span>
          </div>
        }

        @if (unavailable(); as u) {
          <div class="empty">{{ 'mediaProcessing.tools.indexUnavailable' | transloco: { detail: u } }}</div>
        } @else if (!spaces().length) {
          <div class="empty">{{ 'mediaProcessing.tools.indexEmpty' | transloco }}</div>
        } @else {
          <div class="tablewrap" hscrollTop>
            <table>
              <thead>
                <tr>
                  <th>{{ 'mediaProcessing.tools.colSpace' | transloco }}</th>
                  <th>{{ 'mediaProcessing.tools.colLive' | transloco }}</th>
                  <!-- "Recorded" needs a word: it is what config.json believes, which "In the database"
                       is checked against — a mismatch is the drift this table exists to surface. -->
                  <th><span class="th-hint" [attr.title]="'mediaProcessing.tools.colStoredHint' | transloco">{{ 'mediaProcessing.tools.colStored' | transloco }}</span></th>
                  <th class="act-h"><span class="sr-only">{{ 'mediaProcessing.tools.colAction' | transloco }}</span></th>
                </tr>
              </thead>
              <tbody>
                @for (sp of spaces(); track sp.id) {
                  <tr>
                    <td class="space">{{ sp.label }}</td>
                    <td><app-status-pill [variant]="liveVariant(sp)" [dot]="true">{{ 'mediaProcessing.indexState.' + sp.live | transloco }}</app-status-pill></td>
                    <td><app-status-pill [variant]="sp.drifted ? 'error' : 'off'">{{ 'mediaProcessing.indexState.' + sp.stored | transloco }}</app-status-pill></td>
                    <td class="act">
                      <button class="btn btn-danger btn-sm" type="button" [disabled]="rebuilding().has(sp.id)" (click)="rebuildIndexes(sp)">
                        @if (rebuilding().has(sp.id)) { <span class="spinner"></span> } @else { <ph-icon name="arrows-clockwise" [size]="14"/> }
                        {{ 'mediaProcessing.tools.rebuildRowButton' | transloco }}
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>
    </section>
  `,
})
export class ToolsTabComponent {
  readonly pipeline = inject(PipelineStatusService);
  private spacesApi = inject(SpacesApi);
  private toast = inject(ToastService);
  private confirmDialog = inject(ConfirmDialogService);
  private transloco = inject(TranslocoService);

  /** Space ids whose rebuild is in flight — drives the per-row spinner + disabled state. */
  rebuilding = signal(new Set<string>());

  spaces = computed(() => this.pipeline.status()?.index.spaces ?? []);
  unavailable = computed(() => this.pipeline.status()?.index.unavailable ?? null);
  drifted = computed(() => this.pipeline.driftedSpaces());

  /** One dot for the whole index: the worst thing any space reports. */
  indexHealth = computed(() => {
    const spaces = this.spaces();
    if (!this.pipeline.status()) return null;
    if (this.unavailable() || spaces.some(s => s.live === 'unknown')) return null;
    if (spaces.some(s => s.live === 'missing')) return 'down' as const;
    if (spaces.some(s => s.live === 'building')) return 'degraded' as const;
    return 'ok' as const;
  });

  liveVariant(sp: SpaceIndexStatus): StatusVariant {
    if (sp.live === 'ready') return 'ok';
    if (sp.live === 'building') return 'warn';
    if (sp.live === 'missing') return 'error';
    return 'off';
  }

  /**
   * Rebuild one space's `$vectorSearch` index — the repair for the drift this table surfaces.
   *
   * Same operation and guard as the space Danger Zone (`rebuildSpaceIndexes`), surfaced here because
   * this is where drift is visible. It is not destructive — no record is touched, only the index is
   * recreated — but recall returns EMPTY until the build finishes, so the confirm spells that out.
   * Reuses the Danger Zone's confirm/toast copy so the two entry points read identically.
   */
  async rebuildIndexes(sp: SpaceIndexStatus): Promise<void> {
    if (this.rebuilding().has(sp.id)) return;
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('spaces.dangerZone.rebuildIndexesTitle'),
      message: this.transloco.translate('spaces.dangerZone.confirmRebuildIndexes', { label: sp.label }),
      confirmLabel: this.transloco.translate('spaces.dangerZone.rebuildIndexesButton'),
      danger: true,
    });
    if (!ok) return;
    this.rebuilding.update(s => new Set(s).add(sp.id));
    this.spacesApi.rebuildSpaceIndexes(sp.id).subscribe({
      next: () => {
        this.clearRebuilding(sp.id);
        this.toast.success(this.transloco.translate('spaces.dangerZone.rebuildIndexesStarted'));
      },
      error: (err: unknown) => {
        this.clearRebuilding(sp.id);
        this.toast.error(refusalText(this.transloco, err as RefusalSource, 'spaces.dangerZone.rebuildIndexesFailed'));
      },
    });
  }

  private clearRebuilding(id: string): void {
    this.rebuilding.update(s => { const n = new Set(s); n.delete(id); return n; });
  }
}
