/**
 * Component liveness reporting — and the line between "report" and "gate".
 *
 * F9 follow-up. The Overview could tell you an instance was up but not whether the pieces it delegates
 * to were, so "documents stopped being extracted" and "the renderer container died" looked identical.
 *
 * ── The distinction these tests exist to protect ────────────────────────────────────────────────
 *
 * `/ready` is an ORCHESTRATION probe: a 503 there takes the instance out of service. Every component
 * reported here is OPTIONAL — the render sidecars are opt-in, the NLI judge ships with no endpoint at
 * all and its scanner is off by default. Folding any of them into readiness would mean a dead
 * doc-render container pulling a healthy instance out of the load balancer, turning a degraded feature
 * into an outage.
 *
 * So the summary must never produce a level that reads as "take this instance down", and an
 * unconfigured component must never read as a fault. A warning that is always on is one nobody reads.
 *
 * Run: node --test testing/standalone/health-summary.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let summariseHealth;
before(async () => {
  ({ summariseHealth } = await import('../../server/dist/api/health-summary.js'));
});

const comp = (over = {}) => ({
  id: 'doc-render', label: 'Document renderer',
  configured: true, reachable: true, impact: 'x', ...over,
});

describe('rolling component probes into a level', () => {
  it('is ok when everything configured is reachable', () => {
    const s = summariseHealth([comp(), comp({ id: 'doc-office' })]);
    assert.equal(s.level, 'ok');
    assert.deepEqual(s.down, []);
  });

  it('is ok — not degraded — when nothing is configured at all', () => {
    // A plain instance with no sidecars is a SUPPORTED configuration, not a broken one. Reporting
    // degraded here would make the panel permanently yellow, and a warning that is always on is one
    // nobody reads.
    const s = summariseHealth([
      comp({ configured: false, reachable: null }),
      comp({ id: 'nli', configured: false, reachable: null }),
    ]);
    assert.equal(s.level, 'ok');
  });

  it('is degraded — never "down" — when a configured component is unreachable', () => {
    // Nothing here can take the instance out of service. Calling it "down" invites someone to treat a
    // degraded feature as an outage.
    const s = summariseHealth([comp({ reachable: false })]);
    assert.equal(s.level, 'degraded');
    assert.notEqual(s.level, 'down');
    assert.deepEqual(s.down, ['doc-render']);
  });

  it('names every component that is down, not just the first', () => {
    const s = summariseHealth([
      comp({ id: 'doc-render', reachable: false }),
      comp({ id: 'doc-office', reachable: false }),
      comp({ id: 'nli', reachable: true }),
    ]);
    assert.deepEqual(s.down.sort(), ['doc-office', 'doc-render']);
  });

  it('ignores an UNCONFIGURED component even when its probe says false', () => {
    // The probe result is meaningless for something the operator never asked for; `configured` is what
    // decides whether the answer matters.
    const s = summariseHealth([comp({ configured: false, reachable: false })]);
    assert.equal(s.level, 'ok');
    assert.deepEqual(s.down, []);
  });

  it('distinguishes "could not check" from "checked and failed"', () => {
    // Configured but unprobed is `unknown` — those want different responses, and collapsing them would
    // either hide a real failure or invent one.
    const s = summariseHealth([comp({ reachable: null })]);
    assert.equal(s.level, 'unknown');
    assert.deepEqual(s.down, [], 'an unprobed component is not a failure');
  });

  it('a real failure outranks an unprobed one', () => {
    const s = summariseHealth([comp({ reachable: null }), comp({ id: 'doc-office', reachable: false })]);
    assert.equal(s.level, 'degraded');
  });

  it('handles an empty component list', () => {
    assert.deepEqual(summariseHealth([]), { level: 'ok', components: [], down: [] });
  });

  it('does not alias the caller\'s array', () => {
    const input = [comp()];
    const s = summariseHealth(input);
    assert.notEqual(s.components, input);
  });
});

describe('the reporting/gating boundary', () => {
  const ready = readFileSync(new URL('../../server/src/ready.ts', import.meta.url), 'utf8');
  const about = readFileSync(new URL('../../server/src/api/about.ts', import.meta.url), 'utf8');

  it('readiness still gates on mongodb and vectorSearch ONLY', () => {
    // The regression this guards: someone adds a sidecar to `ready` because it seems more complete,
    // and a dead optional container starts pulling healthy instances out of the load balancer.
    assert.match(ready, /ready:\s*mongodb\.status === 'ok' && vectorSearch\.status === 'ok'/,
      'readiness must not depend on any optional component');
    for (const optional of ['isRenderAvailable', 'isOfficeRenderAvailable', 'isNlpAvailable', 'summariseHealth']) {
      assert.equal(ready.includes(optional), false,
        `ready.ts must not reference ${optional} — optional components report, they do not gate`);
    }
  });

  it('the health route is admin-only', () => {
    // It names which optional services an instance is wired to, which is deployment shape.
    assert.match(about, /aboutRouter\.get\('\/health', requireAdmin/);
  });

  it('sidecar probes cannot hang the route', () => {
    // Both probes are cached and timeout-bounded at source; the route additionally swallows a rejection
    // so one failing probe cannot 500 the panel.
    assert.match(about, /isRenderAvailable\(\)\.catch\(\(\) => false\)/);
    assert.match(about, /isOfficeRenderAvailable\(\)\.catch\(\(\) => false\)/);
    assert.match(about, /isNlpAvailable\(\)\.catch\(\(\) => false\)/);
  });
});
