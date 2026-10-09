/**
 * Reading the SERVER's source from a client spec — the declared keys of an interface and the members of a union.
 *
 * ## Why this exists
 *
 * The client types a server response by hand. Nothing ties `ServerVoteRound` to the `VoteRound` the server
 * serves, so the server gained `metaChangedFields`, `changedTypes`, `keptTypes` and `proposesLayer` and the page
 * could not show a voter what a round changed — no error anywhere, the fields were simply never copied. A spec that
 * derives both key sets from source turns "the server added a field" into a red line naming it.
 *
 * Comments are stripped first (a gate must not read its subject's explanation), and nested object types are
 * blanked so only the declaring level's keys are found. It throws instead of returning an empty answer: an
 * interface that was renamed or a file that moved would otherwise report "no keys, nothing missing".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT } from './tracked-sources';
import { stripComments } from './strip-comments';

/** A tracked file under the repository root, comments stripped. */
export function readRepoSource(relativeToRepo: string): string {
  return stripComments(readFileSync(resolve(CLIENT_ROOT, '..', relativeToRepo), 'utf8'));
}

/** A tracked file under `client/`, comments stripped. */
export function readClientSource(relativeToClient: string): string {
  return stripComments(readFileSync(resolve(CLIENT_ROOT, relativeToClient), 'utf8'));
}

/** The text between the braces of `interface <name> { … }`; throws when there is no such interface. */
export function interfaceBody(src: string, name: string): string {
  const start = new RegExp(`\\binterface\\s+${name}\\b[^{]*\\{`).exec(src);
  if (!start) throw new Error(`no interface ${name} found — the source moved or was renamed, and a gate over it would report clean about nothing`);
  let depth = 1;
  let i = start.index + start[0].length;
  const from = i;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(from, i - 1);
}

/** The property names an interface declares at its own level. */
export function interfaceKeys(src: string, name: string): string[] {
  let body = interfaceBody(src, name);
  for (let prev = ''; prev !== body;) { prev = body; body = body.replace(/\{[^{}]*\}/g, '{}'); }
  const keys = [...body.matchAll(/(?:^|[;\n])\s*(?:readonly\s+)?([A-Za-z_]\w*)\??\s*:/g)].map(m => m[1]);
  return [...new Set(keys)];
}

/** The string-literal members of the type of one property of an interface, following one level of type alias. */
export function propertyLiterals(src: string, iface: string, key: string): string[] {
  const body = interfaceBody(src, iface);
  const m = new RegExp(`(?:^|[;\\n\\s])${key}\\??\\s*:\\s*([^;\\n]+(?:\\n\\s*\\|[^;\\n]+)*)`).exec(body);
  if (!m) return [];
  return literalsOf(src, m[1]);
}

/** The string-literal members of `type <name> = 'a' | 'b'`; throws when there is no such alias. */
export function aliasLiterals(src: string, name: string): string[] {
  const m = new RegExp(`\\btype\\s+${name}\\s*=\\s*([^;]+);`).exec(src);
  if (!m) throw new Error(`no type alias ${name} found`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

function literalsOf(src: string, typeText: string): string[] {
  const direct = [...typeText.matchAll(/'([^']+)'/g)].map(x => x[1]);
  if (direct.length) return direct;
  const alias = /^\s*([A-Za-z_]\w*)\s*$/.exec(typeText.trim());
  if (!alias) return [];
  try { return aliasLiterals(src, alias[1]); } catch { return []; }
}
