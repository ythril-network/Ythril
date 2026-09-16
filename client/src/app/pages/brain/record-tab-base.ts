import { Directive, effect, inject, input, signal, untracked } from '@angular/core';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { RecordListState } from './record-list-state.service';
import type { ListSort } from '../../core/brain-api.service';

/** The type/tag filter a record list is narrowed by. Empty strings mean "no filter". */
export interface RecordFilter {
  type: string;
  tag: string;
  /**
   * Per-column description filter.
   *
   * Separate from `search`, which the server spans over name/fact/title AND description. A control in
   * the Description header has to narrow that column alone, or it reports something it does not do.
   */
  description: string;
  /**
   * Per-column properties filter — matches any VALUE in the bag, not a key (owner's call).
   *
   * The server side is a collection scan (`$expr` over `$objectToArray` cannot use an index), so this
   * is debounced like the other typed filters and the query carries its own deadline.
   */
  properties: string;
  /** Entity-NAME filters. The columns show names; the records store ids, so the server translates. */
  fromName: string;
  toName: string;
  entityName: string;
}

/**
 * Every filter cleared — the state a tab opens in.
 *
 * Named because it was written inline in the signal and nowhere else, so a spec wanting "the default plus one
 * field" had to retype all seven and the ones that did not retyped fewer, leaving the template reading
 * `undefined` for the rest. `RecordFilter` requires all seven precisely because the column headers bind them.
 */
export function noRecordFilter(): RecordFilter {
  return { type: '', tag: '', description: '', properties: '', fromName: '', toName: '', entityName: '' };
}

/**
 * Shared machinery for the five record-tab components (memories/entities/edges/chrono/filemeta),
 * extracted after all five landed (A17.9d). Holds ONLY what is provably universal across all of them
 * — the collaborators every tab injects, the `spaceId` input, page size, the paging cursor, the
 * self-load effect, and the delete-confirm toggle.
 *
 * Deliberately minimal: everything that VARIES stays in the subclass — the `brainApi`/`filesApi` and
 * `drawerState` a tab may or may not need, the `mutated`/`openInManager` outputs, the `recordFilter`/
 * search state, and every create/edit/delete/search body. That is the point: a "CRUD base" that
 * absorbed those would erase the per-tab asymmetries the A17.9b-6b characterization tests pin (memory
 * sends properties raw while entity/edge strip; delete refreshes stats for some tabs but not others;
 * memory/chrono resolve chip names on load, entity does not). The base cannot force a wrong shape.
 *
 * `@Directive()` (not a plain abstract class) is the Angular-blessed carrier for shared component
 * logic with `input()`/`inject()`/`effect()`; concrete tabs extend it and add their own `@Component`.
 */
@Directive()
export abstract class RecordTabBase {
  readonly store = inject(BrainStore);
  readonly picker = inject(EntityRefPicker);
  readonly recordList = inject(RecordListState);

  readonly spaceId = input.required<string>();
  readonly pageSize = 20;

  skip = signal(0);

  /**
   * Column sort state, wired to the server's `?sort=&dir=` (slice 2a). `sortField === ''` means "no
   * sort" — the endpoint keeps its own default order, exactly as before any header was clicked. Only
   * fields the server whitelists for the collection are ever set here (the tab only renders a caret on
   * those columns), so a click can never produce a 400.
   */
  sortField = signal('');
  sortDir = signal<'asc' | 'desc'>('desc');

  /**
   * The type/tag filter, shared by all four record tabs (2b-ii moved it out of the retired
   * `record-filter-bar` and into the column headers). The docked header controls bind to it, and the
   * facts tab's tag-badge click writes it — so pushing a value in still reflects into the header
   * control, the round-trip the old filter bar's `[value]` gave. Each tab's `load()` reads it.
   */
  recordFilter = signal<RecordFilter>(noRecordFilter());

  /** Unique datalist id for a tab's docked tag-filter suggestions (multiple tables on one shell). */
  readonly tagListId = `brain-tag-filter-${RecordTabBase._tagSeq++}`;
  private static _tagSeq = 0;

  /**
   * Docked freetext column filter (2b-iii-b), wired to the server's substring `?search=` (2b-iii-a).
   * A column input (Name / Fact / Relation) feeds this; the reload is DEBOUNCED so it doesn't hit the
   * server on every keystroke — the one thing the retired top filter bar got wrong. Distinct from the
   * top bar's semantic search, which is untouched here.
   */
  search = signal('');
  private _searchTimer: ReturnType<typeof setTimeout> | null = null;

  /** The `?search=` value to hand the API, or `undefined` when the freetext filter is empty. */
  protected searchParam(): string | undefined {
    return this.search().trim() || undefined;
  }

  constructor() {
    // Self-load on creation (tab activation via the shell's gated @if) and on a space switch while
    // mounted. This effect must depend on `spaceId` ONLY. The reset + load are wrapped in `untracked`
    // so the signals they touch — critically `resetOnSpaceChange()` writing `recordFilter` to a NEW
    // object, which `load()` then reads — are NOT registered as effect dependencies. Without this, that
    // write→read pair self-triggers the effect forever (signals compare by reference, so each reset is a
    // "change"), storming `load()` on every microtask. Filter/search reloads are driven imperatively by
    // the tab's own handlers, so the effect has no business reacting to them.
    effect(() => {
      const id = this.spaceId();
      untracked(() => {
        this.skip.set(0);
        this.sortField.set('');
        this.sortDir.set('desc');
        this.search.set('');
        this.resetOnSpaceChange();
        if (id) this.load();
      });
    });

    // Live refresh (F12): when the shell signals a change for this space+collection, reload the CURRENT
    // page (no skip/search reset — keep the user's position). Only the mounted tab has a live effect, so
    // only the active list reloads. Depends on `liveRefreshTick` ONLY — `spaceId` and everything `load()`
    // reads are untracked so a space switch doesn't double-load and filter reads don't re-trigger it.
    let firstTick = true;
    effect(() => {
      this.store.liveRefreshTick();
      if (firstTick) { firstTick = false; return; }
      untracked(() => { if (this.spaceId()) this.load(); });
    });
  }

  /** Load the tab's list for the active space. Sets `recordList.loading`/`loadError` + `store.<coll>`. */
  protected abstract load(): void;

  /** Override to clear per-tab filter/search state on a space switch (default: nothing beyond skip). */
  protected resetOnSpaceChange(): void {}

  retryCurrentTab(): void { this.load(); }

  prevPage(): void { this.skip.update(s => Math.max(0, s - this.pageSize)); this.load(); }
  nextPage(): void { this.skip.update(s => s + this.pageSize); this.load(); }

  /**
   * Cycle the sort for a column header: unsorted → desc → asc → back to the endpoint's default.
   * Clicking a different column starts it at desc. Any change resets paging to the first page — a new
   * order makes the current `skip` meaningless — and reloads from the server (the whole point: the
   * sort spans every page, not just the visible rows).
   */
  setSort(field: string): void {
    if (this.sortField() !== field) {
      this.sortField.set(field);
      this.sortDir.set('desc');
    } else if (this.sortDir() === 'desc') {
      this.sortDir.set('asc');
    } else {
      this.sortField.set('');
      this.sortDir.set('desc');
    }
    this.skip.set(0);
    this.load();
  }

  /** The active sort for the current column, or `null` when this column is not the sort key. */
  sortState(field: string): 'asc' | 'desc' | null {
    return this.sortField() === field ? this.sortDir() : null;
  }

  /** Docked Type/Kind header filter changed → narrow the list from page 1. */
  setTypeFilter(value: string): void {
    this.recordFilter.update(f => ({ ...f, type: value }));
    this.skip.set(0);
    this.load();
  }

  /** Docked Tags header filter changed → narrow the list from page 1 (trimmed). */
  setTagFilter(value: string): void {
    this.recordFilter.update(f => ({ ...f, tag: value.trim() }));
    this.skip.set(0);
    this.load();
  }

  /** Docked Description header filter changed. Debounced like the freetext one — it is typed into. */
  setDescriptionFilter(value: string): void {
    this.recordFilter.update(f => ({ ...f, description: value }));
    this.skip.set(0);
    if (this._descTimer) clearTimeout(this._descTimer);
    this._descTimer = setTimeout(() => this.load(), 250);
  }
  private _descTimer?: ReturnType<typeof setTimeout>;

  /** Docked Properties header filter changed. Debounced — the server side scans (no index is possible). */
  setPropertiesFilter(value: string): void {
    this.recordFilter.update(f => ({ ...f, properties: value }));
    this.skip.set(0);
    if (this._propsTimer) clearTimeout(this._propsTimer);
    this._propsTimer = setTimeout(() => this.load(), 250);
  }
  private _propsTimer?: ReturnType<typeof setTimeout>;

  /**
   * Docked entity-NAME header filter (From / To / Entities).
   *
   * `key` picks which column, so one debounced setter serves all three rather than three near-copies.
   */
  setNameFilter(key: 'fromName' | 'toName' | 'entityName', value: string): void {
    this.recordFilter.update(f => ({ ...f, [key]: value }));
    this.skip.set(0);
    if (this._nameTimer) clearTimeout(this._nameTimer);
    this._nameTimer = setTimeout(() => this.load(), 250);
  }
  private _nameTimer?: ReturnType<typeof setTimeout>;

  /**
   * Docked freetext header filter changed. Updates the value immediately (so the input stays
   * responsive) but debounces the server reload by 250ms, so typing "kubernetes" is one request, not
   * ten. Resets paging to the first page.
   */
  setSearchFilter(value: string): void {
    this.search.set(value);
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this.skip.set(0);
      this.load();
    }, 250);
  }

  /** The `ListSort` to hand the API, or `undefined` when no column sort is active. */
  protected sortParam(): ListSort | undefined {
    return this.sortField() ? { field: this.sortField(), dir: this.sortDir() } : undefined;
  }

  requestDelete(id: string): void { this.recordList.confirmDeleteId.set(id); }
  cancelDelete(): void { this.recordList.confirmDeleteId.set(''); }
}
