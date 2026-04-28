import { Component, inject, signal, computed, OnInit, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize, timeout, TimeoutError } from 'rxjs';
import {
  ApiService, Network, Space, SpaceMeta, SpaceStats,
  KnowledgeType, PropertySchema, TypeSchema, ValidationMode, SchemaLibraryEntry,
} from '../../core/api.service';
import { TranslocoPipe } from '@jsverse/transloco';
import { TranslocoService } from '@jsverse/transloco';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { PhIconComponent } from '../../shared/ph-icon.component';

interface TypeSchemaState {
  namingPattern:   string;
  tagSuggestions:  string[];
  propertySchemas: { key: string; s: PropertySchema; _enumInput: string }[];
  _newPropInput:   string;
  _newTagInput:    string;
}

@Component({
  selector: 'app-spaces',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, DragDropModule, PhIconComponent],
  styles: [`
    /* chip inputs */
    .chip-wrap {
      display:flex; flex-wrap:wrap; gap:4px; align-items:center;
      border:1px solid var(--border); border-radius:var(--radius-sm);
      padding:4px 8px; min-height:34px; background:var(--bg-surface); cursor:text;
    }
    .chip {
      display:inline-flex; align-items:center; gap:3px;
      background:color-mix(in srgb,var(--accent) 15%,transparent);
      color:var(--accent); border-radius:3px; padding:1px 6px; font-size:12px;
    }
    .chip-rm { background:none; border:none; color:var(--text-muted); cursor:pointer; padding:0 2px; font-size:14px; line-height:1; }
    .chip-rm:hover { color:var(--danger); }
    .chip-field { border:none; background:none; outline:none; font-size:12px; min-width:100px; flex:1; color:var(--text-primary); font-family:var(--font); padding:1px 0; }
    /* storage bar */
    .st-bar { height:6px; border-radius:3px; background:var(--border); overflow:hidden; }
    .st-bar-fill { height:100%; border-radius:3px; transition:width .3s; }
    .st-bar-fill.ok     { background:var(--success); }
    .st-bar-fill.warn   { background:var(--warning); }
    .st-bar-fill.danger { background:var(--danger); }
    /* drag handle */
    .drag-handle { cursor:grab; color:var(--text-muted); padding:0 4px; user-select:none; font-size:16px; line-height:1; }
    .drag-handle:hover { color:var(--text-primary); }
    .drag-handle-disabled { cursor:default; opacity:0.3; }
    .drag-handle-disabled:hover { color:var(--text-muted); }
    .cdk-drag-preview { background:var(--bg-primary); border:1px solid var(--accent); border-radius:var(--radius-sm); box-shadow:var(--shadow-lg); opacity:0.95; }
    .cdk-drag-placeholder { opacity:0.3; }
    .cdk-drag-animating { transition:transform 250ms cubic-bezier(0,0,0.2,1); }
    /* sort buttons */
    .sort-group { display:flex; gap:2px; border:1px solid var(--border); border-radius:var(--radius-sm); overflow:hidden; }
    .sort-btn { background:none; border:none; padding:3px 8px; font-size:12px; cursor:pointer; color:var(--text-muted); font-family:var(--font); transition:background .15s,color .15s; white-space:nowrap; }
    .sort-btn:hover { background:var(--bg-surface); color:var(--text-primary); }
    .sort-btn.active { background:var(--accent-dim); color:var(--accent); font-weight:600; }
    /* search input */
    .space-search-input { height:28px; padding:0 8px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-surface); color:var(--text-primary); font-size:13px; min-width:160px; }
    /* create dialog */
    .dialog-backdrop { position:fixed; inset:0; background:var(--bg-scrim); display:flex; align-items:center; justify-content:center; z-index:100; }
    .dialog { background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-lg); padding:24px; width:90%; max-width:960px; max-height:90vh; overflow-y:auto; }
    .dialog-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
    /* settings popup */
    .sp-backdrop { position:fixed; inset:0; background:var(--bg-scrim); z-index:200; display:flex; align-items:center; justify-content:center; }
    .sp-panel { width:92vw; height:92vh; max-width:1200px; background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-lg); display:flex; flex-direction:column; overflow:hidden; }
    .sp-header { display:flex; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid var(--border); flex-shrink:0; }
    .sp-tabs { display:flex; border-bottom:1px solid var(--border); flex-shrink:0; background:var(--bg-surface); }
    .sp-tab { background:none; border:none; border-bottom:2px solid transparent; padding:10px 20px; cursor:pointer; font-size:13px; font-family:var(--font); color:var(--text-muted); transition:color .15s; }
    .sp-tab:hover { color:var(--text-primary); }
    .sp-tab.active { color:var(--text-primary); border-bottom-color:var(--accent); font-weight:500; }
    .sp-tab.danger-tab.active { color:var(--danger); border-bottom-color:var(--danger); }
    .sp-body { flex:1; overflow-y:auto; padding:24px; }
    .sp-footer { display:flex; align-items:center; gap:8px; padding:12px 20px; border-top:1px solid var(--border); flex-shrink:0; }
    /* schema */
    .sch-section { margin-bottom:28px; }
    .sch-section-title { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted); margin-bottom:12px; padding-bottom:6px; border-bottom:1px solid var(--border); }
    .sch-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .sch-grid-3 { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
    .prop-table { width:100%; border-collapse:collapse; font-size:13px; }
    .prop-table th { text-align:left; font-size:11px; font-weight:600; color:var(--text-muted); padding:5px 8px; border-bottom:1px solid var(--border); }
    .prop-table td { padding:6px 8px; border-bottom:1px solid var(--border); vertical-align:middle; }
    .prop-expand-row td { background:var(--bg-elevated); padding:0; }
    .prop-expand-inner { padding:12px 16px; }
    /* danger zone */
    .dz-section { border:1px solid var(--border); border-radius:var(--radius-md); padding:16px; margin-bottom:16px; }
    .dz-section.dz-red { border-color:var(--danger); }
    .dz-section-title { font-weight:600; margin-bottom:6px; font-size:14px; }
    .dz-section.dz-red .dz-section-title { color:var(--danger); }
    /* ── schema: top-level collection tabs ── */
    .sch-coll-tabs { display:flex; border-bottom:2px solid var(--border); margin-bottom:0; overflow-x:auto; gap:0; flex-shrink:0; }
    .sch-coll-tab { background:none; border:none; border-bottom:2px solid transparent; margin-bottom:-2px; padding:10px 22px; cursor:pointer; font-size:13px; font-family:var(--font); color:var(--text-muted); display:inline-flex; align-items:center; gap:6px; transition:color .15s; white-space:nowrap; }
    .sch-coll-tab:hover { color:var(--text-primary); }
    .sch-coll-tab.active { color:var(--text-primary); border-bottom-color:var(--accent); font-weight:600; }
    .sch-cnt-badge { background:color-mix(in srgb,var(--accent) 15%,transparent); color:var(--accent); font-size:10px; font-weight:700; border-radius:10px; padding:1px 6px; min-width:18px; text-align:center; }
    .sch-coll-body { padding:20px 0 0; }
    /* ── type-list table (entity types / edge labels) ── */
    .type-table { width:100%; border-collapse:collapse; font-size:13px; margin-bottom:0; }
    .type-table th { text-align:left; font-size:11px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; padding:5px 10px; border-bottom:1px solid var(--border); background:var(--bg-elevated); }
    .type-table td { padding:8px 10px; border-bottom:1px solid var(--border); vertical-align:middle; }
    .type-table tr:hover td { background:var(--bg-elevated); }
    /* ── property rows ── */
    .prop-row { cursor:pointer; user-select:none; }
    .prop-row:hover td { background:var(--bg-elevated); }
    .prop-row.prow-open td { background:color-mix(in srgb,var(--accent) 6%,transparent); }
    /* ── property detail card ── */
    .pdet { background:var(--bg-surface); border-top:2px solid color-mix(in srgb,var(--accent) 30%,transparent); }
    .pdet-head { display:flex; align-items:center; gap:10px; padding:10px 14px; background:color-mix(in srgb,var(--accent) 8%,transparent); border-bottom:1px solid var(--border); }
    .pdet-key { font-family:var(--font-mono); font-size:13px; font-weight:700; flex:1; color:var(--text-primary); }
    .pdet-fields { display:grid; grid-template-columns:repeat(3,1fr); gap:10px 16px; padding:14px; }
    .pdet-full { padding:0 14px 14px; }
    .req-toggle { display:inline-flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; color:var(--text-muted); background:none; border:1px solid var(--border); font-family:var(--font); padding:3px 10px; border-radius:var(--radius-sm); transition:all .15s; }
    .req-toggle:hover { background:var(--bg-elevated); color:var(--text-primary); border-color:color-mix(in srgb,var(--accent) 40%,transparent); }
    .req-toggle.is-req { color:var(--warning); border-color:color-mix(in srgb,var(--warning) 50%,transparent); background:color-mix(in srgb,var(--warning) 8%,transparent); font-weight:600; }
    /* ── schema sub-section headers ── */
    .sch-sub { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.07em; color:var(--text-muted); padding:14px 0 8px; margin-bottom:2px; }
  `],
  template: `
    <!-- CREATE DIALOG -->
    @if (showCreateDialog()) {
      <div class="dialog-backdrop" (click)="showCreateDialog.set(false)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <div class="card-title">{{ 'spaces.create.title' | transloco }}</div>
            <button class="icon-btn" (click)="showCreateDialog.set(false)">✕</button>
          </div>
          @if (createError()) { <div class="alert alert-error">{{ createError() }}</div> }
          <form (ngSubmit)="createSpace()" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
            <div class="field" style="flex:1;min-width:140px;margin-bottom:0;">
              <label>{{ 'spaces.create.label' | transloco }}</label>
              <input type="text" [(ngModel)]="form.label" name="label" [placeholder]="'spaces.create.labelPlaceholder' | transloco" maxlength="200" required />
            </div>
            <div class="field" style="width:140px;margin-bottom:0;">
              <label>{{ 'spaces.create.id' | transloco }}</label>
              <input type="text" [(ngModel)]="form.id" name="id" [placeholder]="'spaces.create.idPlaceholder' | transloco" pattern="[a-z0-9-]+" />
            </div>
            <div class="field" style="width:120px;margin-bottom:0;">
              <label>{{ 'spaces.create.maxGiB' | transloco }}</label>
              <input type="number" [(ngModel)]="form.maxGiB" name="maxGiB" min="0" step="0.1" placeholder="—" />
            </div>
            <div style="display:flex;gap:12px;flex-basis:100%;">
              <div class="field" style="flex:1;margin-bottom:0;">
                <label>{{ 'spaces.create.purpose' | transloco }}</label>
                <textarea [(ngModel)]="form.purpose" name="purpose" maxlength="4000" rows="5" style="resize:vertical;" [placeholder]="'spaces.create.purposePlaceholder' | transloco"></textarea>
              </div>
              <div class="field" style="flex:1;margin-bottom:0;">
                <label>{{ 'spaces.create.proxyFor' | transloco }}</label>
                @if (spaces().length > 0) {
                  <div class="table-wrapper" style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm);">
                    <table style="margin:0;">
                      <thead><tr><th style="width:40px;"></th><th>{{ 'spaces.table.column.label' | transloco }}</th><th>{{ 'spaces.table.column.id' | transloco }}</th></tr></thead>
                      <tbody>
                        <tr style="cursor:pointer;background:var(--bg-elevated);" (click)="toggleProxyForAll()">
                          <td style="text-align:center;"><input type="checkbox" [checked]="proxyForAll" (click)="$event.stopPropagation()" (change)="toggleProxyForAll()" /></td>
                          <td colspan="2" style="font-style:italic;color:var(--text-muted);">{{ 'spaces.create.proxyForAll' | transloco }}</td>
                        </tr>
                        @for (s of spaces(); track s.id) {
                          <tr style="cursor:pointer;" [class.text-muted]="proxyForAll" (click)="!proxyForAll && toggleProxyFor(s.id)">
                            <td style="text-align:center;"><input type="checkbox" [checked]="proxyForAll || isProxyForSelected(s.id)" [disabled]="proxyForAll" (click)="$event.stopPropagation()" (change)="!proxyForAll && toggleProxyFor(s.id)" /></td>
                            <td>{{ s.label }}</td>
                            <td><span class="badge badge-gray mono" style="font-size:11px;">{{ s.id }}</span></td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                } @else {
                  <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">{{ 'spaces.create.noExistingSpaces' | transloco }}</div>
                }
              </div>
            </div>
            <div style="display:flex;gap:12px;flex-basis:100%;align-items:flex-start;">
              <div class="field" style="margin-bottom:0;">
                <label>{{ 'spaces.create.validationMode' | transloco }}</label>
                <select [(ngModel)]="form.validationMode" name="validationMode" style="width:140px;">
                  <option value="off">{{ 'spaces.create.validation.off' | transloco }}</option><option value="warn">{{ 'spaces.create.validation.warn' | transloco }}</option><option value="strict">{{ 'spaces.create.validation.strict' | transloco }}</option>
                </select>
              </div>
              <div class="field" style="margin-bottom:0;padding-top:22px;">
                <label style="display:flex;align-items:center;gap:8px;font-weight:normal;cursor:pointer;">
                  <input type="checkbox" [(ngModel)]="form.strictLinkage" name="strictLinkage" />{{ 'spaces.create.strictLinkage' | transloco }}
                </label>
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-basis:100%;">
              <button class="btn btn-primary" type="submit" style="margin-left:auto;" [disabled]="creating()||!form.label.trim()">
                @if (creating()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.create.submitButton' | transloco }}
              </button>
            </div>
          </form>
        </div>
      </div>
    }

    <!-- SETTINGS POPUP -->
    @if (settingsSpace()) {
      <div class="sp-backdrop" (click)="closeSettings()">
        <div class="sp-panel" (click)="$event.stopPropagation()">
          <div class="sp-header">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ settingsSpace()!.label }}</div>
              <div style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);">{{ settingsSpace()!.id }}</div>
            </div>
            <button class="icon-btn" (click)="closeSettings()">✕</button>
          </div>
          <div class="sp-tabs">
            <button class="sp-tab" [class.active]="settingsTab()==='settings'" (click)="settingsTab.set('settings')">{{ 'spaces.popup.tab.settings' | transloco }}</button>
            <button class="sp-tab" [class.active]="settingsTab()==='schema'"   (click)="settingsTab.set('schema')">{{ 'spaces.popup.tab.schema' | transloco }}</button>
            <button class="sp-tab danger-tab" [class.active]="settingsTab()==='danger'" (click)="settingsTab.set('danger')">{{ 'spaces.popup.tab.dangerZone' | transloco }}</button>
          </div>
          <div class="sp-body">

            <!-- SETTINGS TAB -->
            @if (settingsTab() === 'settings') {
              <div style="max-width:720px;">
                <div class="field">
                  <label>{{ 'spaces.settings.label' | transloco }}</label>
                  <input type="text" [(ngModel)]="stForm.label" maxlength="200" />
                </div>
                <div class="field">
                  <label>{{ 'spaces.settings.purpose' | transloco }} <span style="font-size:11px;color:var(--text-muted);font-weight:normal;">{{ 'spaces.settings.purposeHint' | transloco }}</span></label>
                  <textarea [(ngModel)]="stForm.purpose" rows="6" maxlength="4000" style="resize:vertical;"></textarea>
                </div>
                <div class="field">
                  <label>{{ 'spaces.settings.usageNotes' | transloco }} <span style="font-size:11px;color:var(--text-muted);font-weight:normal;">{{ 'spaces.settings.usageNotesHint' | transloco }}</span></label>
                  <textarea [(ngModel)]="stForm.usageNotes" rows="3" maxlength="2000" style="resize:vertical;"></textarea>
                </div>
                <div class="field" style="max-width:220px;">
                  <label>{{ 'spaces.settings.maxStorage' | transloco }}</label>
                  <input type="number" [(ngModel)]="stForm.maxGiB" min="0" step="0.1" [placeholder]="'spaces.settings.unlimitedPlaceholder' | transloco" />
                  <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">{{ 'spaces.settings.maxStorageHint' | transloco }}</div>
                </div>
                <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;">
                  <div class="field" style="margin:0;">
                    <label>{{ 'spaces.settings.validationMode' | transloco }}</label>
                    <select [(ngModel)]="schValidation" style="width:220px;">
                      <option value="off">{{ 'spaces.settings.validation.off' | transloco }}</option>
                      <option value="warn">{{ 'spaces.settings.validation.warn' | transloco }}</option>
                      <option value="strict">{{ 'spaces.settings.validation.strict' | transloco }}</option>
                    </select>
                  </div>
                  <div class="field" style="margin:0;padding-top:22px;">
                    <label style="display:flex;align-items:center;gap:8px;font-weight:normal;cursor:pointer;">
                      <input type="checkbox" [(ngModel)]="schStrictLinkage" />
                      {{ 'spaces.settings.strictLinkage' | transloco }}
                      <span style="font-size:11px;color:var(--text-muted);font-weight:normal;">{{ 'spaces.settings.strictLinkageHint' | transloco }}</span>
                    </label>
                  </div>
                </div>
              </div>
            }

            <!-- SCHEMA TAB -->
            @if (settingsTab() === 'schema') {
              <!-- export / import toolbar -->
              <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
                <button class="btn btn-secondary btn-sm" type="button" (click)="exportSchema()" [attr.title]="'spaces.schema.exportTitle' | transloco"><ph-icon name="upload" [size]="13" style="margin-right:5px;"/>{{ 'spaces.schema.exportJsonButton' | transloco }}</button>
                <button class="btn btn-secondary btn-sm" type="button" (click)="triggerImportSchema()" [attr.title]="'spaces.schema.importTitle' | transloco"><ph-icon name="download-simple" [size]="13" style="margin-right:5px;"/>{{ 'spaces.schema.importJsonButton' | transloco }}</button>
                <input #schImportInput type="file" accept=".json,application/json" style="display:none" (change)="onImportSchemaFile($event)" />
                <input #schTypeImportInput type="file" accept=".json,application/json" style="display:none" (change)="onImportTypeSchemaFile($event)" />
                <span style="font-size:11px;color:var(--text-muted);margin-left:4px;">{{ 'spaces.schema.autoSyncHint' | transloco }}</span>
              </div>
              <!-- collection tabs -->
              <div class="sch-coll-tabs">
                <button class="sch-coll-tab" [class.active]="schemaCollTab()==='entity'" (click)="schemaCollTab.set('entity');schImportError=''">
                  {{ 'spaces.schema.tab.entities' | transloco }}
                  @if (typeCount('entity')) { <span class="sch-cnt-badge">{{ typeCount('entity') }}</span> }
                </button>
                <button class="sch-coll-tab" [class.active]="schemaCollTab()==='edge'" (click)="schemaCollTab.set('edge');schImportError=''">
                  {{ 'spaces.schema.tab.edges' | transloco }}
                  @if (typeCount('edge')) { <span class="sch-cnt-badge">{{ typeCount('edge') }}</span> }
                </button>
                <button class="sch-coll-tab" [class.active]="schemaCollTab()==='memory'" (click)="schemaCollTab.set('memory');schImportError=''">
                  {{ 'spaces.schema.tab.memories' | transloco }}
                  @if (typeCount('memory')) { <span class="sch-cnt-badge">{{ typeCount('memory') }}</span> }
                </button>
                <button class="sch-coll-tab" [class.active]="schemaCollTab()==='chrono'" (click)="schemaCollTab.set('chrono');schImportError=''">
                  {{ 'spaces.schema.tab.chrono' | transloco }}
                  @if (typeCount('chrono')) { <span class="sch-cnt-badge">{{ typeCount('chrono') }}</span> }
                </button>
              </div>
              <div class="sch-coll-body">

                @if (schemaCollTab() === 'entity') {
                  <div class="sch-sub">{{ 'spaces.schema.subtitle.types' | transloco }} <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-muted);">{{ 'spaces.schema.entityTypeHint' | transloco }}</span></div>
                }
                @if (schemaCollTab() === 'edge') {
                  <div class="sch-sub">{{ 'spaces.schema.subtitle.labels' | transloco }} <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-muted);">{{ 'spaces.schema.edgeLabelHint' | transloco }}</span></div>
                }
                @if (schemaCollTab() === 'memory') {
                  <div class="sch-sub">{{ 'spaces.schema.subtitle.types' | transloco }} <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-muted);">{{ 'spaces.schema.memoryTypeHint' | transloco }}</span></div>
                }
                @if (schemaCollTab() === 'chrono') {
                  <div class="sch-sub">{{ 'spaces.schema.subtitle.types' | transloco }} <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-muted);">{{ 'spaces.schema.chronoTypeHint' | transloco }}</span></div>
                }

                <!-- type list -->
                <ng-container *ngTemplateOutlet="typeList; context: { kt: schemaCollTab() }"></ng-container>

                <!-- Global tag suggestions (entity tab) -->
                @if (schemaCollTab() === 'entity') {
                  <div class="sch-sub" style="margin-top:28px;">{{ 'spaces.schema.globalTagSuggestions' | transloco }} <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-muted);">{{ 'spaces.schema.globalTagSuggestionsHint' | transloco }}</span></div>
                  <div class="chip-wrap">
                    @for (t of schTagSuggestions; track t) {
                      <span class="chip">{{ t }}<button type="button" class="chip-rm" (click)="schTagSuggestions=schTagSuggestions.filter(x=>x!==t)">×</button></span>
                    }
                    <input type="text" class="chip-field" [(ngModel)]="schNewTagInput"
                      [placeholder]="schTagSuggestions.length ? '' : ('spaces.schema.addTagSuggestionPlaceholder' | transloco)"
                      (keydown.enter)="$event.preventDefault();addGlobalTag()" />
                  </div>
                }

              </div><!-- sch-coll-body -->

              <!-- ── shared type-list template ── -->
              <ng-template #typeList let-kt="kt">
                <div class="table-wrapper" style="margin-bottom:0;">
                  <table class="type-table">
                    <thead>
                      <tr>
                        <th>{{ kt === 'edge' ? ('spaces.schema.typeTable.labelColumn' | transloco) : ('spaces.schema.typeTable.typeName' | transloco) }}</th>
                        <th style="width:48px;"></th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (name of typeNames(kt); track name) {
                        <tr class="prop-row" [class.prow-open]="isTypeExpanded(kt,name)">
                          <td (click)="toggleTypeExpand(kt,name)" style="cursor:pointer;">
                            <div style="display:flex;align-items:center;gap:8px;">
                              <span style="font-family:var(--font-mono);font-size:13px;color:var(--accent);">{{ name }}</span>
                              @if (typeLibRef(kt,name)) {
                                <span class="badge badge-blue" style="font-size:10px;">Library</span>
                              } @else {
                                @if (typeState(kt,name).propertySchemas.length) {
                                  <span class="badge badge-gray" style="font-size:10px;">{{ typeState(kt,name).propertySchemas.length }} prop{{ typeState(kt,name).propertySchemas.length !== 1 ? 's' : '' }}</span>
                                }
                                @if (typeState(kt,name).tagSuggestions.length) {
                                  <span class="badge badge-gray" style="font-size:10px;">{{ typeState(kt,name).tagSuggestions.length }} tag{{ typeState(kt,name).tagSuggestions.length !== 1 ? 's' : '' }}</span>
                                }
                                @if (kt === 'entity' && typeState(kt,name).namingPattern) {
                                  <span class="badge badge-gray" style="font-size:10px;">pattern</span>
                                }
                              }
                            </div>
                          </td>
                          <td (click)="$event.stopPropagation()">
                            <div style="display:flex;gap:4px;justify-content:flex-end;">
                              <button class="btn btn-ghost btn-sm" type="button" (click)="exportTypeSchema(kt,name)"
                                style="padding:2px 6px;" [attr.title]="'spaces.schema.exportTypeTitle' | transloco"><ph-icon name="upload" [size]="12"/></button>
                              @if (!typeLibRef(kt,name)) {
                                <button class="btn btn-ghost btn-sm" type="button" (click)="saveTypeToLibrary(kt,name)"
                                  style="font-size:10px;padding:2px 6px;" [attr.title]="'spaces.schema.saveToLibraryTitle' | transloco">{{ 'spaces.schema.saveToLibraryButton' | transloco }}</button>
                              }
                              <button class="btn btn-ghost btn-sm" type="button" (click)="toggleTypeExpand(kt,name)"
                                style="font-size:10px;padding:2px 8px;min-width:28px;">{{ isTypeExpanded(kt,name) ? '▲' : '▼' }}</button>
                              <button class="icon-btn danger" type="button" (click)="removeType(kt,name)" [attr.title]="'common.remove' | transloco">✕</button>
                            </div>
                          </td>
                        </tr>
                        @if (isTypeExpanded(kt,name)) {
                          <tr class="prop-expand-row" (click)="$event.stopPropagation()">
                            <td colspan="2" style="padding:0;">
                              <div class="pdet">
                                @if (typeLibRef(kt,name); as libRef) {
                                  <!-- Linked library schema — non-editable -->
                                  <div style="display:flex;align-items:center;gap:10px;padding:4px 0;color:var(--text-secondary);font-size:13px;">
                                    <ph-icon name="bookmarks" [size]="16" style="color:var(--accent);flex-shrink:0;"/>
                                    <span>{{ 'spaces.schema.libRef.linkedHint' | transloco: {name: libRef} }}</span>
                                  </div>
                                } @else {
                                <!-- Naming pattern (entity only) -->
                                @if (kt === 'entity') {
                                  <div class="pdet-fields" style="margin-bottom:12px;">
                                    <div class="field" style="margin:0;">
                                      <label>{{ 'spaces.schema.namingPattern' | transloco }} <span style="font-size:10px;font-weight:400;color:var(--text-muted);">{{ 'spaces.schema.namingPatternHint' | transloco }}</span></label>
                                      <input type="text" [(ngModel)]="typeState(kt,name).namingPattern" [placeholder]="'spaces.schema.namingPatternPlaceholder' | transloco" style="max-width:320px;" />
                                    </div>
                                  </div>
                                }
                                <!-- Tag suggestions per type -->
                                <div class="pdet-full" style="margin-bottom:12px;">
                                  <div class="field" style="margin:0;">
                                    <label>{{ 'spaces.schema.tagSuggestions' | transloco }} <span style="font-size:10px;font-weight:400;color:var(--text-muted);">{{ 'spaces.schema.tagSuggestionsHint' | transloco }}</span></label>
                                    <div class="chip-wrap">
                                      @for (tag of typeState(kt,name).tagSuggestions; track tag) {
                                        <span class="chip">{{ tag }}<button type="button" class="chip-rm" (click)="typeState(kt,name).tagSuggestions=typeState(kt,name).tagSuggestions.filter(x=>x!==tag)">×</button></span>
                                      }
                                      <input type="text" class="chip-field" [(ngModel)]="typeState(kt,name)._newTagInput"
                                        [placeholder]="typeState(kt,name).tagSuggestions.length ? '' : ('spaces.schema.addTagPlaceholder' | transloco)"
                                        (keydown.enter)="$event.preventDefault();addTypeTag(kt,name)" />
                                    </div>
                                  </div>
                                </div>
                                <!-- Property schemas -->
                                <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;">{{ 'spaces.schema.propertySchemas' | transloco }}</div>
                                <div class="table-wrapper" style="margin-bottom:0;">
                                  <table class="prop-table" style="margin-bottom:0;">
                                    <thead>
                                      <tr>
                                        <th style="width:160px;">{{ 'spaces.schema.propTable.property' | transloco }}</th>
                                        <th style="width:80px;">{{ 'spaces.schema.propTable.type' | transloco }}</th>
                                        <th>{{ 'spaces.schema.propTable.constraints' | transloco }}</th>
                                        <th style="width:68px;"></th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      @for (p of typeState(kt,name).propertySchemas; track p.key) {
                                        <tr class="prop-row" [class.prow-open]="isPropExpanded(kt,name,p.key)"
                                          (click)="togglePropExpand(kt,name,p.key)">
                                          <td>
                                            <div style="display:flex;align-items:center;gap:7px;">
                                              <span style="font-family:var(--font-mono);font-size:12px;">{{ p.key }}</span>
                                              @if (p.s.required) {
                                                <span style="font-size:10px;background:color-mix(in srgb,var(--warning) 16%,transparent);color:var(--warning);border-radius:3px;padding:1px 5px;font-weight:700;">req</span>
                                              }
                                            </div>
                                          </td>
                                          <td><span class="badge badge-gray" style="font-size:11px;">{{ p.s.type ?? 'any' }}</span></td>
                                          <td style="font-size:11px;color:var(--text-muted);">
                                            @if (p.s.enum?.length) { <span class="badge badge-gray" style="font-size:10px;margin-right:3px;">enum {{ p.s.enum!.length }}</span> }
                                            @if (p.s.minimum!==undefined) { <span style="margin-right:4px;">min:{{ p.s.minimum }}</span> }
                                            @if (p.s.maximum!==undefined) { <span style="margin-right:4px;">max:{{ p.s.maximum }}</span> }
                                            @if (p.s.pattern) { <span style="margin-right:4px;">pattern</span> }
                                            @if (p.s.default!==undefined) { <span style="margin-right:4px;">default:{{ p.s.default }}</span> }
                                            @if (p.s.mergeFn) { <span class="badge badge-blue" style="font-size:10px;">{{ p.s.mergeFn }}</span> }
                                          </td>
                                          <td (click)="$event.stopPropagation()">
                                            <div style="display:flex;gap:4px;justify-content:flex-end;">
                                              <button class="btn btn-ghost btn-sm" type="button" (click)="togglePropExpand(kt,name,p.key)"
                                                style="font-size:10px;padding:2px 8px;min-width:28px;">{{ isPropExpanded(kt,name,p.key) ? '▲' : '▼' }}</button>
                                              <button class="icon-btn danger" type="button" (click)="removeProp(kt,name,p.key)" [attr.title]="'common.remove' | transloco">✕</button>
                                            </div>
                                          </td>
                                        </tr>
                                        @if (isPropExpanded(kt,name,p.key)) {
                                          <tr class="prop-expand-row" (click)="$event.stopPropagation()">
                                            <td colspan="4" style="padding:0;">
                                              <div class="pdet">
                                                <div class="pdet-head">
                                                  <span class="pdet-key">{{ p.key }}</span>
                                                  <label class="req-toggle" [class.is-req]="p.s.required">
                                                    <input type="checkbox" [checked]="p.s.required" (change)="p.s.required = !p.s.required" style="pointer-events:none;" />
                                                    {{ 'spaces.schema.propDetail.required' | transloco }}
                                                  </label>
                                                  <button class="icon-btn danger" type="button" (click)="removeProp(kt,name,p.key)" [attr.title]="'spaces.schema.removePropertyTitle' | transloco">✕</button>
                                                </div>
                                                <div class="pdet-fields">
                                                  <div class="field" style="margin:0;">
                                                    <label>{{ 'spaces.schema.propDetail.type' | transloco }}</label>
                                                    <select [(ngModel)]="p.s.type">
                                                      <option [ngValue]="undefined">any</option>
                                                      <option value="string">string</option>
                                                      <option value="number">number</option>
                                                      <option value="boolean">boolean</option>
                                                      <option value="date">date</option>
                                                    </select>
                                                  </div>
                                                  <div class="field" style="margin:0;">
                                                    <label>{{ 'spaces.schema.propDetail.default' | transloco }}</label>
                                                    <input type="text" [(ngModel)]="p.s.default" placeholder="—" />
                                                  </div>
                                                  <div class="field" style="margin:0;">
                                                    <label>{{ 'spaces.schema.propDetail.mergeFn' | transloco }}</label>
                                                    <select [(ngModel)]="p.s.mergeFn">
                                                      <option [ngValue]="undefined">—</option>
                                                      <option value="avg">avg</option><option value="min">min</option>
                                                      <option value="max">max</option><option value="sum">sum</option>
                                                      <option value="and">and</option><option value="or">or</option>
                                                      <option value="xor">xor</option>
                                                    </select>
                                                  </div>
                                                  @if (p.s.type==='string'||p.s.type===undefined) {
                                                    <div class="field" style="margin:0;">
                                                      <label>{{ 'spaces.schema.propDetail.pattern' | transloco }} <span style="font-size:10px;font-weight:400;color:var(--text-muted);">{{ 'spaces.schema.propDetail.patternHint' | transloco }}</span></label>
                                                      <input type="text" [(ngModel)]="p.s.pattern" placeholder="^[A-Z].*" />
                                                    </div>
                                                  }
                                                  @if (p.s.type==='number'||p.s.type===undefined) {
                                                    <div class="field" style="margin:0;">
                                                      <label>{{ 'spaces.schema.propDetail.min' | transloco }}</label>
                                                      <input type="number" [(ngModel)]="p.s.minimum" placeholder="—" />
                                                    </div>
                                                    <div class="field" style="margin:0;">
                                                      <label>{{ 'spaces.schema.propDetail.max' | transloco }}</label>
                                                      <input type="number" [(ngModel)]="p.s.maximum" placeholder="—" />
                                                    </div>
                                                  }
                                                </div>
                                                @if (p.s.type !== 'boolean') {
                                                  <div class="pdet-full">
                                                    <div class="field" style="margin:0;">
                                                      <label>{{ 'spaces.schema.propDetail.enumValues' | transloco }} <span style="font-size:11px;font-weight:normal;color:var(--text-muted);">{{ 'spaces.schema.propDetail.enumHint' | transloco }}</span></label>
                                                      <div class="chip-wrap">
                                                        @for (ev of (p.s.enum??[]); track ev) {
                                                          <span class="chip">{{ ev }}<button type="button" class="chip-rm" (click)="removeEnumVal(kt,name,p.key,ev)">×</button></span>
                                                        }
                                                        <input type="text" class="chip-field" [(ngModel)]="p._enumInput"
                                                          [placeholder]="'spaces.schema.propDetail.enumPlaceholder' | transloco" (keydown)="onEnumKey($event,kt,name,p.key)" />
                                                      </div>
                                                    </div>
                                                  </div>
                                                }
                                              </div>
                                            </td>
                                          </tr>
                                        }
                                      } @empty {
                                        <tr>
                                          <td colspan="4" style="padding:28px 0;text-align:center;color:var(--text-muted);font-size:13px;font-style:italic;">
                                            {{ 'spaces.schema.noProps' | transloco }}
                                          </td>
                                        </tr>
                                      }
                                    </tbody>
                                  </table>
                                </div>
                                <!-- add property -->
                                <div style="display:flex;gap:8px;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
                                  <input type="text" [(ngModel)]="typeState(kt,name)._newPropInput" [placeholder]="'spaces.schema.newPropNamePlaceholder' | transloco"
                                    style="flex:1;max-width:220px;"
                                    (keydown.enter)="$event.preventDefault();addProp(kt,name)" />
                                  <button class="btn btn-secondary btn-sm" type="button"
                                    (click)="addProp(kt,name)" [disabled]="!typeState(kt,name)._newPropInput.trim()">{{ 'spaces.schema.addPropertyButton' | transloco }}</button>
                                </div>
                                } <!-- end @else (not a lib-ref type) -->
                              </div>
                            </td>
                          </tr>
                        }
                      } @empty {
                        <tr>
                          <td colspan="2" style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;font-style:italic;">
                            {{ kt === 'edge' ? ('spaces.schema.noEdgeLabels' | transloco) : ('spaces.schema.noTypes' | transloco) }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                <!-- add type/label -->
                <div style="display:flex;gap:8px;align-items:center;margin-top:8px;padding-top:8px;">
                  <input type="text" [(ngModel)]="schNewTypeInputs[kt]" [placeholder]="kt === 'edge' ? ('spaces.schema.newLabelPlaceholder' | transloco) : ('spaces.schema.newTypeNamePlaceholder' | transloco)"
                    style="flex:1;max-width:200px;"
                    (keydown.enter)="$event.preventDefault();addType(kt)" />
                  <button class="btn btn-secondary btn-sm" type="button"
                    (click)="addType(kt)" [disabled]="!schNewTypeInputs[kt]?.trim()">{{ kt === 'edge' ? ('spaces.schema.addLabelButton' | transloco) : ('spaces.schema.addTypeButton' | transloco) }}</button>
                  <button class="btn btn-secondary btn-sm" type="button"
                    (click)="triggerImportTypeSchemaNew(kt)"
                    [attr.title]="'spaces.schema.importFromFileButton' | transloco"><ph-icon name="download-simple" [size]="13" style="margin-right:4px;vertical-align:-2px;"/>{{ 'spaces.schema.importFromFileButton' | transloco }}</button>
                  <button class="btn btn-secondary btn-sm" type="button"
                    (click)="triggerImportFromLibraryNew(kt)"
                    [attr.title]="'spaces.schema.importFromLibraryTitle' | transloco"><ph-icon name="bookmarks" [size]="13" style="margin-right:4px;vertical-align:-2px;"/>{{ 'spaces.schema.importFromLibraryButton' | transloco }}</button>
                </div>
                @if (schImportError) {
                  <div style="font-size:12px;color:var(--error);margin-top:4px;">{{ schImportError }}</div>
                }
              </ng-template>
            }

            <!-- DANGER ZONE TAB -->
            @if (settingsTab() === 'danger') {
              <div class="dz-section">
                <div class="dz-section-title">{{ 'spaces.dangerZone.renameTitle' | transloco }}</div>
                <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">{{ 'spaces.dangerZone.renameDescription' | transloco }}</p>
                <form (ngSubmit)="submitDangerRename()" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
                  <div class="field" style="margin:0;flex:1;max-width:280px;">
                    <label>{{ 'spaces.dangerZone.newId' | transloco }}</label>
                    <input type="text" [(ngModel)]="dangerRenameId" name="dangerRenameId" pattern="[a-z0-9-]+" maxlength="40" [placeholder]="settingsSpace()!.id" />
                  </div>
                  <button class="btn btn-secondary" type="submit" [disabled]="dangerRenaming()||!dangerRenameId.trim()||dangerRenameId.trim()===settingsSpace()!.id">
                    @if (dangerRenaming()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.dangerZone.renameButton' | transloco }}
                  </button>
                </form>
                @if (dangerRenameError()) { <div class="alert alert-error" style="margin-top:8px;">{{ dangerRenameError() }}</div> }
              </div>

              <div class="dz-section">
                <div class="dz-section-title">{{ 'spaces.dangerZone.wipeTitle' | transloco }}</div>
                <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">{{ 'spaces.dangerZone.wipeDescription' | transloco }}</p>
                @if (dangerWipeLoading()) {
                  <div style="display:flex;gap:8px;align-items:center;color:var(--text-muted);font-size:13px;margin-bottom:12px;">
                    <span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> {{ 'spaces.dangerZone.loadingCounts' | transloco }}
                  </div>
                } @else if (dangerWipeStats()) {
                  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:16px;">
                    @for (col of wipeStatCols(); track col.label) {
                      <div style="text-align:center;padding:10px 6px;background:var(--bg-elevated);border-radius:var(--radius-sm);">
                        <div style="font-size:20px;font-weight:700;font-family:var(--font-mono);">{{ col.value }}</div>
                        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">{{ col.label }}</div>
                      </div>
                    }
                  </div>
                }
                @if (dangerWipeError()) { <div class="alert alert-error" style="margin-bottom:8px;">{{ dangerWipeError() }}</div> }
                <button class="btn btn-danger" type="button" (click)="confirmDangerWipe()" [disabled]="dangerWiping()">
                  @if (dangerWiping()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.dangerZone.wipeButton' | transloco }}
                </button>
              </div>

              @let spaceNets = networksForSpace(settingsSpace()!.id);
              @if (spaceNets.length > 0) {
                <div class="dz-section">
                  <div class="dz-section-title">{{ 'spaces.dangerZone.leaveNetworksTitle' | transloco }}</div>
                  <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">{{ 'spaces.dangerZone.leaveNetworksDescription' | transloco }}</p>
                  @for (n of spaceNets; track n.id) {
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
                      <div>
                        <span style="font-weight:500;">{{ n.label }}</span>
                        <span class="badge badge-gray" style="margin-left:8px;font-size:11px;">{{ n.id }}</span>
                      </div>
                      <button class="btn btn-secondary btn-sm" type="button" (click)="leaveNetworkDanger(n.id)">{{ 'spaces.dangerZone.leaveButton' | transloco }}</button>
                    </div>
                  }
                </div>
              }

              @if (!settingsSpace()!.builtIn) {
                <div class="dz-section dz-red">
                  <div class="dz-section-title">{{ 'spaces.dangerZone.deleteTitle' | transloco }}</div>
                  <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">{{ 'spaces.dangerZone.deleteDescription' | transloco }}</p>
                  @if (dangerDeleteError()) { <div class="alert alert-error" style="margin-bottom:8px;">{{ dangerDeleteError() }}</div> }
                  <button class="btn btn-danger" type="button" (click)="confirmDangerDelete()" [disabled]="dangerDeleting()">
                    @if (dangerDeleting()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.dangerZone.deleteButton' | transloco }}
                  </button>
                </div>
              }
            }
          </div><!-- sp-body -->

          @if (settingsTab() !== 'danger') {
            <div class="sp-footer">
              @if (settingsError()) {
                <div class="alert alert-error" style="flex:1;margin:0;padding:6px 12px;font-size:13px;">{{ settingsError() }}</div>
              }
              <button class="btn btn-primary" type="button" (click)="saveSettings()" [disabled]="settingsSaving()">
                @if (settingsSaving()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.popup.footer.saveChanges' | transloco }}
              </button>
            </div>
          }
        </div><!-- sp-panel -->
      </div><!-- sp-backdrop -->
    }

    <!-- Import conflict dialog -->
    @if (importConflict(); as conflict) {
      <div style="position:fixed;inset:0;background:var(--bg-scrim);display:flex;align-items:center;justify-content:center;z-index:320;" (click)="dismissImportConflict()">
        <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:440px;max-width:96vw;" (click)="$event.stopPropagation()">
          <div style="font-weight:700;font-size:15px;margin-bottom:8px;">Type already exists</div>
          <p style="font-size:13px;color:var(--text-secondary);margin-bottom:20px;">A type named <strong style="font-family:var(--font-mono);">{{ conflict.name }}</strong> already exists in <strong>{{ conflict.kt }}</strong>. What would you like to do?</p>
          <div style="display:flex;flex-direction:column;gap:10px;">
            <button class="btn btn-secondary" type="button" (click)="resolveImportConflictOverride()">Override existing</button>
            @if (importConflict()!.allowAddAs) {
              <div style="display:flex;gap:8px;align-items:center;">
                <input type="text" [ngModel]="importConflictAddAsName()" (ngModelChange)="importConflictAddAsName.set($event)"
                  placeholder="New type name" style="flex:1;" (keydown.enter)="$event.preventDefault();resolveImportConflictAddAs()" />
                <button class="btn btn-primary btn-sm" type="button" (click)="resolveImportConflictAddAs()" [disabled]="!importConflictAddAsName().trim()">Add as</button>
              </div>
            }
            <button class="btn btn-ghost" type="button" (click)="dismissImportConflict()">Cancel</button>
          </div>
        </div>
      </div>
    }

    <!-- Library picker dialog -->
    @if (showLibPickerDialog()) {
      <div style="position:fixed;inset:0;background:var(--bg-scrim);display:flex;align-items:center;justify-content:center;z-index:310;" (click)="closeLibPicker()">
        <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:560px;max-width:96vw;max-height:80vh;overflow-y:auto;" (click)="$event.stopPropagation()">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
            <strong>{{ 'spaces.schema.libPicker.title' | transloco }}</strong>
            <button class="icon-btn" type="button" (click)="closeLibPicker()">✕</button>
          </div>
          @if (libPickerLoading()) {
            <div class="empty-state"><span class="spinner"></span></div>
          } @else if (!libPickerEntries().length) {
            <p style="font-size:13px;color:var(--text-muted);">{{ 'spaces.schema.libPicker.empty' | transloco }}</p>
          } @else {
            <div style="display:grid;gap:8px;">
              @for (entry of libPickerEntries(); track entry.name) {
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-surface);">
                  <div>
                    <div style="font-weight:600;font-size:13px;font-family:var(--font-mono);">{{ entry.name }}</div>
                    <div style="font-size:11px;color:var(--text-muted);">{{ entry.knowledgeType }} · {{ entry.typeName }}</div>
                    @if (entry.description) { <div style="font-size:11px;color:var(--text-secondary);">{{ entry.description }}</div> }
                  </div>
                  <div style="display:flex;gap:6px;flex-shrink:0;">
                    <button class="btn btn-secondary btn-sm" type="button" (click)="importFromLibraryRef(entry)">{{ 'spaces.schema.libPicker.importRef' | transloco }}</button>
                  </div>
                </div>
              }
            </div>
          }
        </div>
      </div>
    }

    <!-- SPACES TABLE -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">{{ 'spaces.table.title' | transloco }}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <input type="search" [value]="spaceSearch()" (input)="spaceSearch.set($any($event.target).value)"
            class="space-search-input"
            [placeholder]="'spaces.table.search.placeholder' | transloco" />
          <div class="sort-group" [attr.aria-label]="'spaces.table.sortLabel' | transloco">
            <button class="sort-btn" [class.active]="sortMode()==='custom'" (click)="sortMode.set('custom')" [attr.title]="'spaces.table.sort.custom' | transloco">⠿</button>
            <button class="sort-btn" [class.active]="sortMode()==='az'" (click)="sortMode.set('az')" [attr.title]="'spaces.table.sort.az' | transloco">A→Z</button>
            <button class="sort-btn" [class.active]="sortMode()==='za'" (click)="sortMode.set('za')" [attr.title]="'spaces.table.sort.za' | transloco">Z→A</button>
            <button class="sort-btn" [class.active]="sortMode()==='usage-desc'" (click)="sortMode.set('usage-desc')" [attr.title]="'spaces.table.sort.usageDesc' | transloco">↓ GiB</button>
            <button class="sort-btn" [class.active]="sortMode()==='usage-asc'" (click)="sortMode.set('usage-asc')" [attr.title]="'spaces.table.sort.usageAsc' | transloco">↑ GiB</button>
          </div>
          <button class="btn-primary btn btn-sm" (click)="showCreateDialog.set(true)">{{ 'spaces.table.createButton' | transloco }}</button>
          <button class="btn-secondary btn btn-sm" (click)="load()">{{ 'spaces.table.refreshButton' | transloco }}</button>
        </div>
      </div>
      @if (loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else {
        <div class="table-wrapper">
          <table>
            <thead>
              <tr><th style="width:32px;"></th><th>{{ 'spaces.table.column.label' | transloco }}</th><th>{{ 'spaces.table.column.id' | transloco }}</th><th>{{ 'spaces.table.column.storage' | transloco }}</th><th>{{ 'spaces.table.column.networks' | transloco }}</th><th>{{ 'spaces.table.column.proxy' | transloco }}</th><th></th></tr>
            </thead>
            <tbody cdkDropList (cdkDropListDropped)="onSpaceDrop($event)">
              @for (s of sortedSpaces(); track s.id) {
                @let bar = storageInfo(s);
                <tr cdkDrag cdkDragLockAxis="y" [cdkDragDisabled]="sortMode() !== 'custom'">
                  <td><span class="drag-handle" cdkDragHandle [class.drag-handle-disabled]="sortMode() !== 'custom'" [attr.title]="'spaces.table.dragHandleTitle' | transloco">⠿</span></td>
                  <td style="font-weight:500;">{{ s.label }}</td>
                  <td><span class="badge badge-gray mono">{{ s.id }}</span></td>
                  <td style="min-width:140px;">
                    @if (bar.label !== '—') {
                      <div class="st-bar"><div [class]="'st-bar-fill '+bar.cls" [style.width.%]="bar.pct"></div></div>
                      <div style="font-size:11px;color:var(--text-muted);margin-top:2px;white-space:nowrap;">{{ bar.label }}</div>
                    } @else {
                      <span style="color:var(--text-muted)">—</span>
                    }
                  </td>
                  <td>
                    @if (networksForSpace(s.id).length) {
                      @for (n of networksForSpace(s.id); track n.id) {
                        <span class="badge badge-gray" style="margin-right:4px;">{{ n.label }}</span>
                      }
                    } @else { <span style="color:var(--text-muted)">—</span> }
                  </td>
                  <td>
                    @if (s.proxyFor?.[0]==='*') {
                      <span class="badge badge-blue" style="font-style:italic;">{{ 'spaces.badge.allSpaces' | transloco }}</span>
                    } @else if (s.proxyFor?.length) {
                      @for (pid of s.proxyFor; track pid) {
                        <span class="badge badge-blue" style="margin-right:4px;font-size:11px;">{{ pid }}</span>
                      }
                    } @else { <span style="color:var(--text-muted)">—</span> }
                  </td>
                  <td><button class="icon-btn" [attr.title]="'spaces.table.configureTitle' | transloco" (click)="openSettings(s)">⚙</button></td>
                </tr>
              } @empty {
                <tr><td colspan="7"><div class="empty-state" style="padding:24px;"><h3>{{ 'spaces.table.empty' | transloco }}</h3></div></td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class SpacesComponent implements OnInit {
  private api = inject(ApiService);
  private transloco = inject(TranslocoService);

  readonly KINDS: KnowledgeType[] = ['entity', 'memory', 'edge', 'chrono'];
  readonly KIND_LABELS: Record<KnowledgeType, string> = {
    entity: 'Entities', memory: 'Memories', edge: 'Edges', chrono: 'Chrono',
  };

  spaces   = signal<Space[]>([]);
  networks = signal<Network[]>([]);
  loading  = signal(true);

  spaceSearch = signal('');
  sortMode = signal<'custom' | 'az' | 'za' | 'usage-desc' | 'usage-asc'>('custom');
  sortedSpaces = computed(() => {
    const list = this.spaces();
    const sorted = (() => {
      switch (this.sortMode()) {
        case 'az':         return [...list].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
        case 'za':         return [...list].sort((a, b) => b.label.localeCompare(a.label, undefined, { sensitivity: 'base' }));
        case 'usage-desc': return [...list].sort((a, b) => (b.usageGiB ?? 0) - (a.usageGiB ?? 0));
        case 'usage-asc':  return [...list].sort((a, b) => (a.usageGiB ?? 0) - (b.usageGiB ?? 0));
        default:           return list;
      }
    })();
    const q = this.spaceSearch().trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(s =>
      s.label.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      (s.description ?? '').toLowerCase().includes(q),
    );
  });

  // create dialog
  creating         = signal(false);
  createError      = signal('');
  showCreateDialog = signal(false);
  proxyForSelected: string[] = [];
  proxyForAll = false;

  static readonly DEFAULT_PURPOSE = [
    'MCP endpoint for this space. Available tools:',
    '',
    'Knowledge Graph — Memory:',
    '  remember(fact, entities?, tags?)              — store a fact with semantic embedding',
    '  recall(query, topK?)                          — semantic search in this space',
    '  recall_global(query, topK?)                   — semantic search across all spaces',
    '  find_similar(id, collection?, topK?)          — find semantically similar items',
    '  update_memory(id, fact?, tags?, entityIds?)   — update memory (re-embeds on fact change)',
    '  delete_memory(id)                             — delete memory',
    '  query(collection, filter, projection?, limit?) — structured MongoDB query',
    '  bulk_write(ops)                               — batch create/update/delete',
    '',
    'Knowledge Graph — Entities & Edges:',
    '  upsert_entity(name, type, tags?, properties?) — create/update named entity',
    '  update_entity(id, ...)                        — update entity fields',
    '  merge_entities(sourceId, targetId)            — merge two entities',
    '  find_entities_by_name(name)                   — find entities by name',
    '  upsert_edge(from, to, label, type?, weight?)  — create/update relationship edge',
    '  update_edge(id, ...)                          — update edge fields',
    '  traverse(entityId, depth?, direction?)        — traverse the knowledge graph',
    '',
    'Knowledge Graph — Chrono:',
    '  create_chrono(title, kind, startsAt, ...)     — create event/deadline/plan/milestone',
    '  update_chrono(id, ...)                        — update chronological entry',
    '  list_chrono(status?, kind?, limit?)           — list chrono entries',
    '',
    'Files:',
    '  read_file(path)             — read file contents',
    '  write_file(path, content)   — write file contents',
    '  list_dir(path?)             — list directory contents',
    '  delete_file(path)           — delete a file',
    '  create_dir(path)            — create directory tree',
    '  move_file(src, dst)         — move or rename file/directory',
    '',
    'Stats, Meta & Sync:',
    '  get_stats()                 — counts of memories, entities, edges, chrono',
    '  get_space_meta()            — schema, purpose, validation mode, entry counts',
    '  list_peers()                — list connected peer instances',
    '  sync_now(peerId?)           — trigger immediate sync cycle',
  ].join('\n');

  form = {
    label: '', id: '', maxGiB: null as number | null,
    purpose: SpacesComponent.DEFAULT_PURPOSE,
    validationMode: 'off' as ValidationMode,
    strictLinkage: false,
  };

  // settings popup
  settingsSpace  = signal<Space | null>(null);
  settingsTab    = signal<'settings' | 'schema' | 'danger'>('settings');
  settingsSaving = signal(false);
  settingsError  = signal('');
  schemaCollTab  = signal<KnowledgeType>('entity');

  stForm = { label: '', purpose: '', usageNotes: '', maxGiB: null as number | null };

  schValidation:     ValidationMode = 'off';
  schStrictLinkage   = false;
  schTagSuggestions: string[] = [];
  schNewTagInput     = '';
  schTypeSchemas:    Partial<Record<KnowledgeType, Record<string, TypeSchemaState>>> = {
    entity: {}, memory: {}, edge: {}, chrono: {},
  };
  schNewTypeInputs:  Record<string, string> = { entity: '', memory: '', edge: '', chrono: '' };
  schExpandedType:   { kt: KnowledgeType; name: string } | null = null;
  schExpandedProp:   { kt: KnowledgeType; typeName: string; propKey: string } | null = null;
  schImportError     = '';
  /** Pending import conflict: holds the parsed state waiting for user resolution. */
  importConflict = signal<{ kt: KnowledgeType; name: string; state: TypeSchemaState; allowAddAs: boolean } | null>(null);
  importConflictAddAsName = signal('');

  @ViewChild('schImportInput') schImportInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('schTypeImportInput') schTypeImportInputRef?: ElementRef<HTMLInputElement>;

  /** Tracks the kt/typeName target for per-type import. */
  private _typeImportTarget: { kt: KnowledgeType; name: string } | null = null;

  // danger zone
  dangerRenameId    = '';
  dangerRenaming    = signal(false);
  dangerRenameError = signal('');
  dangerWipeStats   = signal<SpaceStats | null>(null);
  dangerWipeLoading = signal(false);
  dangerWiping      = signal(false);
  dangerWipeError   = signal('');
  dangerDeleting    = signal(false);
  dangerDeleteError = signal('');

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.api.listSpaces().subscribe({
      next: ({ spaces }) => { this.spaces.set(spaces); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
    this.api.listNetworks().subscribe({
      next: ({ networks }) => this.networks.set(networks),
      error: () => {},
    });
  }

  onSpaceDrop(event: CdkDragDrop<Space[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    const list = [...this.spaces()];
    moveItemInArray(list, event.previousIndex, event.currentIndex);
    this.spaces.set(list);
    this.api.reorderSpaces(list.map(s => s.id)).subscribe({
      next: ({ spaces }) => { this.spaces.set(spaces); },
      error: () => this.load(),
    });
  }

  networksForSpace(spaceId: string): Network[] {
    return this.networks().filter(n => n.spaces.includes(spaceId));
  }

  storageInfo(s: Space): { pct: number; label: string; cls: string } {
    const used = s.usageGiB ?? 0;
    const max  = s.maxGiB;
    if (!max && !used) return { pct: 0, label: '—', cls: 'ok' };
    if (!max)          return { pct: 0, label: this.fmtGiB(used), cls: 'ok' };
    const pct = Math.min(100, Math.round(used / max * 100));
    return { pct, label: `${this.fmtGiB(used)} / ${max} GiB`, cls: pct > 90 ? 'danger' : pct > 70 ? 'warn' : 'ok' };
  }

  fmtGiB(gib: number): string {
    if (gib < 0.001) return `${Math.round(gib * 1024)} MB`;
    return `${gib.toFixed(2)} GiB`;
  }

  isProxyForSelected(id: string): boolean { return this.proxyForSelected.includes(id); }

  toggleProxyFor(id: string): void {
    if (this.proxyForAll) return;
    this.proxyForSelected = this.proxyForSelected.includes(id)
      ? this.proxyForSelected.filter(s => s !== id)
      : [...this.proxyForSelected, id];
  }

  toggleProxyForAll(): void {
    this.proxyForAll = !this.proxyForAll;
    if (this.proxyForAll) this.proxyForSelected = [];
  }

  createSpace(): void {
    if (!this.form.label.trim()) return;
    this.creating.set(true);
    this.createError.set('');
    const body: Parameters<ApiService['createSpace']>[0] = { label: this.form.label.trim() };
    if (this.form.id.trim()) body.id = this.form.id.trim();
    if (this.form.maxGiB) body.maxGiB = this.form.maxGiB;
    if (this.proxyForAll) body.proxyFor = ['*'];
    else if (this.proxyForSelected.length) body.proxyFor = [...this.proxyForSelected];
    const meta: Partial<SpaceMeta> = {};
    if (this.form.purpose.trim()) meta.purpose = this.form.purpose.trim();
    if (this.form.validationMode !== 'off') meta.validationMode = this.form.validationMode;
    if (this.form.strictLinkage) meta.strictLinkage = true;
    if (Object.keys(meta).length) body.meta = meta;
    this.api.createSpace(body).pipe(
      timeout(30_000),
      finalize(() => this.creating.set(false)),
    ).subscribe({
      next: ({ space }) => {
        this.showCreateDialog.set(false);
        this.spaces.update(list => [...list, space]);
        this.form = { label: '', id: '', maxGiB: null, purpose: SpacesComponent.DEFAULT_PURPOSE, validationMode: 'off', strictLinkage: false };
        this.proxyForSelected = [];
        this.proxyForAll = false;
      },
      error: (err) => {
        const msg = err instanceof TimeoutError
          ? this.transloco.translate('spaces.error.createTimeout')
          : (err.error?.error ?? this.transloco.translate('spaces.error.createFailed'));
        this.createError.set(msg);
      },
    });
  }

  openSettings(s: Space): void {
    this.settingsSpace.set(s);
    this.settingsTab.set('settings');
    this.schemaCollTab.set('entity');
    this.settingsError.set('');
    this.settingsSaving.set(false);
    this.stForm = { label: s.label, purpose: s.meta?.purpose ?? '', usageNotes: s.meta?.usageNotes ?? '', maxGiB: s.maxGiB ?? null };
    const meta = s.meta ?? {};
    this.schValidation     = meta.validationMode ?? 'off';
    this.schStrictLinkage  = meta.strictLinkage ?? false;
    this.schTagSuggestions = [...(meta.tagSuggestions ?? [])];
    this.schNewTagInput    = '';
    this.schNewTypeInputs  = { entity: '', memory: '', edge: '', chrono: '' };
    this.schExpandedType   = null;
    this.schExpandedProp   = null;
    const loadKt = (kt: KnowledgeType): Record<string, TypeSchemaState> => {
      const map: Record<string, TypeSchemaState> = {};
      for (const [name, ts] of Object.entries(meta.typeSchemas?.[kt] ?? {})) {
        // Preserve $ref as _libRef sentinel so buildMeta() can round-trip it
        if (ts.$ref?.startsWith('library:')) {
          (map[name] as TypeSchemaState & { _libRef?: string }) = {
            namingPattern: '', tagSuggestions: [], propertySchemas: [],
            _newPropInput: '', _newTagInput: '',
            _libRef: ts.$ref.slice('library:'.length),
          };
        } else {
          map[name] = {
            namingPattern:   ts.namingPattern   ?? '',
            tagSuggestions:  [...(ts.tagSuggestions ?? [])],
            propertySchemas: Object.entries(ts.propertySchemas ?? {}).map(([k, ps]) => ({ key: k, s: { ...ps }, _enumInput: '' })),
            _newPropInput: '',
            _newTagInput:  '',
          };
        }
      }
      return map;
    };
    this.schTypeSchemas = {
      entity: loadKt('entity'),
      memory: loadKt('memory'),
      edge:   loadKt('edge'),
      chrono: loadKt('chrono'),
    };
    this.dangerRenameId = s.id;
    this.dangerRenameError.set('');
    this.dangerRenaming.set(false);
    this.dangerDeleteError.set('');
    this.dangerDeleting.set(false);
    this.dangerWipeStats.set(null);
    this.dangerWipeError.set('');
    this.dangerWiping.set(false);
    this.dangerWipeLoading.set(true);
    this.api.getSpaceStats(s.id).subscribe({
      next: (stats) => { this.dangerWipeStats.set(stats); this.dangerWipeLoading.set(false); },
      error: () => this.dangerWipeLoading.set(false),
    });
  }

  closeSettings(): void { this.settingsSpace.set(null); }

  saveSettings(): void {
    const target = this.settingsSpace();
    if (!target) return;
    this.settingsSaving.set(true);
    this.settingsError.set('');
    this.api.updateSpace(target.id, {
      label:  this.stForm.label.trim() || target.label,
      maxGiB: this.stForm.maxGiB,
      meta:   this.buildMeta(),
    }).subscribe({
      next: ({ space }) => {
        this.settingsSaving.set(false);
        this.spaces.update(list => list.map(s => s.id === space.id ? { ...s, ...space } : s));
        this.closeSettings();
      },
      error: (err) => { this.settingsSaving.set(false); this.settingsError.set(err.error?.error ?? this.transloco.translate('spaces.error.saveFailed')); },
    });
  }

  buildMeta(): Partial<SpaceMeta> {
    const meta: Partial<SpaceMeta> = {};
    if (this.stForm.purpose.trim())    meta.purpose    = this.stForm.purpose.trim();
    if (this.stForm.usageNotes.trim()) meta.usageNotes = this.stForm.usageNotes.trim();
    meta.validationMode = this.schValidation;
    if (this.schStrictLinkage)         meta.strictLinkage  = true;
    if (this.schTagSuggestions.length) meta.tagSuggestions = [...this.schTagSuggestions];
    const typeSchemas: Partial<Record<KnowledgeType, Record<string, TypeSchema>>> = {};
    for (const kt of this.KINDS) {
      const ktMap = this.schTypeSchemas[kt] ?? {};
      const names = Object.keys(ktMap);
      if (names.length) {
        const out: Record<string, TypeSchema> = {};
        for (const name of names) {
          const state = ktMap[name] as TypeSchemaState & { _libRef?: string };
          // If this type was set via "import as $ref", emit a $ref TypeSchema
          if (state._libRef) {
            out[name] = { $ref: `library:${state._libRef}` };
            continue;
          }
          const ts: TypeSchema = {};
          if (kt === 'entity' && state.namingPattern.trim()) ts.namingPattern = state.namingPattern.trim();
          if (state.tagSuggestions.length) ts.tagSuggestions = [...state.tagSuggestions];
          if (state.propertySchemas.length) {
            const ps: Record<string, PropertySchema> = {};
            for (const { key, s } of state.propertySchemas) {
              const schema: PropertySchema = {};
              if (s.type)            schema.type    = s.type;
              if (s.enum?.length)    schema.enum    = [...s.enum];
              if (s.minimum != null) schema.minimum = s.minimum;
              if (s.maximum != null) schema.maximum = s.maximum;
              if (s.pattern?.trim()) schema.pattern = s.pattern.trim();
              if (s.mergeFn)         schema.mergeFn = s.mergeFn;
              if (s.required)        schema.required = s.required;
              if (s.default != null) schema.default  = s.default;
              ps[key] = schema;
            }
            ts.propertySchemas = ps;
          }
          out[name] = ts;
        }
        typeSchemas[kt] = out;
      }
    }
    if (Object.keys(typeSchemas).length) meta.typeSchemas = typeSchemas;
    return meta;
  }

  // ── Schema export / import ─────────────────────────────────────────────────

  exportSchema(): void {
    const space = this.settingsSpace();
    if (!space) return;
    const meta = this.buildMeta();
    const payload = {
      spaceId:     space.id,
      spaceLabel:  space.label,
      exportedAt:  new Date().toISOString(),
      typeSchemas: meta.typeSchemas ?? {},
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${space.id}_schemas.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  triggerImportSchema(): void {
    this.schImportError = '';
    this.schImportInputRef?.nativeElement.click();
  }

  onImportSchemaFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string);
        // Accept either { typeSchemas: {...} } wrapper or bare typeSchemas object
        const ts: unknown = raw?.typeSchemas ?? raw;
        if (!ts || typeof ts !== 'object' || Array.isArray(ts)) {
          this.schImportError = this.transloco.translate('spaces.schema.import.invalidFile');
          return;
        }
        const KINDS: KnowledgeType[] = ['entity', 'edge', 'memory', 'chrono'];
        const merged = { ...this.schTypeSchemas };
        for (const kt of KINDS) {
          const ktRaw = (ts as Record<string, unknown>)[kt];
          if (!ktRaw || typeof ktRaw !== 'object' || Array.isArray(ktRaw)) continue;
          const ktMap = ktRaw as Record<string, unknown>;
          const existing = { ...(merged[kt] ?? {}) };
          for (const [typeName, tsRaw] of Object.entries(ktMap)) {
            const ts2 = tsRaw as Record<string, unknown>;
            existing[typeName] = {
              namingPattern:   typeof ts2['namingPattern'] === 'string' ? ts2['namingPattern'] : '',
              tagSuggestions:  Array.isArray(ts2['tagSuggestions']) ? [...ts2['tagSuggestions'] as string[]] : [],
              propertySchemas: (() => {
                const ps = ts2['propertySchemas'];
                if (!ps || typeof ps !== 'object' || Array.isArray(ps)) return [];
                return Object.entries(ps as Record<string, unknown>).map(([k, v]) => ({
                  key: k,
                  s:   { ...(v as PropertySchema) },
                  _enumInput: '',
                }));
              })(),
              _newPropInput: '',
              _newTagInput:  '',
            };
          }
          merged[kt] = existing;
        }
        this.schTypeSchemas = merged;
        this.schImportError = '';
      } catch {
        this.schImportError = this.transloco.translate('spaces.schema.import.parseFailed');
      } finally {
        // Reset the input so the same file can be re-imported if needed
        if (this.schImportInputRef) this.schImportInputRef.nativeElement.value = '';
      }
    };
    reader.readAsText(file);
  }

  // ── Per-type export / import ───────────────────────────────────────────────

  /** Download a single type definition as a JSON snippet. */
  exportTypeSchema(kt: KnowledgeType, name: string): void {
    const space = this.settingsSpace();
    if (!space) return;
    const state = this.typeState(kt, name);
    const schema: TypeSchema = {};
    const trimmedPattern = state.namingPattern.trim();
    if (kt === 'entity' && trimmedPattern) schema.namingPattern = trimmedPattern;
    if (state.tagSuggestions.length) schema.tagSuggestions = [...state.tagSuggestions];
    if (state.propertySchemas.length) {
      const ps: Record<string, PropertySchema> = {};
      for (const { key, s } of state.propertySchemas) {
        const entry: PropertySchema = {};
        if (s.type)            entry.type    = s.type;
        if (s.enum?.length)    entry.enum    = [...s.enum];
        if (s.minimum != null) entry.minimum = s.minimum;
        if (s.maximum != null) entry.maximum = s.maximum;
        const trimmedProp = s.pattern?.trim();
        if (trimmedProp)       entry.pattern = trimmedProp;
        if (s.mergeFn)         entry.mergeFn = s.mergeFn;
        if (s.required)        entry.required = s.required;
        if (s.default != null) entry.default  = s.default;
        ps[key] = entry;
      }
      schema.propertySchemas = ps;
    }
    const payload = { knowledgeType: kt, typeName: name, schema };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${space.id}_${kt}_${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Open the file picker for per-type schema import (existing type replacement). */
  triggerImportTypeSchema(kt: KnowledgeType, name: string): void {
    this._typeImportTarget = { kt, name };
    this.schImportError = '';
    this.schTypeImportInputRef?.nativeElement.click();
  }

  /** Open the file picker to import a type schema as a new type (name derived from file). */
  triggerImportTypeSchemaNew(kt: KnowledgeType): void {
    this._typeImportTarget = { kt, name: '' };
    this.schImportError = '';
    this.schTypeImportInputRef?.nativeElement.click();
  }

  /** Handle the file chosen for per-type import. */
  onImportTypeSchemaFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || !this._typeImportTarget) return;
    const { kt } = this._typeImportTarget;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string);
        // Accept either a full snippet { knowledgeType, typeName, schema } or a bare TypeSchema object
        const schemaRaw: unknown = raw?.schema ?? raw;
        if (!schemaRaw || typeof schemaRaw !== 'object' || Array.isArray(schemaRaw)) {
          this.schImportError = this.transloco.translate('spaces.schema.import.invalidTypeFile');
          return;
        }
        // Determine target type name: from _typeImportTarget.name (existing), or file's typeName (new)
        const name: string = this._typeImportTarget?.name || (typeof raw?.typeName === 'string' ? raw.typeName.trim() : '');
        if (!name) {
          this.schImportError = this.transloco.translate('spaces.schema.import.invalidTypeFile');
          return;
        }
        const ts2 = schemaRaw as Record<string, unknown>;
        const imported: TypeSchemaState = {
          namingPattern:   typeof ts2['namingPattern'] === 'string' ? ts2['namingPattern'] : '',
          tagSuggestions:  Array.isArray(ts2['tagSuggestions']) ? [...ts2['tagSuggestions'] as string[]] : [],
          propertySchemas: (() => {
            const ps = ts2['propertySchemas'];
            if (!ps || typeof ps !== 'object' || Array.isArray(ps)) return [];
            return Object.entries(ps as Record<string, unknown>).map(([k, v]) => ({
              key: k,
              s:   { ...(v as PropertySchema) },
              _enumInput: '',
            }));
          })(),
          _newPropInput: '',
          _newTagInput:  '',
        };
        // When importing as a new type (name derived from file), check for collision
        if (!this._typeImportTarget?.name && this.typeNames(kt).includes(name)) {
          // Stash parsed state and show conflict dialog instead of erroring
          this.importConflict.set({ kt, name, state: imported, allowAddAs: true });
          this.importConflictAddAsName.set(name + '-2');
          return;
        }
        this.schTypeSchemas = {
          ...this.schTypeSchemas,
          [kt]: { ...(this.schTypeSchemas[kt] ?? {}), [name]: imported },
        };
        this.schImportError = '';
      } catch {
        this.schImportError = this.transloco.translate('spaces.schema.import.parseFailed');
      } finally {
        if (this.schTypeImportInputRef) this.schTypeImportInputRef.nativeElement.value = '';
        this._typeImportTarget = null;
      }
    };
    reader.readAsText(file);
  }

  dismissImportConflict(): void {
    this.importConflict.set(null);
    this.importConflictAddAsName.set('');
  }

  resolveImportConflictOverride(): void {
    const c = this.importConflict();
    if (!c) return;
    this.schTypeSchemas = {
      ...this.schTypeSchemas,
      [c.kt]: { ...(this.schTypeSchemas[c.kt] ?? {}), [c.name]: c.state },
    };
    this.dismissImportConflict();
  }

  resolveImportConflictAddAs(): void {
    const c = this.importConflict();
    const newName = this.importConflictAddAsName().trim();
    if (!c || !newName) return;
    if (this.typeNames(c.kt).includes(newName)) {
      // Still conflicts — update the suggested name signal so the input shakes visually
      this.importConflictAddAsName.set(newName);
      return;
    }
    this.schTypeSchemas = {
      ...this.schTypeSchemas,
      [c.kt]: { ...(this.schTypeSchemas[c.kt] ?? {}), [newName]: c.state },
    };
    this.dismissImportConflict();
  }

  // ── typeSchemas helpers ────────────────────────────────────────────────────
  typeNames(kt: KnowledgeType): string[] { return Object.keys(this.schTypeSchemas[kt] ?? {}); }
  typeState(kt: KnowledgeType, name: string): TypeSchemaState { return (this.schTypeSchemas[kt] ?? {})[name]!; }
  typeCount(kt: KnowledgeType): number { return Object.keys(this.schTypeSchemas[kt] ?? {}).length; }
  /** Returns the library entry name if this type is set as a $ref, otherwise null. */
  typeLibRef(kt: KnowledgeType, name: string): string | null {
    return ((this.schTypeSchemas[kt] ?? {})[name] as TypeSchemaState & { _libRef?: string })?._libRef ?? null;
  }

  isTypeExpanded(kt: KnowledgeType, name: string): boolean {
    return this.schExpandedType?.kt === kt && this.schExpandedType?.name === name;
  }

  toggleTypeExpand(kt: KnowledgeType, name: string): void {
    this.schExpandedType = this.isTypeExpanded(kt, name) ? null : { kt, name };
  }

  addType(kt: KnowledgeType): void {
    const raw = (this.schNewTypeInputs[kt] ?? '').trim();
    if (!raw || (this.schTypeSchemas[kt] ?? {})[raw]) return;
    this.schTypeSchemas = {
      ...this.schTypeSchemas,
      [kt]: { ...(this.schTypeSchemas[kt] ?? {}), [raw]: { namingPattern: '', tagSuggestions: [], propertySchemas: [], _newPropInput: '', _newTagInput: '' } },
    };
    this.schNewTypeInputs = { ...this.schNewTypeInputs, [kt]: '' };
    this.schExpandedType  = { kt, name: raw };
  }

  removeType(kt: KnowledgeType, name: string): void {
    const { [name]: _dropped, ...rest } = this.schTypeSchemas[kt] ?? {};
    this.schTypeSchemas = { ...this.schTypeSchemas, [kt]: rest };
    if (this.schExpandedType?.kt === kt && this.schExpandedType.name === name) this.schExpandedType = null;
  }

  isPropExpanded(kt: KnowledgeType, typeName: string, propKey: string): boolean {
    return this.schExpandedProp?.kt === kt && this.schExpandedProp?.typeName === typeName && this.schExpandedProp?.propKey === propKey;
  }

  togglePropExpand(kt: KnowledgeType, typeName: string, propKey: string): void {
    this.schExpandedProp = this.isPropExpanded(kt, typeName, propKey) ? null : { kt, typeName, propKey };
  }

  addProp(kt: KnowledgeType, typeName: string): void {
    const state = this.typeState(kt, typeName);
    const key = (state._newPropInput ?? '').trim();
    if (!key || state.propertySchemas.some(e => e.key === key)) { state._newPropInput = ''; return; }
    state.propertySchemas = [...state.propertySchemas, { key, s: {}, _enumInput: '' }];
    state._newPropInput   = '';
    this.schExpandedProp  = { kt, typeName, propKey: key };
  }

  removeProp(kt: KnowledgeType, typeName: string, propKey: string): void {
    const state = this.typeState(kt, typeName);
    state.propertySchemas = state.propertySchemas.filter(e => e.key !== propKey);
    if (this.isPropExpanded(kt, typeName, propKey)) this.schExpandedProp = null;
  }

  addTypeTag(kt: KnowledgeType, typeName: string): void {
    const state = this.typeState(kt, typeName);
    const raw = (state._newTagInput ?? '').trim();
    if (!raw || state.tagSuggestions.includes(raw)) { state._newTagInput = ''; return; }
    state.tagSuggestions = [...state.tagSuggestions, raw];
    state._newTagInput   = '';
  }

  addGlobalTag(): void {
    const raw = this.schNewTagInput.trim();
    if (!raw || this.schTagSuggestions.includes(raw)) { this.schNewTagInput = ''; return; }
    this.schTagSuggestions = [...this.schTagSuggestions, raw];
    this.schNewTagInput    = '';
  }

  onEnumKey(e: KeyboardEvent, kt: KnowledgeType, typeName: string, propKey: string): void {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addEnumVal(kt, typeName, propKey); }
  }

  addEnumVal(kt: KnowledgeType, typeName: string, propKey: string): void {
    const entry = this.typeState(kt, typeName).propertySchemas.find(e => e.key === propKey);
    if (!entry) return;
    const val = (entry._enumInput ?? '').trim();
    if (!val) return;
    const curr = entry.s.enum ?? [];
    if (!curr.some(v => String(v) === val)) entry.s = { ...entry.s, enum: [...curr, val] };
    entry._enumInput = '';
  }

  removeEnumVal(kt: KnowledgeType, typeName: string, propKey: string, val: string | number | boolean): void {
    const entry = this.typeState(kt, typeName).propertySchemas.find(e => e.key === propKey);
    if (!entry) return;
    entry.s = { ...entry.s, enum: (entry.s.enum ?? []).filter(v => v !== val) };
  }

  wipeStatCols(): { label: string; value: number }[] {
    const s = this.dangerWipeStats();
    if (!s) return [];
    return [
      { label: this.transloco.translate('spaces.stats.memories'), value: s.memories },
      { label: this.transloco.translate('spaces.stats.entities'), value: s.entities },
      { label: this.transloco.translate('spaces.stats.edges'),    value: s.edges    },
      { label: this.transloco.translate('spaces.stats.chrono'),   value: s.chrono   },
      { label: this.transloco.translate('spaces.stats.files'),    value: s.files    },
    ];
  }

  submitDangerRename(): void {
    const target = this.settingsSpace();
    const newId  = this.dangerRenameId.trim();
    if (!target || !newId || newId === target.id) return;
    if (!confirm(this.transloco.translate('spaces.dangerZone.confirmRename', { label: target.label, id: target.id, newId }))) return;
    this.dangerRenaming.set(true);
    this.dangerRenameError.set('');
    this.api.renameSpace(target.id, newId).subscribe({
      next: ({ space }) => {
        this.dangerRenaming.set(false);
        this.spaces.update(list => list.map(s => s.id === target.id ? space : s));
        this.settingsSpace.set(space);
        this.dangerRenameId = space.id;
        this.api.listNetworks().subscribe({ next: ({ networks }) => this.networks.set(networks), error: () => {} });
      },
      error: (err) => { this.dangerRenaming.set(false); this.dangerRenameError.set(err.error?.error ?? this.transloco.translate('spaces.error.renameFailed')); },
    });
  }

  confirmDangerWipe(): void {
    const target = this.settingsSpace();
    if (!target) return;
    if (!confirm(this.transloco.translate('spaces.dangerZone.confirmWipe', { label: target.label }))) return;
    this.dangerWiping.set(true);
    this.dangerWipeError.set('');
    this.api.wipeSpace(target.id).subscribe({
      next: () => {
        this.dangerWiping.set(false);
        this.dangerWipeStats.set(null);
        this.dangerWipeLoading.set(true);
        this.api.getSpaceStats(target.id).subscribe({
          next: (stats) => { this.dangerWipeStats.set(stats); this.dangerWipeLoading.set(false); },
          error: () => this.dangerWipeLoading.set(false),
        });
      },
      error: (err) => { this.dangerWiping.set(false); this.dangerWipeError.set(err.error?.error ?? this.transloco.translate('spaces.error.wipeFailed')); },
    });
  }

  confirmDangerDelete(): void {
    const target = this.settingsSpace();
    if (!target) return;
    if (!confirm(this.transloco.translate('spaces.dangerZone.confirmDelete', { label: target.label, id: target.id }))) return;
    this.dangerDeleting.set(true);
    this.dangerDeleteError.set('');
    this.api.deleteSpace(target.id).subscribe({
      next: () => {
        this.dangerDeleting.set(false);
        this.spaces.update(list => list.filter(s => s.id !== target.id));
        this.closeSettings();
      },
      error: (err) => { this.dangerDeleting.set(false); this.dangerDeleteError.set(err.error?.error ?? this.transloco.translate('spaces.error.deleteFailed')); },
    });
  }

  leaveNetworkDanger(networkId: string): void {
    if (!confirm(this.transloco.translate('spaces.dangerZone.confirmLeaveNetwork'))) return;
    this.api.leaveNetwork(networkId).subscribe({
      next: () => this.api.listNetworks().subscribe({ next: ({ networks }) => this.networks.set(networks), error: () => {} }),
      error: () => alert(this.transloco.translate('spaces.error.leaveNetworkFailed')),
    });
  }

  // ── Library: save a type to library ───────────────────────────────────────

  saveTypeToLibrary(kt: KnowledgeType, name: string): void {
    const state = this.typeState(kt, name);
    // Auto-derive entry name from the type name (slug)
    const entryName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 200);
    if (!entryName) return;

    const schema: TypeSchema = {};
    if (kt === 'entity' && state.namingPattern.trim()) schema.namingPattern = state.namingPattern.trim();
    if (state.tagSuggestions.length) schema.tagSuggestions = [...state.tagSuggestions];
    if (state.propertySchemas.length) {
      const ps: Record<string, PropertySchema> = {};
      for (const { key, s } of state.propertySchemas) {
        const entry: PropertySchema = {};
        if (s.type)            entry.type    = s.type;
        if (s.enum?.length)    entry.enum    = [...s.enum];
        if (s.minimum != null) entry.minimum = s.minimum;
        if (s.maximum != null) entry.maximum = s.maximum;
        if (s.pattern?.trim()) entry.pattern = s.pattern.trim();
        if (s.mergeFn)         entry.mergeFn = s.mergeFn;
        if (s.required)        entry.required = s.required;
        if (s.default != null) entry.default  = s.default;
        ps[key] = entry;
      }
      schema.propertySchemas = ps;
    }

    const body = { knowledgeType: kt, typeName: name, schema: schema as Omit<TypeSchema, '$ref'> };
    this.api.upsertSchemaLibraryEntry(entryName, body).subscribe({
      next: () => {
        // Convert the in-space type to a $ref pointing at the new library entry
        const refState: TypeSchemaState & { _libRef?: string } = {
          namingPattern:   '',
          tagSuggestions:  [],
          propertySchemas: [],
          _newPropInput:   '',
          _newTagInput:    '',
          _libRef:         entryName,
        };
        this.schTypeSchemas = {
          ...this.schTypeSchemas,
          [kt]: { ...(this.schTypeSchemas[kt] ?? {}), [name]: refState },
        };
      },
      error: (err) => {
        this.schImportError = err?.error?.error ?? this.transloco.translate('spaces.schema.libSave.failed');
      },
    });
  }

  // ── Library: import from library ──────────────────────────────────────────

  showLibPickerDialog = signal(false);
  libPickerLoading    = signal(false);
  libPickerEntries    = signal<SchemaLibraryEntry[]>([]);
  /** kt/typeName context for the open library picker */
  private _libPickerTarget: { kt: KnowledgeType; name: string } | null = null;

  triggerImportFromLibrary(kt: KnowledgeType, name: string): void {
    this._libPickerTarget = { kt, name };
    this.libPickerLoading.set(true);
    this.showLibPickerDialog.set(true);
    this.api.listSchemaLibrary().subscribe({
      next: ({ entries }) => {
        this.libPickerEntries.set(entries.filter(e => e.knowledgeType === kt));
        this.libPickerLoading.set(false);
      },
      error: () => {
        this.libPickerEntries.set([]);
        this.libPickerLoading.set(false);
      },
    });
  }

  triggerImportFromLibraryNew(kt: KnowledgeType): void {
    this._libPickerTarget = { kt, name: '' };
    this.libPickerLoading.set(true);
    this.showLibPickerDialog.set(true);
    this.api.listSchemaLibrary().subscribe({
      next: ({ entries }) => {
        this.libPickerEntries.set(entries.filter(e => e.knowledgeType === kt));
        this.libPickerLoading.set(false);
      },
      error: () => {
        this.libPickerEntries.set([]);
        this.libPickerLoading.set(false);
      },
    });
  }

  closeLibPicker(): void {
    this.showLibPickerDialog.set(false);
    this._libPickerTarget = null;
  }

  /** Import the library entry's schema as an inline TypeSchemaState (merges into current). */
  importFromLibraryInline(entry: SchemaLibraryEntry): void {
    const target = this._libPickerTarget;
    if (!target) return;
    const typeName = target.name || entry.typeName;
    if (!typeName) return;
    const s = entry.schema;
    const imported: TypeSchemaState = {
      namingPattern:   s.namingPattern ?? '',
      tagSuggestions:  [...(s.tagSuggestions ?? [])],
      propertySchemas: Object.entries(s.propertySchemas ?? {}).map(([k, v]) => ({
        key: k, s: { ...v }, _enumInput: '',
      })),
      _newPropInput: '',
      _newTagInput:  '',
    };
    this.schTypeSchemas = {
      ...this.schTypeSchemas,
      [target.kt]: { ...(this.schTypeSchemas[target.kt] ?? {}), [typeName]: imported },
    };
    this.closeLibPicker();
  }

  /** Set the space's type to use a $ref pointing at this library entry. */
  importFromLibraryRef(entry: SchemaLibraryEntry): void {
    const target = this._libPickerTarget;
    if (!target) return;
    const typeName = target.name || entry.typeName;
    if (!typeName) return;
    // Store as a special sentinel state that renders as a $ref in buildMeta()
    const refState: TypeSchemaState & { _libRef?: string } = {
      namingPattern:   '',
      tagSuggestions:  [],
      propertySchemas: [],
      _newPropInput:   '',
      _newTagInput:    '',
      _libRef:         entry.name,
    };
    // When adding a new type from lib (no pre-existing name), check for collision
    if (!target.name && this.typeNames(target.kt).includes(typeName)) {
      this.closeLibPicker();
      this.importConflict.set({ kt: target.kt, name: typeName, state: refState, allowAddAs: false });
      return;
    }
    this.schTypeSchemas = {
      ...this.schTypeSchemas,
      [target.kt]: { ...(this.schTypeSchemas[target.kt] ?? {}), [typeName]: refState },
    };
    this.closeLibPicker();
  }
}
