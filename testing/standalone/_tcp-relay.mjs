/**
 * A TCP relay in front of a test service: the client connects to the relay, the relay connects to the real service, and
 * bytes go both ways until either side goes. The ONE shell under the test MongoDB's two fault relays
 * (`_write-faults.mjs` `driverWriteFailures` and `_delayed-write-relay.mjs`).
 *
 * ## The question it answers
 *
 * "How do I sit between a client and a service I cannot change, so that I can break or slow the connection on purpose?"
 *
 * ## What it prevents
 *
 * The shell is the half a copy gets wrong, and both relays had written it:
 *
 * - **An unhandled `'error'`.** A relay is reset on purpose; a socket with no `'error'` listener turns the reset into an
 *   uncaught exception that ends the test process. Every socket here swallows its own.
 * - **One half left open.** When either side closes, the other is destroyed with it: a client whose upstream is gone
 *   must see the connection end, or the driver never notices the store went away.
 * - **A write after the upstream died.** What a caller's hook forwards reaches the upstream only while it is alive;
 *   a delayed forward whose timer fires late is dropped, not thrown.
 * - **A `close()` that leaves connections.** `close()` stops listening and resets every live connection (the listener is
 *   `local-server.mjs`'s, which also tracks the accepted sockets), and is safe to call twice.
 *
 * ## The one hook
 *
 * What differs between the first two relays is only what happens to the CLIENT's bytes on their way to the server, so that
 * is the option `clientToServer`: called once per connection with a `forward(bytes)` that writes to the upstream, it
 * returns the function that receives each chunk the client sends. Omitted, bytes pass straight through. It is a factory,
 * not a function, so a relay that frames messages or keeps an ordering chain holds that state per connection and cannot
 * leak it between clients.
 *
 * `serverToClient` is its mirror, for the relay that must stop what the SERVER says (`_freezable-relay.mjs`: a store
 * that has frozen answers nothing, with its sockets open, and in streaming-heartbeat mode the monitor's replies are
 * pushed by the server): called once per connection with a `forward(bytes)` that writes to the client, it returns the
 * function that receives each chunk the server sends. It is a hook here and not a second relay because the one-relay gate
 * (`a-tcp-relay-is-one-module.test.js`) refuses any other `net.createServer` that dials a service. Omitted, replies are
 * piped as before, backpressure included; given, they arrive as chunks and the hook decides.
 *
 * Binds 127.0.0.1 only.
 */
import net from 'node:net';
import { listenOnLoopback } from '../_shared/local-server.mjs';

/**
 * @param {{ host: string, port: number,
 *   clientToServer?: (forward: (bytes: Buffer) => void) => (chunk: Buffer) => void,
 *   serverToClient?: (forward: (bytes: Buffer) => void) => (chunk: Buffer) => void }} opts
 *   `host` and `port` are the real service
 * @returns {Promise<{ port: number, address: string, close: () => Promise<void> }>} `port` / `address` are the relay's own
 */
export async function startTcpRelay({ host, port, clientToServer = (forward) => forward, serverToClient }) {
  const upstreams = new Set();
  const server = net.createServer((inbound) => {
    const outbound = net.connect(port, host);
    upstreams.add(outbound);
    outbound.on('close', () => upstreams.delete(outbound));
    for (const socket of [inbound, outbound]) socket.on('error', () => {});
    if (serverToClient) {
      outbound.on('data', serverToClient((bytes) => { if (!inbound.destroyed) inbound.write(bytes); }));
    } else {
      outbound.pipe(inbound);
    }
    const forward = (bytes) => { if (!outbound.destroyed) outbound.write(bytes); };
    inbound.on('data', clientToServer(forward));
    inbound.on('close', () => outbound.destroy());
    outbound.on('close', () => inbound.destroy());
  });
  const local = await listenOnLoopback(server);
  return {
    port: local.port,
    address: `127.0.0.1:${local.port}`,
    async close() {
      for (const upstream of upstreams) upstream.destroy();
      await local.close();
    },
  };
}
