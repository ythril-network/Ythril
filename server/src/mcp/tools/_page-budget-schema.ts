/**
 * The input schema of the paging and size parameters a budgeted tool takes: `skip`, `maxChars`, `maxBytes`,
 * `maxTokens`, `remainderDump` (`Q-132`).
 *
 * Every budgeted tool accepts the same five with the same floors and the same meaning, because they all resolve
 * through `brain/result-budget.ts`. Four tools spelled the schema out by hand before this existed; `graph_traverse` is
 * the first to take it from here, and moving the others is its own ticket. `unit` names what one row of THIS answer is
 * ("node", "match"), so the description a caller reads while building arguments says what `skip` counts.
 */
export function pageBudgetSchema(unit: string): Record<string, Record<string, unknown>> {
  return {
    skip: {
      type: 'integer', minimum: 0,
      description: `How many ${unit}s to skip before filling the byte budget (default 0). A response with \`truncated: true\` and \`nextSkip\` continues when you send \`nextSkip\` back as \`skip\` — none repeated, none missed.`,
    },
    maxChars: {
      type: 'integer', minimum: 1000,
      description: `Ceiling on the serialised answer, in CHARACTERS: whole ${unit}s only, the rest reached with \`nextSkip\`. Default 25000 on MCP and 50000 on REST — the one default the two doors deliberately differ on; up to 5000000.`,
    },
    maxBytes: {
      type: 'integer', minimum: 1000,
      description: 'Ceiling on the serialised answer in real UTF-8 BYTES. No default; when both are set, the answer stops at whichever it reaches first.',
    },
    maxTokens: {
      type: 'integer', minimum: 1,
      description: 'A convenience onto `maxChars`, at 3.5 characters per token. The smaller resulting ceiling applies.',
    },
    remainderDump: {
      type: 'boolean',
      description: `Also keep the ${unit}s that did not fit as a spill for \`read_spill\` (default false), readable by your token alone for a day. Paging with \`skip\` reaches the same ${unit}s without one.`,
    },
  };
}
