/**
 * Environment a test changes, put back as it was: the ONE save-and-restore for `process.env` in a test file.
 *
 * ## The question it answers
 *
 * *"What were these variables before this file touched them, and how do I put them back?"* A test that switches a
 * limiter's kill-switch off, or sets TRUST_PROXY for one app, must leave the process as it found it, or the next file
 * in the same process inherits a limiter it never asked for.
 *
 * ## What it prevents
 *
 * Two bundle-233 files each wrote their own copy over `Object.entries(saved)`. A variable that was unset before is
 * deleted again rather than set to the string "undefined".
 *
 * ## Why it refuses a figure name
 *
 * The bound gate (`a-test-bounds-only-the-operation-it-holds.test.js`) holds every `process.env.<NAME_MS>` a test sets
 * to a figure it can read. This module restores by name, which the gate cannot follow, so it refuses outright any name
 * that is a figure (ending in `MS`): a bound can never be set or put back through here unseen. Restoring goes through
 * `Object.assign` and `delete`, which carry no figure because the names are checked first.
 *
 * @param {string[]} names the variables to keep; none may be a figure (a name ending in `MS`)
 * @returns {() => void} puts each variable back: its old value, or deleted when it had none
 */
export function keepEnv(names) {
  const figures = names.filter(name => /MS$/i.test(name));
  if (figures.length) throw new Error(`keepEnv keeps no timing figure (${figures.join(', ')}): set and restore a bound where the bound gate can read it`);
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  return () => {
    const restored = {};
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else restored[name] = before[name];
    }
    Object.assign(process.env, restored);
  };
}
