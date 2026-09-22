import { Injectable, inject, signal } from '@angular/core';
import { ChronoEntry, Entity, Fact } from '../../core/api.types';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';

/**
 * A form slice that carries a comma-separated entity-id string. Every entity-chip field on the brain
 * page exposes this exact shape — the memory/chrono/file-meta create forms, their inline-edit forms,
 * and the detail drawer's edit models all have an `linkEntities: string`. That shared shape is what lets
 * the picker append to any of them without knowing which one it is.
 */
export interface EntityIdTarget {
  linkEntities: string;
}

/**
 * The brain page's shared entity/memory/chrono reference picker.
 *
 * Extracted from BrainComponent (A17.9b). Shared name/title caches plus the inline entity / memory /
 * chrono pickers serve every form on the page. Previously they were wired by a string-keyed god-switch
 * — `pickEntity(ent, mode, field)` branched on a field key like `'drawer-memory-linkEntities'` and reached
 * directly into the matching form object. This service replaces that switch with a target-based API:
 * the caller passes its OWN form ref, exactly as `removeEntityId(target, id)` already did. That is the
 * seam that lets the drawer and the tab views become their own components (A17.9b-4/5), each holding
 * its own edit models and calling this picker. (The old click-to-open flyout that once fronted these
 * pickers was retired in slice 4d, when file-meta — its last user — moved to the inline ref-fields.)
 *
 * Behaviour preserved verbatim (pinned by the A17.9b-2 characterization tests): picking an entity
 * updates the name cache and appends the id to the target's `linkEntities`; edge endpoints (from/to) are
 * NOT handled here — they set display fields without touching the cache, and stay on the shell with
 * `edgeForm`. Name resolution only runs for the *uncached* ids of a field.
 *
 * `spaceId` is fed by the shell (its `activeSpaceId` is navigation state); the picker never owns it.
 *
 * Provided by BrainComponent (not root): one instance per mounted page.
 */
@Injectable()
export class EntityRefPicker {
  private brainApi = inject(BrainApi);
  private store = inject(BrainStore);

  /** Active brain space. Kept in sync by the shell, whose `activeSpaceId` is nav state. */
  readonly spaceId = signal('');

  // ── Entity picker ────────────────────────────────────────────────────────

  entityNameCache = signal<Record<string, string>>({});

  removeEntityId(target: { linkEntities: string }, id: string): void {
    const parts = target.linkEntities.split(',').map(s => s.trim()).filter(s => s && s !== id);
    target.linkEntities = parts.join(', ');
  }

  entityChips(ids: string): Array<{ id: string; name: string }> {
    const cache = this.entityNameCache();
    return ids.split(',').map(s => s.trim()).filter(Boolean)
      .map(id => ({ id, name: cache[id] ?? id }));
  }

  /** Append the picked entity to a chip field and remember its name for display. */
  pickEntity(ent: Entity, target: EntityIdTarget): void {
    this.entityNameCache.update(c => ({ ...c, [ent._id]: ent.name }));
    target.linkEntities = this.appendEntityId(target.linkEntities, ent._id);
  }

  /** Bulk-resolve entity names into the cache (used when opening a record for editing). */
  resolveEntityNames(ids: string[]): void {
    const spaceId = this.spaceId();
    if (!spaceId) return;
    const unknown = ids.filter(id => !this.entityNameCache()[id]);
    if (!unknown.length) return;
    this.brainApi.getEntitiesByIds(spaceId, unknown).subscribe({
      next: ({ entities }) => {
        const patch: Record<string, string> = {};
        for (const e of entities) patch[e._id] = e.name;
        this.entityNameCache.update(c => ({ ...c, ...patch }));
      },
      error: () => {},
    });
  }

  /** Resolve the uncached ids of a comma-separated field (chip display). */
  resolveEntityNamesFor(idsCsv: string): void {
    this.resolveEntityNames(idsCsv.split(',').map(s => s.trim()).filter(Boolean));
  }

  private appendEntityId(current: string, id: string): string {
    const parts = current.split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.includes(id)) parts.push(id);
    return parts.join(', ');
  }

  // ── Inline memory picker (slice 3c "linkFacts searchable like entity") ───────────────────────
  //
  // Backs app-fact-ref-field: an INLINE search + a title cache so chips show the memory's fact, not a
  // truncated id. Server-searched via listFacts(?search=). Used by the chrono create form, the
  // drawer's chrono edit, and (since slice 4d) the file-meta edit form — only ever one open at a time.

  memPickQuery = signal('');
  memPickResults = signal<Fact[]>([]);
  private _memPickTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fact id → full fact, for chip display (fed on pick and by `resolveMemoryTitles`). */
  memoryTitleCache = signal<Record<string, string>>({});

  onMemPickInput(q: string): void {
    this.memPickQuery.set(q);
    if (this._memPickTimer) clearTimeout(this._memPickTimer);
    if (!q.trim()) { this.memPickResults.set([]); return; }
    this._memPickTimer = setTimeout(() => {
      this.brainApi.listFacts(this.spaceId(), 8, 0, {}, undefined, q).subscribe({
        next: ({ facts }) => this.memPickResults.set(facts.slice(0, 6)),
        error: () => {},
      });
    }, 300);
  }

  /** Cache the picked memory's fact for chip display, append its id to the form, and clear the search. */
  addMemoryRef(form: { linkFacts: string[] }, mem: Fact): void {
    this.memoryTitleCache.update(c => ({ ...c, [mem._id]: mem.fact }));
    if (!form.linkFacts.includes(mem._id)) form.linkFacts.push(mem._id);
    this.memPickQuery.set('');
    this.memPickResults.set([]);
  }

  removeMemoryRef(form: { linkFacts: string[] }, id: string): void {
    form.linkFacts = form.linkFacts.filter(m => m !== id);
  }

  /** Chip label for a linked fact: cached fact → loaded list → truncated id, trimmed for display. */
  memoryRefTitle(id: string): string {
    const full = this.memoryTitleCache()[id] ?? this.store.facts().find(m => m._id === id)?.fact;
    return full ? full.slice(0, 40) + (full.length > 40 ? '…' : '') : id.slice(0, 8) + '…';
  }

  /** Resolve the uncached facts of a linkFacts list (opening a record for editing). Small N → per-id. */
  resolveMemoryTitles(ids: string[]): void {
    const spaceId = this.spaceId();
    if (!spaceId) return;
    for (const id of ids.filter(i => !this.memoryTitleCache()[i])) {
      this.brainApi.getMemory(spaceId, id).subscribe({
        next: (m) => this.memoryTitleCache.update(c => ({ ...c, [m._id]: m.fact })),
        error: () => {},
      });
    }
  }

  // ── Inline chrono picker (file-meta; slice 4d "linkChronos searchable like memories") ──────────
  //
  // Sibling of the memory picker above, backing app-chrono-ref-field. Replaces the old file-meta `fm*`
  // chrono flyout; a title cache lets chips show the entry's title (not a truncated id) and search is
  // server-side via listChrono(?search=), matching the memory picker rather than the old client filter.

  chronoPickQuery = signal('');
  chronoPickResults = signal<ChronoEntry[]>([]);
  private _chronoPickTimer: ReturnType<typeof setTimeout> | null = null;
  /** Chrono id → title, for chip display (fed on pick and by `resolveChronoTitles`). */
  chronoTitleCache = signal<Record<string, string>>({});

  onChronoPickInput(q: string): void {
    this.chronoPickQuery.set(q);
    if (this._chronoPickTimer) clearTimeout(this._chronoPickTimer);
    if (!q.trim()) { this.chronoPickResults.set([]); return; }
    this._chronoPickTimer = setTimeout(() => {
      this.brainApi.listChrono(this.spaceId(), 8, 0, { search: q }).subscribe({
        next: ({ chrono }) => this.chronoPickResults.set(chrono.slice(0, 6)),
        error: () => {},
      });
    }, 300);
  }

  /** Cache the picked entry's title for chip display, append its id to the form, and clear the search. */
  addChronoRef(form: { linkChronos: string[] }, c: ChronoEntry): void {
    this.chronoTitleCache.update(t => ({ ...t, [c._id]: c.title }));
    if (!form.linkChronos.includes(c._id)) form.linkChronos.push(c._id);
    this.chronoPickQuery.set('');
    this.chronoPickResults.set([]);
  }

  removeChronoRef(form: { linkChronos: string[] }, id: string): void {
    form.linkChronos = form.linkChronos.filter(c => c !== id);
  }

  /** Chip label for a linked chrono entry: cached title → loaded list → truncated id, trimmed. */
  chronoRefTitle(id: string): string {
    const full = this.chronoTitleCache()[id] ?? this.store.chrono().find(c => c._id === id)?.title;
    return full ? full.slice(0, 40) + (full.length > 40 ? '…' : '') : id.slice(0, 8) + '…';
  }

  /** Resolve the uncached titles of a linkChronos list (opening a record for editing). Small N → per-id. */
  resolveChronoTitles(ids: string[]): void {
    const spaceId = this.spaceId();
    if (!spaceId) return;
    for (const id of ids.filter(i => !this.chronoTitleCache()[i])) {
      this.brainApi.getChrono(spaceId, id).subscribe({
        next: (c) => this.chronoTitleCache.update(t => ({ ...t, [c._id]: c.title })),
        error: () => {},
      });
    }
  }
}
