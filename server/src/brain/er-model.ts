/**
 * The entity-relationship model of a space, inferred from its schema AND from what is actually stored.
 *
 * ## Why it is inferred from both, and not just from the schema
 *
 * A space's `typeSchemas` declares what SHOULD be there. The records say what IS. Those two disagree
 * constantly and the disagreement is the interesting part — an operator arrived at this product with a
 * space holding 21 entity types nobody had declared, imported from the wrong schema file, and no view
 * anywhere would have shown them that. So every type reports which side it came from:
 *
 *   - `declared` and used  — the ordinary case.
 *   - `declared` and empty — a type nobody writes. Either the schema is aspirational or the writers do
 *     not know it exists; both are worth seeing, and a count of 0 is the only way to see it.
 *   - used but NOT declared — records outside the agreed vocabulary. Under `strict` validation these
 *     cannot be written any more, so they are history; under `warn` they are still arriving.
 *
 * A diagram drawn from the schema alone would show the second case and silently omit the third, which is
 * exactly backwards: the undeclared types are the ones nobody knows about.
 *
 * ## How the relationships are derived
 *
 * An edge joins two entity INSTANCES. A relationship joins two TYPES. So the type-level model is the
 * edge set grouped by `(fromType, label, toType)`, which needs every edge's endpoints resolved to their
 * types.
 *
 * Done with two COVERED index scans and an in-memory join, rather than a `$lookup` per edge:
 *
 *   - entities are read through `{ name: 1, type: 1 }`, which carries `_id` as every index does, so the
 *     id→type map comes off the index without touching a document;
 *   - edges are read through the unique `{ from: 1, to: 1, label: 1 }`, which is exactly the three
 *     fields the grouping needs.
 *
 * Neither scan fetches a document body, and a `$lookup` per edge is avoided entirely. That matters
 * because this feeds a page an operator is WAITING on: the trade documented in `perf-vs-accuracy` says
 * performance wins when someone is watching, and the honesty below is how the accuracy half is paid.
 *
 * ## Bounded, and it says when it was bounded
 *
 * Both scans are capped. A space large enough to exceed the cap gets a model built from what was read
 * and `truncated: true` naming which scan hit its limit — never a quietly partial diagram presented as
 * complete. "Absent" and "not looked at" are different answers and this endpoint is required to say
 * which one it is giving.
 */
import { col, asFilter } from '../db/mongo.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import type { EntityDoc, EdgeDoc, PropertySchema } from '../config/types.js';
import { LINK_CLASSES, linkGroupsOfClass } from './link-adjacency.js';
import { spaceCollection } from '../db/space-collection.js';

/** Read caps. Generous enough that no real space hits them, low enough that a runaway one cannot hang a page. */
export const ER_ENTITY_SCAN_LIMIT = 200_000;
export const ER_EDGE_SCAN_LIMIT = 200_000;
/** A property is only listed if the schema declares it; observed property keys are counted, not enumerated. */
export interface ErProperty {
  name: string;
  type?: PropertySchema['type'];
  required: boolean;
  /** Present only when the schema constrains the value set — the diagram shows this as a badge. */
  enumValues?: (string | number | boolean)[];
}

export interface ErEntityType {
  type: string;
  /** How many records of this type the space actually holds. `0` is a real and interesting answer. */
  count: number;
  /** Whether the space's `typeSchemas.entity` declares it. `false` means records outside the vocabulary. */
  declared: boolean;
  /** Declared naming constraint, if any — shown as the type's key format. */
  namingPattern?: string;
  properties: ErProperty[];
  /** Records of the other three kinds that LINK to this type — a fact, a chrono entry or a file. */
  linkedFrom: { facts: number; chrono: number; files: number };
}

export interface ErRelationship {
  from: string;
  to: string;
  label: string;
  count: number;
}

export interface ErModel {
  spaceId: string;
  entityTypes: ErEntityType[];
  relationships: ErRelationship[];
  /** Edges whose endpoint no longer resolves to an entity — dangling, and worth surfacing rather than dropping. */
  danglingEdges: number;
  truncated: null | { scan: 'entities' | 'edges' | 'links'; limit: number };
  /** Totals BEFORE any cap, so the caller can see what share of the space the diagram represents. */
  totals: { entities: number; edges: number };
}

/** The bucket an entity with no `type` falls into. Named rather than dropped: untyped records are real. */
export const UNTYPED = '(untyped)';

/** The declared half of the model — `typeSchemas.entity`, narrowed to what a diagram uses. */
export type DeclaredTypes = Record<string, {
  namingPattern?: string;
  propertySchemas?: Record<string, PropertySchema>;
}>;

/** Everything the assembly needs, already read. Separated so the logic can be tested without a database. */
export interface ErInputs {
  spaceId: string;
  entities: Array<{ _id: string; type?: string }>;
  edges: Array<{ from: string; to: string; label: string }>;
  /** Per source record, the entity ids it links to — one group list per linking collection. */
  links: { facts: string[][]; chrono: string[][]; files: string[][] };
  declared: DeclaredTypes;
  totals: { entities: number; edges: number };
  truncated: ErModel['truncated'];
}

/**
 * Turn what was read into the model. Pure — no I/O, no clock, no config.
 *
 * Split out because everything that can be WRONG here is arithmetic and set logic: which type a record
 * counts toward, whether a fact linking two services counts once or twice, what an unresolvable edge
 * endpoint means. Those deserve a test that runs in milliseconds against hand-built rows, not one that
 * needs a container and a seeded space.
 */
export function assembleErModel(input: ErInputs): ErModel {
  const typeOf = new Map<string, string>();
  const observed = new Map<string, number>();
  for (const row of input.entities) {
    const t = (row.type ?? '').trim() || UNTYPED;
    typeOf.set(row._id, t);
    observed.set(t, (observed.get(t) ?? 0) + 1);
  }

  const rel = new Map<string, ErRelationship>();
  let danglingEdges = 0;
  for (const e of input.edges) {
    const from = typeOf.get(e.from);
    const to = typeOf.get(e.to);
    // An endpoint we cannot resolve is either genuinely dangling or beyond the entity cap. Counted
    // separately either way: it keeps a truncated read from inventing a relationship, and it surfaces real
    // dangling edges — which `strictLinkage` exists to prevent and which matter where it is off.
    if (from === undefined || to === undefined) { danglingEdges++; continue; }
    const key = JSON.stringify([from, e.label, to]);
    const hit = rel.get(key);
    if (hit) hit.count++;
    else rel.set(key, { from, to, label: e.label, count: 1 });
  }

  const byType = new Map<string, { facts: number; chrono: number; files: number }>();
  for (const [kind, rows] of Object.entries(input.links) as Array<['facts' | 'chrono' | 'files', string[][]]>) {
    for (const ids of rows) {
      // A record linking three entities of the SAME type counts ONCE for that type. "How many facts
      // mention a service" must not double because one fact mentions two services.
      const seen = new Set<string>();
      for (const id of ids) {
        const t = typeOf.get(id);
        if (t !== undefined) seen.add(t);
      }
      for (const t of seen) {
        const hit = byType.get(t) ?? { facts: 0, chrono: 0, files: 0 };
        hit[kind]++;
        byType.set(t, hit);
      }
    }
  }

  const names = new Set<string>([...observed.keys(), ...Object.keys(input.declared)]);
  const entityTypes: ErEntityType[] = [...names].map(type => {
    const schema = input.declared[type];
    const props = schema?.propertySchemas ?? {};
    return {
      type,
      count: observed.get(type) ?? 0,
      declared: schema !== undefined,
      ...(schema?.namingPattern ? { namingPattern: schema.namingPattern } : {}),
      properties: Object.entries(props).map(([name, p]) => ({
        name,
        ...(p.type ? { type: p.type } : {}),
        required: p.required === true,
        ...(p.enum ? { enumValues: p.enum } : {}),
      })),
      linkedFrom: byType.get(type) ?? { facts: 0, chrono: 0, files: 0 },
    };
  });

  // Biggest first: someone opening this wants the SHAPE of the space, and the shape is carried by the types
  // that hold records. An undeclared type with records outranks a declared empty one, deliberately — the
  // undeclared ones are the ones nobody knows about.
  entityTypes.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  return {
    spaceId: input.spaceId,
    entityTypes,
    relationships: [...rel.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)),
    danglingEdges,
    truncated: input.truncated,
    totals: input.totals,
  };
}

/**
 * Build the ER model for one space.
 *
 * Every count is a real count of stored records. Nothing here is estimated, and nothing is hidden — a
 * capped read reports itself in `truncated`.
 */
export async function buildErModel(spaceId: string): Promise<ErModel> {
  const entities = col<EntityDoc>(spaceCollection(spaceId, 'entities'));
  const edges = col<EdgeDoc>(spaceCollection(spaceId, 'edges'));

  const [totalEntities, totalEdges] = await Promise.all([
    entities.countDocuments({}),
    edges.countDocuments({}),
  ]);

  // Read through the covering indexes: `{ name: 1, type: 1 }` carries `_id`, as every index does, and the
  // unique `{ from: 1, to: 1, label: 1 }` is exactly the three fields the grouping needs. No document
  // bodies are fetched, and there is no `$lookup` per edge.
  const [entityRows, edgeRows] = await Promise.all([
    entities.find({}, { projection: { type: 1 }, limit: ER_ENTITY_SCAN_LIMIT })
      .toArray() as Promise<Array<{ _id: string; type?: string }>>,
    edges.find({}, { projection: { from: 1, to: 1, label: 1 }, limit: ER_EDGE_SCAN_LIMIT })
      .toArray() as Promise<Array<{ from: string; to: string; label: string }>>,
  ]);

  const links: ErInputs['links'] = { facts: [], chrono: [], files: [] };
  let linksTruncated = false;
  // Through the shared link classes, so the diagram counts what a traversal would reach. This scan had no
  // chunk exclusion of its own: a file split into forty passages could have contributed forty link rows and
  // drawn a relationship forty times thicker than it is.
  /*
   * ENTITY classes only, and that is what an ER model IS rather than a narrowing.
   *
   * `LINK_CLASSES` holds six since 4.0, three of which name a fact or a chrono entry. Those are real links
   * and a traversal reaches them — but this diagram draws ENTITY TYPES and the relationships between them,
   * so a file naming a chrono entry has no entity type at either end and no row to contribute. Included, the
   * three would each be counted under a `cls.collection` bucket that already has an entry, and `files`
   * appears three times: the last class written would silently replace the first two.
   */
  for (const cls of LINK_CLASSES) {
    if (cls.toKind !== 'entity') continue;
    const { groups, truncated } = await linkGroupsOfClass(spaceId, cls, ER_ENTITY_SCAN_LIMIT);
    if (truncated) linksTruncated = true;
    links[cls.collection] = groups;
  }

  // The first cap hit wins the report. One name is enough to tell a reader the diagram is partial; listing
  // all three would suggest they are independently interesting, and they are not.
  const truncated: ErModel['truncated'] =
    entityRows.length >= ER_ENTITY_SCAN_LIMIT ? { scan: 'entities', limit: ER_ENTITY_SCAN_LIMIT }
      : edgeRows.length >= ER_EDGE_SCAN_LIMIT ? { scan: 'edges', limit: ER_EDGE_SCAN_LIMIT }
        : linksTruncated ? { scan: 'links', limit: ER_ENTITY_SCAN_LIMIT }
          : null;

  return assembleErModel({
    spaceId,
    entities: entityRows,
    edges: edgeRows,
    links,
    declared: (getSpaceMeta(spaceId)?.typeSchemas?.entity ?? {}) as DeclaredTypes,
    totals: { entities: totalEntities, edges: totalEdges },
    truncated,
  });
}
