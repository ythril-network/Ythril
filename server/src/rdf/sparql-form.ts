/**
 * The form of a parsed SPARQL query (SELECT, ASK, CONSTRUCT, DESCRIBE), read from its algebra: the one reading the query endpoint
 * (`sparql-answer.ts`) and a view's save-time check (`view-construct.ts`) share, so a query one of them takes for a CONSTRUCT is one for the
 * other too.
 */

/** The four query forms. */
export type SparqlForm = 'select' | 'ask' | 'construct' | 'describe';

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
/** The algebra nodes a query form is wrapped in. */
const WRAPPERS: ReadonlySet<string> = new Set(['from', 'slice', 'distinct', 'reduced', 'orderby']);
/** The most wrappers a query form is looked for under: a parsed query has a handful. */
const WRAPPER_DEPTH_MAX = 64;

/** The form of a parsed query and, for a SELECT, its projected variables in order. */
export function formOf(algebra: unknown): { form: SparqlForm; vars: string[] } {
  let node: unknown = algebra;
  for (let depth = 0; depth < WRAPPER_DEPTH_MAX && isRecord(node); depth++) {
    const type = node['type'];
    if (type === 'ask') return { form: 'ask', vars: [] };
    if (type === 'construct') return { form: 'construct', vars: [] };
    if (type === 'describe') return { form: 'describe', vars: [] };
    if (type === 'project') {
      const vars = Array.isArray(node['variables']) ? node['variables'].filter(isRecord).map(v => String(v['value'])) : [];
      return { form: 'select', vars };
    }
    if (typeof type === 'string' && WRAPPERS.has(type)) { node = node['input']; continue; }
    break;
  }
  return { form: 'select', vars: [] };
}
