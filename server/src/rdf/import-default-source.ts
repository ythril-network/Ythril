/**
 * The source a file names for itself when the caller gave none: its one data graph (bundle-270, fix round 4, finding R2).
 *
 * ## What it prevents
 *
 * - **A guide that says what the code does not.** `docs/integration-guide/06f-exports.md` says `sourceBase` defaults, for TriG, N-Quads and JSON-LD,
 *   to the file's one data graph (and `sourceVocab` to `<sourceBase>vocab/`, `addressNames`' own default). The act read an absent `sourceBase` as
 *   the target's own base, so the export of another space was refused with every record, type and predicate unknown. An export names its data
 *   graph by the space's base (`term-iri.ts`, `graphIri`), so the graph IS the source base.
 * - **A default that guesses.** It applies only when the file is unambiguous: a format that names its graphs (Turtle names none), exactly one data
 *   graph (the export's description graph is not one), no data statement in the default graph, no `sourceBase` and no `graphBase` the caller gave,
 *   and a graph name that is a base `addressNames` accepts (an absolute address ending in `/`). Anything else keeps its reading.
 * - **A default that reads the file's addresses as the target's own.** A graph that is the target's own base adds no source: the addresses are
 *   the space's own already (the self import), and a source with the same base would only shadow nothing and say the file came from elsewhere.
 *
 * Pure: the caller (the door) reads the graphs off the file, and makes the default once, before the act is registered, so the sort, the act and a dry
 * run read the one `ImportOptions`.
 */
import type { SpaceMeta } from '@ythril-network/schema';
import type { RdfFormat } from './serialize.js';
import { addressNames } from './term-reverse.js';
import { graphIri } from './term-iri.js';

/** What the door saw of the file's graphs: the named ones in order of appearance, which of them only describe the file, and whether a statement sat in no graph. */
export interface GraphsOfFile {
  order: readonly string[];
  describing: ReadonlySet<string>;
  inDefaultGraph: boolean;
}

/** The options a default is made against: what the caller gave. */
export interface CallerSource {
  source?: { base: string; vocab?: string };
  graphBases: Readonly<Record<string, string>>;
}

/** The source base the file's one data graph names, or `null` when the file keeps its reading. */
export function defaultSourceBase(format: RdfFormat, graphs: GraphsOfFile, given: CallerSource, meta: SpaceMeta): string | null {
  if (format === 'turtle' || given.source !== undefined || Object.keys(given.graphBases).length > 0 || graphs.inDefaultGraph) return null;
  const data = graphs.order.filter(g => !graphs.describing.has(g));
  const graph = data[0];
  if (data.length !== 1 || graph === undefined || graph === graphIri(meta)) return null;
  try { addressNames(meta, { base: graph }); } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
  return graph;
}
