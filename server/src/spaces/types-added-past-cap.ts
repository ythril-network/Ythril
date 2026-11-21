/**
 * Would a schema write take a knowledge type past the cap on type definitions, counting only the types it ADDS? (bundle-270, Q-754, design
 * revision 3, challenge F10.)
 *
 * ## What it prevents
 *
 * The cap was written inside the per-type route, for one type at a time; the schema-from-RDF door writes many types in one call and needs the
 * same rule. A second copy that counted every type the call NAMES would refuse a file that only updates types on a kind already at the cap,
 * and one that counted each new type alone would let a call add many past it. One check, asked by both: replaced types are not counted, new
 * types are counted together per kind.
 *
 * PATCH and `schema_update` do not ask it: putting the cap in the planner would refuse bodies those doors accept today.
 */
import type { KnowledgeType, TypeSchema } from '../config/types.js';

/** The most type definitions one knowledge type of a space holds; a write that would add past it is refused. */
export const MAX_TYPES_PER_KIND = 200;
/** The status a write past the cap is refused with: the request is understood and asks for more than a space holds. */
const BAD_REQUEST = 400 as const;

type TypeMaps = Partial<Record<KnowledgeType, Record<string, TypeSchema | unknown> | undefined>>;

/**
 * The refusal (400) of a write whose new types would take a kind of `stored` past {@link MAX_TYPES_PER_KIND}, naming the first such kind, or
 * null. `incoming` is what the write names, per kind; a name `stored` already holds is a replacement and is not counted.
 */
export function typesAddedPastCap(stored: TypeMaps | undefined, incoming: TypeMaps): { status: typeof BAD_REQUEST; error: string } | null {
  for (const [kind, names] of Object.entries(incoming) as [KnowledgeType, Record<string, unknown> | undefined][]) {
    const held = stored?.[kind] ?? {};
    const added = Object.keys(names ?? {}).filter(name => !Object.hasOwn(held, name)).length;
    if (added > 0 && Object.keys(held).length + added > MAX_TYPES_PER_KIND) {
      return {
        status: BAD_REQUEST,
        error: `Max ${MAX_TYPES_PER_KIND} type definitions per knowledge type reached for '${kind}'. Remove unused types before adding new ones.`,
      };
    }
  }
  return null;
}
