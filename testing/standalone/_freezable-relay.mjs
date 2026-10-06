/**
 * A relay in front of the test MongoDB that can FREEZE: stop carrying bytes in both directions while every socket stays
 * open - the condition `docker pause` makes, and the one a closed port does not (Q-329, bundle-53).
 *
 * ## The question it answers
 *
 * "What does the code do when the store stops answering but the connection is still there?" A store that is DOWN is easy
 * to produce and easy for the driver to notice: the connection is refused or reset at once. A store that is FROZEN is the
 * failure that took 40-50 seconds to be told from a slow one, because nothing ever says it has gone: the driver only
 * learns from its own heartbeat timing out. Everything that asks how quickly an in-flight operation ends when the store
 * freezes, or whether a walk over many spaces pays one bound or one per space, needs a store that freezes on demand.
 *
 * ## What it prevents
 *
 * **A freeze that froze nothing.** A relay whose `freeze()` is a no-op, a relay the client was never connected through, or
 * a freeze that drops bytes in only one direction lets every "the client notices a dead store" test pass over a store
 * that was never dead. So `startFreezableRelay` runs `assertRelayFreezes` before it hands the relay back, and THROWS
 * (after closing the relay) unless: after `freeze()` a real operation through it does not settle inside a short window;
 * no byte is forwarded in either direction while frozen, and the operation's bytes were seen and dropped (it went through
 * the relay, it was not simply never sent); and after `thaw()` the store answers again.
 *
 * ## What freeze does to the bytes
 *
 * It DROPS them, in both directions, and keeps both sockets open. A byte sent while frozen is gone, so a connection that
 * was mid-conversation does not resume after `thaw()`: the operation on it ends by the client's own timeout, and the next
 * one opens a new connection - what a real pause that outlasts the driver's detection looks like from the client.
 *
 * ## Layering
 *
 * Built ONLY on `startTcpRelay` (`_tcp-relay.mjs`); the one-relay gate refuses a second `net.createServer` that dials a
 * service. Freezing the server's bytes is what the relay's `serverToClient` hook is for.
 *
 * Imports the harness, so a test that uses it is a `-db` test.
 */
import { MongoClient } from 'mongodb';
import { startTcpRelay } from './_tcp-relay.mjs';
import { testMongoUri, TEST_MONGO_HOST, TEST_MONGO_PORT } from './_mongo-harness.mjs';
import { settleWithin, eventually } from './_write-faults.mjs';

/** How long an operation through a frozen relay must stay unsettled for the freeze to count, ms. */
const FREEZE_WINDOW_MS = 400;
/** The bound on the operation the guard starts while frozen, ms: well past the window, so only the freeze can explain it. */
const FROZEN_OP_TIMEOUT_MS = 1_500;
/** How long the store gets to answer again after `thaw()`, ms. */
const RECOVERY_MS = 15_000;

/**
 * Throw unless `relay` freezes: see the module docblock. `relay` is `{ uri, freeze(), thaw(), flow() }`, where `flow()`
 * returns the bytes carried and dropped so far, `{ toServer, toClient, droppedToServer, droppedToClient }`.
 *
 * The guard's own client lets nothing end the operation before the window does: its heartbeat is long and its
 * connect timeout is generous, so a failure here is the relay's, not the driver's detection firing first.
 *
 * @param {{ uri: string, freeze: () => void, thaw: () => void, flow: () => Record<string, number> }} relay
 * @param {{ recoveryMs?: number }} [o]  how long the store gets to answer again after `thaw()`; a test of the guard itself
 *   shortens it, nothing else should
 */
export async function assertRelayFreezes(relay, { recoveryMs = RECOVERY_MS } = {}) {
  const client = new MongoClient(relay.uri, { serverSelectionTimeoutMS: 5_000, heartbeatFrequencyMS: 10_000, connectTimeoutMS: 5_000 });
  const ping = (options) => client.db('admin').command({ ping: 1 }, options);
  try {
    await client.connect();
    await ping({ timeoutMS: 5_000 });
    relay.freeze();
    const before = relay.flow();
    const frozen = await settleWithin(ping({ timeoutMS: FROZEN_OP_TIMEOUT_MS }), FREEZE_WINDOW_MS);
    const after = relay.flow();
    if (frozen.settled) {
      throw new Error(`assertRelayFreezes: an operation through the relay settled after ${frozen.elapsedMs}ms, inside the ${FREEZE_WINDOW_MS}ms window, `
        + `${frozen.ok ? 'with an answer' : `with ${frozen.error?.name}`}. freeze() did not stop the store answering, so a test of "the client notices a frozen store" would pass over a store that never froze.`);
    }
    if (after.toServer !== before.toServer || after.toClient !== before.toClient) {
      throw new Error(`assertRelayFreezes: bytes were forwarded while frozen (to the server ${after.toServer - before.toServer}, to the client ${after.toClient - before.toClient}). `
        + 'A freeze drops both directions.');
    }
    if (!(after.droppedToServer > before.droppedToServer)) {
      throw new Error('assertRelayFreezes: the operation\'s bytes never reached the relay while it was frozen, so it stalled for a reason that is not the freeze.');
    }
    relay.thaw();
    await frozen.rest.catch(() => {});
    const served = await eventually(async () => {
      try { return (await ping({ timeoutMS: 1_000 })).ok === 1; } catch { return false; }
    }, recoveryMs, 100);
    if (!served) throw new Error(`assertRelayFreezes: the store did not answer again within ${recoveryMs}ms of thaw(), so the relay cannot be put back.`);
  } finally {
    // Thawed BEFORE the client closes: closing ends the client's sessions with a command to the store, which a frozen
    // relay holds for the whole connect timeout (5 s) - a failed guard would otherwise take that long to say so.
    relay.thaw();
    await client.close(true).catch(() => {});
  }
}

/**
 * Start a freezable relay in front of the test MongoDB.
 *
 * @param {string} dbName  the harness database the URI names
 * @param {{ query?: string }} [o]  `query` is extra URI options as an operator would put them in `MONGO_URI`
 *   (`'&connectTimeoutMS=1000&heartbeatFrequencyMS=500'`): the way a test builds a client whose liveness options differ
 *   from the harness's, through the relay
 * @returns {Promise<{ uri: string, address: string, port: number, freeze: () => void, thaw: () => void, flow: () => Record<string, number>,
 *   close: () => Promise<void> }>} `uri` points a client at the relay; `port` is the port it listens on, for a caller that builds its
 *   own URI (`openTestMongo(suffix, { port })`) and used to parse `address` for it; `flow()` is the bytes carried and dropped so far
 */
export async function startFreezableRelay(dbName, { query = '' } = {}) {
  let frozen = false;
  const flow = { toServer: 0, toClient: 0, droppedToServer: 0, droppedToClient: 0 };
  const relay = await startTcpRelay({
    host: TEST_MONGO_HOST,
    port: TEST_MONGO_PORT,
    clientToServer: (forward) => (chunk) => {
      if (frozen) { flow.droppedToServer += chunk.length; return; }
      flow.toServer += chunk.length;
      forward(chunk);
    },
    serverToClient: (forward) => (chunk) => {
      if (frozen) { flow.droppedToClient += chunk.length; return; }
      flow.toClient += chunk.length;
      forward(chunk);
    },
  });
  const handle = {
    uri: testMongoUri(dbName, { port: relay.port, query }),
    address: relay.address,
    port: relay.port,
    freeze() { frozen = true; },
    thaw() { frozen = false; },
    flow: () => ({ ...flow }),
    close: () => relay.close(),
  };
  try {
    await assertRelayFreezes(handle);
  } catch (err) {
    handle.thaw();
    await relay.close();
    throw err;
  }
  return handle;
}
