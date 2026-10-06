/**
 * A freezable relay hands back the port it listens on (bundle-53 G25, from G10).
 *
 * A caller that builds its own URI (`openTestMongo(suffix, { port })`, a door that takes a port) used to parse `relay.address`
 * (`127.0.0.1:<port>`) for it — three tests did, each its own `split(':')`. `startTcpRelay` already returns `port`; the freezable
 * relay that wraps it dropped it. The number is the one `address` and `uri` carry, so this holds the three to each other rather than
 * to a literal.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-freezable-relay-exposes-its-port-db.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { startFreezableRelay } from './_freezable-relay.mjs';

const skip = await mongoSkipReason();

describe('a freezable relay exposes its port', { skip }, () => {
  it('port is a number, and it is the port of its address and of its URI', async () => {
    const relay = await startFreezableRelay('relayport');
    try {
      assert.equal(typeof relay.port, 'number', 'the relay does not expose its port');
      assert.ok(Number.isInteger(relay.port) && relay.port > 0 && relay.port < 65536, `port ${relay.port} is not a port`);
      assert.equal(relay.address, `127.0.0.1:${relay.port}`, 'address and port disagree');
      assert.ok(relay.uri.includes(`:${relay.port}/`), `the URI ${relay.uri.replace(/\/\/[^@]*@/, '//<credentials>@')} does not point at port ${relay.port}`);
    } finally {
      await relay.close();
    }
  });
});
