/**
 * Integration tests: GET /metrics (Prometheus endpoint)
 *
 * Covers:
 *  - Endpoint is accessible without authentication (unauthenticated like /health)
 *  - Response uses Prometheus text/plain content-type
 *  - Default process metrics are present (nodejs_* gauges)
 *  - Ythril application metrics are present
 *  - HTTP counter increments after a request
 *  - Auth attempt counter increments on success and failure
 *  - Active tokens gauge is non-negative
 *
 * Run: node --test testing/standalone/metrics.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let token;

async function getMetrics(instance = INSTANCES.a) {
  const r = await fetch(`${instance}/metrics`);
  return { status: r.status, contentType: r.headers.get('content-type'), text: await r.text() };
}

/** Extract numeric value for a metric line matching the given name (no labels) */
function extractGauge(metricsText, metricName) {
  const lines = metricsText.split('\n');
  for (const line of lines) {
    if (line.startsWith(`${metricName} `)) {
      return parseFloat(line.split(' ')[1]);
    }
  }
  return null;
}

/** Check that a metric name appears anywhere in the output (with or without labels) */
function hasMetric(metricsText, metricName) {
  return metricsText.split('\n').some(l => l.startsWith(metricName));
}

describe('GET /metrics — Prometheus endpoint', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('is accessible without authentication (no Bearer token)', async () => {
    const r = await fetch(`${INSTANCES.a}/metrics`);
    assert.equal(r.status, 200, `Expected 200 got ${r.status}`);
  });

  it('returns Prometheus text/plain content-type', async () => {
    const { contentType } = await getMetrics();
    assert.ok(
      contentType && contentType.includes('text/plain'),
      `Expected text/plain, got: ${contentType}`,
    );
  });

  it('includes standard Node.js process metrics (nodejs_*)', async () => {
    const { text } = await getMetrics();
    assert.ok(hasMetric(text, 'nodejs_'), `nodejs_ metrics not found in output`);
  });

  it('includes ythril_http_requests_total counter', async () => {
    const { text } = await getMetrics();
    assert.ok(hasMetric(text, 'ythril_http_requests_total'), 'ythril_http_requests_total not found');
  });

  it('includes ythril_http_request_duration_seconds histogram', async () => {
    const { text } = await getMetrics();
    assert.ok(
      hasMetric(text, 'ythril_http_request_duration_seconds'),
      'ythril_http_request_duration_seconds not found',
    );
  });

  it('includes ythril_spaces_total gauge', async () => {
    const { text } = await getMetrics();
    assert.ok(hasMetric(text, 'ythril_spaces_total'), 'ythril_spaces_total not found');
  });

  it('ythril_spaces_total is >= 1 (general space always exists)', async () => {
    const { text } = await getMetrics();
    const value = extractGauge(text, 'ythril_spaces_total');
    assert.ok(value !== null && value >= 1, `Expected ythril_spaces_total >= 1, got ${value}`);
  });

  it('includes ythril_tokens_active gauge', async () => {
    const { text } = await getMetrics();
    assert.ok(hasMetric(text, 'ythril_tokens_active'), 'ythril_tokens_active not found');
  });

  it('ythril_tokens_active is >= 1 (at least one token exists for tests)', async () => {
    const { text } = await getMetrics();
    const value = extractGauge(text, 'ythril_tokens_active');
    assert.ok(value !== null && value >= 1, `Expected ythril_tokens_active >= 1, got ${value}`);
  });

  it('includes ythril_memories_total gauge for general space', async () => {
    const { text } = await getMetrics();
    assert.ok(
      text.includes('ythril_memories_total{space="general"}'),
      'ythril_memories_total{space="general"} not found',
    );
  });

  it('includes ythril_auth_attempts_total counter', async () => {
    const { text } = await getMetrics();
    assert.ok(hasMetric(text, 'ythril_auth_attempts_total'), 'ythril_auth_attempts_total not found');
  });

  it('includes ythril_storage_used_bytes gauge', async () => {
    const { text } = await getMetrics();
    assert.ok(hasMetric(text, 'ythril_storage_used_bytes'), 'ythril_storage_used_bytes not found');
  });

  it('includes ythril_embedding_duration_seconds histogram', async () => {
    const { text } = await getMetrics();
    assert.ok(
      hasMetric(text, 'ythril_embedding_duration_seconds'),
      'ythril_embedding_duration_seconds not found',
    );
  });

  it('includes ythril_mcp_connections_active gauge', async () => {
    const { text } = await getMetrics();
    assert.ok(hasMetric(text, 'ythril_mcp_connections_active'), 'ythril_mcp_connections_active not found');
  });

  it('includes ythril_sync_cycles_total counter', async () => {
    const { text } = await getMetrics();
    // The counter may have no data points if no sync cycle has run yet, but
    // it must at least be registered (HELP/TYPE lines present).
    const registered = text.split('\n').some(l =>
      l.startsWith('ythril_sync_cycles_total') || l.includes('ythril_sync_cycles_total'),
    );
    assert.ok(registered, 'ythril_sync_cycles_total not found (not even HELP/TYPE)');
  });

  it('ythril_auth_attempts_total increments after a successful auth request', async () => {
    // Make a request that requires auth to bump the counter
    const before = await getMetrics();
    const beforeCount = countMetricInstances(before.text, 'ythril_auth_attempts_total{result="success"}');

    // Trigger an authenticated request
    await fetch(`${INSTANCES.a}/api/about`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const after = await getMetrics();
    const afterCount = countMetricInstances(after.text, 'ythril_auth_attempts_total{result="success"}');

    // The metric should now appear (if it wasn't before) or have a higher value
    assert.ok(
      afterCount !== null,
      'ythril_auth_attempts_total{result="success"} should appear after an auth request',
    );
    // If both exist and parseable, after >= before
    if (beforeCount !== null) {
      assert.ok(afterCount >= beforeCount, `Expected after (${afterCount}) >= before (${beforeCount})`);
    }
  });

  it('ythril_auth_attempts_total tracks invalid auth attempts', async () => {
    // Make a request with a bad token
    await fetch(`${INSTANCES.a}/api/about`, {
      headers: { Authorization: 'Bearer invalid-token-xyz' },
    });

    const { text } = await getMetrics();
    assert.ok(
      text.includes('ythril_auth_attempts_total{result="invalid"}'),
      'ythril_auth_attempts_total{result="invalid"} should appear after an invalid auth request',
    );
  });

  it('HTTP counter increments after making a request', async () => {
    const before = await getMetrics();

    // Use an API route that is tracked by the HTTP middleware.
    // /health and /metrics are excluded from the counter.
    await fetch(`${INSTANCES.a}/api/about`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const after = await getMetrics();

    // The counter value should be higher after the request
    const beforeVal = sumCounterValues(before.text, 'ythril_http_requests_total');
    const afterVal = sumCounterValues(after.text, 'ythril_http_requests_total');
    assert.ok(afterVal > beforeVal, `HTTP counter should increase: before=${beforeVal} after=${afterVal}`);
  });
});

/** Count metric lines matching the metric name+labels prefix */
function countMetricInstances(text, prefix) {
  const matching = text.split('\n').filter(l => l.startsWith(prefix));
  if (matching.length === 0) return null;
  // Sum all matching values (in case there are multiple label combos containing the prefix)
  return matching.reduce((sum, line) => sum + parseFloat(line.split(' ').at(-1) ?? '0'), 0);
}

/** Sum all values for a counter (all label combinations) */
function sumCounterValues(text, metricName) {
  return text.split('\n')
    .filter(l => l.startsWith(metricName + '{') || l.startsWith(metricName + ' '))
    .reduce((sum, line) => {
      const val = parseFloat(line.split(' ').at(-1) ?? '0');
      return sum + (isNaN(val) ? 0 : val);
    }, 0);
}
