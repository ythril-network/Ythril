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

/** Where the words of a place and of a facet live: `<key>.<name>` in each language's file. */
const PLACE_KEY = 'spaces.schema.history.place';
const FACET_KEY = 'spaces.schema.history.facet';

/**
 * Every facet a property definition can carry (`PropertySchema` in `schema/src/vocabulary.ts`) and every place a type has above its
 * properties (`TypeSchema`, and the keys of its `retention` and `endpoints`). A name the schema gains and this list lacks prints raw,
 * as a newer server's facet must; `type-change-words.schema.spec.ts` fails until the name is here and has words.
 */
const PROPERTY_FACETS: ReadonlySet<string> = new Set(['description', 'type', 'enum', 'minimum', 'maximum', 'pattern', 'mergeFn', 'required', 'default']);
const TYPE_PLACES: ReadonlySet<string> = new Set([
  'description', 'namingPattern', 'retention', 'retention.days', 'retention.contentDays', 'suppressEmbeddings', 'whenDuePasses',
  'endpoints', 'endpoints.from', 'endpoints.to', 'functional',
]);
/** A type's rule is a place of its own per name: `rules.<name>`, and its `rule` or `message` (a name is `[a-z][a-zA-Z0-9_-]*`, never a dot). */
const RULE_PLACE = /^rules\.([^.]+)(?:\.(rule|message))?$/;
/** The facets whose value is a plain value the words put in a sentence of their own (`required` and `enum` have their own shapes). */
const VALUE_FACETS: ReadonlySet<string> = new Set(['description', 'minimum', 'maximum', 'pattern', 'mergeFn', 'default']);

/** A place that is exactly one property: `propertySchemas.<name>`, nothing deeper. */
const isPropertyPlace = (place: string): boolean => place.startsWith(PROPERTY_PREFIX) && place.length > PROPERTY_PREFIX.length && !place.slice(PROPERTY_PREFIX.length).includes('.');

/**
 * The label of a place: a place under `propertySchemas.` is the property's name, and `name: key` when a deeper key follows;
 * any other place as it is; the empty place (the whole type) the words for "The whole definition".
 */
export function changePlaceWords(place: string, say: Say): string {
  if (place === '') return say('spaces.schema.history.wholeDefinition');
  if (place.startsWith(PROPERTY_PREFIX) && place.length > PROPERTY_PREFIX.length) {
    const rest = place.slice(PROPERTY_PREFIX.length);
    const dot = rest.indexOf('.');
    if (dot < 0) return rest;
    const facet = rest.slice(dot + 1);
    return `${rest.slice(0, dot)}: ${PROPERTY_FACETS.has(facet) ? say(`${PLACE_KEY}.property.${facet}`) : facet}`;
  }
  if (TYPE_PLACES.has(place)) return say(`${PLACE_KEY}.${place}`);
  const rule = RULE_PLACE.exec(place);
  if (rule) return say(`${PLACE_KEY}.rules${rule[2] ? `.${rule[2]}` : ''}`, { name: rule[1]! });
  return place;
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
  if (key === 'required' && typeof v === 'boolean') {
    const word = say(`${FACET_KEY}.required`);
    return v ? word : say(`${FACET_KEY}.not`, { facet: word });
  }
  if (VALUE_FACETS.has(key) && isPlain(v)) return say(`${FACET_KEY}.${key}`, { value: plainWords(v, say) });
  if (key === 'enum' && Array.isArray(v) && v.length > 0 && v.every(isPlain)) return say(`${FACET_KEY}.enum`, { value: v.map(x => plainWords(x, say)).join(', ') });
  // A facet this client has no words for (a newer server's, or a known one with a value of another shape) is shown as it is written.
  if (typeof v === 'boolean') return v ? key : say(`${FACET_KEY}.not`, { facet: key });
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
