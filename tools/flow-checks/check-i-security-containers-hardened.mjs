#!/usr/bin/env node
/**
 * check-i-security-containers-hardened: each container runs non-root with capabilities dropped, a read-only root, no new privileges and resource
 * ceilings, and the services that parse untrusted input sit on internal-only networks.
 *
 * Rule (the flow node's stated assertion), read from the tracked compose files that ship to a deployment (`_compose-probe.mjs`, never the test
 * stack under `testing/`), parsed by the repository's one compose reader (`testing/_shared/compose-file.mjs`), per service:
 *
 *   - `user`:         the service sets a non-root `user:`, or it is built here (`build:`) from a tracked Dockerfile whose last `USER` is not root.
 *   - `cap_drop`:     lists `ALL`.
 *   - `read_only`:    is `true`.
 *   - `no-new-privileges`: `security_opt` lists `no-new-privileges:true`.
 *   - `limits`:       a memory ceiling (`mem_limit` or `deploy.resources.limits.memory`), `cpus` and `pids_limit` are declared.
 *   - `network`:      an untrusted-input parser, every network it is on is declared `internal: true`.
 *
 * Who a parser is comes from the topology, not a list: the database is the service whose image names mongo; the app is every service sharing a
 * network with it; a parser is every other service. A new sidecar is held to the rule the day it is added.
 *
 * Exceptions live only in `check-i-security-containers-hardened.allow.json`: `{ id: "<file>#<service>#<control>", reason, reviewBy }`. An entry
 * with no reason, past its reviewBy, or that excuses nothing any more fails the probe; the verdict says how many exceptions it used.
 *
 * The failure that bought it (Q-875): this check was named by the plan and verify phases and answered "cannot answer" from a placeholder, so a new
 * sidecar or a dropped `cap_drop` was found by a reader when it was found at all (`compose-sidecar-hardening.test.js` holds only the five sidecars it names).
 *
 *     node tools/flow-checks/check-i-security-containers-hardened.mjs [--modules <folder holding js-yaml>]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { composeReader, deploymentComposeFiles, modulesFlag, networksOf, rolesOf } from './_compose-probe.mjs';

const isRoot = (user) => /^(root|0)(:.*)?$/.test(String(user).trim());

/** The user a tracked Dockerfile ends as (its last `USER`), or null when it never sets one (root). */
export function dockerfileUser(text) {
  const users = [...text.matchAll(/^\s*USER\s+(\S+)/gim)].map((m) => m[1]);
  return users.length ? users[users.length - 1] : null;
}

/** The memory ceiling a service declares, either spelling, or null. */
const memoryOf = (service) => service.mem_limit ?? service.deploy?.resources?.limits?.memory ?? null;

/**
 * `[{ id, text }]` for every control a service lacks. `dockerfileOf(file, service)` returns a built service's Dockerfile text or null.
 * @param {{ file: string, doc: object }[]} composes
 */
export function findings(composes, dockerfileOf) {
  const out = [];
  for (const { file, doc } of composes) {
    const { parsers } = rolesOf(doc);
    for (const [name, svc] of Object.entries(doc.services)) {
      const add = (control, text) => out.push({ id: `${file}#${name}#${control}`, text: `${file}: ${name} ${text}` });
      let nonRoot = svc.user !== undefined && svc.user !== null && !isRoot(svc.user);
      if (!nonRoot && svc.build) {
        const df = dockerfileOf(file, svc);
        const u = df === null ? null : dockerfileUser(df);
        nonRoot = u !== null && !isRoot(u);
      }
      if (!nonRoot) add('user', 'does not run as a non-root user (no `user:` and no built Dockerfile ending in a non-root USER)');
      if (!(svc.cap_drop ?? []).map((c) => String(c).toUpperCase()).includes('ALL')) add('cap_drop', 'does not drop all capabilities (`cap_drop: [ALL]`)');
      if (svc.read_only !== true) add('read_only', 'has a writable root filesystem (`read_only: true`)');
      if (!(svc.security_opt ?? []).some((o) => /^no-new-privileges(:true)?$/.test(String(o)))) add('no-new-privileges', 'does not set `security_opt: [no-new-privileges:true]`');
      const lacking = [memoryOf(svc) ? null : 'a memory ceiling', svc.cpus ? null : 'cpus', svc.pids_limit ? null : 'pids_limit'].filter(Boolean);
      if (lacking.length) add('limits', `lacks ${lacking.join(', ')}`);
      if (parsers.has(name)) {
        const open = networksOf(svc).filter((net) => doc.networks?.[net]?.internal !== true);
        if (open.length) add('network', `parses untrusted input yet is on a network that is not internal-only (${open.join(', ')})`);
      }
    }
  }
  return out;
}

export function decide(composes, dockerfileOf, allow, todayDate) {
  const all = findings(composes, dockerfileOf);
  const { problem, open, used } = applyAllow(all, allow, todayDate);
  if (problem) return violated(problem);
  const services = composes.reduce((n, c) => n + Object.keys(c.doc.services).length, 0);
  const tail = `${services} service(s) in ${composes.map((c) => c.file).join(', ')}, ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} control(s) missing: ${open.slice(0, 6).map((f) => f.text).join('; ')}${open.length > 6 ? `; and ${open.length - 6} more` : ''} (${tail})`)
    : holds(`every service carries the container controls, and every untrusted-input parser is on internal-only networks (${tail})`);
}

/** A built service's Dockerfile text, read from the checkout; null when the service has no build or the file is missing. */
export function readDockerfile(file, svc, root = REPO_ROOT) {
  const context = typeof svc.build === 'string' ? svc.build : svc.build?.context ?? '.';
  const name = (typeof svc.build === 'object' && svc.build?.dockerfile) || 'Dockerfile';
  try { return readFileSync(join(root, posix.join(dirname(file), context, name)), 'utf8'); }
  catch { return null; }
}

if (isMain(import.meta.url)) {
  await answer(async () => {
    const reader = await composeReader({ modules: modulesFlag(process.argv.slice(2)) });
    const composes = deploymentComposeFiles().map((file) => ({ file, doc: reader.loadCompose(file) }));
    if (!composes.length) throw new CannotAnswer('no compose file');
    return decide(composes, (file, svc) => readDockerfile(file, svc), readAllow(allowFileFor(import.meta.url)), today());
  });
}
