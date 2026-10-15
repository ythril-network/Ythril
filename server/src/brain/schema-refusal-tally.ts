/**
 * How many schema refusals this process has answered, by the door that answered and what blocked the write (`R6-13`).
 *
 * ## What it prevents
 *
 * A strict refusal left no trace on the server: nothing logged, the http metric had a route and a status and no reason, the tool counter
 * no outcome. An operator whose agent was being refused a hundred times an hour for one undeclared key could not see it from any
 * dashboard, and learned of it from the agent. `ythril_schema_refusals_total{door,outcome}` is read from this tally at scrape time
 * (`metrics/registry.ts`, as the file act answers are: this module is imported by the writers and must not import the registry back).
 *
 * ## The labels are a fixed vocabulary, on purpose
 *
 * `door` says where the refusal was answered and `outcome` what blocked the write. Neither is a name a caller, a peer or an operator
 * chose: a space, a rule or a property name as a label would mint a new time series per spelling, which is unbounded cardinality from any
 * authenticated caller (`Q-108`). Every pair is present at 0 from the start, so "absent" and "0" never mean opposite things on a graph.
 *
 * Counted where the refusal is ANSWERED — `countSchemaRefusal` in `write-validation.ts` — and once per refusal, by its blocking fault:
 * the first violation the write introduced.
 */

/** Where a refusal was answered: a REST record route, an MCP tool call, a `POST /api/<tool>` call, one row of a batch, a merge. */
export const SCHEMA_REFUSAL_DOORS = ['rest', 'mcp', 'tool', 'bulk', 'merge'] as const;
export type SchemaRefusalDoor = (typeof SCHEMA_REFUSAL_DOORS)[number];

/**
 * What blocked the write. `undeclared`: a property key the type does not declare. `property`: any other violation of a declared
 * property or of the type (a wrong type, an enum, an unresolved reference). `rule`, `could_not_evaluate` and `too_large`: a schema rule
 * the record broke, one that could not be judged, and a record too large to judge.
 *
 * Exactly the outcomes `refusalOutcomeOf` (`write-validation.ts`) can answer, and no more: each is declared at 0, so an outcome no refusal
 * can have would read "never happened" for ever (`refused_name` did, until bundle-23 wave 4). `a-schema-refusal-is-counted-by-what-blocked-it`
 * holds every one to a refusal that produces it.
 */
export const SCHEMA_REFUSAL_OUTCOMES = ['undeclared', 'property', 'rule', 'could_not_evaluate', 'too_large'] as const;
export type SchemaRefusalOutcome = (typeof SCHEMA_REFUSAL_OUTCOMES)[number];

const tally = new Map<string, number>(
  SCHEMA_REFUSAL_DOORS.flatMap(door => SCHEMA_REFUSAL_OUTCOMES.map(outcome => [`${door}\u0000${outcome}`, 0] as const)),
);

/** Count one refusal. */
export function tallySchemaRefusal(door: SchemaRefusalDoor, outcome: SchemaRefusalOutcome): void {
  const k = `${door}\u0000${outcome}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
}

/** A snapshot: every door and outcome, 0 until the first refusal. */
export function schemaRefusalCounts(): { door: SchemaRefusalDoor; outcome: SchemaRefusalOutcome; count: number }[] {
  return [...tally].map(([k, count]) => {
    const [door, outcome] = k.split('\u0000') as [SchemaRefusalDoor, SchemaRefusalOutcome];
    return { door, outcome, count };
  });
}
