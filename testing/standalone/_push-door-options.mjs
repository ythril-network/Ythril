/**
 * The options of `openPushDoor` (`_push-door.mjs`) that cancel each other, refused at the call.
 *
 * ## The question it answers
 *
 * "Can these two ways of reconnecting the server's Mongo client both be asked for?" They cannot: `monitorCommands` reconnects
 * with command monitoring (`...&monitorCommands=true`), `mongoQuery` reconnects with the options a test passes (a `timeoutMS`, say),
 * and the second reconnect replaces the first one's URI. Handing both used to drop the monitoring in silence, so a test that went
 * on to call `commandsDuring` asserted over an empty command list: `commandsDuring` does assert that monitoring is on, but it
 * reads the option, and the option was true.
 *
 * ## What it prevents
 *
 * The docblock said "not with `monitorCommands`". A sentence is not a guard; the call refuses.
 *
 * Its own file, with no import of the database harness, so a gate over it runs in the pure subset: `_push-door.mjs` makes
 * whatever imports it a database file (`testing/_shared/standalone-split.mjs`).
 */

/** @throws {Error} when both are asked for */
export function refuseConflictingPushDoorOptions({ monitorCommands, mongoQuery } = {}) {
  if (monitorCommands && mongoQuery) {
    throw new Error('openPushDoor: monitorCommands and mongoQuery cannot be combined: the second reconnect replaces the first one\'s connection string, so the command monitoring would be dropped without a word');
  }
}
