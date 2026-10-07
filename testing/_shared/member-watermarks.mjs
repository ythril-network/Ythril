/**
 * Every per-space watermark declared on `NetworkMember`, READ OUT OF THE TYPE.
 *
 * ## Why this is one module
 *
 * A network member carries several `spaceId -> position` maps, and three separate rules apply to the same
 * set: a counter wipe has to clear the ones measured against the counter, a space rename has to carry all of
 * them across, and the sync engine advances them. Two gates had each grown their own copy of the same
 * regex over the same interface — the second one written by somebody who did not know the first existed,
 * which is the standing rule about a module named for its first caller.
 *
 * Owner rule: *"Wherever possible reuse modules or build modules to be reused and perfectly maintainable."*
 *
 * ## What it is for, and it is not a naming convention this file invented
 *
 * The DEFECT it derives against: `resetStaleWatermarks` cleared `lastSeqReceived` and left the other three,
 * and each of those fails in a different direction — a stale pull position silently skips a peer's backlog,
 * a stale retention floor prunes a tombstone that has not been delivered. A gate asserting "it handles
 * `lastSeqReceived`" passed on exactly the code that had the bug.
 *
 * So the set comes from the interface, where a fifth map is added by somebody who has no reason to open
 * either rule's file.
 *
 * ## The floor is inside
 *
 * A regex that stops matching returns `[]`, and every loop written over `[]` reports clean. `memberWatermarks`
 * throws instead — a caller cannot receive that failure quietly.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../standalone/_strip-comments.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = 'server/src/config/types-networks.ts';

/**
 * The per-space maps on `NetworkMember`, as field names.
 *
 * `field?: Record<string, number|string>` — a position per space, whatever it counts and whatever it is called
 * (`lastSeqServed`, and `tombstoneRereadAt`, the state of the one-time re-read, which a rename must carry and a
 * wipe must re-owe all the same). The value type is part of the pattern on purpose: `Record<string, number>` is a
 * position and `Record<string, string>` is a timestamp or a cursor, and all are watermarks; anything else on the
 * interface is not keyed by space at all. A name pattern (`last…`) was the second thing that could rot here: the
 * first map that did not start with it was outside every gate built on this.
 *
 * @param {number} [floor] the minimum that means the scan worked
 * @returns {string[]} field names, in declaration order
 */
export function memberWatermarks(floor = 4) {
  const src = stripComments(readFileSync(join(REPO_ROOT, TYPES), 'utf8'));
  const at = src.indexOf('interface NetworkMember');
  if (at === -1) throw new Error(`${TYPES} no longer declares interface NetworkMember — re-anchor this helper`);
  const iface = src.slice(at, src.indexOf('\n}', at));
  const found = [...iface.matchAll(/^\s*([A-Za-z]+)\??:\s*Record<string,\s*(?:number|string)>/gm)]
    .map(m => m[1]);
  if (found.length < floor) {
    throw new Error(
      `only ${found.length} per-space watermark(s) found on NetworkMember, with a floor of ${floor}. The scan `
      + 'is broken, not the type: an empty set passes every loop written over it, so this fails loudly rather '
      + 'than reporting that every rule covers every watermark.');
  }
  return found;
}
