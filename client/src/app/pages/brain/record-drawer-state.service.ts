import { Injectable, computed, inject, signal } from '@angular/core';
import type { Observable } from 'rxjs';
import { ChronoType, ChronoStatus, Fact, Entity, Edge, ChronoEntry, KnowledgeType } from '../../core/api.types';
import { BrainApi } from '../../core/brain-api.service';
import { httpErrorReason, type RefusalSource, type WireRow } from '../../core/refusal-text';
import { RetypeConfirmService } from '../../core/retype-confirm.service';
import { splitWriteWarnings } from '../../core/write-warnings';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { toLocalDatetime } from './brain-format';
import { isRetypeCancelled, saveWithRetype } from './retype-flow';

/**
 * State for the record detail drawer — one drawer edits ONE record (memory/entity/edge/chrono),
 * opened from every record tab.
 *
 * Extracted from BrainComponent (A17.9b-5). Owns the drawer's own signals (`drawerRecord`/`Saving`/
 * `Failure`/`Warnings`), its four plain edit models, and the open/save/close cycle. It consumes the already-split
 * collaborators — `BrainStore` (record lists + schema helpers), `EntityRefPicker` (chip name
 * resolution), `BrainApi` (persistence) — and the pure `brain-format` utils.
 *
 * `spaceId` is fed by the shell (its `activeSpaceId` is nav state), mirroring `EntityRefPicker`.
 *
 * The plain edit models render under OnPush only because `open()` writes the `drawerRecord` SIGNAL in
 * the same turn — that coupling is load-bearing and pinned by the drawer component's spec.
 *
 * ## What a save answers (bundle-23, Q-93)
 *
 * The drawer holds what the last save ANSWERED, as data: `drawerFailure` is the refused answer itself (the component that shows
 * it has the translation service and words it, and marks the property rows it names) and `drawerWarnings` the `warnings` of a
 * save that succeeded, kept until the next save replaces them. Every save goes through `saveWithRetype`, so a type change a strict
 * space refuses for the keys it would leave behind can be confirmed and sent again with those keys removed.
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

type Props = Record<string, string | number | boolean>;

@Injectable()
export class RecordDrawerState {
  private brainApi = inject(BrainApi);
  private store = inject(BrainStore);
  private picker = inject(EntityRefPicker);
  private retype = inject(RetypeConfirmService);

  /** Active brain space. Kept in sync by the shell, whose `activeSpaceId` is nav state. */
  readonly spaceId = signal('');

  drawerRecord = signal<DrawerRecord | null>(null);
  drawerSaving = signal(false);
  /** The refused answer of the last save, as the request gave it; null when the last save did not fail. */
  readonly drawerFailure = signal<RefusalSource | null>(null);
  /** The same failure as a plain, untranslated sentence ('' when there is none): for a host that wants a string and not rows. */
  readonly drawerError = computed(() => {
    const failure = this.drawerFailure();
    return failure ? httpErrorReason(failure) || String(failure.status ?? '') || 'error' : '';
  });
  /** The `warnings` of the last successful save: shown until the next save replaces them or the reader dismisses them. */
  readonly drawerWarnings = signal<WireRow[]>([]);
  /** The save's warnings were cut by the server (`warningsTruncated`): the notice says rows were left out. */
  readonly drawerWarningsTruncated = signal(false);

  /** The keys the record STORED when it was opened or last saved: what a type change must never treat as an untouched seed. */
  private stored: ReadonlySet<string> = new Set();

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

  drawerEditMemory = { fact: '', type: '', tags: [] as string[], linkEntities: '', description: '', properties: {} as Props };
  drawerEditEntity = { name: '', type: '', tags: [] as string[], description: '', properties: {} as Props };
  drawerEditEdge = { label: '', type: '', weight: null as number | null, tags: [] as string[], description: '', properties: {} as Props };
  drawerEditChrono = { title: '', kind: 'event' as string, status: 'upcoming' as string, startsAt: '', endsAt: '', description: '', tags: [] as string[], linkEntities: '', confidence: null as number | null, linkFacts: [] as string[], properties: {} as Props };

  /** A memory's type changed (the type is a free choice, so it may also be cleared): re-seed from the new type's schema. */
  onMemoryTypeChange(type: string): void {
    const from = this.drawerEditMemory.type;
    this.drawerEditMemory.type = type;
    this.drawerEditMemory.properties = this.store.retypeProperties('fact', this.drawerEditMemory.properties, from, type, this.stored);
  }

  /** A drawer entity's type changed: the old type's untouched seeds go, the new type's are added (mirrors the create/inline forms). */
  onEntityTypeChange(type: string): void {
    const from = this.drawerEditEntity.type;
    this.drawerEditEntity.type = type;
    this.drawerEditEntity.properties = this.store.retypeProperties('entity', this.drawerEditEntity.properties, from, type, this.stored);
  }

  /** A drawer edge's relation changed: an edge's properties belong to its label, so they follow it. */
  onEdgeLabelChange(label: string): void {
    const from = this.drawerEditEdge.label;
    this.drawerEditEdge.label = label;
    this.drawerEditEdge.properties = this.store.retypeProperties('edge', this.drawerEditEdge.properties, from, label, this.stored);
  }

  /** Effective chrono type for schema lookup. */
  drawerChronoKind(): string {
    return this.drawerEditChrono.kind;
  }

  /** A drawer chrono's kind changed (mirrors the create/inline forms). */
  onChronoKindChange(kind: string): void {
    const from = this.drawerEditChrono.kind;
    this.drawerEditChrono.kind = kind;
    this.drawerEditChrono.properties = this.store.retypeProperties('chrono', this.drawerEditChrono.properties, from, kind, this.stored);
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
    this.drawerFailure.set(null);
    this.dismissWarnings();
    this.drawerSaving.set(false);
    this.stored = new Set(Object.keys(record.properties ?? {}));
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
        // A memory is seeded from ITS OWN type, and none at all while it has none.
        properties: this.store.buildPropertiesObject('fact', r.properties ?? {}, r.type),
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
    this.drawerFailure.set(null);
    this.dismissWarnings();
  }

  /** The reader closed the warnings notice. */
  dismissWarnings(): void {
    this.drawerWarnings.set([]);
    this.drawerWarningsTruncated.set(false);
  }

  save(): void {
    const dr = this.drawerRecord();
    if (!dr) return;
    this.drawerSaving.set(true);
    this.drawerFailure.set(null);
    const id = dr.record._id;
    const spaceId = this.spaceId();
    if (dr.kind === 'fact') {
      const props = this.drawerEditMemory.properties;
      const body: Parameters<BrainApi['updateFact']>[2] = {
        fact: this.drawerEditMemory.fact.trim(),
        // Trimmed, and sent even when empty: on an UPDATE an absent field means "leave it alone", so clearing the
        // box has to reach the API as an explicit empty value or the type could be set and never unset.
        type: this.drawerEditMemory.type.trim(),
        tags: this.drawerEditMemory.tags,
        linkEntities: this.drawerEditMemory.linkEntities.split(',').map(s => s.trim()).filter(Boolean),
        description: this.drawerEditMemory.description.trim(),
        ...(Object.keys(props).length ? { properties: props } : {}),
      };
      this.persist(saveWithRetype(this.retype, b => this.brainApi.updateFact(spaceId, id, b), body, body.type !== (dr.record.type ?? '')), dr, updated => {
        this.drawerRecord.set({ kind: 'fact', record: updated });
        this.store.facts.update(list => list.map(m => m._id === id ? updated : m));
        this.lastSaved.set({ kind: 'fact', record: updated });
      });
    } else if (dr.kind === 'entity') {
      const props = this.store.stripEmptyOptionalProps(this.drawerEditEntity.properties, this.store.entitySchema(this.drawerEditEntity.type));
      const body: Parameters<BrainApi['updateEntity']>[2] = {
        name: this.drawerEditEntity.name.trim(),
        type: this.drawerEditEntity.type.trim(),
        tags: this.drawerEditEntity.tags,
        description: this.drawerEditEntity.description.trim(),
        ...(Object.keys(props).length ? { properties: props } : {}),
      };
      this.persist(saveWithRetype(this.retype, b => this.brainApi.updateEntity(spaceId, id, b), body, body.type !== (dr.record.type ?? '')), dr, updated => {
        this.drawerRecord.set({ kind: 'entity', record: updated });
        this.store.entities.update(list => list.map(e => e._id === id ? updated : e));
        this.lastSaved.set({ kind: 'entity', record: updated });
      });
    } else if (dr.kind === 'edge') {
      const props = this.store.stripEmptyOptionalProps(this.drawerEditEdge.properties, this.store.edgeSchema(this.drawerEditEdge.label));
      const body: Parameters<BrainApi['updateEdge']>[2] = {
        label: this.drawerEditEdge.label.trim(),
        ...(this.drawerEditEdge.type.trim() ? { type: this.drawerEditEdge.type.trim() } : {}),
        ...(this.drawerEditEdge.weight != null ? { weight: this.drawerEditEdge.weight } : {}),
        tags: this.drawerEditEdge.tags,
        description: this.drawerEditEdge.description.trim(),
        ...(Object.keys(props).length ? { properties: props } : {}),
      };
      this.persist(saveWithRetype(this.retype, b => this.brainApi.updateEdge(spaceId, id, b), body, body.label !== dr.record.label), dr, updated => {
        this.drawerRecord.set({ kind: 'edge', record: updated });
        this.store.edges.update(list => list.map(e => e._id === id ? updated : e));
        this.lastSaved.set({ kind: 'edge', record: updated });
      });
    } else if (dr.kind === 'chrono') {
      const resolvedKind = this.drawerEditChrono.kind as ChronoType;
      const chronoProps = this.store.stripEmptyOptionalProps(this.drawerEditChrono.properties, this.store.chronoSchema(resolvedKind));
      const body: Parameters<BrainApi['updateChrono']>[2] = {
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
      };
      this.persist(saveWithRetype(this.retype, b => this.brainApi.updateChrono(spaceId, id, b), body, body.type !== dr.record.type), dr, updated => {
        this.drawerRecord.set({ kind: 'chrono', record: updated });
        this.store.chrono.update(list => list.map(c => c._id === id ? updated : c));
        this.lastSaved.set({ kind: 'chrono', record: updated });
      });
    }
  }

  /**
   * One save's outcome, the same for all four kinds: a saved record is split from its `warnings` (which the notice keeps), a
   * refusal is held as it was answered, and a type change the person declined puts the type control back.
   */
  private persist<T extends Fact | Entity | Edge | ChronoEntry>(save: Observable<T>, was: DrawerRecord, onSaved: (record: T) => void): void {
    save.subscribe({
      next: answer => {
        const { record, warnings, truncated } = splitWriteWarnings(answer);
        this.drawerSaving.set(false);
        this.drawerWarnings.set(warnings);
        this.drawerWarningsTruncated.set(truncated);
        // Its keys are stored now: a later type change must not take them for seeds.
        this.stored = new Set(Object.keys(record.properties ?? {}));
        onSaved(record);
      },
      error: err => {
        this.drawerSaving.set(false);
        if (isRetypeCancelled(err)) { this.restoreType(was); return; }
        this.drawerFailure.set(err);
      },
    });
  }

  /** Declining the removal puts the type control back to the record's own and re-seeds the properties for it: nothing was sent, nothing is lost. */
  private restoreType(was: DrawerRecord): void {
    if (was.kind === 'fact') this.onMemoryTypeChange(was.record.type ?? '');
    else if (was.kind === 'entity') this.onEntityTypeChange(was.record.type ?? '');
    else if (was.kind === 'edge') this.onEdgeLabelChange(was.record.label);
    else this.onChronoKindChange(was.record.type);
  }
}
