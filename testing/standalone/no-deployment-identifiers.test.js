/**
 * No real deployment identifier may be committed to this PUBLIC repository.
 *
 * ## Why this gate exists
 *
 * The most useful bug reports arrive with real output pasted in — a failing URL, a resolved address, a
 * warning line naming an internal service. That text then flows straight into the fix: a test asserting
 * the reported shape, a CHANGELOG entry quoting the symptom, a doc example. Each step is individually
 * reasonable and the aggregate is a public repository advertising a private cluster's topology.
 *
 * It had already happened here. A reporter's own vision endpoint, their identity provider's in-cluster
 * name, and two service ClusterIPs were committed across tests, docs and the CHANGELOG, and had been
 * public since the PR that introduced the feature. Nothing was a credential, and none of it was
 * reachable from outside their cluster — but it is free reconnaissance for anyone who ever gets a
 * foothold, and it is not ours to publish.
 *
 * ## What is checked, and why it is an allowlist
 *
 * Two shapes carry deployment topology: Kubernetes cluster-DNS names, and RFC1918 addresses. Both are
 * matched generically and compared against a list of values this repository is allowed to use.
 *
 * An allowlist, not a denylist, for a reason that matters: a denylist would have to *name the secrets*
 * to catch them, so the guard would leak exactly what it protects. Nothing in the list below is real.
 * Adding a value is a deliberate act, which is the whole point — the failure mode is paste-and-forget.
 *
 * ## When this fails
 *
 * Replace the value with a synthetic one **of the same shape**. Shape matters: the tests using these
 * assert how a hostname or a private address gets CLASSIFIED, so substituting a public address or a
 * bare word stops the test exercising what it was written for.
 *
 * Run: node --test testing/standalone/no-deployment-identifiers.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Cluster-DNS names this repository may contain. All synthetic.
 *
 * `*.ythril.svc.cluster.local` are our own shipped defaults — the addresses this product's own sidecars
 * are reached at out of the box, which are ours to publish and must appear in code.
 */
const ALLOWED_CLUSTER_DNS = new Set([
  'ollama.ythril.svc.cluster.local',
  'whisper.ythril.svc.cluster.local',
  'vllm.models.svc.cluster.local',
  'qwen-asr.media.svc.cluster.local',
  'sso.auth.svc.cluster.local',
]);

/**
 * Private addresses this repository may contain. All either documentation-conventional
 * (`192.168.1.x`, `10.0.0.x`) or obviously synthetic (`10.1.2.3`).
 *
 * Network/broadcast bases (`10.0.0.0`, `192.168.0.0`) and gateway-shaped values appear in CIDR and
 * range examples throughout the SSRF guard, which is unavoidable when documenting which ranges are
 * blocked.
 */
const ALLOWED_PRIVATE_IPS = new Set([
  '10.0.0.0', '10.0.0.1', '10.0.0.5', '10.0.0.20',
  '10.1.2.3', '10.1.2.4', '10.9.8.7', '10.9.9.9', '10.42.0.15',
  '172.16.0.0', '172.16.0.1', '172.16.0.9', '172.21.0.5',
  '192.168.0.0', '192.168.1.1', '192.168.1.5', '192.168.1.10',
  '192.168.1.50', '192.168.1.100', '192.168.4.4',
]);

/** This file names the allowed values, so scanning it would report every one of them. */
const SELF = 'testing/standalone/no-deployment-identifiers.test.js';

const CLUSTER_DNS_RE = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.svc\.cluster\.local/g;
const PRIVATE_IP_RE = /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

/**
 * Tracked text files only.
 *
 * `git ls-files`, never a directory walk. Three ways a walk has broken checks in this repo already:
 * gitignored files, untracked generated state (Docker writes 0600 files that CI cannot read), and
 * unreadable files. It is also the correct question — this gate is about what is PUBLISHED, and
 * `git ls-files` is the definition of that.
 */
function trackedTextFiles() {
  const NUL = String.fromCharCode(0);
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split(NUL)
    .filter(Boolean)
    .filter(f => /\.(ts|js|mjs|cjs|md|json|ya?ml|html|scss|css|sh|txt)$/.test(f))
    .filter(f => f !== SELF);
}

/**
 * Undo regex escaping before matching.
 *
 * `/blocked address 10\.43\.12\.7/` is the address, written for a regex literal. A scanner looking for
 * `10.43.12.7` does not see it, because the source says `10\.43`. This is not hypothetical: the scrub
 * that introduced this gate replaced every plain occurrence and left the escaped one in an assertion,
 * which passed preflight and failed CI.
 *
 * Only `\.` is unescaped — enough for dotted addresses and hostnames, and narrow enough that it cannot
 * corrupt unrelated source into a false match.
 */
const unescapeDots = (s) => s.replace(/\\\./g, '.');

function scan(regex, allowed) {
  const offenders = [];
  for (const file of trackedTextFiles()) {
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }
    const lines = unescapeDots(src).split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(regex)) {
        const value = m[0];
        if (allowed.has(value)) continue;
        offenders.push(`${file}:${i + 1}  ${value}`);
      }
    }
  }
  return offenders;
}

describe('no real deployment identifiers reach the public repository', () => {
  it('every in-cluster DNS name is one this repo is allowed to publish', () => {
    const offenders = scan(CLUSTER_DNS_RE, ALLOWED_CLUSTER_DNS);
    assert.deepEqual(
      offenders, [],
      'A cluster-DNS name that is not on the allowlist is almost certainly a real one pasted from a bug\n'
      + 'report. Replace it with a synthetic name of the same shape (service.namespace.svc.cluster.local),\n'
      + `or add it to ALLOWED_CLUSTER_DNS if it is genuinely ours to publish:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('every private address is one this repo is allowed to publish', () => {
    const offenders = scan(PRIVATE_IP_RE, ALLOWED_PRIVATE_IPS);
    assert.deepEqual(
      offenders, [],
      'A private address that is not on the allowlist is almost certainly a real one. Replace it with a\n'
      + 'synthetic RFC1918 address — the range matters, since these values exist to be classified as\n'
      + `private — or add it to ALLOWED_PRIVATE_IPS:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('the allowlists are small enough to stay reviewable', () => {
    // A guard nobody reads is a guard that gets appended to instead of thought about. If these grow
    // large, the examples want consolidating rather than the list extending.
    assert.ok(ALLOWED_CLUSTER_DNS.size <= 12, `cluster-DNS allowlist has grown to ${ALLOWED_CLUSTER_DNS.size}`);
    assert.ok(ALLOWED_PRIVATE_IPS.size <= 32, `private-IP allowlist has grown to ${ALLOWED_PRIVATE_IPS.size}`);
  });

  it('the scanner actually reads files rather than silently matching nothing', () => {
    // A gate that scans zero files passes forever. This is the check that catches a broken glob.
    const files = trackedTextFiles();
    assert.ok(files.length > 200, `expected to scan the repo, got ${files.length} files`);
    assert.ok(files.some(f => f.startsWith('server/src/')), 'server sources must be in scope');
    assert.ok(files.some(f => f.startsWith('docs/')), 'docs must be in scope');
  });

  it('and would actually catch an identifier it has never seen', () => {
    // Mutation-proofing inline: the regexes must match the shapes this exists to find.
    //
    // The examples are invented, not the real values this gate was written to remove. Using the real
    // ones here would have re-published them in the very file that exists to keep them out — the same
    // denylist trap the allowlist design avoids, walked into from the other direction. (It happened:
    // the first version of this test quoted them, and the file's SELF exclusion meant nothing failed.)
    assert.match('http://some-service.some-namespace.svc.cluster.local:8080', CLUSTER_DNS_RE);
    assert.match('resolves to 10.77.88.99', PRIVATE_IP_RE);
    assert.equal(ALLOWED_CLUSTER_DNS.has('some-service.some-namespace.svc.cluster.local'), false);
    assert.equal(ALLOWED_PRIVATE_IPS.has('10.77.88.99'), false);
  });

  it('sees an address written for a regex literal', () => {
    // The form that slipped through the scrub: escaped dots, in an assertion. Matching the raw source
    // misses it entirely, and the scan then reports the file as clean.
    const escaped = String.raw`assert.match(msg, /blocked address 10\.77\.88\.99/)`;
    assert.doesNotMatch(escaped, PRIVATE_IP_RE, 'the raw form must NOT match — that is the whole problem');
    assert.match(unescapeDots(escaped), PRIVATE_IP_RE);
  });
});
