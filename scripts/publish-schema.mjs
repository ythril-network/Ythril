#!/usr/bin/env node
/**
 * Publishes `schema/` to npm from the `publish-schema` job of `publish.yml`, by TRUSTED PUBLISHING (Q-683).
 *
 * Usage: `node scripts/publish-schema.mjs` (a tag run of the job: it reads GITHUB_REF_NAME and GITHUB_SHA, and the version and the
 * package name from `schema/package.json`).
 *
 * ## The question it answers
 *
 * "Does this tag publish the schema package, and with which arguments?" {@link publishDecision} answers it as a pure function
 * (`{ action: 'skip' | 'publish' | 'refuse', argv?, level, message }`) over what the effects gathered: npm's version, the
 * environment, the registry's document and the version's manifest, the tag and the repository's tags, the packed file list. Every
 * branch is a row in `testing/standalone/publish-schema-decides.test.js`; the effects around it only gather and carry out.
 *
 * ## What it prevents
 *
 * A published npm version can never be republished or replaced, and the OIDC credential of the job can publish ANY version of the
 * package. So the script refuses what it does not understand instead of guessing:
 *
 *  - npm below 11.5.1 (it cannot exchange the OIDC token and would fall back to an ambient one);
 *  - a token in the environment (`NODE_AUTH_TOKEN`, `NPM_TOKEN`, an `npm_config_*auth*` key), which npm uses INSTEAD of the OIDC
 *    exchange, so provenance would be claimed for a publish that never used it (the KEY is named, never its value);
 *  - a tarball without LICENSE, NOTICE or `dist/index.js`, or with one empty: Apache-2.0 4(d) unmet on a public registry for good;
 *  - a registry answer that is not understood (a 5xx, a malformed or oversize body, a network error);
 *  - a version already on npm whose recorded `gitHead` is not this tag's commit: "present" proves a number exists, not that this tag
 *    made it;
 *  - the wrong dist-tag: a prerelease goes to `next`, a backfilled older line to `release-<major>.<minor>`, so `latest` never moves
 *    backwards or onto a candidate. "Highest" is `release-tags.mjs`'s one rule, the one the GitHub Release uses.
 *
 * ## The first publish, and why FIRST_NPM_VERSION stays
 *
 * A trusted publisher can only be configured on a package that exists, so the first version ({@link FIRST_NPM_VERSION}) is
 * published by hand. For that one version a 404 from the registry is a warning and a skip, so the first tag of the new job does not
 * fail. For any other version a 404 means the first publish never happened and the run refuses, naming it.
 *
 * The constant stays at 6.5.0 forever. Once 6.5.0 is on npm the 404 branch cannot occur for it, and the constant is the one place
 * the exception is spelled; moving it forward would turn the branch into a silent skip for a later version, the stale-skip defect
 * the design refused. The registry's CDN can serve a stale 404 for a short time after a first publish: a re-run in that window
 * reads "absent", tries to publish, and ends in a loud E403 (npm refuses the same version twice). That failure is safe, and the
 * re-run after the cache expires skips.
 *
 * Importing this module runs nothing: `main` sits behind `isEntryPoint`.
 */
import { spawnSync } from 'node:child_process';
import { readCappedBody } from './_shared/capped-body.mjs';
import { listReleaseTags } from './_shared/release-tag-list.mjs';
import { isHighestReleaseTag, semverOf } from './_shared/release-tags.mjs';
import { readSchemaPackage } from './_shared/schema-package.mjs';
import { isEntryPoint } from './_shared/script-cli.mjs';
import { workflowCommand } from './_shared/workflow-command.mjs';

/** The first version on npm, published by hand. It stays: see the docblock. */
export const FIRST_NPM_VERSION = '6.5.0';

/** The first npm that publishes by trusted publishing. */
const NPM_FLOOR = [11, 5, 1];

/** The environment keys that carry an npm credential: any of them is used instead of the OIDC exchange. */
const TOKEN_KEY = /^(NPM_TOKEN|NODE_AUTH_TOKEN)$|^npm_config_.*(_auth|authtoken)/i;

/** The files a tarball must carry, each with bytes. */
const REQUIRED_FILES = ['LICENSE', 'NOTICE', 'dist/index.js'];

const REGISTRY = 'https://registry.npmjs.org';
const REGISTRY_BODY_CAP = 5 * 1024 * 1024;

/** `schema/package.json`: the package's own name and version, read once. This script never spells the name. */
const MANIFEST = readSchemaPackage();
const NAME = MANIFEST.name;

const refuse = (message) => ({ action: 'refuse', level: 'error', message });
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Is the npm version at least {@link NPM_FLOOR}, compared as numbers (`11.10.0` is above `11.5.1`)? */
function npmIsRecentEnough(npmVersion) {
  const v = semverOf(npmVersion);
  if (!v) return false;
  const have = [v.major, v.minor, v.patch];
  for (let i = 0; i < NPM_FLOOR.length; i++) if (have[i] !== NPM_FLOOR[i]) return have[i] > NPM_FLOOR[i];
  return true;
}

/**
 * What a tag publishes, as a pure function of what the effects gathered.
 *
 * @param {object} input
 * @param {string} input.npmVersion `npm -v`
 * @param {Record<string, string | undefined>} input.env the process environment
 * @param {{ status?: number, body?: string, error?: Error }} input.registry the abbreviated package document
 * @param {{ status?: number, body?: string, error?: Error }} [input.versionDoc] the version's manifest, read for a version that is on npm
 * @param {string} input.version the package's version
 * @param {string} input.tag the tag the run is on
 * @param {string[]} input.tags every `v*` tag of the repository
 * @param {{ path: string, size: number }[]} [input.pack] the file list of `npm pack --dry-run --json`
 * @returns {{ action: 'skip' | 'publish' | 'refuse', argv?: string[], level: 'notice' | 'warning' | 'error', message: string }}
 */
export function publishDecision({ npmVersion, env, registry, versionDoc, version, tag, tags, pack }) {
  if (!npmIsRecentEnough(npmVersion)) {
    return refuse(`npm ${JSON.stringify(npmVersion)} cannot publish by trusted publishing: ${NPM_FLOOR.join('.')} or later is required`);
  }
  const tokenKey = Object.keys(env ?? {}).find((key) => TOKEN_KEY.test(key));
  if (tokenKey) return refuse(`${tokenKey} is set in the environment: npm would use it instead of the OIDC exchange, and provenance would not describe the publish`);

  if (registry?.error) return refuse(`the registry read failed: ${registry.error.message}`);
  if (registry?.status === 404) {
    if (version === FIRST_NPM_VERSION) {
      return { action: 'skip', level: 'warning', message: `${version} is the first npm version and the package does not exist on npm yet: publish it by hand (contribution guide), then re-run this job` };
    }
    return refuse(`the package is missing on npm but ${version} is not the first publish (${FIRST_NPM_VERSION}): the first publish never happened`);
  }
  if (registry?.status !== 200) return refuse(`the registry answered status ${registry?.status}`);
  const doc = parseJson(registry.body);
  if (!isObject(doc) || !isObject(doc.versions)) return refuse('the registry document is malformed (not a JSON object with versions)');

  if (Object.hasOwn(doc.versions, version)) {
    if (!env?.GITHUB_SHA) return refuse(`${version} is on npm and the run has no GITHUB_SHA to compare its gitHead with`);
    if (versionDoc?.error) return refuse(`the version manifest read of ${version} failed: ${versionDoc.error.message}`);
    if (versionDoc?.status !== 200) return refuse(`the version manifest of ${version} answered status ${versionDoc?.status}`);
    const manifest = parseJson(versionDoc.body);
    if (!isObject(manifest)) return refuse(`the version manifest of ${version} is malformed`);
    if (manifest.gitHead !== env.GITHUB_SHA) {
      return refuse(`${version} on npm records gitHead ${manifest.gitHead}, but this tag is ${env.GITHUB_SHA}: it was published from another commit`);
    }
    return { action: 'skip', level: 'notice', message: `${version} is already on npm, from this commit` };
  }

  if (!Array.isArray(pack)) return refuse('the pack list is missing: npm pack gave no file list');
  const bad = REQUIRED_FILES.filter((file) => !(pack.find((entry) => entry?.path === file)?.size > 0));
  if (bad.length > 0) return refuse(`the tarball lacks, or has empty: ${bad.join(', ')}`);

  const parsed = semverOf(version);
  if (!parsed) return refuse(`the version ${JSON.stringify(version)} is not a semver version`);
  const argv = ['publish', '-w', NAME];
  let distTag = 'latest';
  if (parsed.prerelease !== null) distTag = 'next';
  else if (!isHighestReleaseTag(tag, tags)) distTag = `release-${parsed.major}.${parsed.minor}`;
  // The highest release names no `--tag`: npm's default dist-tag is `latest`. The script never names `latest` itself.
  if (distTag !== 'latest') argv.push('--tag', distTag);
  return { action: 'publish', level: 'notice', argv, message: `publishing ${version} under the dist-tag ${distTag}` };
}

// ── the effects: gather the decision's inputs, carry its answer out ────────────────────────────────────────────────────────

/** Did the child fail (it did not start, a signal ended it, or it exited non-zero), and how: the text of its failure, or `null` when it succeeded. */
function childFailure(result) {
  if (!(result.error || result.signal || result.status !== 0)) return null;
  return result.error ? result.error.message : result.signal ? `signal ${result.signal}` : `status ${result.status}`;
}

/** Runs a child with an args array (no shell) and a timeout; a failure or a signal exits 1, naming the child. */
function runChild(label, command, args, timeoutMs) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs });
  const how = childFailure(result);
  if (how !== null) {
    console.log(workflowCommand('error', 'publish-schema', `${label} failed (${how})`));
    process.exit(1);
  }
  return result;
}

/** One registry read, bounded in time and size. A failed read is `{ error }`, never a throw. */
async function readRegistry(path, accept) {
  try {
    const res = await fetch(`${REGISTRY}/${path}`, { headers: { Accept: accept }, signal: AbortSignal.timeout(30_000) });
    return { status: res.status, body: (await readCappedBody(res, REGISTRY_BODY_CAP)).toString('utf8') };
  } catch (error) {
    return { error };
  }
}

/** The file list of `npm pack --dry-run --json`, or `undefined` when npm's answer is not one. */
function packedFiles(stdout) {
  const parsed = parseJson(stdout);
  return Array.isArray(parsed) && Array.isArray(parsed[0]?.files) ? parsed[0].files : undefined;
}

async function main() {
  const version = MANIFEST.version;
  const npmVersion = runChild('npm -v', 'npm', ['-v'], 30_000).stdout.trim();
  const tags = listReleaseTags();
  const pack = packedFiles(runChild('npm pack --dry-run', 'npm', ['pack', '--dry-run', '--json', '-w', NAME], 120_000).stdout);

  // A scoped name is one path segment: `@scope%2Fname`.
  const path = NAME.replace('/', '%2F');
  // The abbreviated document lists every version (it stays small as versions accumulate); it omits `gitHead`, which the version's
  // own manifest carries.
  const registry = await readRegistry(path, 'application/vnd.npm.install-v1+json');
  const versionDoc = await readRegistry(`${path}/${encodeURIComponent(version)}`, 'application/json');

  const decision = publishDecision({ npmVersion, env: process.env, registry, versionDoc, version, tag: process.env.GITHUB_REF_NAME, tags, pack });
  console.log(workflowCommand(decision.level, 'publish-schema', decision.message));
  if (decision.action === 'refuse') process.exit(1);
  if (decision.action !== 'publish') return;

  const result = spawnSync('npm', decision.argv, { encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'inherit', 'pipe'] });
  if (result.stderr) process.stderr.write(result.stderr);
  const publishFailure = childFailure(result);
  if (publishFailure !== null) {
    console.log(workflowCommand('error', 'publish-schema', `npm publish failed (${publishFailure})`));
    if (/\b(E404|E401|ENEEDAUTH)\b/.test(result.stderr ?? '')) {
      console.log(workflowCommand('error', 'trusted publisher', 'npm publish answered E404, E401 or ENEEDAUTH: the trusted publisher is not set for this package, repository, workflow file and environment; see the trusted-publishing steps in the contribution guide'));
    }
    process.exit(1);
  }
}

if (isEntryPoint(import.meta.url)) await main();
