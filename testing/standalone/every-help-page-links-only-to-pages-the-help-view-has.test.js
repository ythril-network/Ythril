/**
 * Every link of every page the Help view renders opens something IN the view, replayed with the view's own rule (bundle-56
 * round S R7, round V S4; generalised from the testing guide).
 *
 * ## What it prevents
 *
 * The Help view (`HELP_DOCS` in `client/src/app/pages/settings/help.component.ts`) renders each guide from `docs/`, a split
 * guide's parts joined into one document. The guides are written for GitHub, and a link that works there can be dead here in
 * three ways, none of which fails anything:
 *
 *  - a link to a repository path (`[LICENSE](../LICENSE)`): the view serves markdown pages only, so the click opens a new
 *    tab on an address that does not exist;
 *  - a link to a sibling page with no fragment (`](02-hosting.md)` in a part of the integration guide): read as written it
 *    names no page, and the click opened `assets/docs/02-hosting.md` — 42 links did, and the first version of this gate
 *    called them held because it read the link against the PAGE's directory, which is not what the view did;
 *  - a link whose `#anchor` is no heading the view renders: it opens the right guide and scrolls nowhere;
 *  - **a link to a page of the guide it sits in, with no fragment** (`](02-hosting.md)`, 35 of them): it resolves to a page, and
 *    the page is already on screen, so the reader stayed exactly where they were — the dead tab turned into a click that does
 *    nothing. The second version of this gate called them held because it replayed `resolveHelpLink` and not what the view does
 *    NEXT; a link is held only if it ends at an element of the document (or a guide switch, or the top of the guide).
 *
 * ## What is held, and how it is replayed rather than restated
 *
 * The guides, their parts and the pages are read out of the component's `HELP_DOCS` (over its syntax tree, with floors). For
 * each guide the gate builds the document the view builds — `joinHelpParts` of the real parts, which gives every part an
 * anchor — and renders it the way the view does: the real `marked` renderer with the real `makeSlugger` and `headingIdFor`
 * (the heading rule of `MarkdownRenderService`), then the real DOMPurify with the service's own configuration, over a jsdom
 * document, and the ids of the ELEMENTS that come out are the ids the view has. (A heading id the sanitizer removes is not in
 * that set: `## Links` was `id=""` in the joined integration guide, and a set of ids computed before the sanitizer did not
 * see it.) Then EVERY link of every rendered page goes through `resolveHelpLink`, the function the view's click handler calls,
 * with the directory the view resolves against (`guideDir`), and through `landingOf`, the function that says where it lands.
 * Those functions are loaded from the client source as they stand (`help-links.ts`, `heading-slug.ts`: pure, no imports), so a
 * change to the view's rule is a change to this gate's subject and not a second copy to forget. Pins hold the component to
 * them: it calls them, and it keeps no markdown-link pattern of its own.
 *
 * A link is fine when it is an external address, or an anchor/page the view opens with the element it names present.
 * Links inside fenced code blocks and inline code are not links, and are skipped. A split guide's index file
 * (`integration-guide.md`) is not rendered, so its links are not the view's; `doc-links-resolve` holds them for GitHub.
 *
 * Run: node --test testing/standalone/every-help-page-links-only-to-pages-the-help-view-has.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import ts from 'typescript';
import { stripComments } from './_strip-comments.mjs';

const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** The parsed tree of `text`, read as `file`'s language says (`.ts` is TypeScript; else JavaScript). */
const parseSource = (file, text) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.([cm]?ts|tsx)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);

/** A client source file that has no imports, loaded as it stands: transpiled, and imported from a data URL. */
async function clientModule(rel) {
  const source = read(rel);
  assert.doesNotMatch(stripComments(source), /^\s*import\s/m, `${rel} imports something: this gate loads it as a standalone module`);
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

const COMPONENT = 'client/src/app/pages/settings/help.component.ts';
const SERVICE = 'client/src/app/shared/markdown-render.service.ts';
const { resolveHelpLink, guideDir, renderedPagesOf, joinHelpParts, foldPartLinks, stripPartHeader, landingOf, partAnchorId } = await clientModule('client/src/app/pages/settings/help-links.ts');
const { makeSlugger, headingTextOf, headingIdFor, elementIdsFor } = await clientModule('client/src/app/shared/heading-slug.ts');
const { Marked } = await import('marked');
// The DOM and the sanitizer are the client's own builds (see the pin below), so the ids that come out are the ones the view has.
const clientRequire = createRequire(join(REPO_ROOT, 'client', 'package.json'));
const { JSDOM } = clientRequire('jsdom');
const createDOMPurify = clientRequire('dompurify');

/** The guides `HELP_DOCS` lists, read from the component's syntax tree: `{ id, file, parts? }`. */
function helpGuides() {
  const sf = parseSource(COMPONENT, read(COMPONENT));
  const guides = [];
  const strings = (node) => (ts.isArrayLiteralExpression(node) ? node.elements.filter(ts.isStringLiteralLike).map(e => e.text) : []);
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'HELP_DOCS' && n.initializer) {
      let list = n.initializer;
      while (ts.isAsExpression(list) || ts.isSatisfiesExpression(list) || ts.isParenthesizedExpression(list)) list = list.expression;
      for (const el of list.elements ?? []) {
        if (!ts.isObjectLiteralExpression(el)) continue;
        const prop = (name) => el.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === name)?.initializer;
        const id = prop('id'), file = prop('file'), parts = prop('parts');
        if (id && file) guides.push({ id: id.text, file: file.text, ...(parts ? { parts: strings(parts) } : {}) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return guides;
}

/** The options the service hands DOMPurify, read out of its source (the second argument of `DOMPurify.sanitize(`): the replay sanitizes as the view does. */
function serviceSanitizerOptions() {
  const sf = parseSource(SERVICE, read(SERVICE));
  let options;
  const visit = (n) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'DOMPurify.sanitize' && n.arguments[1]) options = n.arguments[1].getText(sf);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(options, `${SERVICE} no longer calls DOMPurify.sanitize(html, options): the replay of the view's sanitizer has nothing to read`);
  return new Function(`return (${options});`)();
}

const { window: DOM } = new JSDOM('');
const purify = createDOMPurify(DOM);
/** The sanitizer's own clobbering question, asked of a jsdom document (`isDomPropertyName` asks the browser's). */
const clobbersInDom = (id) => id in DOM.document || id in DOM.document.createElement('form');

/**
 * The document the view shows for `text`: the renderer's own heading rule (the real slugger and `headingIdFor`; a slug is
 * `[\w-]` only, so the service's `escapeHtml` of it changes nothing), then the sanitizer with the service's own options.
 * `clobbers` is the question `headingIdFor` asks; a caller may pass one that is never true to see the view WITHOUT the rule.
 */
function renderedDocumentOf(text, clobbers = clobbersInDom) {
  const slug = makeSlugger();
  const md = new Marked({
    renderer: { heading({ tokens, depth }) { const inner = this.parser.parseInline(tokens); return `<h${depth} id="${headingIdFor(slug(headingTextOf(inner)), clobbers)}">${inner}</h${depth}>\n`; } },
  });
  const clean = purify.sanitize(md.parse(text, { async: false }), serviceSanitizerOptions());
  return new JSDOM(`<body>${clean}</body>`).window.document;
}

/** The ids of the elements of `text` as the view renders it: headings and part anchors, whatever the sanitizer kept. */
const idsOfDocument = (doc) => new Set([...doc.querySelectorAll('[id]')].map(e => e.id).filter(id => id !== ''));

/** The markdown links of a page, outside fenced and inline code: `[text](target)`, never an image. */
function linksOf(text) {
  const prose = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
  return [...prose.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)].map(m => m[1]);
}

/**
 * What is wrong with `target`, written in a page of `guide`, or `null`: the question the view's click handler answers.
 * `idsOf(guide)` gives the ids of the elements the view renders for a guide.
 *
 * **A link is held only if it ENDS somewhere** — what `HelpComponent` does after `resolveHelpLink`: it asks `landingOf` where
 * the link lands and scrolls to the element with that id (the fragment's own id or its namespaced form, `elementIdsFor`), or
 * to the top of the guide when the landing has no anchor; in another guide it opens that guide first and does the same there.
 */
function problemOf(target, guide, guides, idsOf) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // an external address: opened in a tab by design
  const endsAt = (inGuide, anchor, what) => (elementIdsFor(anchor).some(id => idsOf(inGuide).has(id)) ? null : `no ${what} in ${inGuide.id}`);
  if (target.startsWith('#')) {
    let fragment = target.slice(1);
    try { fragment = decodeURIComponent(fragment); } catch { /* the view reads it as written then too */ }
    return endsAt(guide, fragment, `heading #${fragment}`);
  }
  const holder = (page) => guides.find(g => g.file === page || g.parts?.includes(page));
  const link = resolveHelpLink(target, guideDir(guide), (page) => holder(page) !== undefined);
  if (!link) return 'not a link to a markdown page: the view opens it in a tab on an address that does not exist (write a repository path as a code span)';
  if (link.page === null) return `names no page the view holds (${link.bare})`;
  const guideOfPage = holder(link.page);
  const { anchor } = landingOf(link, guideOfPage);
  if (anchor === undefined) return null; // the top of the guide the page belongs to: the view scrolls to the article or opens the guide
  return endsAt(guideOfPage, anchor, link.fragment === undefined ? `anchor for the page ${link.page} (a click would move nowhere)` : `heading #${link.fragment}`);
}

const guides = helpGuides();
const idCache = new Map();
const idsOfGuide = (guide) => {
  if (!idCache.has(guide.id)) {
    const files = renderedPagesOf(guide);
    idCache.set(guide.id, idsOfDocument(renderedDocumentOf(joinHelpParts(files.map(f => read(`docs/${f}`)), files))));
  }
  return idCache.get(guide.id);
};
/** `{ guide, page, target }` for every link of every rendered page, as the view receives it (a part's links folded). */
function everyLink() {
  const out = [];
  for (const guide of guides) {
    const files = renderedPagesOf(guide);
    for (const page of files) {
      const text = files.length === 1 ? read(`docs/${page}`) : foldPartLinks(stripPartHeader(read(`docs/${page}`)), files);
      for (const target of linksOf(text)) out.push({ guide, page, target });
    }
  }
  return out;
}

describe('the pages the Help view renders, and what it does with their links', () => {
  it('the scan finds the view\'s guides, pages, headings and links (a floor: an empty scan holds nothing)', () => {
    const pages = guides.flatMap(renderedPagesOf);
    assert.ok(guides.length >= 8, `only ${guides.length} guide(s) found in HELP_DOCS`);
    assert.ok(pages.length >= 20, `only ${pages.length} page(s) found in HELP_DOCS`);
    assert.ok(guides.some(g => g.parts && g.parts.length >= 5), 'no split guide found: the part-to-part rule is not exercised');
    for (const g of ['dependencies.md', 'contribution-guide.md']) assert.ok(pages.includes(g), `${g} is not among the view's pages`);
    assert.ok(guides.reduce((n, g) => n + idsOfGuide(g).size, 0) >= 200, 'the headings the view renders were not found: the replay of its renderer is broken');
    assert.ok(everyLink().length >= 100, 'too few links found in the pages: the pattern is broken');
  });

  it('every page is a file of docs/ (a page the view lists must exist to be read)', () => {
    const missing = guides.flatMap(g => [g.file, ...(g.parts ?? [])]).filter(p => { try { read(`docs/${p}`); return false; } catch { return true; } });
    assert.deepEqual(missing, []);
  });

  it('every link ENDS somewhere in the view: an external address, a guide it switches to, an element of the document, or the top', () => {
    const bad = [];
    for (const { guide, page, target } of everyLink()) {
      const why = problemOf(target, guide, guides, idsOfGuide);
      if (why) bad.push(`${page}: ${target} — ${why}`);
    }
    assert.deepEqual(bad, [], 'a link the Help view cannot take the reader through');
  });

  it('a link to a page of the guide it sits in lands on the start of that page: every part of a split guide has its anchor', () => {
    let checked = 0;
    for (const guide of guides.filter(g => g.parts)) {
      for (const part of guide.parts) {
        assert.ok(idsOfGuide(guide).has(partAnchorId(part)), `${guide.id}: the rendered document has no anchor for ${part}`);
        checked++;
      }
    }
    assert.ok(checked >= 20, `only ${checked} part(s) checked`);
    assert.ok(everyLink().filter(({ guide, target }) => guide.parts && landingOf(resolveHelpLink(target, guideDir(guide), (p) => guides.some(g => g.file === p || g.parts?.includes(p))) ?? { page: null }, guide).anchor?.startsWith('part:')).length >= 10,
      'no fragmentless sibling link was found: the case this test is about is not exercised');
  });

  it('every part anchor keeps an accessible name through the sanitizer: it is what a link to the part moves focus to (round X, W3)', () => {
    let anchors = 0;
    const nameless = [];
    for (const guide of guides.filter(g => g.parts)) {
      const files = renderedPagesOf(guide);
      const doc = renderedDocumentOf(joinHelpParts(files.map(f => read(`docs/${f}`)), files));
      for (const part of guide.parts) {
        const anchor = [...doc.querySelectorAll('[id]')].find(n => n.id === partAnchorId(part));
        anchors++;
        if (!anchor || !(anchor.getAttribute('aria-label') ?? '').trim() || anchor.getAttribute('role') !== 'group') nameless.push(`${guide.id}: ${part}`);
      }
    }
    assert.ok(anchors >= 20, `only ${anchors} part anchor(s) checked`);
    assert.deepEqual(nameless, [], 'a part anchor has lost its name or role in the sanitized document: focus would land on an element a screen reader cannot name');
  });

  it('no heading of any guide loses its id to the sanitizer (`## Links` was `id=""`: it is a property of `document`)', () => {
    let headings = 0;
    const lost = [];
    for (const guide of guides) {
      const files = renderedPagesOf(guide);
      const doc = renderedDocumentOf(joinHelpParts(files.map(f => read(`docs/${f}`)), files));
      for (const h of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) { headings++; if (h.id === '') lost.push(`${guide.id}: <${h.tagName.toLowerCase()}> ${h.textContent.trim()}`); }
    }
    assert.ok(headings >= 200, `only ${headings} heading(s) rendered`);
    assert.deepEqual(lost, [], 'a heading of a guide has no id after the sanitizer: no link can reach it');
  });

  it('and the check sees the defect: rendered WITHOUT the namespace rule, a `Links` heading has no id', () => {
    const without = renderedDocumentOf('## Links\n\n## Hosting\n', () => false);
    assert.deepEqual([...without.querySelectorAll('h2')].map(h => h.id), ['', 'hosting']);
    const withRule = renderedDocumentOf('## Links\n\n## Hosting\n');
    assert.deepEqual([...withRule.querySelectorAll('h2')].map(h => h.id), ['user-content-links', 'hosting']);
  });

  describe('the component is held to the rule this gate replays', () => {
    const component = stripComments(read(COMPONENT));
    it('resolves every link through resolveHelpLink, against guideDir, and joins a split guide with joinHelpParts', () => {
      for (const call of ['resolveHelpLink(', 'guideDir(', 'joinHelpParts(', 'renderedPagesOf(', 'landingOf(', 'elementIdsFor(']) {
        assert.ok(component.includes(call), `${COMPONENT} no longer calls ${call}: the gate replays a rule the view does not use`);
      }
    });
    it('keeps no markdown-link pattern of its own', () => {
      const sf = parseSource(COMPONENT, read(COMPONENT));
      const patterns = [];
      const visit = (n) => { if (ts.isRegularExpressionLiteral(n) && /\\\.md|\.md\b/.test(n.text)) patterns.push(n.text); ts.forEachChild(n, visit); };
      visit(sf);
      assert.deepEqual(patterns, [], 'the component reads markdown links by a pattern of its own: that is a second rule, and this gate does not replay it');
    });
    it('the renderer\'s heading rule is the one the replay mirrors: the slugger over the heading\'s text as the reader sees it', () => {
      const service = stripComments(read(SERVICE));
      assert.match(service, /makeSlugger\(\)/, 'the service no longer builds its ids with makeSlugger');
      assert.match(service, /headingIdFor\(slug\(headingTextOf\(inner\)\)\)/, 'the service\'s heading id is no longer headingIdFor(the slug of headingTextOf(its inline html))');
      assert.match(service, /this\.parser\.parseInline\(tokens\)/, 'the service no longer renders a heading\'s inline text with the parser');
    });
    it('the sanitizer keeps its clobbering protection: the replay would otherwise see ids the browser does not keep', () => {
      const service = stripComments(read(SERVICE));
      assert.doesNotMatch(service, /SANITIZE_DOM\s*:\s*false/, 'the service switched DOMPurify\'s DOM-clobbering protection off');
      assert.doesNotMatch(service, /SANITIZE_NAMED_PROPS/, 'the service changed how DOMPurify namespaces ids: the replay\'s ids are no longer the view\'s');
    });
    it('the `marked`, `dompurify` and `jsdom` the replay uses are the ones the client resolves', () => {
      for (const name of ['marked', 'dompurify', 'jsdom']) {
        const here = createRequire(import.meta.url).resolve(name);
        const client = clientRequire.resolve(name);
        assert.equal(here, client, `the gate and the client resolve different ${name} builds`);
      }
    });
  });

  describe('the rule, exercised over a miniature (a wrong decision in any row fails it)', () => {
    const mini = [
      { id: 'big', file: 'big.md', parts: ['big/01-a.md', 'big/02-b.md'] },
      { id: 'other', file: 'other.md' },
    ];
    const ids = { big: new Set(['alpha', 'beta', 'beta-1', 'user-content-links', partAnchorId('big/01-a.md'), partAnchorId('big/02-b.md')]), other: new Set(['top']) };
    const idsOf = (g) => ids[g.id];
    const [big, other] = mini;
    const refuse = (target, from, why) => assert.match(problemOf(target, from, mini, idsOf) ?? '', why, `${target} from ${from.id} should be refused`);

    it('holds', () => {
      for (const [t, from] of [
        ['https://example.com/x', big], ['mailto:a@b.c', big],
        ['#alpha', big], ['#beta-1', big], ['#links', big], ['02-b.md', big], ['02-b.md#alpha', big], ['./01-a.md', big], ['../other.md#top', big], ['other.md', big],
        ['big/02-b.md', other], ['big.md#beta', other], ['../big.md', other],
      ]) assert.equal(problemOf(t, from, mini, idsOf), null, `${t} from ${from.id} should be held`);
    });

    it('refuses a repository path, a page the view does not list, and a markdown link written for nowhere', () => {
      for (const t of ['../LICENSE', '../testing/_shared/x.mjs', 'NOTICE', '/docker-compose.yml']) refuse(t, big, /not a link to a markdown page/);
      refuse('unlisted.md', big, /names no page/);
      refuse('03-c.md', big, /names no page/);
      refuse('01-a.md', other, /names no page/);
    });

    it('refuses an anchor that is no heading the view renders, in the guide or in the page it names', () => {
      refuse('#gamma', big, /no heading #gamma/);
      refuse('02-b.md#gamma', big, /no heading #gamma in big/);
      refuse('other.md#alpha', big, /no heading #alpha in other/);
    });

    it('refuses a link to a page of the guide it sits in when the document has no element at that page\'s start (a click that moves nowhere)', () => {
      const noAnchors = (g) => (g.id === 'big' ? new Set(['alpha', 'beta']) : ids[g.id]);
      for (const t of ['02-b.md', './01-a.md', '02-b.md#alpha']) {
        const found = problemOf(t, big, mini, noAnchors);
        if (t.includes('#')) assert.equal(found, null, `${t} names a heading that exists and is held`);
        else assert.match(found ?? '', /no anchor for the page big\/0[12]-[ab]\.md/, `${t} from ${big.id} lands nowhere and should be refused`);
      }
      // the guide's own file is the top of it and needs no element; so does a guide that is one file
      assert.equal(problemOf('../big.md', big, mini, noAnchors), null);
      assert.equal(problemOf('other.md', other, mini, idsOf), null);
    });

    it('refuses a fragment whose element the view does not have under either spelling', () => {
      refuse('#links-2', big, /no heading #links-2/);
      const bare = (g) => new Set([...ids[g.id]].filter(id => id !== 'user-content-links'));
      assert.match(problemOf('#links', big, mini, bare) ?? '', /no heading #links/, 'an id the sanitizer removed is not an element');
    });

    it('the rule the first version of this gate had would have held what the view cannot open', () => {
      // `02-b.md` from `big/01-a.md`, read against the PAGE's directory, was held; the view read it as written. The replay
      // runs the view's function, so the same link is held here only because the view resolves it too.
      assert.equal(problemOf('02-b.md', big, mini, idsOf), null);
      assert.ok(resolveHelpLink('02-b.md', 'big', (p) => p === 'big/02-b.md')?.page === 'big/02-b.md');
      assert.ok(resolveHelpLink('02-b.md', 'big', (p) => p === '02-b.md') !== null && resolveHelpLink('02-b.md', 'big', (p) => p === 'nothing.md')?.page === null);
    });

    it('does not read a link inside code', () => {
      assert.deepEqual(linksOf('a `[x](../LICENSE)` b\n```\n[y](../NOTICE)\n```\n[z](userguide.md)'), ['userguide.md']);
    });
  });
});
