import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, Space, SpaceStats, Memory, Entity, Edge, ChronoEntry, ChronoType, ChronoStatus, QueryCollection, QueryResult, RecallResult, RecallKnowledgeType, SpaceMetaResponse, KnowledgeType, PropertySchema, FileMeta } from '../../core/api.service';
import { GraphComponent } from '../graph/graph.component';
import { FileManagerComponent } from '../files/file-manager.component';
import { EntitySearchComponent } from '../../shared/entity-search.component';
import { PropertiesViewComponent } from '../../shared/properties-view.component';
import { PropertiesEditorComponent } from '../../shared/properties-editor.component';
import { TagInputComponent } from '../../shared/tag-input.component';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { catchError, of } from 'rxjs';
import { TranslocoPipe } from '@jsverse/transloco';

type BrainTab = 'query' | 'graph' | 'files' | 'entities' | 'edges' | 'memories' | 'chrono' | 'filemeta';

interface SpaceView {
  space: Space;
  stats?: SpaceStats;
}

@Component({
  selector: 'app-brain',
  standalone: true,
  imports: [CommonModule, FormsModule, GraphComponent, FileManagerComponent, EntitySearchComponent, PropertiesViewComponent, PropertiesEditorComponent, TagInputComponent, PhIconComponent, TranslocoPipe],
  styles: [`
    .space-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
      overflow-x: auto;
      padding-bottom: 4px;
    }

    .space-chip {
      padding: 6px 14px;
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
      gap: 2px;
      min-width: 110px;
    }

    .space-chip:hover { border-color: var(--accent); color: var(--text-primary); }

    .space-chip.active {
      background: var(--accent-dim);
      border-color: var(--accent);
      color: var(--accent);
    }

    .space-chip-label { font-size: 13px; font-weight: 500; }
    .space-chip-id { font-size: 10px; color: var(--text-muted); }
    .space-chip-count {
      font-size: 10px;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }
    .space-chip.active .space-chip-count { color: var(--accent); opacity: 0.8; }

    .content-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }

    .tab-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-elevated);
      border-radius: 10px;
      padding: 1px 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      margin-left: 5px;
      min-width: 20px;
      font-variant-numeric: tabular-nums;
    }

    .tab.active .tab-count {
      background: var(--accent-dim);
      color: var(--accent);
    }

    .tab-files-info {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 8px 12px;
      font-size: 12px;
      color: var(--text-muted);
      border-bottom: 2px solid transparent;
      text-decoration: none;
      cursor: pointer;
      transition: color var(--transition), border-color var(--transition);
      white-space: nowrap;
    }
    .tab-files-info:hover {
      color: var(--text-primary);
      border-bottom-color: var(--border);
      text-decoration: none;
    }

    .memory-item {
      padding: 14px 16px;
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .filter-bar-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .filter-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid var(--accent);
      background: var(--accent-dim);
      color: var(--accent);
    }
    .filter-chip button {
      background: none;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 2px;
    }
    .tag-clickable, .entity-clickable {
      cursor: pointer;
      transition: opacity var(--transition);
    }
    .tag-clickable:hover, .entity-clickable:hover { opacity: 0.7; }

    .create-form {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      flex-wrap: wrap;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
      margin-bottom: 12px;
    }
    .create-form .field { margin-bottom: 0; }
    .create-form label { font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 2px; }
    .create-form input, .create-form textarea {
      padding: 5px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 13px;
      background: var(--bg-primary);
      color: var(--text-primary);
    }
    .create-form textarea { resize: vertical; }

    .chrono-desc-preview {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
      white-space: pre-wrap;
      max-width: 280px;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .reindex-banner {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 14px;
      margin-bottom: 12px;
      border: 1px solid var(--warning);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--warning) 6%, transparent);
      font-size: 13px;
      color: var(--text-secondary);
    }
    .reindex-result {
      font-size: 12px;
      color: var(--text-muted);
      margin-left: auto;
    }

    .content-header input[type=search] {
      flex: 1;
      min-width: 180px;
      max-width: 400px;
      padding: 5px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 13px;
      background: var(--bg-surface);
      color: var(--text-primary);
    }
    .content-header app-entity-search {
      flex: 1;
      min-width: 180px;
      max-width: 520px;
    }

    .inline-confirm {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--error);
    }
    .inline-confirm button { font-size: 11px; }

    .memory-description {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
      line-height: 1.4;
    }

    .query-panel {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .query-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .query-form-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: flex-end;
    }
    .query-form-row .field { margin: 0; }
    .query-textarea {
      width: 100%;
      font-family: var(--font-mono, monospace);
      font-size: 12px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg-surface);
      color: var(--text-primary);
      resize: vertical;
      min-height: 64px;
    }
    .query-textarea.error { border-color: var(--error); }
    .query-results-header {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .query-results-header strong { color: var(--text-primary); }
    .query-result-card {
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--text-secondary);
    }
    .query-empty {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-muted);
      font-size: 14px;
    }
    .dialog-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .dialog {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      width: 90%;
      max-width: 600px;
      max-height: 90vh;
      overflow-y: auto;
    }
    .dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .entity-picker-wrap {
      position: relative;
    }
    .entity-picker-dropdown {
      position: absolute;
      top: calc(100% + 2px);
      left: 0;
      min-width: 300px;
      max-height: 240px;
      overflow-y: auto;
      z-index: 50;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-md);
    }
    .entity-picker-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      cursor: pointer;
      font-size: 12px;
      border-bottom: 1px solid var(--border-muted);
    }
    .entity-picker-item:last-child { border-bottom: none; }
    .entity-picker-item:hover { background: var(--bg-surface); }
    .entity-picker-name { font-weight: 500; color: var(--text-primary); white-space: nowrap; }
    .entity-picker-desc {
      font-size: 11px; color: var(--text-muted); flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .entity-picker-id {
      font-size: 10px; color: var(--text-muted);
      font-family: var(--font-mono, monospace); margin-left: auto; flex-shrink: 0;
    }
    .tab-spacer { flex: 1; }

    .flyout-backdrop { position: fixed; inset: 0; z-index: 55; }
    .flyout-wrap { position: relative; display: block; width: 100%; }
    .flyout-trigger {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
      font-size: 12px; background: var(--bg-primary); color: var(--text-secondary);
      cursor: pointer; width: 100%; text-align: left; transition: border-color var(--transition);
    }
    .flyout-trigger:hover { border-color: var(--accent); color: var(--text-primary); }
    .flyout-trigger.has-value { color: var(--text-primary); }
    .flyout-panel {
      position: absolute; top: calc(100% + 4px); left: 0; min-width: 300px; z-index: 60;
      background: var(--bg-primary); border: 1px solid var(--border);
      border-radius: var(--radius-md); box-shadow: var(--shadow-lg); padding: 12px;
    }
    .chip-list { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; min-height: 24px; }
    .chip {
      display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px;
      border-radius: 10px; background: var(--accent-dim); border: 1px solid var(--accent);
      color: var(--accent); font-size: 11px; font-weight: 500; max-width: 200px;
    }
    .chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip-remove {
      background: none; border: none; color: var(--accent); cursor: pointer;
      font-size: 13px; line-height: 1; padding: 0 1px; flex-shrink: 0;
    }
    .entity-multi { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; min-height: 28px; padding: 2px 0; }
    .chip-add { font-size: 11px; padding: 2px 8px; background: transparent;
      border: 1px dashed var(--border); border-radius: 10px;
      color: var(--text-muted); cursor: pointer;
    }
    .chip-add:hover { border-color: var(--accent); color: var(--accent); }
    .link-btn {
      background: none; border: none; cursor: pointer; color: var(--accent);
      text-decoration: underline; padding: 0; font-size: inherit; text-align: left;
    }
    .link-btn:hover { color: var(--accent-light, var(--accent)); }
    .icon-btn-danger { color: var(--error); }
    .icon-btn-danger:hover { color: var(--error); }
    .flyout-result:hover { background: var(--bg-secondary); }
    .drawer-overlay {
      position: fixed; inset: 0; background: var(--bg-scrim);
      z-index: 200; display: flex; justify-content: flex-end;
    }
    .drawer {
      width: min(480px, 100vw); background: var(--bg-primary); height: 100%;
      overflow-y: auto; padding: 20px 24px;
      box-shadow: var(--shadow-drawer);
      display: flex; flex-direction: column;
      animation: drawer-in .18s ease;
    }
    @keyframes drawer-in { from { transform: translateX(100%); } to { transform: translateX(0); } }
    .drawer-header {
      display: flex; justify-content: space-between; align-items: flex-start;
      margin-bottom: 20px; padding-bottom: 14px;
      border-bottom: 1px solid var(--border); gap: 12px;
    }
    .drawer-title { font-size: 16px; font-weight: 600; color: var(--text-primary); word-break: break-word; }
    .drawer-field { margin-bottom: 16px; }
    .drawer-label {
      font-size: 10px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px;
    }
    .drawer-value { font-size: 13px; color: var(--text-primary); white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
    .drawer-muted { color: var(--text-muted); }
    .drawer-hr { border: none; border-top: 1px solid var(--border-muted); margin: 16px 0; }
    .drawer-readonly-value {
      font-size: 13px; color: var(--text-muted); padding: 5px 8px;
      border: 1px solid var(--border-muted); border-radius: var(--radius-sm);
      background: var(--bg-surface); word-break: break-all; line-height: 1.4;
    }
    .drawer input[type=text], .drawer input[type=number], .drawer input[type=datetime-local],
    .drawer textarea, .drawer select {
      width: 100%; padding: 5px 8px; border: 1px solid var(--border);
      border-radius: var(--radius-sm); font-size: 13px;
      background: var(--bg-primary); color: var(--text-primary); box-sizing: border-box;
    }
    .drawer textarea { resize: vertical; }
    .drawer select { cursor: pointer; }
    .pill-group { display:flex; border:1px solid var(--border); border-radius:var(--radius-sm); overflow:hidden; flex-shrink:0; }
    .pill-group button { padding:5px 10px; font-size:11px; background:transparent; border:none; border-right:1px solid var(--border); color:var(--text-secondary); cursor:pointer; white-space:nowrap; }
    .pill-group button:last-child { border-right:none; }
    .pill-group button.active { background:var(--accent-dim); color:var(--accent); }
    .pill-group button:hover:not(.active) { background:var(--bg-surface); }
  `],
  template: `
    @if (loadingSpaces()) {
      <div class="loading-overlay"><span class="spinner"></span> {{ 'brain.loadingSpaces' | transloco }}</div>
    } @else if (spaces().length === 0) {
      <div class="empty-state">
        <div class="empty-state-icon"><ph-icon name="package" [size]="48"/></div>
        <h3>{{ 'brain.emptySpaces.title' | transloco }}</h3>
        <p>{{ 'brain.emptySpaces.body' | transloco }}</p>
      </div>
    } @else {

      @if (flyoutField()) { <div class="flyout-backdrop" (click)="closeFlyout()"></div> }

      <!-- Space selector -->
      <div class="space-tabs">
        @for (sv of spaces(); track sv.space.id) {
          <button
            class="space-chip"
            [class.active]="activeSpaceId() === sv.space.id"
            (click)="selectSpace(sv.space.id)"
          >
            <span class="space-chip-label">{{ sv.space.label }}</span>
            <span class="space-chip-id">{{ sv.space.id }}</span>
            @if (sv.stats) {
              <span class="space-chip-count">{{ spaceTotal(sv.stats) }} {{ 'brain.spaceChip.records' | transloco }}</span>
            }
          </button>
        }
      </div>

      @if (needsReindex()) {
        <div class="reindex-banner">
          <span><ph-icon name="warning" [size]="16" style="display:inline-flex;vertical-align:middle;margin-right:4px;"/> {{ 'brain.reindex.stale' | transloco }}</span>
          <button class="btn btn-sm btn-primary" [disabled]="reindexing()" (click)="runReindex()">
            @if (reindexing()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
            {{ 'brain.reindex.button' | transloco }}
          </button>
          @if (reindexResult()) { <span class="reindex-result">{{ reindexResult() }}</span> }
        </div>
      }
      @if (!needsReindex() && reindexResult()) {
        <div class="alert alert-success" style="margin-bottom:10px; font-size:13px;"><ph-icon name="check" [size]="14" style="display:inline-flex;vertical-align:middle;margin-right:4px;"/> {{ reindexResult() }}</div>
      }

      <!-- Sub-tabs: Query on left, collections on right -->
      <div class="tabs">
        <button class="tab" [class.active]="activeTab() === 'query'" (click)="setTab('query')">
          <ph-icon name="magnifying-glass" [size]="15" style="display:inline-flex;vertical-align:middle;margin-right:4px;"/> {{ 'brain.tab.query' | transloco }}
        </button>
        <button class="tab" [class.active]="activeTab() === 'graph'" (click)="setTab('graph')">
          <ph-icon name="binoculars" [size]="15" style="display:inline-flex;vertical-align:middle;margin-right:4px;"/> {{ 'brain.tab.graph' | transloco }}
        </button>
        <button class="tab" [class.active]="activeTab() === 'files'" (click)="setTab('files')">
          <ph-icon name="folder" [size]="15" style="display:inline-flex;vertical-align:middle;margin-right:4px;"/> {{ 'brain.tab.files' | transloco }}
          @if (activeStats(); as s) {
            <span class="tab-count">{{ s.files }}</span>
          }
        </button>
        <span class="tab-spacer"></span>
        @for (tab of collectionTabs; track tab.key) {
          <button class="tab" [class.active]="activeTab() === tab.key" (click)="setTab(tab.key)">
            {{ tab.label }}
            @if (activeStats(); as s) {
              @if (tab.statsKey) {
                <span class="tab-count">{{ s[tab.statsKey] }}</span>
              }
            }
          </button>
        }
      </div>

      <!-- Content -->
      @if (loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else {

        <!-- Graph tab -->
        @if (activeTab() === 'graph') {
          <app-graph-view [embeddedSpaceId]="activeSpaceId()" />
        }

        <!-- Files tab -->
        @if (activeTab() === 'files') {
          <app-file-manager [embeddedSpaceId]="activeSpaceId()" [navigatePath]="fileManagerNavPath()" (viewFileMeta)="openFileMetaEntry($event)" (fileDeleted)="loadStats(activeSpaceId())" />
        }

        <!-- Memories -->
        @if (activeTab() === 'memories') {

          <div class="content-header">
            <input type="search"
              [placeholder]="'brain.memories.searchPlaceholder' | transloco"
              [value]="memorySearch()"
              (input)="onMemorySearch($any($event.target).value)"
              [attr.aria-label]="'brain.memories.searchPlaceholder' | transloco" />
            <div class="pill-group" [attr.title]="'common.searchMode.tooltip' | transloco">
              <button [class.active]="memorySearchMode() === 'text'" (click)="setMemorySearchMode('text')">{{ 'common.sortAZ' | transloco }}</button>
              <button [class.active]="memorySearchMode() === 'semantic'" (click)="setMemorySearchMode('semantic')"><ph-icon name="star-four" [size]="14" style="display:inline-flex;vertical-align:middle;margin-right:3px;"/> {{ 'common.semantic' | transloco }}</button>
            </div>
            <button class="btn-primary btn btn-sm" (click)="openMemoryForm()" [disabled]="showMemoryForm()">{{ 'brain.memories.addButton' | transloco }}</button>
          </div>

          <!-- Add memory form -->
          @if (showMemoryForm()) {
            <form class="create-form" (ngSubmit)="createMemory()">
              <div class="field" style="flex:2; min-width:200px;">
                <label>{{ 'common.form.fact' | transloco }}</label>
                <textarea [(ngModel)]="memoryForm.fact" name="fact" rows="2" required style="width:100%;"></textarea>
              </div>
              <div class="field" style="flex:1; min-width:180px;">
                <label>{{ 'common.form.tags' | transloco }}</label>
                <app-tag-input [(value)]="memoryForm.tags" [suggestions]="memoryTagSuggestions()" inputName="memFormTags" />
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>{{ 'common.form.entities' | transloco }}</label>
                <div class="flyout-wrap">
                  <div class="entity-multi">
                    @for (chip of entityChips(memoryForm.entityIds); track chip.id) {
                      <span class="chip" [title]="chip.id"><span class="chip-name">{{ chip.name }}</span><button type="button" class="chip-remove" (mousedown)="removeEntityId(memoryForm, chip.id)"><ph-icon name="x" [size]="12"/></button></span>
                    }
                    <button type="button" class="chip-add" (click)="openFlyout('create-memory-entityIds')">{{ 'common.addMore' | transloco }}</button>
                  </div>
                  @if (flyoutField() === 'create-memory-entityIds') {
                    <div class="flyout-panel">
                      <app-entity-search
                        mode="picker"
                        [spaceId]="activeSpaceId()"
                        placeholder="common.searchEntitiesPlaceholder"
                        defaultMode="semantic"
                        (selected)="pickEntity($event, 'multi', 'create-memory-entityIds')"
                      />
                      <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                        <button type="button" class="btn btn-sm btn-secondary" (click)="closeFlyout()">{{ 'common.done' | transloco }}</button>
                      </div>
                    </div>
                  }
                </div>
              </div>
              <div class="field" style="flex:2; min-width:200px;">
                <label>{{ 'common.form.description' | transloco }}</label>
                <input type="text" [(ngModel)]="memoryForm.description" name="description" />
              </div>
              <div class="field" style="flex:1; min-width:220px;">
                <label>{{ 'common.form.properties' | transloco }}</label>
                <app-properties-editor [schema]="memorySchema()" [required]="requiredProps(memorySchema())" [(value)]="memoryForm.properties" />
              </div>
              <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingMemory() || !memoryForm.fact.trim()">
                @if (creatingMemory()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                {{ 'common.save' | transloco }}
              </button>
              <button class="btn-secondary btn btn-sm" type="button" (click)="showMemoryForm.set(false)">{{ 'common.cancel' | transloco }}</button>
            </form>
          }

          @if (createMemoryError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createMemoryError() }}</div>
          }

          @if (filterTag() || filterEntity()) {
            <div class="filter-bar">
              <span class="filter-bar-label">{{ 'common.filters' | transloco }}</span>
              @if (filterTag(); as tag) {
                <span class="filter-chip">{{ 'brain.filter.tagPrefix' | transloco }} {{ tag }} <button [attr.aria-label]="'brain.filter.clearTagAriaLabel' | transloco" (click)="clearFilter('tag')"><ph-icon name="x" [size]="12"/></button></span>
              }
              @if (filterEntity(); as ent) {
                <span class="filter-chip">{{ 'brain.filter.entityPrefix' | transloco }} {{ ent }} <button [attr.aria-label]="'brain.filter.clearEntityAriaLabel' | transloco" (click)="clearFilter('entity')"><ph-icon name="x" [size]="12"/></button></span>
              }
              <button class="btn-secondary btn btn-sm" (click)="clearFilter('all')">{{ 'common.clearAll' | transloco }}</button>
            </div>
          }

          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>{{ 'brain.memories.table.fact' | transloco }}</th><th>{{ 'brain.memories.table.description' | transloco }}</th><th>{{ 'brain.memories.table.tags' | transloco }}</th><th>{{ 'brain.memories.table.entities' | transloco }}</th><th>{{ 'brain.memories.table.properties' | transloco }}</th><th>{{ 'brain.memories.table.created' | transloco }}</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (mem of filteredMemories(); track mem._id) {
                  @if (editingId() === mem._id) {
                    <tr>
                      <td colspan="7">
                        <div class="create-form" style="border:none; padding:8px 0;">
                          <div class="field" style="flex:2; min-width:200px; margin-bottom:0;">
                            <label>{{ 'common.form.fact' | transloco }}</label>
                            <textarea [(ngModel)]="editMemory.fact" name="editFact" rows="2" style="width:100%;"></textarea>
                          </div>
                          <div class="field" style="flex:1; min-width:160px; margin-bottom:0;">
                            <label>{{ 'common.form.description' | transloco }}</label>
                            <input type="text" [(ngModel)]="editMemory.description" name="editDesc" />
                          </div>
                          <div class="field" style="flex:1; min-width:180px; margin-bottom:0;">
                            <label>{{ 'common.form.tags' | transloco }}</label>
                            <app-tag-input [(value)]="editMemory.tags" [suggestions]="memoryTagSuggestions()" inputName="memEditTags" />
                          </div>
                          <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                            <label>{{ 'common.form.entities' | transloco }}</label>
                            <div class="flyout-wrap">
                              <div class="entity-multi">
                                @for (chip of entityChips(editMemory.entityIds); track chip.id) {
                                  <span class="chip" [title]="chip.id"><span class="chip-name">{{ chip.name }}</span><button type="button" class="chip-remove" (mousedown)="removeEntityId(editMemory, chip.id)"><ph-icon name="x" [size]="12"/></button></span>
                                }
                                <button type="button" class="chip-add" (click)="openFlyout('edit-memory-entityIds')">{{ 'common.addMore' | transloco }}</button>
                              </div>
                              @if (flyoutField() === 'edit-memory-entityIds') {
                                <div class="flyout-panel">
                                  <app-entity-search
                                    mode="picker"
                                    [spaceId]="activeSpaceId()"
                                    placeholder="common.searchEntitiesPlaceholder"
                                    defaultMode="semantic"
                                    (selected)="pickEntity($event, 'multi', 'edit-memory-entityIds')"
                                  />
                                  <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                                    <button type="button" class="btn btn-sm btn-secondary" (click)="closeFlyout()">{{ 'common.done' | transloco }}</button>
                                  </div>
                                </div>
                              }
                            </div>
                          </div>
                          <div class="field" style="flex:1; min-width:220px; margin-bottom:0;">
                            <label>{{ 'common.form.properties' | transloco }}</label>
                            <app-properties-editor
                              [schema]="memorySchema()"
                              [required]="requiredProps(memorySchema())"
                              [(value)]="editMemory.properties"
                            />
                          </div>
                          <div style="display:flex; gap:6px; align-items:flex-end;">
                            <button class="btn btn-sm btn-primary" [disabled]="editSaving()" (click)="saveEditMemory(mem._id)">
                              @if (editSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } {{ 'common.save' | transloco }}
                            </button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelEdit()">{{ 'common.cancel' | transloco }}</button>
                          </div>
                          @if (editError()) { <div style="font-size:12px; color:var(--error);">{{ editError() }}</div> }
                        </div>
                      </td>
                    </tr>
                  } @else {
                    <tr>
                      <td style="max-width:300px; white-space:pre-wrap; word-break:break-word;">{{ mem.fact }}</td>
                      <td style="font-size:12px; color:var(--text-muted); max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" [title]="mem.description ?? ''">
                        {{ mem.description || '—' }}
                      </td>
                      <td style="font-size:11px;">
                        @for (tag of (mem.tags ?? []); track tag) { <span class="tag tag-clickable" (click)="applyFilter('tag', tag)">{{ tag }}</span> }
                        @if (!(mem.tags?.length)) { <span style="color:var(--text-muted)">—</span> }
                      </td>
                      <td style="font-size:11px;">
                        @if (mem.entityIds?.length) {
                          <div class="chip-list">
                            @for (id of mem.entityIds!; track id) {
                              <span class="chip" [title]="id">{{ entityNameCache()[id] || id.slice(0,8) + '…' }}</span>
                            }
                          </div>
                        } @else { <span style="color:var(--text-muted)">—</span> }
                      </td>
                      <td><app-properties-view [properties]="mem.properties" [schema]="memorySchema()" /></td>
                      <td style="color:var(--text-muted)">{{ mem.createdAt | date:'dd.MM.yyyy' }}</td>
                      <td style="white-space:nowrap;">
                        <button class="icon-btn" [attr.title]="'common.viewDetails' | transloco" [attr.aria-label]="'common.viewDetails' | transloco" (click)="openDrawer('memory', mem)"><ph-icon name="eye" [size]="16"/></button>
                        @if (confirmDeleteId() === mem._id) {
                          <span class="inline-confirm">
                            {{ 'common.deleteConfirm' | transloco }}
                            <button class="btn btn-sm btn-danger" (click)="deleteMemory(mem._id)">{{ 'common.yes' | transloco }}</button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelDelete()">{{ 'common.no' | transloco }}</button>
                          </span>
                        } @else {
                          <button class="icon-btn danger" [attr.title]="'brain.memories.deleteTitle' | transloco" [attr.aria-label]="'brain.memories.deleteAriaLabel' | transloco" (click)="requestDelete(mem._id)"><ph-icon name="x" [size]="16"/></button>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="7">
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon"><ph-icon name="brain" [size]="48"/></div>
                      @if (memorySearch() && memories().length) {
                        <h3>{{ 'common.noMatches' | transloco }}</h3>
                        <p>{{ 'brain.memories.empty.noMatchQuery' | transloco: { query: memorySearch() } }}</p>
                      } @else {
                        <h3>{{ 'brain.memories.empty.title' | transloco }}</h3>
                        <p>{{ 'brain.memories.empty.body' | transloco }}</p>
                      }
                    </div>
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (memorySearchMode() !== 'semantic') {
            <div class="pagination">
              <button class="btn btn-sm btn-secondary" [disabled]="skip() === 0" (click)="prevPage()"><ph-icon name="arrow-left" [size]="14" style="display:inline-flex;vertical-align:middle;"/> {{ 'common.prev' | transloco }}</button>
              <span class="pager-info">{{ filteredMemories().length ? (skip() + 1) + '–' + (skip() + filteredMemories().length) : '–' }}</span>
              <button class="btn btn-sm btn-secondary" [disabled]="memories().length < pageSize" (click)="nextPage()">{{ 'common.next' | transloco }} <ph-icon name="arrow-right" [size]="14" style="display:inline-flex;vertical-align:middle;"/></button>
            </div>
          }
        }

        <!-- Entities -->
        @if (activeTab() === 'entities') {

          <div class="content-header">
            <app-entity-search
              mode="bar"
              [spaceId]="activeSpaceId()"
              placeholder="common.searchEntitiesPlaceholder"
              defaultMode="semantic"
              (queryChange)="onEntitySearchChange($event)"
              (cleared)="onEntitySearchClear()"
              (selected)="onEntitySearchPick($event)"
            />
            <button class="btn-primary btn btn-sm" (click)="openEntityForm()" [disabled]="showEntityForm()">{{ 'brain.entities.addButton' | transloco }}</button>
          </div>

          @if (showEntityForm()) {
            <form class="create-form" (ngSubmit)="createEntity()">
              <div class="field" style="flex:1; min-width:140px;">
                <label>{{ 'brain.entities.table.name' | transloco }}</label>
                <input type="text" [(ngModel)]="entityForm.name" name="name" required />
              </div>
              <div class="field" style="width:140px;">
                <label>Type @if (entityTypeNames().length) { <span style="color:var(--error)">*</span> }</label>
                @if (entityTypeNames().length) {
                  <select [(ngModel)]="entityForm.type" name="type" required (ngModelChange)="onEntityTypeChange($event, 'create')">
                    @for (t of entityTypeNames(); track t) {
                      <option [value]="t">{{ t }}</option>
                    }
                  </select>
                } @else {
                  <input type="text" [(ngModel)]="entityForm.type" name="type" [placeholder]="'brain.entities.form.typePlaceholder' | transloco" />
                }
              </div>
              <div class="field" style="flex:1; min-width:180px;">
                <label>{{ 'brain.entities.table.tags' | transloco }}</label>
                <app-tag-input [(value)]="entityForm.tags" [suggestions]="entityTagSuggestions()" inputName="entFormTags" />
              </div>
              <div class="field" style="flex:1; min-width:200px;">
                <label>{{ 'brain.entities.table.description' | transloco }}</label>
                <input type="text" [(ngModel)]="entityForm.description" name="description" />
              </div>
              <div class="field" style="flex:1; min-width:220px;">
                <label>{{ 'brain.entities.table.properties' | transloco }}</label>
                <app-properties-editor
                  [schema]="entitySchema(entityForm.type)"
                  [required]="requiredProps(entitySchema(entityForm.type))"
                  [(value)]="entityForm.properties"
                />
              </div>
              <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingEntity() || !entityForm.name.trim() || (entityTypeNames().length ? !entityForm.type : false)">
                @if (creatingEntity()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                {{ 'common.save' | transloco }}
              </button>
              <button class="btn-secondary btn btn-sm" type="button" (click)="showEntityForm.set(false)">{{ 'common.cancel' | transloco }}</button>
            </form>
          }

          @if (createEntityError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createEntityError() }}</div>
          }

          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>{{ 'brain.entities.table.name' | transloco }}</th><th>{{ 'brain.entities.table.type' | transloco }}</th><th>{{ 'brain.entities.table.description' | transloco }}</th><th>{{ 'brain.entities.table.tags' | transloco }}</th><th>{{ 'brain.entities.table.properties' | transloco }}</th><th>{{ 'brain.entities.table.created' | transloco }}</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (ent of entities(); track ent._id) {
                  @if (editingId() === ent._id) {
                    <tr>
                      <td colspan="7">
                        <div class="create-form" style="border:none; padding:8px 0;">
                          <div class="field" style="flex:1; min-width:120px; margin-bottom:0;">
                            <label>{{ 'brain.entities.table.name' | transloco }}</label>
                            <input type="text" [(ngModel)]="editEntity.name" name="editEntName" />
                          </div>
                          <div class="field" style="width:120px; margin-bottom:0;">
                            <label>Type @if (entityTypeNames().length) { <span style="color:var(--error)">*</span> }</label>
                            @if (entityTypeNames().length) {
                              <select [(ngModel)]="editEntity.type" name="editEntType" (ngModelChange)="onEntityTypeChange($event, 'inline')">
                                @for (t of entityTypeNames(); track t) {
                                  <option [value]="t">{{ t }}</option>
                                }
                              </select>
                            } @else {
                              <input type="text" [(ngModel)]="editEntity.type" name="editEntType" />
                            }
                          </div>
                          <div class="field" style="flex:1; min-width:160px; margin-bottom:0;">
                            <label>{{ 'brain.entities.table.description' | transloco }}</label>
                            <input type="text" [(ngModel)]="editEntity.description" name="editEntDesc" />
                          </div>
                          <div class="field" style="flex:1; min-width:180px; margin-bottom:0;">
                            <label>{{ 'brain.entities.table.tags' | transloco }}</label>
                            <app-tag-input [(value)]="editEntity.tags" [suggestions]="entityTagSuggestions()" inputName="entEditTags" />
                          </div>
                          <div class="field" style="flex:1; min-width:220px; margin-bottom:0;">
                            <label>{{ 'brain.entities.table.properties' | transloco }}</label>
                            <app-properties-editor
                              [schema]="entitySchema(editEntity.type)"
                              [required]="requiredProps(entitySchema(editEntity.type))"
                              [(value)]="editEntity.properties"
                            />
                          </div>
                          <div style="display:flex; gap:6px; align-items:flex-end;">
                            <button class="btn btn-sm btn-primary" [disabled]="editSaving()" (click)="saveEditEntity(ent._id)">
                              @if (editSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } Save
                            </button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelEdit()">{{ 'common.cancel' | transloco }}</button>
                          </div>
                          @if (editError()) { <div style="font-size:12px; color:var(--error);">{{ editError() }}</div> }
                        </div>
                      </td>
                    </tr>
                  } @else {
                    <tr>
                      <td>{{ ent.name }}</td>
                      <td>
                        @if (ent.type) { <span class="badge badge-purple">{{ ent.type }}</span> }
                      </td>
                      <td style="font-size:12px; color:var(--text-muted); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" [title]="ent.description ?? ''">
                        {{ ent.description || '—' }}
                      </td>
                      <td style="font-size:11px;">
                        @for (tag of (ent.tags ?? []); track tag) { <span class="tag">{{ tag }}</span> }
                        @if (!(ent.tags?.length)) { <span style="color:var(--text-muted)">—</span> }
                      </td>
                      <td><app-properties-view [properties]="ent.properties" [schema]="entitySchema(ent.type)" /></td>
                      <td style="color:var(--text-muted)">{{ ent.createdAt | date:'dd.MM.yyyy' }}</td>
                      <td style="white-space:nowrap;">
                        <button class="icon-btn" [attr.title]="'common.viewDetails' | transloco" [attr.aria-label]="'common.viewDetails' | transloco" (click)="openDrawer('entity', ent)"><ph-icon name="eye" [size]="16"/></button>
                        @if (confirmDeleteId() === ent._id) {
                          <span class="inline-confirm">
                            Delete?
                            <button class="btn btn-sm btn-danger" (click)="deleteEntity(ent._id)">{{ 'common.yes' | transloco }}</button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelDelete()">{{ 'common.no' | transloco }}</button>
                          </span>
                        } @else {
                          <button class="icon-btn danger" [attr.aria-label]="'brain.entities.deleteAriaLabel' | transloco" (click)="requestDelete(ent._id)"><ph-icon name="x" [size]="16"/></button>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="7">
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon"><ph-icon name="tag" [size]="48"/></div>
                      <h3>{{ 'brain.entities.empty.title' | transloco }}</h3>
                    </div>
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          <div class="pagination">
            <button class="btn btn-sm btn-secondary" [disabled]="entitySkip() === 0" (click)="prevEntityPage()"><ph-icon name="arrow-left" [size]="14" style="display:inline-flex;vertical-align:middle;"/> {{ 'common.prev' | transloco }}</button>
            <span class="pager-info">{{ entities().length ? (entitySkip() + 1) + '–' + (entitySkip() + entities().length) : '–' }}</span>
            <button class="btn btn-sm btn-secondary" [disabled]="entities().length < pageSize" (click)="nextEntityPage()">{{ 'common.next' | transloco }} <ph-icon name="arrow-right" [size]="14" style="display:inline-flex;vertical-align:middle;"/></button>
          </div>
        }

        <!-- Edges -->
        @if (activeTab() === 'edges') {

          <div class="content-header">
            <input type="search" [placeholder]="'brain.edges.searchPlaceholder' | transloco"
              [value]="edgeSearch()"
              (input)="onEdgeSearch($any($event.target).value)"
              [attr.aria-label]="'brain.edges.searchPlaceholder' | transloco" />
            <div class="pill-group" [attr.title]="'common.searchMode.tooltip' | transloco">
              <button [class.active]="edgeSearchMode() === 'text'" (click)="setEdgeSearchMode('text')">{{ 'common.sortAZ' | transloco }}</button>
              <button [class.active]="edgeSearchMode() === 'semantic'" (click)="setEdgeSearchMode('semantic')"><ph-icon name="star-four" [size]="14" style="display:inline-flex;vertical-align:middle;margin-right:3px;"/> {{ 'common.semantic' | transloco }}</button>
            </div>
            <button class="btn-primary btn btn-sm" (click)="openEdgeForm()" [disabled]="showEdgeForm()">{{ 'brain.edges.addButton' | transloco }}</button>
          </div>

          @if (showEdgeForm()) {
            <form class="create-form" (ngSubmit)="createEdge()">
              <div class="field" style="flex:1; min-width:120px;">
                <label>{{ 'common.form.from' | transloco }}</label>
                <app-entity-search
                  mode="picker"
                  [spaceId]="activeSpaceId()"
                  placeholder="common.searchEntitiesPlaceholder"
                  defaultMode="semantic"
                  [value]="edgeForm.fromDisplay"
                  (selected)="pickEntity($event, 'single', 'create-edge-from')"
                />
              </div>
              <div class="field" style="flex:1; min-width:120px;">
                <label>{{ 'brain.edges.form.relation' | transloco }} <span style="color:var(--error)">*</span></label>
                @if (edgeLabelNames().length) {
                  <select [(ngModel)]="edgeForm.label" name="label" required>
                    @for (l of edgeLabelNames(); track l) {
                      <option [value]="l">{{ l }}</option>
                    }
                  </select>
                } @else {
                  <input type="text" [(ngModel)]="edgeForm.label" name="label" required />
                }
              </div>
              <div class="field" style="flex:1; min-width:120px;">
                <label>{{ 'common.form.to' | transloco }}</label>
                <app-entity-search
                  mode="picker"
                  [spaceId]="activeSpaceId()"
                  placeholder="common.searchEntitiesPlaceholder"
                  defaultMode="semantic"
                  [value]="edgeForm.toDisplay"
                  (selected)="pickEntity($event, 'single', 'create-edge-to')"
                />
              </div>
              <div class="field" style="width:80px;">
                <label>{{ 'common.form.weight' | transloco }}</label>
                <input type="number" [(ngModel)]="edgeForm.weight" name="weight" step="0.1" />
              </div>
              <div class="field" style="flex:1; min-width:180px;">
                <label>{{ 'brain.edges.table.tags' | transloco }}</label>
                <app-tag-input [(value)]="edgeForm.tags" [suggestions]="edgeTagSuggestions()" inputName="edgeFormTags" />
              </div>
              <div class="field" style="flex:2; min-width:200px;">
                <label>{{ 'brain.edges.table.description' | transloco }}</label>
                <input type="text" [(ngModel)]="edgeForm.description" name="description" />
              </div>
              <div class="field" style="flex:1; min-width:220px;">
                <label>{{ 'brain.edges.table.properties' | transloco }}</label>
                <app-properties-editor
                  [schema]="edgeSchema(edgeForm.label)"
                  [required]="requiredProps(edgeSchema(edgeForm.label))"
                  [(value)]="edgeForm.properties"
                />
              </div>
              <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingEdge() || !edgeForm.from.trim() || !edgeForm.to.trim() || !edgeForm.label.trim()">
                @if (creatingEdge()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                {{ 'common.save' | transloco }}
              </button>
              <button class="btn-secondary btn btn-sm" type="button" (click)="showEdgeForm.set(false)">{{ 'common.cancel' | transloco }}</button>
            </form>
          }

          @if (createEdgeError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createEdgeError() }}</div>
          }
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>{{ 'brain.edges.table.from' | transloco }}</th><th>{{ 'brain.edges.table.relation' | transloco }}</th><th>{{ 'brain.edges.table.to' | transloco }}</th><th>{{ 'brain.edges.table.weight' | transloco }}</th><th>{{ 'brain.edges.table.tags' | transloco }}</th><th>{{ 'brain.edges.table.description' | transloco }}</th><th>{{ 'brain.edges.table.properties' | transloco }}</th><th>{{ 'brain.edges.table.created' | transloco }}</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (edge of filteredEdges(); track edge._id) {
                  @if (editingId() === edge._id) {
                    <tr>
                      <td colspan="9">
                        <div class="create-form" style="border:none; padding:8px 0;">
                          <div class="field" style="min-width:200px; margin-bottom:0;">
                            <label style="font-size:11px; color:var(--text-muted);">{{ 'brain.edges.form.editingLabel' | transloco }}</label>
                            <div style="font-size:12px; padding:6px 8px; background:var(--bg-secondary); border-radius:4px; color:var(--text-muted);">
                              {{ editEdge.fromName || editEdge.from }} → {{ editEdge.toName || editEdge.to }}
                            </div>
                          </div>
                          <div class="field" style="flex:1; min-width:120px; margin-bottom:0;">
                            <label>{{ 'brain.edges.form.relation' | transloco }}</label>
                            @if (edgeLabelNames().length) {
                              <select [(ngModel)]="editEdge.label" name="editEdgeLabel">
                                @for (l of edgeLabelNames(); track l) {
                                  <option [value]="l">{{ l }}</option>
                                }
                              </select>
                            } @else {
                              <input type="text" [(ngModel)]="editEdge.label" name="editEdgeLabel" />
                            }
                          </div>
                          <div class="field" style="width:80px; margin-bottom:0;">
                            <label>{{ 'common.form.weight' | transloco }}</label>
                            <input type="number" [(ngModel)]="editEdge.weight" name="editEdgeWeight" step="0.1" />
                          </div>
                          <div class="field" style="flex:1; min-width:160px; margin-bottom:0;">
                            <label>{{ 'brain.edges.table.description' | transloco }}</label>
                            <input type="text" [(ngModel)]="editEdge.description" name="editEdgeDesc" />
                          </div>
                          <div class="field" style="flex:1; min-width:180px; margin-bottom:0;">
                            <label>{{ 'brain.edges.table.tags' | transloco }}</label>
                            <app-tag-input [(value)]="editEdge.tags" [suggestions]="edgeTagSuggestions()" inputName="edgeEditTags" />
                          </div>
                          <div class="field" style="flex:1; min-width:220px; margin-bottom:0;">
                            <label>{{ 'brain.edges.table.properties' | transloco }}</label>
                            <app-properties-editor
                              [schema]="edgeSchema(editEdge.label)"
                              [required]="requiredProps(edgeSchema(editEdge.label))"
                              [(value)]="editEdge.properties"
                            />
                          </div>
                          <div style="display:flex; gap:6px; align-items:flex-end;">
                            <button class="btn btn-sm btn-primary" [disabled]="editSaving()" (click)="saveEditEdge(edge._id)">
                              @if (editSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } {{ 'common.save' | transloco }}
                            </button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelEdit()">{{ 'common.cancel' | transloco }}</button>
                          </div>
                          @if (editError()) { <div style="font-size:12px; color:var(--error);">{{ editError() }}</div> }
                        </div>
                      </td>
                    </tr>
                  } @else {
                    <tr style="vertical-align:top;">
                      <td style="font-size:12px; white-space:nowrap;">{{ edge.fromName || edge.from }}</td>
                      <td><span class="badge badge-blue">{{ edge.label }}</span></td>
                      <td style="font-size:12px; white-space:nowrap;">{{ edge.toName || edge.to }}</td>
                      <td style="color:var(--text-muted);">{{ edge.weight ?? '—' }}</td>
                      <td style="font-size:11px;">
                        @for (tag of (edge.tags ?? []); track tag) { <span class="tag">{{ tag }}</span> }
                        @if (!(edge.tags?.length)) { <span style="color:var(--text-muted)">—</span> }
                      </td>
                      <td style="font-size:12px; color:var(--text-muted); white-space:normal; word-break:break-word; min-width:140px; min-height:4.2em;">
                        {{ edge.description || '—' }}
                      </td>
                      <td><app-properties-view [properties]="edge.properties" [schema]="edgeSchema(edge.label)" /></td>
                      <td style="color:var(--text-muted); white-space:nowrap;">{{ edge.createdAt | date:'dd.MM.yyyy' }}</td>
                      <td style="white-space:nowrap;">
                        <button class="icon-btn" [attr.title]="'common.viewDetails' | transloco" [attr.aria-label]="'common.viewDetails' | transloco" (click)="openDrawer('edge', edge)"><ph-icon name="eye" [size]="16"/></button>
                        @if (confirmDeleteId() === edge._id) {
                          <span class="inline-confirm">
                            {{ 'common.deleteConfirm' | transloco }}
                            <button class="btn btn-sm btn-danger" (click)="deleteEdge(edge._id)">{{ 'common.yes' | transloco }}</button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelDelete()">{{ 'common.no' | transloco }}</button>
                          </span>
                        } @else {
                          <button class="icon-btn danger" [attr.aria-label]="'brain.edges.deleteAriaLabel' | transloco" (click)="requestDelete(edge._id)"><ph-icon name="x" [size]="16"/></button>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="9">
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon"><ph-icon name="graph" [size]="48"/></div>
                      @if (edgeSearch() && edges().length) {
                        <h3>{{ 'common.noMatches' | transloco }}</h3>
                        <p>{{ 'brain.edges.empty.noMatchQuery' | transloco: { query: edgeSearch() } }}</p>
                      } @else {
                        <h3>{{ 'brain.edges.empty.title' | transloco }}</h3>
                      }
                    </div>
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (edgeSearchMode() !== 'semantic') {
            <div class="pagination">
              <button class="btn btn-sm btn-secondary" [disabled]="edgeSkip() === 0" (click)="prevEdgePage()"><ph-icon name="arrow-left" [size]="14" style="display:inline-flex;vertical-align:middle;"/> {{ 'common.prev' | transloco }}</button>
              <span class="pager-info">{{ filteredEdges().length ? (edgeSkip() + 1) + '–' + (edgeSkip() + filteredEdges().length) : '–' }}</span>
              <button class="btn btn-sm btn-secondary" [disabled]="edges().length < pageSize" (click)="nextEdgePage()">{{ 'common.next' | transloco }} <ph-icon name="arrow-right" [size]="14" style="display:inline-flex;vertical-align:middle;"/></button>
            </div>
          }
        }

        <!-- Chrono -->
        @if (activeTab() === 'chrono') {

          <div class="content-header">
            <input type="search" [placeholder]="'brain.chrono.searchPlaceholder' | transloco"
              [value]="chronoSearch()"
              (input)="onChronoSearch($any($event.target).value)"
              [attr.aria-label]="'brain.chrono.searchPlaceholder' | transloco" />
            <div class="pill-group" [attr.title]="'common.searchMode.tooltip' | transloco">
              <button [class.active]="chronoSearchMode() === 'text'" (click)="setChronoSearchMode('text')">{{ 'common.sortAZ' | transloco }}</button>
              <button [class.active]="chronoSearchMode() === 'semantic'" (click)="setChronoSearchMode('semantic')"><ph-icon name="star-four" [size]="14" style="display:inline-flex;vertical-align:middle;margin-right:3px;"/> {{ 'common.semantic' | transloco }}</button>
            </div>
            <button class="btn-primary btn btn-sm" (click)="openChronoForm()" [disabled]="showChronoForm()">{{ 'brain.chrono.addButton' | transloco }}</button>
          </div>

          @if (showChronoForm()) {
            <form class="create-form" (ngSubmit)="createChrono()">
              <div class="field" style="flex:2; min-width:200px;">
                <label>{{ 'common.form.title' | transloco }}</label>
                <input type="text" [(ngModel)]="chronoForm.title" name="title" required />
              </div>
              <div class="field" style="width:160px;">
                <label>{{ 'brain.chrono.form.kind' | transloco }}</label>
                @if (chronoForm.kind !== '__custom__') {
                  <select [(ngModel)]="chronoForm.kind" name="kind">
                    @for (k of chronoKinds; track k) { <option [value]="k">{{ k }}</option> }
                    <option value="__custom__">{{ 'brain.chrono.form.customKind' | transloco }}</option>
                  </select>
                } @else {
                  <div style="display:flex; gap:4px;">
                    <input type="text" [(ngModel)]="chronoForm.customKind" name="customKind" style="flex:1;" />
                    <button type="button" class="btn-secondary btn btn-sm" style="padding:4px 8px;" (click)="chronoForm.kind = 'event'; chronoForm.customKind = ''" [attr.title]="'brain.chrono.form.backToPresets' | transloco"><ph-icon name="x" [size]="14"/></button>
                  </div>
                }
              </div>
              <div class="field" style="width:200px;">
                <label>{{ 'brain.chrono.form.startsAt' | transloco }}</label>
                <input type="datetime-local" [(ngModel)]="chronoForm.startsAt" name="startsAt" required />
              </div>
              <div class="field" style="width:200px;">
                <label>{{ 'brain.chrono.form.endsAt' | transloco }}</label>
                <input type="datetime-local" [(ngModel)]="chronoForm.endsAt" name="endsAt" />
              </div>
              <div class="field" style="flex:1; min-width:200px;">
                <label>{{ 'brain.chrono.table.description' | transloco }}</label>
                <textarea [(ngModel)]="chronoForm.description" name="description" rows="3" style="resize:vertical;"></textarea>
              </div>
              <div class="field" style="flex:1; min-width:180px;">
                <label>{{ 'brain.chrono.table.tags' | transloco }}</label>
                <app-tag-input [(value)]="chronoForm.tags" [suggestions]="chronoTagSuggestions()" inputName="chronoFormTags" />
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>{{ 'brain.chrono.table.entities' | transloco }}</label>
                <div class="flyout-wrap">
                  <div class="entity-multi">
                    @for (chip of entityChips(chronoForm.entityIds); track chip.id) {
                      <span class="chip" [title]="chip.id"><span class="chip-name">{{ chip.name }}</span><button type="button" class="chip-remove" (mousedown)="removeEntityId(chronoForm, chip.id)"><ph-icon name="x" [size]="12"/></button></span>
                    }
                    <button type="button" class="chip-add" (click)="openFlyout('create-chrono-entityIds')">{{ 'common.addMore' | transloco }}</button>
                  </div>
                  @if (flyoutField() === 'create-chrono-entityIds') {
                    <div class="flyout-panel">
                      <app-entity-search
                        mode="picker"
                        [spaceId]="activeSpaceId()"
                        placeholder="common.searchEntitiesPlaceholder"
                        defaultMode="semantic"
                        (selected)="pickEntity($event, 'multi', 'create-chrono-entityIds')"
                      />
                      <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                        <button type="button" class="btn btn-sm btn-secondary" (click)="closeFlyout()">{{ 'common.done' | transloco }}</button>
                      </div>
                    </div>
                  }
                </div>
              </div>
              <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingChrono() || !chronoForm.title.trim() || !chronoForm.startsAt || (chronoForm.kind === '__custom__' && !chronoForm.customKind.trim())">
                @if (creatingChrono()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                {{ 'common.save' | transloco }}
              </button>
              <button class="btn-secondary btn btn-sm" type="button" (click)="showChronoForm.set(false)">{{ 'common.cancel' | transloco }}</button>
            </form>
          }

          @if (createChronoError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createChronoError() }}</div>
          }



          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>{{ 'brain.chrono.table.title' | transloco }}</th><th>{{ 'brain.chrono.table.description' | transloco }}</th><th>{{ 'brain.chrono.table.kind' | transloco }}</th><th>{{ 'brain.chrono.table.status' | transloco }}</th><th>{{ 'brain.chrono.table.starts' | transloco }}</th><th>{{ 'brain.chrono.table.ends' | transloco }}</th><th>{{ 'brain.chrono.table.tags' | transloco }}</th><th>{{ 'brain.chrono.table.entities' | transloco }}</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (entry of filteredChrono(); track entry._id) {
                  @if (editingId() === entry._id) {
                    <tr>
                      <td colspan="9">
                        <div class="create-form" style="border:none; padding:8px 0;">
                          <div class="field" style="flex:2; min-width:180px; margin-bottom:0;">
                            <label>{{ 'common.form.title' | transloco }}</label>
                            <input type="text" [(ngModel)]="editChrono.title" name="editChronoTitle" />
                          </div>
                          <div class="field" style="width:130px; margin-bottom:0;">
                            <label>{{ 'brain.chrono.form.kind' | transloco }}</label>
                            <select [(ngModel)]="editChrono.kind" name="editChronoKind">
                              @for (k of chronoKinds; track k) { <option [value]="k">{{ k }}</option> }
                            </select>
                          </div>
                          <div class="field" style="width:130px; margin-bottom:0;">
                            <label>{{ 'brain.chrono.table.status' | transloco }}</label>
                            <select [(ngModel)]="editChrono.status" name="editChronoStatus">
                              @for (s of chronoStatusOptions; track s) { <option [value]="s">{{ s }}</option> }
                            </select>
                          </div>
                          <div class="field" style="width:190px; margin-bottom:0;">
                            <label>{{ 'brain.chrono.form.startsAt' | transloco }}</label>
                            <input type="datetime-local" [(ngModel)]="editChrono.startsAt" name="editChronoStarts" />
                          </div>
                          <div class="field" style="width:190px; margin-bottom:0;">
                            <label>{{ 'common.form.endsAt' | transloco }}</label>
                            <input type="datetime-local" [(ngModel)]="editChrono.endsAt" name="editChronoEnds" />
                          </div>
                          <div class="field" style="flex:1; min-width:180px; margin-bottom:0;">
                            <label>{{ 'brain.chrono.table.description' | transloco }}</label>
                            <textarea [(ngModel)]="editChrono.description" name="editChronoDesc" rows="2" style="resize:vertical;"></textarea>
                          </div>
                          <div class="field" style="flex:1; min-width:180px; margin-bottom:0;">
                            <label>{{ 'brain.chrono.table.tags' | transloco }}</label>
                            <app-tag-input [(value)]="editChrono.tags" [suggestions]="chronoTagSuggestions()" inputName="chronoEditTags" />
                          </div>
                          <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                            <label>{{ 'brain.chrono.table.entities' | transloco }}</label>
                            <div class="flyout-wrap">
                              <div class="entity-multi">
                                @for (chip of entityChips(editChrono.entityIds); track chip.id) {
                                  <span class="chip" [title]="chip.id"><span class="chip-name">{{ chip.name }}</span><button type="button" class="chip-remove" (mousedown)="removeEntityId(editChrono, chip.id)"><ph-icon name="x" [size]="12"/></button></span>
                                }
                                <button type="button" class="chip-add" (click)="openFlyout('edit-chrono-entityIds')">{{ 'common.addMore' | transloco }}</button>
                              </div>
                              @if (flyoutField() === 'edit-chrono-entityIds') {
                                <div class="flyout-panel">
                                  <app-entity-search
                                    mode="picker"
                                    [spaceId]="activeSpaceId()"
                                    placeholder="common.searchEntitiesPlaceholder"
                                    defaultMode="semantic"
                                    (selected)="pickEntity($event, 'multi', 'edit-chrono-entityIds')"
                                  />
                                  <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                                    <button type="button" class="btn btn-sm btn-secondary" (click)="closeFlyout()">{{ 'common.done' | transloco }}</button>
                                  </div>
                                </div>
                              }
                            </div>
                          </div>
                          <div style="display:flex; gap:6px; align-items:flex-end;">
                            <button class="btn btn-sm btn-primary" [disabled]="editSaving()" (click)="saveEditChrono(entry._id)">
                              @if (editSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } {{ 'common.save' | transloco }}
                            </button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelEdit()">{{ 'common.cancel' | transloco }}</button>
                          </div>
                          @if (editError()) { <div style="font-size:12px; color:var(--error);">{{ editError() }}</div> }
                        </div>
                      </td>
                    </tr>
                  } @else {
                    <tr>
                      <td>{{ entry.title }}</td>
                      <td style="font-size:12px; color:var(--text-muted); max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" [title]="entry.description ?? ''">
                        {{ entry.description || '—' }}
                      </td>
                      <td><span class="badge badge-blue">{{ entry.type }}</span></td>
                      <td><span class="badge" [class.badge-purple]="entry.status === 'upcoming'" [class.badge-blue]="entry.status === 'active'" style="font-size:11px">{{ entry.status }}</span></td>
                      <td style="color:var(--text-muted); font-size:12px">{{ entry.startsAt | date:'dd.MM.yyyy HH:mm' }}</td>
                      <td style="color:var(--text-muted); font-size:12px">{{ entry.endsAt ? (entry.endsAt | date:'dd.MM.yyyy HH:mm') : '—' }}</td>
                      <td>
                        @for (tag of entry.tags; track tag) { <span class="tag">{{ tag }}</span> }
                      </td>
                      <td style="font-size:11px;">
                        @if (entry.entityIds.length) {
                          <div class="chip-list">
                            @for (id of entry.entityIds; track id) {
                              <span class="chip" [title]="id">{{ entityNameCache()[id] || id.slice(0,8) + '…' }}</span>
                            }
                          </div>
                        } @else { <span style="color:var(--text-muted)">—</span> }
                      </td>
                      <td style="white-space:nowrap;">
                        <button class="icon-btn" [attr.title]="'common.viewDetails' | transloco" [attr.aria-label]="'common.viewDetails' | transloco" (click)="openDrawer('chrono', entry)"><ph-icon name="eye" [size]="16"/></button>
                        @if (confirmDeleteId() === entry._id) {
                          <span class="inline-confirm">
                            {{ 'common.deleteConfirm' | transloco }}
                            <button class="btn btn-sm btn-danger" (click)="deleteChrono(entry._id)">{{ 'common.yes' | transloco }}</button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelDelete()">{{ 'common.no' | transloco }}</button>
                          </span>
                        } @else {
                          <button class="icon-btn danger" [attr.aria-label]="'brain.chrono.deleteAriaLabel' | transloco" (click)="requestDelete(entry._id)"><ph-icon name="x" [size]="16"/></button>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="9">
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon"><ph-icon name="timer" [size]="48"/></div>
                      @if (chronoSearch()) {
                        <h3>{{ 'common.noMatches' | transloco }}</h3>
                        <p>{{ 'brain.chrono.empty.noMatchQuery' | transloco }}</p>
                      } @else {
                        <h3>{{ 'brain.chrono.empty.title' | transloco }}</h3>
                      }
                    </div>
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (chronoSearchMode() !== 'semantic') {
            <div class="pagination">
              <button class="btn btn-sm btn-secondary" [disabled]="chronoSkip() === 0" (click)="prevChronoPage()"><ph-icon name="arrow-left" [size]="14" style="display:inline-flex;vertical-align:middle;"/> {{ 'common.prev' | transloco }}</button>
              <span class="pager-info">{{ chrono().length ? (chronoSkip() + 1) + '–' + (chronoSkip() + chrono().length) : '–' }}</span>
              <button class="btn btn-sm btn-secondary" [disabled]="chrono().length < pageSize" (click)="nextChronoPage()">{{ 'common.next' | transloco }} <ph-icon name="arrow-right" [size]="14" style="display:inline-flex;vertical-align:middle;"/></button>
            </div>
          }
        }

        <!-- File Meta -->
        @if (activeTab() === 'filemeta') {
          <div class="content-header">
            <input type="search" [value]="fileMetaSearch()" (input)="onFileMetaSearch($any($event.target).value)" [placeholder]="'brain.fileMeta.filterPlaceholder' | transloco" [attr.aria-label]="'brain.fileMeta.filterAriaLabel' | transloco" />
          </div>
          @if (loading()) {
            <div class="empty-state"><span class="spinner"></span></div>
          } @else if (!fileMetas().length) {
            <div class="empty-state">{{ 'brain.fileMeta.empty' | transloco }}</div>
          } @else {
            <div class="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>{{ 'brain.fileMeta.table.path' | transloco }}</th>
                    <th>{{ 'brain.fileMeta.table.description' | transloco }}</th>
                    <th>{{ 'brain.fileMeta.table.tags' | transloco }}</th>
                    <th>{{ 'brain.fileMeta.table.entities' | transloco }}</th>
                    <th>{{ 'brain.fileMeta.table.memories' | transloco }}</th>
                    <th>{{ 'brain.fileMeta.table.chrono' | transloco }}</th>
                    <th>{{ 'brain.fileMeta.table.size' | transloco }}</th>
                    <th>{{ 'brain.fileMeta.table.updated' | transloco }}</th>
                    <th>{{ 'brain.fileMeta.table.actions' | transloco }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (fm of filteredFileMetas(); track fm._id) {
                    @if (editingId() === fm._id) {
                      <tr class="edit-row"><td colspan="9">
                        <form class="edit-form" (ngSubmit)="saveEditFileMeta(fm._id)" #fmEditForm="ngForm">
                          <div class="edit-form-fields">
                            <div class="field" style="flex:2; min-width:180px; margin-bottom:0;">
                              <label>{{ 'brain.fileMeta.table.description' | transloco }}</label>
                              <input type="text" [(ngModel)]="editFileMeta.description" name="fmEditDesc" />
                            </div>
                            <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                              <label>{{ 'brain.fileMeta.table.tags' | transloco }}</label>
                              <app-tag-input [(value)]="editFileMeta.tags" inputName="fmEditTags" />
                            </div>
                            <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                              <label>{{ 'brain.fileMeta.table.entities' | transloco }}</label>
                              <div class="flyout-wrap">
                                <div class="entity-multi">
                                  @for (chip of entityChips(editFileMeta.entityIds); track chip.id) {
                                    <span class="chip" [title]="chip.id"><span class="chip-name">{{ chip.name }}</span><button type="button" class="chip-remove" (mousedown)="removeEntityId(editFileMeta, chip.id)"><ph-icon name="x" [size]="12"/></button></span>
                                  }
                                  <button type="button" class="chip-add" (click)="openFlyout('edit-filemeta-entityIds')">{{ 'common.addMore' | transloco }}</button>
                                </div>
                                @if (flyoutField() === 'edit-filemeta-entityIds') {
                                  <div class="flyout-panel">
                                    <app-entity-search mode="picker" [spaceId]="activeSpaceId()" placeholder="common.searchEntitiesPlaceholder" defaultMode="semantic" (selected)="pickEntity($event, 'multi', 'edit-filemeta-entityIds')" />
                                    <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                                      <button type="button" class="btn btn-sm btn-secondary" (click)="closeFlyout()">{{ 'common.done' | transloco }}</button>
                                    </div>
                                  </div>
                                }
                              </div>
                            </div>
                            <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                              <label>{{ 'brain.fileMeta.table.memories' | transloco }}</label>
                              <div class="flyout-wrap">
                                <div class="entity-multi">
                                  @for (id of editFileMeta.memoryIds; track id) {
                                    <span class="chip" [title]="id"><span class="chip-name">{{ fmMemoryTitle(id) }}</span><button type="button" class="chip-remove" (mousedown)="removeFmMemoryId(editFileMeta, id)"><ph-icon name="x" [size]="12"/></button></span>
                                  }
                                  <button type="button" class="chip-add" (click)="openFlyout('edit-filemeta-memoryIds')">{{ 'common.addMore' | transloco }}</button>
                                </div>
                                @if (flyoutField() === 'edit-filemeta-memoryIds') {
                                  <div class="flyout-panel">
                                    <input type="text" [value]="fmMemPickerQuery()" (input)="onFmMemPickerInput($any($event.target).value)" [placeholder]="'brain.fileMeta.picker.searchMemories' | transloco" style="width:100%; margin-bottom:6px;" />
                                    @for (mem of fmMemPickerResults(); track mem._id) {
                                      <div class="flyout-result" (click)="addFmMemoryId(editFileMeta, mem._id); closeFlyout()" style="cursor:pointer; padding:4px 6px; border-radius:4px;">
                                        {{ mem.fact.slice(0, 60) }}{{ mem.fact.length > 60 ? '…' : '' }}
                                      </div>
                                    }
                                    <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                                      <button type="button" class="btn btn-sm btn-secondary" (click)="closeFlyout()">{{ 'common.done' | transloco }}</button>
                                    </div>
                                  </div>
                                }
                              </div>
                            </div>
                            <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                              <label>{{ 'brain.fileMeta.table.chrono' | transloco }}</label>
                              <div class="flyout-wrap">
                                <div class="entity-multi">
                                  @for (id of editFileMeta.chronoIds; track id) {
                                    <span class="chip" [title]="id"><span class="chip-name">{{ fmChronoTitle(id) }}</span><button type="button" class="chip-remove" (mousedown)="removeFmChronoId(editFileMeta, id)"><ph-icon name="x" [size]="12"/></button></span>
                                  }
                                  <button type="button" class="chip-add" (click)="openFlyout('edit-filemeta-chronoIds')">{{ 'common.addMore' | transloco }}</button>
                                </div>
                                @if (flyoutField() === 'edit-filemeta-chronoIds') {
                                  <div class="flyout-panel">
                                    <input type="text" [value]="fmChronoPickerQuery()" (input)="onFmChronoPickerInput($any($event.target).value)" [placeholder]="'brain.fileMeta.picker.searchChrono' | transloco" style="width:100%; margin-bottom:6px;" />
                                    @for (c of fmChronoPickerResults(); track c._id) {
                                      <div class="flyout-result" (click)="addFmChronoId(editFileMeta, c._id); closeFlyout()" style="cursor:pointer; padding:4px 6px; border-radius:4px;">
                                        {{ c.title.slice(0, 60) }}{{ c.title.length > 60 ? '…' : '' }}
                                      </div>
                                    }
                                    <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                                      <button type="button" class="btn btn-sm btn-secondary" (click)="closeFlyout()">{{ 'common.done' | transloco }}</button>
                                    </div>
                                  </div>
                                }
                              </div>
                            </div>
                          </div>
                          @if (editError()) {
                            <div class="error-msg">{{ editError() }}</div>
                          }
                          <div class="edit-form-actions">
                            <button class="btn btn-sm btn-primary" type="submit" [disabled]="editSaving()">
                              @if (editSaving()) { <span class="spinner" style="width:10px;height:10px;border-width:2px;"></span> }
                              {{ 'common.save' | transloco }}
                            </button>
                            <button class="btn btn-sm btn-secondary" type="button" (click)="cancelEdit()">{{ 'common.cancel' | transloco }}</button>
                          </div>
                        </form>
                      </td></tr>
                    } @else {
                      <tr>
                        <td>
                          <button class="link-btn" [attr.title]="'brain.fileMeta.openInFilesTabTitle' | transloco" (click)="openFileInManager(fm.path)">{{ fm.path }}</button>
                        </td>
                        <td class="text-muted" style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{{ fm.description || '–' }}</td>
                        <td>
                          <div class="chip-list">
                            @for (tag of fm.tags; track tag) {
                              <span class="chip chip-tag">{{ tag }}</span>
                            }
                          </div>
                        </td>
                        <td>
                          <div class="chip-list">
                            @for (id of (fm.entityIds ?? []); track id) {
                              <span class="chip" [title]="id">{{ entityNameCache()[id] || id.slice(0,8) + '…' }}</span>
                            }
                          </div>
                        </td>
                        <td>
                          <div class="chip-list">
                            @for (id of (fm.memoryIds ?? []); track id) {
                              <span class="chip" [title]="id">{{ fmMemoryTitle(id) }}</span>
                            }
                          </div>
                        </td>
                        <td>
                          <div class="chip-list">
                            @for (id of (fm.chronoIds ?? []); track id) {
                              <span class="chip" [title]="id">{{ fmChronoTitle(id) }}</span>
                            }
                          </div>
                        </td>
                        <td class="text-muted" style="white-space:nowrap;">{{ (fm.sizeBytes / 1024).toFixed(1) }} KB</td>
                        <td class="text-muted" style="white-space:nowrap;">{{ fm.updatedAt | date:'dd.MM.yyyy HH:mm' }}</td>
                        <td class="actions-cell">
                          @if (confirmDeleteId() === fm._id) {
                            <span class="delete-confirm">
                              <button class="btn btn-xs btn-danger" (click)="deleteFileMeta(fm._id)">{{ 'common.confirm' | transloco }}</button>
                              <button class="btn btn-xs btn-secondary" (click)="cancelDelete()">{{ 'common.cancel' | transloco }}</button>
                            </span>
                          } @else {
                            <button class="icon-btn" [attr.title]="'brain.fileMeta.editTitle' | transloco" [attr.aria-label]="'brain.fileMeta.editAriaLabel' | transloco" (click)="startEditFileMeta(fm)"><ph-icon name="pencil-simple" [size]="16"/></button>
                            <button class="icon-btn icon-btn-danger" [attr.title]="'brain.fileMeta.removeTitle' | transloco" [attr.aria-label]="'brain.fileMeta.removeAriaLabel' | transloco" (click)="requestDelete(fm._id)"><ph-icon name="trash" [size]="16"/></button>
                          }
                        </td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
            </div>
            <div class="pagination">
              <button class="btn btn-sm btn-secondary" [disabled]="fileMetaSkip() === 0" (click)="prevFileMetaPage()"><ph-icon name="arrow-left" [size]="14" style="display:inline-flex;vertical-align:middle;"/> {{ 'common.prev' | transloco }}</button>
              <span class="pager-info">{{ fileMetas().length ? (fileMetaSkip() + 1) + '–' + (fileMetaSkip() + fileMetas().length) : '–' }}</span>
              <button class="btn btn-sm btn-secondary" [disabled]="fileMetas().length < pageSize" (click)="nextFileMetaPage()">{{ 'common.next' | transloco }} <ph-icon name="arrow-right" [size]="14" style="display:inline-flex;vertical-align:middle;"/></button>
            </div>
          }
        }

        <!-- Query -->
        @if (activeTab() === 'query') {
          <div class="query-panel">
            <!-- Mode switcher -->
            <div style="display:flex; gap:8px; margin-bottom:12px;">
              <button class="btn btn-sm" [class.btn-primary]="queryMode() === 'search'" [class.btn-secondary]="queryMode() !== 'search'" (click)="queryMode.set('search')">{{ 'brain.query.mode.semanticSearch' | transloco }}</button>
              <button class="btn btn-sm" [class.btn-primary]="queryMode() === 'advanced'" [class.btn-secondary]="queryMode() !== 'advanced'" (click)="queryMode.set('advanced')">{{ 'brain.query.mode.advancedQuery' | transloco }}</button>
            </div>

            <!-- Semantic Search mode -->
            @if (queryMode() === 'search') {
              <div class="query-form">
                <div class="field" style="margin-bottom:0;">
                  <label>{{ 'brain.query.search.label' | transloco }}</label>
                  <input
                    type="text"
                    [(ngModel)]="recallForm.query"
                    name="recallQuery"
                    [placeholder]="'brain.query.search.placeholder' | transloco"
                    style="width:100%; font-size:14px; padding:8px 12px;"
                    (keydown.enter)="runRecall()"
                    [attr.aria-label]="'brain.query.search.label' | transloco"
                  />
                </div>
                <div class="query-form-row" style="margin-top:8px;">
                  <div class="field" style="min-width:100px; margin:0;">
                    <label>{{ 'brain.query.topK' | transloco }} <span style="color:var(--text-muted);font-size:11px;" [attr.title]="'brain.query.topK.tooltip' | transloco"><ph-icon name="info" [size]="11" style="display:inline-flex;vertical-align:middle;"/></span></label>
                    <input type="number" [(ngModel)]="recallForm.topK" name="recallTopK" min="1" max="100" style="width:80px;" />
                  </div>
                  <div class="field" style="min-width:120px; margin:0;">
                    <label>{{ 'brain.query.minScore' | transloco }} <span style="color:var(--text-muted);font-size:11px;" [attr.title]="'brain.query.minScore.tooltip' | transloco"><ph-icon name="info" [size]="11" style="display:inline-flex;vertical-align:middle;"/></span></label>
                    <input type="number" [(ngModel)]="recallForm.minScore" name="recallMinScore" min="0" max="1" step="0.05" style="width:80px;" />
                  </div>
                </div>
                <div style="display:flex; align-items:center; gap:10px; margin-top:8px;">
                  <button class="btn btn-sm btn-primary" [disabled]="recallRunning() || !recallForm.query.trim()" (click)="runRecall()">
                    @if (recallRunning()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                    {{ 'brain.query.searchButton' | transloco }}
                  </button>
                  @if (recallResults().length) {
                    <button class="btn btn-sm btn-secondary" (click)="clearRecall()">{{ 'brain.query.clearResults' | transloco }}</button>
                  }
                  @if (recallError()) {
                    <span style="font-size:12px; color:var(--error);">{{ recallError() }}</span>
                  }
                </div>
              </div>

              @if (recallResults().length) {
                <div class="query-results-header" style="margin-top:12px;">
                  <strong>{{ recallResults().length }}</strong> {{ 'brain.query.resultsCount' | transloco: { count: recallResults().length } }}
                </div>
                @for (r of recallResults(); track $index) {
                  <div class="query-result-card" style="margin-top:6px;">
                    <div style="display:flex; gap:8px; margin-bottom:4px; align-items:center;">
                      <span class="badge badge-purple" style="font-size:10px;">{{ r.type }}</span>
                      @if (r.score != null) {
                        <span style="font-size:11px; color:var(--text-muted);">{{ 'common.score' | transloco }}: {{ r.score.toFixed(3) }}</span>
                      }
                    </div>
                    <div style="white-space:pre-wrap; word-break:break-all;">{{ formatQueryDoc(r) }}</div>
                  </div>
                }
              }
            }

            <!-- Advanced Query mode -->
            @if (queryMode() === 'advanced') {
              <div class="query-form">
                <div class="query-form-row">
                  <div class="field" style="min-width:160px;">
                    <label>{{ 'brain.query.collection' | transloco }}</label>
                    <select [(ngModel)]="queryForm.collection" name="queryCollection" [attr.aria-label]="'brain.query.collection' | transloco">
                      @for (c of queryCollections; track c) { <option [value]="c">{{ c }}</option> }
                    </select>
                  </div>
                  <div class="field" style="min-width:80px;">
                    <label>{{ 'brain.query.limit' | transloco }}</label>
                    <input type="number" [(ngModel)]="queryForm.limit" name="queryLimit" min="1" max="100" style="width:80px;" />
                  </div>
                  <div class="field" style="min-width:100px;">
                    <label>{{ 'brain.query.maxTimeMs' | transloco }}</label>
                    <input type="number" [(ngModel)]="queryForm.maxTimeMS" name="queryMaxTimeMS" min="100" max="30000" style="width:100px;" />
                  </div>
                </div>
                <div class="field">
                  <label>{{ 'brain.query.filter' | transloco }} <span style="color:var(--text-muted);font-size:11px;">{{ 'brain.query.filterHint' | transloco }}</span></label>
                  <textarea
                    class="query-textarea"
                    [class.error]="queryFilterError()"
                    [(ngModel)]="queryForm.filter"
                    name="queryFilter"
                    rows="3"
                    [placeholder]="'brain.query.filterPlaceholder' | transloco"
                  ></textarea>
                  @if (queryFilterError()) {
                    <div style="font-size:11px; color:var(--error); margin-top:3px;">{{ queryFilterError() }}</div>
                  }
                </div>
                <div class="field">
                  <label>{{ 'brain.query.projection' | transloco }} <span style="color:var(--text-muted);font-size:11px;">{{ 'brain.query.projectionHint' | transloco }}</span></label>
                  <textarea
                    class="query-textarea"
                    [class.error]="queryProjectionError()"
                    [(ngModel)]="queryForm.projection"
                    name="queryProjection"
                    rows="2"
                    [placeholder]="'brain.query.projectionPlaceholder' | transloco"
                  ></textarea>
                  @if (queryProjectionError()) {
                    <div style="font-size:11px; color:var(--error); margin-top:3px;">{{ queryProjectionError() }}</div>
                  }
                </div>
                <div style="display:flex; align-items:center; gap:10px;">
                  <button class="btn btn-sm btn-primary" [disabled]="queryRunning()" (click)="runQuery()">
                    @if (queryRunning()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                    {{ 'brain.query.runQuery' | transloco }}
                  </button>
                  @if (queryResult()) {
                    <button class="btn btn-sm btn-secondary" (click)="clearQuery()">{{ 'brain.query.clearResults' | transloco }}</button>
                  }
                  @if (queryError()) {
                    <span style="font-size:12px; color:var(--error);">{{ queryError() }}</span>
                  }
                </div>
              </div>

              @if (queryResult(); as res) {
                <div class="query-results-header">
                  <strong>{{ res.count }}</strong> {{ 'brain.query.resultsFrom' | transloco: { count: res.count, collection: res.collection } }}
                </div>
                @if (res.results.length === 0) {
                  <div class="query-empty">{{ 'brain.query.noDocuments' | transloco }}</div>
                } @else {
                  @for (doc of res.results; track $index) {
                    <div class="query-result-card">{{ formatQueryDoc(doc) }}</div>
                  }
                }
              }
            }
          </div>
        }

      }

      <!-- Detail Drawer -->
      @if (drawerRecord(); as dr) {
        <div class="drawer-overlay" (click)="closeDrawer()">
          <div class="drawer" (click)="$event.stopPropagation()" role="dialog" [attr.aria-label]="'brain.drawer.recordDetailsAriaLabel' | transloco">
            <div class="drawer-header">
              <div style="flex:1; min-width:0;">
                @if (dr.kind === 'memory') { <span class="badge badge-blue" style="margin-bottom:6px; display:inline-block;">{{ 'brain.drawer.badge.memory' | transloco }}</span> }
                @if (dr.kind === 'entity') { <span class="badge badge-purple" style="margin-bottom:6px; display:inline-block;">{{ 'brain.drawer.badge.entity' | transloco }}</span> }
                @if (dr.kind === 'edge') { <span class="badge badge-blue" style="margin-bottom:6px; display:inline-block;">{{ 'brain.drawer.badge.edge' | transloco }}</span> }
                @if (dr.kind === 'chrono') { <span class="badge" style="margin-bottom:6px; display:inline-block;">{{ 'brain.drawer.badge.chrono' | transloco }}</span> }
                <div class="drawer-title">
                  @if (dr.kind === 'memory') { {{ drawerEditMemory.fact.length > 80 ? (drawerEditMemory.fact | slice:0:80) + '\u2026' : drawerEditMemory.fact }} }
                  @if (dr.kind === 'entity') { {{ drawerEditEntity.name || dr.record.name }} }
                  @if (dr.kind === 'edge') { {{ (dr.record.fromName || dr.record.from) + ' \u2192 ' + (dr.record.toName || dr.record.to) }} }
                  @if (dr.kind === 'chrono') { {{ drawerEditChrono.title || dr.record.title }} }
                </div>
              </div>
              <div style="display:flex; gap:8px; flex-shrink:0; align-items:flex-start; padding-top:2px;">
                <button class="btn btn-sm btn-primary" [disabled]="drawerSaving()" (click)="saveDrawer()">
                  @if (drawerSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } {{ 'common.save' | transloco }}
                </button>
                <button class="icon-btn" [attr.title]="'common.close' | transloco" [attr.aria-label]="'brain.drawer.closeDetailsAriaLabel' | transloco" (click)="closeDrawer()"><ph-icon name="x" [size]="16"/></button>
              </div>
            </div>
            @if (drawerError()) {
              <div class="alert alert-error" style="margin-bottom:16px; font-size:13px;">{{ drawerError() }}</div>
            }

            <form>
              <!-- ── MEMORY ── -->
              @if (dr.kind === 'memory') {
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.fact' | transloco }} <span style="color:var(--error)">*</span></div>
                  <textarea [(ngModel)]="drawerEditMemory.fact" name="drwMemFact" rows="4"></textarea>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.description' | transloco }}</div>
                  <input type="text" [(ngModel)]="drawerEditMemory.description" name="drwMemDesc" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.tags' | transloco }}</div>
                  <app-tag-input [(value)]="drawerEditMemory.tags" [suggestions]="memoryTagSuggestions()" inputName="drwMemTags" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.entityIds' | transloco }}</div>
                  <div class="flyout-wrap">
                    <div class="entity-multi">
                      @for (chip of entityChips(drawerEditMemory.entityIds); track chip.id) {
                        <span class="chip" [title]="chip.id"><span class="chip-name">{{ chip.name }}</span><button type="button" class="chip-remove" (mousedown)="removeEntityId(drawerEditMemory, chip.id)"><ph-icon name="x" [size]="12"/></button></span>
                      }
                      <button type="button" class="chip-add" (click)="openFlyout('drawer-memory-entityIds')">{{ 'common.addMore' | transloco }}</button>
                    </div>
                    @if (flyoutField() === 'drawer-memory-entityIds') {
                      <div class="flyout-panel">
                        <app-entity-search mode="picker" [spaceId]="activeSpaceId()" placeholder="common.searchEntitiesPlaceholder" defaultMode="semantic" (selected)="pickEntity($event, 'multi', 'drawer-memory-entityIds')" />
                        <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                          <button type="button" class="btn btn-sm btn-secondary" (click)="closeFlyout()">{{ 'common.done' | transloco }}</button>
                        </div>
                      </div>
                    }
                  </div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.properties' | transloco }}</div>
                  <app-properties-editor [schema]="memorySchema()" [required]="requiredProps(memorySchema())" [(value)]="drawerEditMemory.properties" />
                </div>
                <hr class="drawer-hr">
                <div class="drawer-field">
                  <div class="drawer-label">_id</div>
                  <div class="drawer-readonly-value" style="font-family:var(--font-mono,monospace); font-size:11px;">{{ dr.record._id }}</div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.seq' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.seq }}</div>
                </div>
                @if (dr.record.author) {
                  <div class="drawer-field">
                    <div class="drawer-label">{{ 'common.authorInstanceId' | transloco }}</div>
                    <div class="drawer-readonly-value">{{ dr.record.author.instanceId }}</div>
                  </div>
                }
                <div class="drawer-field" style="margin-bottom:0;">
                  <div class="drawer-label">{{ 'common.createdAt' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.createdAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
              }

              <!-- ── ENTITY ── -->
              @if (dr.kind === 'entity') {
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'brain.entities.table.name' | transloco }} <span style="color:var(--error)">*</span></div>
                  <input type="text" [(ngModel)]="drawerEditEntity.name" name="drwEntName" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.type' | transloco }} @if (entityTypeNames().length) { <span style="color:var(--error)">*</span> }</div>
                  @if (entityTypeNames().length) {
                    <select [(ngModel)]="drawerEditEntity.type" name="drwEntType" (ngModelChange)="onEntityTypeChange($event, 'drawer')">
                      @for (t of entityTypeNames(); track t) {
                        <option [value]="t">{{ t }}</option>
                      }
                    </select>
                  } @else {
                    <input type="text" [(ngModel)]="drawerEditEntity.type" name="drwEntType" />
                  }
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.description' | transloco }}</div>
                  <input type="text" [(ngModel)]="drawerEditEntity.description" name="drwEntDesc" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.tags' | transloco }}</div>
                  <app-tag-input [(value)]="drawerEditEntity.tags" [suggestions]="entityTagSuggestions()" inputName="drwEntTags" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.properties' | transloco }}</div>
                  <app-properties-editor [schema]="entitySchema(drawerEditEntity.type)" [required]="requiredProps(entitySchema(drawerEditEntity.type))" [(value)]="drawerEditEntity.properties" />
                </div>
                <hr class="drawer-hr">
                <div class="drawer-field">
                  <div class="drawer-label">_id</div>
                  <div class="drawer-readonly-value" style="font-family:var(--font-mono,monospace); font-size:11px;">{{ dr.record._id }}</div>
                </div>
                <div class="drawer-field" style="margin-bottom:0;">
                  <div class="drawer-label">{{ 'common.createdAt' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.createdAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
              }

              <!-- ── EDGE ── -->
              @if (dr.kind === 'edge') {
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.from' | transloco }} <span class="drawer-muted">{{ 'common.readOnly' | transloco }}</span></div>
                  <div class="drawer-readonly-value">{{ dr.record.fromName || dr.record.from }}<span style="font-size:11px;"> ({{ dr.record.from }})</span></div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'brain.edges.table.relation' | transloco }} <span style="color:var(--error)">*</span></div>
                  @if (edgeLabelNames().length) {
                    <select [(ngModel)]="drawerEditEdge.label" name="drwEdgeLabel">
                      @for (l of edgeLabelNames(); track l) {
                        <option [value]="l">{{ l }}</option>
                      }
                    </select>
                  } @else {
                    <input type="text" [(ngModel)]="drawerEditEdge.label" name="drwEdgeLabel" />
                  }
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.to' | transloco }} <span class="drawer-muted">{{ 'common.readOnly' | transloco }}</span></div>
                  <div class="drawer-readonly-value">{{ dr.record.toName || dr.record.to }}<span style="font-size:11px;"> ({{ dr.record.to }})</span></div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.type' | transloco }}</div>
                  <input type="text" [(ngModel)]="drawerEditEdge.type" name="drwEdgeType" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.weight' | transloco }}</div>
                  <input type="number" [(ngModel)]="drawerEditEdge.weight" name="drwEdgeWeight" step="0.1" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.description' | transloco }}</div>
                  <input type="text" [(ngModel)]="drawerEditEdge.description" name="drwEdgeDesc" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.tags' | transloco }}</div>
                  <app-tag-input [(value)]="drawerEditEdge.tags" [suggestions]="edgeTagSuggestions()" inputName="drwEdgeTags" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.properties' | transloco }}</div>
                  <app-properties-editor [schema]="edgeSchema(drawerEditEdge.label)" [required]="requiredProps(edgeSchema(drawerEditEdge.label))" [(value)]="drawerEditEdge.properties" />
                </div>
                <hr class="drawer-hr">
                <div class="drawer-field">
                  <div class="drawer-label">_id</div>
                  <div class="drawer-readonly-value" style="font-family:var(--font-mono,monospace); font-size:11px;">{{ dr.record._id }}</div>
                </div>
                <div class="drawer-field" style="margin-bottom:0;">
                  <div class="drawer-label">{{ 'common.createdAt' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.createdAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
              }

              <!-- ── CHRONO ── -->
              @if (dr.kind === 'chrono') {
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.title' | transloco }} <span style="color:var(--error)">*</span></div>
                  <input type="text" [(ngModel)]="drawerEditChrono.title" name="drwChronoTitle" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.kind' | transloco }} <span style="color:var(--error)">*</span></div>
                  @if (drawerEditChrono.kind !== '__custom__') {
                    <select [(ngModel)]="drawerEditChrono.kind" name="drwChronoKind">
                      @for (k of chronoKinds; track k) { <option [value]="k">{{ k }}</option> }
                      <option value="__custom__">{{ 'brain.chrono.form.customKind' | transloco }}</option>
                    </select>
                  } @else {
                    <div style="display:flex; gap:4px;">
                      <input type="text" [(ngModel)]="drawerEditChrono.customKind" name="drwChronoCustomKind" style="flex:1;" />
                      <button type="button" class="btn-secondary btn btn-sm" style="padding:4px 8px;" (click)="drawerEditChrono.kind = 'event'; drawerEditChrono.customKind = ''" [attr.title]="'brain.chrono.form.backToPresets' | transloco"><ph-icon name="x" [size]="14"/></button>
                    </div>
                  }
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'brain.chrono.table.status' | transloco }}</div>
                  <select [(ngModel)]="drawerEditChrono.status" name="drwChronoStatus">
                    @for (s of chronoStatusOptions; track s) { <option [value]="s">{{ s }}</option> }
                  </select>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.startsAt' | transloco }} <span style="color:var(--error)">*</span></div>
                  <input type="datetime-local" [(ngModel)]="drawerEditChrono.startsAt" name="drwChronoStarts" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.endsAt' | transloco }}</div>
                  <input type="datetime-local" [(ngModel)]="drawerEditChrono.endsAt" name="drwChronoEnds" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.confidence' | transloco }} <span class="drawer-muted">(0-1)</span></div>
                  <input type="number" [(ngModel)]="drawerEditChrono.confidence" name="drwChronoConf" min="0" max="1" step="0.01" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.description' | transloco }}</div>
                  <textarea [(ngModel)]="drawerEditChrono.description" name="drwChronoDesc" rows="3"></textarea>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.tags' | transloco }}</div>
                  <app-tag-input [(value)]="drawerEditChrono.tags" [suggestions]="chronoTagSuggestions()" inputName="drwChronoTags" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.entityIds' | transloco }}</div>
                  <div class="flyout-wrap">
                    <div class="entity-multi">
                      @for (chip of entityChips(drawerEditChrono.entityIds); track chip.id) {
                        <span class="chip" [title]="chip.id"><span class="chip-name">{{ chip.name }}</span><button type="button" class="chip-remove" (mousedown)="removeEntityId(drawerEditChrono, chip.id)"><ph-icon name="x" [size]="12"/></button></span>
                      }
                      <button type="button" class="chip-add" (click)="openFlyout('drawer-chrono-entityIds')">{{ 'common.addMore' | transloco }}</button>
                    </div>
                    @if (flyoutField() === 'drawer-chrono-entityIds') {
                      <div class="flyout-panel">
                        <app-entity-search mode="picker" [spaceId]="activeSpaceId()" placeholder="common.searchEntitiesPlaceholder" defaultMode="semantic" (selected)="pickEntity($event, 'multi', 'drawer-chrono-entityIds')" />
                        <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                          <button type="button" class="btn btn-sm btn-secondary" (click)="closeFlyout()">{{ 'common.done' | transloco }}</button>
                        </div>
                      </div>
                    }
                  </div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.memoryIds' | transloco }} <span class="drawer-muted">{{ 'common.commaSeparatedIds' | transloco }}</span></div>
                  <textarea [(ngModel)]="drawerEditChrono.memoryIds" name="drwChronoMemIds" rows="2" style="font-family:var(--font-mono,monospace); font-size:11px;"></textarea>
                </div>
                <hr class="drawer-hr">
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.spaceId' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.spaceId }}</div>
                </div>
                @if (dr.record.recurrence) {
                  <div class="drawer-field">
                    <div class="drawer-label">{{ 'common.recurrence' | transloco }}</div>
                    <div class="drawer-readonly-value" style="font-family:var(--font-mono,monospace); font-size:11px;">{{ dr.record.recurrence | json }}</div>
                  </div>
                }
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.author' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.author?.instanceLabel }} ({{ dr.record.author?.instanceId }})</div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.seq' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.seq }}</div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">_id</div>
                  <div class="drawer-readonly-value" style="font-family:var(--font-mono,monospace); font-size:11px;">{{ dr.record._id }}</div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.createdAt' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.createdAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
                <div class="drawer-field" style="margin-bottom:0;">
                  <div class="drawer-label">{{ 'common.updatedAt' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.updatedAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
              }
            </form>

          </div>
        </div>
      }
    }
  `,
})
export class BrainComponent implements OnInit {
  private api = inject(ApiService);

  collectionTabs: { key: BrainTab; label: string; statsKey?: keyof SpaceStats }[] = [
    { key: 'entities', label: 'Entities', statsKey: 'entities' },
    { key: 'edges', label: 'Edges', statsKey: 'edges' },
    { key: 'memories', label: 'Memories', statsKey: 'memories' },
    { key: 'chrono', label: 'Chrono', statsKey: 'chrono' },
    { key: 'filemeta', label: 'File Meta', statsKey: 'files' },
  ];

  readonly pageSize = 20;

  spaces = signal<SpaceView[]>([]);
  activeSpaceId = signal('');
  activeTab = signal<BrainTab>('query');
  loading = signal(false);
  loadingSpaces = signal(true);

  memories = signal<Memory[]>([]);
  entities = signal<Entity[]>([]);
  edges = signal<Edge[]>([]);
  chrono = signal<ChronoEntry[]>([]);
  fileMetas = signal<FileMeta[]>([]);
  fileMetaSkip = signal(0);
  fileMetaSearch = signal('');
  fileManagerNavPath = signal('');

  editFileMeta = { description: '', tags: [] as string[], entityIds: '', memoryIds: [] as string[], chronoIds: [] as string[] };
  drawerEditFileMeta = { description: '', tags: [] as string[], entityIds: '', memoryIds: [] as string[], chronoIds: [] as string[] };
  fmMemPickerQuery = signal('');
  fmMemPickerResults = signal<Memory[]>([]);
  fmChronoPickerQuery = signal('');
  fmChronoPickerResults = signal<ChronoEntry[]>([]);
  fmDrawerMemPickerQuery = signal('');
  fmDrawerMemPickerResults = signal<Memory[]>([]);
  fmDrawerChronoPickerQuery = signal('');
  fmDrawerChronoPickerResults = signal<ChronoEntry[]>([]);
  private _fmMemTimer: ReturnType<typeof setTimeout> | null = null;
  private _fmChronoTimer: ReturnType<typeof setTimeout> | null = null;
  private _fmDrawerMemTimer: ReturnType<typeof setTimeout> | null = null;
  private _fmDrawerChronoTimer: ReturnType<typeof setTimeout> | null = null;

  memoryTagSuggestions = computed(() => [...new Set([
    ...(this.spaceMeta()?.tagSuggestions ?? []),
    ...this.memories().flatMap(m => m.tags ?? []),
  ])]);
  entityTagSuggestions = computed(() => [...new Set([
    ...(this.spaceMeta()?.tagSuggestions ?? []),
    ...this.entities().flatMap(e => e.tags ?? []),
  ])]);
  edgeTagSuggestions = computed(() => [...new Set([
    ...(this.spaceMeta()?.tagSuggestions ?? []),
    ...this.edges().flatMap(e => e.tags ?? []),
  ])]);
  chronoTagSuggestions = computed(() => [...new Set([
    ...(this.spaceMeta()?.tagSuggestions ?? []),
    ...this.chrono().flatMap(c => c.tags ?? []),
  ])]);

  entityTypeNames(): string[] {
    return Object.keys(this.spaceMeta()?.typeSchemas?.entity ?? {});
  }
  edgeLabelNames(): string[] {
    return Object.keys(this.spaceMeta()?.typeSchemas?.edge ?? {});
  }
  entitySchema(typeName: string | undefined): Record<string, PropertySchema> | undefined {
    if (!typeName) return undefined;
    return this.spaceMeta()?.typeSchemas?.entity?.[typeName]?.propertySchemas;
  }
  edgeSchema(labelName: string | undefined): Record<string, PropertySchema> | undefined {
    if (!labelName) return undefined;
    return this.spaceMeta()?.typeSchemas?.edge?.[labelName]?.propertySchemas;
  }
  memorySchema(): Record<string, PropertySchema> | undefined {
    const ts = this.spaceMeta()?.typeSchemas?.memory;
    if (!ts) return undefined;
    return Object.values(ts)[0]?.propertySchemas;
  }
  requiredProps(schema: Record<string, PropertySchema> | undefined): string[] {
    if (!schema) return [];
    return Object.entries(schema).filter(([, s]) => s.required).map(([k]) => k);
  }

  filteredMemories = computed(() => {
    if (this.memorySearchMode() === 'semantic') return this.memories();
    const q = this.memorySearch().toLowerCase().trim();
    if (!q) return this.memories();
    return this.memories().filter(m => m.fact.toLowerCase().includes(q));
  });

  filteredChrono = computed(() => {
    if (this.chronoSearchMode() === 'semantic') return this.chrono();
    const q = this.chronoSearch().toLowerCase().trim();
    if (!q) return this.chrono();
    return this.chrono().filter(e =>
      e.title.toLowerCase().includes(q) ||
      (e.description ?? '').toLowerCase().includes(q) ||
      e.type.toLowerCase().includes(q) ||
      e.tags.some(t => t.toLowerCase().includes(q)),
    );
  });

  filteredEdges = computed(() => {
    if (this.edgeSearchMode() === 'semantic') return this.edges();
    const q = this.edgeSearch().toLowerCase().trim();
    if (!q) return this.edges();
    return this.edges().filter(e =>
      e.label.toLowerCase().includes(q) ||
      (e.fromName ?? '').toLowerCase().includes(q) ||
      (e.toName ?? '').toLowerCase().includes(q)
    );
  });

  filteredFileMetas = computed(() => {
    const q = this.fileMetaSearch().toLowerCase().trim();
    if (!q) return this.fileMetas();
    return this.fileMetas().filter(fm =>
      fm.path.toLowerCase().includes(q) ||
      (fm.description ?? '').toLowerCase().includes(q) ||
      fm.tags.some(t => t.toLowerCase().includes(q)),
    );
  });

  // Memories pagination + filter
  skip = signal(0);
  filterTag = signal('');
  filterEntity = signal('');

  // Entities pagination + search
  entitySkip = signal(0);
  entitySearch = signal('');
  memorySearch = signal('');
  edgeSearch = signal('');
  chronoSearch = signal('');
  memorySearchMode = signal<'text' | 'semantic'>('text');
  edgeSearchMode = signal<'text' | 'semantic'>('text');
  chronoSearchMode = signal<'text' | 'semantic'>('text');
  private _memSemTimer: ReturnType<typeof setTimeout> | null = null;
  private _edgeSemTimer: ReturnType<typeof setTimeout> | null = null;
  private _chronoSemTimer: ReturnType<typeof setTimeout> | null = null;

  // Edges pagination
  edgeSkip = signal(0);

  // Chrono pagination
  chronoSkip = signal(0);

  // Reindex
  needsReindex = signal(false);
  reindexing = signal(false);
  reindexResult = signal('');

  // Inline delete confirmation (stores the ID pending confirmation)
  confirmDeleteId = signal('');

  // Inline edit state
  editingId = signal('');
  editSaving = signal(false);
  editError = signal('');
  editMemory = { fact: '', tags: [] as string[], entityIds: '', description: '', properties: {} as Record<string, string | number | boolean> };
  editEntity = { name: '', type: '', tags: [] as string[], description: '', properties: {} as Record<string, string | number | boolean> };
  editEdge = { from: '', to: '', fromName: undefined as string | undefined, toName: undefined as string | undefined, label: '', weight: null as number | null, tags: [] as string[], description: '', properties: {} as Record<string, string | number | boolean> };
  editChrono = { title: '', kind: '' as string, status: '' as string, startsAt: '', endsAt: '', description: '', tags: [] as string[], entityIds: '' };

  // Create memory form
  showMemoryForm = signal(false);
  creatingMemory = signal(false);
  createMemoryError = signal('');
  memoryForm = { fact: '', tags: [] as string[], entityIds: '', description: '', properties: {} as Record<string, string | number | boolean> };

  // Create entity form
  showEntityForm = signal(false);
  creatingEntity = signal(false);
  createEntityError = signal('');
  entityForm = { name: '', type: '', tags: [] as string[], description: '', properties: {} as Record<string, string | number | boolean> };

  // Create edge form
  showEdgeForm = signal(false);
  creatingEdge = signal(false);
  createEdgeError = signal('');
  edgeForm = { from: '', fromDisplay: '', to: '', toDisplay: '', label: '', weight: null as number | null, tags: [] as string[], description: '', properties: {} as Record<string, string | number | boolean> };

  // Create chrono form
  showChronoForm = signal(false);
  creatingChrono = signal(false);
  createChronoError = signal('');
  chronoKinds: ChronoType[] = ['event', 'deadline', 'plan', 'prediction', 'milestone'];
  chronoStatusOptions: ChronoStatus[] = ['upcoming', 'active', 'completed', 'overdue', 'cancelled'];
  chronoForm = { title: '', kind: 'event' as ChronoType | '__custom__', customKind: '', startsAt: '', endsAt: '', description: '', tags: [] as string[], entityIds: '' };

  // Query panel
  queryMode = signal<'search' | 'advanced'>('search');
  queryCollections: QueryCollection[] = ['memories', 'entities', 'edges', 'chrono', 'files'];
  queryForm = { collection: 'memories' as QueryCollection, filter: '', projection: '', limit: 20, maxTimeMS: 5000 };
  queryRunning = signal(false);
  queryResult = signal<QueryResult | null>(null);
  queryError = signal('');
  queryFilterError = signal('');
  queryProjectionError = signal('');

  // Semantic search
  recallKnowledgeTypes: RecallKnowledgeType[] = ['memory', 'entity', 'edge', 'chrono', 'file'];
  recallForm = { query: '', topK: 10, minScore: 0 };
  recallRunning = signal(false);
  recallResults = signal<RecallResult[]>([]);
  recallError = signal('');

  // Settings tab (schema only — UI lives in Admin → Spaces)
  spaceMeta = signal<SpaceMetaResponse | null>(null);

  // Entity picker

  activeStats = computed(() =>
    this.spaces().find(sv => sv.space.id === this.activeSpaceId())?.stats,
  );

  spaceTotal(stats: SpaceStats): number {
    return stats.memories + stats.entities + stats.edges + stats.chrono + stats.files;
  }

  ngOnInit(): void {
    this.api.listSpaces().subscribe({
      next: ({ spaces }) => {
        this.spaces.set(spaces.map(s => ({ space: s })));
        this.loadingSpaces.set(false);
        if (spaces.length > 0) {
          this.selectSpace(spaces[0].id);
          // Pre-load stats for all other spaces so counts show on their chips
          spaces.slice(1).forEach(s => this.loadStats(s.id));
        }
      },
      error: () => this.loadingSpaces.set(false),
    });
  }

  selectSpace(id: string): void {
    this.activeSpaceId.set(id);
    this.skip.set(0);
    this.entitySkip.set(0);
    this.edgeSkip.set(0);
    this.chronoSkip.set(0);
    this.filterTag.set('');
    this.filterEntity.set('');
    this.entitySearch.set('');
    this.memorySearch.set('');
    this.edgeSearch.set('');
    this.chronoSearch.set('');
    this.memorySearchMode.set('text');
    this.edgeSearchMode.set('text');
    this.chronoSearchMode.set('text');
    this.confirmDeleteId.set('');
    this.reindexResult.set('');
    this.loadStats(id);
    this.loadSpaceMeta(id);
    this.loadCurrentTab(id);
  }

  setTab(tab: BrainTab): void {
    this.activeTab.set(tab);
    this.skip.set(0);
    this.entitySkip.set(0);
    this.edgeSkip.set(0);
    this.chronoSkip.set(0);
    this.fileMetaSkip.set(0);
    this.filterTag.set('');
    this.filterEntity.set('');
    this.memorySearch.set('');
    this.edgeSearch.set('');
    this.chronoSearch.set('');
    this.fileMetaSearch.set('');
    this.memorySearchMode.set('text');
    this.edgeSearchMode.set('text');
    this.chronoSearchMode.set('text');
    this.confirmDeleteId.set('');
    this.loadCurrentTab(this.activeSpaceId());
  }

  prevPage(): void { this.skip.update(s => Math.max(0, s - this.pageSize)); this.loadCurrentTab(this.activeSpaceId()); }
  nextPage(): void { this.skip.update(s => s + this.pageSize); this.loadCurrentTab(this.activeSpaceId()); }

  prevEntityPage(): void { this.entitySkip.update(s => Math.max(0, s - this.pageSize)); this.loadCurrentTab(this.activeSpaceId()); }
  nextEntityPage(): void { this.entitySkip.update(s => s + this.pageSize); this.loadCurrentTab(this.activeSpaceId()); }

  prevEdgePage(): void { this.edgeSkip.update(s => Math.max(0, s - this.pageSize)); this.loadCurrentTab(this.activeSpaceId()); }
  nextEdgePage(): void { this.edgeSkip.update(s => s + this.pageSize); this.loadCurrentTab(this.activeSpaceId()); }

  prevChronoPage(): void { this.chronoSkip.update(s => Math.max(0, s - this.pageSize)); this.loadCurrentTab(this.activeSpaceId()); }
  nextChronoPage(): void { this.chronoSkip.update(s => s + this.pageSize); this.loadCurrentTab(this.activeSpaceId()); }

  prevFileMetaPage(): void { this.fileMetaSkip.update(s => Math.max(0, s - this.pageSize)); this.loadCurrentTab(this.activeSpaceId()); }
  nextFileMetaPage(): void { this.fileMetaSkip.update(s => s + this.pageSize); this.loadCurrentTab(this.activeSpaceId()); }

  onFileMetaSearch(q: string): void {
    this.fileMetaSearch.set(q);
    // client-side filter via filteredFileMetas computed() — no API call per keystroke
  }

  searchEntities(): void { this.entitySkip.set(0); this.loadCurrentTab(this.activeSpaceId()); }

  // ── Entity search bar handlers (brain entities tab) ──────────────────────
  onEntitySearchChange(q: string): void {
    this.entitySearch.set(q);
    this.entitySkip.set(0);
    this.loadEntitiesSilent();
  }
  onEntitySearchClear(): void {
    this.entitySearch.set('');
    this.entitySkip.set(0);
    this.loadEntitiesSilent();
  }
  onEntitySearchPick(ent: Entity): void {
    this.entitySearch.set(ent.name);
    this.entitySkip.set(0);
    this.loadEntitiesSilent();
  }

  loadEntitiesSilent(): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.api.listEntities(spaceId, this.pageSize, this.entitySkip(), this.entitySearch() || undefined).subscribe({
      next: ({ entities }) => this.entities.set(entities),
      error: () => {},
    });
  }

  // ── Memory / Edge / Chrono search with mode toggle ─────────────────────────
  onMemorySearch(q: string): void {
    this.memorySearch.set(q);
    if (this.memorySearchMode() === 'semantic') {
      if (this._memSemTimer) clearTimeout(this._memSemTimer);
      if (!q.trim()) { this.memories.set([]); return; }
      this._memSemTimer = setTimeout(() => this.runSemanticMemorySearch(), 300);
    }
  }
  setMemorySearchMode(m: 'text' | 'semantic'): void {
    this.memorySearchMode.set(m);
    const q = this.memorySearch().trim();
    if (!q) return;
    if (m === 'semantic') this.runSemanticMemorySearch();
    else { this.skip.set(0); this.loadCurrentTab(this.activeSpaceId()); }
  }
  runSemanticMemorySearch(): void {
    const q = this.memorySearch().trim();
    const spaceId = this.activeSpaceId();
    if (!q || !spaceId) { this.memories.set([]); return; }
    this.api.recallBrain(spaceId, { query: q, types: ['memory'], topK: 20 }).pipe(
      catchError(() => of({ results: [], count: 0 })),
    ).subscribe(res => {
      this.memories.set(res.results.filter(r => r.type === 'memory').map(r => ({
        _id: r['_id'] as string,
        fact: (r['fact'] as string) ?? '',
        tags: (r['tags'] as string[]) ?? [],
        entityIds: (r['entityIds'] as string[]) ?? [],
        description: r['description'] as string | undefined,
        properties: (r['properties'] as Record<string, string | number | boolean>) ?? {},
        createdAt: (r['createdAt'] as string) ?? '',
        seq: (r['seq'] as number) ?? 0,
        author: r['author'] as { instanceId: string } | undefined,
      } as Memory)));
    });
  }

  onEdgeSearch(q: string): void {
    this.edgeSearch.set(q);
    if (this.edgeSearchMode() === 'semantic') {
      if (this._edgeSemTimer) clearTimeout(this._edgeSemTimer);
      if (!q.trim()) { this.edges.set([]); return; }
      this._edgeSemTimer = setTimeout(() => this.runSemanticEdgeSearch(), 300);
    }
  }
  setEdgeSearchMode(m: 'text' | 'semantic'): void {
    this.edgeSearchMode.set(m);
    const q = this.edgeSearch().trim();
    if (!q) return;
    if (m === 'semantic') this.runSemanticEdgeSearch();
    else { this.edgeSkip.set(0); this.loadCurrentTab(this.activeSpaceId()); }
  }
  runSemanticEdgeSearch(): void {
    const q = this.edgeSearch().trim();
    const spaceId = this.activeSpaceId();
    if (!q || !spaceId) { this.edges.set([]); return; }
    this.api.recallBrain(spaceId, { query: q, types: ['edge'], topK: 20 }).pipe(
      catchError(() => of({ results: [], count: 0 })),
    ).subscribe(res => {
      this.edges.set(res.results.filter(r => r.type === 'edge').map(r => ({
        _id: r['_id'] as string,
        from: (r['from'] as string) ?? '',
        fromName: r['fromName'] as string | undefined,
        to: (r['to'] as string) ?? '',
        toName: r['toName'] as string | undefined,
        label: (r['label'] as string) ?? '',
        weight: r['weight'] as number | undefined,
        tags: (r['tags'] as string[]) ?? [],
        description: r['description'] as string | undefined,
        properties: (r['properties'] as Record<string, string | number | boolean>) ?? {},
        createdAt: (r['createdAt'] as string) ?? '',
      } as Edge)));
    });
  }

  onChronoSearch(q: string): void {
    this.chronoSearch.set(q);
    if (this.chronoSearchMode() === 'semantic') {
      if (this._chronoSemTimer) clearTimeout(this._chronoSemTimer);
      if (!q.trim()) { this.chrono.set([]); return; }
      this._chronoSemTimer = setTimeout(() => this.runSemanticChronoSearch(), 300);
    }
    // text mode: filteredChrono computed() handles filtering automatically
  }
  setChronoSearchMode(m: 'text' | 'semantic'): void {
    this.chronoSearchMode.set(m);
    const q = this.chronoSearch().trim();
    if (!q) return;
    if (m === 'semantic') this.runSemanticChronoSearch();
    // text mode: filteredChrono computed() handles filtering automatically
  }
  runSemanticChronoSearch(): void {
    const q = this.chronoSearch().trim();
    const spaceId = this.activeSpaceId();
    if (!q || !spaceId) { this.chrono.set([]); return; }
    this.api.recallBrain(spaceId, { query: q, types: ['chrono'], topK: 20 }).pipe(
      catchError(() => of({ results: [], count: 0 })),
    ).subscribe(res => {
      this.chrono.set(res.results.filter(r => r.type === 'chrono').map(r => ({
        _id: r['_id'] as string,
        spaceId: (r['spaceId'] as string) ?? spaceId,
        title: (r['title'] as string) ?? '',
        description: r['description'] as string | undefined,
        type: ((r['type'] as string) ?? 'event') as ChronoType,
        startsAt: (r['startsAt'] as string) ?? '',
        endsAt: r['endsAt'] as string | undefined,
        status: 'upcoming' as ChronoStatus,
        confidence: r['confidence'] as number | undefined,
        tags: (r['tags'] as string[]) ?? [],
        entityIds: (r['entityIds'] as string[]) ?? [],
        memoryIds: [],
        author: (r['author'] as { instanceId: string; instanceLabel: string }) ?? { instanceId: '', instanceLabel: '' },
        createdAt: (r['createdAt'] as string) ?? '',
        updatedAt: (r['createdAt'] as string) ?? '',
        seq: (r['seq'] as number) ?? 0,
      } as ChronoEntry)));
    });
  }

  applyChronoSearch(): void { this.chronoSkip.set(0); this.loadCurrentTab(this.activeSpaceId()); }

  loadStats(spaceId: string): void {
    this.api.getSpaceStats(spaceId).subscribe({
      next: (stats) => {
        this.spaces.update(list =>
          list.map(sv => sv.space.id === spaceId ? { ...sv, stats } : sv),
        );
      },
      error: () => {},
    });
    this.api.getReindexStatus(spaceId).subscribe({
      next: ({ needsReindex }) => this.needsReindex.set(needsReindex),
      error: () => {},
    });
  }

  private loadCurrentTab(spaceId: string): void {
    if (!spaceId) return;
    this.loading.set(true);

    switch (this.activeTab()) {
      case 'memories': {
        const filters: { tag?: string; entity?: string } = {};
        if (this.filterTag()) filters.tag = this.filterTag();
        if (this.filterEntity()) filters.entity = this.filterEntity();
        this.api.listMemories(spaceId, this.pageSize, this.skip(), filters).subscribe({
          next: ({ memories }) => {
            this.memories.set(memories);
            const ids = [...new Set(memories.flatMap(m => m.entityIds ?? []))];
            if (ids.length) this.resolveEntityNames(ids);
            this.loading.set(false);
          },
          error: () => this.loading.set(false),
        });
        break;
      }
      case 'entities':
        this.api.listEntities(spaceId, this.pageSize, this.entitySkip(), this.entitySearch() || undefined).subscribe({
          next: ({ entities }) => { this.entities.set(entities); this.loading.set(false); },
          error: () => this.loading.set(false),
        });
        break;
      case 'edges':
        this.api.listEdges(spaceId, this.pageSize, this.edgeSkip()).subscribe({
          next: ({ edges }) => { this.edges.set(edges); this.loading.set(false); },
          error: () => this.loading.set(false),
        });
        break;
      case 'chrono': {
        const cf: { search?: string } = {};
        if (this.chronoSearch()) cf.search = this.chronoSearch();
        this.api.listChrono(spaceId, this.pageSize, this.chronoSkip(), cf).subscribe({
          next: ({ chrono }) => {
            this.chrono.set(chrono);
            const ids = [...new Set(chrono.flatMap(e => e.entityIds ?? []))];
            if (ids.length) this.resolveEntityNames(ids);
            this.loading.set(false);
          },
          error: () => this.loading.set(false),
        });
        break;
      }
      case 'query':
        // Query tab manages its own loading state; just clear the global overlay
        this.loading.set(false);
        break;
      case 'graph':
        // Graph tab is self-contained; no data pre-fetch needed
        this.loading.set(false);
        break;
      case 'files':
        // File manager handles its own loading
        this.loading.set(false);
        break;
      case 'filemeta':
        this.api.listFileMeta(spaceId, this.pageSize, this.fileMetaSkip(), this.fileMetaSearch() || undefined).subscribe({
          next: ({ files }) => { this.fileMetas.set(files); this.loading.set(false); },
          error: () => this.loading.set(false),
        });
        break;
    }
  }

  applyFilter(type: 'tag' | 'entity', value: string): void {
    if (type === 'tag') this.filterTag.set(value);
    else this.filterEntity.set(value);
    this.skip.set(0);
    this.loadCurrentTab(this.activeSpaceId());
  }

  clearFilter(which: 'tag' | 'entity' | 'all'): void {
    if (which === 'tag' || which === 'all') this.filterTag.set('');
    if (which === 'entity' || which === 'all') this.filterEntity.set('');
    this.skip.set(0);
    this.loadCurrentTab(this.activeSpaceId());
  }

  requestDelete(id: string): void { this.confirmDeleteId.set(id); }
  cancelDelete(): void { this.confirmDeleteId.set(''); }

  // ── Inline edit methods ────────────────────────────────────────────────

  startEditMemory(mem: Memory): void {
    this.editingId.set(mem._id);
    this.editError.set('');
    this.editMemory = {
      fact: mem.fact,
      tags: mem.tags ?? [],
      entityIds: (mem.entityIds ?? []).join(', '),
      description: mem.description ?? '',
      properties: this.buildPropertiesObject('memory', mem.properties ?? {}),
    };
  }

  startEditEntity(ent: Entity): void {
    this.editingId.set(ent._id);
    this.editError.set('');
    this.editEntity = {
      name: ent.name,
      type: ent.type ?? '',
      tags: ent.tags ?? [],
      description: ent.description ?? '',
      properties: this.buildPropertiesObject('entity', ent.properties ?? {}),
    };
  }

  startEditEdge(edge: Edge): void {
    this.editingId.set(edge._id);
    this.editError.set('');
    this.editEdge = {
      from: edge.from,
      to: edge.to,
      fromName: edge.fromName,
      toName: edge.toName,
      label: edge.label,
      weight: edge.weight ?? null,
      tags: edge.tags ?? [],
      description: edge.description ?? '',
      properties: this.buildPropertiesObject('edge', edge.properties ?? {}),
    };
  }

  startEditChrono(entry: ChronoEntry): void {
    this.editingId.set(entry._id);
    this.editError.set('');
    this.editChrono = {
      title: entry.title,
      kind: entry.type,
      status: entry.status,
      startsAt: entry.startsAt ? this.toLocalDatetime(entry.startsAt) : '',
      endsAt: entry.endsAt ? this.toLocalDatetime(entry.endsAt) : '',
      description: entry.description ?? '',
      tags: entry.tags ?? [],
      entityIds: (entry.entityIds ?? []).join(', '),
    };
  }

  cancelEdit(): void {
    this.editingId.set('');
    this.editError.set('');
  }

  saveEditMemory(id: string): void {
    this.editSaving.set(true);
    this.editError.set('');
    const memProps = this.editMemory.properties;
    this.api.updateMemory(this.activeSpaceId(), id, {
      fact: this.editMemory.fact.trim(),
      tags: this.editMemory.tags,
      entityIds: this.editMemory.entityIds.split(',').map(s => s.trim()).filter(Boolean),
      description: this.editMemory.description.trim(),
      ...(Object.keys(memProps).length ? { properties: memProps } : {}),
    }).subscribe({
      next: (updated) => {
        this.editSaving.set(false);
        this.editingId.set('');
        this.memories.update(list => list.map(m => m._id === id ? updated : m));
      },
      error: (err) => { this.editSaving.set(false); this.editError.set(this.fmtApiError(err, 'Failed to save')); },
    });
  }

  saveEditEntity(id: string): void {
    this.editSaving.set(true);
    this.editError.set('');
    const entProps = this.editEntity.properties;
    this.api.updateEntity(this.activeSpaceId(), id, {
      name: this.editEntity.name.trim(),
      type: this.editEntity.type.trim(),
      tags: this.editEntity.tags,
      description: this.editEntity.description.trim(),
      ...(Object.keys(entProps).length ? { properties: entProps } : {}),
    }).subscribe({
      next: (updated) => {
        this.editSaving.set(false);
        this.editingId.set('');
        this.entities.update(list => list.map(e => e._id === id ? updated : e));
      },
      error: (err) => { this.editSaving.set(false); this.editError.set(this.fmtApiError(err, 'Failed to save')); },
    });
  }

  saveEditEdge(id: string): void {
    this.editSaving.set(true);
    this.editError.set('');
    const edgeProps = this.editEdge.properties;
    this.api.updateEdge(this.activeSpaceId(), id, {
      label: this.editEdge.label.trim(),
      tags: this.editEdge.tags,
      description: this.editEdge.description.trim(),
      ...(this.editEdge.weight != null ? { weight: this.editEdge.weight } : {}),
      ...(Object.keys(edgeProps).length ? { properties: edgeProps } : {}),
    }).subscribe({
      next: (updated) => {
        this.editSaving.set(false);
        this.editingId.set('');
        this.edges.update(list => list.map(e => e._id === id ? updated : e));
      },
      error: (err) => { this.editSaving.set(false); this.editError.set(this.fmtApiError(err, 'Failed to save')); },
    });
  }

  saveEditChrono(id: string): void {
    this.editSaving.set(true);
    this.editError.set('');
    this.api.updateChrono(this.activeSpaceId(), id, {
      title: this.editChrono.title.trim(),
      type: this.editChrono.kind as ChronoType,
      status: this.editChrono.status as ChronoStatus,
      ...(this.editChrono.startsAt ? { startsAt: new Date(this.editChrono.startsAt).toISOString() } : {}),
      ...(this.editChrono.endsAt ? { endsAt: new Date(this.editChrono.endsAt).toISOString() } : {}),
      description: this.editChrono.description.trim(),
      tags: this.editChrono.tags,
      entityIds: this.editChrono.entityIds.split(',').map(s => s.trim()).filter(Boolean),
    }).subscribe({
      next: (updated) => {
        this.editSaving.set(false);
        this.editingId.set('');
        this.chrono.update(list => list.map(c => c._id === id ? updated : c));
      },
      error: (err) => { this.editSaving.set(false); this.editError.set(this.fmtApiError(err, 'Failed to save')); },
    });
  }

  deleteMemory(id: string): void {
    this.confirmDeleteId.set('');
    this.api.deleteMemory(this.activeSpaceId(), id).subscribe({
      next: () => { this.memories.update(list => list.filter(m => m._id !== id)); this.loadStats(this.activeSpaceId()); },
      error: () => {},
    });
  }

  // ── File Meta inline edit ─────────────────────────────────────────────────

  startEditFileMeta(entry: FileMeta): void {
    this.editingId.set(entry._id);
    this.editError.set('');
    this.editFileMeta = {
      description: entry.description ?? '',
      tags: entry.tags ?? [],
      entityIds: (entry.entityIds ?? []).join(', '),
      memoryIds: [...(entry.memoryIds ?? [])],
      chronoIds: [...(entry.chronoIds ?? [])],
    };
    // Resolve entity names for chips display
    this.resolveEntityNamesForFlyout('edit-filemeta-entityIds');
  }

  saveEditFileMeta(id: string): void {
    this.editSaving.set(true);
    this.editError.set('');
    this.api.updateFileMeta(this.activeSpaceId(), id, {
      description: this.editFileMeta.description.trim(),
      tags: this.editFileMeta.tags,
      entityIds: this.editFileMeta.entityIds.split(',').map(s => s.trim()).filter(Boolean),
      memoryIds: this.editFileMeta.memoryIds,
      chronoIds: this.editFileMeta.chronoIds,
    }).subscribe({
      next: (updated) => {
        this.editSaving.set(false);
        this.editingId.set('');
        this.fileMetas.update(list => list.map(f => f._id === id ? updated : f));
      },
      error: (err) => { this.editSaving.set(false); this.editError.set(this.fmtApiError(err, 'Failed to save')); },
    });
  }

  deleteFileMeta(id: string): void {
    // Deleting just removes the metadata record, not the file itself.
    const fm = this.fileMetas().find(f => f._id === id);
    if (!fm) { this.confirmDeleteId.set(''); return; }
    this.api.deleteFileMeta(this.activeSpaceId(), fm.path).subscribe({
      next: () => {
        this.confirmDeleteId.set('');
        this.fileMetas.update(list => list.filter(f => f._id !== id));
        this.loadStats(this.activeSpaceId());
      },
      error: () => {
        this.confirmDeleteId.set('');
        alert('Failed to delete file metadata record.');
      },
    });
  }

  // ── File Meta navigation helpers ─────────────────────────────────────────

  /** Called from Files tab file preview: switch to Filemeta tab filtered by path. */
  openFileMetaEntry(path: string): void {
    this.fileMetaSearch.set(path.replace(/^\/+/, ''));
    this.fileMetaSkip.set(0);
    this.activeTab.set('filemeta');
    this.loadCurrentTab(this.activeSpaceId());
  }

  /** Called from Filemeta tab: switch to Files tab and navigate to the file's directory. */
  openFileInManager(path: string): void {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '/';
    this.fileManagerNavPath.set(dir === '/' ? '' : dir);
    this.setTab('files');
  }

  // ── File Meta memory/chrono pickers ──────────────────────────────────────

  onFmMemPickerInput(q: string, isDrawer = false): void {
    if (isDrawer) {
      this.fmDrawerMemPickerQuery.set(q);
      if (this._fmDrawerMemTimer) clearTimeout(this._fmDrawerMemTimer);
      if (!q.trim()) { this.fmDrawerMemPickerResults.set([]); return; }
      this._fmDrawerMemTimer = setTimeout(() => {
        this.api.listMemories(this.activeSpaceId(), 8, 0, {}).subscribe({
          next: ({ memories }) => this.fmDrawerMemPickerResults.set(
            memories.filter(m => m.fact.toLowerCase().includes(q.toLowerCase())).slice(0, 6),
          ),
          error: () => {},
        });
      }, 300);
    } else {
      this.fmMemPickerQuery.set(q);
      if (this._fmMemTimer) clearTimeout(this._fmMemTimer);
      if (!q.trim()) { this.fmMemPickerResults.set([]); return; }
      this._fmMemTimer = setTimeout(() => {
        this.api.listMemories(this.activeSpaceId(), 8, 0, {}).subscribe({
          next: ({ memories }) => this.fmMemPickerResults.set(
            memories.filter(m => m.fact.toLowerCase().includes(q.toLowerCase())).slice(0, 6),
          ),
          error: () => {},
        });
      }, 300);
    }
  }

  onFmChronoPickerInput(q: string, isDrawer = false): void {
    if (isDrawer) {
      this.fmDrawerChronoPickerQuery.set(q);
      if (this._fmDrawerChronoTimer) clearTimeout(this._fmDrawerChronoTimer);
      if (!q.trim()) { this.fmDrawerChronoPickerResults.set([]); return; }
      this._fmDrawerChronoTimer = setTimeout(() => {
        this.api.listChrono(this.activeSpaceId(), 8, 0, { search: q }).subscribe({
          next: ({ chrono }) => this.fmDrawerChronoPickerResults.set(chrono.slice(0, 6)),
          error: () => {},
        });
      }, 300);
    } else {
      this.fmChronoPickerQuery.set(q);
      if (this._fmChronoTimer) clearTimeout(this._fmChronoTimer);
      if (!q.trim()) { this.fmChronoPickerResults.set([]); return; }
      this._fmChronoTimer = setTimeout(() => {
        this.api.listChrono(this.activeSpaceId(), 8, 0, { search: q }).subscribe({
          next: ({ chrono }) => this.fmChronoPickerResults.set(chrono.slice(0, 6)),
          error: () => {},
        });
      }, 300);
    }
  }

  addFmMemoryId(form: { memoryIds: string[] }, id: string): void {
    if (!form.memoryIds.includes(id)) form.memoryIds.push(id);
    this.fmMemPickerQuery.set('');
    this.fmMemPickerResults.set([]);
    this.fmDrawerMemPickerQuery.set('');
    this.fmDrawerMemPickerResults.set([]);
  }

  removeFmMemoryId(form: { memoryIds: string[] }, id: string): void {
    form.memoryIds = form.memoryIds.filter(m => m !== id);
  }

  addFmChronoId(form: { chronoIds: string[] }, id: string): void {
    if (!form.chronoIds.includes(id)) form.chronoIds.push(id);
    this.fmChronoPickerQuery.set('');
    this.fmChronoPickerResults.set([]);
    this.fmDrawerChronoPickerQuery.set('');
    this.fmDrawerChronoPickerResults.set([]);
  }

  removeFmChronoId(form: { chronoIds: string[] }, id: string): void {
    form.chronoIds = form.chronoIds.filter(c => c !== id);
  }

  fmMemoryTitle(id: string): string {
    const mem = this.memories().find(m => m._id === id);
    return mem ? mem.fact.slice(0, 40) + (mem.fact.length > 40 ? '…' : '') : id.slice(0, 8) + '…';
  }

  fmChronoTitle(id: string): string {
    const c = this.chrono().find(c => c._id === id);
    return c ? c.title.slice(0, 40) + (c.title.length > 40 ? '…' : '') : id.slice(0, 8) + '…';
  }

  createMemory(): void {
    if (!this.memoryForm.fact.trim()) return;
    this.creatingMemory.set(true);
    this.createMemoryError.set('');
    const entityIds = this.memoryForm.entityIds.split(',').map(s => s.trim()).filter(Boolean);
    const body: Parameters<ApiService['createMemory']>[1] = { fact: this.memoryForm.fact.trim() };
    if (this.memoryForm.tags.length) body.tags = this.memoryForm.tags;
    if (entityIds.length) body.entityIds = entityIds;
    if (this.memoryForm.description.trim()) body.description = this.memoryForm.description.trim();
    if (Object.keys(this.memoryForm.properties).length) body.properties = this.memoryForm.properties;
    this.api.createMemory(this.activeSpaceId(), body).subscribe({
      next: () => {
        this.creatingMemory.set(false);
        this.showMemoryForm.set(false);
        this.memoryForm = { fact: '', tags: [], entityIds: '', description: '', properties: {} as Record<string, string | number | boolean> };
        this.loadStats(this.activeSpaceId());
        this.loadCurrentTab(this.activeSpaceId());
      },
      error: (err) => { this.creatingMemory.set(false); this.createMemoryError.set(this.fmtApiError(err, 'Failed to create memory')); },
    });
  }

  createEntity(): void {
    if (!this.entityForm.name.trim()) return;
    this.creatingEntity.set(true);
    this.createEntityError.set('');
    const body: Parameters<ApiService['createEntity']>[1] = { name: this.entityForm.name.trim() };
    if (this.entityForm.type.trim()) body.type = this.entityForm.type.trim();
    if (this.entityForm.tags.length) body.tags = this.entityForm.tags;
    if (this.entityForm.description.trim()) body.description = this.entityForm.description.trim();
    if (Object.keys(this.entityForm.properties).length) body.properties = this.entityForm.properties;
    this.api.createEntity(this.activeSpaceId(), body).subscribe({
      next: () => {
        this.creatingEntity.set(false);
        this.showEntityForm.set(false);
        this.entityForm = { name: '', type: '', tags: [], description: '', properties: {} as Record<string, string | number | boolean> };
        this.loadStats(this.activeSpaceId());
        this.loadCurrentTab(this.activeSpaceId());
      },
      error: (err) => { this.creatingEntity.set(false); this.createEntityError.set(this.fmtApiError(err, 'Failed to create entity')); },
    });
  }

  createEdge(): void {
    if (!this.edgeForm.from.trim() || !this.edgeForm.to.trim() || !this.edgeForm.label.trim()) return;
    this.creatingEdge.set(true);
    this.createEdgeError.set('');
    const body: Parameters<ApiService['createEdge']>[1] = {
      from: this.edgeForm.from.trim(),
      to: this.edgeForm.to.trim(),
      label: this.edgeForm.label.trim(),
    };
    if (this.edgeForm.weight != null) body.weight = this.edgeForm.weight;
    if (this.edgeForm.tags.length) body.tags = this.edgeForm.tags;
    if (this.edgeForm.description.trim()) body.description = this.edgeForm.description.trim();
    if (Object.keys(this.edgeForm.properties).length) body.properties = this.edgeForm.properties;
    this.api.createEdge(this.activeSpaceId(), body).subscribe({
      next: () => {
        this.creatingEdge.set(false);
        this.showEdgeForm.set(false);
        this.edgeForm = { from: '', fromDisplay: '', to: '', toDisplay: '', label: '', weight: null, tags: [], description: '', properties: {} as Record<string, string | number | boolean> };
        this.loadStats(this.activeSpaceId());
        this.loadCurrentTab(this.activeSpaceId());
      },
      error: (err) => { this.creatingEdge.set(false); this.createEdgeError.set(this.fmtApiError(err, 'Failed to create edge')); },
    });
  }

  deleteEntity(id: string): void {
    this.confirmDeleteId.set('');
    this.api.deleteEntity(this.activeSpaceId(), id).subscribe({
      next: () => { this.entities.update(list => list.filter(e => e._id !== id)); this.loadStats(this.activeSpaceId()); },
      error: () => {},
    });
  }

  deleteEdge(id: string): void {
    this.confirmDeleteId.set('');
    this.api.deleteEdge(this.activeSpaceId(), id).subscribe({
      next: () => this.edges.update(list => list.filter(e => e._id !== id)),
      error: () => {},
    });
  }

  createChrono(): void {
    if (!this.chronoForm.title.trim() || !this.chronoForm.startsAt) return;
    const resolvedKind = this.chronoForm.kind === '__custom__'
      // Custom kind: the server accepts free-text values beyond the predefined enum.
      ? (this.chronoForm.customKind.trim() as ChronoType)
      : this.chronoForm.kind as ChronoType;
    if (!resolvedKind) return;
    this.creatingChrono.set(true);
    this.createChronoError.set('');
    const entityIds = this.chronoForm.entityIds.split(',').map(s => s.trim()).filter(Boolean);
    const body: Parameters<ApiService['createChrono']>[1] = {
      title: this.chronoForm.title.trim(),
      type: resolvedKind,
      startsAt: new Date(this.chronoForm.startsAt).toISOString(),
    };
    if (this.chronoForm.endsAt) body.endsAt = new Date(this.chronoForm.endsAt).toISOString();
    if (this.chronoForm.description.trim()) body.description = this.chronoForm.description.trim();
    if (this.chronoForm.tags.length) body.tags = this.chronoForm.tags;
    if (entityIds.length) body.entityIds = entityIds;
    this.api.createChrono(this.activeSpaceId(), body).subscribe({
      next: () => {
        this.creatingChrono.set(false);
        this.showChronoForm.set(false);
        this.chronoForm = { title: '', kind: 'event', customKind: '', startsAt: '', endsAt: '', description: '', tags: [], entityIds: '' };
        this.loadCurrentTab(this.activeSpaceId());
      },
      error: (err) => { this.creatingChrono.set(false); this.createChronoError.set(this.fmtApiError(err, 'Failed to create chrono entry')); },
    });
  }

  deleteChrono(id: string): void {
    this.confirmDeleteId.set('');
    this.api.deleteChrono(this.activeSpaceId(), id).subscribe({
      next: () => this.chrono.update(list => list.filter(c => c._id !== id)),
      error: () => {},
    });
  }

  runReindex(): void {
    this.reindexing.set(true);
    this.reindexResult.set('');
    this.api.reindex(this.activeSpaceId()).subscribe({
      next: (result) => {
        this.reindexing.set(false);
        const total = Object.values(result).reduce((s: number, n) => s + (typeof n === 'number' ? n : 0), 0);
        this.reindexResult.set(`Reindexed ${total} documents.`);
        this.needsReindex.set(false);
        this.loadStats(this.activeSpaceId());
      },
      error: () => { this.reindexing.set(false); this.reindexResult.set('Reindex failed — check server logs.'); },
    });
  }

  /** Convert an ISO date string to the YYYY-MM-DDTHH:mm format required by datetime-local inputs */
  private toLocalDatetime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  runQuery(): void {
    this.queryFilterError.set('');
    this.queryProjectionError.set('');
    this.queryError.set('');

    let filter: Record<string, unknown> = {};
    let projection: Record<string, unknown> | undefined;

    if (this.queryForm.filter.trim()) {
      try { filter = JSON.parse(this.queryForm.filter.trim()); }
      catch (e) { this.queryFilterError.set(`Invalid JSON — ${e instanceof Error ? e.message : 'check your filter syntax'}`); return; }
    }
    if (this.queryForm.projection.trim()) {
      try { projection = JSON.parse(this.queryForm.projection.trim()); }
      catch (e) { this.queryProjectionError.set(`Invalid JSON — ${e instanceof Error ? e.message : 'check your projection syntax'}`); return; }
    }

    this.queryRunning.set(true);
    this.api.queryBrain(this.activeSpaceId(), {
      collection: this.queryForm.collection,
      filter,
      projection,
      limit: this.queryForm.limit,
      maxTimeMS: this.queryForm.maxTimeMS,
    }).subscribe({
      next: (res) => { this.queryRunning.set(false); this.queryResult.set(res); },
      error: (err) => {
        this.queryRunning.set(false);
        this.queryError.set(err.error?.error ?? 'Query failed');
      },
    });
  }

  clearQuery(): void {
    this.queryResult.set(null);
    this.queryError.set('');
  }

  runRecall(): void {
    if (!this.recallForm.query.trim()) return;
    this.recallRunning.set(true);
    this.recallError.set('');
    this.recallResults.set([]);
    this.api.recallBrain(this.activeSpaceId(), {
      query: this.recallForm.query.trim(),
      topK: this.recallForm.topK,
      minScore: this.recallForm.minScore || undefined,
    }).subscribe({
      next: (res) => { this.recallRunning.set(false); this.recallResults.set(res.results); },
      error: (err) => { this.recallRunning.set(false); this.recallError.set(err.error?.error ?? 'Search failed'); },
    });
  }

  clearRecall(): void {
    this.recallResults.set([]);
    this.recallError.set('');
  }

  formatQueryDoc(doc: Record<string, unknown>): string {
    return JSON.stringify(doc, null, 2);
  }

  // ── Space meta (schema, loaded for property prefill) ────────────────────

  loadSpaceMeta(spaceId: string): void {
    if (!spaceId) return;
    this.api.getSpaceMeta(spaceId).subscribe({
      next: (meta) => this.spaceMeta.set(meta),
      error: () => this.spaceMeta.set(null),
    });
  }

  // ── Form openers with schema prefill ────────────────────────────────────

  /** Format an API error response into a human-readable string.
   *  When the server returns { error: 'schema_violation', violations: [...] }
   *  this produces a message listing each violating field and why. */
  private fmtApiError(err: { error?: { error?: string; violations?: { field: string; value: unknown; reason: string }[] } }, fallback: string): string {
    const body = err?.error;
    if (body?.error === 'schema_violation' && Array.isArray(body.violations) && body.violations.length > 0) {
      const details = body.violations.map(v => `${v.field}: ${v.reason}`).join('; ');
      return `Schema violation — ${details}`;
    }
    return body?.error ?? fallback;
  }

  openEntityForm(): void {
    const firstType = Object.keys(this.spaceMeta()?.typeSchemas?.entity ?? {})[0] ?? '';
    this.entityForm = { name: '', type: firstType, tags: [], description: '', properties: this.buildPropertiesObject('entity') };
    this.showEntityForm.set(true);
  }

  /** Called when the entity type dropdown changes. Rebuilds properties: keeps existing values, adds defaults for any new schema-required fields. */
  onEntityTypeChange(_type: string, target: 'create' | 'inline' | 'drawer'): void {
    if (target === 'create') {
      this.entityForm.properties = this.buildPropertiesObject('entity', this.entityForm.properties);
    } else if (target === 'inline') {
      this.editEntity.properties = this.buildPropertiesObject('entity', this.editEntity.properties);
    } else {
      this.drawerEditEntity.properties = this.buildPropertiesObject('entity', this.drawerEditEntity.properties);
    }
  }

  openEdgeForm(): void {
    const firstLabel = Object.keys(this.spaceMeta()?.typeSchemas?.edge ?? {})[0] ?? '';
    this.edgeForm = { from: '', fromDisplay: '', to: '', toDisplay: '', label: firstLabel, weight: null, tags: [], description: '', properties: this.buildPropertiesObject('edge') };
    this.showEdgeForm.set(true);
  }

  openMemoryForm(): void {
    this.memoryForm = { fact: '', tags: [], entityIds: '', description: '', properties: this.buildPropertiesObject('memory') };
    this.showMemoryForm.set(true);
  }

  openChronoForm(): void {
    this.chronoForm = { title: '', kind: 'event', customKind: '', startsAt: '', endsAt: '', description: '', tags: [], entityIds: '' };
    this.showChronoForm.set(true);
  }

  private buildPropertiesObject(type: KnowledgeType, existing: Record<string, string | number | boolean> = {}): Record<string, string | number | boolean> {
    const meta = this.spaceMeta();
    const typeSchemas = meta?.typeSchemas?.[type];
    if (!typeSchemas || Object.keys(typeSchemas).length === 0) return existing;
    // Use the first type's property schemas as fallback defaults
    const firstTypeSchemas = Object.values(typeSchemas)[0]?.propertySchemas ?? {};
    if (Object.keys(firstTypeSchemas).length === 0) return existing;
    const result = { ...existing };
    for (const [key, schema] of Object.entries(firstTypeSchemas)) {
      if (key in result) continue;
      if (schema.enum?.length) {
        result[key] = schema.enum[0] as string | number | boolean;
      } else if (schema.type === 'number') {
        result[key] = 0;
      } else if (schema.type === 'boolean') {
        result[key] = false;
      } else {
        result[key] = '';
      }
    }
    return result;
  }

  // ── Detail drawer ──────────────────────────────────────────────────────

  drawerRecord = signal<{ kind: 'memory' | 'entity' | 'edge' | 'chrono'; record: any } | null>(null);
  drawerSaving = signal(false);
  drawerError = signal('');

  drawerEditMemory = { fact: '', tags: [] as string[], entityIds: '', description: '', properties: {} as Record<string, string | number | boolean> };
  drawerEditEntity = { name: '', type: '', tags: [] as string[], description: '', properties: {} as Record<string, string | number | boolean> };
  drawerEditEdge = { label: '', type: '', weight: null as number | null, tags: [] as string[], description: '', properties: {} as Record<string, string | number | boolean> };
  drawerEditChrono = { title: '', kind: 'event' as string, customKind: '', status: 'upcoming' as string, startsAt: '', endsAt: '', description: '', tags: [] as string[], entityIds: '', confidence: null as number | null, memoryIds: '' };

  openDrawer(kind: 'memory' | 'entity' | 'edge' | 'chrono', record: any): void {
    this.drawerRecord.set({ kind, record });
    this.drawerError.set('');
    this.drawerSaving.set(false);
    const ids: string[] = record.entityIds ?? [];
    if (ids.length) this.resolveEntityNames(ids);
    if (kind === 'memory') {
      this.drawerEditMemory = {
        fact: record.fact,
        tags: [...(record.tags ?? [])],
        entityIds: (record.entityIds ?? []).join(', '),
        description: record.description ?? '',
        properties: this.buildPropertiesObject('memory', record.properties ?? {}),
      };
    } else if (kind === 'entity') {
      this.drawerEditEntity = {
        name: record.name,
        type: record.type ?? '',
        tags: [...(record.tags ?? [])],
        description: record.description ?? '',
        properties: this.buildPropertiesObject('entity', record.properties ?? {}),
      };
    } else if (kind === 'edge') {
      this.drawerEditEdge = {
        label: record.label,
        type: record.type ?? '',
        weight: record.weight ?? null,
        tags: [...(record.tags ?? [])],
        description: record.description ?? '',
        properties: this.buildPropertiesObject('edge', record.properties ?? {}),
      };
    } else if (kind === 'chrono') {
      const isPredefined = this.chronoKinds.includes(record.type as ChronoType);
      this.drawerEditChrono = {
        title: record.title,
        kind: isPredefined ? record.type : '__custom__',
        customKind: isPredefined ? '' : record.type,
        status: record.status,
        startsAt: record.startsAt ? this.toLocalDatetime(record.startsAt) : '',
        endsAt: record.endsAt ? this.toLocalDatetime(record.endsAt) : '',
        description: record.description ?? '',
        tags: [...(record.tags ?? [])],
        entityIds: (record.entityIds ?? []).join(', '),
        confidence: record.confidence ?? null,
        memoryIds: (record.memoryIds ?? []).join(', '),
      };
    }
  }

  closeDrawer(): void {
    this.drawerRecord.set(null);
    this.drawerError.set('');
    this.closeFlyout();
  }

  saveDrawer(): void {
    const dr = this.drawerRecord();
    if (!dr) return;
    this.drawerSaving.set(true);
    this.drawerError.set('');
    const id = dr.record._id;
    const spaceId = this.activeSpaceId();
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
          this.memories.update(list => list.map(m => m._id === id ? updated : m));
        },
        error: (err) => { this.drawerSaving.set(false); this.drawerError.set(this.fmtApiError(err, 'Failed to save')); },
      });
    } else if (dr.kind === 'entity') {
      const props = this.drawerEditEntity.properties;
      this.api.updateEntity(spaceId, id, {
        name: this.drawerEditEntity.name.trim(),
        type: this.drawerEditEntity.type.trim(),
        tags: this.drawerEditEntity.tags,
        description: this.drawerEditEntity.description.trim(),
        ...(Object.keys(props).length ? { properties: props } : {}),
      }).subscribe({
        next: (updated) => {
          this.drawerSaving.set(false);
          this.drawerRecord.set({ kind: 'entity', record: updated });
          this.entities.update(list => list.map(e => e._id === id ? updated : e));
        },
        error: (err) => { this.drawerSaving.set(false); this.drawerError.set(this.fmtApiError(err, 'Failed to save')); },
      });
    } else if (dr.kind === 'edge') {
      const props = this.drawerEditEdge.properties;
      this.api.updateEdge(spaceId, id, {
        label: this.drawerEditEdge.label.trim(),
        ...(this.drawerEditEdge.type.trim() ? { type: this.drawerEditEdge.type.trim() } : {}),
        ...(this.drawerEditEdge.weight != null ? { weight: this.drawerEditEdge.weight } : {}),
        tags: this.drawerEditEdge.tags,
        description: this.drawerEditEdge.description.trim(),
        ...(Object.keys(props).length ? { properties: props } : {}),
      }).subscribe({
        next: (updated) => {
          this.drawerSaving.set(false);
          this.drawerRecord.set({ kind: 'edge', record: updated });
          this.edges.update(list => list.map(e => e._id === id ? updated : e));
        },
        error: (err) => { this.drawerSaving.set(false); this.drawerError.set(this.fmtApiError(err, 'Failed to save')); },
      });
    } else if (dr.kind === 'chrono') {
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
        ...(this.drawerEditChrono.confidence != null ? { confidence: this.drawerEditChrono.confidence } : {}),
      }).subscribe({
        next: (updated) => {
          this.drawerSaving.set(false);
          this.drawerRecord.set({ kind: 'chrono', record: updated });
          this.chrono.update(list => list.map(c => c._id === id ? updated : c));
        },
        error: (err) => { this.drawerSaving.set(false); this.drawerError.set(this.fmtApiError(err, 'Failed to save')); },
      });
    }
  }

  private resolveEntityNames(ids: string[]): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
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

  // ── Entity picker & flyouts ─────────────────────────────────────────────

  flyoutField = signal('');
  entityNameCache = signal<Record<string, string>>({});

  openFlyout(key: string): void {
    this.flyoutField.set(key);
    if (key.endsWith('entityIds')) this.resolveEntityNamesForFlyout(key);
  }

  closeFlyout(): void {
    this.flyoutField.set('');
  }

  removeEntityId(target: { entityIds: string }, id: string): void {
    const parts = target.entityIds.split(',').map(s => s.trim()).filter(s => s && s !== id);
    target.entityIds = parts.join(', ');
  }

  entityChips(ids: string): Array<{ id: string; name: string }> {
    const cache = this.entityNameCache();
    return ids.split(',').map(s => s.trim()).filter(Boolean)
      .map(id => ({ id, name: cache[id] ?? id }));
  }

  private resolveEntityNamesForFlyout(key: string): void {
    let ids = '';
    switch (key) {
      case 'create-memory-entityIds': ids = this.memoryForm.entityIds; break;
      case 'edit-memory-entityIds': ids = this.editMemory.entityIds; break;
      case 'drawer-memory-entityIds': ids = this.drawerEditMemory.entityIds; break;
      case 'create-chrono-entityIds': ids = this.chronoForm.entityIds; break;
      case 'edit-chrono-entityIds': ids = this.editChrono.entityIds; break;
      case 'drawer-chrono-entityIds': ids = this.drawerEditChrono.entityIds; break;
      case 'edit-filemeta-entityIds': ids = this.editFileMeta.entityIds; break;
      case 'drawer-filemeta-entityIds': ids = this.drawerEditFileMeta.entityIds; break;
    }
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    const unknown = ids.split(',').map(s => s.trim())
      .filter(s => s && !this.entityNameCache()[s]);
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

  pickEntity(ent: Entity, mode: 'single' | 'multi', field: string): void {
    switch (field) {
      case 'create-edge-from':         this.edgeForm.from = ent._id; this.edgeForm.fromDisplay = ent.name; break;
      case 'create-edge-to':           this.edgeForm.to = ent._id; this.edgeForm.toDisplay = ent.name; break;
      case 'create-memory-entityIds':
        this.entityNameCache.update(c => ({ ...c, [ent._id]: ent.name }));
        this.memoryForm.entityIds = this.appendEntityId(this.memoryForm.entityIds, ent._id); break;
      case 'create-chrono-entityIds':
        this.entityNameCache.update(c => ({ ...c, [ent._id]: ent.name }));
        this.chronoForm.entityIds = this.appendEntityId(this.chronoForm.entityIds, ent._id); break;
      case 'edit-memory-entityIds':
        this.entityNameCache.update(c => ({ ...c, [ent._id]: ent.name }));
        this.editMemory.entityIds = this.appendEntityId(this.editMemory.entityIds, ent._id); break;
      case 'drawer-memory-entityIds':
        this.entityNameCache.update(c => ({ ...c, [ent._id]: ent.name }));
        this.drawerEditMemory.entityIds = this.appendEntityId(this.drawerEditMemory.entityIds, ent._id); break;
      case 'edit-chrono-entityIds':
        this.entityNameCache.update(c => ({ ...c, [ent._id]: ent.name }));
        this.editChrono.entityIds = this.appendEntityId(this.editChrono.entityIds, ent._id); break;
      case 'drawer-chrono-entityIds':
        this.entityNameCache.update(c => ({ ...c, [ent._id]: ent.name }));
        this.drawerEditChrono.entityIds = this.appendEntityId(this.drawerEditChrono.entityIds, ent._id); break;
      case 'edit-filemeta-entityIds':
        this.entityNameCache.update(c => ({ ...c, [ent._id]: ent.name }));
        this.editFileMeta.entityIds = this.appendEntityId(this.editFileMeta.entityIds, ent._id); break;
      case 'drawer-filemeta-entityIds':
        this.entityNameCache.update(c => ({ ...c, [ent._id]: ent.name }));
        this.drawerEditFileMeta.entityIds = this.appendEntityId(this.drawerEditFileMeta.entityIds, ent._id); break;
    }
  }

  private appendEntityId(current: string, id: string): string {
    const parts = current.split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.includes(id)) parts.push(id);
    return parts.join(', ');
  }
}
