/**
 * How the history dialog's "What changed" table says a change: a place as the property it is about, a value as words.
 *
 * What it prevents: the table printing the diff's own wire spelling (`propertySchemas.size`, `{"type":"number"}`, `true`) to a person
 * who never saw the schema's JSON. The server answers each change with a `place` relative to its type and the raw `from` / `to`;
 * this is the one place those become the sentence the mockup draws (`email: required`, `no`, `string, pattern 0000-0000-0000-000X`),
 * so no second reader words them differently.
 *
 * Pure: it takes `say`, a translator (key, params to text), and returns text only. The caller binds the text, never markup, so a value
 * a member's schema carries (a pattern, a description) can never become a tag or an attribute.
 *
 * A value this module has no words for is shown as compact JSON, never dropped: a definition property with a facet that is itself an
 * object stays whole, because words for half of it would hide the rest.
 */

/** A translator: a key and its parameters to the text. */
export type Say = (key: string, params?: Record<string, string>) => string;

const PROPERTY_PREFIX = 'propertySchemas.';

/** A place that is exactly one property: `propertySchemas.<name>`, nothing deeper. */
const isPropertyPlace = (place: string): boolean => place.startsWith(PROPERTY_PREFIX) && place.length > PROPERTY_PREFIX.length && !place.slice(PROPERTY_PREFIX.length).includes('.');

/**
 * The label of a place: a place under `propertySchemas.` is the property's name, and `name: key` when a deeper key follows;
 * any other place as it is; the empty place (the whole type) the words for "The whole definition".
 */
export function changePlaceWords(place: string, say: Say): string {
  if (place === '') return say('spaces.schema.history.wholeDefinition');
  if (!place.startsWith(PROPERTY_PREFIX) || place.length === PROPERTY_PREFIX.length) return place;
  const rest = place.slice(PROPERTY_PREFIX.length);
  const dot = rest.indexOf('.');
  return dot < 0 ? rest : `${rest.slice(0, dot)}: ${rest.slice(dot + 1)}`;
}

const isPlain = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A plain value: yes / no for a boolean, a string or number as it is. */
function plainWords(v: string | number | boolean, say: Say): string {
  if (typeof v === 'boolean') return say(v ? 'common.yes' : 'common.no').toLocaleLowerCase();
  return String(v);
}

/** One facet of a property definition in words, or null when it is no plain value (the caller then keeps the whole value as JSON). */
function facetWords(key: string, v: unknown, say: Say): string | null {
  if (key === 'required' && v === true) return say('spaces.schema.history.facet.required');
  if (key === 'pattern' && typeof v === 'string') return say('spaces.schema.history.facet.pattern', { value: v });
  if (typeof v === 'boolean') return v ? key : say('spaces.schema.history.facet.not', { facet: key });
  if (typeof v === 'string' || typeof v === 'number') return `${key} ${v}`;
  if (Array.isArray(v) && v.length > 0 && v.every(isPlain)) return `${key} (${v.map(x => plainWords(x, say)).join(', ')})`;
  return null;
}

/** A property definition as its type, then its other plain facets; null when it has no string type or a facet is not plain. */
function propertyWords(def: Record<string, unknown>, say: Say): string | null {
  if (typeof def['type'] !== 'string') return null;
  const parts = [def['type']];
  for (const [k, v] of Object.entries(def)) {
    if (k === 'type') continue;
    const w = facetWords(k, v, say);
    if (w === null) return null;
    parts.push(w);
  }
  return parts.join(', ');
}

/**
 * One side of a change in words. `place` says what the value is: an object at exactly a property is a definition, read as its type
 * and facets. An absent side (undefined) reads "not declared".
 */
export function changeValueWords(v: unknown, place: string, say: Say): string {
  if (v === undefined) return say('propertiesEditor.notDeclared');
  if (isPlain(v)) return plainWords(v, say);
  if (Array.isArray(v) && v.length > 0 && v.every(isPlain)) return v.map(x => plainWords(x, say)).join(', ');
  if (isRecord(v) && isPropertyPlace(place)) {
    const w = propertyWords(v, say);
    if (w !== null) return w;
  }
  return JSON.stringify(v);
}
