import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  ApiService, Network, Space, SpaceMeta, SpaceStats,
  KnowledgeType, PropertySchema, ValidationMode,
} from '../../core/api.service';

@Component({
  selector: 'app-spaces',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
    .st-bar-fill.ok     { background:var(--success,#22c55e); }
    .st-bar-fill.warn   { background:var(--warning,#f59e0b); }
    .st-bar-fill.danger { background:var(--danger); }
    /* create dialog */
    .dialog-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; z-index:100; }
    .dialog { background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-lg); padding:24px; width:90%; max-width:960px; max-height:90vh; overflow-y:auto; }
    .dialog-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
    /* settings popup */
    .sp-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:200; display:flex; align-items:center; justify-content:center; }
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
    /* ── schema: collection inner tabs ── */
    .sch-coll-tabs { display:flex; border-bottom:2px solid var(--border); margin-bottom:0; overflow-x:auto; gap:0; flex-shrink:0; }
    .sch-coll-tab { background:none; border:none; border-bottom:2px solid transparent; margin-bottom:-2px; padding:9px 18px; cursor:pointer; font-size:12px; font-family:var(--font); color:var(--text-muted); display:inline-flex; align-items:center; gap:6px; transition:color .15s; white-space:nowrap; }
    .sch-coll-tab:hover { color:var(--text-primary); }
    .sch-coll-tab.active { color:var(--text-primary); border-bottom-color:var(--accent); font-weight:600; }
    .sch-cnt-badge { background:color-mix(in srgb,var(--accent) 15%,transparent); color:var(--accent); font-size:10px; font-weight:700; border-radius:10px; padding:1px 6px; min-width:18px; text-align:center; }
    .sch-coll-body { padding:18px 0 0; }
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
    .req-toggle.is-req { color:var(--warning,#f59e0b); border-color:color-mix(in srgb,var(--warning,#f59e0b) 50%,transparent); background:color-mix(in srgb,var(--warning,#f59e0b) 8%,transparent); font-weight:600; }
  `],
  template: `
    <!-- CREATE DIALOG -->
    @if (showCreateDialog()) {
      <div class="dialog-backdrop" (click)="showCreateDialog.set(false)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <div class="card-title">Create space</div>
            <button class="icon-btn" (click)="showCreateDialog.set(false)">✕</button>
          </div>
          @if (createError()) { <div class="alert alert-error">{{ createError() }}</div> }
          <form (ngSubmit)="createSpace()" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
            <div class="field" style="flex:1;min-width:140px;margin-bottom:0;">
              <label>Display Name</label>
              <input type="text" [(ngModel)]="form.label" name="label" placeholder="My Space" maxlength="200" required />
            </div>
            <div class="field" style="width:140px;margin-bottom:0;">
              <label>ID (optional)</label>
              <input type="text" [(ngModel)]="form.id" name="id" placeholder="my-space" pattern="[a-z0-9-]+" />
            </div>
            <div class="field" style="width:120px;margin-bottom:0;">
              <label>Max GiB</label>
              <input type="number" [(ngModel)]="form.maxGiB" name="maxGiB" min="0" step="0.1" placeholder="—" />
            </div>
            <div style="display:flex;gap:12px;flex-basis:100%;">
              <div class="field" style="flex:1;margin-bottom:0;">
                <label>Purpose</label>
                <textarea [(ngModel)]="form.purpose" name="purpose" maxlength="4000" rows="5" style="resize:vertical;" placeholder="Describe what this space is for…"></textarea>
              </div>
              <div class="field" style="flex:1;margin-bottom:0;">
                <label>Proxy for (optional)</label>
                @if (spaces().length > 0) {
                  <div class="table-wrapper" style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm);">
                    <table style="margin:0;">
                      <thead><tr><th style="width:40px;"></th><th>Space</th><th>ID</th></tr></thead>
                      <tbody>
                        <tr style="cursor:pointer;background:var(--bg-elevated);" (click)="toggleProxyForAll()">
                          <td style="text-align:center;"><input type="checkbox" [checked]="proxyForAll" (click)="$event.stopPropagation()" (change)="toggleProxyForAll()" /></td>
                          <td colspan="2" style="font-style:italic;color:var(--text-muted);">All (including spaces added later)</td>
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
                  <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">No existing spaces.</div>
                }
              </div>
            </div>
            <div style="display:flex;gap:12px;flex-basis:100%;align-items:flex-start;">
              <div class="field" style="margin-bottom:0;">
                <label>Validation mode</label>
                <select [(ngModel)]="form.validationMode" name="validationMode" style="width:140px;">
                  <option value="off">Off</option><option value="warn">Warn</option><option value="strict">Strict</option>
                </select>
              </div>
              <div class="field" style="margin-bottom:0;padding-top:22px;">
                <label style="display:flex;align-items:center;gap:8px;font-weight:normal;cursor:pointer;">
                  <input type="checkbox" [(ngModel)]="form.strictLinkage" name="strictLinkage" />Strict linkage
                </label>
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-basis:100%;">
              <button class="btn btn-secondary" type="button" (click)="showCreateDialog.set(false)">Cancel</button>
              <button class="btn btn-primary" type="submit" style="margin-left:auto;" [disabled]="creating()||!form.label.trim()">
                @if (creating()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }Create
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
            <button class="sp-tab" [class.active]="settingsTab()==='settings'" (click)="settingsTab.set('settings')">Settings</button>
            <button class="sp-tab" [class.active]="settingsTab()==='schema'"   (click)="settingsTab.set('schema')">Schema</button>
            <button class="sp-tab danger-tab" [class.active]="settingsTab()==='danger'" (click)="settingsTab.set('danger')">Danger Zone</button>
          </div>
          <div class="sp-body">

            <!-- SETTINGS TAB -->
            @if (settingsTab() === 'settings') {
              <div style="max-width:720px;">
                <div class="field">
                  <label>Display Name</label>
                  <input type="text" [(ngModel)]="stForm.label" maxlength="200" />
                </div>
                <div class="field">
                  <label>Purpose <span style="font-size:11px;color:var(--text-muted);font-weight:normal;">— surfaced to MCP clients at the SSE handshake</span></label>
                  <textarea [(ngModel)]="stForm.purpose" rows="6" maxlength="4000" style="resize:vertical;"></textarea>
                </div>
                <div class="field">
                  <label>Usage Notes <span style="font-size:11px;color:var(--text-muted);font-weight:normal;">— additional guidance for LLM clients</span></label>
                  <textarea [(ngModel)]="stForm.usageNotes" rows="3" maxlength="2000" style="resize:vertical;"></textarea>
                </div>
                <div class="field" style="max-width:220px;">
                  <label>Max Storage (GiB)</label>
                  <input type="number" [(ngModel)]="stForm.maxGiB" min="0" step="0.1" placeholder="Unlimited" />
                  <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Leave blank or 0 for no limit</div>
                </div>
                <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;">
                  <div class="field" style="margin:0;">
                    <label>Validation mode</label>
                    <select [(ngModel)]="schValidation" style="width:220px;">
                      <option value="off">Off — unrestricted writes</option>
                      <option value="warn">Warn — log violations only</option>
                      <option value="strict">Strict — reject violations</option>
                    </select>
                  </div>
                  <div class="field" style="margin:0;padding-top:22px;">
                    <label style="display:flex;align-items:center;gap:8px;font-weight:normal;cursor:pointer;">
                      <input type="checkbox" [(ngModel)]="schStrictLinkage" />
                      Strict linkage
                      <span style="font-size:11px;color:var(--text-muted);font-weight:normal;">— enforce UUID refs; block entity deletion while linked</span>
                    </label>
                  </div>
                </div>
              </div>
            }

            <!-- SCHEMA TAB -->
            @if (settingsTab() === 'schema') {
              <!-- collection tabs -->
              <div class="sch-coll-tabs">
                <button class="sch-coll-tab" [class.active]="schemaCollTab()==='memory'" (click)="schemaCollTab.set('memory')">
                  Memories @if (schPropSchemas['memory'].length) { <span class="sch-cnt-badge">{{ schPropSchemas['memory'].length }}</span> }
                </button>
                <button class="sch-coll-tab" [class.active]="schemaCollTab()==='entity'" (click)="schemaCollTab.set('entity')">
                  Entities @if (schPropSchemas['entity'].length) { <span class="sch-cnt-badge">{{ schPropSchemas['entity'].length }}</span> }
                </button>
                <button class="sch-coll-tab" [class.active]="schemaCollTab()==='edge'" (click)="schemaCollTab.set('edge')">
                  Edges @if (schPropSchemas['edge'].length) { <span class="sch-cnt-badge">{{ schPropSchemas['edge'].length }}</span> }
                </button>
                <button class="sch-coll-tab" [class.active]="schemaCollTab()==='chrono'" (click)="schemaCollTab.set('chrono')">
                  Chrono @if (schPropSchemas['chrono'].length) { <span class="sch-cnt-badge">{{ schPropSchemas['chrono'].length }}</span> }
                </button>
                <button class="sch-coll-tab" [class.active]="schemaCollTab()==='vocab'" (click)="schemaCollTab.set('vocab')">Vocabulary</button>
              </div>
              <div class="sch-coll-body">

                <!-- ── VOCABULARY ── -->
                @if (schemaCollTab() === 'vocab') {
                  <div class="sch-section">
                    <div class="sch-section-title">Entity Types</div>
                    <div class="chip-wrap">
                      @for (t of schEntityTypes; track t) {
                        <span class="chip">{{ t }}<button type="button" class="chip-rm" (click)="removeEntityType(t)">×</button></span>
                      }
                      <input type="text" class="chip-field" [(ngModel)]="chipInputs['entityType']"
                        [placeholder]="schEntityTypes.length ? '' : 'Add type + Enter'"
                        (keydown)="onChipKey($event,'entityTypes','entityType')" />
                    </div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Allowed entity types. Empty = any type accepted.</div>
                  </div>
                  @if (schEntityTypes.length > 0) {
                    <div class="sch-section">
                      <div class="sch-section-title">Naming Patterns <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;">(regex per entity type)</span></div>
                      <div style="display:grid;gap:8px;">
                        @for (et of schEntityTypes; track et) {
                          <div style="display:flex;align-items:center;gap:10px;">
                            <span style="font-family:var(--font-mono);font-size:12px;color:var(--accent);min-width:140px;flex-shrink:0;">{{ et }}</span>
                            <input type="text" [ngModel]="schNamingPatterns[et]"
                              (ngModelChange)="updateNamingPattern(et,$event)"
                              placeholder="^[A-Z].* (optional regex)" style="flex:1;" />
                          </div>
                        }
                      </div>
                    </div>
                  }
                  <div class="sch-section">
                    <div class="sch-section-title">Edge Labels</div>
                    <div class="chip-wrap">
                      @for (t of schEdgeLabels; track t) {
                        <span class="chip">{{ t }}<button type="button" class="chip-rm" (click)="schEdgeLabels=schEdgeLabels.filter(x=>x!==t)">×</button></span>
                      }
                      <input type="text" class="chip-field" [(ngModel)]="chipInputs['edgeLabel']"
                        [placeholder]="schEdgeLabels.length ? '' : 'Add label + Enter'"
                        (keydown)="onChipKey($event,'edgeLabels','edgeLabel')" />
                    </div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Allowed relationship labels. Empty = any label accepted.</div>
                  </div>
                  <div class="sch-section">
                    <div class="sch-section-title">Tag Suggestions</div>
                    <div class="chip-wrap">
                      @for (t of schTagSuggestions; track t) {
                        <span class="chip">{{ t }}<button type="button" class="chip-rm" (click)="schTagSuggestions=schTagSuggestions.filter(x=>x!==t)">×</button></span>
                      }
                      <input type="text" class="chip-field" [(ngModel)]="chipInputs['tag']"
                        [placeholder]="schTagSuggestions.length ? '' : 'Add tag + Enter'"
                        (keydown)="onChipKey($event,'tags','tag')" />
                    </div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Hints surfaced to clients. Any tag is still accepted.</div>
                  </div>
                }

                <!-- ── COLLECTION TABS (memory / entity / edge / chrono) ── -->
                @for (kt of KINDS; track kt) {
                  @if (schemaCollTab() === kt) {
                    <!-- required fields strip -->
                    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--border);">
                      <span style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);white-space:nowrap;">Required</span>
                      <div class="chip-wrap" style="flex:1;min-height:30px;">
                        @for (p of schRequiredProps[kt]; track p) {
                          <span class="chip">{{ p }}<button type="button" class="chip-rm" (click)="removeRequiredProp(kt,p)">×</button></span>
                        }
                        <input type="text" class="chip-field"
                          [(ngModel)]="chipInputs['req'+kt]"
                          [placeholder]="schRequiredProps[kt].length ? '' : 'field name + Enter'"
                          (keydown)="onChipKey($event,'req_'+kt,'req'+kt)" />
                      </div>
                    </div>
                    <!-- property schemas -->
                    <table class="prop-table" style="margin-bottom:0;">
                      <thead>
                        <tr>
                          <th style="width:190px;">Property</th>
                          <th style="width:80px;">Type</th>
                          <th>Constraints</th>
                          <th style="width:68px;"></th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (p of schPropSchemas[kt]; track p.key) {
                          <tr class="prop-row" [class.prow-open]="isPropExpanded(kt,p.key)"
                            (click)="togglePropExpand(kt,p.key)">
                            <td>
                              <div style="display:flex;align-items:center;gap:7px;">
                                <span style="font-family:var(--font-mono);font-size:12px;">{{ p.key }}</span>
                                @if (isRequired(kt,p.key)) {
                                  <span style="font-size:10px;background:color-mix(in srgb,var(--warning,#f59e0b) 16%,transparent);color:var(--warning,#f59e0b);border-radius:3px;padding:1px 5px;font-weight:700;">req</span>
                                }
                              </div>
                            </td>
                            <td><span class="badge badge-gray" style="font-size:11px;">{{ p.s.type ?? 'any' }}</span></td>
                            <td style="font-size:11px;color:var(--text-muted);">
                              @if (p.s.enum?.length) { <span class="badge badge-gray" style="font-size:10px;margin-right:3px;">enum {{ p.s.enum!.length }}</span> }
                              @if (p.s.minimum!==undefined) { <span style="margin-right:4px;">min:{{ p.s.minimum }}</span> }
                              @if (p.s.maximum!==undefined) { <span style="margin-right:4px;">max:{{ p.s.maximum }}</span> }
                              @if (p.s.pattern) { <span style="margin-right:4px;">pattern</span> }
                              @if (p.s.mergeFn) { <span class="badge badge-blue" style="font-size:10px;">{{ p.s.mergeFn }}</span> }
                            </td>
                            <td (click)="$event.stopPropagation()">
                              <div style="display:flex;gap:4px;justify-content:flex-end;">
                                <button class="btn btn-ghost btn-sm" type="button" (click)="togglePropExpand(kt,p.key)"
                                  style="font-size:10px;padding:2px 8px;min-width:28px;">
                                  {{ isPropExpanded(kt,p.key) ? '▲' : '▼' }}
                                </button>
                                <button class="icon-btn danger" type="button" (click)="removeProp(kt,p.key)" title="Remove">✕</button>
                              </div>
                            </td>
                          </tr>
                          @if (isPropExpanded(kt,p.key)) {
                            <tr class="prop-expand-row" (click)="$event.stopPropagation()">
                              <td colspan="4" style="padding:0;">
                                <div class="pdet">
                                  <!-- header -->
                                  <div class="pdet-head">
                                    <span class="pdet-key">{{ p.key }}</span>
                                    <label class="req-toggle" [class.is-req]="isRequired(kt,p.key)">
                                      <input type="checkbox" [checked]="isRequired(kt,p.key)" (change)="toggleRequired(kt,p.key)" style="pointer-events:none;" />
                                      Required
                                    </label>
                                    <button class="icon-btn danger" type="button" (click)="removeProp(kt,p.key)" title="Remove property">✕</button>
                                  </div>
                                  <!-- fields grid -->
                                  <div class="pdet-fields">
                                    <div class="field" style="margin:0;">
                                      <label>Type</label>
                                      <select [(ngModel)]="p.s.type">
                                        <option [ngValue]="undefined">any</option>
                                        <option value="string">string</option>
                                        <option value="number">number</option>
                                        <option value="boolean">boolean</option>
                                      </select>
                                    </div>
                                    <div class="field" style="margin:0;">
                                      <label>Merge function</label>
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
                                        <label>Pattern <span style="font-size:10px;font-weight:400;color:var(--text-muted);">(regex)</span></label>
                                        <input type="text" [(ngModel)]="p.s.pattern" placeholder="^[A-Z].*" />
                                      </div>
                                    }
                                    @if (p.s.type==='number'||p.s.type===undefined) {
                                      <div class="field" style="margin:0;">
                                        <label>Min</label>
                                        <input type="number" [(ngModel)]="p.s.minimum" placeholder="—" />
                                      </div>
                                      <div class="field" style="margin:0;">
                                        <label>Max</label>
                                        <input type="number" [(ngModel)]="p.s.maximum" placeholder="—" />
                                      </div>
                                    }
                                  </div>
                                  <!-- enum values -->
                                  @if (p.s.type !== 'boolean') {
                                    <div class="pdet-full">
                                      <div class="field" style="margin:0;">
                                        <label>Enum values <span style="font-size:11px;font-weight:normal;color:var(--text-muted);">— restrict to exact set</span></label>
                                        <div class="chip-wrap">
                                          @for (ev of (p.s.enum??[]); track ev) {
                                            <span class="chip">{{ ev }}<button type="button" class="chip-rm" (click)="removeEnumVal(kt,p.key,ev)">×</button></span>
                                          }
                                          <input type="text" class="chip-field" [(ngModel)]="p._enumInput"
                                            placeholder="value + Enter" (keydown)="onEnumKey($event,kt,p.key)" />
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
                              No property schemas yet — add one below.
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                    <!-- add property -->
                    <div style="display:flex;gap:8px;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
                      <input type="text" [(ngModel)]="schPropInputs[kt]" placeholder="New property name"
                        style="flex:1;max-width:220px;"
                        (keydown.enter)="$event.preventDefault();addProp(kt)" />
                      <button class="btn btn-secondary btn-sm" type="button"
                        (click)="addProp(kt)" [disabled]="!schPropInputs[kt].trim()">+ Add</button>
                    </div>
                  }
                }

              </div><!-- sch-coll-body -->
            }

            <!-- DANGER ZONE TAB -->
            @if (settingsTab() === 'danger') {
              <div class="dz-section">
                <div class="dz-section-title">Edit Space ID</div>
                <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Changes the internal identifier used by tokens, networks, files, and MCP clients. All references updated atomically.</p>
                <form (ngSubmit)="submitDangerRename()" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
                  <div class="field" style="margin:0;flex:1;max-width:280px;">
                    <label>New ID</label>
                    <input type="text" [(ngModel)]="dangerRenameId" name="dangerRenameId" pattern="[a-z0-9-]+" maxlength="40" [placeholder]="settingsSpace()!.id" />
                  </div>
                  <button class="btn btn-secondary" type="submit" [disabled]="dangerRenaming()||!dangerRenameId.trim()||dangerRenameId.trim()===settingsSpace()!.id">
                    @if (dangerRenaming()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }Rename
                  </button>
                </form>
                @if (dangerRenameError()) { <div class="alert alert-error" style="margin-top:8px;">{{ dangerRenameError() }}</div> }
              </div>

              <div class="dz-section">
                <div class="dz-section-title">Wipe Space Data</div>
                <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Permanently deletes all brain data and files. Space configuration and ID are preserved.</p>
                @if (dangerWipeLoading()) {
                  <div style="display:flex;gap:8px;align-items:center;color:var(--text-muted);font-size:13px;margin-bottom:12px;">
                    <span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> Loading counts…
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
                  @if (dangerWiping()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }Wipe all data
                </button>
              </div>

              @let spaceNets = networksForSpace(settingsSpace()!.id);
              @if (spaceNets.length > 0) {
                <div class="dz-section">
                  <div class="dz-section-title">Leave Networks</div>
                  <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Leaves the sync ring for each selected network.</p>
                  @for (n of spaceNets; track n.id) {
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
                      <div>
                        <span style="font-weight:500;">{{ n.label }}</span>
                        <span class="badge badge-gray" style="margin-left:8px;font-size:11px;">{{ n.id }}</span>
                      </div>
                      <button class="btn btn-secondary btn-sm" type="button" (click)="leaveNetworkDanger(n.id)">Leave</button>
                    </div>
                  }
                </div>
              }

              @if (!settingsSpace()!.builtIn) {
                <div class="dz-section dz-red">
                  <div class="dz-section-title">Delete Space</div>
                  <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Permanently destroys this space along with all brain data and stored files. Cannot be undone.</p>
                  @if (dangerDeleteError()) { <div class="alert alert-error" style="margin-bottom:8px;">{{ dangerDeleteError() }}</div> }
                  <button class="btn btn-danger" type="button" (click)="confirmDangerDelete()" [disabled]="dangerDeleting()">
                    @if (dangerDeleting()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }Delete space permanently
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
              <button class="btn btn-secondary" type="button" (click)="closeSettings()">Cancel</button>
              <button class="btn btn-primary" type="button" (click)="saveSettings()" [disabled]="settingsSaving()">
                @if (settingsSaving()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }Save changes
              </button>
            </div>
          }
        </div><!-- sp-panel -->
      </div><!-- sp-backdrop -->
    }

    <!-- SPACES TABLE -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">Spaces</div>
        <div style="display:flex;gap:8px;">
          <button class="btn-primary btn btn-sm" (click)="showCreateDialog.set(true)">Create New Space</button>
          <button class="btn-secondary btn btn-sm" (click)="load()">Refresh</button>
        </div>
      </div>
      @if (loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else {
        <div class="table-wrapper">
          <table>
            <thead>
              <tr><th>Label</th><th>ID</th><th>Storage</th><th>Networks</th><th>Proxy</th><th></th></tr>
            </thead>
            <tbody>
              @for (s of spaces(); track s.id) {
                @let bar = storageInfo(s);
                <tr>
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
                      <span class="badge badge-blue" style="font-style:italic;">All spaces</span>
                    } @else if (s.proxyFor?.length) {
                      @for (pid of s.proxyFor; track pid) {
                        <span class="badge badge-blue" style="margin-right:4px;font-size:11px;">{{ pid }}</span>
                      }
                    } @else { <span style="color:var(--text-muted)">—</span> }
                  </td>
                  <td><button class="icon-btn" title="Configure space" (click)="openSettings(s)">⚙</button></td>
                </tr>
              } @empty {
                <tr><td colspan="6"><div class="empty-state" style="padding:24px;"><h3>No spaces</h3></div></td></tr>
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

  readonly KINDS: KnowledgeType[] = ['entity', 'memory', 'edge', 'chrono'];
  readonly KIND_LABELS: Record<KnowledgeType, string> = {
    entity: 'Entities', memory: 'Memories', edge: 'Edges', chrono: 'Chrono',
  };

  spaces   = signal<Space[]>([]);
  networks = signal<Network[]>([]);
  loading  = signal(true);

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
  schemaCollTab  = signal<KnowledgeType | 'vocab'>('memory');

  stForm = { label: '', purpose: '', usageNotes: '', maxGiB: null as number | null };

  schValidation:     ValidationMode = 'off';
  schStrictLinkage   = false;
  schEntityTypes:    string[] = [];
  schEdgeLabels:     string[] = [];
  schNamingPatterns: Record<string, string> = {};
  schTagSuggestions: string[] = [];
  schRequiredProps:  Record<KnowledgeType, string[]> = { entity: [], memory: [], edge: [], chrono: [] };
  schPropSchemas:    Record<KnowledgeType, { key: string; s: PropertySchema; _enumInput: string }[]> = {
    entity: [], memory: [], edge: [], chrono: [],
  };
  schPropInputs:     Record<KnowledgeType, string> = { entity: '', memory: '', edge: '', chrono: '' };
  schExpandedProp:   string | null = null;
  chipInputs:        Record<string, string> = {
    entityType: '', edgeLabel: '', tag: '',
    reqentity: '', reqmemory: '', reqedge: '', reqchrono: '',
  };

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
    this.api.createSpace(body).subscribe({
      next: ({ space }) => {
        this.creating.set(false);
        this.showCreateDialog.set(false);
        this.spaces.update(list => [...list, space]);
        this.form = { label: '', id: '', maxGiB: null, purpose: SpacesComponent.DEFAULT_PURPOSE, validationMode: 'off', strictLinkage: false };
        this.proxyForSelected = [];
        this.proxyForAll = false;
      },
      error: (err) => { this.creating.set(false); this.createError.set(err.error?.error ?? 'Failed to create space'); },
    });
  }

  openSettings(s: Space): void {
    this.settingsSpace.set(s);
    this.settingsTab.set('settings');
    this.schemaCollTab.set('memory');
    this.settingsError.set('');
    this.settingsSaving.set(false);
    this.stForm = { label: s.label, purpose: s.meta?.purpose ?? '', usageNotes: s.meta?.usageNotes ?? '', maxGiB: s.maxGiB ?? null };
    const meta = s.meta ?? {};
    this.schValidation     = meta.validationMode ?? 'off';
    this.schStrictLinkage  = meta.strictLinkage ?? false;
    this.schEntityTypes    = [...(meta.entityTypes ?? [])];
    this.schEdgeLabels     = [...(meta.edgeLabels ?? [])];
    this.schNamingPatterns = { ...(meta.namingPatterns ?? {}) };
    this.schTagSuggestions = [...(meta.tagSuggestions ?? [])];
    this.schRequiredProps  = {
      entity: [...(meta.requiredProperties?.entity ?? [])],
      memory: [...(meta.requiredProperties?.memory ?? [])],
      edge:   [...(meta.requiredProperties?.edge   ?? [])],
      chrono: [...(meta.requiredProperties?.chrono ?? [])],
    };
    this.schPropSchemas = {
      entity: Object.entries(meta.propertySchemas?.entity ?? {}).map(([k, ps]) => ({ key: k, s: { ...ps }, _enumInput: '' })),
      memory: Object.entries(meta.propertySchemas?.memory ?? {}).map(([k, ps]) => ({ key: k, s: { ...ps }, _enumInput: '' })),
      edge:   Object.entries(meta.propertySchemas?.edge   ?? {}).map(([k, ps]) => ({ key: k, s: { ...ps }, _enumInput: '' })),
      chrono: Object.entries(meta.propertySchemas?.chrono ?? {}).map(([k, ps]) => ({ key: k, s: { ...ps }, _enumInput: '' })),
    };
    this.schPropInputs   = { entity: '', memory: '', edge: '', chrono: '' };
    this.schExpandedProp = null;
    this.chipInputs = { entityType: '', edgeLabel: '', tag: '', reqentity: '', reqmemory: '', reqedge: '', reqchrono: '' };
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
      maxGiB: this.stForm.maxGiB ?? 0,
      meta:   this.buildMeta(),
    }).subscribe({
      next: ({ space }) => {
        this.settingsSaving.set(false);
        this.spaces.update(list => list.map(s => s.id === space.id ? { ...s, ...space } : s));
        this.settingsSpace.set({ ...target, ...space });
      },
      error: (err) => { this.settingsSaving.set(false); this.settingsError.set(err.error?.error ?? 'Failed to save'); },
    });
  }

  buildMeta(): Partial<SpaceMeta> {
    const meta: Partial<SpaceMeta> = {};
    if (this.stForm.purpose.trim())    meta.purpose    = this.stForm.purpose.trim();
    if (this.stForm.usageNotes.trim()) meta.usageNotes = this.stForm.usageNotes.trim();
    meta.validationMode = this.schValidation;
    if (this.schStrictLinkage)         meta.strictLinkage  = true;
    if (this.schEntityTypes.length)    meta.entityTypes    = [...this.schEntityTypes];
    if (this.schEdgeLabels.length)     meta.edgeLabels     = [...this.schEdgeLabels];
    if (this.schTagSuggestions.length) meta.tagSuggestions = [...this.schTagSuggestions];
    const patterns: Record<string, string> = {};
    for (const et of this.schEntityTypes) {
      const p = this.schNamingPatterns[et];
      if (p?.trim()) patterns[et] = p.trim();
    }
    if (Object.keys(patterns).length) meta.namingPatterns = patterns;
    const reqProps: Partial<Record<KnowledgeType, string[]>> = {};
    for (const kt of this.KINDS) {
      if (this.schRequiredProps[kt]?.length) reqProps[kt] = [...this.schRequiredProps[kt]];
    }
    if (Object.keys(reqProps).length) meta.requiredProperties = reqProps;
    const propSchemas: Partial<Record<KnowledgeType, Record<string, PropertySchema>>> = {};
    for (const kt of this.KINDS) {
      const entries = this.schPropSchemas[kt];
      if (entries?.length) {
        const obj: Record<string, PropertySchema> = {};
        for (const { key, s } of entries) {
          const ps: PropertySchema = {};
          if (s.type)               ps.type    = s.type;
          if (s.enum?.length)       ps.enum    = [...s.enum];
          if (s.minimum != null)    ps.minimum = s.minimum;
          if (s.maximum != null)    ps.maximum = s.maximum;
          if (s.pattern?.trim())    ps.pattern = s.pattern.trim();
          if (s.mergeFn)            ps.mergeFn = s.mergeFn;
          obj[key] = ps;
        }
        propSchemas[kt] = obj;
      }
    }
    if (Object.keys(propSchemas).length) meta.propertySchemas = propSchemas;
    return meta;
  }

  onChipKey(e: KeyboardEvent, arrayName: string, inputKey: string): void {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addChip(arrayName, inputKey); }
  }

  addChip(arrayName: string, inputKey: string): void {
    const raw = (this.chipInputs[inputKey] ?? '').trim().replace(/,+$/, '');
    if (!raw) return;
    if (arrayName === 'entityTypes') {
      if (!this.schEntityTypes.includes(raw)) {
        this.schEntityTypes = [...this.schEntityTypes, raw];
        if (!(raw in this.schNamingPatterns)) this.schNamingPatterns = { ...this.schNamingPatterns, [raw]: '' };
      }
    } else if (arrayName === 'edgeLabels') {
      if (!this.schEdgeLabels.includes(raw)) this.schEdgeLabels = [...this.schEdgeLabels, raw];
    } else if (arrayName === 'tags') {
      if (!this.schTagSuggestions.includes(raw)) this.schTagSuggestions = [...this.schTagSuggestions, raw];
    } else if (arrayName.startsWith('req_')) {
      const kt = arrayName.slice(4) as KnowledgeType;
      const curr = this.schRequiredProps[kt] ?? [];
      if (!curr.includes(raw)) this.schRequiredProps = { ...this.schRequiredProps, [kt]: [...curr, raw] };
    }
    this.chipInputs = { ...this.chipInputs, [inputKey]: '' };
  }

  updateNamingPattern(et: string, value: string): void {
    this.schNamingPatterns = { ...this.schNamingPatterns, [et]: value };
  }

  removeEntityType(t: string): void {
    this.schEntityTypes = this.schEntityTypes.filter(x => x !== t);
    const { [t]: _dropped, ...rest } = this.schNamingPatterns;
    this.schNamingPatterns = rest;
  }

  removeRequiredProp(kt: KnowledgeType, p: string): void {
    this.schRequiredProps = { ...this.schRequiredProps, [kt]: this.schRequiredProps[kt].filter(x => x !== p) };
  }

  isPropExpanded(kt: KnowledgeType, key: string): boolean { return this.schExpandedProp === `${kt}::${key}`; }

  togglePropExpand(kt: KnowledgeType, key: string): void {
    const id = `${kt}::${key}`;
    this.schExpandedProp = this.schExpandedProp === id ? null : id;
  }

  isRequired(kt: KnowledgeType, key: string): boolean {
    return (this.schRequiredProps[kt] ?? []).includes(key);
  }

  toggleRequired(kt: KnowledgeType, key: string): void {
    const curr = this.schRequiredProps[kt] ?? [];
    this.schRequiredProps = {
      ...this.schRequiredProps,
      [kt]: curr.includes(key) ? curr.filter(x => x !== key) : [...curr, key],
    };
  }

  addProp(kt: KnowledgeType): void {
    const key = (this.schPropInputs[kt] ?? '').trim();
    if (!key || this.schPropSchemas[kt].some(e => e.key === key)) { this.schPropInputs[kt] = ''; return; }
    this.schPropSchemas[kt] = [...this.schPropSchemas[kt], { key, s: {}, _enumInput: '' }];
    this.schPropInputs[kt]  = '';
    this.schExpandedProp    = `${kt}::${key}`;
  }

  removeProp(kt: KnowledgeType, key: string): void {
    this.schPropSchemas[kt] = this.schPropSchemas[kt].filter(e => e.key !== key);
    if (this.schExpandedProp === `${kt}::${key}`) this.schExpandedProp = null;
  }

  onEnumKey(e: KeyboardEvent, kt: KnowledgeType, key: string): void {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addEnumVal(kt, key); }
  }

  addEnumVal(kt: KnowledgeType, key: string): void {
    const entry = this.schPropSchemas[kt].find(e => e.key === key);
    if (!entry) return;
    const val = (entry._enumInput ?? '').trim();
    if (!val) return;
    const curr = entry.s.enum ?? [];
    if (!curr.some(v => String(v) === val)) entry.s = { ...entry.s, enum: [...curr, val] };
    entry._enumInput = '';
  }

  removeEnumVal(kt: KnowledgeType, key: string, val: string | number | boolean): void {
    const entry = this.schPropSchemas[kt].find(e => e.key === key);
    if (!entry) return;
    entry.s = { ...entry.s, enum: (entry.s.enum ?? []).filter(v => v !== val) };
  }

  wipeStatCols(): { label: string; value: number }[] {
    const s = this.dangerWipeStats();
    if (!s) return [];
    return [
      { label: 'Memories', value: s.memories },
      { label: 'Entities', value: s.entities },
      { label: 'Edges',    value: s.edges    },
      { label: 'Chrono',   value: s.chrono   },
      { label: 'Files',    value: s.files    },
    ];
  }

  submitDangerRename(): void {
    const target = this.settingsSpace();
    const newId  = this.dangerRenameId.trim();
    if (!target || !newId || newId === target.id) return;
    if (!confirm(`Rename space "${target.label}" from "${target.id}" to "${newId}"? All references will be updated.`)) return;
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
      error: (err) => { this.dangerRenaming.set(false); this.dangerRenameError.set(err.error?.error ?? 'Failed to rename'); },
    });
  }

  confirmDangerWipe(): void {
    const target = this.settingsSpace();
    if (!target) return;
    if (!confirm(`Wipe ALL data from "${target.label}"? This cannot be undone.`)) return;
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
      error: (err) => { this.dangerWiping.set(false); this.dangerWipeError.set(err.error?.error ?? 'Failed to wipe'); },
    });
  }

  confirmDangerDelete(): void {
    const target = this.settingsSpace();
    if (!target) return;
    if (!confirm(`Delete space "${target.label}" (${target.id}) permanently? All data will be destroyed.`)) return;
    this.dangerDeleting.set(true);
    this.dangerDeleteError.set('');
    this.api.deleteSpace(target.id).subscribe({
      next: () => {
        this.dangerDeleting.set(false);
        this.spaces.update(list => list.filter(s => s.id !== target.id));
        this.closeSettings();
      },
      error: (err) => { this.dangerDeleting.set(false); this.dangerDeleteError.set(err.error?.error ?? 'Failed to delete'); },
    });
  }

  leaveNetworkDanger(networkId: string): void {
    if (!confirm('Leave this network? This instance will stop syncing with its peers.')) return;
    this.api.leaveNetwork(networkId).subscribe({
      next: () => this.api.listNetworks().subscribe({ next: ({ networks }) => this.networks.set(networks), error: () => {} }),
      error: () => alert('Failed to leave network.'),
    });
  }
}
