/**
 * The parameters of the RDF data import, judged before any logic runs (bundle-270, Q-752, Q-955, Q-755): the one schema both doors' parameters
 * pass (`RdfImportParams`), the status doors' parameter, and how a REST query or a tool's arguments are read into it. Moved out of
 * `rdf-import-act.ts` along this seam when Q-755 added the inference's thresholds, so the act stays within its size limit.
 *
 * ## What it prevents
 *
 * - **Two doors that read their parameters two ways.** A REST query carries text and a tool carries JSON; {@link rdfImportParamsOf} reads
 *   both into one shape (booleans and numbers from their texts, a repeated value as a list) and the schema judges it, so a value one door takes
 *   the other takes too.
 * - **An unbounded input.** Every list and number carries its bound: graph bases, address lengths, the support threshold (at most the subjects
 *   an import holds), the confidence threshold (a share).
 */
import { z } from 'zod';
import { RDF_FORMATS, type RdfFormat } from '../rdf/serialize.js';
import { rdfParamBool, rdfParamList } from '../rdf/rdf-document.js';
import { RDF_IMPORT_MAX_QUADS } from '../rdf/import-spool.js';
import { RDF_IMPORT_ADDRESS_MAX } from './rdf-import-files.js';

/** The most per-graph source bases one request names (and the most graph addresses a refusal names). */
export const RDF_IMPORT_GRAPH_BASES_MAX = 64;
/** A graph base is `"<graph address> <source base>"`: at least one character each side of the space, and at most two addresses and the space. */
export const RDF_IMPORT_GRAPH_BASE_MIN_CHARS = 3;
export const RDF_IMPORT_GRAPH_BASE_MAX_CHARS = RDF_IMPORT_ADDRESS_MAX * 2 + 1;
/** What an import with `schema` reads the schema from: the file's OWL and RDFS declarations, its shapes, and its records (`data`, Q-755). */
export const IMPORT_SCHEMA_SOURCES =['declared', 'shacl', 'data'] as const;
/**
 * The largest support threshold a caller may ask: more subjects than a file of `RDF_IMPORT_MAX_QUADS` quads can have (a subject has at least one
 * quad), a static figure. The most subjects an import holds is the memory room's, which differs per instance, so it cannot be the schema's maximum.
 */
export const RDF_IMPORT_INFER_SUPPORT_MAX = RDF_IMPORT_MAX_QUADS;

/** A source base per graph: `"<graph address> <source base>"`, one value each. */
const GRAPH_BASE = z.string().min(RDF_IMPORT_GRAPH_BASE_MIN_CHARS).max(RDF_IMPORT_GRAPH_BASE_MAX_CHARS).regex(/^\S+ \S+$/, 'a graph base is "<graph address> <source base>"');

/**
 * The parameters both doors take, judged before any logic runs. NOT strict: a door passes only these names. `schema` (Q-955): `none` (the
 * default) imports the data alone; `generate`, `expand` and `update` build or extend the space's type schemas from the file's classes and shapes,
 * as the schema door's `mode`, read from `from` (the schema door's default when absent).
 */
export const RdfImportParams = z.object({
  format: z.enum(RDF_FORMATS as unknown as [RdfFormat, ...RdfFormat[]]).optional(),
  dryRun: z.boolean().optional(),
  blankNodes: z.enum(['refuse', 'mint']).optional(),
  sourceBase: z.string().min(1).max(RDF_IMPORT_ADDRESS_MAX).optional(),
  sourceVocab: z.string().min(1).max(RDF_IMPORT_ADDRESS_MAX).optional(),
  graphBase: z.array(GRAPH_BASE).max(RDF_IMPORT_GRAPH_BASES_MAX).optional(),
  schema: z.enum(['none', 'generate', 'expand', 'update']).optional(),
  from: z.array(z.enum(IMPORT_SCHEMA_SOURCES)).min(1).max(IMPORT_SCHEMA_SOURCES.length).optional(),
  // With `data` in `from` (Q-755): the inference's thresholds, as shape-extraction tools take them, and whether an edge label no subject states
  // twice is one-only. Each without `data` is refused by the schema step's one judgement.
  inferFunctional: z.boolean().optional(),
  inferMinSupport: z.number().int().min(1).max(RDF_IMPORT_INFER_SUPPORT_MAX).optional(),
  inferMinConfidence: z.number().min(0).max(1).optional(),
});

/** The status doors' parameter. */
export const RdfImportStatusParams = z.object({ importId: z.string().uuid() });

/** A REST query's number as the parameters take it: a decimal text read as a number, anything else passed on for the schema to judge. */
const paramNumber = (v: unknown): unknown => (typeof v === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)\s*$/.test(v) ? Number(v) : v);

/** A REST query or a tool's arguments as the parameters take them: booleans and numbers from their strings, one graph base or several. */
export function rdfImportParamsOf(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    format: raw['format'], dryRun: rdfParamBool(raw['dryRun']), blankNodes: raw['blankNodes'], sourceBase: raw['sourceBase'],
    sourceVocab: raw['sourceVocab'], graphBase: rdfParamList(raw['graphBase']), schema: raw['schema'], from: rdfParamList(raw['from']),
    inferFunctional: rdfParamBool(raw['inferFunctional']), inferMinSupport: paramNumber(raw['inferMinSupport']), inferMinConfidence: paramNumber(raw['inferMinConfidence']),
  };
}
