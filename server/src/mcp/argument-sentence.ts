/**
 * The words a refused tool argument is said in: the one place they are spelled, for the MCP validator (`mcp/validate-args.ts`) and for a REST door
 * that validates the same parameters in code (Review's resolve, `brain/forks.ts`). What it prevents: one missing parameter answered in the
 * validator's words on one door and in ours on the other, so the behaviour depended on which client the caller picked (y-flows convention `convention-ythril-both-doors-same-parameters`, "MCP and REST
 * are ONE API with two doors"). Import-free, so any module may ask it.
 */

/** The whole refusal: `Invalid arguments for '<tool>': <detail>`. */
export function invalidArgumentsSentence(tool: string, detail: string): string {
  return `Invalid arguments for '${tool}': ${detail}`;
}

/** The detail of a required argument that is absent. */
export function missingArgumentDetail(property: string): string {
  return `(arguments): missing required property '${property}'`;
}
