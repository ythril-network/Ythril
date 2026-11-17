#!/usr/bin/env node
/**
 * check-i-docs-refusals-and-messages-current: each documented error message matches the string the code emits.
 *
 * Rule (the flow node's stated assertion): extract the documented error strings; `git grep -F` each in the source dirs; zero hits is a finding.
 *
 *   - Documented strings: the value of every `"error": "..."` or `"message": "..."` in a tracked `docs/**\/*.md` page.
 *   - A string is cut into its literal pieces at a quoted value (`'general'`), a `<placeholder>`, a number and an ellipsis, because the code builds those
 *     parts at run time; its longest piece must appear verbatim in a tracked source under `server/src`, `client/src` or `schema/src`
 *     (specs left out: a test's copy of a message is not the code's). A string with no piece of 12 characters is counted as "too short to match"
 *     and named in the verdict, never silently passed.
 *   - Exceptions live only in `check-i-docs-refusals-and-messages-current.allow.json` beside this file: `{ text, reason, reviewBy }`. An entry
 *     with no reason, or past its reviewBy date, fails the probe; the verdict says how many exceptions it used.
 *   - The file lists come from `git ls-files` through `testing/standalone/_sources.mjs`, whose floor makes an empty listing throw.
 *
 * The failure that bought it (Q-875): the check was named by the verify phases and answered "cannot answer" from a placeholder, so a changed
 * refusal text was found by a reader when it was found at all.
 *
 *     node tools/flow-checks/check-i-docs-refusals-and-messages-current.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTrackedSources } from '../../testing/standalone/_sources.mjs';
import { stripSourceComments } from './_axe.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOW_FILE = join(HERE, 'check-i-docs-refusals-and-messages-current.allow.json');
const MIN_PIECE = 12;

export function readAllow() {
  try { return JSON.parse(readFileSync(ALLOW_FILE, 'utf8')); }
  catch (e) { throw new CannotAnswer(`${ALLOW_FILE} unreadable: ${e.message}`); }
}

/** Built fresh per use: a shared global regex keeps its position between pages. */
const documentedRe = () => /"(?:error|message)"\s*:\s*"((?:[^"\\\n]|\\.)+)"/g;

/** `[{ file, line, text }]`: every error or message string a docs page prints in an example, once per page and text. */
export function documentedStrings(pages) {
  const out = [];
  for (const { file, text } of pages) {
    const seen = new Set();
    for (const m of text.matchAll(documentedRe())) {
      const s = m[1].replace(/\\(["\\])/g, '$1');
      if (seen.has(s)) continue;
      seen.add(s);
      out.push({ file, line: text.slice(0, m.index).split('\n').length, text: s });
    }
  }
  return out;
}

/** The literal pieces of a documented string, longest first: the parts the code does not build at run time. */
export function fragmentsOf(text) {
  return text
    .split(/'[^']*'|`[^`]*`|<[^>]*>|\.{3}|\u2026|\b\d[\d.]*\b/)
    .filter(p => p.trim().length)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * Source text as the code's messages read at run time: `'a' +\n 'b'` joined, and each `${...}` (braces balanced) replaced by one marker character,
 * so a documented piece that stops where a value begins is found where the code writes the value.
 */
export function messageText(code) {
  const joined = code.replace(/(['"`])[ \t]*\+[ \t]*\r?\n?[ \t]*(['"`])/g, '');
  let out = '';
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '$' && joined[i + 1] === '{') {
      let depth = 1, j = i + 2;
      for (; j < joined.length && depth; j++) depth += joined[j] === '{' ? 1 : joined[j] === '}' ? -1 : 0;
      out += '\u0001';
      i = j - 1;
    } else out += joined[i];
  }
  return out;
}

/** The shortest run of the code's own words that lets a documented piece stand in for a message the code finishes with a value. */
const MIN_CHUNK = 20;

/**
 * Is `piece` emitted? Verbatim in some source, or (the code writes a value where the page prints an example one, such as
 * "This ${record} has changed...") some source chunk between two values, at least MIN_CHUNK characters and half the piece, is inside the piece.
 */
function emitted(piece, sources) {
  if (sources.some(s => s.text.includes(piece) || s.text.includes(piece.replace(/'/g, "\\'")))) return true;
  const need = Math.max(MIN_CHUNK, piece.trim().length / 2);
  return sources.some(s => s.text.includes('\u0001') && s.text.split(/[\u0001\n'"`]/).some(c => c.trim().length >= need && piece.includes(c)));
}

/** `today` is `YYYY-MM-DD`; `sources` are `{ file, text }` with comments left in (a message in a comment is not emitted, so they are stripped here). */
export function decide(strings, sources, allow, today) {
  const stripped = sources.map(s => ({ file: s.file, text: messageText(stripSourceComments(s.text)) }));
  for (const e of allow) {
    if (!e.text || !e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy ?? '')) return violated(`an exception needs its text, a reason and a reviewBy date: ${JSON.stringify(e)}`);
    if (e.reviewBy < today) return violated(`the exception for "${e.text.slice(0, 60)}" is past its reviewBy date ${e.reviewBy}: review it, then move the date`);
  }
  const allowed = new Set(allow.map(e => e.text));
  const missing = [], tooShort = [];
  let used = 0;
  for (const d of strings) {
    const piece = fragmentsOf(d.text)[0];
    if (allowed.has(d.text)) { used++; continue; }
    if (!piece || piece.trim().length < MIN_PIECE) { tooShort.push(d); continue; }
    if (!emitted(piece, stripped)) missing.push(d);
  }
  const tail = `${strings.length} documented string(s), ${used} exception(s) used, ${tooShort.length} too short to match`;
  return missing.length
    ? violated(`${missing.length} documented message(s) no source emits: ${missing.slice(0, 5).map(d => `${d.file}:${d.line} "${d.text.slice(0, 70)}"`).join('; ')}${missing.length > 5 ? `; and ${missing.length - 5} more` : ''} (${tail})`)
    : holds(`every documented message with a literal piece is emitted by the source (${tail})`);
}

if (isMain(import.meta.url)) {
  await answer(() => decide(
    documentedStrings(readTrackedSources(['docs'], { ext: ['.md'], floor: 10 })),
    readTrackedSources(['server/src', 'client/src', 'schema/src'], { ext: ['.ts'], specs: false }),
    readAllow(),
    new Date().toISOString().slice(0, 10),
  ));
}
