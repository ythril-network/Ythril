/**
 * The per-type schema edits, as pure operations over one `TypeSchemaState`.
 *
 * ## Why they left the service
 *
 * These lived on `SpaceSettingsState` and reached into its own `schTypeSchemas` map to find the type they
 * were editing. That made them unusable anywhere else — and "anywhere else" is now a real requirement: the
 * Brain Overview's data-model panel opens the SAME per-type editor in place, rather than sending an operator
 * off to Space Settings to make a one-field change.
 *
 * `SpaceSettingsState` is `@Injectable()` with no `providedIn`, so it is provided by the settings page and
 * the Brain page cannot inject it. Making it root-provided would turn per-space editing state into a
 * cross-page singleton, which is a worse problem than the one being solved.
 *
 * So the editing logic operates on a state object it is handed. The service keeps its map and delegates;
 * the dialog keeps a draft and delegates to the same functions. One implementation, two callers, and no
 * service dragged across the app.
 *
 * ## What is deliberately NOT here
 *
 * **Persistence.** The two callers save differently and must keep doing so: Space Settings is STAGED — edit
 * several types, then Save — while the Overview panel is IMMEDIATE, editing one type and writing it now.
 * Pushing a save into these functions would force one of those hosts to adopt the other's model.
 *
 * **Expansion state.** Which property rows are open is a property of a VIEW, not of the schema, and the two
 * hosts disagree about it: the settings tab keeps a set across every type it has open, and a modal editing
 * one type does not need one at all. The service keeps its own set and calls these for the data half.
 */
import type { PropertySchema } from '../../core/api.types';
import type { TypeSchemaState } from './space-settings-state.service';

/** A property key that is blank, or already taken, is not an edit — it is a typo. */
export function canAddProp(state: TypeSchemaState): string | null {
  const key = (state._newPropInput ?? '').trim();
  if (!key) return null;
  if (state.propertySchemas.some(e => e.key === key)) return null;
  return key;
}

/**
 * Append the pending property.
 *
 * Returns the key that was added, or `null` when nothing was — the caller needs to know, because the
 * settings tab also expands the new row and cannot do that for a key that was never created.
 *
 * Mutates in place because the callers hold this object directly and Angular's change detection here is
 * driven by the containing signal, not by identity of this leaf.
 */
export function addProp(state: TypeSchemaState): string | null {
  const key = canAddProp(state);
  // The input is cleared either way. Leaving a rejected duplicate sitting in the box reads as "the button
  // did nothing", which is the report we would get.
  state._newPropInput = '';
  if (!key) return null;
  state.propertySchemas = [...state.propertySchemas, { key, s: {}, _enumInput: '' }];
  return key;
}

export function removeProp(state: TypeSchemaState, propKey: string): void {
  state.propertySchemas = state.propertySchemas.filter(e => e.key !== propKey);
}

/**
 * Add the pending enum value to one property.
 *
 * Compared by `String(v)` rather than by value: the input is text, and a stored `4` and a typed `"4"` are
 * the same allowed value to anyone reading the list. Comparing strictly would let the list grow a visually
 * duplicated entry that no record could ever satisfy twice.
 */
export function addEnumVal(state: TypeSchemaState, propKey: string): void {
  const entry = state.propertySchemas.find(e => e.key === propKey);
  if (!entry) return;
  const val = (entry._enumInput ?? '').trim();
  if (!val) return;
  const curr: NonNullable<PropertySchema['enum']> = entry.s.enum ?? [];
  if (!curr.some(v => String(v) === val)) entry.s = { ...entry.s, enum: [...curr, val] };
  entry._enumInput = '';
}

export function removeEnumVal(state: TypeSchemaState, propKey: string, val: string | number | boolean): void {
  const entry = state.propertySchemas.find(e => e.key === propKey);
  if (!entry) return;
  entry.s = { ...entry.s, enum: (entry.s.enum ?? []).filter(v => v !== val) };
}

// ── An edge label's permitted ends, and its cardinality (G-12) ──────────────────────────────────────────────
//
// Two fields the API has accepted since S-1 and that no control could set. They are here rather than in the
// component for the reason the whole module exists: the settings tab and the Brain Overview open the same
// editor, and a rule written in one of them is a rule the other one gets wrong.

/** Which end of the edge a list constrains. */
export type EndpointSide = 'from' | 'to';

/** The explicit "an entity with no type at all" member, spelled as the API spells it. */
export const UNTYPED_END = 'UNTYPED';

/** The names currently permitted at one end, or an empty array when the end is unrestricted. */
export function endpointsFor(state: TypeSchemaState, side: EndpointSide): string[] {
  return state.endpoints?.[side] ?? [];
}

/**
 * True when this end permits ANY entity type — which is the absence of a list, not an empty one.
 *
 * The difference is the whole control. `endpoints.from` absent means any type may be the source;
 * `endpoints.from: []` is refused by the API and, were it not, would forbid every edge of the label. So an
 * operator clearing the last checkbox has to land on "any", and `toggleEndpoint` is what guarantees it.
 */
export function isAnyEnd(state: TypeSchemaState, side: EndpointSide): boolean {
  return endpointsFor(state, side).length === 0;
}

/**
 * The names an ends picker must OFFER: the vocabulary, plus whatever is already picked.
 *
 * Owner-reported, `B-16`: the picker listed the entity types the space CURRENTLY declares, so deleting
 * a type that an edge named as an end left the stored name with no checkbox — nothing to untick, still
 * enforced, and invisible on a control that looked complete. The declaration became permanent.
 *
 * **The shape recurs wherever a picker's OPTIONS come from a vocabulary and its VALUES come from a
 * record.** Those are different sets, and rendering only the first hides the difference rather than
 * reporting it. Here rather than in the component so it can be tested without a fixture — and because
 * the union is a rule about the data, not about the view.
 *
 * `UNTYPED_END` is appended last: it is a real choice ("an entity carrying no type at all") but the
 * unusual one, and at the top of a list it reads as a header or as the default.
 */
export function endNamesFor(declared: readonly string[], state: TypeSchemaState): string[] {
  const picked = [...endpointsFor(state, 'from'), ...endpointsFor(state, 'to')].filter(n => n !== UNTYPED_END);
  return [...new Set([...declared, ...picked])].sort((a, b) => a.localeCompare(b)).concat(UNTYPED_END);
}

/**
 * True for an offered name that the space no longer declares — shown as such.
 *
 * An operator meeting a name they do not recognise cannot otherwise tell whether it is a type they
 * forgot or one somebody deleted out from under the edge.
 */
export function isStaleEndName(declared: readonly string[], name: string): boolean {
  return name !== UNTYPED_END && !declared.includes(name);
}

/**
 * Add or remove one type name at one end, keeping the "empty means absent" invariant.
 *
 * Removing the last name deletes the side, and deleting the last side deletes the object — because
 * `endpoints: {}` is refused too, with "an empty object constrains nothing and is more likely a typo".
 * Every intermediate state a click can produce is therefore one the API accepts.
 */
export function toggleEndpoint(state: TypeSchemaState, side: EndpointSide, name: string): void {
  const curr = endpointsFor(state, side);
  const next = curr.includes(name) ? curr.filter(n => n !== name) : [...curr, name];
  const other = side === 'from' ? 'to' : 'from';
  const keep = endpointsFor(state, other);
  if (next.length === 0 && keep.length === 0) { state.endpoints = undefined; return; }
  state.endpoints = {
    ...(side === 'from' ? { from: next } : { from: keep.length ? keep : undefined }),
    ...(side === 'to' ? { to: next } : { to: keep.length ? keep : undefined }),
  };
  if (state.endpoints.from === undefined) delete state.endpoints.from;
  if (state.endpoints.to === undefined) delete state.endpoints.to;
}

/**
 * Every pair this label permits, for a preview under the two lists.
 *
 * **The reason this function exists at all.** Two lists mean the CROSS PRODUCT and not pairing by position
 * — owner's ruling, 2026-08-31 — and two lists side by side imply pairs to almost everybody. Two names on
 * the left and three on the right is SIX permitted edges, not two, and a control that leaves the reader to
 * work that out from the layout is a control that says something the API does not do.
 *
 * An unrestricted end appears as `*`. Both unrestricted returns nothing: there is no restriction to preview,
 * and a preview reading `* -> *` would look like a rule where there is none.
 */
export function endpointPairs(state: TypeSchemaState): string[] {
  const from = endpointsFor(state, 'from');
  const to = endpointsFor(state, 'to');
  if (from.length === 0 && to.length === 0) return [];
  const left = from.length ? from : ['*'];
  const right = to.length ? to : ['*'];
  return left.flatMap(f => right.map(t => `${f} \u2192 ${t}`));
}
