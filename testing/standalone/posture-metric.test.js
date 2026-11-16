/**
 * The security posture is countable, so a fleet can alert on it (observability audit, lens 9).
 *
 * ## The finding
 *
 * `computeSecurityPosture()` produces PASS/WARN/FAIL checks that are printed once at boot and served on
 * `GET /api/about/security`. Both are pull-only and human-shaped, so the way a fleet learned that an
 * instance came up misconfigured was somebody reading its boot log. Nobody reads five boot logs — and the
 * checks that matter most are the ones with no runtime symptom at all: `requireEncryptedTransport` off, or
 * on WITHOUT `trustProxy`, which rejects every request with a 403 that looks like a client problem.
 *
 * ## What this pins
 *
 * The gauge exists, counts by level, is derived from the SAME function as the endpoint (never a second copy
 * of the rules), reports zeros rather than nothing when no posture has been computed, and cannot make a
 * scrape fail.
 *
 * Run: node --test testing/standalone/posture-metric.test.js
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { POSTURE_LEVELS } from '../../server/dist/config/posture-levels.js';
import { readFileSync } from 'node:fs';
import { metricSourceText } from './_metric-sources.mjs';

let register, securityPostureChecks, setPostureProvider;

/** The value of one label of the gauge, read back out of the registry. */
async function level(name) {
  const json = await register.getSingleMetric('ythril_security_posture_checks').get();
  return json.values.find(v => v.labels.level === name)?.value;
}

describe('ythril_security_posture_checks', () => {
  before(async () => {
    ({ register, securityPostureChecks, setPostureProvider } = await import('../../server/dist/metrics/registry.js'));
  });

  beforeEach(() => setPostureProvider(() => []));

  it('is registered, with a level label and an alertable name', () => {
    assert.ok(register.getSingleMetric('ythril_security_posture_checks'), 'the gauge must be on the registry');
  });

  it('reports ZERO for every level when nothing has been computed', async () => {
    // Absent and zero look identical in a graph and mean opposite things: "no findings" versus "nobody
    // asked". An alert on fail > 0 must not depend on a series existing.
    // The levels come from `POSTURE_LEVELS`, the runtime list the type is now derived from. A fourth level
    // would be pre-declared by the registry and unchecked here, which is the half a graph cannot show.
    for (const l of POSTURE_LEVELS) {
      assert.equal(await level(l), 0, `level=${l}`);
    }
  });

  it('counts the findings by level', async () => {
    setPostureProvider(() => ([
      { level: 'pass' }, { level: 'pass' }, { level: 'warn' }, { level: 'fail' },
    ]));
    await register.metrics();               // a scrape triggers collect()
    assert.equal(await level('pass'), 2);
    assert.equal(await level('warn'), 1);
    assert.equal(await level('fail'), 1);
  });

  it('drops back to zero when a finding is resolved, instead of keeping the high-water mark', async () => {
    setPostureProvider(() => ([{ level: 'fail' }]));
    await register.metrics();
    assert.equal(await level('fail'), 1);
    setPostureProvider(() => ([{ level: 'pass' }]));
    await register.metrics();
    assert.equal(await level('fail'), 0, 'a fixed instance must stop alerting');
    assert.equal(await level('pass'), 1);
  });

  it('ignores a level it does not know rather than inventing a series', async () => {
    setPostureProvider(() => ([{ level: 'catastrophe' }, { level: 'warn' }]));
    await register.metrics();
    assert.equal(await level('warn'), 1);
    assert.equal(await level('catastrophe'), undefined);
  });

  it('a scrape survives a provider that throws', async () => {
    // The posture reads config. A metrics scrape must never be the thing that fails because of it.
    setPostureProvider(() => { throw new Error('config not loaded'); });
    const text = await register.metrics();
    assert.match(text, /ythril_security_posture_checks/);
  });
});

describe('the metric and the endpoint cannot disagree', () => {
  const strip = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('both derive from computeSecurityPosture, and the metric holds no rules of its own', () => {
    // A posture metric that could disagree with `GET /api/about/security` would be worse than no metric.
    const boot = strip(readFileSync('server/src/index.ts', 'utf8'));
    assert.match(boot, /setPostureProvider\(\(\) => computeSecurityPosture\(\)\.checks\)/);
    const reg = strip(metricSourceText());
    assert.ok(!/requireEncryptedTransport|trustProxy|allowInsecurePeers/.test(reg),
      'the registry must not restate any posture rule — it counts what the one computer returns');
  });

  it('the registry does not import the config loader to do it', () => {
    // `registry.ts` is imported by nearly every module; pulling the config loader in here inverts the
    // dependency direction. The provider is registered at boot instead.
    const reg = strip(metricSourceText());
    assert.ok(!/from '\.\.\/config\/security-posture/.test(reg));
  });
});
