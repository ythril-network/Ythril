#!/usr/bin/env node
/**
 * check-i-accessibility-i18n-deep-untranslated-and-unused: list the keys a non-source locale holds in the source language, and the source keys no
 * client file refers to; neither list may grow past its recorded ceiling.
 *
 * Rule (the flow node's stated assertion): per non-source locale, keys whose value equals the source value; keys of the source locale with zero
 * hits in the client source.
 *
 *   - The locales are the tracked `*.json` files of the shipped dictionary folder; the SOURCE locale is the client's own `defaultLang`
 *     (`app.config.ts`), never a name written here. Nested dictionaries are flattened to dotted keys.
 *   - UNTRANSLATED: a key of a non-source locale whose value, trimmed, equals the source value and holds a letter (a value of digits,
 *     placeholders and punctuation, `{{n}}` or `-`, reads the same in every language and is not a finding).
 *   - UNUSED: a source key that no tracked client source (specs out) holds, as text: the key quoted (`'a.b'`, `"a.b"`, a template literal),
 *     or reached by a prefix the code builds at run time (`'a.' + kind`, `` `a.${kind}` ``: a literal ending in a dot that is the start of the key).
 *     A key used only by a spec is unused: the product does not show it. A key under a REFUSAL PREFIX (`files.refusal.<code>`) is reached
 *     too, but only while its last part is a code the server can answer (`testing/standalone/_server-refusal-codes.mjs`) or the client spells
 *     the key itself (`${REFUSAL_CONSTANT}.name`, read by `_refusal-prefixes.mjs`): a sentence for a code the server stopped sending is dead
 *     and is named (second review F13; H7 had counted every key under a prefix used). `refusalText` builds the key at run time from the
 *     code the server sends, so no file spells it; the prefixes are read from the client
 *     by `testing/standalone/_refusal-prefixes.mjs`, the module the client's own spec (`data-acts-have-words.spec.ts`) reads them with, so no
 *     second list exists (bundle-270 H7: each write-closed code had added seven keys this check called unused).
 *   - Each list is a MEASURE (`untranslated:<locale>`, `unused:<source>`), held to a ceiling in `check-i-accessibility-i18n-deep-untranslated-and-
 *     unused.allow.json` (`{ id, max, reason, reviewBy }`, through `_allow.mjs applyCeilings`): a count above its ceiling is a finding, a ceiling for
 *     a count of zero is a problem, and a count below its ceiling is said in the verdict so the owner lowers it (a ceiling only goes down).
 *
 * The failure that bought it (Q-917): named by the accessibility lens and answered "cannot answer" from a placeholder; the shipped German and
 * Polish files copied English wording for keys added later and nothing counted them, and keys a retired page used stay in all three files.
 *
 *     node tools/flow-checks/check-i-accessibility-i18n-deep-untranslated-and-unused.mjs
 */
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { trackedSources, REPO_ROOT, SERVER_CODE_ROOTS } from '../../testing/standalone/_sources.mjs';
import { serverRefusalCodes } from '../../testing/standalone/_server-refusal-codes.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { refusalPrefixes } from '../../testing/standalone/_refusal-prefixes.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyCeilings, today } from './_allow.mjs';

/** The client's configuration file: it names the default (source) language. */
const CLIENT_CONFIG = 'client/src/app/app.config.ts';

/** A dictionary, flat: nested objects joined by dots; a value that is not a string is skipped. */
export function flatten(dict, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(dict)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
  }
  return out;
}

/** The source locale, from the client's own configuration text. */
export function sourceLocale(configText) {
  const m = /\bdefaultLang\s*:\s*['"]([\w-]+)['"]/.exec(stripComments(configText));
  if (!m) throw new CannotAnswer('the client configuration names no defaultLang: the source locale was not read');
  return m[1];
}

/** Keys of `locale` whose value equals the source's, as `[key]`; a value without a letter reads the same everywhere and is left out. */
export function untranslatedKeys(source, locale) {
  return Object.keys(locale).filter((k) => k in source && locale[k].trim() === source[k].trim() && /\p{L}/u.test(source[k].replace(/\{\{[^}]*\}\}/g, '')));
}

/** Prefixes the code builds keys from at run time: a literal that ends in a dot (`'a.b.'`, or `` `a.b.${x}` ``). */
export function dynamicPrefixes(code) {
  const out = new Set();
  for (const m of code.matchAll(/['"`]([A-Za-z][\w-]*(?:\.[\w-]+)*\.)(?:['"`]|\$\{)/g)) out.add(m[1]);
  return out;
}

/**
 * Source keys no client source holds, quoted or by a run-time prefix; `texts` are the sources, comments in. `refusalFamilies` are the refusal
 * prefixes (`files.refusal`): every key under one is looked up by the code the server sends, which no file spells.
 */
export function unusedKeys(sourceDict, texts, refusalFamilies = [], answered = undefined) {
  const code = texts.map(stripComments).join('\n');
  const prefixes = dynamicPrefixes(code);
  // The guard lives here, where a caller cannot drop it: refusal families without the codes the server answers cannot tell a live sentence from a dead one.
  if (refusalFamilies.length > 0 && !(Array.isArray(answered?.codes) && answered.codes.length > 0)) {
    throw new CannotAnswer('refusal prefixes were read but no codes the server can answer: a sentence under a prefix cannot be told live from dead');
  }
  const codes = new Set(answered?.codes ?? []);
  const spelled = new Set(answered?.spelled ?? []);
  const quoted = new Set();
  for (const m of code.matchAll(/['"`]([A-Za-z][\w-]*(?:\.[\w-]+)+)['"`]/g)) quoted.add(m[1]);
  // A key under a refusal prefix is looked up by the code the server sends, so it is used only while the server can answer that code (or the client
  // spells the key itself): a sentence for a code the server stopped sending is dead, whatever prefix it sits under (second review F13).
  const underPrefix = (k) => refusalFamilies.some((f) => k.startsWith(`${f}.`));
  const reachedByCode = (k) => underPrefix(k) && (codes.has(k.slice(k.lastIndexOf('.') + 1)) || spelled.has(k));
  const reached = (k) => quoted.has(k) || reachedByCode(k) || [...prefixes].some((p) => k.startsWith(p));
  // A plural key is reached by its base (`'a.b'` for `a.b.one` and `a.b.other`): the plural service appends the language's form.
  return Object.keys(sourceDict).filter((k) => !reached(k) && !(PLURAL_FORM.test(k) && reached(k.replace(PLURAL_FORM, ''))));
}

/** The forms a plural base is stored under. */
const PLURAL_FORM = /\.(?:zero|one|two|few|many|other)$/;

/** `[{ id, value, text }]`: one measure per non-source locale and one for the source's unused keys. */
export function measures({ source, dicts, texts, refusalPrefixes: families, refusalCodes, refusalSpelled }) {
  const out = [];
  for (const [locale, dict] of Object.entries(dicts)) {
    if (locale === source) continue;
    const keys = untranslatedKeys(dicts[source], dict);
    out.push({ id: `untranslated:${locale}`, value: keys.length, text: `${keys.length} key(s) of ${locale} equal the ${source} wording (${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', ...' : ''})` });
  }
  const unused = unusedKeys(dicts[source], texts, families, { codes: refusalCodes, spelled: refusalSpelled });
  out.push({ id: `unused:${source}`, value: unused.length, text: `${unused.length} ${source} key(s) no client file refers to (${unused.slice(0, 3).join(', ')}${unused.length > 3 ? ', ...' : ''})` });
  return out;
}

export function decide(input, ceilings, todayDate) {
  const { source, dicts, texts } = input;
  if (!dicts[source]) throw new CannotAnswer(`no dictionary file for the source locale ${source}`);
  if (Object.keys(dicts).length < 2) throw new CannotAnswer('only one locale file found: there is nothing to compare');
  for (const [l, d] of Object.entries(dicts)) if (Object.keys(d).length < 500) throw new CannotAnswer(`${l} holds ${Object.keys(d).length} keys: the dictionary was not read`);
  if (texts.length < 50) throw new CannotAnswer(`only ${texts.length} client sources read: the listing was not read`);
  // The floor the client's own spec asserts: a reader that found no refusal prefix would call every refusal sentence unused.
  if (!Array.isArray(input.refusalPrefixes) || input.refusalPrefixes.length < 4) throw new CannotAnswer(`only ${input.refusalPrefixes?.length ?? 0} refusal prefixes read from the client: the refusal sentences cannot be told from unused ones`);
  // The codes the server answers, from its own source: a reader that found none would call every refusal sentence dead.
  if (!Array.isArray(input.refusalCodes) || input.refusalCodes.length < 30) throw new CannotAnswer(`only ${input.refusalCodes?.length ?? 0} server refusal codes read: the sentences under the refusal prefixes cannot be told live from dead`);
  const m = measures(input);
  const { problem, over, used, slack } = applyCeilings(m, ceilings, todayDate);
  if (problem) return violated(problem);
  const tail = `${m.map((x) => `${x.id} ${x.value}`).join(', ')}; ${used} ceiling(s) used${slack.length ? `; ${slack.join('; ')}: lower the ceiling` : ''}`;
  return over.length
    ? violated(`${over.map((x) => `${x.text}, over its ceiling`).join('; ')} (${tail})`)
    : holds(`no untranslated or unused list is above its ceiling (${tail})`);
}

/** The real tree's input for {@link decide}. */
export function realInput() {
  const files = trackedSources(['client/public/assets/i18n'], { ext: ['.json'], floor: 2 });
  const dicts = Object.fromEntries(files.map((f) => [posix.basename(f, '.json'), flatten(JSON.parse(readFileSync(join(REPO_ROOT, f), 'utf8')))]));
  const config = readFileSync(join(REPO_ROOT, CLIENT_CONFIG), 'utf8');
  const sources = trackedSources(['client/src'], { ext: ['.ts', '.html'], floor: 100, specs: false }).filter((f) => !/\.spec\.ts$|\/testing\//.test(f));
  const app = trackedSources(['client/src/app'], { ext: ['.ts'], floor: 100 }).filter((f) => !/\.spec\.ts$/.test(f));
  const read = refusalPrefixes(app.map((f) => ({ file: f, src: readFileSync(join(REPO_ROOT, f), 'utf8') })));
  if (read.unresolved.length) throw new CannotAnswer(`a refusal prefix argument this reader cannot resolve: ${read.unresolved.join('; ')}`);
  const server = trackedSources(SERVER_CODE_ROOTS, { ext: ['.ts'], floor: 100, specs: false });
  const refusalCodes = serverRefusalCodes(server.map((f) => readFileSync(join(REPO_ROOT, f), 'utf8')));
  return {
    source: sourceLocale(config), dicts, texts: sources.map((f) => readFileSync(join(REPO_ROOT, f), 'utf8')),
    refusalPrefixes: read.prefixes, refusalSpelled: read.spelled, refusalCodes,
  };
}

if (isMain(import.meta.url)) {
  await answer(async () => decide(realInput(), readAllow(allowFileFor(import.meta.url)), today()));
}
