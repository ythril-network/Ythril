/**
 * How a reader of `Test-Run` records reads them: the records of a span without their bulky field, and one record's
 * `measurements` text on its own (bundle-356, Q-948).
 *
 * ## The question it answers
 *
 * "Which `Test-Run` records does the instance hold since a moment, and what does one of them say per file?" Asked by
 * `scripts/test-times.mjs` (`--trend --flags` reads a record's per-file times) and `scripts/test-failure-rates.mjs` (each
 * test's failures over the runs that ran it). Reading only: nothing here writes.
 *
 * ## What it prevents
 *
 * - **A short answer read as a whole one.** {@link testRunRowsSince} pages until the server's `total` is held; a walk that
 *   stops before it (the page bound, a server that ignores `skip`) THROWS rather than return the records it happened to get,
 *   so a reader never answers over part of a span as if it were all of it.
 * - **A listing that downloads what it does not read.** `measurements` is up to 400 KB per record; the listing leaves it out
 *   and {@link testRunMeasurements} asks for one record's whole, sized by its `measurementsChars`.
 * - **The server's predicate taken on trust.** A row of another type, or dated before the span, is not returned.
 */
import { YthrilApiError } from './ythril-api.mjs';
import { TEST_RUN_SPEC } from './telemetry-record.mjs';
import { newestBy } from './newest-by.mjs';

const SPACE = TEST_RUN_SPEC.space;
const TYPE = TEST_RUN_SPEC.type;

/** One listing page without `measurements`: records asked for, and the ceiling on the answer in characters. */
const BARE_PAGE = { limit: 200, maxChars: 1_000_000 };
/**
 * One listing page WITH `measurements`: ten records of up to 400 KB each fit the ceiling. A request per record met the instance's
 * per-token rate limit (429) on the first read of a month of records (Q-948); a page of ten is a tenth of the requests.
 */
const MEASURED_PAGE = { limit: 10, maxChars: 5_000_000 };
/** The most pages one listing reads: a bound on a walk whose server may ignore what it is asked. */
const MAX_PAGES = 1000;

/**
 * Every `Test-Run` record whose `startsAt` is at or after `since`, newest first; with `measurements: true` each carries its
 * `measurements` text, read a page at a time, otherwise the listing leaves it out.
 *
 * @param {{ call(tool: string, args?: object): Promise<any> }} api
 * @param {string} since an ISO moment
 * @param {{ measurements?: boolean }} [options]
 * @returns {Promise<object[]>}
 * @throws {YthrilApiError} when an answer carries no rows, or the walk ends before the server's total is held
 */
export async function testRunRowsSince(api, since, { measurements = false } = {}) {
  const page = measurements ? MEASURED_PAGE : BARE_PAGE;
  const held = new Map();
  let skip = 0;
  let total;
  for (let n = 0; n < MAX_PAGES; n++) {
    const answer = await api.call('filter', {
      space: SPACE, collection: 'chrono', filter: { type: TYPE, startsAt: { $gte: since } },
      ...(measurements ? {} : { projection: { 'properties.measurements': 0 } }),
      sort: 'startsAt', dir: 'desc', limit: page.limit, skip, maxChars: page.maxChars,
    });
    const rows = answer?.data?.results;
    if (!Array.isArray(rows)) throw new YthrilApiError('filter: the answer carried no results', { tool: 'filter' });
    if (Number.isFinite(answer.data.total)) total = answer.data.total;
    let fresh = 0;
    for (const r of rows) if (typeof r?._id === 'string' && !held.has(r._id)) { held.set(r._id, r); fresh++; }
    skip += rows.length;
    if (!rows.length || !fresh || (total !== undefined && skip >= total)) break;
  }
  if (total !== undefined && held.size < total) {
    throw new YthrilApiError(`filter: read ${held.size} of the ${total} Test-Run records the server holds since ${since}; an answer over part of them is not given`, { tool: 'filter' });
  }
  return [...held.values()].filter(r => r.type === TYPE && typeof r.startsAt === 'string' && r.startsAt >= since)
    .sort(newestBy('startsAt'));
}

/**
 * One record's `measurements` text, fetched on its own (a listing never carries it), or null when the answer holds none.
 *
 * @param {{ call(tool: string, args?: object): Promise<any> }} api
 * @param {{ _id: string, properties?: { measurementsChars?: number } }} row
 * @returns {Promise<string|null>}
 */
export async function testRunMeasurements(api, row) {
  const chars = Number(row.properties?.measurementsChars);
  const answer = await api.call('filter', {
    space: SPACE, collection: 'chrono', filter: { type: TYPE, _id: row._id }, projection: { 'properties.measurements': 1 }, limit: 1,
    maxChars: Math.min(5_000_000, (Number.isFinite(chars) ? chars : 1_000_000) + 5000),
  });
  const text = answer?.data?.results?.[0]?.properties?.measurements;
  return typeof text === 'string' ? text : null;
}
