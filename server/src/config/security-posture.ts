/**
 * Startup security-posture check (PR-S3).
 *
 * Aggregates the transport (S1) and at-rest (S2) security settings — plus MongoDB auth — into a single
 * PASS / WARN / FAIL report, logged at boot and served to admins at `GET /api/about/security`. It does
 * not enforce on its own (the individual `require*` flags do that); but with `security.strict` (or env
 * `YTHRIL_SECURITY_STRICT`) any FAIL aborts boot, so a misconfigured instance fails fast instead of
 * running in a falsely-secure state.
 */
import { getConfig, getMongoUri, atRestEncryptionActive } from './loader.js';
import { requireEncryptedTransport, allowInsecurePeersRaw } from './transport-security.js';
import { allowPrivateModelEndpoints, egressSlotOverrides } from './model-egress-policy.js';
import { allowPrivateOidcIssuer } from './oidc-egress-policy.js';
import { modelEndpointExposure, formatExposure, classifyEndpoint } from './model-egress-exposure.js';
import { publicBaseUrlIsFallback } from './public-url.js';
import { atRestMigrationState } from '../files/at-rest-migration.js';
import { unreadableCount } from '../files/unreadable-files.js';

export { POSTURE_LEVELS, type PostureLevel } from './posture-levels.js';
import type { PostureLevel } from './posture-levels.js';

export interface PostureCheck {
  id: string;
  level: PostureLevel;
  message: string;
}

export interface SecurityPosture {
  checks: PostureCheck[];
  /** The most severe level across all checks (`pass` < `warn` < `fail`). */
  worst: PostureLevel;
}

/** Whether strict posture enforcement is on (env → config → default false). */
export function securityStrict(): boolean {
  if (process.env['YTHRIL_SECURITY_STRICT'] === 'true') return true;
  try { return getConfig().security?.strict === true; } catch { return false; }
}

/** True when Express `trust proxy` is configured (needed for `req.secure` behind a TLS-terminating proxy). */
function trustProxyConfigured(): boolean {
  if (process.env['TRUST_PROXY']) return true;
  try {
    const tp = getConfig().trustProxy;
    return tp !== undefined && tp !== false && tp !== 0 && tp !== '';
  } catch { return false; }
}

/** True when the Mongo connection carries credentials (URI userinfo or MONGO_USERNAME). */
function mongoAuthenticated(): boolean {
  if (process.env['MONGO_USERNAME']) return true;
  try {
    // Match a userinfo component: scheme://user[:pass]@host
    return /^[a-z]+(?:\+[a-z]+)?:\/\/[^/@]+@/i.test(getMongoUri());
  } catch { return false; }
}

/**
 * Describe the exposure tally WITHOUT claiming a resolution that never happened.
 *
 * The line used to read `N of M external endpoint(s) resolve to private addresses`. On a cluster where
 * every endpoint is a DNS name, `classifyEndpoint` returns `hostname` for all of them and N is 0 — so a
 * deployment with two private ClusterIP endpoints was told "0 of 2 resolve to private addresses".
 *
 * That is not merely imprecise, it inverts the meaning, and it does so in a place where the *same*
 * phrasing is load-bearing: two branches up, "nothing is using the permission" genuinely means "unset
 * this flag". An operator who has learned to trust that reading will apply it here and turn off the
 * setting their endpoints depend on. A check that cannot resolve DNS must say it did not resolve DNS.
 *
 * Exported for unit testing — the inversion is the reason this function exists.
 */
export function exposureCount(privateCount: number, unresolvedCount: number, total: number): string {
  if (unresolvedCount === 0) {
    return `${privateCount} of ${total} are private addresses.`;
  }
  const known = unresolvedCount === total
    ? `None of the ${total} are IP literals`
    : `${privateCount} of ${total} are private IP literals; the other ${unresolvedCount}`;
  return `${known} — a hostname is resolved at call time, so this check has not established where ` +
    `${unresolvedCount === total ? 'any of them point' : 'they point'}. "Not resolved here" is not "not private".`;
}

const RANK: Record<PostureLevel, number> = { pass: 0, warn: 1, fail: 2 };

/** Compute the current security posture from config + environment. Pure (no I/O beyond reads). */
export function computeSecurityPosture(): SecurityPosture {
  const checks: PostureCheck[] = [];
  let cfg: ReturnType<typeof getConfig> | undefined;
  try { cfg = getConfig(); } catch { /* pre-setup — report what we can from env */ }

  const tlsOn = requireEncryptedTransport();

  // ── Transport ──────────────────────────────────────────────────────────────
  checks.push(tlsOn
    ? { id: 'transport.tls', level: 'pass', message: 'requireEncryptedTransport is on — plaintext requests are rejected.' }
    : { id: 'transport.tls', level: 'warn', message: 'requireEncryptedTransport is off — set it (behind a TLS-terminating proxy) to reject plaintext requests instance-wide.' });

  if (tlsOn && !trustProxyConfigured()) {
    checks.push({ id: 'transport.trustProxy', level: 'fail', message: 'requireEncryptedTransport is on but trustProxy is not set — behind a proxy every request will look plaintext and be rejected (403). Set trustProxy to your proxy hop count.' });
  }

  checks.push(allowInsecurePeersRaw()
    ? { id: 'transport.peers', level: 'warn', message: 'allowInsecurePeers is on — sync may use plaintext http:// peers.' }
    : { id: 'transport.peers', level: 'pass', message: 'Sync peers must use HTTPS.' });

  if (cfg?.allowInsecurePlaintext) {
    // RETIRED, and the line has to say so — it used to claim "the plaintext-exposure guard is disabled",
    // which described a guard that does not exist. The flag's original meaning in the first prototype was
    // nearly the opposite: it opted the operator IN to a boot warning when the host had a non-loopback
    // interface. That warning was replaced by this posture block; the flag was left behind, read by
    // nothing, and the message written for it inverted what it had meant.
    //
    // Reported rather than ignored, because an operator who set it believes it is doing something. The
    // control that actually rejects plaintext is `requireEncryptedTransport`, one check up.
    checks.push({
      id: 'transport.plaintext',
      level: 'warn',
      message: 'allowInsecurePlaintext is set but does nothing — it is retired and read by no code path. '
        + (tlsOn
          ? 'Plaintext requests are already rejected by requireEncryptedTransport; remove the key.'
          : 'Plaintext requests are NOT rejected — that is requireEncryptedTransport, which is off. '
            + 'Setting this key does not change it.'),
    });
  }

  // Widening where model/media egress may point is a deliberate operator decision, so it is reported
  // rather than silent — but it is NOT a `fail`: the guard itself stays on (DNS-pinning, redirect
  // re-validation, crown-jewel ranges still blocked), only private addresses become reachable.
  //
  // Report the EXPOSURE, not the flag. "allowPrivateModelEndpoints is on" tells an operator what they
  // set; "vision → 10.1.2.3 (private)" tells them what it actually reaches, which is the thing that
  // makes this check load-bearing. A hostname is named as a hostname — only the resolution-time guard
  // knows where it points, and claiming otherwise here would be a guess.
  //
  // Split PER ENDPOINT rather than by the instance-wide flag, because the two conditions below are no
  // longer mutually exclusive. Once each slot carries its own permission, the intended deployment — every
  // model on the operator's own infra except one that is genuinely on the public internet — has widened
  // endpoints and strict endpoints at the same time. An if/else on one global boolean would report only
  // whichever branch the flag happened to select and stay silent about the other half of the estate.
  {
    const exposure = modelEndpointExposure();
    // Endpoints the permission is actually doing something for: a private literal, or a hostname that
    // might resolve to one. A public endpoint under a widened slot is not using the permission.
    const widened = exposure.filter(e => e.allowsPrivate && (e.klass === 'private' || e.klass === 'hostname'));
    // Endpoints configured privately with NO permission for their slot. These cannot work: the call is
    // refused at request time, which surfaces as a model that is "configured" and silently never answers.
    const stuck = exposure.filter(e => !e.allowsPrivate && (e.klass === 'private' || e.klass === 'invalid'));

    if (widened.length > 0) {
      const privateOnes = widened.filter(e => e.klass === 'private');
      const unresolved = widened.filter(e => e.klass === 'hostname');
      checks.push({
        id: 'egress.privateModelEndpoints',
        level: 'warn',
        message: `Private model endpoints are permitted for: ${formatExposure(widened)}. ${exposureCount(privateOnes.length, unresolved.length, widened.length)} SSRF guarding, IP-pinning and redirect re-validation still apply; loopback, link-local/IMDS and cloud-metadata addresses stay blocked.`,
      });
    } else if (allowPrivateModelEndpoints()) {
      checks.push({
        id: 'egress.privateModelEndpoints',
        level: 'warn',
        message: 'allowPrivateModelEndpoints is on but no configured model/media endpoint is using the permission — every one of them is public, or none is configured.',
      });
    }

    if (stuck.length > 0) {
      // Its own check id, not a fallback branch of the one above: with per-slot settings both can be true
      // at once, and a single id would let one overwrite the other in any consumer keyed by it.
      checks.push({
        id: 'egress.unreachableModelEndpoints',
        level: 'warn',
        message: `Model endpoint(s) point at addresses this instance will refuse to call: ${formatExposure(stuck)}. Permit a self-hosted endpoint on a private address per slot (allowPrivateModelEndpointsBySlot / YTHRIL_ALLOW_PRIVATE_<SLOT>=true) or instance-wide (allowPrivateModelEndpoints); cloud-metadata addresses stay blocked regardless.`,
      });
    }
  }

  // Slots whose permission departs from the instance-wide flag. Reported as a `pass`, not a warning: this
  // is the operator having been MORE precise than the global flag allows, and the whole point of naming it
  // is that a per-slot `false` under a global `true` is otherwise invisible — nothing else in the posture
  // would ever mention the one endpoint they deliberately kept strict.
  {
    const overrides = egressSlotOverrides();
    if (overrides.length > 0) {
      checks.push({
        id: 'egress.perSlotOverrides',
        level: 'pass',
        message: `Per-endpoint egress permissions differ from the instance-wide setting for: ${
          overrides.map(o => `${o.slot} (${o.allowPrivate ? 'private permitted' : 'strict'})`).join('; ')
        }.`,
      });
    }
  }

  // ── OIDC issuer egress ───────────────────────────────────────────────────────
  // The one check here that can be a FAIL rather than a WARN, and deliberately so: an enabled OIDC
  // config whose issuer sits on a private address with the opt-in absent means NOBODY CAN SIGN IN.
  // Discovering that from a login page that says "authentication failed" is the bad version of this
  // change; discovering it from a named line at boot (and, under security.strict, from a refusal to
  // start at all) is the good one.
  if (cfg?.oidc?.enabled && cfg.oidc.issuerUrl) {
    const { host, klass } = classifyEndpoint(cfg.oidc.issuerUrl);
    const allowPrivate = allowPrivateOidcIssuer();
    if (klass === 'invalid') {
      checks.push({ id: 'oidc.issuer', level: 'fail', message: `oidc.enabled is on but issuerUrl (${host}) is unusable — unparseable, or a loopback / link-local / cloud-metadata address that is blocked regardless of oidc.allowPrivateIssuer. No one can sign in.` });
    } else if (klass === 'private' && !allowPrivate) {
      checks.push({ id: 'oidc.issuer', level: 'fail', message: `oidc.enabled is on and issuerUrl (${host}) is a private address, but oidc.allowPrivateIssuer is not set — discovery will be refused and no one can sign in. Set oidc.allowPrivateIssuer: true (or YTHRIL_OIDC_ALLOW_PRIVATE_ISSUER=true) for an internal IdP.` });
    } else if (allowPrivate) {
      // Report the exposure, not the flag — same rule as the model endpoints above. A hostname is
      // named as a hostname: only the resolution-time guard knows where it points.
      // Three-way, not two-way. `hostname` is not "not private" — it is "not resolved", and collapsing
      // the two produced advice that would break the deployment it was aimed at: an internal IdP at
      // sso.auth.svc.cluster.local classifies as `hostname`, and the old else-branch told the
      // operator that nothing was using the permission and to unset it. Following that advice makes
      // discovery refuse the issuer and NOBODY CAN SIGN IN — the exact outcome the fail branch above
      // exists to prevent, arrived at by obeying the posture block.
      checks.push(klass === 'private'
        ? { id: 'oidc.issuer', level: 'warn', message: `oidc.allowPrivateIssuer is on — issuer ${host} is a private address. SSRF guarding, IP-pinning and redirect re-validation still apply; loopback, link-local/IMDS and cloud-metadata addresses stay blocked, and a public issuer could not name a private jwks_uri.` }
        : klass === 'hostname'
          ? { id: 'oidc.issuer', level: 'warn', message: `oidc.allowPrivateIssuer is on and issuer ${host} is a hostname — this check does not resolve DNS, so whether the permission is in use cannot be determined here. Keep it set if the IdP is internal; unsetting it would refuse discovery and stop all sign-in.` }
          : { id: 'oidc.issuer', level: 'warn', message: `oidc.allowPrivateIssuer is on but issuer ${host} is a public address — nothing is using the permission; unset it.` });
    }
  }

  // ── Public base URL (MCP OAuth) ──────────────────────────────────────────────
  // MCP OAuth needs an externally-reachable issuer, and with nothing configured it falls back to
  // loopback: the endpoint answers, the metadata is well-formed, and every URL inside it points at a
  // host no browser connector can reach. Nothing fails, so nothing is reported — the operator finds out
  // from a connector that will not authorize, with no server-side symptom to search for.
  //
  // A `warn`, not a `fail`: an instance with no MCP connectors is a legitimate configuration, and
  // static bearer-token MCP access works regardless of this setting.
  if (publicBaseUrlIsFallback()) {
    checks.push({
      id: 'mcp.publicUrl',
      level: 'warn',
      message: 'publicUrl is not set, so the instance falls back to a loopback base URL. MCP OAuth advertises that URL as its issuer and resource identifier, so browser-based connectors cannot complete authorization. Set config.publicUrl (or PUBLIC_BASE_URL) to the external https:// URL. Static bearer-token MCP access is unaffected.',
    });
  }

  // ── At rest ──────────────────────────────────────────────────────────────────
  const atRest = atRestEncryptionActive();
  checks.push(atRest
    ? { id: 'atRest.encryption', level: 'pass', message: 'State files are encrypted at rest (master secret configured).' }
    : { id: 'atRest.encryption', level: 'warn', message: 'State files and uploaded files are NOT encrypted at rest — set YTHRIL_MASTER_KEY or YTHRIL_MASTER_PASSPHRASE.' });

  const files = storedFilesCheck(atRest);
  if (files) checks.push(files);

  const wantAtRest = process.env['YTHRIL_REQUIRE_ENCRYPTED_AT_REST'] === 'true' || cfg?.requireEncryptedAtRest === true;
  if (wantAtRest && !atRest) {
    checks.push({ id: 'atRest.strict', level: 'fail', message: 'requireEncryptedAtRest is set but no master secret is configured.' });
  }

  // ── MongoDB ──────────────────────────────────────────────────────────────────
  checks.push(mongoAuthenticated()
    ? { id: 'mongo.auth', level: 'pass', message: 'MongoDB connection is authenticated.' }
    : { id: 'mongo.auth', level: 'warn', message: 'MongoDB connection has no credentials — enable auth on the database. On shared hardware, run a dedicated mongod per tenant on its own encrypted volume (do not share a mongod across tenants).' });

  const worst = checks.reduce<PostureLevel>((w, c) => (RANK[c.level] > RANK[w] ? c.level : w), 'pass');
  return { checks, worst };
}

/**
 * The stored-files line (F-43). It never FAILS: every state it reports is either transient (the background pass has
 * not reached a file yet) or already refusing loudly where it matters (an unreadable file refuses its download),
 * and a fail would stop a strict instance booting over files it could otherwise go on serving. Absent on a keyless
 * instance with nothing encrypted, where `atRest.encryption` already says everything there is to say.
 */
function storedFilesCheck(keyed: boolean): PostureCheck | null {
  const m = atRestMigrationState();
  const unreadable = unreadableCount();
  const id = 'atRest.files';
  if (!keyed) {
    return m.encryptedWithoutSecret > 0
      ? { id, level: 'warn', message: `${m.encryptedWithoutSecret} stored file(s) are encrypted and no master secret is set, so they cannot be read. Restore the secret they were written with.` }
      : null;
  }
  if (unreadable > 0) {
    return { id, level: 'warn', message: `${unreadable} stored file(s) cannot be decrypted with this master secret (written under another, or altered on disk). Their downloads refuse.` };
  }
  if (m.phase === 'not-started' || m.phase === 'running') {
    return { id, level: 'pass', message: 'Uploaded files are encrypted at rest; files stored before the master secret was set are being checked in the background.' };
  }
  if (m.phase === 'stopped' || m.plaintextLeft > 0) {
    return { id, level: 'warn', message: `${m.plaintextLeft} stored file(s) are still plaintext on disk${m.stoppedBecause ? ` (the background pass stopped: ${m.stoppedBecause})` : ''}. They are encrypted on the next start.` };
  }
  return { id, level: 'pass', message: 'Uploaded files are encrypted at rest.' };
}

/** Format the posture as human-readable lines for the boot log. */
export function formatPostureLines(posture: SecurityPosture): string[] {
  const glyph: Record<PostureLevel, string> = { pass: '✓', warn: '⚠', fail: '✗' };
  return posture.checks.map(c => `  ${glyph[c.level]} [${c.id}] ${c.message}`);
}
