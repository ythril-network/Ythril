/**
 * EntitySearchComponent — shared entity search with name and semantic modes.
 *
 * Modes:
 *   bar    — Full search bar with A–Z / Semantic toggle. Emits `selected` when
 *            the user picks an entity from the dropdown. Used in the Entities
 *            tab to drive list filtering (parent controls actual load).
 *   picker — Compact inline picker for form fields (edge from/to, memory/chrono
 *            entityIds). Emits `selected` on pick. Parent owns the display text.
 *
 * Inputs:
 *   spaceId      — Required. Which space to search in.
 *   mode         — 'bar' (default) or 'picker'.
 *   placeholder  — Input placeholder text.
 *   defaultMode  — 'semantic' (default) or 'name'.
 *   value        — Controlled display value (picker mode).
 *   debounceMs   — Debounce delay (default 280ms).
 *
 * Outputs:
 *   selected     — Emits the Entity the user clicked.
 *   queryChange  — Emits raw query string on every keystroke (bar mode —
 *                  parent uses this to trigger name-filter list reload).
 *   cleared      — Emits when the clear button is clicked (bar mode).
 */

import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  OnDestroy,
  OnChanges,
  SimpleChanges,
  signal,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, Subscription, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError, map } from 'rxjs/operators';
import { ApiService, Entity, RecallResult } from '../core/api.service';
import { TranslocoPipe } from '@jsverse/transloco';

@Component({
  selector: 'app-entity-search',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe],
  styles: [`
    :host { display: block; position: relative; }

    .search-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    input[type="search"],
    input[type="text"] {
      flex: 1;
      min-width: 0;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      padding: 6px 10px;
      font-size: 13px;
    }
    input:focus { outline: none; border-color: var(--accent); }

    /* pill group (reuse graph style) */
    .pill-group {
      display: flex;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
      flex-shrink: 0;
    }
    .pill-group button {
      padding: 5px 10px;
      font-size: 11px;
      background: transparent;
      border: none;
      border-right: 1px solid var(--border);
      color: var(--text-secondary);
      cursor: pointer;
      white-space: nowrap;
    }
    .pill-group button:last-child { border-right: none; }
    .pill-group button.active {
      background: var(--accent-dim);
      color: var(--accent);
    }
    .pill-group button:hover:not(.active) { background: var(--bg-surface); }

    .btn-clear {
      padding: 5px 8px;
      font-size: 11px;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      cursor: pointer;
      flex-shrink: 0;
    }
    .btn-clear:hover { color: var(--text-primary); border-color: var(--text-muted); }

    .dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-md);
      z-index: 200;
      max-height: 260px;
      overflow-y: auto;
    }

    .dropdown-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 12px;
      cursor: pointer;
      border-bottom: 1px solid var(--border);
    }
    .dropdown-item:last-child { border-bottom: none; }
    .dropdown-item:hover { background: var(--bg-elevated); }

    .item-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }
    .item-meta {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .item-type {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--accent-dim);
      color: var(--accent);
      font-weight: 500;
    }
    .item-desc {
      font-size: 11px;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .item-id {
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }
    .item-score {
      font-size: 10px;
      color: var(--text-muted);
    }

    .dropdown-empty {
      padding: 12px;
      font-size: 12px;
      color: var(--text-muted);
      text-align: center;
    }

    .spinner-wrap {
      padding: 10px;
      display: flex;
      justify-content: center;
    }
    .spinner {
      width: 16px; height: 16px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `],
  template: `
    <div class="search-row">
      <input
        [type]="mode === 'picker' ? 'text' : 'search'"
        [placeholder]="placeholder | transloco"
        [ngModel]="displayValue()"
        (ngModelChange)="onInput($event)"
        (focus)="focused.set(true)"
        (blur)="schedulClose()"
        (keyup.enter)="selectFirst()"
        [attr.aria-label]="placeholder | transloco"
        autocomplete="off"
      />
      @if (mode === 'bar') {
        <div class="pill-group" [attr.title]="'common.searchMode.tooltip' | transloco">
          <button [class.active]="searchMode() === 'name'"     (click)="setMode('name')">{{ 'common.sortAZ' | transloco }}</button>
          <button [class.active]="searchMode() === 'semantic'" (click)="setMode('semantic')">{{ 'entitySearch.semantic' | transloco }}</button>
        </div>
        @if (displayValue()) {
          <button class="btn-clear" (click)="clear()">{{ 'entitySearch.clearButton' | transloco }}</button>
        }
      }
    </div>

    @if (focused() && (results().length > 0 || loading())) {
      <div class="dropdown">
        @if (loading()) {
          <div class="spinner-wrap"><div class="spinner"></div></div>
        } @else if (results().length === 0) {
          <div class="dropdown-empty">{{ 'entitySearch.noResults' | transloco }}</div>
        } @else {
          @for (ent of results(); track ent._id) {
            <div class="dropdown-item" (mousedown)="pick(ent)">
              <span class="item-name">{{ ent.name }}</span>
              <div class="item-meta">
                @if (ent.type) { <span class="item-type">{{ ent.type }}</span> }
                @if (ent.description) { <span class="item-desc">{{ ent.description }}</span> }
              </div>
              @if (mode === 'bar') {
                <span class="item-id">{{ ent._id }}</span>
              }
            </div>
          }
        }
      </div>
    }
  `,
})
export class EntitySearchComponent implements OnInit, OnDestroy, OnChanges {
  @Input() spaceId = '';
  @Input() mode: 'bar' | 'picker' = 'bar';
  @Input() placeholder = 'entitySearch.defaultPlaceholder';
  @Input() defaultMode: 'name' | 'semantic' = 'semantic';
  /** Controlled display value for picker mode (parent sets this after pick). */
  @Input() value = '';
  @Input() debounceMs = 280;

  @Output() selected = new EventEmitter<Entity>();
  @Output() queryChange = new EventEmitter<string>();
  @Output() cleared = new EventEmitter<void>();

  private api = inject(ApiService);

  searchMode = signal<'name' | 'semantic'>('semantic');
  results = signal<Entity[]>([]);
  focused = signal(false);
  loading = signal(false);

  private query = signal('');
  private input$ = new Subject<string>();
  private subs = new Subscription();
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  displayValue(): string {
    // picker mode: prefer parent-controlled value (single-select), fall back to
    // internal query (multi-select where [value] is never bound) so the input
    // reflects what the user typed AND clears to '' after pick().
    if (this.mode === 'picker') return this.value || this.query();
    return this.query();
  }

  ngOnInit(): void {
    this.searchMode.set(this.defaultMode);

    this.subs.add(
      this.input$.pipe(
        debounceTime(this.debounceMs),
        distinctUntilChanged(),
        switchMap(q => {
          if (!q.trim() || !this.spaceId) {
            this.loading.set(false);
            return of({ entities: [] as Entity[] });
          }
          this.loading.set(true);
          if (this.searchMode() === 'semantic') {
            return this.api.recallBrain(this.spaceId, { query: q, types: ['entity'], topK: 10 }).pipe(
              catchError(() => of({ results: [] as RecallResult[], count: 0 })),
              map(res => ({
                entities: res.results
                  .filter(r => r['type'] === 'entity')
                  .map(r => ({
                    _id: r['_id'] as string,
                    spaceId: this.spaceId,
                    name: (r['name'] as string) || '',
                    type: (r['entityType'] as string) || '',
                    description: r['description'] as string | undefined,
                    tags: (r['tags'] as string[]) ?? [],
                    properties: (r['properties'] as Record<string, string | number | boolean>) ?? {},
                    createdAt: r['createdAt'] as string,
                    updatedAt: r['createdAt'] as string,
                    seq: 0,
                  } as Entity)),
              })),
            );
          }
          return this.api.searchEntitiesByName(this.spaceId, q).pipe(
            catchError(() => of({ entities: [] as Entity[] })),
          );
        }),
      ).subscribe(res => {
        this.results.set(res.entities);
        this.loading.set(false);
      }),
    );
  }

  ngOnChanges(changes: SimpleChanges): void {
    // If spaceId changes (user switches space), clear stale results
    if (changes['spaceId'] && !changes['spaceId'].firstChange) {
      this.results.set([]);
      this.query.set('');
    }
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    if (this.closeTimer) clearTimeout(this.closeTimer);
  }

  onInput(v: string): void {
    this.query.set(v);
    this.input$.next(v);
    this.queryChange.emit(v);
    // In semantic mode we always search regardless; in name mode the parent
    // may use queryChange to filter without needing a separate API call
    // (listEntities already does server-side name filtering).
    if (!v.trim()) {
      this.results.set([]);
      this.loading.set(false);
    }
  }

  setMode(m: 'name' | 'semantic'): void {
    this.searchMode.set(m);
    // Re-fire current query in new mode
    const q = this.query();
    if (q.trim()) this.input$.next(q);
  }

  selectFirst(): void {
    const first = this.results()[0];
    if (first) this.pick(first);
  }

  pick(ent: Entity): void {
    this.selected.emit(ent);
    this.results.set([]);
    this.focused.set(false);
    if (this.mode === 'picker') {
      // Keep display value controlled by parent — clear internal query
      this.query.set('');
    } else {
      this.query.set(ent.name);
    }
  }

  clear(): void {
    this.query.set('');
    this.results.set([]);
    this.cleared.emit();
    this.queryChange.emit('');
  }

  schedulClose(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      this.focused.set(false);
      this.results.set([]);
    }, 200);
  }
}
