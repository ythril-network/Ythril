/**
 * What a compose file SAYS, read from the parsed YAML: the services, and the values they declare with their
 * `${VAR:-default}` defaults resolved.
 *
 * ## Why this exists, and why it is a module
 *
 * The gates over the test stack (`the-test-stack-leaves-the-machine-room`, `the-search-process-has-room-for-every-suite`,
 * `the-test-stacks-document-sidecars-are-hardened-like-production`, `network-segmentation`) each had their own way in:
 * one hand-split the file's text into service blocks and said, in a comment, that it was "the same reading" another
 * gate used — which was already YAML by then — and each carried its own `${VAR:-default}` resolver (two anchored on
 * the whole value, one a replace anywhere in it) and its own parser of a size like `1280m`, in two different units.
 * Three spellings of one rule disagree the first time a value is written in a shape only one of them reads (a
 * default inside a larger string, an uppercase-only variable name), and the one that is wrong is the one that
 * reports the stack green.
 *
 * Every question about a compose file's values has one answer here. `compose-start-sets.mjs` holds the other half
 * (which services a command starts together); it holds no budget and neither does this, so a rule and the reading
 * of its subjects never share a reason to change.
 *
 * ## What it refuses
 *
 * A file with no `services:` map throws (an empty stack passes every loop written over it), and so does a size it
 * cannot read: both would otherwise let a gate conclude about a stack it never saw.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { REPO_ROOT } from '../standalone/_sources.mjs';

/** A compose file, parsed: `rel` under `root` (default: this repository, whatever the working directory). */
export function loadCompose(rel, root = REPO_ROOT) {
  const doc = load(readFileSync(join(root, rel), 'utf8'));
  if (!doc || typeof doc.services !== 'object' || doc.services === null || Object.keys(doc.services).length === 0) {
    throw new Error(`${rel} does not parse to a compose file with services`);
  }
  return doc;
}

/** `${VAR:-default}` resolved to its default wherever it stands in the value — a port or option written with a variable means what its default says. */
export const resolveDefaults = (value) => String(value).replace(/\$\{[A-Za-z0-9_]+:-([^}]*)\}/g, '$1');

/**
 * The host address a published port binds, or null for "every interface" (a port with no host address binds 0.0.0.0).
 * Reads both spellings compose has — the short string and the long object — and resolves a `${VAR:-default}` to its default.
 */
export function boundAddress(port) {
  if (typeof port === 'object' && port !== null) return port.host_ip ?? null;
  const parts = resolveDefaults(port).replace(/\/(tcp|udp)$/, '').split(':');
  return parts.length >= 3 ? parts[0] : null;
}

/** Every published port of a service that is not bound to loopback, as JSON: what a gate over "listens on this machine only" reports. */
export function exposedPorts(service) {
  return (service.ports ?? []).filter((p) => boundAddress(p) !== '127.0.0.1').map((p) => JSON.stringify(p));
}

/** Is the whole value one `${VAR:-default}` — a ceiling a bigger runner can raise without editing the file? */
export const isOverridable = (value) => /^\$\{[A-Z0-9_]+:-[^}]+\}$/.test(String(value).trim());

/** A service key's value with its default resolved, as a trimmed string; null when the service does not declare it. */
export function resolvedValue(service, key) {
  const raw = service?.[key];
  return raw === undefined || raw === null ? null : resolveDefaults(String(raw).trim());
}

/** A size like `1280m`, `3g`, `512k` (or one written with a `${VAR:-default}`) in MiB. Throws on one it cannot read. */
export function memoryMiB(value) {
  const text = resolveDefaults(String(value).trim().replace(/^["']|["']$/g, ''));
  const m = text.match(/^([\d.]+)\s*([gmk])b?$/i);
  if (!m) throw new Error(`unreadable memory value: ${value}`);
  return Number(m[1]) * ({ g: 1024, m: 1, k: 1 / 1024 })[m[2].toLowerCase()];
}

/** A service's `environment`, as `{ KEY: value }` — compose accepts a map or a list of `KEY=value`. */
export function environmentOf(service) {
  const env = service?.environment;
  if (Array.isArray(env)) {
    return Object.fromEntries(env.map((e) => { const at = String(e).indexOf('='); return at < 0 ? [String(e), ''] : [String(e).slice(0, at), String(e).slice(at + 1)]; }));
  }
  return env && typeof env === 'object' ? { ...env } : {};
}
