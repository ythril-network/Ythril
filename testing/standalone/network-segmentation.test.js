/**
 * Standalone tests: media sidecars must not share a network with MongoDB (S7).
 *
 * MongoDB runs with NO authentication, so Ythril's entire security model — PATs, admin
 * gating, space scoping, read-only tokens, the audit log — is enforced at the API layer
 * and *not* at the database. Anything that can open a TCP connection to port 27017 owns
 * every space in the brain, invisibly.
 *
 * `ollama` and `whisper` are third-party images whose whole job is parsing untrusted,
 * user-supplied media (uploaded images, audio, video) — the highest-risk attack surface in
 * the deployment. They must therefore never be able to reach the database: a parser exploit
 * in one of them would otherwise mean unauthenticated read/write of the entire brain.
 *
 * Kubernetes already enforces this (kubernetes/manifests/media-netpol.yaml gives ollama and
 * whisper an Egress policy permitting only DNS + 80/443, so 27017 is unreachable). Compose
 * used to put all four containers on one flat bridge — this test exists so that gap cannot
 * silently come back.
 *
 * This is a STATIC check of docker-compose.yml (it must pass in CI, which does not run the
 * workstation stack). The live behaviour was verified by hand: from `ythril-ollama`,
 * `ythril-mongo` no longer resolves and TCP 27017 is refused, while `ythril` still reaches
 * mongo, ollama and whisper.
 *
 * Run: node --test testing/standalone/network-segmentation.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadCompose } from '../_shared/compose-file.mjs';

let compose;

/** Networks a service is attached to, normalised to an array of names. */
function networksOf(serviceName) {
  const svc = compose.services?.[serviceName];
  assert.ok(svc, `service '${serviceName}' missing from docker-compose.yml`);
  const nets = svc.networks;
  if (!nets) return [];
  return Array.isArray(nets) ? nets : Object.keys(nets);
}

const MEDIA_SIDECARS = ['ollama', 'whisper'];

describe('Compose network segmentation — media sidecars vs the database', () => {
  before(() => {
    compose = loadCompose('docker-compose.yml');
  });

  it('mongo shares NO network with any media sidecar', () => {
    const mongoNets = new Set(networksOf('ythril-mongo'));
    assert.ok(mongoNets.size > 0, 'mongo must be on at least one network');

    for (const sidecar of MEDIA_SIDECARS) {
      const shared = networksOf(sidecar).filter(n => mongoNets.has(n));
      assert.deepEqual(
        shared, [],
        `'${sidecar}' shares network(s) [${shared}] with ythril-mongo — it parses untrusted ` +
        `media and MongoDB has no auth, so this grants it unauthenticated read/write of the ` +
        `entire brain. Keep the database network separate.`,
      );
    }
  });

  it('the app is on both networks — it must still reach the db AND the sidecars', () => {
    const appNets = new Set(networksOf('ythril'));
    const mongoNets = networksOf('ythril-mongo');
    assert.ok(
      mongoNets.some(n => appNets.has(n)),
      'ythril must share a network with mongo, or it cannot reach its own database',
    );
    for (const sidecar of MEDIA_SIDECARS) {
      assert.ok(
        networksOf(sidecar).some(n => appNets.has(n)),
        `ythril must share a network with '${sidecar}' to dispatch media jobs`,
      );
    }
  });

  it('the database network is internal (a compromised db cannot call out)', () => {
    const dbNets = networksOf('ythril-mongo');
    for (const name of dbNets) {
      const def = compose.networks?.[name];
      assert.ok(def, `network '${name}' must be declared`);
      assert.equal(
        def.internal, true,
        `the database network '${name}' should be internal: mongo needs no outbound internet`,
      );
    }
  });

  it('no service silently re-flattens onto a single shared network', () => {
    // Guards the regression directly: if someone puts everything back on one network,
    // mongo and the sidecars would collide, which the first test catches — but this also
    // catches the subtler case of a NEW service bridging the two.
    const mongoNets = new Set(networksOf('ythril-mongo'));
    for (const [name, svc] of Object.entries(compose.services ?? {})) {
      if (name === 'ythril' || name === 'ythril-mongo') continue; // the app is the intended bridge
      if (!svc.networks) continue;
      const shared = networksOf(name).filter(n => mongoNets.has(n));
      assert.deepEqual(
        shared, [],
        `service '${name}' is on the database network — only 'ythril' itself may bridge to mongo`,
      );
    }
  });
});
