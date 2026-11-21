/**
 * How the types a schema file builds meet the type schemas a space already has (bundle-270, slice S8, Q-754; plan section 3 (g), Modes).
 *
 * ## What it prevents
 *
 * - **A write that loses work.** An import over a schema the owner edited must not clobber a type by hand: `generate` builds into a space with no
 *   type only (anything else is refused); `expand` adds the types and properties that are absent and leaves every stored value as it is, naming
 *   each value the file states that it does not apply; `update` replaces the stored values the file states and adds what is absent. None deletes
 *   a type, a property or a field: an absence in the file is no statement, so a stored field the file does not state stays.
 * - **A change nobody can see.** The answer lists every change as a row (added type, added property, added or changed field, with what it was
 *   and what it becomes), so a dry run shows what a write would do.
 * - **A stored schema edited in place.** The stored type schemas are an argument and never touched: the result is a copy.
 * - **A library reference edited field by field.** A stored type that is a `$ref` holds no fields of its own, so it is kept whole and what the
 *   file states of it is named.
 *
 * Pure.
 */
import { KNOWLEDGE_TYPES, type KnowledgeType } from '@ythril-network/schema';
import { sameValue } from './schema-from-rdf-drafts.js';
import type { Ledger, Place } from './schema-from-rdf-store.js';

/** The type schemas of a space by kind, as `meta.typeSchemas` holds them. */
export type TypeSchemasByKind = Record<KnowledgeType, Record<string, unknown>>;
export type StoredTypeSchemas = Partial<Record<KnowledgeType, Record<string, unknown> | undefined>>;
export type SchemaMode = 'generate' | 'expand' | 'update';

/** A type the file builds: its kind, name, and definition. */
export interface BuiltType { kind: KnowledgeType; name: string; def: Record<string, unknown> }

/** One change a write would make. */
export interface SchemaChange {
  change: 'add-type' | 'add-property' | 'add-field' | 'change-field';
  kind: KnowledgeType; type: string; prop?: string; field?: string; from?: unknown; to?: unknown;
  /** What the change was read from (Q-755): the OWL and RDFS declarations, the shapes, or the data (an inferred term). Set by the proposal. */
  source?: 'declared' | 'shacl' | 'data';
}

type Path = [string] | [string, string];
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (bag: Record<string, unknown>, key: string): unknown => (Object.hasOwn(bag, key) ? bag[key] : undefined);
const fieldName = (path: Path): string => path.join('.');
const GROUPED: ReadonlySet<string> = new Set(['retention', 'endpoints', 'rules']);

/** The fields of a type's own definition, flat: a group (retention, endpoints, rules) by its members; the properties are not fields of the type. */
function typeFields(def: Record<string, unknown>): Array<{ path: Path; value: unknown }> {
  const out: Array<{ path: Path; value: unknown }> = [];
  for (const key of Object.keys(def)) {
    if (key === 'propertySchemas') continue;
    const value = def[key];
    if (GROUPED.has(key) && isRecord(value)) for (const member of Object.keys(value)) out.push({ path: [key, member], value: value[member] });
    else out.push({ path: [key], value });
  }
  return out;
}

const propertyFields = (def: Record<string, unknown>): Array<{ path: Path; value: unknown }> => Object.keys(def).map(key => ({ path: [key] as Path, value: def[key] }));

function getAt(def: Record<string, unknown>, path: Path): unknown {
  const first = own(def, path[0]);
  if (path.length === 1) return first;
  return isRecord(first) ? own(first, path[1]) : undefined;
}

function setAt(def: Record<string, unknown>, path: Path, value: unknown): void {
  if (path.length === 1) { def[path[0]] = value; return; }
  const group = own(def, path[0]);
  const target = isRecord(group) ? group : {};
  target[path[1]] = value;
  def[path[0]] = target;
}

function emptyKinds(): TypeSchemasByKind {
  const out: Partial<TypeSchemasByKind> = {};
  for (const kind of KNOWLEDGE_TYPES) out[kind] = {};
  return out as TypeSchemasByKind;
}

/** A copy of stored type schemas with all four kinds present. */
export function normalizedStored(stored: StoredTypeSchemas | undefined): TypeSchemasByKind {
  const out = emptyKinds();
  for (const kind of KNOWLEDGE_TYPES) {
    const types = stored?.[kind];
    if (isRecord(types)) for (const name of Object.keys(types)) out[kind][name] = structuredClone(types[name]);
  }
  return out;
}

/** The first type the stored schemas hold, as `kind:name`, or `undefined` for a space with none. */
export function firstStoredType(stored: TypeSchemasByKind): string | undefined {
  for (const kind of KNOWLEDGE_TYPES) { const name = Object.keys(stored[kind])[0]; if (name !== undefined) return `${kind}:${name}`; }
  return undefined;
}

interface Apply { mode: 'expand' | 'update'; ledger: Ledger; changes: SchemaChange[] }

/** Meet the stored fields `fields` with the built ones: absent are added in `update`, differing are changed in `update`, and kept and named in `expand`. */
function meetFields(a: Apply, target: Record<string, unknown>, fields: Array<{ path: Path; value: unknown }>, where: Place, kind: KnowledgeType): void {
  for (const { path, value } of fields) {
    const field = fieldName(path);
    const was = getAt(target, path);
    if (was !== undefined && sameValue(field, was, value)) continue;
    if (a.mode === 'update') {
      setAt(target, path, value);
      a.changes.push({ change: was === undefined ? 'add-field' : 'change-field', kind, type: where.type, ...(where.prop === undefined ? {} : { prop: where.prop }), field, ...(was === undefined ? {} : { from: was }), to: value });
    } else {
      a.ledger.keepAsStored(where, field, was === undefined
        ? 'expand adds types and properties, not fields of one the space already has: the stored type keeps no value here'
        : 'expand keeps what the space already has: the stored value stands');
    }
  }
}

/** Add a whole built type to the result and list it. */
function addType(changes: SchemaChange[], into: TypeSchemasByKind, built: BuiltType): void {
  into[built.kind][built.name] = structuredClone(built.def);
  changes.push({ change: 'add-type', kind: built.kind, type: built.name });
  const props = own(built.def, 'propertySchemas');
  if (isRecord(props)) for (const prop of Object.keys(props)) changes.push({ change: 'add-property', kind: built.kind, type: built.name, prop });
}

/**
 * The type schemas a space would have, and the changes that make them, once `built` meets `stored`. `generate` is refused for a space with a
 * type (the caller has checked that and does not call this); `expand` and `update` as in the module's docblock. Pure: `stored` is copied.
 */
export function meetStored(mode: 'expand' | 'update', built: readonly BuiltType[], stored: StoredTypeSchemas | undefined, ledger: Ledger): { typeSchemas: TypeSchemasByKind; changes: SchemaChange[] } {
  const result = normalizedStored(stored);
  const a: Apply = { mode, ledger, changes: [] };
  for (const b of built) {
    const existing = own(result[b.kind], b.name);
    if (existing === undefined) { addType(a.changes, result, b); continue; }
    const where: Place = { kind: b.kind, type: b.name };
    if (!isRecord(existing) || own(existing, '$ref') !== undefined) {
      for (const { path } of typeFields(b.def)) ledger.keepAsStored(where, fieldName(path), 'a stored type that is a library reference holds no fields of its own: it is kept whole');
      const props = own(b.def, 'propertySchemas');
      if (isRecord(props)) for (const prop of Object.keys(props)) {
        const pdef = props[prop];
        if (isRecord(pdef)) for (const { path } of propertyFields(pdef)) ledger.keepAsStored({ ...where, prop }, fieldName(path), 'a stored type that is a library reference holds no properties of its own: it is kept whole');
      }
      continue;
    }
    meetFields(a, existing, typeFields(b.def), where, b.kind);
    const props = own(b.def, 'propertySchemas');
    if (!isRecord(props)) continue;
    for (const prop of Object.keys(props)) {
      const pdef = props[prop];
      if (!isRecord(pdef)) continue;
      const storedProps = own(existing, 'propertySchemas');
      const bag: Record<string, unknown> = isRecord(storedProps) ? storedProps : {};
      const was = own(bag, prop);
      if (was === undefined) {
        bag[prop] = structuredClone(pdef);
        existing['propertySchemas'] = bag;
        a.changes.push({ change: 'add-property', kind: b.kind, type: b.name, prop });
      } else if (isRecord(was)) {
        meetFields(a, was, propertyFields(pdef), { ...where, prop }, b.kind);
      }
    }
  }
  return { typeSchemas: result, changes: a.changes };
}

/** The built types as the answer's type schemas when the space has none: all of them, listed as additions. */
export function buildWhole(built: readonly BuiltType[]): { typeSchemas: TypeSchemasByKind; changes: SchemaChange[] } {
  const result = emptyKinds();
  const changes: SchemaChange[] = [];
  for (const b of built) addType(changes, result, b);
  return { typeSchemas: result, changes };
}
