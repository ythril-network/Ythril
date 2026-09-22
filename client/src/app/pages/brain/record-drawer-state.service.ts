import { Injectable, inject, signal } from '@angular/core';
import { ChronoType, ChronoStatus, Fact, Entity, Edge, ChronoEntry, KnowledgeType } from '../../core/api.types';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { toLocalDatetime, fmtApiError } from './brain-format';

/**
 * State for the record detail drawer — one drawer edits ONE record (memory/entity/edge/chrono),
 * opened from every record tab.
 *
 * Extracted from BrainComponent (A17.9b-5). Owns the drawer's own signals (`drawerRecord`/`Saving`/
 * `Error`), its four plain edit models, and the open/save/close cycle. It consumes the already-split
 * collaborators — `BrainStore` (record lists + schema helpers), `EntityRefPicker` (chip name
 * resolution), `BrainApi` (persistence) — and the pure `brain-format` utils.
 *
 * `spaceId` is fed by the shell (its `activeSpaceId` is nav state), mirroring `EntityRefPicker`.
 *
 * The plain edit models render under OnPush only because `open()` writes the `drawerRecord` SIGNAL in
 * the same turn — that coupling is load-bearing and pinned by the drawer component's spec.
 *
 * Provided by BrainComponent (not root): one instance per mounted page.
 */

/** The four record kinds one drawer edits. */
export type DrawerKind = KnowledgeType;

/**
 * What the drawer is holding — a discriminated union, so reading `record.fact` is only legal once
 * `kind` has been narrowed to `'fact'`.
 *
 * This used to be `{ kind: DrawerKind; record: any }`, and the `any` was load-bearing in the wrong
 * direction: `open()` reads `record.fact`, `record.name`, `record.label` and `record.title` on four
 * different shapes, so nothing stopped a caller passing an Edge as a `'fact'` and getting a drawer
 * with an undefined fact and no error anywhere.
 */
export type DrawerRecord =
  | { kind: 'fact'; record: Fact }
  | { kind: 'entity'; record: Entity }
  | { kind: 'edge'; record: Edge }
  | { kind: 'chrono'; record: ChronoEntry };

@Injectable()
export class RecordDrawerState {
  private brainApi = inject(BrainApi);
  private store = inject(BrainStore);
  private picker = inject(EntityRefPicker);

  /** Active brain space. Kept in sync by the shell, whose `activeSpaceId` is nav state. */
  readonly spaceId = signal('');

  drawerRecord = signal<DrawerRecord | null>(null);
  drawerSaving = signal(false);
  drawerError = signal('');

  /**
   * The last record a `save()` persisted, for hosts that keep their OWN copies of records.
   *
   * `save()` already patches the `BrainStore` lists, which is all the brain page needs. The graph
   * page holds per-node `nodeMemories`/`nodeChrono` arrays the store never sees, so without this it
   * would save successfully and still show the stale row underneath — the silent-staleness shape.
   * Deliberately a signal rather than a callback so a host reacts declaratively and one host cannot
   * overwrite another's handler.
   */
  readonly lastSaved = signal<DrawerRecord | null>(null);

  drawerEditMemory = { fact: '', type: '', tags: [] as string[], linkEntities: '', description: '', properties: {} as Record<string, string | number | boolean> };
  drawerEditEntity = { name: '', type: '', tags: [] as string[], description: '', properties: {} as Record<string, string | number | boolean> };
  drawerEditEdge = { label: '', type: '', weight: null as number | null, tags: [] as string[], description: '', properties: {} as Record<string, string | number | boolean> };
  drawerEditChrono = { title: '', kind: 'event' as string, status: 'upcoming' as string, startsAt: '', endsAt: '', description: '', tags: [] as string[], linkEntities: '', confidence: null as number | null, linkFacts: [] as string[], properties: {} as Record<string, string | number | boolean> };

  /** Re-seed a drawer entity's properties when its type changes (mirrors the create/inline forms). */
  onEntityTypeChange(type: string): void {
    this.drawerEditEntity.properties = this.store.buildPropertiesObject('entity', this.drawerEditEntity.properties, type);
  }

  /** Effective chrono type for schema lookup. */
  drawerChronoKind(): string {
    return this.drawerEditChrono.kind;
  }

  /** Re-seed the drawer chrono's properties when its kind changes (mirrors the create/inline forms). */
  onDrawerChronoKindChange(): void {
    this.drawerEditChrono.properties = this.store.buildPropertiesObject('chrono', this.drawerEditChrono.properties, this.drawerChronoKind());
  }

  /**
   * Open the drawer on one record.
   *
   * Four overloads rather than one `(kind, record: any)`: the kind and the record are separate
   * arguments, and TypeScript will not narrow the second from the first on its own. Stating the four
   * legal pairings is what makes `open('fact', someEdge)` a compile error at all eight call sites —
   * four of which are templates, checked because the client builds with `strictTemplates`.
   */
  open(kind: 'fact', record: Fact): void;
  open(kind: 'entity', record: Entity): void;
  open(kind: 'edge', record: Edge): void;
  open(kind: 'chrono', record: ChronoEntry): void;
  open(kind: DrawerKind, record: Fact | Entity | Edge | ChronoEntry): void {
    // The one assertion in this method, and the overloads above are what make it sound: every caller
    // has already been checked against a single legal (kind, record) pairing.
    const target = { kind, record } as DrawerRecord;
    this.drawerRecord.set(target);
    this.drawerError.set('');
    this.drawerSaving.set(false);
    // Only facts and chrono entries carry entity references — the other two kinds have no such field.
    const ids: string[] = 'linkEntities' in record ? (record.linkEntities ?? []) : [];
    if (ids.length) this.picker.resolveEntityNames(ids);
    if (target.kind === 'fact') {
      const r = target.record;
      this.drawerEditMemory = {
        fact: r.fact,
        type: r.type ?? '',
        tags: [...(r.tags ?? [])],
        linkEntities: (r.linkEntities ?? []).join(', '),
        description: r.description ?? '',
        properties: this.store.buildPropertiesObject('fact', r.properties ?? {}),
      };
    } else if (target.kind === 'entity') {
      const r = target.record;
      this.drawerEditEntity = {
        name: r.name,
        type: r.type ?? '',
        tags: [...(r.tags ?? [])],
        description: r.description ?? '',
        properties: this.store.buildPropertiesObject('entity', r.properties ?? {}, r.type),
      };
    } else if (target.kind === 'edge') {
      const r = target.record;
      this.drawerEditEdge = {
        label: r.label,
        type: r.type ?? '',
        weight: r.weight ?? null,
        tags: [...(r.tags ?? [])],
        description: r.description ?? '',
        properties: this.store.buildPropertiesObject('edge', r.properties ?? {}, r.label),
      };
    } else {
      const r = target.record;
      this.drawerEditChrono = {
        title: r.title,
        // Verbatim. The old split routed anything outside the five built-ins into a free-text box —
        // which is where a space's own declared types landed, and the box could only ever save a 400.
        kind: r.type,
        status: r.status,
        startsAt: r.startsAt ? toLocalDatetime(r.startsAt) : '',
        endsAt: r.endsAt ? toLocalDatetime(r.endsAt) : '',
        description: r.description ?? '',
        tags: [...(r.tags ?? [])],
        linkEntities: (r.linkEntities ?? []).join(', '),
        confidence: r.confidence ?? null,
        linkFacts: [...(r.linkFacts ?? [])],
        properties: this.store.buildPropertiesObject('chrono', r.properties ?? {}, r.type),
      };
      this.picker.resolveMemoryTitles(r.linkFacts ?? []);
    }
  }

  close(): void {
    this.drawerRecord.set(null);
    this.drawerError.set('');
  }

  save(): void {
    const dr = this.drawerRecord();
    if (!dr) return;
    this.drawerSaving.set(true);
    this.drawerError.set('');
    const id = dr.record._id;
    const spaceId = this.spaceId();
    if (dr.kind === 'fact') {
      const props = this.drawerEditMemory.properties;
      this.brainApi.updateFact(spaceId, id, {
        fact: this.drawerEditMemory.fact.trim(),
        // Trimmed, and sent even when empty: on an UPDATE an absent field means "leave it alone", so clearing the
        // box has to reach the API as an explicit empty value or the type could be set and never unset.
        type: this.drawerEditMemory.type.trim(),
        tags: this.drawerEditMemory.tags,
        linkEntities: this.drawerEditMemory.linkEntities.split(',').map(s => s.trim()).filter(Boolean),
        description: this.drawerEditMemory.description.trim(),
        ...(Object.keys(props).length ? { properties: props } : {}),
      }).subscribe({
        next: (updated) => {
          this.drawerSaving.set(false);
          this.drawerRecord.set({ kind: 'fact', record: updated });
          this.store.facts.update(list => list.map(m => m._id === id ? updated : m));
          this.lastSaved.set({ kind: 'fact', record: updated });
        },
        error: (err) => { this.drawerSaving.set(false); this.drawerError.set(fmtApiError(err, 'Failed to save')); },
      });
    } else if (dr.kind === 'entity') {
      const props = this.store.stripEmptyOptionalProps(this.drawerEditEntity.properties, this.store.entitySchema(this.drawerEditEntity.type));
      this.brainApi.updateEntity(spaceId, id, {
        name: this.drawerEditEntity.name.trim(),
        type: this.drawerEditEntity.type.trim(),
        tags: this.drawerEditEntity.tags,
        description: this.drawerEditEntity.description.trim(),
        ...(Object.keys(props).length ? { properties: props } : {}),
      }).subscribe({
        next: (updated) => {
          this.drawerSaving.set(false);
          this.drawerRecord.set({ kind: 'entity', record: updated });
          this.store.entities.update(list => list.map(e => e._id === id ? updated : e));
          this.lastSaved.set({ kind: 'entity', record: updated });
        },
        error: (err) => { this.drawerSaving.set(false); this.drawerError.set(fmtApiError(err, 'Failed to save')); },
      });
    } else if (dr.kind === 'edge') {
      const props = this.store.stripEmptyOptionalProps(this.drawerEditEdge.properties, this.store.edgeSchema(this.drawerEditEdge.label));
      this.brainApi.updateEdge(spaceId, id, {
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
          this.store.edges.update(list => list.map(e => e._id === id ? updated : e));
          this.lastSaved.set({ kind: 'edge', record: updated });
        },
        error: (err) => { this.drawerSaving.set(false); this.drawerError.set(fmtApiError(err, 'Failed to save')); },
      });
    } else if (dr.kind === 'chrono') {
      const resolvedKind = this.drawerEditChrono.kind as ChronoType;
      const chronoProps = this.store.stripEmptyOptionalProps(this.drawerEditChrono.properties, this.store.chronoSchema(resolvedKind));
      this.brainApi.updateChrono(spaceId, id, {
        title: this.drawerEditChrono.title.trim(),
        type: resolvedKind,
        status: this.drawerEditChrono.status as ChronoStatus,
        ...(this.drawerEditChrono.startsAt ? { startsAt: new Date(this.drawerEditChrono.startsAt).toISOString() } : {}),
        ...(this.drawerEditChrono.endsAt ? { endsAt: new Date(this.drawerEditChrono.endsAt).toISOString() } : {}),
        description: this.drawerEditChrono.description.trim(),
        tags: this.drawerEditChrono.tags,
        linkEntities: this.drawerEditChrono.linkEntities.split(',').map(s => s.trim()).filter(Boolean),
        ...(this.drawerEditChrono.linkFacts.length ? { linkFacts: this.drawerEditChrono.linkFacts } : {}),
        ...(this.drawerEditChrono.confidence != null ? { confidence: this.drawerEditChrono.confidence } : {}),
        ...(Object.keys(chronoProps).length ? { properties: chronoProps } : {}),
      }).subscribe({
        next: (updated) => {
          this.drawerSaving.set(false);
          this.drawerRecord.set({ kind: 'chrono', record: updated });
          this.store.chrono.update(list => list.map(c => c._id === id ? updated : c));
          this.lastSaved.set({ kind: 'chrono', record: updated });
        },
        error: (err) => { this.drawerSaving.set(false); this.drawerError.set(fmtApiError(err, 'Failed to save')); },
      });
    }
  }
}
