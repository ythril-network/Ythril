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
 * {@link countRecordsOfSpaces} answers many spaces at once and says which of them failed, so a listing can go on without one space's
 * count and name it (`countsIncomplete`) instead of failing whole or reading it as empty (Q-332).
 */
import { col } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { log, peerList, peerText } from '../util/log.js';
import { warnOnce, SAY_ONCE_WINDOW_MS } from '../util/warn-once.js';

/** The sets of failed spaces whose count failure was logged in this window, so a listing repeated while a space stays broken logs it once. */
const countFailureSaid = warnOnce<string>({ max: 64, every: SAY_ONCE_WINDOW_MS });

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

/** A space a listing counts, with what the caller reads for it (`readSpacesOfRequest`, `readSpacesOfCall`). */
export type SpaceToCount = { id: string; memberIds: readonly string[] };

/**
 * The counts of a listing: each space's counts by id, and the ids of the spaces whose count FAILED. A failed space is in
 * `countsIncomplete` and has no entry in `countsBySpaceId`; the other spaces are counted whatever happened to it.
 */
export type SpaceListCounts = { countsBySpaceId: Record<string, RecordCounts>; countsIncomplete: string[] };

/**
 * Count every space of a listing, one failed space not failing the others (`Promise.allSettled`).
 *
 * The failure is logged once for the listing, naming the spaces and the first reason (and once per window while the same spaces keep
 * failing: a listing where every count succeeds starts the next failure as news), and the failed space is answered as failed:
 * REST and MCP both leave its `counts` out and list it in `countsIncomplete`. Before, REST left the counts out and said nothing,
 * and MCP answered `{ facts: 0, entities: 0, edges: 0, chrono: 0 }`, which is what an empty space answers, so an agent choosing
 * a space to recall from left a space full of records alone.
 */
export async function countRecordsOfSpaces(spaces: readonly SpaceToCount[]): Promise<SpaceListCounts> {
  const settled = await Promise.allSettled(spaces.map(s => countRecords(s.memberIds)));
  const countsBySpaceId: Record<string, RecordCounts> = {};
  const countsIncomplete: string[] = [];
  let firstFailure: unknown;
  settled.forEach((result, i) => {
    const id = spaces[i]!.id;
    if (result.status === 'fulfilled') { countsBySpaceId[id] = result.value; return; }
    if (countsIncomplete.length === 0) firstFailure = result.reason;
    countsIncomplete.push(id);
  });
  if (countsIncomplete.length === 0) {
    // Every count succeeded: the condition cleared, so the next failure is news again.
    countFailureSaid.forgetAll();
  } else {
    // Said once per window for one set of failed spaces: an agent lists its spaces at the start of every task, and a space that
    // stays broken would otherwise write this line on every call.
    countFailureSaid([...countsIncomplete].sort().join(','), () => {
      log.warn(`Counting records failed for ${peerList(countsIncomplete, ', ')}; listed without counts: ${peerText(firstFailure)}`);
    });
  }
  return { countsBySpaceId, countsIncomplete };
}
