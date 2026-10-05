/**
 * The log lines the server EMITTED while something ran — as a log reader splits them.
 *
 * ## Why a module
 *
 * The -db tests that ask "what did the log say": the forge test (`a-peer-value-cannot-forge-a-log-line-db`, whose own copy
 * it replaced) and the two `Q-214` / `Q-270` tests beside it. The question has one honest answer and two
 * ways to get it subtly wrong, which is what this module is for.
 *
 * ## The two things a hand-written copy drops
 *
 * **The emitted line, not the call.** Patching `log.warn` (as `_pull-door.mjs`'s `logsDuring` does, for a different
 * question: WHICH warnings) sees the arguments before `fmt` builds the line, so it cannot see what `fmt` does to them
 * — the meta argument, the redaction, any bound. This subscribes to the ring (`subscribeLogLines`), which receives
 * exactly the line that `console` and the log viewer receive.
 *
 * **Splitting the way a reader splits.** One emitted line holding `\r\n` is TWO lines to every log reader, and the
 * second is the forgery. So the result is split on CR, LF and the two Unicode separators; a test asserting "no line
 * starts with X" is asserting about what an operator would read.
 *
 * The console is silenced while it runs: a case that sends a megabyte would otherwise print a megabyte to the test
 * report on a tree where the bound is missing, which is the tree the case exists to fail on.
 */
const LINE_END = new RegExp(`\\r\\n|\\r|\\n|${String.fromCharCode(0x2028)}|${String.fromCharCode(0x2029)}`);

let logMod;

/**
 * Every line the server logged while `fn` ran (any level), split as a log reader splits them, and `fn`'s result.
 *
 * @template T
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<{ lines: string[], emitted: string[], result: T }>} `emitted` is the lines as the ring received
 *   them, unsplit — for a question about one line's LENGTH.
 */
export async function logLinesDuring(fn) {
  logMod ??= await import('../../server/dist/util/log.js');
  const emitted = [];
  const stop = logMod.subscribeLogLines(l => emitted.push(l));
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  let result;
  try { result = await fn(); } finally { Object.assign(console, saved); stop(); }
  return { lines: emitted.flatMap(l => l.split(LINE_END)), emitted, result };
}
