/**
 * Danger zone — rename, wipe, delete the space, and leave its networks.
 *
 * Extracted from SpacesComponent (A17.8b). Needs no inputs and no data outputs: SpacesStore owns
 * the server data and SpaceSettingsState owns the dialog form state, and both are services the
 * page provides — so this component just renders them and calls them.
 */
import { Component, ChangeDetectionStrategy, inject, signal, computed, effect } from '@angular/core';
import type { ReembedResult } from '../../core/api.types';
import { firstValueFrom } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { SPACE_DIALOG_STYLES } from './space-dialog.styles';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesStore } from './spaces-store.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { TTL_BUCKETS, recordTtlWindows, type RecordTtlWindows, type TtlBucket } from '../../core/api.types';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { TranslocoService } from '@jsverse/transloco';

@Component({
  selector: 'app-space-danger-tab',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [SPACE_DIALOG_STYLES],
  template: `
<!-- ── Retention ────────────────────────────────────────────────────────────────────────────────────────
     Here rather than in Settings (owner call, 2026-08-02) because this DELETES records on a timer. It used
     to sit next to the storage cap, which only refuses new writes — the same card for "you cannot add more"
     and "what you have will be removed".

     Two levels, and the copy is explicit that a per-record ttlDays overrides both, because that is the part
     an operator cannot discover from a form. NOTE: no backticks anywhere in this template — one kills the
     whole string and the error points at @Component, never at the comment. -->
<div class="dz-section dz-red">
  <div class="dz-section-title">{{ 'spaces.dangerZone.retentionTitle' | transloco }}</div>
  <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">{{ 'spaces.dangerZone.retentionDescription' | transloco }}</p>

  <!-- One field per bucket. It was ONE number for all five, which a space holding two kinds of thing cannot
       use: a tickets space keeps ticket entities for a year and their status-change chronos for a month.
       Files get their own because they share this tier and have no type for the Schema tab to reach. -->
  <div class="ttl-grid">
    @for (b of buckets; track b) {
      <div class="field" style="margin:0;">
        <label>{{ 'spaces.dangerZone.retentionBucket.' + b | transloco }}</label>
        <input type="number" [(ngModel)]="ttl[b]" [name]="'ttl-' + b" min="0" step="1"
          [placeholder]="'spaces.dangerZone.retentionNever' | transloco" />
      </div>
    }
  </div>
  <div style="font-size:11px;color:var(--text-muted);margin:6px 0 14px;">{{ 'spaces.dangerZone.retentionSpaceWideHint' | transloco }}</div>

  <div style="margin-bottom:12px;">
    <button class="btn btn-secondary" type="button" [disabled]="savingRetention()" (click)="saveRetention()">
      @if (savingRetention()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.dangerZone.retentionSave' | transloco }}
    </button>
  </div>

  <!-- A pointer, not a titled block. The reporter's operator "understood every individual word and could not
       tell what the block was for", and they were right about why: a heading promises a control, and this
       section has none — the control is on the Schema tab. So it is one line when there is nothing to list,
       and a labelled list only when there is something that overrides the field above.

       The precedence now lives in the section description at the top, once, instead of arriving here as a
       mid-sentence aside on first mention. And nothing says "the number above" any more: that was a bare
       back-reference the reader had to scroll up and guess at. -->
  @if (declaredRetention().length) {
    <p class="dz-hint">{{ 'spaces.dangerZone.retentionPerType' | transloco }} — {{ 'spaces.dangerZone.retentionPerTypeHint' | transloco }}</p>
    <ul style="margin:6px 0 0;padding-left:18px;font-size:12px;color:var(--text-secondary);">
      @for (r of declaredRetention(); track r.key) {
        <li>{{ r.label }}</li>
      }
    </ul>
  } @else {
    <p class="dz-hint">{{ 'spaces.dangerZone.retentionPerTypeNone' | transloco }}</p>
  }
</div>

<div class="dz-section">
  <div class="dz-section-title">{{ 'spaces.dangerZone.embeddingsTitle' | transloco }}</div>
  <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">{{ 'spaces.dangerZone.embeddingsDescription' | transloco }}</p>

  <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;margin-bottom:10px;">
    <input type="checkbox" [ngModel]="suppress()" (ngModelChange)="suppress.set($event)" name="suppressEmbeddings" style="margin-top:2px;" />
    <span style="font-size:13px;">{{ 'spaces.dangerZone.embeddingsSuppress' | transloco }}</span>
  </label>

  <!-- Shown while the box is ticked rather than only after saving: the consequence an operator needs is that
       records written from now on have no vector, and telling them that AFTER they save is telling them too late. -->
  @if (suppress()) {
    <div class="alert alert-warning" style="margin-bottom:12px;font-size:12px;">{{ 'spaces.dangerZone.embeddingsNoBackfill' | transloco }}</div>
  }

  <!-- The per-TYPE overrides, read-only, for the same reason retention lists them: an operator setting a
       space-wide switch needs to know which types ignore it, or they set it and wonder why one type keeps
       being embedded. -->
  @if (declaredSuppression().length) {
    <p class="dz-hint">{{ 'spaces.dangerZone.embeddingsPerType' | transloco }}</p>
    <ul style="margin:6px 0 12px;padding-left:18px;font-size:12px;color:var(--text-secondary);">
      @for (r of declaredSuppression(); track r.key) {
        <li>{{ r.label }}</li>
      }
    </ul>
  }

  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
    <button class="btn btn-secondary" type="button" [disabled]="savingSuppress()" (click)="saveSuppress()">
      @if (savingSuppress()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.dangerZone.embeddingsSave' | transloco }}
    </button>
    <!-- Disabled while suppression is on, because the server would skip every candidate and report zero. A
         button that runs and does nothing is worse than one that says why it cannot. -->
    <button class="btn btn-secondary" type="button" [disabled]="backfilling() || suppress()" (click)="backfill()">
      @if (backfilling()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.dangerZone.embeddingsBackfill' | transloco }}
    </button>
  </div>
  @if (suppress()) {
    <div class="dz-hint" style="margin-top:6px;">{{ 'spaces.dangerZone.embeddingsBackfillBlocked' | transloco }}</div>
  }
  @if (backfillResult(); as r) {
    <div class="alert alert-success" style="margin-top:10px;font-size:12px;">
      {{ 'spaces.dangerZone.embeddingsBackfillDone' | transloco: { enqueued: r.enqueued } }}
      @if (r.truncated) { <br/>{{ 'spaces.dangerZone.embeddingsBackfillMore' | transloco: { remaining: r.remaining } }} }
      @if (r.skippedSuppressed > 0) { <br/>{{ 'spaces.dangerZone.embeddingsBackfillSkipped' | transloco: { skipped: r.skippedSuppressed } }} }
    </div>
  }
</div>

<div class="dz-section">
  <div class="dz-section-title">{{ 'spaces.dangerZone.renameTitle' | transloco }}</div>
  <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">{{ 'spaces.dangerZone.renameDescription' | transloco }}</p>
  <form (ngSubmit)="submitDangerRename()" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
    <div class="field" style="margin:0;flex:1;max-width:280px;">
      <label>{{ 'spaces.dangerZone.newId' | transloco }}</label>
      <input type="text" [(ngModel)]="state.dangerRenameId" name="state.dangerRenameId" pattern="[a-z0-9-]+" maxlength="40" [placeholder]="state.settingsSpace()!.id" />
    </div>
    <button class="btn btn-secondary" type="submit" [disabled]="state.dangerRenaming()||!state.dangerRenameId.trim()||state.dangerRenameId.trim()===state.settingsSpace()!.id">
      @if (state.dangerRenaming()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.dangerZone.renameButton' | transloco }}
    </button>
  </form>
  @if (state.dangerRenameError()) { <div class="alert alert-error" style="margin-top:8px;">{{ state.dangerRenameError() }}</div> }
</div>

<div class="dz-section">
  <div class="dz-section-title">{{ 'spaces.dangerZone.rebuildIndexesTitle' | transloco }}</div>
  <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">{{ 'spaces.dangerZone.rebuildIndexesDescription' | transloco }}</p>
  <button class="btn btn-secondary" type="button" [disabled]="rebuildingIndexes()" (click)="rebuildIndexes()">
    @if (rebuildingIndexes()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.dangerZone.rebuildIndexesButton' | transloco }}
  </button>
</div>

<div class="dz-section dz-red">
  <div class="dz-section-title">{{ 'spaces.dangerZone.wipeTitle' | transloco }}</div>
  <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">{{ 'spaces.dangerZone.wipeDescription' | transloco }}</p>
  @if (state.dangerWipeLoading()) {
    <div style="display:flex;gap:8px;align-items:center;color:var(--text-muted);font-size:13px;margin-bottom:12px;">
      <span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> {{ 'spaces.dangerZone.loadingCounts' | transloco }}
    </div>
  } @else if (state.dangerWipeStats()) {
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px;margin-bottom:16px;">
      @for (col of state.wipeStatCols(); track col.label) {
        <div style="text-align:center;padding:10px 6px;background:var(--bg-elevated);border-radius:var(--radius-sm);">
          <div style="font-size:20px;font-weight:700;font-family:var(--font-mono);">{{ col.value }}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">{{ col.label }}</div>
        </div>
      }
    </div>
  }
  @if (state.dangerWipeError()) { <div class="alert alert-error" style="margin-bottom:8px;">{{ state.dangerWipeError() }}</div> }
  <button class="btn btn-danger" type="button" (click)="confirmDangerWipe()" [disabled]="state.dangerWiping()">
    @if (state.dangerWiping()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.dangerZone.wipeButton' | transloco }}
  </button>
</div>

@let spaceNets = store.networksForSpace(state.settingsSpace()!.id);
@if (spaceNets.length > 0) {
  <div class="dz-section">
    <div class="dz-section-title">{{ 'spaces.dangerZone.leaveNetworksTitle' | transloco }}</div>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">{{ 'spaces.dangerZone.leaveNetworksDescription' | transloco }}</p>
    @for (n of spaceNets; track n.id) {
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
        <div>
          <span style="font-weight:500;">{{ n.label }}</span>
          <span class="badge badge-gray" style="margin-left:8px">{{ n.id }}</span>
        </div>
        <button class="btn btn-secondary btn-sm" type="button" (click)="leaveNetworkDanger(n.id)">{{ 'spaces.dangerZone.leaveButton' | transloco }}</button>
      </div>
    }
  </div>
}

@if (!state.settingsSpace()!.builtIn) {
  <div class="dz-section dz-red">
    <div class="dz-section-title">{{ 'spaces.dangerZone.deleteTitle' | transloco }}</div>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">{{ 'spaces.dangerZone.deleteDescription' | transloco }}</p>
    @if (state.dangerDeleteError()) { <div class="alert alert-error" style="margin-bottom:8px;">{{ state.dangerDeleteError() }}</div> }
    <button class="btn btn-danger" type="button" (click)="confirmDangerDelete()" [disabled]="state.dangerDeleting()">
      @if (state.dangerDeleting()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.dangerZone.deleteButton' | transloco }}
    </button>
  </div>
}
  `,
})
export class SpaceDangerTabComponent {
  readonly state = inject(SpaceSettingsState);
  readonly store = inject(SpacesStore);
  private spacesApi = inject(SpacesApi);
  private networksApi = inject(NetworksApi);
  private toast = inject(ToastService);
  private confirmDialog = inject(ConfirmDialogService);
  private transloco = inject(TranslocoService);

  rebuildingIndexes = signal(false);

  // ── Retention ──────────────────────────────────────────────────────────────────────────────────────
  //
  // Local form state rather than SpaceSettingsState: this section saves itself. Retention deletes records,
  // so it should not ride along in a footer save with a label edit — an operator must press a button that
  // says what it does.

  /**
   * One window per bucket, in days. 0 / empty = never expire.
   *
   * FIVE fields, not one, because a space does not hold one kind of thing: a `tickets` space holds ticket
   * entities that must outlive their status-change chronos, and a single number cannot express that. The schema
   * tier does not help — it keys on a type NAME, while this is about a whole collection.
   *
   * `file` is the fifth and it earns its own: uploads share this tier (they have no type, so the schema tier
   * cannot reach them), so folding them into one of the other four would have attached every file to whichever
   * bucket was picked.
   */
  ttl: Record<TtlBucket, number | null> = { entity: null, fact: null, edge: null, chrono: null, file: null };

  readonly buckets = TTL_BUCKETS;

  savingRetention = signal(false);

  /** Seeded from the space the dialog opened on; re-seeds when that changes. */
  private seeded = '';

  constructor() {
    effect(() => {
      const s = this.state.settingsSpace();
      if (!s || this.seeded === s.id) return;
      this.seeded = s.id;
      // `recordTtlWindows` widens a legacy scalar, so a space that set one number before the split shows it on
      // all five fields — which is what it has always meant — rather than appearing to have no policy.
      this.ttl = recordTtlWindows(s.recordTtlDays);
      // Absent reads as false, matching the server: suppression is opt-in, and the failure direction of getting
      // that backwards is records silently missing from recall, which nobody reports because there is nothing to
      // see. Re-seeded per space, and the previous space's backfill result is cleared with it.
      this.suppress.set(s.meta?.suppressEmbeddings === true);
      this.backfillResult.set(null);
    });
  }

  // ── Embeddings ─────────────────────────────────────────────────────────────────────────────────────
  //
  // Its own save, like retention and for the same reason: this changes what the space is findable BY, so it
  // must not ride along in a footer save with a label edit.

  /** The space-wide tier of record > schema > space. The LOWEST tier — any type schema that states a value wins. */
  readonly suppress = signal(false);
  readonly savingSuppress = signal(false);
  readonly backfilling = signal(false);
  readonly backfillResult = signal<ReembedResult | null>(null);

  /**
   * The per-TYPE overrides already declared in the schema, read-only.
   *
   * Same reasoning as `declaredRetention`: an operator setting a space-wide switch needs to know which types
   * ignore it, or they tick the box and wonder why one type is still being embedded. Only types that STATE a
   * value are listed — a type that says nothing inherits, and listing it would suggest an override that is not
   * there.
   */
  readonly declaredSuppression = computed<Array<{ key: string; label: string }>>(() => {
    const schemas = this.state.settingsSpace()?.meta?.typeSchemas ?? {};
    const t = (k: string, p?: Record<string, unknown>) => this.transloco.translate(k, p);
    const out: Array<{ key: string; label: string }> = [];
    for (const [kt, map] of Object.entries(schemas)) {
      for (const [name, schema] of Object.entries(map ?? {})) {
        const v = (schema as { suppressEmbeddings?: boolean }).suppressEmbeddings;
        if (v === undefined) continue;
        out.push({
          key: `${kt}.${name}`,
          label: t(v ? 'spaces.dangerZone.embeddingsTypeSuppressed' : 'spaces.dangerZone.embeddingsTypeEmbedded', { type: name }),
        });
      }
    }
    return out;
  });

  async saveSuppress(): Promise<void> {
    const space = this.state.settingsSpace();
    if (!space) return;
    this.savingSuppress.set(true);
    try {
      // `firstValueFrom`, not `await` on the Observable — `updateSpace` is cold, and awaiting one resolves with
      // the Observable itself without subscribing, so no request is sent and the success toast fires anyway.
      // That exact bug shipped on the retention button in this same file.
      //
      // Sent inside `meta`, because the server MERGES a partial meta over what is stored: sending the whole meta
      // back would race any other edit made since this dialog opened.
      await firstValueFrom(this.spacesApi.updateSpace(space.id, { meta: { suppressEmbeddings: this.suppress() } }));
      this.store.load();
      this.toast.success(this.transloco.translate('spaces.dangerZone.embeddingsSaved'));
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      this.savingSuppress.set(false);
    }
  }

  async backfill(): Promise<void> {
    const space = this.state.settingsSpace();
    if (!space) return;
    this.backfilling.set(true);
    this.backfillResult.set(null);
    try {
      // The counts ARE the result — `enqueued`, and `remaining` when the call was capped. Reporting only
      // "started" would leave an operator unable to tell a fully-swept space from one that needs three more
      // calls, which is the whole reason the endpoint returns numbers instead of `202`.
      this.backfillResult.set(await firstValueFrom(this.spacesApi.reembedSpace(space.id)));
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      this.backfilling.set(false);
    }
  }

  /**
   * The per-TYPE windows already declared in the schema, read-only.
   *
   * Shown rather than edited here on purpose: a window set in two places drifts, and the type is where an
   * operator already went to define it. But an operator standing in the Danger Zone about to set a space-wide
   * number needs to know which types override it — otherwise they set 30 days and wonder why one type keeps
   * everything for ten years.
   */
  declaredRetention = computed<Array<{ key: string; label: string }>>(() => {
    const schemas = this.state.settingsSpace()?.meta?.typeSchemas ?? {};
    const t = (k: string, p?: Record<string, unknown>) => this.transloco.translate(k, p);
    const out: Array<{ key: string; label: string }> = [];
    for (const [collection, types] of Object.entries(schemas)) {
      for (const [type, schema] of Object.entries(types ?? {})) {
        const r = schema?.retention;
        if (!r || (!r.days && !r.contentDays)) continue;
        const name = `${collection}.${type}`;
        const label = r.days && r.contentDays
          ? t('brain.overview.retentionTypeContent', { type: name, days: r.days, contentDays: r.contentDays })
          : r.days
            ? t('brain.overview.retentionType', { type: name, days: r.days })
            : t('brain.overview.retentionTypeContentOnly', { type: name, contentDays: r.contentDays });
        out.push({ key: name, label });
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  });

  async saveRetention(): Promise<void> {
    const space = this.state.settingsSpace();
    if (!space) return;
    this.savingRetention.set(true);
    try {
      // Every bucket is sent explicitly, including the empty ones as `null`. The server MERGES a partial object
      // over what is stored, so omitting a cleared field would leave its old window in place — the operator
      // emptied it and the save would look like it worked.
      const windows: RecordTtlWindows = {};
      for (const b of TTL_BUCKETS) {
        const v = Number(this.ttl[b]);
        windows[b] = Number.isInteger(v) && v > 0 ? v : null;
      }
      // Five nulls is a valid write and clears everything: the route only refuses an object that mentions no
      // bucket at all, because THAT would make "clear everything" and "change nothing" the same request.
      //
      // `firstValueFrom`, NOT `await` on the Observable. `updateSpace` returns a cold Observable, and awaiting
      // one resolves immediately with the Observable itself without ever subscribing — so no request is sent and
      // the success toast fires anyway. That is what this button did: it reported "Retention saved." and saved
      // nothing, from the moment retention moved to this tab. Every other call in this file uses `.subscribe`;
      // this was the one that did not, and the one nobody could see failing.
      await firstValueFrom(this.spacesApi.updateSpace(space.id, { recordTtlDays: windows }));
      this.store.load();
      this.toast.success(this.transloco.translate('spaces.dangerZone.retentionSaved'));
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      this.savingRetention.set(false);
    }
  }

  /**
   * Rebuild this space's vector search indexes — the repair for "search returns nothing".
   *
   * It sits in the danger zone because it has a real cost: recall returns EMPTY until the rebuild
   * finishes, which on a large space is minutes. It is not destructive — no record is touched, only the
   * index is recreated — so the confirmation explains the outage rather than demanding a typed id.
   */
  async rebuildIndexes(): Promise<void> {
    const target = this.state.settingsSpace();
    if (!target) return;
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('spaces.dangerZone.rebuildIndexesTitle'),
      message: this.transloco.translate('spaces.dangerZone.confirmRebuildIndexes', { label: target.label }),
      confirmLabel: this.transloco.translate('spaces.dangerZone.rebuildIndexesButton'),
      danger: true,
    });
    if (!ok) return;
    this.rebuildingIndexes.set(true);
    this.spacesApi.rebuildSpaceIndexes(target.id).subscribe({
      next: () => {
        this.rebuildingIndexes.set(false);
        this.toast.success(this.transloco.translate('spaces.dangerZone.rebuildIndexesStarted'));
      },
      error: (err: { error?: { error?: string }; message?: string }) => {
        this.rebuildingIndexes.set(false);
        this.toast.error(err?.error?.error ?? err?.message ?? this.transloco.translate('spaces.dangerZone.rebuildIndexesFailed'));
      },
    });
  }

  async submitDangerRename(): Promise<void> {
    const target = this.state.settingsSpace();
    const newId  = this.state.dangerRenameId.trim();
    if (!target || !newId || newId === target.id) return;
    // Renaming changes the space id, which breaks existing MCP/token references to it — so require the
    // operator to type the CURRENT id to confirm (same type-to-confirm ritual as wipe/delete).
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('spaces.dangerZone.confirmRenameTitle'),
      message: this.transloco.translate('spaces.dangerZone.confirmRename', { label: target.label, id: target.id, newId }),
      confirmLabel: this.transloco.translate('spaces.dangerZone.renameButton'),
      danger: true,
      requireText: target.id,
      requireTextLabel: this.transloco.translate('spaces.dangerZone.typeIdToConfirm', { id: target.id }),
    });
    if (!ok) return;
    this.state.dangerRenaming.set(true);
    this.state.dangerRenameError.set('');
    this.spacesApi.renameSpace(target.id, newId).subscribe({
      next: ({ space }) => {
        this.state.dangerRenaming.set(false);
        this.store.spaces.update(list => list.map(s => s.id === target.id ? space : s));
        this.state.settingsSpace.set(space);
        this.state.dangerRenameId = space.id;
        this.networksApi.listNetworks().subscribe({ next: ({ networks }) => this.store.networks.set(networks), error: () => {} });
      },
      error: (err) => { this.state.dangerRenaming.set(false); this.state.dangerRenameError.set(err.error?.error ?? this.transloco.translate('spaces.error.renameFailed')); },
    });
  }

  async confirmDangerWipe(): Promise<void> {
    const target = this.state.settingsSpace();
    if (!target) return;
    // Irreversible: require the operator to type the space id (GitHub-style, C3).
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('spaces.dangerZone.confirmWipeTitle'),
      message: this.transloco.translate('spaces.dangerZone.confirmWipe', { label: target.label }),
      confirmLabel: this.transloco.translate('spaces.dangerZone.wipeButton'),
      danger: true,
      requireText: target.id,
      requireTextLabel: this.transloco.translate('spaces.dangerZone.typeIdToConfirm', { id: target.id }),
    });
    if (!ok) return;
    this.state.dangerWiping.set(true);
    this.state.dangerWipeError.set('');
    this.spacesApi.wipeSpace(target.id).subscribe({
      next: () => {
        this.state.dangerWiping.set(false);
        this.state.dangerWipeStats.set(null);
        this.state.dangerWipeLoading.set(true);
        this.spacesApi.getSpaceStats(target.id).subscribe({
          next: (stats) => { this.state.dangerWipeStats.set(stats); this.state.dangerWipeLoading.set(false); },
          error: () => this.state.dangerWipeLoading.set(false),
        });
      },
      error: (err) => { this.state.dangerWiping.set(false); this.state.dangerWipeError.set(err.error?.error ?? this.transloco.translate('spaces.error.wipeFailed')); },
    });
  }

  async confirmDangerDelete(): Promise<void> {
    const target = this.state.settingsSpace();
    if (!target) return;
    // Irreversible: require the operator to type the space id (GitHub-style, C3).
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('spaces.dangerZone.confirmDeleteTitle'),
      message: this.transloco.translate('spaces.dangerZone.confirmDelete', { label: target.label, id: target.id }),
      confirmLabel: this.transloco.translate('spaces.dangerZone.deleteButton'),
      danger: true,
      requireText: target.id,
      requireTextLabel: this.transloco.translate('spaces.dangerZone.typeIdToConfirm', { id: target.id }),
    });
    if (!ok) return;
    this.state.dangerDeleting.set(true);
    this.state.dangerDeleteError.set('');
    this.spacesApi.deleteSpace(target.id).subscribe({
      next: () => {
        this.state.dangerDeleting.set(false);
        this.store.spaces.update(list => list.filter(s => s.id !== target.id));
        this.state.closeSettings();
      },
      error: (err) => { this.state.dangerDeleting.set(false); this.state.dangerDeleteError.set(err.error?.error ?? this.transloco.translate('spaces.error.deleteFailed')); },
    });
  }

  async leaveNetworkDanger(networkId: string): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('spaces.dangerZone.confirmLeaveNetworkTitle'),
      message: this.transloco.translate('spaces.dangerZone.confirmLeaveNetwork'),
      confirmLabel: this.transloco.translate('networks.leaveButton'),
      danger: true,
    });
    if (!ok) return;
    this.networksApi.leaveNetwork(networkId).subscribe({
      next: () => this.store.refreshNetworks(),
      error: () => this.toast.error(this.transloco.translate('spaces.error.leaveNetworkFailed')),
    });
  }
}
