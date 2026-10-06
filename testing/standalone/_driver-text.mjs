/**
 * Does a body carry the DRIVER'S words — the fault's marker host, its address, its port, a pool's own sentence?
 *
 * The question a store-failure gate asks of every answer, and the one a scrape answers wrongly if it is asked as a bare
 * substring: a Prometheus body is hundreds of numbers (`nodejs_heap_size_total_bytes 27017216`), and a port written as
 * the digits `27017` is inside one of them often enough to fail a suite on a run where nothing leaked (preflight,
 * b53 g34: `GET /metrics` matched on a loaded machine and on none of three quiet reruns). A port, an address and a host
 * are TOKENS: a digit or a dot on either side makes it part of a number or a longer address, not the driver's text.
 *
 * Returns the first match as `{ text, index }`, or `null`. Callers show the text AROUND the index, because a long body
 * leaks somewhere past its first characters.
 */
const NOT_INSIDE_A_NUMBER_BEFORE = '(?<![\\d.])';
const NOT_INSIDE_A_NUMBER_AFTER = '(?!\\d|\\.\\d)';
const NUMERIC_TOKENS = ['172\\.16\\.0\\.9', '27017']
  .map(t => `${NOT_INSIDE_A_NUMBER_BEFORE}${t}${NOT_INSIDE_A_NUMBER_AFTER}`);
const WORDS = ['mongo-a\\.internal', 'Connection pool for', 'MongoPoolClearedError'];

export const DRIVER_TEXT = new RegExp([...NUMERIC_TOKENS, ...WORDS].join('|'));

export function driverTextIn(body) {
  const m = DRIVER_TEXT.exec(String(body));
  return m ? { text: m[0], index: m.index } : null;
}
