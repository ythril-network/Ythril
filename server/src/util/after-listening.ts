/**
 * Work that must not compete with a starting server runs once it is LISTENING — the one place that question is
 * answered (bundle-30 I8).
 *
 * ## What this prevents
 *
 * The bootstrap (`startConfiguredInstanceServices`) runs before `index.ts` calls `listen` on a configured boot, and
 * after it on the setup route. Background work it started at once — the boot suppression sweep: an unindexed scan per
 * record kind of every space — competed with the boot's index builds and held the port closed for nothing. Handed to
 * `afterListening`, it waits for the listen on a boot, and runs at once on the setup route, where the server has
 * long been listening; neither caller has to know which case it is in.
 *
 * `markListening` is called from the listen callback, and a process that never listens (a test calling the
 * bootstrap's pieces directly) never runs held work — which is the point of holding it.
 */

let listening = false;
const held: Array<() => void> = [];

/** Run `work` once the server listens: now if it already does, else when `markListening` is called. */
export function afterListening(work: () => void): void {
  if (listening) work();
  else held.push(work);
}

/** The server is listening: run what was held, in the order it was handed over. Called once, from the listen callback. */
export function markListening(): void {
  listening = true;
  for (const work of held.splice(0)) work();
}
