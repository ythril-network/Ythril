/**
 * Local-agent URL loopback validation.
 *
 * Guards a deliberate security decision AND a config↔code alignment that had drifted:
 *
 *  - `isLoopbackHost` accepts ONLY numeric loopback (127.0.0.1 / ::1). `localhost` is intentionally
 *    rejected — it resolves via DNS/hosts and could be remapped to a non-loopback address, which would
 *    let the bearer token be sent off-box. Someone "fixing" a config mismatch by adding `localhost`
 *    here would reopen that hole; this test makes that regression fail loudly.
 *  - `LOCAL_AGENT_DEFAULT_URL` is the numeric-loopback default the server falls back to, and is the
 *    value docker-compose.yml's base default must match (it previously shipped `http://localhost:38123`,
 *    which the validator then rejected unless YTHRIL_LOCAL_AGENT_ALLOW_REMOTE=true).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isLoopbackHost, LOCAL_AGENT_DEFAULT_URL } from '../../server/dist/api/local-agent-url.js';

describe('local-agent URL validation', () => {
  it('accepts numeric loopback hosts', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('::1'), true);
  });

  it('rejects localhost (DNS/hosts-resolved — deliberately not loopback)', () => {
    assert.equal(isLoopbackHost('localhost'), false);
    assert.equal(isLoopbackHost('LOCALHOST'), false);
  });

  it('rejects other/non-loopback hosts', () => {
    for (const h of ['0.0.0.0', 'host-gateway', 'example.com', '10.0.0.5', '169.254.1.1', '127.0.0.1.evil.com', '']) {
      assert.equal(isLoopbackHost(h), false, `expected ${JSON.stringify(h)} to be rejected`);
    }
  });

  it('the default URL is a numeric-loopback host the validator accepts (matches compose base default)', () => {
    // The port is the connector's own default, read from where the connector sets it (importing it would start the connector).
    const connector = readFileSync('server/src/local-agent-connector/index.ts', 'utf8');
    const connectorPort = connector.match(/envInt\(\s*'YTHRIL_CONNECTOR_PORT'\s*,\s*(\d+)\s*\)/)?.[1];
    assert.ok(connectorPort, 'local-agent-connector/index.ts no longer reads its port as envInt(\'YTHRIL_CONNECTOR_PORT\', <default>): re-anchor this read');
    assert.equal(new URL(LOCAL_AGENT_DEFAULT_URL).port, connectorPort, 'the server dials the connector on a port the connector does not listen on by default');
    assert.equal(isLoopbackHost(new URL(LOCAL_AGENT_DEFAULT_URL).hostname), true);
  });
});
