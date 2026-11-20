/**
 * The constraints of SHACL Core, each either mapped to the schema field it is read as or named as not taken, and why (bundle-270, slice S8,
 * Q-754; plan section 3 (g)).
 *
 * ## What it prevents
 *
 * A type schema has a few fields and SHACL Core has some thirty constraint components. A reader that maps the ones it knows and passes over the
 * rest builds a strict-looking space that accepts what the file's shape forbade. So every constraint of Core is a row of
 * {@link SHACL_CONSTRAINTS}, in one of two columns: `mapped` (the fields it can set, in the forms the reader accepts) or `not-taken` (the
 * reason). `every-shacl-constraint-is-taken-or-named.test.js` holds the list of Core against the table and each row against a file.
 * {@link leftoverWhy} answers for a statement of a shape that no reader took: a constraint not taken by its row's reason, anything else as
 * stating nothing a field holds. So a predicate the reader has no code for is named, never passed over.
 *
 * ## The rule behind the columns
 *
 * A constraint is mapped only where the field holds EXACTLY what it says. `sh:datatype xsd:integer` is not `type: number` (a number may be
 * 1.5); `sh:minExclusive` is not `minimum` (a minimum accepts the bound); a bare `sh:class` is not an endpoint list (an endpoint is checked
 * only when the other end is an entity, so a fact would pass); a bare `sh:minInclusive` or `sh:pattern` on a value that may be another type is
 * not read (the schema reads a range only on a number and a pattern only on text); `sh:minCount 2` is not `required`; `sh:maxCount 2` is not
 * one-only. Such a statement is named with `looser-field` when a field is close and would accept more, `no-field` when none holds it.
 *
 * Pure.
 */
import { short, type NotTakenWhy, type Stmt } from './schema-from-rdf-store.js';

/** One constraint of SHACL Core (or a parameter of one) and what the reader does with it. */
export type ConstraintRow =
  | { constraint: string; outcome: 'mapped'; fields: readonly string[]; reason: string }
  | { constraint: string; outcome: 'not-taken'; why: NotTakenWhy; reason: string };

const mapped = (constraint: string, fields: readonly string[], reason: string): ConstraintRow => ({ constraint, outcome: 'mapped', fields, reason });
const notTaken = (constraint: string, why: NotTakenWhy, reason: string): ConstraintRow => ({ constraint, outcome: 'not-taken', why, reason });

/** Every constraint of SHACL Core with the parameters it carries, in the order of the recommendation (section 4). */
export const SHACL_CONSTRAINTS: readonly ConstraintRow[] = Object.freeze([
  notTaken('sh:class', 'no-field', 'a class a value must be an instance of: no property field holds it, and on an edge label an endpoint would pass an end that is no entity'),
  mapped('sh:datatype', ['type'], 'string, boolean, and number for xsd:decimal, xsd:double and xsd:float; any other datatype would be read looser or has no field'),
  notTaken('sh:nodeKind', 'no-field', 'what kind of node a value is: no field holds it'),
  mapped('sh:minCount', ['required'], 'a count of one is required; a count of zero states nothing; a larger count has no field'),
  mapped('sh:maxCount', ['(every property)', 'functional'], 'one is what every property holds and what a one-only edge label is; any other count has no field'),
  notTaken('sh:minExclusive', 'looser-field', 'a bound the value must pass: a minimum accepts the bound itself'),
  mapped('sh:minInclusive', ['minimum'], 'a minimum, only where the value is a number (the schema reads a range only on a number)'),
  notTaken('sh:maxExclusive', 'looser-field', 'a bound the value must pass: a maximum accepts the bound itself'),
  mapped('sh:maxInclusive', ['maximum'], 'a maximum, only where the value is a number (the schema reads a range only on a number)'),
  mapped('sh:minLength', ['required'], 'a length of one beside a count of one is what a required property states; any other length has no field'),
  notTaken('sh:maxLength', 'no-field', 'a longest text: no field holds it'),
  mapped('sh:pattern', ['pattern', 'namingPattern'], 'a pattern, only where SPARQL and ECMAScript read it alike, no flags are given, and the value is text'),
  notTaken('sh:flags', 'no-field', 'flags change what a pattern means: a pattern field holds none'),
  notTaken('sh:languageIn', 'no-field', 'the languages of a text: a text has none'),
  notTaken('sh:uniqueLang', 'no-field', 'one text per language: a text has no language'),
  notTaken('sh:equals', 'no-field', 'a pair of properties that hold the same values: no field holds it'),
  notTaken('sh:disjoint', 'no-field', 'a pair of properties that hold no value in common: no field holds it'),
  notTaken('sh:lessThan', 'no-field', 'a pair of properties ordered by value: no field holds it'),
  notTaken('sh:lessThanOrEquals', 'no-field', 'a pair of properties ordered by value: no field holds it'),
  notTaken('sh:not', 'no-field', 'a shape the value must not conform to: no field holds it'),
  notTaken('sh:and', 'no-field', 'shapes the value must all conform to: no field holds it'),
  mapped('sh:or', ['type', 'minimum', 'maximum', 'pattern', 'endpoints'], 'a choice, only in the forms the export writes (a number, a date, a guarded range or pattern, an edge label\'s endpoints)'),
  notTaken('sh:xone', 'no-field', 'exactly one of several shapes: no field holds it'),
  notTaken('sh:node', 'no-field', 'a value that conforms to another shape: no field holds it'),
  mapped('sh:property', ['propertySchemas'], 'a property shape of a type is a property of it'),
  notTaken('sh:qualifiedValueShape', 'no-field', 'a count of values that conform to a shape: no field holds it'),
  notTaken('sh:qualifiedMinCount', 'no-field', 'a least count of values that conform to a shape: no field holds it'),
  notTaken('sh:qualifiedMaxCount', 'no-field', 'a most count of values that conform to a shape: no field holds it'),
  notTaken('sh:qualifiedValueShapesDisjoint', 'no-field', 'qualified shapes that exclude one another: no field holds it'),
  notTaken('sh:closed', 'no-field', 'a record that states no property the shape does not name: a type schema does not close a type'),
  notTaken('sh:ignoredProperties', 'no-field', 'properties a closed shape leaves out: a type schema does not close a type'),
  notTaken('sh:hasValue', 'no-field', 'a value a property must have among its own: no field holds it'),
  mapped('sh:in', ['enum'], 'the allowed values, every member a plain value'),
]);

/** Why a statement of a shape or term the reader owns that no reader took is not taken. */
export function leftoverWhy(stmt: Stmt): { why: NotTakenWhy; message: string } {
  const predicate = short(stmt.quad.predicate.value);
  const row = SHACL_CONSTRAINTS.find(r => r.constraint === predicate);
  if (row?.outcome === 'not-taken') return { why: row.why, message: row.reason };
  if (row?.outcome === 'mapped') return { why: 'no-field', message: `${predicate} is read where a type or property states it in a form a field holds, and is not stated so here` };
  return { why: 'no-field', message: `no schema field holds ${predicate}` };
}
