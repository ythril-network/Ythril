import type { QueryCollection } from '../../core/api.types';

/** The Advanced form as the query tab holds it: the filter and the projection are JSON text the operator typed. */
export interface QueryForm {
  collection: QueryCollection;
  filter: string;
  projection: string;
  limit: number;
  maxTimeMS: number;
}

/** The body `BrainApi.queryBrain` takes. */
export interface QueryBody {
  collection: QueryCollection;
  filter: Record<string, unknown>;
  projection: Record<string, unknown> | undefined;
  limit: number;
  maxTimeMS: number;
}

/** Either the body to send, or the one field that cannot be read and what is wrong with it. */
export type QueryRequest =
  | { body: QueryBody; field?: undefined; error?: undefined }
  | { body?: undefined; field: 'filter' | 'projection'; error: string };

/**
 * Build the query request from the Advanced form, and be the ONLY thing that does.
 *
 * The filter and the projection are read by one rule: trimmed, parsed as JSON, and on a parse error the field is
 * named with "Invalid JSON" and nothing is sent. It was written twice in the component, once per field, which is
 * the shape this codebase's defects take when one copy is later changed and the other is not. The filter is read
 * first, so when both are broken the filter is the one reported, as the form reads top to bottom.
 */
export function queryRequestFrom(form: QueryForm): QueryRequest {
  const filter = jsonField(form.filter, 'filter');
  if ('error' in filter) return { field: 'filter', error: filter.error };
  const projection = jsonField(form.projection, 'projection');
  if ('error' in projection) return { field: 'projection', error: projection.error };
  return {
    body: { collection: form.collection, filter: filter.value ?? {}, projection: projection.value, limit: form.limit, maxTimeMS: form.maxTimeMS },
  };
}

/** A JSON field of the form: `undefined` when left empty, the parsed object, or what is wrong with the text. */
function jsonField(text: string, name: string): { value: Record<string, unknown> | undefined } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { value: undefined };
  try {
    return { value: JSON.parse(trimmed) as Record<string, unknown> };
  } catch (e) {
    return { error: `Invalid JSON — ${e instanceof Error ? e.message : `check your ${name} syntax`}` };
  }
}
