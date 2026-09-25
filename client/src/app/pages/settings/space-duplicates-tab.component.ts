/**
 * Duplicates tab — near-duplicate detection rules for the space.
 *
 * Extracted from SpacesComponent (A17.8b). Needs no inputs and no data outputs: SpacesStore owns
 * the server data and SpaceSettingsState owns the dialog form state, and both are services the
 * page provides — so this component just renders them and calls them.
 */
import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { SPACE_DIALOG_STYLES } from './space-dialog.styles';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { SpacesStore } from './spaces-store.service';
import type { DupeActionRule } from '../../core/api.types';
import { TranslocoService } from '@jsverse/transloco';

@Component({
  selector: 'app-space-duplicates-tab',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [SPACE_DIALOG_STYLES],
  template: `
<div style="max-width:760px;">
  <p style="font-size:13px;color:var(--text-muted);margin:0 0 16px;">{{ 'spaces.dupe.intro' | transloco }}</p>

  <div class="field">
    <label>{{ 'spaces.dupe.survivor' | transloco }}</label>
    <select [(ngModel)]="state.dupeSurvivor" style="max-width:220px;">
      <option value="older">{{ 'spaces.dupe.survivorOlder' | transloco }}</option>
      <option value="newer">{{ 'spaces.dupe.survivorNewer' | transloco }}</option>
    </select>
  </div>

  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:12px;font-size:13px;">
    <input type="checkbox" [(ngModel)]="state.dupeOnInsert" />
    <span>{{ 'spaces.dupe.onInsert' | transloco }}</span>
  </label>
  <p style="font-size:12px;color:var(--text-muted);margin:-6px 0 16px;">{{ 'spaces.dupe.onInsertHint' | transloco }}</p>

  <div class="dz-section-title" style="margin-top:8px;">{{ 'spaces.dupe.rulesTitle' | transloco }}</div>
  <p style="font-size:12px;color:var(--text-muted);margin:4px 0 12px;">{{ 'spaces.dupe.rulesHint' | transloco }}</p>

  @for (r of state.dupeRulesState; track $index) {
    <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;padding:10px;background:var(--bg-secondary);border-radius:8px;margin-bottom:8px;">
      <div class="field" style="margin:0;width:170px;">
        <label style="font-size:11px;display:flex;justify-content:space-between;gap:6px;">
          <span>{{ 'spaces.dupe.minScore' | transloco }}</span>
          <span style="color:var(--accent);font-weight:600;font-variant-numeric:tabular-nums;">{{ pct(r.minScore) }}%</span>
        </label>
        <input type="range" min="0" max="1" step="0.01" [(ngModel)]="r.minScore" style="width:100%;" [attr.aria-label]="'spaces.dupe.minScore' | transloco" />
      </div>
      <div class="field" style="margin:0;width:150px;">
        <label style="font-size:11px;">{{ 'spaces.dupe.action' | transloco }}</label>
        <select [(ngModel)]="r.action">
          <option value="flag">{{ 'spaces.dupe.actionFlag' | transloco }}</option>
          <option value="automerge">{{ 'spaces.dupe.actionAutomerge' | transloco }}</option>
          <option value="notify">{{ 'spaces.dupe.actionNotify' | transloco }}</option>
        </select>
      </div>
      @if (r.action === 'notify') {
        <div class="field" style="margin:0;flex:1;min-width:220px;">
          <label style="font-size:11px;">{{ 'spaces.dupe.webhookUrl' | transloco }}</label>
          <input type="url" [(ngModel)]="r.webhookUrl" [placeholder]="'spaces.dupe.webhookPlaceholder' | transloco" />
        </div>
      }
      <button class="btn btn-secondary btn-sm" type="button" (click)="state.removeDupeRule($index)"
              [attr.aria-label]="'spaces.dupe.removeRule' | transloco"><ph-icon name="x" [size]="14"/></button>
    </div>
  } @empty {
    <div style="border:1px dashed var(--border);border-radius:8px;padding:16px 18px;color:var(--text-muted);font-size:13px;line-height:1.5;">
      {{ 'spaces.dupe.rulesEmpty' | transloco }}
    </div>
  }

  <button class="btn btn-secondary btn-sm" type="button" (click)="state.addDupeRule()" style="margin-top:8px;">
    <ph-icon name="plus" [size]="14"/> {{ 'spaces.dupe.addRule' | transloco }}
  </button>

  @if (state.hasAutomergeRule()) {
    <div class="alert alert-warning" style="margin-top:16px;display:flex;gap:8px;align-items:flex-start;">
      <ph-icon name="warning" [size]="18"/>
      <span>{{ 'spaces.dupe.automergeWarning' | transloco }}</span>
    </div>
  }

  @if (state.dupeError()) { <div class="alert alert-error" style="margin-top:12px;">{{ state.dupeError() }}</div> }

  <div style="margin-top:20px;display:flex;gap:8px;align-items:center;">
    <button class="btn btn-primary" type="button" (click)="saveDupeRules()" [disabled]="state.dupeSaving()">
      @if (state.dupeSaving()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.dupe.save' | transloco }}
    </button>
    @if (state.dupeSaved()) { <span style="font-size:13px;color:var(--success);">{{ 'spaces.dupe.saved' | transloco }}</span> }
  </div>
</div>
  `,
})
export class SpaceDuplicatesTabComponent {
  readonly state = inject(SpaceSettingsState);
  private spacesApi = inject(SpacesApi);
  private transloco = inject(TranslocoService);
  private confirmDialog = inject(ConfirmDialogService);
  readonly store = inject(SpacesStore);

  /** Render a 0–1 minScore as a whole-number percent for the slider label. */
  pct(v: number): number { return Math.round((Number(v) || 0) * 100); }

  async saveDupeRules(): Promise<void> {
    const target = this.state.settingsSpace();
    if (!target) return;
    // Validate notify override URLs client-side (the field is not inside a <form>).
    for (const r of this.state.dupeRulesState) {
      if (r.action === 'notify' && r.webhookUrl?.trim()) {
        try { new URL(r.webhookUrl.trim()); }
        catch { this.state.dupeError.set(this.transloco.translate('spaces.dupe.invalidUrl')); return; }
      }
    }
    // Auto-merge is destructive and unattended — confirm before enabling it.
    if (this.state.hasAutomergeRule()) {
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('spaces.dupe.automergeConfirmTitle'),
        message: this.transloco.translate('spaces.dupe.automergeConfirm'),
        danger: true,
      });
      if (!ok) return;
    }
    // Normalise: clamp scores, drop empty override URLs.
    const rules: DupeActionRule[] = this.state.dupeRulesState.map(r => ({
      minScore: Math.min(Math.max(Number(r.minScore) || 0, 0), 1),
      action: r.action,
      ...(r.types && r.types.length > 0 ? { types: r.types } : {}),
      ...(r.action === 'notify' && r.webhookUrl?.trim() ? { webhookUrl: r.webhookUrl.trim() } : {}),
    }));
    this.state.dupeSaving.set(true);
    this.state.dupeError.set('');
    this.state.dupeSaved.set(false);
    this.spacesApi.updateSpace(target.id, { dupeRules: rules, dupeMergeSurvivor: this.state.dupeSurvivor, dupeRulesOnInsert: this.state.dupeOnInsert }).subscribe({
      next: (result) => {
        this.state.dupeSaving.set(false);
        this.state.dupeSaved.set(true);
        // Duplicate rules are local and never governed, so this endpoint always answers with the space
        // for THIS request — but the response type admits `vote_pending` because a meta change on the
        // same endpoint can. Guard rather than assert: if a future field on this form ever becomes
        // governed, the tab skips the reflect instead of throwing inside its own success handler, which
        // is precisely the failure the settings tab shipped with.
        const space = result.space;
        if (!space) { this.state.markDupePristine(); return; }
        // Reflect saved state back onto the space object.
        this.state.settingsSpace.set(space);
        this.store.spaces.update(list => list.map(x => x.id === space.id ? space : x));
        // Re-baseline the dupe dirty snapshot so the close guard doesn't flag freshly-saved rules.
        this.state.markDupePristine();
      },
      error: (e) => { this.state.dupeSaving.set(false); this.state.dupeError.set(e?.error?.error || this.transloco.translate('spaces.dupe.saveError')); },
    });
  }
}
