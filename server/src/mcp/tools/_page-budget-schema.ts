import { BUDGET_CEILING_MIN, MIN_MAX_BYTES, MAX_MAX_BYTES, DEFAULT_CHARS_PER_TOKEN, ROW_PAGER, budgetDefaultsSentence, type Pager } from '../../brain/result-budget.js';

/**
 * What the ceiling does to the unit that is itself over it, said in the caller's words and from the pager's own descriptor (Q-450): a row pager
 * admits the first row whole (the answer says `truncated: true`), a document window splits the first paragraph at the ceiling.
 */
function overTheCeilingSentence(unit: string, pager: Pager): string {
  return pager.firstUnit === 'split'
    ? 'the first paragraph is split at the ceiling, so a window never exceeds it.'
    : `the first ${unit} is returned whole even above the ceiling, with \`truncated: true\`, or it could never be read.`;
}

/**
 * The input schema of the size ceilings every budgeted tool takes: `maxChars`, `maxBytes`, `maxTokens` (`Q-161`).
 *
 * All of them resolve through `brain/result-budget.ts`, so the schema is derived from it rather than written per tool.
 * Four tools spelled it out by hand and had drifted from the resolver and from each other: one accepted `maxChars: 1`
 * where the rest refused anything under 1000, one said `maxTokens` converts onto `maxBytes`, and every copy refused a
 * `maxBytes` under 1000 that the resolver deliberately honours. So the floors here are the resolver's: a small
 * `maxChars` is RAISED to the floor rather than refused, and `maxBytes` has none. `unit` names what one row of THIS
 * answer is ("match", "row", "node", "item"), so the description a caller reads while building arguments says what
 * a budget cuts. `pager` is the descriptor of the module that pages (`ROW_PAGER`, `KEYSET_PAGER`, `WINDOW_PAGER`): it names the field the
 * answer continues by and what happens to a first unit over the ceiling, so the description is the code's own.
 */
export function budgetSizeSchema(unit: string, pager: Pager = ROW_PAGER): Record<string, Record<string, unknown>> {
  const lead = pager.firstUnit === 'split'
    ? `Ceiling on the returned text, in CHARACTERS: whole paragraphs only, the rest reached with \`${pager.continuedBy}\`; `
    : `Ceiling on the serialised answer, in CHARACTERS: whole ${unit}s only, the rest reached with \`${pager.continuedBy}\`; `;
  return {
    maxChars: {
      type: 'integer', minimum: BUDGET_CEILING_MIN,
      description: `${lead}${overTheCeilingSentence(unit, pager)} `
        + `${budgetDefaultsSentence()} Held between ${MIN_MAX_BYTES} and ${MAX_MAX_BYTES}: a smaller value is raised to ${MIN_MAX_BYTES}, not refused. Characters equal `
        + 'bytes only for ASCII — for a byte ceiling use `maxBytes`.',
    },
    maxBytes: {
      type: 'integer', minimum: BUDGET_CEILING_MIN,
      description: 'Ceiling on the serialised answer in real UTF-8 BYTES — what a transport or buffer limit is. NO DEFAULT, '
        + 'deliberately: bytes are always at least characters, so a byte default would silently bind on every non-ASCII '
        + `answer. No floor either — a caller who states 500 bytes has a reason. Up to ${MAX_MAX_BYTES}. When both are set, `
        + 'the answer stops at whichever it reaches first.',
    },
    maxTokens: {
      type: 'integer', minimum: BUDGET_CEILING_MIN,
      description: `A convenience onto \`maxChars\`, at a fixed ${DEFAULT_CHARS_PER_TOKEN} characters per token. When both are `
        + 'set the smaller resulting ceiling applies. An approximation: the server does not know your tokeniser.',
    },
  };
}

/**
 * The size ceilings plus the paging pair a tool that SPILLS takes: `skip` and `remainderDump` (`Q-132`, `Q-161`).
 *
 * Built on `budgetSizeSchema` rather than beside it, so the ceilings cannot be written twice. A tool that pages by
 * `limit` and keeps no spill — `filter` — takes the size schema alone and states its own `skip`.
 */
export function pageBudgetSchema(unit: string): Record<string, Record<string, unknown>> {
  return {
    skip: {
      type: 'integer', minimum: 0,
      description: `How many ${unit}s to skip before filling the byte budget (default 0). A response with \`truncated: true\` and \`nextSkip\` continues when you send \`nextSkip\` back as \`skip\` — none repeated, none missed.`,
    },
    ...budgetSizeSchema(unit),
    remainderDump: {
      type: 'boolean',
      description: `Also keep the ${unit}s that did not fit as a spill for \`read_spill\` (default false), readable by your token alone for a day. Paging with \`skip\` reaches the same ${unit}s without one.`,
    },
  };
}
