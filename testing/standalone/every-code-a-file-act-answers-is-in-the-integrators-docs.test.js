/**
 * Every `code` a file act answers is named where an integrator reads status codes, a page that states THE SET states all of it,
 * and a retired or invented one is named nowhere.
 *
 * ## The defect it prevents
 *
 * `files/act-answers.ts` is the one place a file act's refusal or failure becomes a status, a `code` and a sentence, on
 * every door. An integrator branches on `code` (a client that meets one it does not know acts on the status), so a code
 * the docs do not list is a capability nobody knows about, and a code the docs still list after the server stopped
 * answering it is a branch that never fires. Both were true at once while a move onto another file's records answered
 * `destination_taken_by_other` and the guide described the replacement it no longer made.
 *
 * The same defect arrived a second time as a LIST: the upgrade page (`02b-upgrading.md`) named seven of the eight codes
 * while the status table named all of them, so an integrator who read the upgrade notes met `destination_held_after_move`
 * with no sentence about it. A page that lists the codes is somebody's whole reference for them, and a list that stops one
 * short is invisible from the inside.
 *
 * ## What it holds
 *
 * The codes are DERIVED from the module's own `code: '<x>'` literals with its comments removed (the same read the client spec
 * makes), never listed here; the floor guards the derivation.
 *
 *  - (a) `03-auth-and-limits.md` and `05-files-api.md` each name every code (the status table and the page whose refusals it
 *    points to).
 *  - (b) A page that states THE SET says so with `<!-- file-act-codes -->` on the line before its list, and the list (the
 *    block up to the next blank line or heading: a table, one bullet, a paragraph) names every code. The pages are every
 *    page of `docs/integration-guide/` and the `[Unreleased]` section of the changelog (a released section is history and
 *    names what was true then). The COMPLEMENT is derived, not listed: an UNMARKED page that names at least
 *    `NAMES_ENOUGH_TO_BE_THE_SET` distinct codes fails, so a page that quietly became a list of the codes cannot stay
 *    unmarked and stop one short. At least `MARKED_PAGES_FLOOR` marked pages must exist, or the marker is a convention
 *    nobody follows and the complement has nothing to compare against.
 *  - (c) No page of the docs or the changelog names, in a `code` form (`"code": "x"`, `` `code: "x"` ``), a code the server
 *    source does not spell. It reads the server source, not only `act-answers.ts`: the docs name other APIs' codes in the same
 *    form (`space_name_in_use`), and a check against the act answers alone would call each of them invented. What it catches
 *    is a code that was spelled once and is not any more, or was misspelled in the page.
 *  - A retired code is named by no page of the guide, the user guide or the changelog; it is the one entry kept by hand,
 *    because a gate cannot derive what no longer exists.
 *
 * The rule is exercised on synthetic text as well as on the real pages, so a weakening of the block, the complement or the
 * code form fails here without waiting for a page to drift.
 *
 * Run: node --test testing/standalone/every-code-a-file-act-answers-is-in-the-integrators-docs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allDocsText, docFiles, DOCS_ROOT } from './_docs.mjs';
import { stripComments } from './_strip-comments.mjs';
import { readTrackedSources } from './_sources.mjs';

const ANSWERS = 'server/src/files/act-answers.ts';
const PAGES = ['docs/integration-guide/03-auth-and-limits.md', 'docs/integration-guide/05-files-api.md'];

/** Codes a file act no longer answers. Folded into `destination_exists` when a move stopped replacing anything. */
const RETIRED = ['destination_taken_by_other'];

/** The line a page puts before the list that states the whole set of codes. */
const MARKER = 'file-act-codes';
const markerPattern = () => new RegExp(`<!--\\s*${MARKER}\\s*-->`, 'g');

/** An unmarked page naming this many distinct codes is a list of them in all but name (two is a page that mentions a refusal). */
const NAMES_ENOUGH_TO_BE_THE_SET = 3;
/** The fewest pages that state the set: the integrator's status table and the upgrade page, at the least. */
const MARKED_PAGES_FLOOR = 2;

const codesIn = (src) => [...new Set([...stripComments(src).matchAll(/code: '([a-z_]+)'/g)].map(m => m[1]))];
const codes = codesIn(readFileSync(ANSWERS, 'utf8'));

/** The codes `text` names, in the two spellings a doc uses: `` `code` `` and `"code"`. */
const namedIn = (text, all = codes) => all.filter(code => text.includes(`\`${code}\``) || text.includes(`"${code}"`));

/**
 * The lists a page marks: for each marker, the block that follows it, up to the next blank line or heading. A block is one
 * table, one bullet or one paragraph, so a marker cannot claim a whole page as its list.
 */
function markedLists(text) {
  const lists = [];
  for (const m of text.matchAll(markerPattern())) {
    const lines = text.slice(m.index + m[0].length).split(/\r?\n/).slice(1);
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    const block = [];
    for (; i < lines.length && lines[i].trim() !== '' && !/^#{1,6}\s/.test(lines[i]); i++) block.push(lines[i]);
    lists.push(block.join('\n'));
  }
  return lists;
}

/** What is wrong with a page, as sentences: a marked list short of a code, an empty one, or an unmarked page that states the set. */
function listProblems(name, text, all = codes) {
  const lists = markedLists(text);
  if (lists.length === 0) {
    const named = namedIn(text, all);
    if (named.length < NAMES_ENOUGH_TO_BE_THE_SET) return [];
    return [`${name} names ${named.length} of the ${all.length} codes without a \`<!-- ${MARKER} -->\` list: mark the list that states the set `
      + `and make it name all of them (it lacks: ${all.filter(c => !named.includes(c)).join(', ') || 'none'})`];
  }
  return lists.flatMap((list, n) => {
    const missing = all.filter(c => !namedIn(list, all).includes(c));
    if (list.trim() === '') return [`${name}: marker ${n + 1} is followed by no list`];
    return missing.length === 0 ? [] : [`${name}: the list after marker ${n + 1} does not name: ${missing.join(', ')}`];
  });
}

/** The pages the rule governs: every integration-guide page, and the changelog's `[Unreleased]` section. */
function governedPages() {
  const pages = docFiles().filter(f => f.startsWith('integration-guide/'))
    .map(f => ({ name: `docs/${f}`, text: readFileSync(join(DOCS_ROOT, f), 'utf8') }));
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const start = changelog.search(/^## \[Unreleased\]/m);
  assert.ok(start > -1, 'CHANGELOG.md has no `## [Unreleased]` section: re-anchor this gate');
  const rest = changelog.slice(start + 1);
  const next = rest.search(/^## \[/m);
  pages.push({ name: 'CHANGELOG.md [Unreleased]', text: next === -1 ? rest : rest.slice(0, next) });
  return pages;
}

/** The `code` forms a doc spells: `"code": "x"`, `` `code: "x"` ``, `code: 'x'`. */
const codeFormsIn = (text) => [...new Set([...text.matchAll(/\bcode"?\s*:\s*["']([a-z][a-z0-9_]*)["']/g)].map(m => m[1]))];

describe('the codes a file act answers are in the integrator docs', () => {
  it('finds the codes (the scan itself still works)', () => {
    assert.ok(codes.length >= 8, `only found ${codes.length} codes in ${ANSWERS}`);
    assert.ok(codes.includes('destination_exists'), 'the move refusal is among them');
  });

  it('reads a code from the code, not from the prose around it', () => {
    assert.deepEqual(codesIn("// code: 'in_a_comment'\n/* code: 'in_a_block' */\nreturn { code: 'real_one' };"), ['real_one']);
  });

  for (const page of PAGES) {
    it(`${page} names every code`, () => {
      const text = readFileSync(page, 'utf8');
      const missing = codes.filter(code => !text.includes(`\`${code}\``) && !text.includes(`"${code}"`));
      assert.deepEqual(missing, [], `${page} does not name: ${missing.join(', ')}`);
    });
  }

  it('no page of the docs or the changelog names a retired code', () => {
    const text = `${allDocsText()}\n${readFileSync('CHANGELOG.md', 'utf8')}`;
    const named = RETIRED.filter(code => text.includes(code));
    assert.deepEqual(named, [], `still documented: ${named.join(', ')}`);
  });
});

describe('a page that states the set of codes marks its list, and the list holds every code', () => {
  const ALL = ['alpha_one', 'beta_two', 'gamma_three', 'delta_four'];
  const full = ALL.map(c => `| \`${c}\` | x |`).join('\n');

  it('a marked list that names every code is clean, in a table, a bullet and a paragraph', () => {
    assert.deepEqual(listProblems('p', `# T\n\n<!-- ${MARKER} -->\n${full}\n\nprose`, ALL), []);
    assert.deepEqual(listProblems('p', `<!--${MARKER}-->\n\n- ${ALL.map(c => `\`${c}\``).join(', ')}\n`, ALL), []);
    assert.deepEqual(listProblems('p', `<!-- ${MARKER} -->\r\n${ALL.map(c => `"${c}"`).join(' ')}\r\n`, ALL), []);
  });

  it('a marked list one code short fails, naming the code', () => {
    const short = ALL.slice(0, 3).map(c => `| \`${c}\` | x |`).join('\n');
    assert.deepEqual(listProblems('p', `<!-- ${MARKER} -->\n${short}\n`, ALL),
      ['p: the list after marker 1 does not name: delta_four']);
  });

  it('a code named only AFTER the list ends does not count for the list', () => {
    const three = ALL.slice(0, 3).map(c => `| \`${c}\` | x |`).join('\n');
    assert.equal(listProblems('p', `<!-- ${MARKER} -->\n${three}\n\nlater \`delta_four\`\n`, ALL).length, 1);
    assert.equal(listProblems('p', `<!-- ${MARKER} -->\n${three}\n# Heading\n\`delta_four\`\n`, ALL).length, 1);
  });

  it('a marker with no list after it fails', () => {
    assert.equal(listProblems('p', `<!-- ${MARKER} -->\n\n# Next\n`, ALL).length, 1);
  });

  it('an UNMARKED page naming enough codes fails, however complete it is; one naming fewer is left alone', () => {
    assert.equal(listProblems('p', full, ALL).length, 1);
    assert.equal(listProblems('p', `\`alpha_one\` and \`beta_two\` only`, ALL).length, 0);
    assert.equal(listProblems('p', `\`alpha_one\` \`beta_two\` \`gamma_three\``, ALL).length, 1);
  });

  const pages = governedPages();
  const marked = pages.filter(p => markedLists(p.text).length > 0);

  it('finds the pages it governs, and the changelog section among them', () => {
    assert.ok(pages.length >= 10, `only ${pages.length} pages found: the page scan is broken`);
    assert.ok(pages.some(p => p.name.endsWith('02b-upgrading.md')), 'the upgrade page is governed');
    assert.ok(pages.some(p => p.name === 'CHANGELOG.md [Unreleased]'), 'the changelog section is governed');
  });

  it('enough pages state the set under the marker (the complement has something to compare against)', () => {
    assert.ok(marked.length >= MARKED_PAGES_FLOOR,
      `only ${marked.length} page(s) carry \`<!-- ${MARKER} -->\`; the status table (03), the files page (05), the upgrade page (02b) `
      + 'and the changelog section each state the set and each must mark its list');
  });

  it('every marked list holds every code, and no unmarked page names enough of them to be one', () => {
    const problems = pages.flatMap(p => listProblems(p.name, p.text));
    assert.deepEqual(problems, [], problems.join('\n'));
  });
});

describe('no doc names a code the server source does not spell', () => {
  it('reads a `code` form in each spelling and nothing else', () => {
    assert.deepEqual(codeFormsIn('{ "code": "a_b" } `code: "c_d"` code: \'e_f\' "codes": "no" decode: "no"'), ['a_b', 'c_d', 'e_f']);
  });

  // Every string literal the server source spells, so a code spelled once and renamed is found by its absence.
  const spelled = new Set();
  const sources = readTrackedSources(['server/src'], { floor: 300, specs: false });
  for (const { text } of sources) for (const m of stripComments(text).matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)) spelled.add(m[1]);

  it('finds the server source and the act codes in it (the sweep itself still works)', () => {
    for (const code of codes) assert.ok(spelled.has(code), `${code} is not among the literals read from the server source`);
    assert.ok(spelled.size >= 1000, 'the literal sweep found far too few strings');
  });

  it('every `code` form in the docs and the changelog is a code the server source spells', () => {
    const text = `${allDocsText()}\n${readFileSync('CHANGELOG.md', 'utf8')}`;
    const forms = codeFormsIn(text);
    assert.ok(forms.length >= codes.length, 'the docs hold fewer `code` forms than the file act alone has codes: the form read is broken');
    const invented = forms.filter(c => !spelled.has(c));
    assert.deepEqual(invented, [], `named in a code form but spelled by no server file: ${invented.join(', ')}`);
  });
});
