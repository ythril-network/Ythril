/**
 * The request context of the `network_sync` tool door, for a test that calls `tool.handle(ctx)` itself.
 *
 * ## Why a module (bundle-39)
 *
 * Two tests wrote the same nine-field context by hand (`shutdown-lets-a-running-sync-stop-at-its-page-db`, `network-sync-takes-wait-and-timeout-on-both-doors-db`);
 * a field the tool reads and a hand copy lacked would fail one test and not the other. The response a REST handler is driven with is `fakeRes` from
 * `_vote-round-instance.mjs`, which every standalone door test shares: a different response shape is named where a test needs one.
 *
 * ## What it prevents
 *
 * A context that drifts from the one the tool door builds: one field list, so a field the tool starts to read is added once.
 */

/** The context `network_sync` is handed on `transport` (`'mcp'` by default), with `args` as the tool's arguments. */
export const syncToolCtx = (args, transport = 'mcp') => ({
  args, name: 'network_sync', transport, callSpace: undefined, callSpaces: [], accessibleSpaceIds: [], viewReads: new Map(),
  accessibleSpaces: [], cfg: {}, rateKey: 'test', actor: { tokenLabel: 'test' },
});
