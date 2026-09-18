/**
 * Convert every unconverted space to link records at boot, so nobody has to run a script.
 *
 * ## The report that made this necessary
 *
 * The canary operator, 2026-09-15T0034Z: `npm run links:convert` **cannot run on a deployed instance**. The
 * npm script survives into the published image and resolves `/app/scripts/convert-links.mjs`; `scripts/`
 * is not copied, so it fails as a Node `MODULE_NOT_FOUND` — a stack trace that reads like a broken
 * installation of theirs rather than a missing file of ours. `04g-links-api.md` documents that script as
 * THE mechanism and there is no second route: the pre-flight only reports, and `POST /links` writes one
 * link at a time, which is not a migration path for a space holding hundreds of array entries.
 *
 * So "spaces converted" was a set a container deployment could not join, and the 5.0 removal of the six
 * link ARRAY fields is gated on exactly that set.
 *
 * Owner's ruling, 2026-09-17: *"make the script autorun at startup when updating to 5.0 to force
 * conversion when updating to >=5.0. remove that on 6.0."*
 *
 * ## Why a BOOT migration is allowed here, when synced data normally must migrate lazily
 *
 * The standing rule is that synced DATA migrates lazily and self-healingly, because a peer running older
 * code writes the old shape back and a boot migration cannot see that happen. **The peer floor is what
 * suspends it.** `MIN_PEER_VERSION` derives from our own major, so a 5.0 instance refuses every 4.x peer
 * at the handshake — the network is homogeneous or it is not a network. `renameMemoriesToFacts` runs at
 * boot in the same release on the same argument.
 *
 * It is also additive, which is the second half of why this is safe. Conversion WRITES link records and
 * never removes an array, and `link-adjacency.ts` reads the arrays for any space without
 * `completeLinkage` — so a space is correct before, during and after, and an interrupted run is fixed by
 * the next boot rather than by working out where it stopped.
 *
 * ## It does not refuse the boot, and that is a decision rather than an omission
 *
 * "Force" here means the operator does not have to run anything: every boot converts what is not yet
 * converted, and there is no command to remember, no `scripts/` to ship, no exec into a container.
 *
 * Exiting on a failed conversion would be the harsher reading and it buys nothing: a space whose walk
 * throws is left UNMARKED, which means it keeps reading its arrays and keeps accepting array writes —
 * exactly the behaviour it had before this ran. Refusing to serve would turn a recoverable data problem
 * into an instance the operator cannot log into to look at it. The failure is loud in the log and visible
 * in the space's own `completeLinkage`, and the next boot retries.
 *
 * **What this DOES guarantee, and what the array removal must still check:** after a successful boot,
 * every space this instance holds is either `completeLinkage` or named in an error. Dropping the arrays
 * is safe for the first set and would lose data for the second, so the removal has to read the marker
 * rather than assume this ran.
 *
 * ## Steady state costs nothing
 *
 * A space that is already `completeLinkage` is skipped outright, not re-walked: the marker makes it refuse
 * array writes, so no new arrays can appear in it. On an instance that has booted once at 5.0 this
 * function reads the space list and returns.
 */
import { getConfig } from '../config/loader.js';
import { convertSpaceLinks } from './links-conversion.js';
import { updateSpace } from '../spaces/spaces.js';
import { log } from '../util/log.js';

/**
 * Convert and mark every space that is not yet converted.
 *
 * Never throws: a failure here must not take down a boot that would otherwise serve correctly, and every
 * outcome is already recorded in the log and in each space's own marker.
 */
export async function convertLinksOnBoot(): Promise<void> {
  try {
    await convertPendingSpaces();
  } catch (err) {
    /*
     * The OUTER guard, and it exists because the inner one was not enough.
     *
     * The per-space `try` below covers a walk that throws. It does not cover this function's own first
     * line: `getConfig()` throws `Config not loaded` before any config exists, and on a first-run boot
     * that took the whole instance down — the module promising it could not take a boot down, broken by
     * the statement that reads the spaces it was going to convert. The call site is guarded too; this is
     * the half that holds whatever the call site does next year.
     */
    log.error(`Link conversion could not run: ${err instanceof Error ? err.message : String(err)}. `
      + 'No space was marked, so every space keeps reading its arrays exactly as before.');
  }
}

async function convertPendingSpaces(): Promise<void> {
  const pending = getConfig().spaces.filter(s =>
    // A proxy holds no documents of its own — it aggregates members, which convert in their own right.
    // Walking one finds nothing and would then mark it complete on the strength of that.
    !(s.proxyFor && s.proxyFor.length > 0) && s.completeLinkage !== true);

  if (pending.length === 0) return;

  log.info(
    `Link conversion: ${pending.length} space(s) not yet converted — converting now. `
    + 'This is the 5.0 migration from the legacy link ARRAY fields to link records. It is additive: '
    + 'nothing is removed, the arrays keep being read until a space is marked, and an interrupted run is '
    + 'fixed by the next boot.');

  const failures: string[] = [];
  for (const space of pending) {
    try {
      const report = await convertSpaceLinks(space.id);
      if (report.failed > 0) {
        failures.push(`${space.id} (${report.failed} document(s) failed to reconcile)`);
        continue;
      }
      // Marked only on a clean walk, which is the same condition the script used. A marked space refuses
      // array writes, so marking one whose walk was partial would start refusing writes for links that
      // were never created.
      updateSpace(space.id, { completeLinkage: true });
      log.info(`Link conversion: ${space.id} converted — ${report.added} link(s) created, marked complete`);
    } catch (err) {
      failures.push(`${space.id} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (failures.length > 0) {
    log.error(
      `Link conversion FAILED for ${failures.length} space(s): ${failures.join('; ')}. `
      + 'Those spaces are NOT marked `completeLinkage`, so they keep reading their arrays and keep '
      + 'accepting array writes — nothing is lost and nothing has changed for them. The next boot retries. '
      + 'Until they convert, the 5.0 removal of the array fields would lose their links.');
  }
}
