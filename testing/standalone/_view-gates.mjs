/**
 * The source questions Q-531's gates ask (bundle-100, plan rev 3.2: a proxy is a personal view, never a space).
 *
 * ## Why a module
 *
 * Each gate in `a-personal-view-has-one-home-in-the-source.test.js` reads the server's source, and each must be seen red by a
 * mutation in a SCRATCH COPY of a source file (the phase forbids proving a gate by editing the tree it reads). So every question
 * here takes the sources as an argument (`[{ file, text }]`): the gate hands it the tracked tree, a mutation run hands it the same
 * tree with one file's text replaced. One implementation for both, or the mutation proves a copy.
 *
 * ## How a site is named
 *
 * Comments are blanked (positions kept) before parsing, so neither a comment explaining a fix nor one describing the old rule
 * matches. A site belongs to the INNERMOST function around it, widened outward only where a question says so (a member list
 * filtered in a callback belongs to the function that holds the list). Lines are 1-based in the original file.
 */
import { readTrackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { ts, parseSource, lineOf } from '../_shared/syntax-tree.mjs';

/** The server's tracked TypeScript, read (floor inside `trackedSources`). */
export const serverSources = () => readTrackedSources('server/src', { ext: ['.ts'], floor: 300, specs: false });

/** A fresh regex per use: a shared /g regex under-scans. */
const re = (src, flags = '') => new RegExp(src, flags);

/** The name a reader would grep for: the declaration, the variable or property it is bound to, else its line. */
function nameOf(sf, fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && ts.isIdentifier(p.name)) return p.name.text;
  return `<function at line ${lineOf(sf, fn)}>`;
}

/** Every function-like node with a body, innermost-first lookup made cheap by sorting on span. */
function functionsOf(sf) {
  const out = [];
  const visit = (n) => {
    if (ts.isFunctionLike(n) && !ts.isSourceFile(n) && n.body) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Parsed, comment-blanked view of one source. */
function view({ file, text }) {
  const blank = blankComments(text);
  const sf = parseSource(file, blank);
  const fns = functionsOf(sf);
  const textOf = (n) => blank.slice(n.getStart(sf), n.end);
  /** Functions containing `at`, innermost first. */
  const around = (at) => fns.filter(f => f.getStart(sf) <= at && at < f.end).sort((a, b) => (a.end - a.getStart(sf)) - (b.end - b.getStart(sf)));
  const lineAt = (at) => blank.slice(0, at).split('\n').length;
  return { file, blank, sf, fns, textOf, around, lineAt, name: (f) => nameOf(sf, f) };
}

/**
 * Sites matching `pattern` (a regex source), each named by its function: the innermost one, or the innermost whose text passes
 * `widenUntil` when given. A match outside any function is named `<module>`.
 */
export function sitesOf(sources, pattern, { files = () => true, widenUntil } = {}) {
  const out = [];
  for (const s of sources) {
    if (!files(s.file)) continue;
    const v = view(s);
    for (const m of v.blank.matchAll(re(pattern, 'g'))) {
      const chain = v.around(m.index);
      const fn = widenUntil ? chain.find(f => widenUntil(v.textOf(f))) ?? chain[chain.length - 1] : chain[0];
      out.push({ file: s.file, line: v.lineAt(m.index), fn: fn ? v.name(fn) : '<module>', fnText: fn ? v.textOf(fn) : v.blank, match: m[0] });
    }
  }
  return out;
}

/** One finding per function, not per match. */
const byFunction = (sites) => [...new Map(sites.map(s => [`${s.file}#${s.fn}`, s])).values()];

// ── 1. no reader of config.spaces treats an entry as a proxy or a view ─────────────────────────────────────────────

/** The two modules whose job is to read spaces AND views: the store (a `'*'` member list is every space) and the migration. */
export const VIEW_HOMES = Object.freeze(['server/src/config/views.ts', 'server/src/config/migrate-proxies-to-views.ts']);
export const CONFIG_SPACES_READ = String.raw`\b(?:getConfig\(\)|cfg|config|fresh)\.spaces\b`;
const VIEW_OR_PROXY_WORD = String.raw`\bproxyFor\b|\bisProxy\w*\b|\.views\b|\bisView\b`;

export function configSpacesReadersThatMentionViews(sources) {
  const readers = byFunction(sitesOf(sources, CONFIG_SPACES_READ, { files: f => f.startsWith('server/src/') && !VIEW_HOMES.includes(f) }));
  return { readers, findings: readers.filter(r => re(VIEW_OR_PROXY_WORD).test(r.fnText)).map(r => `${r.file}:${r.line} ${r.fn} reads config.spaces and names ${re(VIEW_OR_PROXY_WORD).exec(r.fnText)[0]}`) };
}

// ── 2. one function computes the members a view reads ───────────────────────────────────────────────────────────────

export const THE_VIEW_MEMBER_FUNCTION = 'server/src/config/views.ts#viewReadMembers';
const REACH_OR_RUNG_CALL = String.raw`\b(?:holdsRung|reachesSpace|reachableSpaceIds|spacesWhereTokenMay)\s*\(`;
const MEMBER_LIST = String.raw`(?<!\b(?:net|network|n))\.members\b|\bproxyFor\b|\bresolveMemberSpaces\b|\bmemberSpaces\w*\(`;

/** Functions that narrow a member list by the caller's reach or rung: the behaviour, whatever the function is called. */
export function viewMemberComputers(sources) {
  const sites = sitesOf(sources, REACH_OR_RUNG_CALL, { files: f => f.startsWith('server/src/'), widenUntil: t => re(MEMBER_LIST).test(t) })
    .filter(s => re(MEMBER_LIST).test(s.fnText));
  return byFunction(sites).map(s => `${s.file}#${s.fn}`).sort();
}

// ── 3. every creation site refuses a retired id ─────────────────────────────────────────────────────────────────────

export const RETIRED_CHECK = 'assertNotRetiredSpaceId';
/** A new entry pushed into config.spaces, an id rewritten on a space entry, or the ids a reload added handed to their init. */
const CREATION = String.raw`\b(?:getConfig\(\)|cfg|config|fresh)\.spaces\.push\((?!\s*\.\.\.diff\.kept)|\bspace\.id\s*=(?!=)|\bfunction\s+\w+\s*\(\s*\{\s*added\b`;

export function creationSites(sources) {
  return byFunction(sitesOf(sources, CREATION, { files: f => f.startsWith('server/src/') && !VIEW_HOMES.includes(f) }));
}
export const creationSitesWithoutTheCheck = (sites) => sites.filter(s => !re(String.raw`\b${RETIRED_CHECK}\s*\(`).test(s.fnText)).map(s => `${s.file}:${s.line} ${s.fn}`);

// ── 4. every place a space leaves config drops it from every view ───────────────────────────────────────────────────

export const DROP_FROM_VIEWS = 'dropSpaceFromViews';
/** A filter that takes an entry out of config.spaces, or the reload's consumption of `removeSpaces`. */
const LEAVE = String.raw`\b(?:getConfig\(\)|cfg|config|fresh)\.spaces\s*=\s*(?:getConfig\(\)|cfg|config|fresh)\.spaces\.filter\(|\.removeSpaces\b(?!\s*\?\?)`;

export function leaveSites(sources) {
  return byFunction(sitesOf(sources, LEAVE, { files: f => f.startsWith('server/src/') && !VIEW_HOMES.includes(f) }));
}
export const leaveSitesWithoutTheDrop = (sites) => sites.filter(s => !re(String.raw`\b${DROP_FROM_VIEWS}\s*\(`).test(s.fnText)).map(s => `${s.file}:${s.line} ${s.fn}`);

// ── 5. one function removes tokens ──────────────────────────────────────────────────────────────────────────────────

const TOKENS_REMOVAL = String.raw`\.tokens\s*=\s*[\w.()]*\.tokens\.filter\(|\.tokens\.splice\(`;
const TOKENS_WRITE = String.raw`\.tokens\s*=(?!=)|\.tokens\.(?:push|splice)\(`;

/** The functions that take a token out of config.tokens, and every writer of config.tokens beside them. */
export function tokenWriters(sources) {
  const files = f => f.startsWith('server/src/');
  return {
    removers: byFunction(sitesOf(sources, TOKENS_REMOVAL, { files })),
    writers: byFunction(sitesOf(sources, TOKENS_WRITE, { files })),
    oauthClientWriters: byFunction(sitesOf(sources, String.raw`\.oauthClients\s*=(?!=)|\.oauthClients\.(?:push|splice)\(`, { files })),
  };
}

// ── 6. the word "proxy" in what a caller reads ──────────────────────────────────────────────────────────────────────

/** The HTTP sense of the word, which this rule is not about: a reverse proxy in front of the instance, and its settings. */
const HTTP_PROXY = /\b(?:reverse|trust|auth|dns|dev|forward|http|https|socks|corporate|outbound|egress)[ _-]?proxy|proxy[ _-]?(?:header|pass|protocol|chain|server|url|settings|config(?:uration)?|env)|TRUST_PROXY|HTTPS?_PROXY|NO_PROXY|behind (?:a|the|your) proxy|stalling-peer-proxy/i;

/**
 * A text says "proxy" in the SPACE sense: it names a retired field, or, once the HTTP sense is taken out, it still says proxy or
 * proxies in the same line or literal as a space or a member. A reverse proxy in front of the instance is described without either.
 */
const spaceSenseProxy = (s) => /\bproxyFor\b|\btargetSpace\b/.test(s)
  || (/prox(?:y|ies)/i.test(s.replace(new RegExp(HTTP_PROXY.source, 'gi'), '')) && /space|member/i.test(s));

/** "proxy" in the space sense: what the integration guide, the user guide and every MCP description must no longer say. */
export function proxyWordFindings({ toolSources, docs }) {
  const out = [];
  for (const { file, text } of toolSources) {
    const sf = parseSource(file, blankComments(text));
    const visit = (n) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
        && spaceSenseProxy(n.text)) out.push(`${file}:${lineOf(sf, n)} "${n.text.slice(0, 90)}"`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  for (const { file, text } of docs) {
    text.split('\n').forEach((line, i) => { if (spaceSenseProxy(line)) out.push(`${file}:${i + 1} ${line.trim().slice(0, 90)}`); });
  }
  return out;
}

/** The pages allowed to say it: the release history and the upgrade page, which must name what was removed. */
export const PROXY_WORD_ALLOWED = Object.freeze(['docs/integration-guide/02b-upgrading.md']);
export const mcpToolSources = () => readTrackedSources('server/src/mcp', { ext: ['.ts'], floor: 30, specs: false });
export const callerDocs = () => readTrackedSources('docs', { ext: ['.md'], floor: 40 })
  .filter(d => !PROXY_WORD_ALLOWED.includes(d.file) && !/CHANGELOG/i.test(d.file));
