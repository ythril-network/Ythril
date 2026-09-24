/**
 * The sentence in the MCP server instructions that says which tools need a `space`.
 *
 * Derived from the tools' own schemas, never written out: it named `list_chrono`, `find_similar`,
 * `list_peers` and `sync_now` for months after all four were renamed or folded away, and it is the first
 * thing a connecting agent reads — a stale tool name there costs a failed call before anything else.
 */
import type { ToolSchemas } from './tools/types.js';

interface ToolLike { name: string; inputSchema: (s: ToolSchemas) => Record<string, unknown> }

export function spaceScopeSentence(tools: readonly ToolLike[], schemas: ToolSchemas): string {
  const optional: string[] = [];
  const none: string[] = [];
  for (const t of tools) {
    const s = t.inputSchema(schemas);
    const props = (s['properties'] ?? {}) as Record<string, unknown>;
    const required = Array.isArray(s['required']) ? s['required'] as string[] : [];
    if (!('space' in props)) none.push(t.name);
    else if (!required.includes('space')) optional.push(t.name);
  }
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs.join(''));
  return `Each tool requires a "space" parameter`
    + (optional.length || none.length ? ' (except ' : '')
    + (optional.length ? `${list(optional)}, where it is optional and enables cross-space results when omitted` : '')
    + (optional.length && none.length ? '; and ' : '')
    + (none.length ? `${list(none)}, which take none` : '')
    + (optional.length || none.length ? ')' : '') + '.';
}
