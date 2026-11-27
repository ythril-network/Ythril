/**
 * The phases a `Server-Timing` header names, read the way a client reads them (bundle-378, Q-976, S1): the phase specs import the harness's own
 * parser from here (`benchmarks/rdf/server-timing.mjs`, which `door-floor.mjs` and `run.mjs` read as well), so a spec and the measurement read one
 * header alike. This file holds no parser of its own: `bsbm-harness-server-timing.test.js` fails one written here.
 *
 * ## What it prevents
 *
 * A spec that matched a phase name anywhere in the header text would pass on `members` inside another entry's description; the parser splits the
 * header into its entries (`name;dur=<ms>;desc="n=<count>"`) and answers each entry by name, with its count. A header that is absent answers
 * `null`, never an empty map, so a spec cannot read "no phases" as "no header".
 */
export { serverTimingOf, mcpTimingOf, mcpCallResult } from '../../benchmarks/rdf/server-timing.mjs';
