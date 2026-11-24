/**
 * BSBM query templates and their parameters.
 *
 * A template is the benchmark's own query text with `%Name%` placeholders. The test driver chooses the values
 * (from the generator's data, under its own seed); the harness records what the driver chose with
 * `extractParams` and fills the same templates later with `substitute`.
 *
 * ## What this prevents
 *
 * - **A placeholder left in a query.** Both engines then answer a parse error for it and the run still
 *   completes; `substitute` refuses a placeholder with no value, and a value with no placeholder.
 * - **A value read as a placeholder.** The fill is one pass over the template, so a value that contains
 *   `%B%` is inserted as text, never filled in again.
 * - **A query that is not an instance of its template** being filed under it: `extractParams` throws
 *   instead of returning a partial set.
 */

const PLACEHOLDER = /%([A-Za-z][A-Za-z0-9]*)%/g;

/** Placeholder names, each once, in order of first appearance. */
export function placeholders(template) {
  const names = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

export function substitute(template, params) {
  const needed = placeholders(template);
  const missing = needed.filter((n) => !(n in params));
  if (missing.length) throw new Error(`no value for placeholder(s): ${missing.join(', ')}`);
  const extra = Object.keys(params).filter((n) => !needed.includes(n));
  if (extra.length) throw new Error(`the template has no placeholder for: ${extra.join(', ')}`);
  return template.replace(PLACEHOLDER, (_all, name) => String(params[name]));
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The values a driver put into a template. Whitespace in the template matches any whitespace in the query,
 * and a placeholder that appears twice must carry the same value both times.
 */
export function extractParams(template, query) {
  const seen = new Set();
  let source = '';
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    source += literal(template.slice(last, m.index));
    source += seen.has(m[1]) ? `\\k<${m[1]}>` : `(?<${m[1]}>\\S+)`;
    seen.add(m[1]);
    last = m.index + m[0].length;
  }
  source += literal(template.slice(last));
  const match = new RegExp(`^\\s*${source}\\s*$`).exec(query);
  if (!match) throw new Error('query does not match the template');
  return { ...match.groups };
}

function literal(text) {
  return text.split(/\s+/).map(escapeRegex).join('\\s+');
}
