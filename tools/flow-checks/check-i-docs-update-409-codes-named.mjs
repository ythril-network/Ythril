#!/usr/bin/env node
/**
 * check-i-docs-update-409-codes-named: every `409` code a record update can answer is named in that update tool's MCP text and on its API page.
 *
 * Rule: the codes are READ from the two functions that answer an update's refusal for every door (`connectionRefusalAnswer` and `writeRefusalAnswer`,
 * `server/src/brain/write-validation.ts`): each `instanceof` class whose answer is `409` and which carries a `code`. Each code is a row of
 * {@link ANSWERED_BY}: the update tools that can answer it and the integration-guide page that names it, or a reason it is none's. Then:
 *
 *   - a code in the source with no row fails (a refusal added next month is asked the day it is added);
 *   - a row for a code the source no longer answers fails (the table does not rot);
 *   - each tool of a row names the code, in its description or in any description inside its input schema (a caller reads both);
 *   - the row's page names the code.
 *
 * The failure that bought it (bundle-378 lens sweep L1.5, 2026-11-27): `409 write_race_lost` was added to every record update and named in neither the
 * four update tools' descriptions nor the brain API page, which still said an edit retries with no end; the ceiling code beside it was named in both.
 * A tool's description is what a caller reads while constructing a call, and nobody reports a refusal they were never told of.
 *
 *     node tools/flow-checks/check-i-docs-update-409-codes-named.mjs   (after `npm run build:server`)
 */
import { readTrackedSources } from '../../testing/standalone/_sources.mjs';
import { builtRegistry, SPACE_SCHEMAS } from './_built-registry.mjs';
import { stripSourceComments } from './_axe.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';

const UPDATE_TOOLS = Object.freeze(['update_entity', 'update_fact', 'update_chrono', 'update_edge']);
const BRAIN_PAGE = 'docs/integration-guide/04-brain-api.md';

/**
 * Per code a record update can answer with `409`: the tools that answer it and the page that names it, or `{ none }` with the reason no update tool
 * answers it. Everything else about the code is read from the source.
 */
export const ANSWERED_BY = Object.freeze({
  record_version_at_ceiling: { tools: UPDATE_TOOLS, page: BRAIN_PAGE },
  write_race_lost: { tools: UPDATE_TOOLS, page: BRAIN_PAGE },
  fork_row_read_only: { tools: UPDATE_TOOLS, page: BRAIN_PAGE },
  endpoint_removed: { tools: ['update_edge'], page: 'docs/integration-guide/04b-graph-api.md' },
  fork_cap: { none: 'a re-key or merge past the fork cap: `merge_entities` and the fork resolve answer it, no update tool re-keys a record' },
  link_target_removed: { none: 'the link write `save_link` answers it; an update\'s link to a deleted entity is taken back with a warning, not refused' },
});

/** The text of the function `name` in `text`, from its `export function` line to the closing `}` at column 0; `null` when it is not there. */
function functionText(text, name) {
  const start = text.search(new RegExp(`export function ${name}\\b`));
  if (start < 0) return null;
  const end = text.indexOf('\n}', start);
  return end < 0 ? null : text.slice(start, end + 2);
}

/** The string a `readonly code = X` names: a literal, a constant of `sources`, or `ARRAY[n]` of a frozen array of strings. `null` when it cannot be read. */
function codeValue(expr, sources) {
  const literal = /^['"]([a-z_]+)['"]$/.exec(expr);
  if (literal) return literal[1];
  const indexed = /^([A-Z_]+)\[(\d+)\]$/.exec(expr);
  const name = indexed ? indexed[1] : expr;
  for (const s of sources) {
    const m = new RegExp(`export const ${name}\\s*=\\s*([^;]+);`).exec(s.text);
    if (!m) continue;
    if (!indexed) return codeValue(m[1].trim(), []);
    const items = [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
    return items[Number(indexed[2])] ?? null;
  }
  return null;
}

/**
 * `[{ cls, code }]`: the `409` refusals the update answer functions map. `answerers` is the text of `write-validation.ts`; `sources` are every server
 * source `{ file, text }` (comments stripped), where the classes and their code constants are.
 */
export function refusalCodesOf(answerers, sources) {
  const body = ['connectionRefusalAnswer', 'writeRefusalAnswer'].map(n => functionText(answerers, n)).filter(Boolean).join('\n');
  if (!body) throw new CannotAnswer('connectionRefusalAnswer and writeRefusalAnswer were not found in write-validation.ts: re-anchor this probe');
  const found = [];
  for (const stmt of body.split(/\n\s*(?=if \()/)) {
    const classes = [...stmt.matchAll(/instanceof (\w+)/g)].map(m => m[1]);
    if (!classes.length) continue;
    for (const cls of classes) {
      const src = sources.find(s => new RegExp(`class ${cls}\\b`).test(s.text));
      if (!src) continue;
      const from = src.text.search(new RegExp(`class ${cls}\\b`));
      const cut = src.text.slice(from, src.text.indexOf('\n}', from));
      const code = /readonly code = ([^;]+);/.exec(cut);
      if (!code) continue;
      const status409 = /status:\s*409/.test(stmt) || /readonly status = 409/.test(cut);
      if (!status409) continue;
      const value = codeValue(code[1].trim(), sources);
      if (value) found.push({ cls, code: value });
    }
  }
  return found;
}

/** The text a caller of `tool` reads: its description and every description inside its input schema. */
export function textOfTool(tool) {
  const schema = typeof tool.inputSchema === 'function' ? tool.inputSchema(SPACE_SCHEMAS) : tool.inputSchema;
  return `${tool.description ?? ''}\n${JSON.stringify(schema ?? {})}`;
}

/** `tools` are the registry's tool objects; `pages` is `{ [path]: text }`. */
export function decide({ codes, tools, pages }) {
  const read = [...new Set(codes.map(c => c.code))];
  if (read.length < 4) return violated(`only ${read.length} refusal code(s) read from the update answer functions (${read.join(', ')}): the reader is broken, not the code`);
  const unlisted = read.filter(c => !ANSWERED_BY[c]);
  if (unlisted.length) return violated(`the update answer functions answer 409 ${unlisted.join(', ')}, which ${'tools/flow-checks/check-i-docs-update-409-codes-named.mjs'} has no row for: say which update tools can answer it`);
  const stale = Object.keys(ANSWERED_BY).filter(c => !read.includes(c));
  if (stale.length) return violated(`ANSWERED_BY lists ${stale.join(', ')}, which the update answer functions no longer answer`);
  const missing = [];
  for (const [code, row] of Object.entries(ANSWERED_BY)) {
    if (row.none) continue;
    for (const name of row.tools) {
      const tool = tools.find(t => t.name === name);
      if (!tool) throw new CannotAnswer(`the registry has no tool '${name}'`);
      if (!textOfTool(tool).includes(code)) missing.push(`${name} does not name ${code}`);
    }
    const page = pages[row.page];
    if (page === undefined) throw new CannotAnswer(`${row.page} was not read`);
    if (!page.includes(code)) missing.push(`${row.page} does not name ${code}`);
  }
  return missing.length
    ? violated(`${missing.length} refusal(s) an update can answer are not named where a caller reads: ${missing.join('; ')}`)
    : holds(`every 409 code an update answers (${read.join(', ')}) is named in its tools and on its page`);
}

/** The inputs of {@link decide} read from the repository. */
export async function readInputs() {
  const sources = readTrackedSources(['server/src'], { ext: ['.ts'], specs: false, floor: 50 })
    .map(s => ({ file: s.file, text: stripSourceComments(s.text) }));
  const validation = sources.find(s => s.file.endsWith('brain/write-validation.ts'));
  if (!validation) throw new CannotAnswer('server/src/brain/write-validation.ts was not read');
  const { ALL_TOOLS } = await builtRegistry();
  const pageFiles = readTrackedSources(['docs/integration-guide'], { ext: ['.md'], floor: 5 });
  const pages = Object.fromEntries(pageFiles.map(p => [p.file.replace(/\\/g, '/'), p.text]));
  return { codes: refusalCodesOf(validation.text, sources), tools: ALL_TOOLS, pages };
}

if (isMain(import.meta.url)) await answer(async () => decide(await readInputs()));
