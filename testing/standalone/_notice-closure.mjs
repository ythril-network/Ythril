/**
 * The production closure of one package, read out of `package-lock.json`, and the question "does NOTICE name each of them".
 *
 * ## What it prevents
 *
 * `notice-coverage.test.js` reads the DIRECT dependencies of both workspaces, and says why it stops there ("a gate nobody can
 * satisfy is a gate that gets deleted"). `jszip` showed the cost of that limit once: transitive, in the browser bundle, unattributed,
 * found by a person. A rule engine (`@bufbuild/cel`) is the first dependency added since whose licence story is carried by its
 * CHILDREN: the engine's own package ships no licence file, its spec data is derived from Google's, its protobuf runtime
 * carries a Google-named BSD clause, its regex engine is a port with two copyright holders. The obligation travels with each one
 * of them, so the question is asked of the whole closure of THIS dependency — bounded, and a set a person can keep honest —
 * without widening the direct-dependency gate to thousands.
 *
 * ## What it decides, once
 *
 * - which edges are production: `dependencies`, `optionalDependencies` and `peerDependencies` of a package whose lock entry is not
 *   `dev`; a development-only package is a build tool and reaches no user; a peer the declaring package's own lock entry marks optional
 *   (`peerDependenciesMeta`) is left out, because npm installs no optional peer;
 * - how a name resolves: the nearest `node_modules/<name>` going up from the requiring package (npm's own rule), so a nested copy
 *   is the one that ships and a hoisted one is found;
 * - what counts as named: a `###` or `####` heading of NOTICE that lists the FULL scoped name (`@bufbuild/cel`), alone or in a
 *   comma-separated list as the Angular packages are. A bare `cel` is not a name; a body sentence is not a heading.
 */

/** The lock's `packages` map, from `package-lock.json` text. */
export const packagesOf = (lockText) => JSON.parse(lockText).packages ?? {};

/** The lock key a requirement resolves to, from the package at `fromKey` (`''` is the root, `server` a workspace). */
function resolveKey(packages, fromKey, name) {
  /** The package whose `node_modules` holds `key`: `a/node_modules/b` is under `a`, anything else is under the root (`''`). */
  const parentOf = (key) => {
    const cut = key.lastIndexOf('/node_modules/');
    return cut === -1 ? '' : key.slice(0, cut);
  };
  let base = fromKey;
  for (;;) {
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (candidate in packages) return candidate;
    if (base === '') return null;
    base = parentOf(base);
  }
}

/**
 * Every package `entryName` pulls into production, itself included: `[{ name, key, version, license }]`, in discovery order.
 * `from` is the workspace that declares the dependency (`server`). Throws when the entry is not in the lock.
 */
export function productionClosure(packages, entryName, from = 'server') {
  const start = resolveKey(packages, from, entryName);
  if (!start) throw new Error(`${entryName} is not in the lock file (looked from '${from}')`);
  return closureFromKey(packages, start);
}

/**
 * Every package a WORKSPACE pulls into production, the workspace itself left out: `[{ name, key, version, license }]`. `workspaceKey`
 * is the workspace's own lock key (`schema`), never its `node_modules/<name>` entry: that one is a link (`{ resolved, link: true }`)
 * with no dependencies, so a walk started there finds nothing and a gate over it passes about nothing (Q-668, B1). Throws when the key
 * is not in the lock or is a link.
 */
export function workspaceClosure(packages, workspaceKey) {
  const entry = packages[workspaceKey];
  if (!entry) throw new Error(`workspace '${workspaceKey}' is not in the lock file`);
  if (entry.link === true) throw new Error(`'${workspaceKey}' is a link in the lock file, not a workspace: walk from the workspace's own key`);
  return closureFromKey(packages, workspaceKey).filter(p => p.key !== workspaceKey);
}

/**
 * Whether `entry` (a lock entry) marks its peer `dep` optional, in the entry's OWN `peerDependenciesMeta` and nowhere else: npm installs no
 * optional peer, so the package ships none of it and owes it no heading (the schema package's `typescript`, which only its `from-typescript`
 * entry reads, from the caller's own install). A peer with no meta, or `optional: false`, is installed and stays counted, and a meta on
 * another package says nothing about this edge, so the skip is one the declaring package makes by its own lock entry.
 */
function isOptionalPeer(entry, dep) {
  return entry.peerDependenciesMeta?.[dep]?.optional === true;
}

/** The production closure from one lock key, that key included. */
function closureFromKey(packages, start) {
  const seen = new Map();
  const queue = [start];
  while (queue.length) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    const entry = packages[key];
    if (!entry || entry.dev === true) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    seen.set(key, { name, key, version: entry.version, license: entry.license ?? null });
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(entry[field] ?? {})) {
        if (field === 'peerDependencies' && isOptionalPeer(entry, dep)) continue;
        const next = resolveKey(packages, key, dep);
        if (next) queue.push(next);
      }
    }
  }
  return [...seen.values()];
}

/** A line only the full Apache License 2.0 text carries (its appendix boilerplate does not). */
export const APACHE_TEXT = 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION';

/**
 * Whether `text` is the Apache License 2.0 itself: its first non-blank line is the title and the terms are there. A byte-order mark and
 * the leading indentation the published text carries are not a difference.
 */
export function isApacheLicenceText(text) {
  const lines = String(text).replace(/^\u{FEFF}/u, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines[0] === 'Apache License' && /^Version 2\.0\b/.test(lines[1] ?? '') && lines.includes(APACHE_TEXT);
}

/**
 * The licences a closure gate admits without an election: the permissive ones, as SPDX ids. `BlueOak-1.0.0` and `FreeBSD` (the FreeBSD
 * two-clause text, which `negotiate` names in a `licenses` array) joined with the SPARQL engine's closure (bundle-271, R7).
 */
export const PERMISSIVE_LICENCES = Object.freeze(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'FreeBSD']);

/**
 * The licence a package record declares, as one SPDX expression, from any of the forms npm has seen: a `license` string, a `license`
 * object (`{ type }`), or a `licenses` array (each `{ type }`, offered together, so joined by `OR`). `null` when it declares none.
 */
export function licenceOfRecord(record) {
  const l = record?.license;
  if (typeof l === 'string' && l.trim() !== '') return l.trim();
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type;
  if (Array.isArray(record?.licenses)) {
    const types = record.licenses.map(x => (typeof x === 'string' ? x : x?.type)).filter(t => typeof t === 'string' && t !== '');
    if (types.length === 1) return types[0];
    if (types.length > 1) return `(${types.join(' OR ')})`;
  }
  return null;
}

/** The arm NOTICE records Ythril elects for `name` (`... elects the MIT License` in the entry under a heading naming it), or null. */
export function electionIn(noticeText, name) {
  const lines = noticeText.split(/\r?\n/);
  const start = lines.findIndex(line => /^#{3,4}\s/.test(line) && line.replace(/^#{3,4}\s+/, '').split(',').map(p => p.trim().replace(/^`|`$/g, '').toLowerCase()).includes(name.toLowerCase()));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && /^#{2,4}\s/.test(line));
  const section = lines.slice(start, end < 0 ? undefined : end).join('\n');
  const m = /elects the (\S+) Licen[cs]e/i.exec(section) ?? /elects (\S+)/i.exec(section);
  return m ? m[1] : null;
}

/**
 * Whether a licence expression may ship: a permissive id alone, or a choice (`A OR B`) whose elected arm is permissive and is the arm NOTICE
 * records. An `AND`, a `WITH`, a copyleft id, an unknown one or none at all may not. Answers `{ ok, why }`.
 */
export function licenceVerdict(licence, election) {
  if (licence === null || licence === undefined) return { ok: false, why: 'declares no licence' };
  const arms = String(licence).replace(/^\(|\)$/g, '').split(/\s+OR\s+/);
  if (arms.some(a => /\s(AND|WITH)\s|[()]/.test(a))) return { ok: false, why: `${licence} is not a plain choice of licences` };
  if (arms.length === 1) return PERMISSIVE_LICENCES.includes(arms[0]) ? { ok: true } : { ok: false, why: `${licence} is not a permissive licence` };
  if (election === null || election === undefined) return { ok: false, why: `${licence} is a choice and NOTICE records no election` };
  if (!arms.includes(election)) return { ok: false, why: `NOTICE elects ${election}, which ${licence} does not offer` };
  return PERMISSIVE_LICENCES.includes(election) ? { ok: true } : { ok: false, why: `the elected arm ${election} is not permissive` };
}

/**
 * Whether a lock entry is installed in the Linux image: an optional package limited to other systems (`fsevents`, `os: ["darwin"]`) is
 * never installed there, so it ships nothing and owes no heading.
 */
export function installedOnLinux(entry) {
  if (entry?.optional !== true) return true;
  const os = entry.os;
  return !Array.isArray(os) || os.some(o => o === 'linux') || (os.every(o => o.startsWith('!')) && !os.includes('!linux'));
}

/** The package names the headings of a NOTICE list (`### a, b` gives both), full scoped names only. */
export function noticeHeadingNames(noticeText) {
  const names = new Set();
  for (const line of noticeText.split(/\r?\n/)) {
    const m = /^#{3,4}\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    for (const part of m[1].split(',')) names.add(part.trim().replace(/^`|`$/g, '').toLowerCase());
  }
  return names;
}

/** Which of `names` no NOTICE heading carries. */
export const missingFromNotice = (names, noticeText) => {
  const headings = noticeHeadingNames(noticeText);
  return names.filter(n => !headings.has(n.toLowerCase()));
};
