/**
 * The copies of a server word list that the client and the docs carry, read as DATA so a test can hold them to the server's one list (Q-681).
 *
 * ## The question it answers
 *
 * "Which words does this client file, this language file or this union say?" - asked by every gate that compares a hand copy in the client
 * (`const KNOWN_STATUS = [...]`, a spec's `const STATUSES = [...] as const`, `"sync.status.<word>"` keys in en/de/pl, a TypeScript union of
 * string literals) with the list the server declares. Three gates had each parsed a client file with a regex of their own; the regex that
 * stops matching reports an empty list, and an empty list passes every comparison written over it.
 *
 * ## What it prevents
 *
 * A reader here THROWS where a copy it was asked for is not there (the constant was renamed, the file moved, the key prefix has no keys, the
 * union lost its anchor) and where what it found is empty. It never returns `[]` for "not found", so a comparison cannot go green because the
 * scan stopped matching. Comments are stripped before the source is read, so a word that survives only in a doc comment is not a copy.
 *
 * Paths are relative to the project root (the cwd a test runs from), as the standalone tests read `server/src/...`.
 */
import { readFileSync } from 'node:fs';
import { stripComments } from '../standalone/_strip-comments.mjs';

/** The string literals of one bracketed or union span, in order. */
const literalsOf = (span) => [...span.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)].map(m => m[1] ?? m[2]);

/**
 * The words of `const NAME = ['a', 'b'] (as const)?` in a client source file (a component or a spec).
 *
 * @param {string} file  project-root-relative path of a `.ts` file
 * @param {string} name  the constant's name
 * @returns {string[]} the literals, in source order; throws when the constant is absent or holds none
 */
export function clientConstList(file, name) {
  const src = stripComments(readFileSync(file, 'utf8'));
  const m = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!m) throw new Error(`${file} declares no \`const ${name} = [...]\`: re-anchor the gate that reads it (a missing copy is not an empty one)`);
  const words = literalsOf(m[1]);
  if (words.length === 0) throw new Error(`${file}: \`const ${name}\` holds no string literals`);
  return words;
}

/**
 * The words of a string-literal union in a client source file: the span of `'a' | 'b' | ...` that follows the first match of `anchor`.
 *
 * @param {string} file    project-root-relative path of a `.ts` file
 * @param {RegExp} anchor  what precedes the union (`/interface SyncHistoryRecord[\s\S]*?\bstatus\??:/`); matched against comment-free source
 * @returns {string[]} the literals of that union only (a `(string & {})` escape is not a word); throws when the anchor or the union is absent
 */
export function clientUnionWords(file, anchor) {
  const src = stripComments(readFileSync(file, 'utf8'));
  const at = anchor.exec(src);
  if (!at) throw new Error(`${file}: ${anchor} matches nothing: re-anchor the gate that reads it`);
  const rest = src.slice(at.index + at[0].length);
  const span = /^\s*((?:'[^'\\]*'|"[^"\\]*")(?:\s*\|\s*(?:'[^'\\]*'|"[^"\\]*"))*)/.exec(rest);
  if (!span) throw new Error(`${file}: no string-literal union follows ${anchor}`);
  return literalsOf(span[1]);
}

/** The language files the client ships, in the order the gates report them. */
export const CLIENT_LANGUAGES = Object.freeze(['en', 'de', 'pl']);

/**
 * The words under a dotted key prefix in each shipped language file (`client/public/assets/i18n/<lang>.json`, flat keys): for the prefix
 * `sync.status.`, the key `sync.status.partial` yields the word `partial`. A key deeper than one segment under the prefix is not a word of it.
 *
 * @param {string} prefix  the key prefix, ending in a dot
 * @returns {Record<string, Record<string, string>>} language -> word -> text; throws when a language file is missing or has no key under the prefix
 */
export function i18nKeysUnder(prefix) {
  if (!prefix.endsWith('.')) throw new Error(`i18nKeysUnder takes a prefix ending in a dot, got "${prefix}"`);
  const out = {};
  for (const lang of CLIENT_LANGUAGES) {
    const file = `client/public/assets/i18n/${lang}.json`;
    const dict = JSON.parse(readFileSync(file, 'utf8'));
    const words = {};
    for (const [key, text] of Object.entries(dict)) {
      if (!key.startsWith(prefix)) continue;
      const word = key.slice(prefix.length);
      if (word !== '' && !word.includes('.')) words[word] = text;
    }
    if (Object.keys(words).length === 0) throw new Error(`${file} has no key under "${prefix}": re-anchor the gate that reads it`);
    out[lang] = words;
  }
  return out;
}

/**
 * The backticked words of one table row of a docs page: the row that starts with the backticked `metric` name. `` `a`, `b` `` words anywhere in the
 * row count, so a row that stops naming a word is seen.
 *
 * @param {string} file    project-root-relative path of a `.md` file
 * @param {string} metric  the first cell's code span, without backticks
 * @returns {string[]} every code span of that row; throws when no row starts with the metric
 */
export function docsRowCodeSpans(file, metric) {
  const row = readFileSync(file, 'utf8').split('\n').find(l => l.startsWith(`| \`${metric}\` `));
  if (!row) throw new Error(`${file} has no table row for \`${metric}\`: re-anchor the gate that reads it`);
  return [...row.matchAll(/`([^`]+)`/g)].map(m => m[1]);
}
