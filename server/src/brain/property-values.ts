/**
 * What may sit in a record's property bag, at the API layer — one rule, one implementation.
 *
 * ## The report this exists because of
 *
 * The fleet integrator, 2026-09-02T1047Z, measured both entity writes minutes apart against one space, on
 * the same record type and the same field name: `POST` refused a nested value with a `400`, and `PATCH`
 * stored it and read it back three levels deep. Same field, same record, same space, two answers.
 *
 * **They were not asking for nested properties.** Their words: *"a nested value in a property is usually a
 * graph in the wrong place"* — they moved the structure to records and edges and said the store was right.
 * What they asked for is that the two doors agree.
 *
 * **And the reason the hole cost them something is worth keeping:** *"the hole did not fail, it taught us
 * the wrong contract."* They wrote through the permissive door, read it back whole, concluded nested
 * properties were supported, and built on it — so the failure was scheduled to arrive later, on a different
 * route, as a puzzle rather than a refusal.
 *
 * Reading the source for the reported pair found a THIRD door: `bulk.ts` cast the bag with no value check at
 * all. A reporter names where they saw it; the sweep has to go wider than the report.
 *
 * ## Why the rule is entity-only, and why widening it is not a bug fix
 *
 * `docs/integration-guide/04-brain-api.md` states it deliberately: *"unlike the entity endpoint, the
 * fact/edge/chrono write paths don't reject non-primitive values at the API layer"*. Applying it to the
 * other three would refuse writes that work today — a product decision, and a breaking one. What this module
 * fixes is that the rule the product HAS is the same on every door that has it.
 *
 * ## Why a returned error rather than a throw
 *
 * The same shape as `validateDeleteFields`: a door needs to answer `400` with a message, and the two other
 * ways of doing that are both worse here. A throw needs a matching catch on every door, and the doors' catch
 * blocks already carry `SchemaViolationError`, which means something different — a violation of the SPACE's
 * schema, which a space in `warn` mode records and stores. This is a shape rule, refused in every mode.
 */

/** A property bag as it arrives from a caller: keys and values both unverified. */
type IncomingProperties = Record<string, unknown>;

/**
 * The refusal for a property bag holding a non-primitive value, or `null` when every value is one.
 *
 * The MESSAGE IS VERBATIM what the create route has always answered. The integrator quoted it back and
 * called it good — *"it says exactly what is allowed"* — and somebody matching on that string would break
 * silently if it were reworded during an extraction that changes no behaviour.
 *
 * `undefined` and `null` bags are fine: a caller that sends no properties has broken no rule. That is the
 * distinction a PATCH needs, where the bag being absent means "leave what is stored" rather than "empty".
 */
export function primitivePropertyError(properties: unknown): string | null {
  if (properties === undefined || properties === null) return null;
  if (typeof properties !== 'object' || Array.isArray(properties)) {
    return '`properties` must be a plain object';
  }
  for (const [k, v] of Object.entries(properties as IncomingProperties)) {
    if (typeof k !== 'string' || (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')) {
      return '`properties` values must be string, number, or boolean';
    }
  }
  return null;
}
