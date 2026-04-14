import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, Space, SpaceStats, Memory, Entity, Edge, ChronoEntry, ChronoKind, ChronoStatus, QueryCollection, QueryResult, RecallResult, RecallResponse, RecallKnowledgeType, SpaceMeta, SpaceMetaResponse, ValidationMode, KnowledgeType } from '../../core/api.service';

type BrainTab = 'query' | 'settings' | 'entities' | 'edges' | 'memories' | 'chrono';

interface SpaceView {
  space: Space;
  stats?: SpaceStats;
}

@Component({
  selector: 'app-brain',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
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
      border: 1px solid var(--border-muted);
      border-radius: var(--radius-md);
      margin-bottom: 8px;
      background: var(--bg-surface);
      transition: border-color var(--transition);
    }

    .memory-item:hover { border-color: var(--border); }

    .memory-content {
      font-size: 13px;
      color: var(--text-primary);
      line-height: 1.6;
      margin-bottom: 8px;
    }

    .memory-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .memory-meta time { font-size: 11px; color: var(--text-muted); }

    .filter-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
      padding: 8px 12px;
      border: 1px solid var(--border);
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

    .wipe-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      padding: 10px 14px;
      border: 1px solid var(--error);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--error) 6%, transparent);
    }
    .wipe-bar input {
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 13px;
      background: var(--bg-surface);
      color: var(--text-primary);
    }

    .create-form {
      display: flex;
      gap: 10px;
      align-items: flex-end;
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

    .search-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .search-bar input {
      padding: 5px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 13px;
      background: var(--bg-surface);
      color: var(--text-primary);
      min-width: 200px;
    }
    .search-bar select {
      padding: 5px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 13px;
      background: var(--bg-surface);
      color: var(--text-primary);
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
  `],
  template: `
    @if (loadingSpaces()) {
      <div class="loading-overlay"><span class="spinner"></span> Loading spaces…</div>
    } @else if (spaces().length === 0) {
      <div class="empty-state">
        <div class="empty-state-icon">📦</div>
        <h3>No spaces yet</h3>
        <p>Create a space in <a routerLink="/settings/spaces">Settings → Spaces</a>.</p>
      </div>
    } @else {

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
              <span class="space-chip-count">{{ spaceTotal(sv.stats) }} records</span>
            }
          </button>
        }
      </div>

      @if (needsReindex()) {
        <div class="reindex-banner">
          <span>⚠️ Embeddings are stale — the embedding model has changed and this space needs reindexing.</span>
          <button class="btn btn-sm btn-primary" [disabled]="reindexing()" (click)="runReindex()">
            @if (reindexing()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
            Reindex now
          </button>
          @if (reindexResult()) { <span class="reindex-result">{{ reindexResult() }}</span> }
        </div>
      }
      @if (!needsReindex() && reindexResult()) {
        <div class="alert alert-success" style="margin-bottom:10px; font-size:13px;">✓ {{ reindexResult() }}</div>
      }

      <!-- Sub-tabs with counts -->
      <div class="tabs">
        @for (tab of tabs; track tab.key) {
          <button class="tab" [class.active]="activeTab() === tab.key" (click)="setTab(tab.key)">
            {{ tab.label }}
            @if (activeStats(); as s) {
              @if (tab.statsKey) {
                <span class="tab-count">{{ s[tab.statsKey] }}</span>
              }
            }
          </button>
        }
        @if (activeStats(); as s) {
          <a class="tab-files-info" routerLink="/files" [queryParams]="{space: activeSpaceId()}" title="Open file manager for this space">
            Files <span class="tab-count">{{ s.files }}</span>
          </a>
        }
      </div>

      <!-- Content -->
      @if (loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else {

        <!-- Memories -->
        @if (activeTab() === 'memories') {

          <!-- Add memory form -->
          @if (showMemoryForm()) {
            <form class="create-form" (ngSubmit)="createMemory()">
              <div class="field" style="flex:2; min-width:200px;">
                <label>Fact</label>
                <textarea [(ngModel)]="memoryForm.fact" name="fact" rows="2" placeholder="Something to remember…" required style="width:100%;"></textarea>
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>Tags (comma-separated)</label>
                <input type="text" [(ngModel)]="memoryForm.tags" name="tags" placeholder="tag1, tag2" />
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>Entity IDs (comma-separated)</label>
                <input type="text" [(ngModel)]="memoryForm.entityIds" name="entityIds" placeholder="entity-id-1" />
              </div>
              <div class="field" style="flex:2; min-width:200px;">
                <label>Description (optional)</label>
                <input type="text" [(ngModel)]="memoryForm.description" name="description" placeholder="Context or rationale…" />
              </div>
              <div class="field" style="flex:1; min-width:160px;">
                <label>Properties (JSON, optional)</label>
                <input type="text" [(ngModel)]="memoryForm.properties" name="properties" placeholder='{"key": "value"}' />
              </div>
              <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingMemory() || !memoryForm.fact.trim()">
                @if (creatingMemory()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                Save
              </button>
              <button class="btn-secondary btn btn-sm" type="button" (click)="showMemoryForm.set(false)">Cancel</button>
            </form>
          }

          @if (createMemoryError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createMemoryError() }}</div>
          }

          @if (filterTag() || filterEntity()) {
            <div class="filter-bar">
              <span class="filter-bar-label">Filters</span>
              @if (filterTag(); as tag) {
                <span class="filter-chip">tag: {{ tag }} <button aria-label="Clear tag filter" (click)="clearFilter('tag')">✕</button></span>
              }
              @if (filterEntity(); as ent) {
                <span class="filter-chip">entity: {{ ent }} <button aria-label="Clear entity filter" (click)="clearFilter('entity')">✕</button></span>
              }
              <button class="btn-secondary btn btn-sm" (click)="clearFilter('all')">Clear all</button>
            </div>
          }

          @if (showWipeConfirm()) {
            <div class="wipe-bar">
              <span style="font-size:13px; color:var(--error); font-weight:500;">
                Type <strong>{{ activeSpaceId() }}</strong> to confirm wipe of all {{ activeStats()?.memories ?? '?' }} memories:
              </span>
              <input
                [value]="wipeInput()"
                (input)="wipeInput.set($any($event.target).value)"
                placeholder="space id"
                aria-label="Type space ID to confirm wipe"
              />
              <button
                class="btn btn-danger btn-sm"
                [disabled]="wipeInput() !== activeSpaceId() || wipingInProgress()"
                (click)="executeWipe()"
              >
                {{ wipingInProgress() ? 'Wiping…' : 'Confirm wipe' }}
              </button>
              <button class="btn-secondary btn btn-sm" (click)="showWipeConfirm.set(false); wipeInput.set('')">Cancel</button>
            </div>
          }

          <div class="content-header">
            <span style="font-size:13px; color:var(--text-secondary);">
              Showing {{ memories().length }} memories (skip {{ skip() }})
            </span>
            <span style="flex:1"></span>
            <button class="btn-secondary btn btn-sm" [disabled]="skip() === 0" (click)="prevPage()">← Prev</button>
            <button class="btn-secondary btn btn-sm" [disabled]="memories().length < pageSize" (click)="nextPage()">Next →</button>
            <button
              class="btn-primary btn btn-sm"
              (click)="showMemoryForm.set(true)"
              [disabled]="showMemoryForm()"
            >+ Add memory</button>
            <button
              class="btn btn-danger btn-sm"
              [disabled]="!activeStats()?.memories"
              (click)="showWipeConfirm.set(true)"
              title="Wipe all memories in this space"
            >Wipe all</button>
          </div>

          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Fact</th><th>Description</th><th>Tags</th><th>Properties</th><th>Created</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (mem of memories(); track mem._id) {
                  @if (editingId() === mem._id) {
                    <tr>
                      <td colspan="6">
                        <div class="create-form" style="border:none; padding:8px 0;">
                          <div class="field" style="flex:2; min-width:200px; margin-bottom:0;">
                            <label>Fact</label>
                            <textarea [(ngModel)]="editMemory.fact" name="editFact" rows="2" style="width:100%;"></textarea>
                          </div>
                          <div class="field" style="flex:1; min-width:160px; margin-bottom:0;">
                            <label>Description</label>
                            <input type="text" [(ngModel)]="editMemory.description" name="editDesc" />
                          </div>
                          <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                            <label>Tags (comma-separated)</label>
                            <input type="text" [(ngModel)]="editMemory.tags" name="editTags" />
                          </div>
                          <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                            <label>Properties (JSON)</label>
                            <input type="text" [(ngModel)]="editMemory.properties" name="editProps" />
                          </div>
                          <div style="display:flex; gap:6px; align-items:flex-end;">
                            <button class="btn btn-sm btn-primary" [disabled]="editSaving()" (click)="saveEditMemory(mem._id)">
                              @if (editSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } Save
                            </button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelEdit()">Cancel</button>
                          </div>
                          @if (editError()) { <div style="font-size:12px; color:var(--error);">{{ editError() }}</div> }
                        </div>
                      </td>
                    </tr>
                  } @else {
                    <tr>
                      <td style="max-width:300px; white-space:normal; word-break:break-word;">{{ mem.fact }}</td>
                      <td style="font-size:12px; color:var(--text-muted); max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" [title]="mem.description ?? ''">
                        {{ mem.description || '—' }}
                      </td>
                      <td style="font-size:11px;">
                        @for (tag of (mem.tags ?? []); track tag) { <span class="tag tag-clickable" (click)="applyFilter('tag', tag)">{{ tag }}</span> }
                        @if (!(mem.tags?.length)) { <span style="color:var(--text-muted)">—</span> }
                      </td>
                      <td style="font-size:12px; color:var(--text-muted); max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" [title]="formatProps(mem.properties)">
                        {{ formatProps(mem.properties) }}
                      </td>
                      <td style="color:var(--text-muted)">{{ mem.createdAt | date:'MMM d, y' }}</td>
                      <td style="white-space:nowrap;">
                        <button class="icon-btn" title="Edit memory" aria-label="Edit memory" (click)="startEditMemory(mem)">✎</button>
                        @if (confirmDeleteId() === mem._id) {
                          <span class="inline-confirm">
                            Delete?
                            <button class="btn btn-sm btn-danger" (click)="deleteMemory(mem._id)">Yes</button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelDelete()">No</button>
                          </span>
                        } @else {
                          <button class="icon-btn danger" title="Delete memory" aria-label="Delete memory" (click)="requestDelete(mem._id)">✕</button>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="6">
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon">🧠</div>
                      <h3>No memories</h3>
                      <p>Memories will appear here once written by an MCP client.</p>
                    </div>
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          <div class="pagination">
            <button class="btn btn-sm btn-secondary" [disabled]="skip() === 0" (click)="prevPage()">← Prev</button>
            <span class="pager-info">{{ skip() + 1 }}–{{ skip() + memories().length }}</span>
            <button class="btn btn-sm btn-secondary" [disabled]="memories().length < pageSize" (click)="nextPage()">Next →</button>
          </div>
        }

        <!-- Entities -->
        @if (activeTab() === 'entities') {

          <div style="margin-bottom:12px; display:flex; gap:8px;">
            <button class="btn-primary btn btn-sm" (click)="showEntityForm.set(true)" [disabled]="showEntityForm()">+ Add entity</button>
          </div>

          @if (showEntityForm()) {
            <form class="create-form" (ngSubmit)="createEntity()">
              <div class="field" style="flex:1; min-width:140px;">
                <label>Name</label>
                <input type="text" [(ngModel)]="entityForm.name" name="name" placeholder="Kubernetes" required />
              </div>
              <div class="field" style="width:140px;">
                <label>Type (optional)</label>
                <input type="text" [(ngModel)]="entityForm.type" name="type" placeholder="technology" />
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>Tags (comma-separated)</label>
                <input type="text" [(ngModel)]="entityForm.tags" name="tags" placeholder="infra, devops" />
              </div>
              <div class="field" style="flex:1; min-width:200px;">
                <label>Description (optional)</label>
                <input type="text" [(ngModel)]="entityForm.description" name="description" placeholder="Brief description…" />
              </div>
              <div class="field" style="flex:1; min-width:180px;">
                <label>Properties (JSON)</label>
                <input type="text" [(ngModel)]="entityForm.properties" name="properties" placeholder='{"wheels": 4, "color": "red"}' />
              </div>
              <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingEntity() || !entityForm.name.trim()">
                @if (creatingEntity()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                Save
              </button>
              <button class="btn-secondary btn btn-sm" type="button" (click)="showEntityForm.set(false)">Cancel</button>
            </form>
          }

          @if (createEntityError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createEntityError() }}</div>
          }

          <div class="search-bar">
            <input type="search" placeholder="Search by name…" [(ngModel)]="entitySearch" (input)="searchEntities()" aria-label="Search entities" />
            @if (entitySearch()) {
              <button class="btn btn-sm btn-secondary" (click)="entitySearch.set(''); searchEntities()">Clear</button>
            }
          </div>

          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Type</th><th>Description</th><th>Tags</th><th>Properties</th><th>Created</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (ent of entities(); track ent._id) {
                  @if (editingId() === ent._id) {
                    <tr>
                      <td colspan="7">
                        <div class="create-form" style="border:none; padding:8px 0;">
                          <div class="field" style="flex:1; min-width:120px; margin-bottom:0;">
                            <label>Name</label>
                            <input type="text" [(ngModel)]="editEntity.name" name="editEntName" />
                          </div>
                          <div class="field" style="width:120px; margin-bottom:0;">
                            <label>Type</label>
                            <input type="text" [(ngModel)]="editEntity.type" name="editEntType" />
                          </div>
                          <div class="field" style="flex:1; min-width:160px; margin-bottom:0;">
                            <label>Description</label>
                            <input type="text" [(ngModel)]="editEntity.description" name="editEntDesc" />
                          </div>
                          <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                            <label>Tags (comma-separated)</label>
                            <input type="text" [(ngModel)]="editEntity.tags" name="editEntTags" />
                          </div>
                          <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                            <label>Properties (JSON)</label>
                            <input type="text" [(ngModel)]="editEntity.properties" name="editEntProps" />
                          </div>
                          <div style="display:flex; gap:6px; align-items:flex-end;">
                            <button class="btn btn-sm btn-primary" [disabled]="editSaving()" (click)="saveEditEntity(ent._id)">
                              @if (editSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } Save
                            </button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelEdit()">Cancel</button>
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
                      <td style="font-size:12px; color:var(--text-muted); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" [title]="formatProps(ent.properties)">
                        {{ formatProps(ent.properties) }}
                      </td>
                      <td style="color:var(--text-muted)">{{ ent.createdAt | date:'MMM d, y' }}</td>
                      <td style="white-space:nowrap;">
                        <button class="icon-btn" title="Edit entity" aria-label="Edit entity" (click)="startEditEntity(ent)">✎</button>
                        @if (confirmDeleteId() === ent._id) {
                          <span class="inline-confirm">
                            Delete?
                            <button class="btn btn-sm btn-danger" (click)="deleteEntity(ent._id)">Yes</button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelDelete()">No</button>
                          </span>
                        } @else {
                          <button class="icon-btn danger" aria-label="Delete entity" (click)="requestDelete(ent._id)">✕</button>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="7">
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon">🏷️</div>
                      <h3>No entities</h3>
                    </div>
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          <div class="pagination">
            <button class="btn btn-sm btn-secondary" [disabled]="entitySkip() === 0" (click)="prevEntityPage()">← Prev</button>
            <span class="pager-info">{{ entitySkip() + 1 }}–{{ entitySkip() + entities().length }}</span>
            <button class="btn btn-sm btn-secondary" [disabled]="entities().length < pageSize" (click)="nextEntityPage()">Next →</button>
          </div>
        }

        <!-- Edges -->
        @if (activeTab() === 'edges') {

          <div style="margin-bottom:12px; display:flex; gap:8px;">
            <button class="btn-primary btn btn-sm" (click)="showEdgeForm.set(true)" [disabled]="showEdgeForm()">+ Add edge</button>
          </div>

          @if (showEdgeForm()) {
            <form class="create-form" (ngSubmit)="createEdge()">
              <div class="field" style="flex:1; min-width:120px;">
                <label>From</label>
                <input type="text" [(ngModel)]="edgeForm.from" name="from" placeholder="Entity A" required />
              </div>
              <div class="field" style="flex:1; min-width:120px;">
                <label>Label (relation)</label>
                <input type="text" [(ngModel)]="edgeForm.label" name="label" placeholder="depends_on" required />
              </div>
              <div class="field" style="flex:1; min-width:120px;">
                <label>To</label>
                <input type="text" [(ngModel)]="edgeForm.to" name="to" placeholder="Entity B" required />
              </div>
              <div class="field" style="width:100px;">
                <label>Type (optional)</label>
                <input type="text" [(ngModel)]="edgeForm.type" name="type" placeholder="causal" />
              </div>
              <div class="field" style="width:80px;">
                <label>Weight</label>
                <input type="number" [(ngModel)]="edgeForm.weight" name="weight" step="0.1" placeholder="—" />
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>Tags (comma-separated)</label>
                <input type="text" [(ngModel)]="edgeForm.tags" name="tags" placeholder="tag1, tag2" />
              </div>
              <div class="field" style="flex:2; min-width:200px;">
                <label>Description (optional)</label>
                <input type="text" [(ngModel)]="edgeForm.description" name="description" placeholder="Why does this relation exist?" />
              </div>
              <div class="field" style="flex:1; min-width:160px;">
                <label>Properties (JSON, optional)</label>
                <input type="text" [(ngModel)]="edgeForm.properties" name="properties" placeholder='{"since": "2024"}' />
              </div>
              <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingEdge() || !edgeForm.from.trim() || !edgeForm.to.trim() || !edgeForm.label.trim()">
                @if (creatingEdge()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                Save
              </button>
              <button class="btn-secondary btn btn-sm" type="button" (click)="showEdgeForm.set(false)">Cancel</button>
            </form>
          }

          @if (createEdgeError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createEdgeError() }}</div>
          }
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>From</th><th>Relation</th><th>Type</th><th>To</th><th>Description</th><th>Tags</th><th>Weight</th><th>Created</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (edge of edges(); track edge._id) {
                  @if (editingId() === edge._id) {
                    <tr>
                      <td colspan="9">
                        <div class="create-form" style="border:none; padding:8px 0;">
                          <div class="field" style="flex:1; min-width:120px; margin-bottom:0;">
                            <label>Label (relation)</label>
                            <input type="text" [(ngModel)]="editEdge.label" name="editEdgeLabel" />
                          </div>
                          <div class="field" style="width:100px; margin-bottom:0;">
                            <label>Type</label>
                            <input type="text" [(ngModel)]="editEdge.type" name="editEdgeType" />
                          </div>
                          <div class="field" style="width:80px; margin-bottom:0;">
                            <label>Weight</label>
                            <input type="number" [(ngModel)]="editEdge.weight" name="editEdgeWeight" step="0.1" />
                          </div>
                          <div class="field" style="flex:1; min-width:160px; margin-bottom:0;">
                            <label>Description</label>
                            <input type="text" [(ngModel)]="editEdge.description" name="editEdgeDesc" />
                          </div>
                          <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                            <label>Tags (comma-separated)</label>
                            <input type="text" [(ngModel)]="editEdge.tags" name="editEdgeTags" />
                          </div>
                          <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                            <label>Properties (JSON)</label>
                            <input type="text" [(ngModel)]="editEdge.properties" name="editEdgeProps" />
                          </div>
                          <div style="display:flex; gap:6px; align-items:flex-end;">
                            <button class="btn btn-sm btn-primary" [disabled]="editSaving()" (click)="saveEditEdge(edge._id)">
                              @if (editSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } Save
                            </button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelEdit()">Cancel</button>
                          </div>
                          @if (editError()) { <div style="font-size:12px; color:var(--error);">{{ editError() }}</div> }
                        </div>
                      </td>
                    </tr>
                  } @else {
                    <tr>
                      <td class="mono" style="font-size:12px">{{ edge.from }}</td>
                      <td><span class="badge badge-blue">{{ edge.label }}</span></td>
                      <td style="color:var(--text-muted); font-size:12px">{{ edge.type ?? '—' }}</td>
                      <td class="mono" style="font-size:12px">{{ edge.to }}</td>
                      <td style="font-size:12px; color:var(--text-muted); max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" [title]="edge.description ?? ''">
                        {{ edge.description || '—' }}
                      </td>
                      <td style="font-size:11px;">
                        @for (tag of (edge.tags ?? []); track tag) { <span class="tag">{{ tag }}</span> }
                        @if (!(edge.tags?.length)) { <span style="color:var(--text-muted)">—</span> }
                      </td>
                      <td style="color:var(--text-muted)">{{ edge.weight ?? '—' }}</td>
                      <td style="color:var(--text-muted)">{{ edge.createdAt | date:'MMM d, y' }}</td>
                      <td style="white-space:nowrap;">
                        <button class="icon-btn" title="Edit edge" aria-label="Edit edge" (click)="startEditEdge(edge)">✎</button>
                        @if (confirmDeleteId() === edge._id) {
                          <span class="inline-confirm">
                            Delete?
                            <button class="btn btn-sm btn-danger" (click)="deleteEdge(edge._id)">Yes</button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelDelete()">No</button>
                          </span>
                        } @else {
                          <button class="icon-btn danger" aria-label="Delete edge" (click)="requestDelete(edge._id)">✕</button>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="9">
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon">🕸️</div>
                      <h3>No edges</h3>
                    </div>
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          <div class="pagination">
            <button class="btn btn-sm btn-secondary" [disabled]="edgeSkip() === 0" (click)="prevEdgePage()">← Prev</button>
            <span class="pager-info">{{ edgeSkip() + 1 }}–{{ edgeSkip() + edges().length }}</span>
            <button class="btn btn-sm btn-secondary" [disabled]="edges().length < pageSize" (click)="nextEdgePage()">Next →</button>
          </div>
        }

        <!-- Chrono -->
        @if (activeTab() === 'chrono') {

          <div style="margin-bottom:12px; display:flex; gap:8px;">
            <button class="btn-primary btn btn-sm" (click)="showChronoForm.set(true)" [disabled]="showChronoForm()">+ Add entry</button>
          </div>

          @if (showChronoForm()) {
            <form class="create-form" (ngSubmit)="createChrono()">
              <div class="field" style="flex:2; min-width:200px;">
                <label>Title</label>
                <input type="text" [(ngModel)]="chronoForm.title" name="title" placeholder="Release v1.0" required />
              </div>
              <div class="field" style="width:160px;">
                <label>Kind</label>
                @if (chronoForm.kind !== '__custom__') {
                  <select [(ngModel)]="chronoForm.kind" name="kind">
                    @for (k of chronoKinds; track k) { <option [value]="k">{{ k }}</option> }
                    <option value="__custom__">Custom…</option>
                  </select>
                } @else {
                  <div style="display:flex; gap:4px;">
                    <input type="text" [(ngModel)]="chronoForm.customKind" name="customKind" placeholder="my-kind" style="flex:1;" />
                    <button type="button" class="btn-secondary btn btn-sm" style="padding:4px 8px;" (click)="chronoForm.kind = 'event'; chronoForm.customKind = ''" title="Back to presets">✕</button>
                  </div>
                }
              </div>
              <div class="field" style="width:200px;">
                <label>Starts at</label>
                <input type="datetime-local" [(ngModel)]="chronoForm.startsAt" name="startsAt" required />
              </div>
              <div class="field" style="width:200px;">
                <label>Ends at (optional)</label>
                <input type="datetime-local" [(ngModel)]="chronoForm.endsAt" name="endsAt" />
              </div>
              <div class="field" style="flex:1; min-width:200px;">
                <label>Description (optional)</label>
                <textarea [(ngModel)]="chronoForm.description" name="description" placeholder="Add context or details…" rows="3" style="resize:vertical;"></textarea>
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>Tags (comma-separated)</label>
                <input type="text" [(ngModel)]="chronoForm.tags" name="tags" placeholder="release, infra" />
              </div>
              <div class="field" style="flex:1; min-width:140px;">
                <label>Entity IDs (comma-separated, optional)</label>
                <input type="text" [(ngModel)]="chronoForm.entityIds" name="entityIds" placeholder="entity-id-1, entity-id-2" />
              </div>
              <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingChrono() || !chronoForm.title.trim() || !chronoForm.startsAt || (chronoForm.kind === '__custom__' && !chronoForm.customKind.trim())">
                @if (creatingChrono()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                Save
              </button>
              <button class="btn-secondary btn btn-sm" type="button" (click)="showChronoForm.set(false)">Cancel</button>
            </form>
          }

          @if (createChronoError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createChronoError() }}</div>
          }

          <div class="search-bar">
            <label style="font-size:12px; color:var(--text-muted);">Filter:</label>
            <input type="search" placeholder="Tags…" [(ngModel)]="chronoFilterTag" (input)="applyChronoFilter()" style="min-width:140px;" aria-label="Filter by tag" />
            <select [(ngModel)]="chronoFilterStatus" (change)="applyChronoFilter()" aria-label="Filter by status">
              <option value="">All statuses</option>
              @for (s of chronoStatusOptions; track s) { <option [value]="s">{{ s }}</option> }
            </select>
            @if (chronoFilterTag() || chronoFilterStatus()) {
              <button class="btn btn-sm btn-secondary" (click)="chronoFilterTag.set(''); chronoFilterStatus.set(''); applyChronoFilter()">Clear</button>
            }
          </div>

          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Title</th><th>Description</th><th>Kind</th><th>Status</th><th>Starts</th><th>Ends</th><th>Tags</th><th>Entities</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (entry of chrono(); track entry._id) {
                  @if (editingId() === entry._id) {
                    <tr>
                      <td colspan="9">
                        <div class="create-form" style="border:none; padding:8px 0;">
                          <div class="field" style="flex:2; min-width:180px; margin-bottom:0;">
                            <label>Title</label>
                            <input type="text" [(ngModel)]="editChrono.title" name="editChronoTitle" />
                          </div>
                          <div class="field" style="width:130px; margin-bottom:0;">
                            <label>Kind</label>
                            <select [(ngModel)]="editChrono.kind" name="editChronoKind">
                              @for (k of chronoKinds; track k) { <option [value]="k">{{ k }}</option> }
                            </select>
                          </div>
                          <div class="field" style="width:130px; margin-bottom:0;">
                            <label>Status</label>
                            <select [(ngModel)]="editChrono.status" name="editChronoStatus">
                              @for (s of chronoStatusOptions; track s) { <option [value]="s">{{ s }}</option> }
                            </select>
                          </div>
                          <div class="field" style="width:190px; margin-bottom:0;">
                            <label>Starts at</label>
                            <input type="datetime-local" [(ngModel)]="editChrono.startsAt" name="editChronoStarts" />
                          </div>
                          <div class="field" style="width:190px; margin-bottom:0;">
                            <label>Ends at</label>
                            <input type="datetime-local" [(ngModel)]="editChrono.endsAt" name="editChronoEnds" />
                          </div>
                          <div class="field" style="flex:1; min-width:180px; margin-bottom:0;">
                            <label>Description</label>
                            <textarea [(ngModel)]="editChrono.description" name="editChronoDesc" rows="2" style="resize:vertical;"></textarea>
                          </div>
                          <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                            <label>Tags (comma-separated)</label>
                            <input type="text" [(ngModel)]="editChrono.tags" name="editChronoTags" />
                          </div>
                          <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                            <label>Entity IDs (comma-separated)</label>
                            <input type="text" [(ngModel)]="editChrono.entityIds" name="editChronoEntIds" />
                          </div>
                          <div style="display:flex; gap:6px; align-items:flex-end;">
                            <button class="btn btn-sm btn-primary" [disabled]="editSaving()" (click)="saveEditChrono(entry._id)">
                              @if (editSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } Save
                            </button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelEdit()">Cancel</button>
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
                      <td><span class="badge badge-blue">{{ entry.kind }}</span></td>
                      <td><span class="badge" [class.badge-purple]="entry.status === 'upcoming'" [class.badge-blue]="entry.status === 'active'" style="font-size:11px">{{ entry.status }}</span></td>
                      <td style="color:var(--text-muted); font-size:12px">{{ entry.startsAt | date:'MMM d, y HH:mm' }}</td>
                      <td style="color:var(--text-muted); font-size:12px">{{ entry.endsAt ? (entry.endsAt | date:'MMM d, y HH:mm') : '—' }}</td>
                      <td>
                        @for (tag of entry.tags; track tag) { <span class="tag">{{ tag }}</span> }
                      </td>
                      <td style="font-size:11px; color:var(--text-muted);">
                        @if (entry.entityIds.length) {
                          {{ entry.entityIds.length }} linked
                        } @else { — }
                      </td>
                      <td style="white-space:nowrap;">
                        <button class="icon-btn" title="Edit chrono entry" aria-label="Edit chrono entry" (click)="startEditChrono(entry)">✎</button>
                        @if (confirmDeleteId() === entry._id) {
                          <span class="inline-confirm">
                            Delete?
                            <button class="btn btn-sm btn-danger" (click)="deleteChrono(entry._id)">Yes</button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelDelete()">No</button>
                          </span>
                        } @else {
                          <button class="icon-btn danger" aria-label="Delete chrono entry" (click)="requestDelete(entry._id)">✕</button>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="9">
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon">⏱️</div>
                      <h3>No chrono entries</h3>
                    </div>
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          <div class="pagination">
            <button class="btn btn-sm btn-secondary" [disabled]="chronoSkip() === 0" (click)="prevChronoPage()">← Prev</button>
            <span class="pager-info">{{ chronoSkip() + 1 }}–{{ chronoSkip() + chrono().length }}</span>
            <button class="btn btn-sm btn-secondary" [disabled]="chrono().length < pageSize" (click)="nextChronoPage()">Next →</button>
          </div>
        }

        <!-- Query -->
        @if (activeTab() === 'query') {
          <div class="query-panel">
            <!-- Mode switcher -->
            <div style="display:flex; gap:8px; margin-bottom:12px;">
              <button class="btn btn-sm" [class.btn-primary]="queryMode() === 'search'" [class.btn-secondary]="queryMode() !== 'search'" (click)="queryMode.set('search')">Semantic Search</button>
              <button class="btn btn-sm" [class.btn-primary]="queryMode() === 'advanced'" [class.btn-secondary]="queryMode() !== 'advanced'" (click)="queryMode.set('advanced')">Advanced Query</button>
            </div>

            <!-- Semantic Search mode -->
            @if (queryMode() === 'search') {
              <div class="query-form">
                <div class="field" style="margin-bottom:0;">
                  <label>Search your knowledge base</label>
                  <input
                    type="text"
                    [(ngModel)]="recallForm.query"
                    name="recallQuery"
                    placeholder="What do you want to find?"
                    style="width:100%; font-size:14px; padding:8px 12px;"
                    (keydown.enter)="runRecall()"
                    aria-label="Semantic search query"
                  />
                </div>
                <div class="query-form-row" style="margin-top:8px;">
                  <div class="field" style="min-width:100px; margin:0;">
                    <label>Top K <span style="color:var(--text-muted);font-size:11px;" title="Maximum number of results to return">ⓘ</span></label>
                    <input type="number" [(ngModel)]="recallForm.topK" name="recallTopK" min="1" max="100" style="width:80px;" />
                  </div>
                  <div class="field" style="min-width:120px; margin:0;">
                    <label>Min score <span style="color:var(--text-muted);font-size:11px;" title="Minimum similarity score (0–1). Higher = more relevant.">ⓘ</span></label>
                    <input type="number" [(ngModel)]="recallForm.minScore" name="recallMinScore" min="0" max="1" step="0.05" style="width:80px;" />
                  </div>
                </div>
                <div style="display:flex; align-items:center; gap:10px; margin-top:8px;">
                  <button class="btn btn-sm btn-primary" [disabled]="recallRunning() || !recallForm.query.trim()" (click)="runRecall()">
                    @if (recallRunning()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                    Search
                  </button>
                  @if (recallResults().length) {
                    <button class="btn btn-sm btn-secondary" (click)="clearRecall()">Clear results</button>
                  }
                  @if (recallError()) {
                    <span style="font-size:12px; color:var(--error);">{{ recallError() }}</span>
                  }
                </div>
              </div>

              @if (recallResults().length) {
                <div class="query-results-header" style="margin-top:12px;">
                  <strong>{{ recallResults().length }}</strong> result{{ recallResults().length === 1 ? '' : 's' }}
                </div>
                @for (r of recallResults(); track $index) {
                  <div class="query-result-card" style="margin-top:6px;">
                    <div style="display:flex; gap:8px; margin-bottom:4px; align-items:center;">
                      <span class="badge badge-purple" style="font-size:10px;">{{ r.type }}</span>
                      @if (r.score != null) {
                        <span style="font-size:11px; color:var(--text-muted);">score: {{ r.score.toFixed(3) }}</span>
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
                    <label>Collection</label>
                    <select [(ngModel)]="queryForm.collection" name="queryCollection" aria-label="Collection">
                      @for (c of queryCollections; track c) { <option [value]="c">{{ c }}</option> }
                    </select>
                  </div>
                  <div class="field" style="min-width:80px;">
                    <label>Limit</label>
                    <input type="number" [(ngModel)]="queryForm.limit" name="queryLimit" min="1" max="100" style="width:80px;" />
                  </div>
                  <div class="field" style="min-width:100px;">
                    <label>maxTimeMS</label>
                    <input type="number" [(ngModel)]="queryForm.maxTimeMS" name="queryMaxTimeMS" min="100" max="30000" style="width:100px;" />
                  </div>
                </div>
                <div class="field">
                  <label>Filter <span style="color:var(--text-muted);font-size:11px;">(JSON — supports $eq $in $regex $and $or $elemMatch etc.)</span></label>
                  <textarea
                    class="query-textarea"
                    [class.error]="queryFilterError()"
                    [(ngModel)]="queryForm.filter"
                    name="queryFilter"
                    rows="3"
                    placeholder='{"tags": {"$in": ["my-tag"]}} or {"name": {"$regex": "auth", "$options": "i"}}'
                  ></textarea>
                  @if (queryFilterError()) {
                    <div style="font-size:11px; color:var(--error); margin-top:3px;">{{ queryFilterError() }}</div>
                  }
                </div>
                <div class="field">
                  <label>Projection <span style="color:var(--text-muted);font-size:11px;">(optional JSON — e.g. {{ '{' }}"fact":1,"tags":1{{ '}' }})</span></label>
                  <textarea
                    class="query-textarea"
                    [class.error]="queryProjectionError()"
                    [(ngModel)]="queryForm.projection"
                    name="queryProjection"
                    rows="2"
                    placeholder='{"fact": 1, "tags": 1}'
                  ></textarea>
                  @if (queryProjectionError()) {
                    <div style="font-size:11px; color:var(--error); margin-top:3px;">{{ queryProjectionError() }}</div>
                  }
                </div>
                <div style="display:flex; align-items:center; gap:10px;">
                  <button class="btn btn-sm btn-primary" [disabled]="queryRunning()" (click)="runQuery()">
                    @if (queryRunning()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                    Run Query
                  </button>
                  @if (queryResult()) {
                    <button class="btn btn-sm btn-secondary" (click)="clearQuery()">Clear results</button>
                  }
                  @if (queryError()) {
                    <span style="font-size:12px; color:var(--error);">{{ queryError() }}</span>
                  }
                </div>
              </div>

              @if (queryResult(); as res) {
                <div class="query-results-header">
                  <strong>{{ res.count }}</strong> result{{ res.count === 1 ? '' : 's' }} from <code>{{ res.collection }}</code>
                </div>
                @if (res.results.length === 0) {
                  <div class="query-empty">No documents matched the filter.</div>
                } @else {
                  @for (doc of res.results; track $index) {
                    <div class="query-result-card">{{ formatQueryDoc(doc) }}</div>
                  }
                }
              }
            }
          </div>
        }

        <!-- Settings tab -->
        @if (activeTab() === 'settings') {
          <div style="padding:8px 0;">
            @if (settingsLoading()) {
              <div class="loading-overlay" style="padding:24px;"><span class="spinner"></span></div>
            } @else if (spaceMeta()) {
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                <!-- Left column: Space info -->
                <div class="card" style="margin-bottom:0;">
                  <div class="card-header">
                    <div class="card-title" style="font-size:14px;">Space configuration</div>
                  </div>
                  <div class="field" style="margin-bottom:8px;">
                    <label>Label</label>
                    <input type="text" [(ngModel)]="settingsForm.label" name="settingsLabel" maxlength="200" />
                  </div>
                  <div class="field" style="margin-bottom:8px;">
                    <label>Description</label>
                    <textarea [(ngModel)]="settingsForm.description" name="settingsDescription" maxlength="4000" rows="3" style="resize:vertical;"></textarea>
                  </div>
                  <div style="display:flex; gap:8px; margin-top:8px;">
                    <button class="btn btn-sm btn-primary" [disabled]="settingsSaving()" (click)="saveSpaceSettings()">
                      @if (settingsSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                      Save
                    </button>
                    @if (settingsSaved()) { <span style="color:var(--success); font-size:12px;">✓ Saved</span> }
                    @if (settingsError()) { <span style="color:var(--error); font-size:12px;">{{ settingsError() }}</span> }
                  </div>
                </div>

                <!-- Right column: Schema meta -->
                <div class="card" style="margin-bottom:0;">
                  <div class="card-header">
                    <div class="card-title" style="font-size:14px;">Schema definition</div>
                    @if (spaceMeta()!.version) {
                      <span class="badge badge-gray" style="font-size:11px;">v{{ spaceMeta()!.version }}</span>
                    }
                  </div>

                  <div class="field" style="margin-bottom:8px;">
                    <label>Validation mode</label>
                    <select [(ngModel)]="metaForm.validationMode" name="metaValidationMode" style="width:140px;">
                      <option value="off">Off</option>
                      <option value="warn">Warn</option>
                      <option value="strict">Strict</option>
                    </select>
                  </div>

                  <div class="field" style="margin-bottom:8px;">
                    <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                      <input type="checkbox" [(ngModel)]="metaForm.strictLinkage" name="metaStrictLinkage" />
                      Strict linkage
                      <span style="color:var(--text-muted);font-size:11px;" title="When enabled, all reference fields (edge from/to, entityIds, memoryIds) must use UUID IDs, and entity deletion is blocked while inbound backlinks exist.">ⓘ</span>
                    </label>
                  </div>

                  <div class="field" style="margin-bottom:8px;">
                    <label>Purpose</label>
                    <textarea [(ngModel)]="metaForm.purpose" name="metaPurpose" maxlength="4000" rows="2" style="resize:vertical;" placeholder="Short directive injected into MCP instructions"></textarea>
                  </div>

                  <div class="field" style="margin-bottom:8px;">
                    <label>Entity types <span style="color:var(--text-muted);font-size:11px;" title="Allowlist of valid entity type values. Leave empty for unrestricted.">ⓘ</span></label>
                    <input type="text" [(ngModel)]="metaForm.entityTypesStr" name="metaEntityTypes" placeholder="person, project, topic (comma-separated)" />
                  </div>

                  <div class="field" style="margin-bottom:8px;">
                    <label>Edge labels <span style="color:var(--text-muted);font-size:11px;" title="Allowlist of valid edge label values. Leave empty for unrestricted.">ⓘ</span></label>
                    <input type="text" [(ngModel)]="metaForm.edgeLabelsStr" name="metaEdgeLabels" placeholder="knows, depends_on, part_of (comma-separated)" />
                  </div>

                  <div class="field" style="margin-bottom:8px;">
                    <label>Tag suggestions <span style="color:var(--text-muted);font-size:11px;" title="Non-enforced tag hints for UI autocomplete.">ⓘ</span></label>
                    <input type="text" [(ngModel)]="metaForm.tagSuggestionsStr" name="metaTags" placeholder="important, review, draft (comma-separated)" />
                  </div>

                  <div class="field" style="margin-bottom:8px;">
                    <label>Usage notes</label>
                    <textarea [(ngModel)]="metaForm.usageNotes" name="metaUsageNotes" rows="2" style="resize:vertical;" placeholder="Naming conventions, examples, links (Markdown)"></textarea>
                  </div>

                  <div class="field" style="margin-bottom:8px;">
                    <label>Naming patterns <span style="color:var(--text-muted);font-size:11px;" title="JSON object mapping knowledge types to naming conventions.">ⓘ</span></label>
                    <textarea
                      [(ngModel)]="metaForm.namingPatternsJson"
                      name="metaNamingPatterns"
                      rows="3"
                      style="resize:vertical; font-family:var(--font-mono); font-size:12px;"
                      placeholder='{{ "{" }}"entity": "PascalCase", "memory": "lowercase"{{ "}" }}'
                    ></textarea>
                  </div>

                  <div class="field" style="margin-bottom:8px;">
                    <label>Required properties <span style="color:var(--text-muted);font-size:11px;" title="JSON object mapping knowledge types to required property name arrays.">ⓘ</span></label>
                    <textarea
                      [(ngModel)]="metaForm.requiredPropertiesJson"
                      name="metaRequiredProps"
                      rows="3"
                      style="resize:vertical; font-family:var(--font-mono); font-size:12px;"
                      placeholder='{{ "{" }}"entity": ["type", "description"]{{ "}" }}'
                    ></textarea>
                  </div>

                  <div class="field" style="margin-bottom:8px;">
                    <label>Property schemas <span style="color:var(--text-muted);font-size:11px;" title="JSON object mapping knowledge types to property name → schema definitions.">ⓘ</span></label>
                    <textarea
                      [(ngModel)]="metaForm.propertySchemasJson"
                      name="metaPropSchemas"
                      rows="4"
                      style="resize:vertical; font-family:var(--font-mono); font-size:12px;"
                      placeholder='{{ "{" }}"entity": {{ "{" }}"status": {{ "{" }}"type":"string","enum":["active","archived"]{{ "}" }}{{ "}" }}{{ "}" }}'
                    ></textarea>
                  </div>

                  <div style="display:flex; gap:8px; margin-top:8px;">
                    <button class="btn btn-sm btn-primary" [disabled]="metaSaving()" (click)="saveMetaSettings()">
                      @if (metaSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                      Save schema
                    </button>
                    @if (metaSaved()) { <span style="color:var(--success); font-size:12px;">✓ Saved</span> }
                    @if (metaError()) { <span style="color:var(--error); font-size:12px;">{{ metaError() }}</span> }
                  </div>
                </div>
              </div>

              <!-- Space admin actions -->
              <div class="card" style="margin-top:16px;">
                <div class="card-header">
                  <div class="card-title" style="font-size:14px;">Space administration</div>
                </div>
                <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
                  <button class="btn btn-sm btn-secondary" (click)="showCreateSpaceDialog.set(true)">+ Create new space</button>
                  <button class="btn btn-sm btn-danger" [disabled]="isActiveBuiltIn()" (click)="showDeleteSpaceConfirm.set(true)" title="Delete this space and all its data permanently">Delete space</button>
                  <button class="btn btn-sm btn-danger" (click)="showWipeSpaceConfirm.set(true)" title="Wipe all data from this space (keeps configuration)">Wipe all data</button>
                </div>
                @if (isActiveBuiltIn()) {
                  <div style="font-size:11px; color:var(--text-muted); margin-top:8px;">Built-in spaces cannot be deleted.</div>
                }
                @if (spaceAdminError()) {
                  <div class="alert alert-error" style="margin-top:8px;">{{ spaceAdminError() }}</div>
                }
              </div>

              <!-- Create space dialog -->
              @if (showCreateSpaceDialog()) {
                <div class="dialog-backdrop" (click)="showCreateSpaceDialog.set(false)">
                  <div class="dialog" (click)="$event.stopPropagation()" style="max-width:500px;">
                    <div class="dialog-header">
                      <div class="card-title">Create space</div>
                      <button class="icon-btn" aria-label="Close dialog" (click)="showCreateSpaceDialog.set(false)">✕</button>
                    </div>
                    <form (ngSubmit)="adminCreateSpace()" style="display:flex; flex-direction:column; gap:12px;">
                      <div class="field" style="margin-bottom:0;">
                        <label>Display Name</label>
                        <input type="text" [(ngModel)]="newSpaceForm.label" name="newSpaceLabel" placeholder="My Space" maxlength="200" required />
                      </div>
                      <div class="field" style="margin-bottom:0;">
                        <label>ID (optional)</label>
                        <input type="text" [(ngModel)]="newSpaceForm.id" name="newSpaceId" placeholder="my-space" pattern="[a-z0-9-]+" />
                      </div>
                      <div class="field" style="margin-bottom:0;">
                        <label>Description (optional)</label>
                        <textarea [(ngModel)]="newSpaceForm.description" name="newSpaceDesc" placeholder="Purpose of this space" maxlength="4000" rows="3" style="resize:vertical;"></textarea>
                      </div>
                      <div style="display:flex; gap:8px; justify-content:flex-end;">
                        <button class="btn btn-secondary" type="button" (click)="showCreateSpaceDialog.set(false)">Cancel</button>
                        <button class="btn btn-primary" type="submit" [disabled]="creatingNewSpace() || !newSpaceForm.label.trim()">
                          @if (creatingNewSpace()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                          Create
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              }

              <!-- Wipe space confirmation -->
              @if (showWipeSpaceConfirm()) {
                <div class="dialog-backdrop" (click)="showWipeSpaceConfirm.set(false)">
                  <div class="dialog" (click)="$event.stopPropagation()" style="max-width:450px;">
                    <div class="dialog-header">
                      <div class="card-title" style="color:var(--danger);">⚠ Wipe all data</div>
                      <button class="icon-btn" (click)="showWipeSpaceConfirm.set(false)">✕</button>
                    </div>
                    <p>This will permanently delete all data from <strong>{{ activeSpaceId() }}</strong>. The space configuration will be preserved.</p>
                    <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;">
                      <button class="btn btn-secondary" (click)="showWipeSpaceConfirm.set(false)" [disabled]="wipingSpace()">Cancel</button>
                      <button class="btn btn-danger" (click)="adminWipeSpace()" [disabled]="wipingSpace()">
                        @if (wipingSpace()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                        Wipe all data
                      </button>
                    </div>
                  </div>
                </div>
              }

              <!-- Delete space confirmation -->
              @if (showDeleteSpaceConfirm()) {
                <div class="dialog-backdrop" (click)="showDeleteSpaceConfirm.set(false)">
                  <div class="dialog" (click)="$event.stopPropagation()" style="max-width:450px;">
                    <div class="dialog-header">
                      <div class="card-title" style="color:var(--danger);">⚠ Delete space</div>
                      <button class="icon-btn" (click)="showDeleteSpaceConfirm.set(false)">✕</button>
                    </div>
                    <p>This will permanently delete the space <strong>{{ activeSpaceId() }}</strong> and <strong>all data</strong> within it. This cannot be undone.</p>
                    <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;">
                      <button class="btn btn-secondary" (click)="showDeleteSpaceConfirm.set(false)" [disabled]="deletingSpace()">Cancel</button>
                      <button class="btn btn-danger" (click)="adminDeleteSpace()" [disabled]="deletingSpace()">
                        @if (deletingSpace()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                        Delete space
                      </button>
                    </div>
                  </div>
                </div>
              }
            } @else {
              <div style="padding:24px; text-align:center; color:var(--text-muted);">
                Could not load space settings. <button class="btn btn-sm btn-secondary" (click)="loadSettings()">Retry</button>
              </div>
            }
          </div>
        }

      }
    }
  `,
})
export class BrainComponent implements OnInit {
  private api = inject(ApiService);

  tabs: { key: BrainTab; label: string; statsKey?: keyof SpaceStats }[] = [
    { key: 'query', label: '🔍 Query' },
    { key: 'settings', label: '⚙ Settings' },
    { key: 'entities', label: 'Entities', statsKey: 'entities' },
    { key: 'edges', label: 'Edges', statsKey: 'edges' },
    { key: 'memories', label: 'Memories', statsKey: 'memories' },
    { key: 'chrono', label: 'Chrono', statsKey: 'chrono' },
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

  // Memories pagination + filter
  skip = signal(0);
  filterTag = signal('');
  filterEntity = signal('');
  showWipeConfirm = signal(false);
  wipeInput = signal('');
  wipingInProgress = signal(false);

  // Entities pagination + search
  entitySkip = signal(0);
  entitySearch = signal('');

  // Edges pagination
  edgeSkip = signal(0);

  // Chrono pagination + filter
  chronoSkip = signal(0);
  chronoFilterTag = signal('');
  chronoFilterStatus = signal('');

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
  editMemory = { fact: '', tags: '', entityIds: '', description: '', properties: '' };
  editEntity = { name: '', type: '', tags: '', description: '', properties: '' };
  editEdge = { label: '', type: '', weight: null as number | null, tags: '', description: '', properties: '' };
  editChrono = { title: '', kind: '' as string, status: '' as string, startsAt: '', endsAt: '', description: '', tags: '', entityIds: '' };

  // Create memory form
  showMemoryForm = signal(false);
  creatingMemory = signal(false);
  createMemoryError = signal('');
  memoryForm = { fact: '', tags: '', entityIds: '', description: '', properties: '' };

  // Create entity form
  showEntityForm = signal(false);
  creatingEntity = signal(false);
  createEntityError = signal('');
  entityForm = { name: '', type: '', tags: '', description: '', properties: '' };

  // Create edge form
  showEdgeForm = signal(false);
  creatingEdge = signal(false);
  createEdgeError = signal('');
  edgeForm = { from: '', to: '', label: '', type: '', weight: null as number | null, tags: '', description: '', properties: '' };

  // Create chrono form
  showChronoForm = signal(false);
  creatingChrono = signal(false);
  createChronoError = signal('');
  chronoKinds: ChronoKind[] = ['event', 'deadline', 'plan', 'prediction', 'milestone'];
  chronoStatusOptions: ChronoStatus[] = ['upcoming', 'active', 'completed', 'overdue', 'cancelled'];
  chronoForm = { title: '', kind: 'event' as ChronoKind | '__custom__', customKind: '', startsAt: '', endsAt: '', description: '', tags: '', entityIds: '' };

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

  // Settings tab
  spaceMeta = signal<SpaceMetaResponse | null>(null);
  settingsLoading = signal(false);
  settingsForm = { label: '', description: '' };
  settingsSaving = signal(false);
  settingsSaved = signal(false);
  settingsError = signal('');
  metaForm = {
    validationMode: 'off' as ValidationMode,
    strictLinkage: false,
    purpose: '',
    usageNotes: '',
    entityTypesStr: '',
    edgeLabelsStr: '',
    tagSuggestionsStr: '',
    namingPatternsJson: '',
    requiredPropertiesJson: '',
    propertySchemasJson: '',
  };
  metaSaving = signal(false);
  metaSaved = signal(false);
  metaError = signal('');

  // Space admin (from Settings tab)
  showCreateSpaceDialog = signal(false);
  showWipeSpaceConfirm = signal(false);
  showDeleteSpaceConfirm = signal(false);
  newSpaceForm = { label: '', id: '', description: '' };
  creatingNewSpace = signal(false);
  wipingSpace = signal(false);
  deletingSpace = signal(false);
  spaceAdminError = signal('');

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
    this.chronoFilterTag.set('');
    this.chronoFilterStatus.set('');
    this.confirmDeleteId.set('');
    this.reindexResult.set('');
    this.loadStats(id);
    this.loadCurrentTab(id);
  }

  setTab(tab: BrainTab): void {
    this.activeTab.set(tab);
    this.skip.set(0);
    this.entitySkip.set(0);
    this.edgeSkip.set(0);
    this.chronoSkip.set(0);
    this.filterTag.set('');
    this.filterEntity.set('');
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

  searchEntities(): void { this.entitySkip.set(0); this.loadCurrentTab(this.activeSpaceId()); }
  applyChronoFilter(): void { this.chronoSkip.set(0); this.loadCurrentTab(this.activeSpaceId()); }

  private loadStats(spaceId: string): void {
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
          next: ({ memories }) => { this.memories.set(memories); this.loading.set(false); },
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
        const cf: { tags?: string; status?: string } = {};
        if (this.chronoFilterTag()) cf.tags = this.chronoFilterTag();
        if (this.chronoFilterStatus()) cf.status = this.chronoFilterStatus();
        this.api.listChrono(spaceId, this.pageSize, this.chronoSkip(), cf).subscribe({
          next: ({ chrono }) => { this.chrono.set(chrono); this.loading.set(false); },
          error: () => this.loading.set(false),
        });
        break;
      }
      case 'query':
        // Query tab manages its own loading state; just clear the global overlay
        this.loading.set(false);
        break;
      case 'settings':
        this.loading.set(false);
        this.loadSettings();
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

  executeWipe(): void {
    const spaceId = this.activeSpaceId();
    if (this.wipeInput() !== spaceId) return;
    this.wipingInProgress.set(true);
    this.api.wipeMemories(spaceId).subscribe({
      next: () => {
        this.wipingInProgress.set(false);
        this.showWipeConfirm.set(false);
        this.wipeInput.set('');
        this.memories.set([]);
        this.loadStats(spaceId);
        this.loadCurrentTab(spaceId);
      },
      error: () => this.wipingInProgress.set(false),
    });
  }

  requestDelete(id: string): void { this.confirmDeleteId.set(id); }
  cancelDelete(): void { this.confirmDeleteId.set(''); }

  // ── Inline edit methods ────────────────────────────────────────────────

  startEditMemory(mem: Memory): void {
    this.editingId.set(mem._id);
    this.editError.set('');
    this.editMemory = {
      fact: mem.fact,
      tags: (mem.tags ?? []).join(', '),
      entityIds: (mem.entityIds ?? []).join(', '),
      description: mem.description ?? '',
      properties: mem.properties && Object.keys(mem.properties).length ? JSON.stringify(mem.properties) : '',
    };
  }

  startEditEntity(ent: Entity): void {
    this.editingId.set(ent._id);
    this.editError.set('');
    this.editEntity = {
      name: ent.name,
      type: ent.type ?? '',
      tags: (ent.tags ?? []).join(', '),
      description: ent.description ?? '',
      properties: ent.properties && Object.keys(ent.properties).length ? JSON.stringify(ent.properties) : '',
    };
  }

  startEditEdge(edge: Edge): void {
    this.editingId.set(edge._id);
    this.editError.set('');
    this.editEdge = {
      label: edge.label,
      type: edge.type ?? '',
      weight: edge.weight ?? null,
      tags: (edge.tags ?? []).join(', '),
      description: edge.description ?? '',
      properties: edge.properties && Object.keys(edge.properties).length ? JSON.stringify(edge.properties) : '',
    };
  }

  startEditChrono(entry: ChronoEntry): void {
    this.editingId.set(entry._id);
    this.editError.set('');
    this.editChrono = {
      title: entry.title,
      kind: entry.kind,
      status: entry.status,
      startsAt: entry.startsAt ? this.toLocalDatetime(entry.startsAt) : '',
      endsAt: entry.endsAt ? this.toLocalDatetime(entry.endsAt) : '',
      description: entry.description ?? '',
      tags: (entry.tags ?? []).join(', '),
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
    let props: Record<string, string | number | boolean> | undefined;
    if (this.editMemory.properties.trim()) {
      try { props = JSON.parse(this.editMemory.properties.trim()); }
      catch (e) { this.editSaving.set(false); this.editError.set(`Properties: ${e instanceof Error ? e.message : 'invalid JSON'}`); return; }
    }
    this.api.updateMemory(this.activeSpaceId(), id, {
      fact: this.editMemory.fact.trim(),
      tags: this.editMemory.tags.split(',').map(s => s.trim()).filter(Boolean),
      entityIds: this.editMemory.entityIds.split(',').map(s => s.trim()).filter(Boolean),
      description: this.editMemory.description.trim(),
      ...(props ? { properties: props } : {}),
    }).subscribe({
      next: (updated) => {
        this.editSaving.set(false);
        this.editingId.set('');
        this.memories.update(list => list.map(m => m._id === id ? updated : m));
      },
      error: (err) => { this.editSaving.set(false); this.editError.set(err.error?.error ?? 'Failed to save'); },
    });
  }

  saveEditEntity(id: string): void {
    this.editSaving.set(true);
    this.editError.set('');
    let props: Record<string, string | number | boolean> | undefined;
    if (this.editEntity.properties.trim()) {
      try { props = JSON.parse(this.editEntity.properties.trim()); }
      catch (e) { this.editSaving.set(false); this.editError.set(`Properties: ${e instanceof Error ? e.message : 'invalid JSON'}`); return; }
    }
    this.api.updateEntity(this.activeSpaceId(), id, {
      name: this.editEntity.name.trim(),
      type: this.editEntity.type.trim(),
      tags: this.editEntity.tags.split(',').map(s => s.trim()).filter(Boolean),
      description: this.editEntity.description.trim(),
      ...(props ? { properties: props } : {}),
    }).subscribe({
      next: (updated) => {
        this.editSaving.set(false);
        this.editingId.set('');
        this.entities.update(list => list.map(e => e._id === id ? updated : e));
      },
      error: (err) => { this.editSaving.set(false); this.editError.set(err.error?.error ?? 'Failed to save'); },
    });
  }

  saveEditEdge(id: string): void {
    this.editSaving.set(true);
    this.editError.set('');
    let props: Record<string, string | number | boolean> | undefined;
    if (this.editEdge.properties.trim()) {
      try { props = JSON.parse(this.editEdge.properties.trim()); }
      catch (e) { this.editSaving.set(false); this.editError.set(`Properties: ${e instanceof Error ? e.message : 'invalid JSON'}`); return; }
    }
    this.api.updateEdge(this.activeSpaceId(), id, {
      label: this.editEdge.label.trim(),
      type: this.editEdge.type.trim(),
      tags: this.editEdge.tags.split(',').map(s => s.trim()).filter(Boolean),
      description: this.editEdge.description.trim(),
      ...(this.editEdge.weight != null ? { weight: this.editEdge.weight } : {}),
      ...(props ? { properties: props } : {}),
    }).subscribe({
      next: (updated) => {
        this.editSaving.set(false);
        this.editingId.set('');
        this.edges.update(list => list.map(e => e._id === id ? updated : e));
      },
      error: (err) => { this.editSaving.set(false); this.editError.set(err.error?.error ?? 'Failed to save'); },
    });
  }

  saveEditChrono(id: string): void {
    this.editSaving.set(true);
    this.editError.set('');
    this.api.updateChrono(this.activeSpaceId(), id, {
      title: this.editChrono.title.trim(),
      kind: this.editChrono.kind as ChronoKind,
      status: this.editChrono.status as ChronoStatus,
      ...(this.editChrono.startsAt ? { startsAt: new Date(this.editChrono.startsAt).toISOString() } : {}),
      ...(this.editChrono.endsAt ? { endsAt: new Date(this.editChrono.endsAt).toISOString() } : {}),
      description: this.editChrono.description.trim(),
      tags: this.editChrono.tags.split(',').map(s => s.trim()).filter(Boolean),
      entityIds: this.editChrono.entityIds.split(',').map(s => s.trim()).filter(Boolean),
    }).subscribe({
      next: (updated) => {
        this.editSaving.set(false);
        this.editingId.set('');
        this.chrono.update(list => list.map(c => c._id === id ? updated : c));
      },
      error: (err) => { this.editSaving.set(false); this.editError.set(err.error?.error ?? 'Failed to save'); },
    });
  }

  deleteMemory(id: string): void {
    this.confirmDeleteId.set('');
    this.api.deleteMemory(this.activeSpaceId(), id).subscribe({
      next: () => { this.memories.update(list => list.filter(m => m._id !== id)); this.loadStats(this.activeSpaceId()); },
      error: () => {},
    });
  }

  createMemory(): void {
    if (!this.memoryForm.fact.trim()) return;
    this.creatingMemory.set(true);
    this.createMemoryError.set('');
    const tags = this.memoryForm.tags.split(',').map(s => s.trim()).filter(Boolean);
    const entityIds = this.memoryForm.entityIds.split(',').map(s => s.trim()).filter(Boolean);
    const body: Parameters<ApiService['createMemory']>[1] = { fact: this.memoryForm.fact.trim() };
    if (tags.length) body.tags = tags;
    if (entityIds.length) body.entityIds = entityIds;
    if (this.memoryForm.description.trim()) body.description = this.memoryForm.description.trim();
    if (this.memoryForm.properties.trim()) {
      try { body.properties = JSON.parse(this.memoryForm.properties.trim()); }
      catch { this.creatingMemory.set(false); this.createMemoryError.set('Properties must be valid JSON'); return; }
    }
    this.api.createMemory(this.activeSpaceId(), body).subscribe({
      next: () => {
        this.creatingMemory.set(false);
        this.showMemoryForm.set(false);
        this.memoryForm = { fact: '', tags: '', entityIds: '', description: '', properties: '' };
        this.loadStats(this.activeSpaceId());
        this.loadCurrentTab(this.activeSpaceId());
      },
      error: (err) => { this.creatingMemory.set(false); this.createMemoryError.set(err.error?.error ?? 'Failed to create memory'); },
    });
  }

  createEntity(): void {
    if (!this.entityForm.name.trim()) return;
    this.creatingEntity.set(true);
    this.createEntityError.set('');
    const tags = this.entityForm.tags.split(',').map(s => s.trim()).filter(Boolean);
    const body: Parameters<ApiService['createEntity']>[1] = { name: this.entityForm.name.trim() };
    if (this.entityForm.type.trim()) body.type = this.entityForm.type.trim();
    if (tags.length) body.tags = tags;
    if (this.entityForm.description.trim()) body.description = this.entityForm.description.trim();
    if (this.entityForm.properties.trim()) {
      try { body.properties = JSON.parse(this.entityForm.properties.trim()); }
      catch { this.creatingEntity.set(false); this.createEntityError.set('Properties must be valid JSON'); return; }
    }
    this.api.createEntity(this.activeSpaceId(), body).subscribe({
      next: () => {
        this.creatingEntity.set(false);
        this.showEntityForm.set(false);
        this.entityForm = { name: '', type: '', tags: '', description: '', properties: '' };
        this.loadStats(this.activeSpaceId());
        this.loadCurrentTab(this.activeSpaceId());
      },
      error: (err) => { this.creatingEntity.set(false); this.createEntityError.set(err.error?.error ?? 'Failed to create entity'); },
    });
  }

  createEdge(): void {
    if (!this.edgeForm.from.trim() || !this.edgeForm.to.trim() || !this.edgeForm.label.trim()) return;
    this.creatingEdge.set(true);
    this.createEdgeError.set('');
    const tags = this.edgeForm.tags.split(',').map(s => s.trim()).filter(Boolean);
    const body: Parameters<ApiService['createEdge']>[1] = {
      from: this.edgeForm.from.trim(),
      to: this.edgeForm.to.trim(),
      label: this.edgeForm.label.trim(),
    };
    if (this.edgeForm.type.trim()) body.type = this.edgeForm.type.trim();
    if (this.edgeForm.weight != null) body.weight = this.edgeForm.weight;
    if (tags.length) body.tags = tags;
    if (this.edgeForm.description.trim()) body.description = this.edgeForm.description.trim();
    if (this.edgeForm.properties.trim()) {
      try { body.properties = JSON.parse(this.edgeForm.properties.trim()); }
      catch { this.creatingEdge.set(false); this.createEdgeError.set('Properties must be valid JSON'); return; }
    }
    this.api.createEdge(this.activeSpaceId(), body).subscribe({
      next: () => {
        this.creatingEdge.set(false);
        this.showEdgeForm.set(false);
        this.edgeForm = { from: '', to: '', label: '', type: '', weight: null, tags: '', description: '', properties: '' };
        this.loadStats(this.activeSpaceId());
        this.loadCurrentTab(this.activeSpaceId());
      },
      error: (err) => { this.creatingEdge.set(false); this.createEdgeError.set(err.error?.error ?? 'Failed to create edge'); },
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
      ? (this.chronoForm.customKind.trim() as ChronoKind)
      : this.chronoForm.kind as ChronoKind;
    if (!resolvedKind) return;
    this.creatingChrono.set(true);
    this.createChronoError.set('');
    const tags = this.chronoForm.tags.split(',').map(s => s.trim()).filter(Boolean);
    const entityIds = this.chronoForm.entityIds.split(',').map(s => s.trim()).filter(Boolean);
    const body: Parameters<ApiService['createChrono']>[1] = {
      title: this.chronoForm.title.trim(),
      kind: resolvedKind,
      startsAt: new Date(this.chronoForm.startsAt).toISOString(),
    };
    if (this.chronoForm.endsAt) body.endsAt = new Date(this.chronoForm.endsAt).toISOString();
    if (this.chronoForm.description.trim()) body.description = this.chronoForm.description.trim();
    if (tags.length) body.tags = tags;
    if (entityIds.length) body.entityIds = entityIds;
    this.api.createChrono(this.activeSpaceId(), body).subscribe({
      next: () => {
        this.creatingChrono.set(false);
        this.showChronoForm.set(false);
        this.chronoForm = { title: '', kind: 'event', customKind: '', startsAt: '', endsAt: '', description: '', tags: '', entityIds: '' };
        this.loadCurrentTab(this.activeSpaceId());
      },
      error: (err) => { this.creatingChrono.set(false); this.createChronoError.set(err.error?.error ?? 'Failed to create chrono entry'); },
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

  formatProps(props?: Record<string, string | number | boolean>): string {
    if (!props || Object.keys(props).length === 0) return '—';
    return Object.entries(props).map(([k, v]) => `${k}: ${v}`).join(', ');
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

  // ── Settings tab methods ────────────────────────────────────────────────

  loadSettings(): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.settingsLoading.set(true);
    this.settingsError.set('');
    this.metaError.set('');
    this.settingsSaved.set(false);
    this.metaSaved.set(false);

    const sv = this.spaces().find(s => s.space.id === spaceId);
    if (sv) {
      this.settingsForm.label = sv.space.label;
      this.settingsForm.description = sv.space.description ?? '';
    }

    this.api.getSpaceMeta(spaceId).subscribe({
      next: (meta) => {
        this.spaceMeta.set(meta);
        this.metaForm.validationMode = meta.validationMode ?? 'off';
        this.metaForm.strictLinkage = meta.strictLinkage ?? false;
        this.metaForm.purpose = meta.purpose ?? '';
        this.metaForm.usageNotes = meta.usageNotes ?? '';
        this.metaForm.entityTypesStr = (meta.entityTypes ?? []).join(', ');
        this.metaForm.edgeLabelsStr = (meta.edgeLabels ?? []).join(', ');
        this.metaForm.tagSuggestionsStr = (meta.tagSuggestions ?? []).join(', ');
        this.metaForm.namingPatternsJson = meta.namingPatterns && Object.keys(meta.namingPatterns).length
          ? JSON.stringify(meta.namingPatterns, null, 2) : '';
        this.metaForm.requiredPropertiesJson = meta.requiredProperties && Object.keys(meta.requiredProperties).length
          ? JSON.stringify(meta.requiredProperties, null, 2) : '';
        this.metaForm.propertySchemasJson = meta.propertySchemas && Object.keys(meta.propertySchemas).length
          ? JSON.stringify(meta.propertySchemas, null, 2) : '';
        this.settingsLoading.set(false);
      },
      error: () => {
        this.spaceMeta.set(null);
        this.settingsLoading.set(false);
      },
    });
  }

  saveSpaceSettings(): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.settingsSaving.set(true);
    this.settingsError.set('');
    this.settingsSaved.set(false);
    this.api.updateSpace(spaceId, {
      label: this.settingsForm.label.trim(),
      description: this.settingsForm.description.trim(),
    }).subscribe({
      next: ({ space }) => {
        this.settingsSaving.set(false);
        this.settingsSaved.set(true);
        // Update the local space list to reflect changes
        this.spaces.update(list =>
          list.map(sv => sv.space.id === spaceId ? { ...sv, space: { ...sv.space, label: space.label, description: space.description } } : sv),
        );
        setTimeout(() => this.settingsSaved.set(false), 3000);
      },
      error: (err) => {
        this.settingsSaving.set(false);
        this.settingsError.set(err.error?.error ?? 'Failed to save');
      },
    });
  }

  saveMetaSettings(): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.metaSaving.set(true);
    this.metaError.set('');
    this.metaSaved.set(false);

    const parseList = (s: string): string[] => s.split(',').map(v => v.trim()).filter(Boolean);

    const meta: Partial<SpaceMeta> = {
      validationMode: this.metaForm.validationMode,
      strictLinkage: this.metaForm.strictLinkage,
      purpose: this.metaForm.purpose.trim() || undefined,
      usageNotes: this.metaForm.usageNotes.trim() || undefined,
      entityTypes: parseList(this.metaForm.entityTypesStr),
      edgeLabels: parseList(this.metaForm.edgeLabelsStr),
      tagSuggestions: parseList(this.metaForm.tagSuggestionsStr),
    };

    // Parse optional JSON fields
    if (this.metaForm.namingPatternsJson.trim()) {
      try { meta.namingPatterns = JSON.parse(this.metaForm.namingPatternsJson.trim()); }
      catch { this.metaSaving.set(false); this.metaError.set('Naming patterns must be valid JSON'); return; }
    }
    if (this.metaForm.requiredPropertiesJson.trim()) {
      try { meta.requiredProperties = JSON.parse(this.metaForm.requiredPropertiesJson.trim()); }
      catch { this.metaSaving.set(false); this.metaError.set('Required properties must be valid JSON'); return; }
    }
    if (this.metaForm.propertySchemasJson.trim()) {
      try { meta.propertySchemas = JSON.parse(this.metaForm.propertySchemasJson.trim()); }
      catch { this.metaSaving.set(false); this.metaError.set('Property schemas must be valid JSON'); return; }
    }

    this.api.updateSpace(spaceId, { meta }).subscribe({
      next: () => {
        this.metaSaving.set(false);
        this.metaSaved.set(true);
        setTimeout(() => this.metaSaved.set(false), 3000);
      },
      error: (err) => {
        this.metaSaving.set(false);
        const errMsg = err.error?.error ?? err.error?.message ?? 'Failed to save schema';
        this.metaError.set(errMsg);
      },
    });
  }

  // ── Space admin methods (Settings tab) ──────────────────────────────────

  isActiveBuiltIn(): boolean {
    const sv = this.spaces().find(s => s.space.id === this.activeSpaceId());
    return !!sv?.space.builtIn;
  }

  adminCreateSpace(): void {
    if (!this.newSpaceForm.label.trim()) return;
    this.creatingNewSpace.set(true);
    this.spaceAdminError.set('');
    const body: { label: string; id?: string; description?: string } = { label: this.newSpaceForm.label.trim() };
    if (this.newSpaceForm.id.trim()) body.id = this.newSpaceForm.id.trim();
    if (this.newSpaceForm.description.trim()) body.description = this.newSpaceForm.description.trim();
    this.api.createSpace(body).subscribe({
      next: ({ space }) => {
        this.creatingNewSpace.set(false);
        this.showCreateSpaceDialog.set(false);
        this.newSpaceForm = { label: '', id: '', description: '' };
        this.spaces.update(list => [...list, { space }]);
        this.selectSpace(space.id);
      },
      error: (err) => {
        this.creatingNewSpace.set(false);
        this.spaceAdminError.set(err.error?.error ?? 'Failed to create space');
      },
    });
  }

  adminWipeSpace(): void {
    const spaceId = this.activeSpaceId();
    this.wipingSpace.set(true);
    this.spaceAdminError.set('');
    this.api.wipeSpace(spaceId).subscribe({
      next: () => {
        this.wipingSpace.set(false);
        this.showWipeSpaceConfirm.set(false);
        this.loadStats(spaceId);
        this.loadCurrentTab(spaceId);
      },
      error: (err) => {
        this.wipingSpace.set(false);
        this.spaceAdminError.set(err.error?.error ?? 'Failed to wipe space');
      },
    });
  }

  adminDeleteSpace(): void {
    const spaceId = this.activeSpaceId();
    this.deletingSpace.set(true);
    this.spaceAdminError.set('');
    this.api.deleteSpace(spaceId).subscribe({
      next: () => {
        this.deletingSpace.set(false);
        this.showDeleteSpaceConfirm.set(false);
        this.spaces.update(list => list.filter(sv => sv.space.id !== spaceId));
        const remaining = this.spaces();
        if (remaining.length > 0) {
          this.selectSpace(remaining[0].space.id);
        } else {
          this.activeSpaceId.set('');
        }
      },
      error: (err) => {
        this.deletingSpace.set(false);
        this.spaceAdminError.set(err.error?.error ?? 'Failed to delete space');
      },
    });
  }
}
