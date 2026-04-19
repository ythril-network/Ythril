import {
  Component,
  OnInit,
  AfterViewInit,
  OnDestroy,
  Input,
  inject,
  signal,
  computed,
  viewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subscription, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import cytoscape from 'cytoscape';
import {
  ApiService,
  Space,
  Entity,
  Memory,
  ChronoEntry,
  ChronoType,
  ChronoStatus,
  Edge,
  TraverseNode,
  TraverseEdge,
  TraverseResult,
} from '../../core/api.service';
import { EntryPopupComponent } from '../../shared/entry-popup.component';
import { EntitySearchComponent } from '../../shared/entity-search.component';
import { PropertiesViewComponent } from '../../shared/properties-view.component';
import { TagInputComponent } from '../../shared/tag-input.component';
import { PropertiesEditorComponent } from '../../shared/properties-editor.component';

// ── Deterministic colour palette for node types ──────────────────────────────

const TYPE_COLORS = [
  '#7c6af7', '#58a6ff', '#3fb950', '#00e5ff', '#f85149',
  '#e38625', '#9580ff', '#79c0ff', '#56d364', '#ff6eb4',
];

function typeColor(type: string): string {
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) | 0;
  return TYPE_COLORS[Math.abs(hash) % TYPE_COLORS.length];
}

// ── Helper types ─────────────────────────────────────────────────────────────

interface DetailRow {
  id: string;
  kind: 'memory' | 'chrono';
  description: string;
  tags: string[];
  properties: Record<string, unknown>;
  createdAt: string;
  raw: Record<string, unknown>;
}

@Component({
  selector: 'app-graph-view',
  standalone: true,
  imports: [CommonModule, FormsModule, EntryPopupComponent, EntitySearchComponent, PropertiesViewComponent, TagInputComponent, PropertiesEditorComponent],
  host: { '[class.embedded]': 'isEmbedded()' },
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 56px - 56px);
      min-height: 0;
      gap: 8px;
    }
    :host.embedded {
      height: 70vh;
      min-height: 400px;
    }

    /* ── Space chips (matches brain style) ─────────────────────────────────── */
    .space-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
      overflow-x: auto;
      padding-bottom: 2px;
      flex-shrink: 0;
    }
    .space-chip {
      padding: 5px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid var(--border);
      background: var(--bg-surface);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1px;
      min-width: 90px;
      white-space: nowrap;
    }
    .space-chip:hover { border-color: var(--accent); color: var(--text-primary); }
    .space-chip.active {
      background: var(--accent-dim);
      border-color: var(--accent);
      color: var(--accent);
    }
    .space-chip-label { font-size: 12px; font-weight: 500; }
    .space-chip-id { font-size: 10px; color: var(--text-muted); }
    .space-chip.active .space-chip-id { color: var(--accent); opacity: 0.7; }

    /* ── Toolbar ───────────────────────────────────────────────────────────── */

    .graph-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      margin-bottom: 8px;
      flex-shrink: 0;
    }

    .graph-toolbar select,
    .graph-toolbar input[type="search"],
    .graph-toolbar input[type="text"] {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-family: var(--font);
      font-size: 13px;
      padding: 6px 10px;
      outline: none;
      transition: border-color var(--transition);
    }
    .graph-toolbar select:focus,
    .graph-toolbar input:focus {
      border-color: var(--accent);
    }

    .graph-toolbar select { min-width: 140px; }

    .search-wrapper {
      position: relative;
      flex: 1;
      min-width: 200px;
      max-width: 360px;
    }

    .toolbar-divider {
      width: 1px;
      height: 22px;
      background: var(--border);
      flex-shrink: 0;
    }
    .toolbar-spacer { flex: 1; }
    .toolbar-label {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .depth-control {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .depth-control input[type="range"] {
      accent-color: var(--accent);
      width: 80px;
      cursor: pointer;
    }
    .depth-value {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-primary);
      min-width: 14px;
      text-align: center;
    }

    .pill-group {
      display: flex;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
      flex-shrink: 0;
    }
    .pill-group button {
      padding: 5px 12px;
      font-size: 12px;
      background: var(--bg-elevated);
      color: var(--text-secondary);
      border: none;
      cursor: pointer;
      transition: background var(--transition), color var(--transition);
      white-space: nowrap;
    }
    .pill-group button + button { border-left: 1px solid var(--border); }
    .pill-group button.active {
      background: var(--accent-dim);
      color: var(--accent);
    }
    .pill-group button:hover:not(.active) {
      background: var(--bg-overlay);
      color: var(--text-primary);
    }

    .toolbar-toggle {
      display: flex;
      align-items: center;
      gap: 5px;
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .toolbar-toggle input[type="checkbox"] { accent-color: var(--accent); }

    .toolbar-btn {
      padding: 5px 10px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;
      line-height: 1;
      transition: border-color var(--transition), color var(--transition), background var(--transition);
    }
    .toolbar-btn:hover {
      border-color: var(--accent);
      color: var(--text-primary);
      background: var(--accent-dim);
    }
    .graph-stats {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      font-family: var(--font-mono);
    }

    /* ── Canvas zone ──────────────────────────────────────────────────────── */

    .canvas-row {
      display: flex;
      flex: 1;
      min-height: 0;
      gap: 8px;
    }

    .canvas-zone {
      position: relative;
      flex: 1;
      min-height: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-primary);
      overflow: hidden;
    }

    .cy-container {
      width: 100%;
      height: 100%;
      position: absolute;
      inset: 0;
    }

    .truncation-banner {
      position: absolute;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      background: var(--error-dim);
      border: 1px solid var(--error);
      border-radius: var(--radius-sm);
      color: var(--warning);
      font-size: 13px;
      white-space: nowrap;
    }
    .truncation-banner button {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;
      padding: 0 2px;
    }

    .canvas-empty {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      gap: 8px;
    }
    .empty-icon {
      font-size: 52px;
      line-height: 1;
      opacity: 0.2;
    }
    .canvas-empty h3 {
      color: var(--text-muted);
      font-weight: 500;
      font-size: 15px;
      margin: 0;
    }
    .canvas-empty p {
      color: var(--text-muted);
      font-size: 13px;
      margin: 0;
      opacity: 0.7;
    }

    /* Loading overlay */
    .loading-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.25);
      z-index: 30;
      backdrop-filter: blur(2px);
    }
    .loading-spinner {
      width: 36px;
      height: 36px;
      border: 3px solid rgba(124, 106, 247, 0.25);
      border-top-color: #7c6af7;
      border-radius: 50%;
      animation: graph-spin 0.75s linear infinite;
    }
    @keyframes graph-spin { to { transform: rotate(360deg); } }

    /* ── Side panel (shown when node or edge selected) ───────────────────── */

    .side-panel {
      width: 560px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
      overflow: hidden;
      min-height: 0;
    }

    .side-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      gap: 8px;
    }
    .side-panel-title {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .side-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .side-panel-title h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .side-panel-header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    /* Side panel body: two columns */
    .side-panel-body {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    /* Left column: record card */
    .record-card {
      flex: 0 0 50%;
      border-right: 1px solid var(--border);
      overflow-y: auto;
      padding: 12px 14px;
    }

    /* Drawer fields (same pattern as brain component) */
    .drawer-field { margin-bottom: 14px; }
    .drawer-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 4px;
    }
    .drawer-value {
      font-size: 12px;
      color: var(--text-primary);
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
    }
    .drawer-muted { color: var(--text-muted); }
    .drawer-hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
    .drawer-readonly-value {
      font-size: 12px;
      color: var(--text-muted);
      padding: 4px 8px;
      border: 1px solid var(--border-muted, var(--border));
      border-radius: var(--radius-sm);
      background: var(--bg-elevated);
      word-break: break-all;
      line-height: 1.4;
    }
    .drawer-tag {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 11px;
      background: var(--bg-elevated);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      margin: 2px 3px 2px 0;
    }

    /* Right column: memory + chrono lists */
    .lists-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }
    .list-section {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      border-bottom: 1px solid var(--border);
    }
    .list-section:last-child { border-bottom: none; }
    .list-section-header {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 8px 12px 6px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .list-section-header .count-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      background: var(--bg-overlay);
      border-radius: 8px;
      font-size: 10px;
      color: var(--text-muted);
    }
    .list-body { overflow-y: auto; flex: 1; }
    .list-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background var(--transition);
    }
    .list-row:last-child { border-bottom: none; }
    .list-row:hover { background: var(--bg-elevated); }
    .list-row-text {
      flex: 1;
      font-size: 12px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list-row-date {
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .list-empty {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
      text-align: center;
      padding: 16px 12px;
    }

    /* ── Shared badge, button helpers ──────────────────────────────────────── */
    .tag {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 11px;
      background: var(--bg-elevated);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      margin-right: 3px;
    }

    /* ── Brain-style record drawer modal ───────────────────────────────────── */
    .bdrawer-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,.55);
      display: flex; align-items: center; justify-content: center;
      z-index: 1100;
    }
    .bdrawer-modal {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      width: 100%; max-width: 640px;
      max-height: 88vh; overflow: hidden;
      display: flex; flex-direction: column;
    }
    .bdrawer-header {
      display: flex; align-items: flex-start; justify-content: space-between;
      padding: 16px 20px; border-bottom: 1px solid var(--border); gap: 12px; flex-shrink: 0;
    }
    .bdrawer-title { font-size: 15px; font-weight: 600; color: var(--text-primary); word-break: break-word; }
    .bdrawer-body { overflow-y: auto; flex: 1; padding: 20px; }
    .bdrawer-footer {
      display: flex; align-items: center; justify-content: flex-end;
      gap: 8px; padding: 12px 20px; border-top: 1px solid var(--border); flex-shrink: 0;
    }
    .bdrawer-field { margin-bottom: 16px; }
    .bdrawer-label {
      font-size: 10px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px;
    }
    .bdrawer-readonly {
      font-size: 12px; color: var(--text-muted); padding: 5px 8px;
      border: 1px solid var(--border-muted, var(--border)); border-radius: var(--radius-sm);
      background: var(--bg-elevated); word-break: break-all; line-height: 1.4;
      font-family: var(--font-mono);
    }
    .bdrawer-muted { color: var(--text-muted); font-size: 11px; }
    .bdrawer-hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
    .bdrawer-modal input[type=text], .bdrawer-modal input[type=number],
    .bdrawer-modal input[type=datetime-local], .bdrawer-modal textarea, .bdrawer-modal select {
      width: 100%; padding: 6px 9px;
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      font-size: 13px; background: var(--bg-primary); color: var(--text-primary);
      box-sizing: border-box; font-family: var(--font);
    }
    .bdrawer-modal textarea { resize: vertical; }
    .bdrawer-modal input:focus, .bdrawer-modal select:focus, .bdrawer-modal textarea:focus {
      outline: none; border-color: var(--accent);
    }
    /* entity chips */
    .entity-multi {
      display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
      padding: 4px 6px; border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--bg-primary); min-height: 34px;
    }
    .chip {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 8px; border-radius: 10px;
      background: var(--accent-dim); border: 1px solid var(--accent);
      font-size: 11px; color: var(--text-primary);
    }
    .chip-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip-remove {
      background: none; border: none; color: var(--text-muted); cursor: pointer;
      padding: 0 1px; font-size: 12px; line-height: 1;
    }
    .chip-add {
      background: none; border: none; color: var(--accent); cursor: pointer;
      font-size: 12px; padding: 2px 4px;
    }
    .flyout-wrap { position: relative; }
    .flyout-panel {
      position: absolute; top: 100%; left: 0; right: 0; z-index: 200;
      background: var(--bg-surface); border: 1px solid var(--border);
      border-radius: var(--radius-md); padding: 10px; margin-top: 4px;
      box-shadow: 0 8px 24px rgba(0,0,0,.3);
    }
  `],
  template: `
    <!-- ═══ Space selector ══════════════════════════════════════════════════ -->
    @if (!isEmbedded() && spaces().length > 0) {
      <div class="space-tabs">
        @for (s of spaces(); track s.id) {
          <button class="space-chip" [class.active]="activeSpaceId() === s.id" (click)="onSpaceChange(s.id)">{{ s.label }}</button>
        }
      </div>
    }

    <!-- ═══ Toolbar ════════════════════════════════════════════════════════ -->
    <div class="graph-toolbar">
      <div class="search-wrapper">
        <app-entity-search
          mode="bar"
          [spaceId]="activeSpaceId()"
          placeholder="🔍  Search entity…"
          defaultMode="semantic"
          (selected)="selectRoot($event)"
          (queryChange)="onSearchQueryChange($event)"
        />
      </div>

      <div class="toolbar-divider"></div>

      <div class="depth-control">
        <span class="toolbar-label">Depth</span>
        <input type="range" min="1" max="10" [ngModel]="depth()" (ngModelChange)="onDepthChange($event)" />
        <span class="depth-value">{{ depth() }}</span>
      </div>

      <div class="pill-group">
        <button [class.active]="direction() === 'outbound'" (click)="setDirection('outbound')">Out</button>
        <button [class.active]="direction() === 'inbound'" (click)="setDirection('inbound')">In</button>
        <button [class.active]="direction() === 'both'"    (click)="setDirection('both')">Both</button>
      </div>

      <div class="pill-group">
        <button [class.active]="!hideLabels()" (click)="onHideLabelsChange(!hideLabels())" title="Toggle edge labels">Labels</button>
      </div>

      <div class="toolbar-spacer"></div>

      @if (rootEntity()) {
        <span class="graph-stats">{{ nodeCount() }} nodes · {{ edgeCount() }} edges</span>
      }
      <button class="toolbar-btn" title="Fit to viewport" (click)="fitGraph()">⛶</button>
      <button class="toolbar-btn" title="Reset graph"     (click)="resetGraph()">↺</button>
    </div>

    <!-- ═══ Canvas row (canvas + optional side panel) ══════════════════════ -->
    <div class="canvas-row">

      <!-- ── Canvas zone ────────────────────────────────────────────────── -->
      <div class="canvas-zone">
        @if (truncated()) {
          <div class="truncation-banner">
            ⚠ Result truncated — reduce depth or node limit to see full graph
            <button (click)="truncated.set(false)">✕</button>
          </div>
        }

        @if (loading()) {
          <div class="loading-overlay"><div class="loading-spinner"></div></div>
        }

        @if (!rootEntity() && !loading()) {
          <div class="canvas-empty">
            <div class="empty-icon">◎</div>
            <h3>Search for an entity to start exploring</h3>
            <p>Tap nodes to inspect · double-tap to re-root</p>
          </div>
        }

        <div #cyContainer class="cy-container" [style.visibility]="rootEntity() ? 'visible' : 'hidden'"></div>
      </div>

      <!-- ── Side panel (node selected) ────────────────────────────────── -->
      @if (selectedNode()) {
        <div class="side-panel">
          <div class="side-panel-header">
            <div class="side-panel-title">
              <span class="side-dot" [style.background]="panelColor()"></span>
              <h3>{{ selectedNode()!.name }}</h3>
              <span class="badge">{{ selectedNode()!.type || 'entity' }}</span>
            </div>
            <div class="side-panel-header-actions">
              <button class="btn btn-sm btn-ghost" (click)="openEntityPopup(selectedNode()!)">👁</button>
              <button class="icon-btn" title="Close" (click)="selectedNode.set(null)">✕</button>
            </div>
          </div>
          <div class="side-panel-body">

            <!-- Record card -->
            <div class="record-card">
              @if (selectedEntityRecord()) {
                <div class="drawer-field">
                  <div class="drawer-label">name</div>
                  <div class="drawer-value">{{ selectedEntityRecord()!.name }}</div>
                </div>
                @if (selectedEntityRecord()!.type) {
                  <div class="drawer-field">
                    <div class="drawer-label">type</div>
                    <div class="drawer-value">{{ selectedEntityRecord()!.type }}</div>
                  </div>
                }
                @if (selectedEntityRecord()!.description) {
                  <div class="drawer-field">
                    <div class="drawer-label">description</div>
                    <div class="drawer-value">{{ selectedEntityRecord()!.description }}</div>
                  </div>
                }
                @if (selectedEntityRecord()!.tags?.length) {
                  <div class="drawer-field">
                    <div class="drawer-label">tags</div>
                    <div>
                      @for (t of selectedEntityRecord()!.tags!; track t) {
                        <span class="drawer-tag">{{ t }}</span>
                      }
                    </div>
                  </div>
                }
                @if (selectedEntityRecord()!.properties && objectKeys(selectedEntityRecord()!.properties!).length) {
                  <div class="drawer-field">
                    <div class="drawer-label">properties</div>
                    <app-properties-view [properties]="selectedEntityRecord()!.properties!" />
                  </div>
                }
                <hr class="drawer-hr">
                <div class="drawer-field">
                  <div class="drawer-label">_id</div>
                  <div class="drawer-readonly-value" style="font-family:var(--font-mono,monospace);font-size:10px;">{{ selectedEntityRecord()!._id }}</div>
                </div>
                <div class="drawer-field" style="margin-bottom:0;">
                  <div class="drawer-label">createdAt</div>
                  <div class="drawer-readonly-value">{{ selectedEntityRecord()!.createdAt | date:'dd.MM.yyyy HH:mm' }}</div>
                </div>
              } @else {
                <div style="font-size:12px;color:var(--text-muted);padding:8px 0;">Loading…</div>
              }
            </div>

            <!-- Lists pane: memories + chrono -->
            <div class="lists-pane">
              <div class="list-section">
                <div class="list-section-header">
                  Memories <span class="count-chip">{{ nodeMemories().length }}</span>
                </div>
                <div class="list-body">
                  @for (m of nodeMemories(); track m._id) {
                    <div class="list-row" (click)="openDetailPopup({ id: m._id, kind: 'memory', description: m.fact || m.description || '', tags: m.tags ?? [], properties: {}, createdAt: m.createdAt, raw: asRecord(m) })">
                      <span class="list-row-text" [title]="m.fact || m.description">{{ m.fact || m.description || '—' }}</span>
                      <span class="list-row-date">{{ m.createdAt | date:'dd.MM.yy' }}</span>
                    </div>
                  } @empty {
                    <div class="list-empty">No memories</div>
                  }
                </div>
              </div>
              <div class="list-section">
                <div class="list-section-header">
                  Chrono <span class="count-chip">{{ nodeChrono().length }}</span>
                </div>
                <div class="list-body">
                  @for (c of nodeChrono(); track c._id) {
                    <div class="list-row" (click)="openDetailPopup({ id: c._id, kind: 'chrono', description: c.title || c.description || '', tags: c.tags, properties: {}, createdAt: c.createdAt, raw: asRecord(c) })">
                      <span class="list-row-text" [title]="c.title || c.description">{{ c.title || c.description || '—' }}</span>
                      <span class="list-row-date">{{ c.startsAt | date:'dd.MM.yy' }}</span>
                    </div>
                  } @empty {
                    <div class="list-empty">No chrono entries</div>
                  }
                </div>
              </div>
            </div>

          </div>
        </div>
      }

      <!-- ── Side panel (edge selected) ────────────────────────────────── -->
      @if (selectedEdge()) {
        <div class="side-panel">
          <div class="side-panel-header">
            <div class="side-panel-title">
              <span class="side-dot" [style.background]="panelColor()"></span>
              <h3>{{ selectedEdge()!.label || 'edge' }}</h3>
              <span class="badge">edge</span>
            </div>
            <div class="side-panel-header-actions">
              @if (selectedEdgeRecord()) {
                <button class="btn btn-sm btn-ghost" (click)="popupRecord.set(asRecord(selectedEdgeRecord()!)); popupType.set('edge')">👁</button>
              }
              <button class="icon-btn" title="Close" (click)="selectedEdge.set(null); selectedEdgeRecord.set(null)">✕</button>
            </div>
          </div>
          <div class="side-panel-body">

            <!-- Edge record card -->
            <div class="record-card">
              @if (selectedEdgeRecord()) {
                <div class="drawer-field">
                  <div class="drawer-label">label</div>
                  <div class="drawer-value">{{ selectedEdgeRecord()!.label }}</div>
                </div>
                @if (selectedEdgeRecord()!.type) {
                  <div class="drawer-field">
                    <div class="drawer-label">type</div>
                    <div class="drawer-value">{{ selectedEdgeRecord()!.type }}</div>
                  </div>
                }
                @if (selectedEdgeRecord()!.description) {
                  <div class="drawer-field">
                    <div class="drawer-label">description</div>
                    <div class="drawer-value">{{ selectedEdgeRecord()!.description }}</div>
                  </div>
                }
                @if (selectedEdgeRecord()!.weight !== undefined && selectedEdgeRecord()!.weight !== null) {
                  <div class="drawer-field">
                    <div class="drawer-label">weight</div>
                    <div class="drawer-value">{{ selectedEdgeRecord()!.weight }}</div>
                  </div>
                }
                @if (selectedEdgeRecord()!.tags?.length) {
                  <div class="drawer-field">
                    <div class="drawer-label">tags</div>
                    <div>
                      @for (t of selectedEdgeRecord()!.tags!; track t) {
                        <span class="drawer-tag">{{ t }}</span>
                      }
                    </div>
                  </div>
                }
                @if (selectedEdgeRecord()!.properties && objectKeys(selectedEdgeRecord()!.properties!).length) {
                  <div class="drawer-field">
                    <div class="drawer-label">properties</div>
                    <app-properties-view [properties]="selectedEdgeRecord()!.properties!" />
                  </div>
                }
                <hr class="drawer-hr">
                <div class="drawer-field">
                  <div class="drawer-label">from</div>
                  <div class="drawer-readonly-value">{{ selectedEdgeRecord()!.fromName || selectedEdge()!.from }}</div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">to</div>
                  <div class="drawer-readonly-value">{{ selectedEdgeRecord()!.toName || selectedEdge()!.to }}</div>
                </div>
                <div class="drawer-field" style="margin-bottom:0;">
                  <div class="drawer-label">_id</div>
                  <div class="drawer-readonly-value" style="font-family:var(--font-mono,monospace);font-size:10px;">{{ selectedEdgeRecord()!._id }}</div>
                </div>
              } @else {
                <div style="font-size:12px;color:var(--text-muted);padding:8px 0;">Loading…</div>
              }
            </div>

            <!-- Lists pane: memories + chrono for both endpoints -->
            <div class="lists-pane">
              <div class="list-section">
                <div class="list-section-header">
                  Memories <span class="count-chip">{{ nodeMemories().length }}</span>
                </div>
                <div class="list-body">
                  @for (m of nodeMemories(); track m._id) {
                    <div class="list-row" (click)="openDetailPopup({ id: m._id, kind: 'memory', description: m.fact || m.description || '', tags: m.tags ?? [], properties: {}, createdAt: m.createdAt, raw: asRecord(m) })">
                      <span class="list-row-text" [title]="m.fact || m.description">{{ m.fact || m.description || '—' }}</span>
                      <span class="list-row-date">{{ m.createdAt | date:'dd.MM.yy' }}</span>
                    </div>
                  } @empty {
                    <div class="list-empty">No linked memories</div>
                  }
                </div>
              </div>
              <div class="list-section">
                <div class="list-section-header">
                  Chrono <span class="count-chip">{{ nodeChrono().length }}</span>
                </div>
                <div class="list-body">
                  @for (c of nodeChrono(); track c._id) {
                    <div class="list-row" (click)="openDetailPopup({ id: c._id, kind: 'chrono', description: c.title || c.description || '', tags: c.tags, properties: {}, createdAt: c.createdAt, raw: asRecord(c) })">
                      <span class="list-row-text" [title]="c.title || c.description">{{ c.title || c.description || '—' }}</span>
                      <span class="list-row-date">{{ c.startsAt | date:'dd.MM.yy' }}</span>
                    </div>
                  } @empty {
                    <div class="list-empty">No linked chrono</div>
                  }
                </div>
              </div>
            </div>

          </div>
        </div>
      }

    </div><!-- /canvas-row -->

    <!-- ═══ Entry popup (entity / edge) ═══════════════════════════════════ -->
    @if (popupRecord()) {
      <app-entry-popup
        [record]="popupRecord()"
        [recordType]="popupType()"
        [spaceId]="activeSpaceId()"
        [canEdit]="canEdit()"
        (closed)="closePopup()"
        (saved)="onPopupSaved($event)"
      />
    }

    <!-- ═══ Brain-style drawer modal (memory / chrono) ════════════════════ -->
    @if (drawerRecord(); as dr) {
      <div class="bdrawer-overlay" (click)="closeBrainDrawer()">
        <div class="bdrawer-modal" (click)="$event.stopPropagation()" role="dialog">
          <div class="bdrawer-header">
            <div style="flex:1; min-width:0;">
              @if (dr.kind === 'memory') { <span class="badge badge-blue" style="margin-bottom:6px; display:inline-block;">memory</span> }
              @if (dr.kind === 'chrono') { <span class="badge" style="margin-bottom:6px; display:inline-block;">chrono</span> }
              <div class="bdrawer-title">
                @if (dr.kind === 'memory') { {{ drawerEditMemory.fact.length > 80 ? (drawerEditMemory.fact | slice:0:80) + '…' : drawerEditMemory.fact }} }
                @if (dr.kind === 'chrono') { {{ drawerEditChrono.title || dr.record.title }} }
              </div>
            </div>
            <div style="display:flex; gap:8px; flex-shrink:0; align-items:flex-start; padding-top:2px;">
              <button class="btn btn-sm btn-primary" [disabled]="drawerSaving()" (click)="saveBrainDrawer()">
                @if (drawerSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } Save
              </button>
              <button class="icon-btn" title="Close" (click)="closeBrainDrawer()">✕</button>
            </div>
          </div>

          <div class="bdrawer-body">
            @if (drawerError()) {
              <div class="alert alert-error" style="margin-bottom:16px; font-size:13px;">{{ drawerError() }}</div>
            }
            <form>

              <!-- ── MEMORY ── -->
              @if (dr.kind === 'memory') {
                <div class="bdrawer-field">
                  <div class="bdrawer-label">fact <span style="color:var(--error)">*</span></div>
                  <textarea [(ngModel)]="drawerEditMemory.fact" name="drwMemFact" rows="4"></textarea>
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">description</div>
                  <input type="text" [(ngModel)]="drawerEditMemory.description" name="drwMemDesc" />
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">tags</div>
                  <app-tag-input [(value)]="drawerEditMemory.tags" [suggestions]="[]" inputName="drwMemTags" />
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">entityIds</div>
                  <div class="flyout-wrap">
                    <div class="entity-multi">
                      @for (chip of entityChips(drawerEditMemory.entityIds); track chip.id) {
                        <span class="chip" [title]="chip.id">
                          <span class="chip-name">{{ chip.name }}</span>
                          <button type="button" class="chip-remove" (mousedown)="removeEntityId(drawerEditMemory, chip.id)">✕</button>
                        </span>
                      }
                      <button type="button" class="chip-add" (click)="openFlyout('drawer-memory-entityIds')">+ Add…</button>
                    </div>
                    @if (flyoutField() === 'drawer-memory-entityIds') {
                      <div class="flyout-panel">
                        <app-entity-search mode="picker" [spaceId]="activeSpaceId()" placeholder="Search entities…" defaultMode="semantic"
                          (selected)="pickDrawerEntity($event, 'drawer-memory-entityIds')" />
                        <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                          <button type="button" class="btn btn-sm btn-secondary" (click)="closeFlyout()">Done</button>
                        </div>
                      </div>
                    }
                  </div>
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">properties</div>
                  <app-properties-editor [(value)]="drawerEditMemory.properties" />
                </div>
                <hr class="bdrawer-hr">
                <div class="bdrawer-field">
                  <div class="bdrawer-label">_id</div>
                  <div class="bdrawer-readonly">{{ dr.record._id }}</div>
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">seq</div>
                  <div class="bdrawer-readonly">{{ dr.record.seq }}</div>
                </div>
                <div class="bdrawer-field" style="margin-bottom:0;">
                  <div class="bdrawer-label">createdAt</div>
                  <div class="bdrawer-readonly">{{ dr.record.createdAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
              }

              <!-- ── CHRONO ── -->
              @if (dr.kind === 'chrono') {
                <div class="bdrawer-field">
                  <div class="bdrawer-label">title <span style="color:var(--error)">*</span></div>
                  <input type="text" [(ngModel)]="drawerEditChrono.title" name="drwChronoTitle" />
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">type <span style="color:var(--error)">*</span></div>
                  @if (drawerEditChrono.kind !== '__custom__') {
                    <select [(ngModel)]="drawerEditChrono.kind" name="drwChronoKind">
                      @for (k of chronoKinds; track k) { <option [value]="k">{{ k }}</option> }
                      <option value="__custom__">Custom…</option>
                    </select>
                  } @else {
                    <div style="display:flex; gap:4px;">
                      <input type="text" [(ngModel)]="drawerEditChrono.customKind" name="drwChronoCustomKind" style="flex:1;" />
                      <button type="button" class="btn btn-sm btn-secondary" style="padding:4px 8px;" (click)="drawerEditChrono.kind = 'event'; drawerEditChrono.customKind = ''">✕</button>
                    </div>
                  }
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">status</div>
                  <select [(ngModel)]="drawerEditChrono.status" name="drwChronoStatus">
                    @for (s of chronoStatusOptions; track s) { <option [value]="s">{{ s }}</option> }
                  </select>
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">startsAt <span style="color:var(--error)">*</span></div>
                  <input type="datetime-local" [(ngModel)]="drawerEditChrono.startsAt" name="drwChronoStarts" />
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">endsAt</div>
                  <input type="datetime-local" [(ngModel)]="drawerEditChrono.endsAt" name="drwChronoEnds" />
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">description</div>
                  <textarea [(ngModel)]="drawerEditChrono.description" name="drwChronoDesc" rows="3"></textarea>
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">tags</div>
                  <app-tag-input [(value)]="drawerEditChrono.tags" [suggestions]="[]" inputName="drwChronoTags" />
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">entityIds</div>
                  <div class="flyout-wrap">
                    <div class="entity-multi">
                      @for (chip of entityChips(drawerEditChrono.entityIds); track chip.id) {
                        <span class="chip" [title]="chip.id">
                          <span class="chip-name">{{ chip.name }}</span>
                          <button type="button" class="chip-remove" (mousedown)="removeEntityId(drawerEditChrono, chip.id)">✕</button>
                        </span>
                      }
                      <button type="button" class="chip-add" (click)="openFlyout('drawer-chrono-entityIds')">+ Add…</button>
                    </div>
                    @if (flyoutField() === 'drawer-chrono-entityIds') {
                      <div class="flyout-panel">
                        <app-entity-search mode="picker" [spaceId]="activeSpaceId()" placeholder="Search entities…" defaultMode="semantic"
                          (selected)="pickDrawerEntity($event, 'drawer-chrono-entityIds')" />
                        <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                          <button type="button" class="btn btn-sm btn-secondary" (click)="closeFlyout()">Done</button>
                        </div>
                      </div>
                    }
                  </div>
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">memoryIds <span class="bdrawer-muted">(comma-separated IDs)</span></div>
                  <textarea [(ngModel)]="drawerEditChrono.memoryIds" name="drwChronoMemIds" rows="2" style="font-family:var(--font-mono,monospace); font-size:11px;"></textarea>
                </div>
                <hr class="bdrawer-hr">
                <div class="bdrawer-field">
                  <div class="bdrawer-label">_id</div>
                  <div class="bdrawer-readonly">{{ dr.record._id }}</div>
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">seq</div>
                  <div class="bdrawer-readonly">{{ dr.record.seq }}</div>
                </div>
                <div class="bdrawer-field">
                  <div class="bdrawer-label">createdAt</div>
                  <div class="bdrawer-readonly">{{ dr.record.createdAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
                <div class="bdrawer-field" style="margin-bottom:0;">
                  <div class="bdrawer-label">updatedAt</div>
                  <div class="bdrawer-readonly">{{ dr.record.updatedAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
              }
            </form>
          </div>
        </div>
      </div>
    }
  `,
})
export class GraphComponent implements OnInit, AfterViewInit, OnDestroy {
  // ── DI ──────────────────────────────────────────────────────────────────────
  private api = inject(ApiService);
  private location = inject(Location);
  private route = inject(ActivatedRoute);

  // ── Element refs ────────────────────────────────────────────────────────────
  cyContainer = viewChild<ElementRef<HTMLDivElement>>('cyContainer');

  // ── Embedded input ──────────────────────────────────────────────────────────
  @Input() set embeddedSpaceId(v: string | undefined) {
    if (v !== undefined) {
      this.isEmbedded.set(true);
      const changed = this.activeSpaceId() !== v;
      this.activeSpaceId.set(v);
      if (changed && this.cy) this.resetGraph();
    }
  }

  // ── State signals ───────────────────────────────────────────────────────────
  isEmbedded = signal(false);

  spaces = signal<Space[]>([]);
  activeSpaceId = signal('');
  searchQuery = signal('');

  rootEntity = signal<Entity | null>(null);
  depth = signal(3);
  direction = signal<'outbound' | 'inbound' | 'both'>('both');
  hideLabels = signal(false);
  truncated = signal(false);

  selectedNode = signal<TraverseNode | null>(null);
  selectedEntityRecord = signal<Entity | null>(null);
  selectedEdge = signal<TraverseEdge | null>(null);
  selectedEdgeRecord = signal<Edge | null>(null);
  nodeMemories = signal<Memory[]>([]);
  nodeChrono = signal<ChronoEntry[]>([]);

  detailTypeFilter = signal<'all' | 'memory' | 'chrono'>('all');
  detailDescFilter = signal('');
  sortField = signal<'description' | 'createdAt'>('createdAt');
  sortAsc = signal(false);

  nodeCount = signal(0);
  edgeCount = signal(0);

  popupRecord = signal<Record<string, unknown> | null>(null);
  popupType = signal<'entity' | 'edge' | 'memory' | 'chrono'>('entity');
  canEdit = signal(false);

  // ── Brain-style drawer for memory / chrono ──────────────────────────────
  drawerRecord = signal<{ kind: 'memory' | 'chrono'; record: any } | null>(null);
  drawerSaving = signal(false);
  drawerError = signal('');
  drawerEditMemory = { fact: '', tags: [] as string[], entityIds: '', description: '', properties: {} as Record<string, string | number | boolean> };
  drawerEditChrono = { title: '', kind: 'event' as string, customKind: '', status: 'upcoming' as string, startsAt: '', endsAt: '', description: '', tags: [] as string[], entityIds: '', memoryIds: '' };
  entityNameCache = signal<Record<string, string>>({});
  flyoutField = signal('');
  readonly chronoKinds: ChronoType[] = ['event', 'deadline', 'plan', 'prediction', 'milestone'];
  readonly chronoStatusOptions: ChronoStatus[] = ['upcoming', 'active', 'completed', 'overdue', 'cancelled'];

  loading = signal(false);

  // ── Computed ────────────────────────────────────────────────────────────────
  allDetails = computed<DetailRow[]>(() => {
    const mems: DetailRow[] = this.nodeMemories().map(m => ({
      id: m._id,
      kind: 'memory' as const,
      description: m.fact || m.description || '',
      tags: m.tags ?? [],
      properties: (m.properties ?? {}) as Record<string, unknown>,
      createdAt: m.createdAt,
      raw: m as unknown as Record<string, unknown>,
    }));
    const chrs: DetailRow[] = this.nodeChrono().map(c => ({
      id: c._id,
      kind: 'chrono' as const,
      description: c.title || c.description || '',
      tags: c.tags,
      properties: {} as Record<string, unknown>,
      createdAt: c.createdAt,
      raw: c as unknown as Record<string, unknown>,
    }));
    return [...mems, ...chrs];
  });

  filteredDetails = computed<DetailRow[]>(() => {
    let rows = this.allDetails();
    const tf = this.detailTypeFilter();
    if (tf !== 'all') rows = rows.filter(r => r.kind === tf);
    const df = this.detailDescFilter().toLowerCase();
    if (df) rows = rows.filter(r => r.description.toLowerCase().includes(df));
    const field = this.sortField();
    const asc = this.sortAsc();
    rows = [...rows].sort((a, b) => {
      const va = field === 'description' ? a.description.toLowerCase() : a.createdAt;
      const vb = field === 'description' ? b.description.toLowerCase() : b.createdAt;
      return asc ? (va < vb ? -1 : va > vb ? 1 : 0)
                 : (va > vb ? -1 : va < vb ? 1 : 0);
    });
    return rows;
  });

  nodeColor = computed(() => {
    const n = this.selectedNode();
    return n ? typeColor(n.type || 'default') : '#8b949e';
  });

  panelTitle = computed(() => {
    const n = this.selectedNode();
    if (n) return n.name;
    const e = this.selectedEdge();
    if (e) return e.label || 'edge';
    return '';
  });

  panelColor = computed(() => {
    const n = this.selectedNode();
    if (n) return typeColor(n.type || 'default');
    const e = this.selectedEdgeRecord();
    if (e) return typeColor(e.label || 'edge');
    return '#8b949e';
  });

  // ── Private state ───────────────────────────────────────────────────────────
  private cy: any = null;
  private subs = new Subscription();

  // Currently rendered (depth-filtered) view
  private graphNodes: TraverseNode[] = [];
  private graphEdges: TraverseEdge[] = [];

  // Full-depth traversal cache — avoids re-fetching shallower depths
  private cacheStartId: string | null = null;
  private cacheDirection: 'outbound' | 'inbound' | 'both' | null = null;
  private cacheMaxDepth = 0;
  private cacheNodes: TraverseNode[] = [];
  private cacheEdges: TraverseEdge[] = [];
  private cacheTruncated = false;

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  ngOnInit(): void {
    // Load spaces only in standalone mode; in embedded mode the space is injected via @Input
    if (!this.isEmbedded()) {
      this.api.listSpaces().subscribe(res => {
        this.spaces.set(res.spaces);
        const qp = this.route.snapshot.queryParams;
        const initial = qp['space'] || (res.spaces.length ? res.spaces[0].id : '');
        this.activeSpaceId.set(initial);

        // If entity query-param present, load it as root
        if (qp['entity'] && initial) {
          this.api.getEntity(initial, qp['entity']).pipe(
            catchError(() => of(null)),
          ).subscribe(ent => {
            if (ent) this.selectRoot(ent);
          });
        }
      });
    }

    this.api.getMe().pipe(catchError(() => of(null))).subscribe(me => {
      this.canEdit.set(me ? !me.readOnly : false);
    });
  }

  ngAfterViewInit(): void {
    this.initCytoscape();

    // Watch direction / depth / hideLabels changes via effect
    // Using effect in AfterViewInit requires the injection context to still be active
    // so we'll use subscriptions on signals via polling or explicit calls.
    // The signals are updated via template bindings and we trigger traverse from those handlers.
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    if (this.cy) {
      this.cy.destroy();
      this.cy = null;
    }
  }

  // ── Cytoscape init ──────────────────────────────────────────────────────────

  private initCytoscape(): void {
    const container = this.cyContainer()?.nativeElement;
    if (!container) return;

    // Glass shine SVG — radial highlight in upper-left quadrant
    const glassShineSvg = (color: string) => {
      const c = encodeURIComponent(color);
      return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><defs><radialGradient id='base' cx='50%25' cy='50%25' r='50%25'><stop offset='0%25' stop-color='${c}' stop-opacity='0.28'/><stop offset='100%25' stop-color='${c}' stop-opacity='0.06'/></radialGradient><radialGradient id='shine' cx='30%25' cy='22%25' r='50%25'><stop offset='0%25' stop-color='white' stop-opacity='0.55'/><stop offset='45%25' stop-color='white' stop-opacity='0.12'/><stop offset='100%25' stop-color='white' stop-opacity='0'/></radialGradient><radialGradient id='rim' cx='50%25' cy='50%25' r='50%25'><stop offset='68%25' stop-color='${c}' stop-opacity='0'/><stop offset='100%25' stop-color='${c}' stop-opacity='0.7'/></radialGradient><radialGradient id='bot' cx='58%25' cy='80%25' r='38%25'><stop offset='0%25' stop-color='${c}' stop-opacity='0.18'/><stop offset='100%25' stop-color='${c}' stop-opacity='0'/></radialGradient></defs><circle cx='50' cy='50' r='49' fill='url(%23base)'/><circle cx='50' cy='50' r='49' fill='url(%23rim)'/><circle cx='50' cy='50' r='49' fill='url(%23bot)'/><circle cx='50' cy='50' r='49' fill='url(%23shine)'/></svg>`;
    };

    this.cy = cytoscape({
      container,
      elements: [],
      style: [
        {
          selector: 'node',
          style: {
            'width': (ele: any) => { const d = +ele.data('depth'); return d === 0 ? 68 : Math.max(36, 52 - d * 3); },
            'height': (ele: any) => { const d = +ele.data('depth'); return d === 0 ? 68 : Math.max(36, 52 - d * 3); },
            'background-color': '#0d1117',
            'background-image': (ele: any) => glassShineSvg(typeColor(ele.data('type') || 'default')),
            'background-fit': 'cover',
            'background-clip': 'node',
            'border-width': (ele: any) => +ele.data('depth') === 0 ? 2.5 : 1.5,
            'border-color': (ele: any) => typeColor(ele.data('type') || 'default'),
            'border-opacity': 0.75,
            'label': 'data(label)',
            'font-size': (ele: any) => +ele.data('depth') === 0 ? 13 : 11,
            'font-weight': (ele: any) => +ele.data('depth') === 0 ? '600' : '400',
            'color': '#c9d1d9',
            'text-outline-color': '#0d1117',
            'text-outline-width': 2,
            'text-valign': 'bottom',
            'text-margin-y': 8,
            'text-max-width': '110px',
            'text-wrap': 'ellipsis',
            'opacity': (ele: any) => { const d = +ele.data('depth'); return d === 0 ? 1 : Math.max(0.55, 1 - d * 0.1); },
            'shadow-blur': (ele: any) => +ele.data('depth') === 0 ? 28 : 14,
            'shadow-color': (ele: any) => typeColor(ele.data('type') || 'default'),
            'shadow-opacity': (ele: any) => +ele.data('depth') === 0 ? 0.6 : 0.35,
            'shadow-offset-x': 0,
            'shadow-offset-y': 0,
          } as any,
        },
        {
          selector: 'node.root',
          style: {
            'border-color': '#7c6af7',
            'border-width': 3,
            'border-opacity': 1,
          } as any,
        },
        {
          selector: 'node.hovered',
          style: {
            'border-width': 2.5,
            'border-opacity': 1,
            'opacity': 1,
            'shadow-blur': 30,
            'shadow-opacity': 0.8,
          } as any,
        },
        {
          selector: 'node:selected',
          style: {
            'border-color': '#58a6ff',
            'border-width': 3,
            'border-opacity': 1,
            'opacity': 1,
            'shadow-blur': 36,
            'shadow-color': '#58a6ff',
            'shadow-opacity': 0.9,
          } as any,
        },
        {
          selector: 'edge',
          style: {
            'width': 1.5,
            'line-color': '#3d444d',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#3d444d',
            'curve-style': 'bezier',
            'label': 'data(label)',
            'font-size': 10,
            'color': '#6e7681',
            'text-rotation': 'autorotate',
            'text-margin-y': -8,
            'text-background-color': '#0d1117',
            'text-background-opacity': 0.7,
            'text-background-padding': '2px',
            'opacity': 0.75,
            'shadow-blur': 0,
          } as any,
        },
        {
          selector: 'edge.hovered',
          style: {
            'line-color': '#58a6ff',
            'target-arrow-color': '#58a6ff',
            'opacity': 1,
            'width': 2.5,
            'shadow-blur': 12,
            'shadow-color': '#58a6ff',
            'shadow-opacity': 0.6,
            'shadow-offset-x': 0,
            'shadow-offset-y': 0,
          } as any,
        },
        {
          selector: 'edge:selected',
          style: {
            'line-color': '#7c6af7',
            'target-arrow-color': '#7c6af7',
            'opacity': 1,
            'width': 2.5,
            'shadow-blur': 16,
            'shadow-color': '#7c6af7',
            'shadow-opacity': 0.7,
            'shadow-offset-x': 0,
            'shadow-offset-y': 0,
          } as any,
        },
        {
          selector: 'edge.hide-labels',
          style: {
            'label': '',
          } as any,
        },
      ],
      layout: { name: 'grid' },
      minZoom: 0.1,
      maxZoom: 5,
      wheelSensitivity: 0.25,
    });

    // Node tap → select + show detail panel
    this.cy.on('tap', 'node', (evt: any) => {
      const node = evt.target;
      const id = node.data('id');
      // graphNodes does NOT include the root node (added separately in renderGraph)
      let tn = this.graphNodes.find(n => n._id === id);
      if (!tn) {
        const root = this.rootEntity();
        if (root && root._id === id) {
          tn = { _id: root._id, name: root.name, type: root.type || 'default', depth: 0, description: root.description, tags: root.tags };
        }
      }
      if (tn) {
        this.selectedEdge.set(null);
        this.selectedEdgeRecord.set(null);
        this.selectedEntityRecord.set(null);
        this.selectedNode.set(tn);
        this.loadNodeDetails(id);
      }
    });

    // Edge tap → show edge side panel
    this.cy.on('tap', 'edge', (evt: any) => {
      const edgeId = evt.target.data('id');
      const te = this.graphEdges.find(e => e._id === edgeId);
      if (te) {
        this.selectedNode.set(null);
        this.selectedEdge.set(te);
        this.loadEdgeDetails(te);
      }
    });

    // Double-tap node → re-root
    this.cy.on('dbltap', 'node', (evt: any) => {
      const id = evt.target.data('id');
      const spaceId = this.activeSpaceId();
      if (!spaceId) return;
      this.api.getEntity(spaceId, id).pipe(
        catchError(() => of(null)),
      ).subscribe(ent => {
        if (ent) this.selectRoot(ent, true);
      });
    });

    // Hover effects
    this.cy.on('mouseover', 'node', (evt: any) => { evt.target.addClass('hovered'); });
    this.cy.on('mouseout',  'node', (evt: any) => { evt.target.removeClass('hovered'); });
    this.cy.on('mouseover', 'edge', (evt: any) => { evt.target.addClass('hovered'); });
    this.cy.on('mouseout',  'edge', (evt: any) => { evt.target.removeClass('hovered'); });

    // Background tap → deselect
    this.cy.on('tap', (evt: any) => {
      if (evt.target === this.cy) {
        this.selectedNode.set(null);
        this.selectedEdge.set(null);
        this.selectedEdgeRecord.set(null);
      }
    });
  }

  // ── Toolbar handlers ────────────────────────────────────────────────────────

  onSearchQueryChange(q: string): void {
    this.searchQuery.set(q);
  }

  onSpaceChange(spaceId: string): void {
    this.activeSpaceId.set(spaceId);
    this.resetGraph();
  }

  onSearchInput(query: string): void {
    this.searchQuery.set(query);
  }

  onDepthChange(val: number | string): void {
    this.depth.set(+val);
    if (this.rootEntity()) {
      this.traverse(this.rootEntity()!._id, +val, this.direction());
    }
  }

  setDirection(dir: 'outbound' | 'inbound' | 'both'): void {
    this.direction.set(dir);
    if (this.rootEntity()) {
      this.traverse(this.rootEntity()!._id, this.depth(), dir);
    }
  }

  onHideLabelsChange(hide: boolean): void {
    this.hideLabels.set(hide);
    if (this.cy) {
      if (hide) {
        this.cy.edges().addClass('hide-labels');
      } else {
        this.cy.edges().removeClass('hide-labels');
      }
    }
  }

  selectRoot(entity: Entity, pushHistory = false): void {
    this.rootEntity.set(entity);
    this.searchQuery.set(entity.name);
    this.selectedNode.set(null);
    this.selectedEntityRecord.set(null);
    this.selectedEdge.set(null);
    this.selectedEdgeRecord.set(null);
    this.nodeMemories.set([]);
    this.nodeChrono.set([]);
    if (!this.isEmbedded()) this.updateUrl(entity._id, pushHistory);
    this.traverse(entity._id, this.depth(), this.direction());
  }

  fitGraph(): void {
    if (this.cy) this.cy.fit(undefined, 40);
  }

  resetGraph(): void {
    this.rootEntity.set(null);
    this.selectedNode.set(null);
    this.selectedEntityRecord.set(null);
    this.selectedEdge.set(null);
    this.selectedEdgeRecord.set(null);
    this.nodeMemories.set([]);
    this.nodeChrono.set([]);
    this.searchQuery.set('');
    this.truncated.set(false);
    this.graphNodes = [];
    this.graphEdges = [];
    this.cacheStartId = null;
    this.cacheDirection = null;
    this.cacheMaxDepth = 0;
    this.cacheNodes = [];
    this.cacheEdges = [];
    this.cacheTruncated = false;
    if (this.cy) {
      this.cy.elements().remove();
    }
  }

  // ── Graph traversal ─────────────────────────────────────────────────────────

  private traverse(startId: string, maxDepth: number, direction: 'outbound' | 'inbound' | 'both'): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;

    this.selectedNode.set(null);
    this.selectedEntityRecord.set(null);
    this.selectedEdge.set(null);
    this.selectedEdgeRecord.set(null);

    const sameRoot = this.cacheStartId === startId && this.cacheDirection === direction;

    // Depth decrease (or same depth): serve from cache — no network request needed
    if (sameRoot && maxDepth <= this.cacheMaxDepth) {
      this.applyDepthFilter(startId, maxDepth);
      return;
    }

    // Depth increase into an un-truncated cache: fetch only the new frontier and merge
    const incremental = sameRoot && maxDepth > this.cacheMaxDepth && !this.cacheTruncated;

    this.loading.set(true);
    this.api.traverseGraph(spaceId, { startId, direction, maxDepth, limit: 200 }).pipe(
      catchError(() => of({ nodes: [], edges: [], truncated: false } as TraverseResult)),
    ).subscribe(result => {
      this.loading.set(false);

      if (incremental) {
        // Merge only the new nodes/edges into the existing cache
        const knownNodes = new Set(this.cacheNodes.map(n => n._id));
        const knownEdges = new Set(this.cacheEdges.map(e => e._id));
        for (const n of result.nodes) if (!knownNodes.has(n._id)) this.cacheNodes.push(n);
        for (const e of result.edges) if (!knownEdges.has(e._id)) this.cacheEdges.push(e);
      } else {
        this.cacheNodes = result.nodes;
        this.cacheEdges = result.edges;
      }

      this.cacheStartId = startId;
      this.cacheDirection = direction;
      this.cacheMaxDepth = maxDepth;
      this.cacheTruncated = result.truncated;

      this.truncated.set(result.truncated);
      this.applyDepthFilter(startId, maxDepth);
    });
  }

  // Filter the full cache down to the requested depth and re-render
  private applyDepthFilter(startId: string, maxDepth: number): void {
    this.graphNodes = this.cacheNodes.filter(n => n.depth <= maxDepth);
    const visibleIds = new Set<string>(this.graphNodes.map(n => n._id));
    visibleIds.add(startId);  // root node always included
    this.graphEdges = this.cacheEdges.filter(e => visibleIds.has(e.from) && visibleIds.has(e.to));
    this.renderGraph(startId);
  }

  private renderGraph(rootId: string): void {
    if (!this.cy) return;

    this.cy.resize();  // ensure canvas matches current container dimensions
    this.cy.elements().remove();

    const elements: any[] = [];

    // Add the root node (not included in traverse result)
    const root = this.rootEntity();
    if (root) {
      elements.push({
        group: 'nodes',
        data: { id: root._id, label: root.name, type: root.type || 'default', depth: 0 },
        classes: 'root',
      });
    }

    for (const n of this.graphNodes) {
      // Skip if root was already added
      if (n._id === rootId) continue;
      elements.push({
        group: 'nodes',
        data: { id: n._id, label: n.name, type: n.type || 'default', depth: n.depth },
      });
    }

    for (const e of this.graphEdges) {
      elements.push({
        group: 'edges',
        data: { id: e._id, source: e.from, target: e.to, label: e.label },
      });
    }

    this.cy.add(elements);
    this.nodeCount.set(elements.filter((e: any) => e.group === 'nodes').length);
    this.edgeCount.set(elements.filter((e: any) => e.group === 'edges').length);

    // Apply hide-labels class to edges
    if (this.hideLabels()) {
      this.cy.edges().addClass('hide-labels');
    } else {
      this.cy.edges().removeClass('hide-labels');
    }

    // Run layout
    const layout = this.cy.layout({
      name: 'cose',
      animate: true,
      animationDuration: 400,
      nodeRepulsion: () => 80000,
      idealEdgeLength: () => 1000,
      gravity: 0.08,
      padding: 40,
    } as any);

    layout.on('layoutstop', () => {
      if (this.cy) {
        // Fit all nodes then zoom out so the full graph breathes
        this.cy.fit(undefined, 60);
        this.cy.zoom(this.cy.zoom() * 0.55);
        // Pan so root node sits at viewport centre
        const root = this.rootEntity();
        const rootNode = root ? this.cy.getElementById(root._id) : null;
        if (rootNode && rootNode.length) this.cy.center(rootNode);
      }
      // Auto-select root node on first render
      const root = this.rootEntity();
      if (root && !this.selectedNode() && !this.selectedEdge()) {
        const rootTn: TraverseNode = { _id: root._id, name: root.name, type: root.type || 'default', depth: 0, description: root.description, tags: root.tags };
        this.selectedNode.set(rootTn);
        this.loadNodeDetails(root._id);
      }
    });
    layout.run();
  }

  // ── Detail panel helpers ────────────────────────────────────────────────────

  private loadNodeDetails(entityId: string): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;

    // Fetch full entity record for the record card
    this.api.getEntity(spaceId, entityId).pipe(
      catchError(() => of(null)),
    ).subscribe(ent => { if (ent) this.selectedEntityRecord.set(ent); });

    forkJoin({
      mems: this.api.listMemories(spaceId, 100, 0, { entity: entityId }).pipe(
        catchError(() => of({ memories: [] as Memory[] })),
      ),
      chrono: this.api.queryBrain(spaceId, {
        collection: 'chrono',
        filter: { entityIds: entityId },
        limit: 100,
      }).pipe(
        catchError(() => of({ results: [] as Record<string, unknown>[], collection: 'chrono' as const, count: 0 })),
      ),
    }).subscribe(({ mems, chrono }) => {
      this.nodeMemories.set(mems.memories);
      this.nodeChrono.set(chrono.results as unknown as ChronoEntry[]);
    });
  }

  toggleSort(field: 'description' | 'createdAt'): void {
    if (this.sortField() === field) {
      this.sortAsc.set(!this.sortAsc());
    } else {
      this.sortField.set(field);
      this.sortAsc.set(true);
    }
  }

  sortArrow(field: 'description' | 'createdAt'): string {
    return this.sortField() === field ? (this.sortAsc() ? '▲' : '▼') : '';
  }

  openEntityPopup(node: TraverseNode): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.api.getEntity(spaceId, node._id).pipe(
      catchError(() => of(null)),
    ).subscribe(ent => {
      if (ent) {
        this.popupRecord.set(ent as unknown as Record<string, unknown>);
        this.popupType.set('entity');
      }
    });
  }

  private loadEdgeDetails(te: TraverseEdge): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.nodeMemories.set([]);
    this.nodeChrono.set([]);

    // Load the full edge record
    this.api.getEdge(spaceId, te._id).pipe(
      catchError(() => of(null)),
    ).subscribe(edge => {
      if (edge) this.selectedEdgeRecord.set(edge);
    });

    // Load memories/chronos linked to BOTH endpoints
    forkJoin({
      mems: this.api.listMemories(spaceId, 100, 0, { entity: te.from }).pipe(
        catchError(() => of({ memories: [] as Memory[] })),
      ),
      chrono: this.api.queryBrain(spaceId, {
        collection: 'chrono',
        filter: { entityIds: te.from },
        limit: 100,
      }).pipe(
        catchError(() => of({ results: [] as Record<string, unknown>[], collection: 'chrono' as const, count: 0 })),
      ),
    }).subscribe(({ mems, chrono }) => {
      // filter to those also referencing te.to
      const filteredMems = mems.memories.filter(m =>
        Array.isArray((m as any).entityIds) && (m as any).entityIds.includes(te.to)
      );
      const filteredChrono = (chrono.results as unknown as ChronoEntry[]).filter(c =>
        Array.isArray(c.entityIds) && c.entityIds.includes(te.from) && c.entityIds.includes(te.to)
      );
      this.nodeMemories.set(filteredMems);
      this.nodeChrono.set(filteredChrono);
    });
  }

  openDetailPopup(row: DetailRow): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    if (row.kind === 'memory') {
      this.api.getMemory(spaceId, row.id).pipe(catchError(() => of(null))).subscribe(m => {
        if (m) this.openBrainDrawer('memory', m);
      });
    } else {
      this.api.getChrono(spaceId, row.id).pipe(catchError(() => of(null))).subscribe(c => {
        if (c) this.openBrainDrawer('chrono', c);
      });
    }
  }

  openBrainDrawer(kind: 'memory' | 'chrono', record: any): void {
    this.drawerError.set('');
    this.drawerSaving.set(false);
    this.flyoutField.set('');
    const ids: string[] = record.entityIds ?? [];
    if (ids.length) this.resolveEntityNamesById(ids);
    if (kind === 'memory') {
      this.drawerEditMemory = {
        fact: record.fact ?? '',
        tags: [...(record.tags ?? [])],
        entityIds: (record.entityIds ?? []).join(', '),
        description: record.description ?? '',
        properties: { ...(record.properties ?? {}) },
      };
    } else {
      const isPredefined = this.chronoKinds.includes(record.type as ChronoType);
      this.drawerEditChrono = {
        title: record.title ?? '',
        kind: isPredefined ? record.type : '__custom__',
        customKind: isPredefined ? '' : (record.type ?? ''),
        status: record.status ?? 'upcoming',
        startsAt: record.startsAt ? this.toLocalDatetime(record.startsAt) : '',
        endsAt: record.endsAt ? this.toLocalDatetime(record.endsAt) : '',
        description: record.description ?? '',
        tags: [...(record.tags ?? [])],
        entityIds: (record.entityIds ?? []).join(', '),
        memoryIds: (record.memoryIds ?? []).join(', '),
      };
    }
    this.drawerRecord.set({ kind, record });
  }

  closeBrainDrawer(): void {
    this.drawerRecord.set(null);
    this.drawerError.set('');
    this.flyoutField.set('');
  }

  saveBrainDrawer(): void {
    const dr = this.drawerRecord();
    if (!dr) return;
    const spaceId = this.activeSpaceId();
    const id = dr.record._id;
    this.drawerSaving.set(true);
    this.drawerError.set('');
    if (dr.kind === 'memory') {
      const props = this.drawerEditMemory.properties;
      this.api.updateMemory(spaceId, id, {
        fact: this.drawerEditMemory.fact.trim(),
        tags: this.drawerEditMemory.tags,
        entityIds: this.drawerEditMemory.entityIds.split(',').map(s => s.trim()).filter(Boolean),
        description: this.drawerEditMemory.description.trim(),
        ...(Object.keys(props).length ? { properties: props } : {}),
      }).subscribe({
        next: (updated) => {
          this.drawerSaving.set(false);
          this.drawerRecord.set({ kind: 'memory', record: updated });
          this.nodeMemories.update(list => list.map(m => m._id === id ? updated : m));
        },
        error: (err) => { this.drawerSaving.set(false); this.drawerError.set(err?.error?.error ?? err?.message ?? 'Save failed'); },
      });
    } else {
      const resolvedKind = this.drawerEditChrono.kind === '__custom__'
        ? (this.drawerEditChrono.customKind.trim() as ChronoType)
        : this.drawerEditChrono.kind as ChronoType;
      this.api.updateChrono(spaceId, id, {
        title: this.drawerEditChrono.title.trim(),
        type: resolvedKind,
        status: this.drawerEditChrono.status as ChronoStatus,
        ...(this.drawerEditChrono.startsAt ? { startsAt: new Date(this.drawerEditChrono.startsAt).toISOString() } : {}),
        ...(this.drawerEditChrono.endsAt ? { endsAt: new Date(this.drawerEditChrono.endsAt).toISOString() } : {}),
        description: this.drawerEditChrono.description.trim(),
        tags: this.drawerEditChrono.tags,
        entityIds: this.drawerEditChrono.entityIds.split(',').map(s => s.trim()).filter(Boolean),
        ...(this.drawerEditChrono.memoryIds.trim() ? { memoryIds: this.drawerEditChrono.memoryIds.split(',').map(s => s.trim()).filter(Boolean) } : {}),
      }).subscribe({
        next: (updated) => {
          this.drawerSaving.set(false);
          this.drawerRecord.set({ kind: 'chrono', record: updated });
          this.nodeChrono.update(list => list.map(c => c._id === id ? updated : c));
        },
        error: (err) => { this.drawerSaving.set(false); this.drawerError.set(err?.error?.error ?? err?.message ?? 'Save failed'); },
      });
    }
  }

  entityChips(ids: string): Array<{ id: string; name: string }> {
    const cache = this.entityNameCache();
    return ids.split(',').map(s => s.trim()).filter(Boolean).map(id => ({ id, name: cache[id] ?? id }));
  }

  removeEntityId(target: { entityIds: string }, id: string): void {
    target.entityIds = target.entityIds.split(',').map(s => s.trim()).filter(s => s && s !== id).join(', ');
  }

  openFlyout(key: string): void {
    this.flyoutField.set(key);
    let ids = '';
    if (key === 'drawer-memory-entityIds') ids = this.drawerEditMemory.entityIds;
    if (key === 'drawer-chrono-entityIds') ids = this.drawerEditChrono.entityIds;
    const spaceId = this.activeSpaceId();
    if (spaceId && ids) {
      const unknown = ids.split(',').map(s => s.trim()).filter(s => s && !this.entityNameCache()[s]);
      if (unknown.length) this.resolveEntityNamesById(unknown);
    }
  }

  closeFlyout(): void { this.flyoutField.set(''); }

  pickDrawerEntity(ent: Entity, field: string): void {
    this.entityNameCache.update(c => ({ ...c, [ent._id]: ent.name }));
    if (field === 'drawer-memory-entityIds') {
      const parts = this.drawerEditMemory.entityIds.split(',').map(s => s.trim()).filter(Boolean);
      if (!parts.includes(ent._id)) parts.push(ent._id);
      this.drawerEditMemory.entityIds = parts.join(', ');
    } else if (field === 'drawer-chrono-entityIds') {
      const parts = this.drawerEditChrono.entityIds.split(',').map(s => s.trim()).filter(Boolean);
      if (!parts.includes(ent._id)) parts.push(ent._id);
      this.drawerEditChrono.entityIds = parts.join(', ');
    }
  }

  private resolveEntityNamesById(ids: string[]): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId || !ids.length) return;
    const unknown = ids.filter(id => !this.entityNameCache()[id]);
    if (!unknown.length) return;
    this.api.getEntitiesByIds(spaceId, unknown).subscribe({
      next: ({ entities }) => {
        const patch: Record<string, string> = {};
        for (const e of entities) patch[e._id] = e.name;
        this.entityNameCache.update(c => ({ ...c, ...patch }));
      },
      error: () => {},
    });
  }

  private toLocalDatetime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  asRecord(obj: unknown): Record<string, unknown> {
    return obj as Record<string, unknown>;
  }

  objectKeys(obj: Record<string, unknown>): string[] {
    return Object.keys(obj);
  }

  closePopup(): void {
    this.popupRecord.set(null);
  }

  onPopupSaved(_evt: Record<string, unknown>): void {
    this.popupRecord.set(null);
    const root = this.rootEntity();
    if (root) {
      this.traverse(root._id, this.depth(), this.direction());
      const sel = this.selectedNode();
      if (sel) this.loadNodeDetails(sel._id);
      const edge = this.selectedEdge();
      if (edge) this.loadEdgeDetails(edge);
    }
  }

  // ── URL management ──────────────────────────────────────────────────────────
  private updateUrl(entityId: string, push = false): void {
    const spaceId = this.activeSpaceId();
    const path = this.location.path().split('?')[0];
    const qs = `space=${spaceId}&entity=${entityId}`;
    if (push) {
      this.location.go(path, qs);
    } else {
      this.location.replaceState(path, qs);
    }
  }
}
