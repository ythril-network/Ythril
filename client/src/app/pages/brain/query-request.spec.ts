/**
 * `queryRequestFrom` — the ONE thing that turns the Advanced form into a query request.
 *
 * The filter and the projection are parsed by the same rule, and it was written twice in the component: trim, parse,
 * and on a parse error say "Invalid JSON" against that field and send nothing. Here it is written once, and these
 * cases pin what the component did with it (`query-tab.component.spec.ts` still drives `runQuery` end to end).
 */
import { describe, it, expect } from 'vitest';
import { queryRequestFrom, type QueryForm } from './query-request';

function form(over: Partial<QueryForm> = {}): QueryForm {
  return { collection: 'facts', filter: '', projection: '', limit: 20, maxTimeMS: 5000, ...over };
}

describe('queryRequestFrom', () => {
  it('an empty form asks for everything in the collection, with no projection', () => {
    expect(queryRequestFrom(form())).toEqual({ body: { collection: 'facts', filter: {}, projection: undefined, limit: 20, maxTimeMS: 5000 } });
  });

  it('the filter and the projection are read from their trimmed JSON', () => {
    const r = queryRequestFrom(form({ collection: 'entities', filter: '  {"type":"person"} ', projection: ' {"name":1} ', limit: 5, maxTimeMS: 100 }));
    expect(r).toEqual({ body: { collection: 'entities', filter: { type: 'person' }, projection: { name: 1 }, limit: 5, maxTimeMS: 100 } });
  });

  it('a filter that is not JSON names the filter and sends nothing', () => {
    const r = queryRequestFrom(form({ filter: '{ not valid json ' }));
    expect(r.body).toBeUndefined();
    expect(r.field).toBe('filter');
    expect(r.error).toContain('Invalid JSON');
  });

  it('a projection that is not JSON names the projection', () => {
    const r = queryRequestFrom(form({ projection: '{ nope' }));
    expect(r.field).toBe('projection');
    expect(r.error).toContain('Invalid JSON');
  });

  it('when both are broken the filter is the one reported, as the form reads top to bottom', () => {
    expect(queryRequestFrom(form({ filter: '{', projection: '{' })).field).toBe('filter');
  });
});
