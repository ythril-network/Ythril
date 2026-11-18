/**
 * How many records does this space hold? One module counts the four knowledge collections of a space for every door.
 *
 * ## What it prevents
 *
 * Four doors answered a space's counts and each wrote the four-collection count out by hand: REST stats, MCP `space_stats`,
 * `GET /api/spaces?counts=true` and MCP `list_spaces`. REST stats counted facts with a function of its own (`countFacts`) and the
 * others with `countDocuments()`, so a change to what a fact count means reached one door and not the next. The count is written
 * here once, `a-spaces-record-counts-are-read-from-one-module` refuses a file that counts three or more of the four collections
 * itself, and the stats body that adds the files and the embed queue to it is built once in `spaces/space-meta-answer.ts`
 * (`spaceStatsAnswer`).
 *
 * ## What is counted
 *
 * Facts, entities, edges and chrono entries, each by `countDocuments()`. `memberIds` is what the caller READS for the space it
 * names (`readSpacesOfRequest`, `readSpacesOfCall`): the space itself, or the members of a personal view, whose figures are summed.
 * An empty list is a view that reads nothing for this caller, and its counts are zero because it holds nothing for them; the caller
 * decides that, never this module by falling back to every space.
 *
 * ## Why it imports nothing of the app
 *
 * The server's import cycle has a ceiling that only goes down (`check-i-architecture-dependency-direction`). A module the MCP tools
 * import that itself imports a member of the cycle becomes one, so this one reaches only the database layer and the log. A count that
 * needs a member of the cycle (the embed queue, the files waiting for their bytes) is built where a member already lives.
 *
 * A count that FAILS throws from {@link countRecords}: nothing here answers a failure with zeros, which an empty space also answers.
 */
import { col } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';

/** The four knowledge collections' record counts of a space. */
export type RecordCounts = { facts: number; entities: number; edges: number; chrono: number };

/** One concrete space's four counts. */
async function recordsOf(spaceId: string): Promise<RecordCounts> {
  return {
    facts: await col(spaceCollection(spaceId, 'facts')).countDocuments(),
    entities: await col(spaceCollection(spaceId, 'entities')).countDocuments(),
    edges: await col(spaceCollection(spaceId, 'edges')).countDocuments(),
    chrono: await col(spaceCollection(spaceId, 'chrono')).countDocuments(),
  };
}

/** The record counts of what a caller reads for one named space, summed over `memberIds`. */
export async function countRecords(memberIds: readonly string[]): Promise<RecordCounts> {
  const perMember = await Promise.all(memberIds.map(recordsOf));
  return {
    facts: perMember.reduce((n, c) => n + c.facts, 0),
    entities: perMember.reduce((n, c) => n + c.entities, 0),
    edges: perMember.reduce((n, c) => n + c.edges, 0),
    chrono: perMember.reduce((n, c) => n + c.chrono, 0),
  };
}
