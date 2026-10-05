/**
 * A port on 127.0.0.1 that nothing listens on: the address a test of "the instance cannot be reached" points at.
 *
 * ## The question it answers
 *
 * "Where do I send a request that is certain to be refused?" It was written twice, inline: bind a server on port 0, read
 * the port it was given, release it. Guessing a number (`9`, `1`, `65000`) is the trap this prevents: a port that is
 * closed on this machine is open on the next, and a test that connects to a service that happens to be there reports an
 * answer where it meant to provoke a refusal.
 *
 * ## The one limit, said once
 *
 * Between the release and the caller's connect another process could take the port. The operating system hands out
 * ephemeral ports in rotation rather than reusing the one just freed, so it does not happen in practice; a test that
 * cannot tolerate even that has to hold a listener that refuses (there is no such test here).
 */
import net from 'node:net';
import { listenOnLoopback } from './local-server.mjs';

/** @returns {Promise<number>} a loopback port with no listener */
export async function closedLoopbackPort() {
  const probe = await listenOnLoopback(net.createServer());
  const { port } = probe;
  await probe.close();
  return port;
}
