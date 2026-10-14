import { Injectable, signal, computed } from '@angular/core';
import {
  Fact, Entity, Edge, ChronoEntry, FileMeta, SpaceMetaResponse, PropertySchema,
  KnowledgeType, ChronoType, ChronoStatus,
} from '../../core/api.types';

/** The value a new record's property row starts with, from its declared schema: enum -> first option, number -> 0, boolean -> false, else ''. */
function seedValue(schema: PropertySchema): string | number | boolean {
  if (schema.enum?.length) return schema.enum[0] as string | number | boolean;
  if (schema.type === 'number') return 0;
  if (schema.type === 'boolean') return false;
  return '';
}

/**
 * Records for the active brain space, and the client-side view of them.
 *
 * Extracted from the 3701-line BrainComponent (A17.9b). Owns the five record lists, the space meta,
 * the per-collection top-bar search text, and everything derived from them: the `*TagSuggestions` and
 * the schema-backed `*TypeOptions`.
 *
 * What is NOT here (stays with the component, moves to its own owner in a later step): the shell's
 * navigation (space list, activeTab, activeSpaceId), the loaders that populate these signals, the
 * create/edit forms per tab, the query/recall tab state, and the record drawer.
 *
 * Search shape (post 4c-i): every record tab filters SERVER-SIDE — memories/edges/chrono have a
 * semantic top bar plus a docked column freetext filter; file-meta has a docked column freetext filter
 * (its top bar / semantic recall is a later slice). No client-side `filtered*` views remain; templates
 * bind `store.<collection>()` directly.
 *
 * Provided by BrainComponent (not root): one instance per mounted page.
 */
@Injectable()
export class BrainStore {
  // ── Records loaded for the active space ─────────────────────────────────────
  facts = signal<Fact[]>([]);
  entities = signal<Entity[]>([]);
  edges = signal<Edge[]>([]);
  chrono = signal<ChronoEntry[]>([]);
  fileMetas = signal<FileMeta[]>([]);
  // Settings tab (schema only — UI lives in Admin → Spaces)
  spaceMeta = signal<SpaceMetaResponse | null>(null);
  /** Live-update tick (F12): the shell bumps this when a brain-change SSE event lands for the active
   *  space+collection, and the mounted record tab reloads its current page in response. */
  liveRefreshTick = signal(0);
  // The record tabs' TOP-BAR search text. For memories/edges/chrono this is a SEMANTIC recall query
  // (2b-iii-c demoted the old A–Z text mode into the docked column freetext filter). For file-meta,
  // `fileMetaSearch` is now just the shell→tab DEEP-LINK seed: the Files-tab "open in File Meta" action
  // writes the file's path here, and the File Meta tab reads it into its docked Path-column freetext
  // filter on open (4c-i). File-meta has no semantic top bar yet (4c-ii).
  memorySearch = signal('');
  edgeSearch = signal('');
  chronoSearch = signal('');
  fileMetaSearch = signal('');

  // ── Tag suggestions + filtered views (per collection) ───────────────────────
  //
  // Sourced from the tags ALREADY IN USE in this collection. The space-level
  // `meta.tagSuggestions` list used to be merged in as well; it was retired because it was
  // editable in one place, applied everywhere, and easy to forget about — a stored list quietly
  // steering what agents and people tagged with. What is actually in use is self-maintaining and
  // needs no editor.
  memoryTagSuggestions = computed(() => [...new Set([
    ...this.facts().flatMap(m => m.tags ?? []),
  ])]);

  entityTagSuggestions = computed(() => [...new Set([
    ...this.entities().flatMap(e => e.tags ?? []),
  ])]);

  edgeTagSuggestions = computed(() => [...new Set([
    ...this.edges().flatMap(e => e.tags ?? []),
  ])]);

  chronoTagSuggestions = computed(() => [...new Set([
    ...this.chrono().flatMap(c => c.tags ?? []),
  ])]);

  // No client-side `filtered*` views remain: every record tab now filters server-side (semantic top bar
  // for memories/edges/chrono; docked column freetext for all four, incl. file-meta since 4c-i). The
  // templates bind `store.<collection>()` directly.

  // ── Schema-derived accessors + filter-bar type options ──────────────────────
  entityTypeNames(): string[] {
    return Object.keys(this.spaceMeta()?.typeSchemas?.entity ?? {});
  }

  edgeLabelNames(): string[] {
    return Object.keys(this.spaceMeta()?.typeSchemas?.edge ?? {});
  }

  entitySchema(typeName: string | undefined): Record<string, PropertySchema> | undefined {
    return this.schemaFor('entity', typeName);
  }

  edgeSchema(labelName: string | undefined): Record<string, PropertySchema> | undefined {
    return this.schemaFor('edge', labelName);
  }

  /**
   * The property schemas of the memory type `typeName` - ITS OWN, as the other three kinds do.
   *
   * It used to answer the FIRST declared fact type's schema whatever the memory's type, so a `decision` memory was edited, seeded and
   * marked against the schema of whichever type happened to be declared first. A typeless memory, and a type the space does not
   * declare, have no schema (undefined): an open record.
   */
  memorySchema(typeName?: string): Record<string, PropertySchema> | undefined {
    if (!typeName) return undefined;
    return this.spaceMeta()?.typeSchemas?.fact?.[typeName]?.propertySchemas;
  }

  /** Property schema for a chrono type (kind or custom-kind name); undefined when none is defined. */
  chronoSchema(typeName: string | undefined): Record<string, PropertySchema> | undefined {
    if (!typeName) return undefined;
    return this.spaceMeta()?.typeSchemas?.chrono?.[typeName]?.propertySchemas;
  }

  requiredProps(schema: Record<string, PropertySchema> | undefined): string[] {
    if (!schema) return [];
    return Object.entries(schema).filter(([, s]) => s.required).map(([k]) => k);
  }

  /** Type options for the filter bar's dropdown, per collection: the space's schema
   *  type names UNION the distinct `type` values actually present in the loaded list,
   *  so the filter is usable whether or not a schema is defined. */
  private typeOptionsFrom(schemaNames: string[], present: (string | undefined)[]): string[] {
    return [...new Set([...schemaNames, ...present.filter((t): t is string => !!t)])].sort();
  }

  /**
   * Does this space RESTRICT memory types? The client's mirror of `validateMemory`'s allowlist branch.
   *
   * The rule is the one every other record kind uses and facts gained on 2026-08-30 (P-24 = A): declaring
   * one or more `typeSchemas.fact` entries makes those names the allowed set. Declaring none constrains
   * nothing, which is why this is a question rather than a constant — a space that never asked to restrict
   * memory types must keep accepting any string, and the create form must keep letting one be typed.
   */
  memoryTypesAreRestricted(): boolean {
    return Object.keys(this.spaceMeta()?.typeSchemas?.fact ?? {}).length > 0;
  }

  /** Types a memory write is ACCEPTED with — declared names where the space declares any, else unrestricted. */
  memoryAllowedTypes(): string[] {
    return Object.keys(this.spaceMeta()?.typeSchemas?.fact ?? {}).slice().sort();
  }

  /** Filter options: allowed types UNION whatever the loaded rows hold, so a record written before a schema
   *  change stays reachable in the filter even though its type is no longer writable. */
  memoryTypeOptions(): string[] {
    return this.typeOptionsFrom(Object.keys(this.spaceMeta()?.typeSchemas?.fact ?? {}), this.facts().map(m => m.type));
  }

  entityTypeOptions(): string[] {
    return this.typeOptionsFrom(this.entityTypeNames(), this.entities().map(e => e.type));
  }

  edgeTypeOptions(): string[] {
    // Edge `type` is not schema-backed; offer the distinct types in the current list.
    return this.typeOptionsFrom([], this.edges().map(e => e.type));
  }

  /** Types a chrono write is ACCEPTED with — the client's mirror of `getAllowedChronoTypes`
   *  (server/src/spaces/schema-validation.ts). That rule is EXCLUSIVE, not additive: a space that
   *  declares `typeSchemas.chrono` allows those names and ONLY those, and 400s on the built-ins.
   *  Offering the built-ins unconditionally is why the create form could not save in such a space. */
  chronoAllowedTypes(): string[] {
    const declared = Object.keys(this.spaceMeta()?.typeSchemas?.chrono ?? {});
    return declared.length > 0 ? declared.slice().sort() : [...this.chronoKinds];
  }

  /** Filter options: the allowed types UNION whatever the loaded rows actually hold, so a record
   *  written before a schema change stays reachable even though its type is no longer writable. */
  chronoTypeOptions(): string[] {
    return this.typeOptionsFrom(this.chronoAllowedTypes(), this.chrono().map(c => c.type));
  }

  // ── Schema-driven property helpers (shared by every create/edit form + the drawer) ──

  /** The five built-in chrono types — the FALLBACK allowlist, used only by a space that declares no
   *  `typeSchemas.chrono` of its own. Never bind this in a template: it is the fallback, not the
   *  answer. Forms bind `chronoAllowedTypes()`, the filter binds `chronoTypeOptions()`. */
  readonly chronoKinds: ChronoType[] = ['event', 'deadline', 'plan', 'prediction', 'milestone'];

  /** The chrono lifecycle statuses. */
  readonly chronoStatusOptions: ChronoStatus[] = ['upcoming', 'active', 'completed', 'overdue', 'cancelled'];

  /** Seed a properties object from a type's schema: fill missing keys with a typed default
   *  (enum → first option, number → 0, boolean → false, else ''), preserving existing values. */
  buildPropertiesObject(type: KnowledgeType, existing: Record<string, string | number | boolean> = {}, typeName?: string): Record<string, string | number | boolean> {
    const meta = this.spaceMeta();
    const typeSchemas = meta?.typeSchemas?.[type];
    if (!typeSchemas || Object.keys(typeSchemas).length === 0) return existing;
    // Use the specified type's schema. With no name given a form that has no type yet is pre-filled from the first declared
    // type - except a memory, which has no "first": it is typeless until the person picks one, and seeds nothing.
    const schemas = (typeName ? typeSchemas[typeName] : type === 'fact' ? undefined : Object.values(typeSchemas)[0])?.propertySchemas ?? {};
    if (Object.keys(schemas).length === 0) return existing;
    const result = { ...existing };
    for (const [key, schema] of Object.entries(schemas)) {
      if (key in result) continue;
      result[key] = seedValue(schema);
    }
    return result;
  }

  /**
   * The properties of a record after its type changed from `fromType` to `toType`: what was only SEEDED from the old type and never
   * touched is dropped, the new type's seeds are added, and everything else stays (bundle-23, Q-93).
   *
   * One question, asked by every surface that changes a record's type (the four tabs' create forms and inline rows and the
   * drawer's four kinds): without it the next save carries the old type's seeds, which the new type does not declare, and a
   * strict space refuses it with a list of keys the person never typed. What counts as untouched is exact: the key is declared by
   * the OLD type, its value is still the value that type would have seeded, and the record did not STORE it (`storedKeys`) - a
   * stored key is data, even when its value happens to equal the old default, and a value the person edited is theirs. Whatever
   * stays and the new type does not declare is shown marked "not declared" by the properties editor, never silently dropped.
   */
  retypeProperties(
    type: KnowledgeType,
    current: Record<string, string | number | boolean>,
    fromType: string | undefined,
    toType: string | undefined,
    storedKeys: ReadonlySet<string> = new Set(),
  ): Record<string, string | number | boolean> {
    const from = this.schemaFor(type, fromType);
    const kept: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(current)) {
      const untouchedSeed = !!from && Object.hasOwn(from, key) && !storedKeys.has(key) && value === seedValue(from[key]);
      if (!untouchedSeed) kept[key] = value;
    }
    return this.buildPropertiesObject(type, kept, toType);
  }

  /** The property schemas of one type of a kind (an edge is keyed by its label, a chrono entry by its type); undefined when there are none. */
  schemaFor(type: KnowledgeType, typeName: string | undefined): Record<string, PropertySchema> | undefined {
    if (!typeName) return undefined;
    return this.spaceMeta()?.typeSchemas?.[type]?.[typeName]?.propertySchemas;
  }

  /** Strip optional properties whose value is an empty string; required fields are preserved even if empty (server will reject them with a clear error). */
  stripEmptyOptionalProps(
    props: Record<string, string | number | boolean>,
    schema: Record<string, PropertySchema> | undefined,
  ): Record<string, string | number | boolean> {
    if (!schema) return props;
    return Object.fromEntries(
      Object.entries(props).filter(([k, v]) => v !== '' || (schema[k]?.required ?? false)),
    );
  }
}
