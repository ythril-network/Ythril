/**
 * Does a changelog entry name an internal mechanism, or only an outcome and the public names?
 *
 * ## What it prevents (Q-975)
 *
 * The changelog and the release notes cut from it are public, and what outsiders read there is how Ythril works inside.
 * An idea published there can no longer be patented in Germany. The owner, 2026-11-27: "dont publish too much info in
 * changelog from now on. enforce in flows and on whatever door makes sense." An entry says what the reader can now do or
 * what changed for them, and it names the things a reader types or reads: a route, a tool, a parameter, a config key, an
 * environment variable, a code, a metric, a header. It never names the way the server does it.
 *
 * ## What it refuses, over one line of text
 *
 * 1. **A term from {@link MECHANISM_TERMS}** (an algorithm or data structure: bitmap, posting list, journal, lease ...),
 *    each with its reason. Anywhere in the line, in code spans too: `buildId` is refused although a tool answers it.
 * 2. **A source path**: `server/src/...`, `client/...`, `schema/...`, `sidecars/...`, `testing/...`, and any `.ts` or `.tsx`
 *    file. `scripts/` and `docs/` are paths a reader is told to run or open, so they pass.
 * 3. **An internal collection or storage name**: a collection a space owns (`<space>_rdf_quads`, `rdf_quads`), or one the
 *    server opens by name. Read from the code (`SPACE_COLLECTIONS` and every `col('name')`), never listed here.
 * 4. **A source identifier**: a camelCase, snake_case or PascalCase word in a code span that is no public name.
 *
 * ## What is public, and how it is known
 *
 * A name is public when the code says a caller can meet it. {@link surfacesOf} reads it from the tracked sources, with
 * comments out, and lists nothing by hand: every property key (a tool's parameters and answer fields, a config key, a
 * record field, a metric label), every string that is exactly one identifier (a tool name, a reason code, a metric name),
 * every dotted one (`sparql.maxRecordsChanged`), and every `:param` of a route. Environment variables and headers are not
 * camelCase or snake_case, so they are never refused. A route, tool, parameter or code that is renamed in the code is
 * followed on the next run, and the old name is refused.
 *
 * ## The limit
 *
 * A property key that only the server reads is public by this reading too: the rule cannot tell a field a client sees from one
 * it does not. It refuses a function, a class, a module or a collection by name, which is where a mechanism is named. The
 * term list is the owner's second net for an idea that is described in plain words.
 *
 * ## Which releases it holds
 *
 * `[Unreleased]` and every release after {@link EXEMPT_THROUGH}. The released sections up to it stay as published.
 *
 * Pure: it reads no file. {@link file://./_changelog-surfaces.mjs} reads the code and hands the files here.
 */
import { blankComments } from '../testing/standalone/_strip-comments.mjs';

/** The last release whose published text is not held to the rule. Newer releases and `[Unreleased]` are. */
export const EXEMPT_THROUGH = '6.5.7';

const versionOf = (name) => /^\[(\d+)\.(\d+)\.(\d+)\]/.exec(name)?.slice(1).map(Number) ?? null;

/** True for `[Unreleased]` and any `[x.y.z]` after {@link EXEMPT_THROUGH}. */
export function holdsMechanismRule(sectionName) {
  if (/^\[Unreleased\]/i.test(sectionName)) return true;
  const v = versionOf(sectionName);
  if (!v) return false;
  const limit = EXEMPT_THROUGH.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== limit[i]) return v[i] > limit[i];
  return false;
}

/**
 * Algorithms and data structures a changelog does not name. One row each: what is matched and why it is kept out. Add a
 * row when an entry slips one through; the reason is what the next author reads when the gate stops them.
 * @type {{ name: string, re: RegExp, reason: string }[]}
 */
export const MECHANISM_TERMS = [
  { name: 'bitmap', re: /\bbitmaps?\b/i, reason: 'a data structure of a search or filter index' },
  { name: 'posting list', re: /\bposting[- ]lists?\b/i, reason: 'the layout of an inverted index' },
  { name: 'inverted index', re: /\binverted[- ]index(?:es)?\b/i, reason: 'how a search is answered' },
  { name: 'B-tree', re: /\bB[- ]?trees?\b/i, reason: 'the structure under an index' },
  { name: 'bloom filter', re: /\bbloom[- ]filters?\b/i, reason: 'a probabilistic structure that gives a lookup its shortcut' },
  { name: 'LRU', re: /\bLRU\b/, reason: 'the eviction rule of a cache' },
  { name: 'journal', re: /\bjournal(?:s|ed|ing)?\b/i, reason: 'a write log that a derived store is brought up from' },
  { name: 'write-ahead log', re: /\bwrite[- ]ahead\b/i, reason: 'a durability mechanism' },
  { name: 'follower', re: /\bfollowers?\b/i, reason: 'a process that tails another store' },
  { name: 'fenced', re: /\bfenc(?:e|ed|es|ing)\b/i, reason: 'a token that keeps two writers apart' },
  { name: 'lease', re: /\bleas(?:e|es|ed)\b/i, reason: 'a time-bound ownership between processes' },
  { name: 'mutex', re: /\b(?:mutex(?:es)?|semaphores?)\b/i, reason: 'a lock between concurrent callers' },
  { name: 'buildId', re: /\bbuildId\b/, reason: 'the identity of a derived store\'s build' },
  { name: 'triple index', re: /\btriple[- ]index(?:es)?\b/i, reason: 'the storage a SPARQL query is answered from' },
  { name: 'bind join', re: /\b(?:bind|hash)[- ]joins?\b/i, reason: 'how a query\'s joins are planned' },
];

/** A path into our own tree. `scripts/` and `docs/` are commands to run and pages to open, so they are not here. */
const SOURCE_PATHS = [
  // `node testing/_init/x.mjs` is a command a contributor is told to run, as `node scripts/x.mjs` is; a module path is not.
  [/(?:^|[^\w])(?<!\bnode )((?:server|client|schema|sidecars|testing)\/[\w@./<>-]+)/, 'a path into the source tree'],
  [/\b[\w-]+\.tsx?\b/, 'a TypeScript file'],
];

/** The words of a code span that have the shape of a source identifier, with the shape. */
function identifierShape(word) {
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(word)) return 'camelCase';
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(word)) return 'snake_case';
  if (/^(?:[A-Z][a-z0-9]+){2,}$/.test(word)) return 'PascalCase';
  return null;
}

/** An identifier written as a collection key (`rdfQuads`) or a suffix (`rdf_quads`) is a name, never English. */
const isNameShaped = (w) => identifierShape(w) !== null;

/**
 * What the code says a caller can meet, and what it says is the server's own storage.
 *
 * @param {{ file: string, text: string }[]} files the tracked sources to read (`.ts` and `.mjs`), the one that declares
 *   `SPACE_COLLECTIONS` among them: without it this throws, so a scan that lost it never reads as "no collections".
 * @returns {{ publicNames: Set<string>, internalNames: Set<string>, collectionSuffixes: Set<string> }}
 */
export function surfacesOf(files) {
  const keys = new Set();
  const literals = new Set();
  const params = new Set();
  const internal = new Set();
  const suffixes = new Set();

  const collections = files.find(f => /(?:^|\/)db\/space-collection\.ts$/.test(f.file));
  const body = collections && /\bSPACE_COLLECTIONS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(blankComments(collections.text))?.[1];
  if (!body) throw new Error('surfacesOf: no `SPACE_COLLECTIONS` among the files; the collections a space owns cannot be told from the public names without it');
  // The camelCase key (`schemaSnapshots`) is a JavaScript name that a public field may share (the export's `schemaSnapshots`);
  // only the stored name (`schema_snapshots`) is the storage.
  for (const m of body.matchAll(/(\w+)\s*:\s*'([a-z_]+)'/g)) { internal.add(m[2]); suffixes.add(m[2]); }
  if (suffixes.size < 10) throw new Error(`surfacesOf: \`SPACE_COLLECTIONS\` holds ${suffixes.size} collections, fewer than the floor of 10; the reader stopped working`);

  for (const { text } of files) {
    // Imports and re-exports name functions, never anything a caller meets.
    const code = blankComments(text)
      .replace(/\bimport\s[^;]*?\bfrom\s*['"][^'"]+['"]/g, '')
      .replace(/\bexport\s*(?:type\s*)?\{[^}]*\}(?:\s*from\s*['"][^'"]+['"])?/g, '');
    for (const m of code.matchAll(/(?:^|[{,(])\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))\??\s*:(?!:)/gm)) keys.add(m[1] ?? m[2] ?? m[3]);
    // A shorthand property (`{ ok, filesAwaitingBytes }`) is a key too.
    for (const m of code.matchAll(/[{,]\s*([A-Za-z_]\w*)\s*(?=[,}])/g)) keys.add(m[1]);
    for (const m of code.matchAll(/(['"`])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\1/g)) for (const part of m[2].split('.')) literals.add(part);
    for (const m of code.matchAll(/(['"`])(\/[^'"`\s]*)\1/g)) for (const p of m[2].matchAll(/:([A-Za-z_]\w*)/g)) params.add(p[1]);
    // A collection the server opens by name outside a space (`col('ythril_counters')`).
    for (const m of code.matchAll(/\b(?:col|collection)\s*(?:<[^>()]*>)?\(\s*(['"`])(_?[a-z][a-z0-9_]*)\1/g)) {
      internal.add(m[2]); internal.add(m[2].replace(/^_/, '')); suffixes.add(m[2].replace(/^_/, ''));
    }
  }

  const publicNames = new Set([...keys, ...literals, ...params].filter(n => !internal.has(n)));
  return { publicNames, internalNames: internal, collectionSuffixes: suffixes };
}

/**
 * Every internal mechanism one line names, each as `{ rule, found, why }`; empty when it names none.
 *
 * @param {string} text one changelog line
 * @param {ReturnType<typeof surfacesOf>} surfaces
 */
export function mechanismsIn(text, surfaces) {
  const out = [];
  for (const t of MECHANISM_TERMS) {
    const m = t.re.exec(text);
    if (m) out.push({ rule: 'term', found: m[0], why: `"${m[0]}" is ${t.reason}` });
  }
  for (const [re, label] of SOURCE_PATHS) {
    const m = re.exec(text);
    if (m) out.push({ rule: 'path', found: m[1] ?? m[0], why: `"${m[1] ?? m[0]}" is ${label}` });
  }
  for (const span of text.matchAll(/`([^`]+)`/g)) {
    const collection = /<space[\w-]*>_(\w+)|\$\{[^}]+\}_(\w+)/.exec(span[1]);
    const spaceOwned = collection && (collection[1] ?? collection[2]);
    if (spaceOwned && surfaces.collectionSuffixes.has(spaceOwned)) {
      out.push({ rule: 'collection', found: collection[0], why: `"${collection[0]}" is a collection a space owns` });
    }
    for (const word of span[1].match(/[A-Za-z_]\w*/g) ?? []) {
      const bare = word.replace(/^_+/, '');
      if (bare === spaceOwned && surfaces.collectionSuffixes.has(bare)) continue; // said once, by the name that carries it
      if (isNameShaped(bare) && surfaces.collectionSuffixes.has(bare)) {
        out.push({ rule: 'collection', found: word, why: `"${word}" is a collection the server keeps` });
      } else if (identifierShape(word) && !surfaces.publicNames.has(word)) {
        out.push({ rule: 'identifier', found: word,
          why: `"${word}" is a ${identifierShape(word)} name in the source that no tool, parameter, config key, code, metric or route parameter carries` });
      }
    }
  }
  return out;
}

/**
 * Every offence in the sections the rule holds, over the whole changelog text: `{ section, n, rule, found, why }` with `n` the
 * 1-based line in the file.
 */
export function changelogMechanisms(changelogText, surfaces) {
  const out = [];
  let section = null;
  changelogText.split(/\r?\n/).forEach((text, i) => {
    const h = /^## (\[.+?\])/.exec(text);
    if (h) { section = h[1]; return; }
    if (/^## /.test(text)) { section = null; return; }
    if (!section || !holdsMechanismRule(section)) return;
    for (const p of mechanismsIn(text, surfaces)) out.push({ section, n: i + 1, ...p });
  });
  return out;
}

/** What an author is told beside the offences. */
export const MECHANISM_HINT = 'Say what the reader can now do or what changed for them, and name only what they type or read: a route, tool, '
  + 'parameter, config key, environment variable, code, metric or header. How the server does it stays out; the commit holds it.';

/** The offences as one message, for a gate that fails on them. */
export function describeMechanisms(offences, file = 'CHANGELOG.md') {
  const sample = offences.slice(0, 12).map(o => `  ${file}:${o.n}  ${o.section}  ${o.why}`).join('\n');
  return `${offences.length} changelog line(s) name an internal mechanism.\n${MECHANISM_HINT}\n${sample}`
    + (offences.length > 12 ? `\n  ... and ${offences.length - 12} more` : '');
}
