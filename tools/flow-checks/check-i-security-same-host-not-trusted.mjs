#!/usr/bin/env node
/**
 * check-i-security-same-host-not-trusted: the same host is no trust boundary on shared hardware, so each tenant has its own database process,
 * its own volume and an encryption setting.
 *
 * Rule (the flow node's stated assertion), read from the tracked compose files that ship to a deployment (`_compose-probe.mjs`) through the
 * repository's compose reader. A tenant is an app service: the one that shares a network with a database service (`rolesOf`, from the topology,
 * never a list), so a second app added to a file is held to the rule the day it appears. Per tenant:
 *
 *   - `database`:   it reaches at least one database service, and no other app reaches the same one (a `mongod` shared between tenants is the
 *                   thing `docs/integration-guide/02-hosting.md` forbids: "do not share one mongod across tenants").
 *   - `volume`:     each database service keeps its data on a volume of its own (a named volume or a bind source no other service mounts), and has one.
 *   - `encryption-app`: the app's environment passes a master secret (`YTHRIL_MASTER_KEY` or `YTHRIL_MASTER_PASSPHRASE`).
 *   - `encryption-db`:  the database's own encryption is set: an encryption flag in its `command`, or a data volume declared with a driver option
 *                   that names encryption (an encrypted volume), since a plain bridge volume is readable by a co-tenant with host access.
 *
 * Findings are `<file>#<tenant>#<control>`; exceptions live only in `check-i-security-same-host-not-trusted.allow.json` with a reason and a
 * reviewBy, and an exception that excuses nothing any more fails the probe. The deployment manifests under `kubernetes/` carry no database
 * (they take `MONGO_URI`), so there is nothing in them to read for a tenant's database process; the probe reads compose only.
 *
 * The failure that bought it (Q-875): the check was named by the verify phases and answered "cannot answer" from a placeholder, so shared
 * hardware was judged by reading.
 *
 *     node tools/flow-checks/check-i-security-same-host-not-trusted.mjs [--modules <folder holding js-yaml>]
 */
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { composeReader, deploymentComposeFiles, modulesFlag, networksOf, rolesOf } from './_compose-probe.mjs';

const MASTER_SECRET = ['YTHRIL_MASTER_KEY', 'YTHRIL_MASTER_PASSPHRASE'];
const DB_ENCRYPTION_FLAG = /--(enableEncryption|encryptionKeyFile|kmipServerName)\b/;
const ENCRYPTED_VOLUME_OPT = /\b(crypt|encrypt|luks)/i;

/** The sources a service mounts: a named volume or a bind path, from the short string or the long object form. */
export function mountSources(service) {
  return (service.volumes ?? []).map((v) => (typeof v === 'object' && v !== null ? v.source : String(v).split(':')[0])).filter(Boolean);
}

/** The environment names a service passes, as compose accepts them (map or `KEY=value` list). */
function envNames(service, environmentOf) {
  return Object.keys(environmentOf(service));
}

/**
 * `[{ id, text }]` per tenant control that is missing.
 * @param {{ file: string, doc: object }[]} composes
 * @param {(service: object) => Record<string, unknown>} environmentOf the reader's environment parser
 */
export function findings(composes, environmentOf) {
  const out = [];
  for (const { file, doc } of composes) {
    const { database, app } = rolesOf(doc);
    for (const tenant of app) {
      const add = (control, text) => out.push({ id: `${file}#${tenant}#${control}`, text: `${file}: tenant ${tenant} ${text}` });
      const tenantNets = new Set(networksOf(doc.services[tenant]));
      const mine = [...database].filter((db) => networksOf(doc.services[db]).some((n) => tenantNets.has(n)));
      if (!mine.length) { add('database', 'reaches no database service of its own'); continue; }
      for (const db of mine) {
        const shared = [...app].filter((other) => other !== tenant && networksOf(doc.services[other]).some((n) => networksOf(doc.services[db]).includes(n)));
        if (shared.length) add('database', `shares the database ${db} with ${shared.join(', ')}`);
        const dataSources = mountSources(doc.services[db]);
        if (!dataSources.length) add('volume', `has a database (${db}) with no volume of its own`);
        const others = Object.entries(doc.services).filter(([n]) => n !== db);
        const clash = dataSources.filter((s) => others.some(([, o]) => mountSources(o).includes(s)));
        if (clash.length) add('volume', `has a database (${db}) whose volume ${clash.join(', ')} another service mounts`);
        const encFlag = [doc.services[db].command ?? []].flat().some((c) => DB_ENCRYPTION_FLAG.test(String(c)));
        const encVolume = dataSources.some((s) => ENCRYPTED_VOLUME_OPT.test(JSON.stringify(doc.volumes?.[s]?.driver_opts ?? {})));
        if (!encFlag && !encVolume) add('encryption-db', `has a database (${db}) with no encryption setting (no encryption flag in its command, no encrypted data volume)`);
      }
      if (!MASTER_SECRET.some((k) => envNames(doc.services[tenant], environmentOf).includes(k))) add('encryption-app', `passes no master secret (${MASTER_SECRET.join(' or ')}) to the app`);
    }
  }
  return out;
}

export function decide(composes, environmentOf, allow, todayDate) {
  const tenants = composes.flatMap(({ file, doc }) => [...rolesOf(doc).app].map((t) => `${file}#${t}`));
  if (!tenants.length) throw new CannotAnswer('no tenant found: no service shares a network with a database service in any shipped compose file');
  const { problem, open, used } = applyAllow(findings(composes, environmentOf), allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${tenants.length} tenant(s) (${tenants.join(', ')}), ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} tenant control(s) missing: ${open.slice(0, 6).map((f) => f.text).join('; ')}${open.length > 6 ? `; and ${open.length - 6} more` : ''} (${tail})`)
    : holds(`every tenant has its own database process, its own volume and an encryption setting (${tail})`);
}

if (isMain(import.meta.url)) {
  await answer(async () => {
    const reader = await composeReader({ modules: modulesFlag(process.argv.slice(2)) });
    const composes = deploymentComposeFiles().map((file) => ({ file, doc: reader.loadCompose(file) }));
    return decide(composes, reader.environmentOf, readAllow(allowFileFor(import.meta.url)), today());
  });
}
