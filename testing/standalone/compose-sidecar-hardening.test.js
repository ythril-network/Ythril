/**
 * Standalone tests: container hardening of the untrusted-input sidecars (SECURITY-TODO F4).
 *
 * `ollama`, `whisper`, `unstructured`, `doc-render` and `doc-office` exist to parse UNTRUSTED
 * user-supplied input — uploaded images, audio, PDFs, office documents. They are the highest-risk
 * processes in a Ythril deployment, and `docker-compose.yml` confines them accordingly:
 *
 *   - `security_opt: [no-new-privileges:true]`  — a parser exploit cannot gain privileges
 *   - `cap_drop: [ALL]`                          — no Linux capabilities at all
 *   - `read_only: true` (+ a `/tmp` tmpfs)       — nothing but the service's own volume is writable
 *   - `mem_limit` / `pids_limit` / `cpus`        — a malformed input cannot OOM or fork-bomb the host
 *
 * The ceilings themselves are sized from live measurement (see docs/dependencies.md); this file does
 * NOT re-assert the numbers, only that every ceiling is declared — a missing limit is the regression
 * that matters, and pinning exact byte counts here would just make legitimate resizing noisy.
 *
 * The point of the test is the LIST: adding a new parser sidecar without hardening it, or quietly
 * dropping a control from an existing one, fails here. An exemption must be recorded in EXEMPT with
 * a reason, exactly like the audited-route coverage gate.
 *
 * Run: node --test testing/standalone/compose-sidecar-hardening.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCompose, environmentOf } from '../_shared/compose-file.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Sidecars that parse untrusted user input. Every one of them must be confined. */
const UNTRUSTED_PARSERS = ['ollama', 'whisper', 'unstructured', 'doc-render', 'doc-office', 'doc-nlp'];

/** Services that legitimately need no such confinement, with the reason they are exempt. */
const EXEMPT = {
  ythril: 'the application itself — it is the trust boundary, not a parser behind it',
  'ythril-mongo': 'the database: no user-controlled parsing, and already isolated on an internal network',
};

/**
 * Controls a service may legitimately lack, each with the reason it was waived. Verified against the
 * live image, not assumed — see the matching comment in docker-compose.yml.
 */
const WAIVED = {
  whisper: {
    read_only:
      'faster-whisper-server is launched via `uv run`, which rewrites its own virtualenv on every ' +
      'start; a read-only rootfs crash-loops it with "Read-only file system (os error 30)"',
  },
  'doc-render': {
    tmpfs: 'writes nothing outside the response body — it has no scratch directory to grant',
  },
  'doc-office': {
    // doc-office declares its own tmpfs already; no waiver needed for the others.
  },
  'doc-nlp': {
    // doc-nlp declares its own tmpfs (the Transformers cache); no waiver needed.
  },
};

const services = loadCompose('docker-compose.yml').services;

describe('docker-compose.yml — untrusted-parser sidecar hardening', () => {
  it('every compose service is either a known untrusted parser or explicitly exempt', () => {
    const unaccounted = Object.keys(services).filter(
      (name) => !UNTRUSTED_PARSERS.includes(name) && !(name in EXEMPT),
    );
    assert.deepEqual(
      unaccounted,
      [],
      `New compose service(s) ${unaccounted.join(', ')}: either harden them (cap_drop/read_only/` +
        `mem_limit/pids_limit/cpus) and add them to UNTRUSTED_PARSERS, or add them to EXEMPT with a reason.`,
    );
  });

  for (const name of UNTRUSTED_PARSERS) {
    describe(name, () => {
      it('is defined in docker-compose.yml', () => {
        assert.ok(services[name], `service ${name} is missing from docker-compose.yml`);
      });

      it('blocks privilege escalation', () => {
        const opts = services[name]?.security_opt ?? [];
        assert.ok(
          opts.includes('no-new-privileges:true'),
          `${name} must set security_opt: [no-new-privileges:true]`,
        );
      });

      it('drops all Linux capabilities', () => {
        const dropped = services[name]?.cap_drop ?? [];
        assert.ok(dropped.includes('ALL'), `${name} must set cap_drop: [ALL]`);
      });

      it('runs with a read-only root filesystem', () => {
        if (WAIVED[name]?.read_only) return;
        assert.equal(services[name]?.read_only, true, `${name} must set read_only: true`);
      });

      it('declares a memory ceiling', () => {
        assert.ok(services[name]?.mem_limit, `${name} must set mem_limit`);
      });

      it('declares a process (thread) ceiling', () => {
        assert.ok(services[name]?.pids_limit, `${name} must set pids_limit`);
      });

      it('declares a CPU ceiling', () => {
        assert.ok(services[name]?.cpus, `${name} must set cpus`);
      });
    });
  }

  it('unstructured keeps its request-time caches inside the tmpfs and its models offline', () => {
    // Each of these was established by running a real hi_res extraction against the hardened
    // container; dropping any one of them breaks document conversion rather than just weakening it.
    const env = (key) => { const v = environmentOf(services.unstructured)[key]; return v === undefined ? undefined : String(v); };
    assert.equal(env('NUMBA_CACHE_DIR'), '/tmp/numba', 'without this numba caches next to the package → fails on a read-only rootfs');
    assert.equal(env('MPLCONFIGDIR'), '/tmp/matplotlib', 'matplotlib needs a writable config dir');
    assert.equal(env('HF_HUB_OFFLINE'), '1', 'the models are baked in, but huggingface_hub calls the hub to resolve them — impossible on the internal network');
    for (const forbidden of ['HOME', 'XDG_CACHE_HOME']) {
      assert.equal(
        env(forbidden),
        undefined,
        `${forbidden} must NOT be set on unstructured — it relocates the baked Hugging Face model cache, ` +
          `which makes hi_res extraction try to download on a network with no internet`,
      );
    }
  });

  it('every heavy sidecar can be switched off from .env (infra-managed deployments)', () => {
    // set-claim: the services that declare a replica gate, which is what "can be switched off" means. A
    // sidecar without one is a product question rather than a drift -- the ceilings case below sweeps.
    const envExample = readFileSync(join(repoRoot, '.env.example'), 'utf8');
    for (const name of ['ollama', 'whisper', 'unstructured']) {
      const replicas = String(services[name]?.deploy?.replicas ?? '');
      const match = /\$\{([A-Z0-9_]+):-1\}/.exec(replicas);
      assert.ok(
        match,
        `${name} should declare deploy.replicas: \${SOME_VAR:-1} so infra can drop it with 0 ` +
          `without editing docker-compose.yml (got "${replicas}")`,
      );
      assert.ok(
        envExample.includes(match[1]),
        `${match[1]} gates the ${name} service but is not documented in .env.example`,
      );
    }
  });

  it('every compose service declares a memory ceiling — the app and the database too', () => {
    /*
     * EXEMPT above waives CONFINEMENT for `ythril` and `ythril-mongo`, not a memory ceiling. Uncapped, MongoDB
     * sizes its cache from the whole host and the app grows without bound, so on a shared compose host one
     * Ythril can take the machine with it — which is what happened on 2026-09-24. Infra sets its own pod limits;
     * this is the compose default.
     */
    const uncapped = Object.keys(services).filter(n => services[n]?.mem_limit === undefined);
    assert.ok(Object.keys(services).length >= 5, 'the compose parser found almost no services — it is wrong, not the file');
    assert.deepEqual(uncapped, [], `compose service(s) with no mem_limit: ${uncapped.join(', ')}`);
  });

  it('the operator can raise every ceiling from .env without editing the compose file', () => {
    /*
     * EVERY service that declares a ceiling, read out of the compose file.
     *
     * Three were named and five have ceilings: `doc-render` and `doc-office` had `mem_limit: 1g` and
     * `cpus: "2.0"` written into the file. So an operator whose documents needed more headroom had to edit
     * `docker-compose.yml` -- the exact thing this case's title says they never have to do -- and the case
     * reported that every ceiling was overridable.
     */
    const envExample = readFileSync(join(repoRoot, '.env.example'), 'utf8');
    const LIMITS = ['mem_limit', 'pids_limit', 'cpus'];
    const limited = Object.keys(services).filter(n => LIMITS.some(k => services[n]?.[k] !== undefined));
    assert.ok(limited.length >= 5,
      `only ${limited.length} service(s) with a ceiling found -- the compose parser is wrong, not the file`);
    for (const name of limited) {
      for (const key of LIMITS) {
        if (services[name]?.[key] === undefined) continue;
        const value = String(services[name]?.[key] ?? '');
        const match = /\$\{([A-Z0-9_]+):-/.exec(value);
        assert.ok(match, `${name}.${key} should be overridable, e.g. \${SOME_VAR:-default} (got "${value}")`);
        assert.ok(
          envExample.includes(match[1]),
          `${match[1]} is used in docker-compose.yml but not documented in .env.example`,
        );
      }
    }
  });
});
