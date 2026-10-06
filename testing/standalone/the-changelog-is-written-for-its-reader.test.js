/**
 * The changelog is written for the person upgrading, and it stays short enough to be read.
 *
 * ## Why this exists
 *
 * By 2026-10 `CHANGELOG.md` was 5 273 lines and 445 KB, and `[Unreleased]` alone was 1 272 lines. Every entry was
 * individually accurate and every one was written by whoever fixed the defect, for the people who fixed it: how the
 * defect was found and who reported it, the earlier attempts, ticket ids, bundle names, the test that now holds the
 * line, the reasoning. The reader — an operator or an integrator deciding whether to upgrade — had to dig the one
 * sentence they needed out of a paragraph about our own process. The owner said so on 2026-10-06: *"still bloated,
 * has history and books of text; needs a densing down and organization."*
 *
 * Nobody chose that either. Each PR appended a block, and each block was fine.
 *
 * ## What it holds, over EVERY section (derived from the file; the floor guards the derivation)
 *
 * - **An entry is one to two lines, 300 characters at most.** What changed and what it means to the reader; the
 *   story goes in the commit message, the ticket or the code.
 * - **No internal id.** `Q-…`, `B-…`, `bundle-…`, `G…`, `I…`, a PR number in prose: none of them mean anything to
 *   someone who does not have our tracker, and each one is a pointer into history.
 * - **No narration of how we found it.** "Reported by", "found by", "owner decision", the canary, the fleet
 *   integrator.
 * - **Headings are the six kinds, once each**, and every entry opens with a bold subject (`**Sync:**`) with the
 *   entries of one subject adjacent, so a reader who cares about sync reads one run of lines, not the whole section.
 * - **A release opens with one sentence** saying what it is, then, if anything breaks, a
 *   `| Changes on upgrade | Action |` table with a row per break.
 * - **A ceiling on the size**, which only goes down (see the two constants).
 *
 * ## What it deliberately does not hold
 *
 * That an entry is TRUE or COMPLETE: no test can tell that a dense line kept the fact a reader needed. Every
 * breaking change, env var, route, tool, parameter, metric, config key, status-code change and security fix has to
 * survive a rewrite, and that is a review, not a regex.
 *
 * Run: node --test testing/standalone/the-changelog-is-written-for-its-reader.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILE = 'CHANGELOG.md';

/** An entry is at most this many source lines. Wrapped at 120 columns, two lines is ~240 characters. */
const MAX_ENTRY_LINES = 2;
/** ... and at most this many characters once its lines are joined: the 240 the style asks for plus a margin. */
const MAX_ENTRY_CHARS = 300;
/** The one sentence a release opens with. */
const MAX_OPENING_CHARS = 300;

/**
 * THE CEILINGS ARE A RATCHET: lower them, never raise them. Both are the densified file's own figure plus a margin
 * of about 10 per cent, so a section that grows past its neighbours fails here before it becomes the next 1 272
 * lines. A change that genuinely needs more room tightens older entries to make it — which is the point.
 *
 * SECTION_MAX_LINES: the longest section of the densified file (`[Unreleased]`, 229 lines, whose upgrade table alone
 * is 32 rows) plus the margin. Every released section is far under it — the largest, 5.0.0 which renamed every public
 * name at once, is 167 — so for a patch release it is a loose bound; the entry cap above is what keeps a patch short.
 * And at the cut `[Unreleased]` becomes a release section, so it must fit the same ceiling.
 * FILE_MAX_BYTES: the whole file, densified, plus the margin, counted with LF endings so a Windows checkout and CI
 * agree. The file was 445 058 bytes.
 */
const SECTION_MAX_LINES = 250;
/** A `**Subject:**` lead names a product area; longer than this, it is a sentence in bold. */
const SUBJECT_MAX_CHARS = 39;
const FILE_MAX_BYTES = 134000;

/** The six kinds, in Keep-a-Changelog order with this project's `Internal` last. */
const KINDS = ['Added', 'Changed', 'Removed', 'Fixed', 'Security', 'Internal'];

/** The table a release's breaking changes go in. */
const TABLE_HEADER = '| Changes on upgrade | Action |';

/**
 * What an internal id looks like. Each is a pointer into our own tracker or history.
 *   - `Q-343`, `B-5`, `F-31`: a ticket id is ONE capital, a dash and digits.
 *   - `bundle-30`, `bundle-b53`: a work bundle.
 *   - `G18`: a work group inside a bundle.   - `I15`: an inventory id.
 *   - `#1483`: a PR number (three or more digits, so `#1` in prose about a list is not caught).
 */
const INTERNAL_IDS = [
  [/\b[A-Z]-\d+(?:\.\d+)?\b/, 'ticket id (Q-343)'],
  [/\bbundle-\w+/i, 'bundle name'],
  [/\bG\d+\b/, 'group id (G18)'],
  [/\bI\d+\b/, 'inventory id (I15)'],
  [/(?:^|[^\w&])#\d{3,}\b/, 'PR number (#1483)'],
];

/** How we found it, who said so, and what we call ourselves. The reader needs the change, not the provenance. */
const NARRATION = [
  [/\bowner(?:'s)? (?:decision|ruling|rule)\b/i, 'owner decision'],
  [/\b(?:reported|found|noticed|spotted) (?:by|in|while|when|on)\b/i, 'how it was found'],
  [/\bcanary\b/i, 'the canary'],
  [/\bfleet integrator\b/i, 'the fleet integrator'],
  [/\*Docs changed:?\*/i, 'a list of the docs files we touched'],
];

/** Strip inline code, so an id-shaped word that is a literal (a config key, a regex in a refusal) is not flagged. */
const withoutCode = (s) => s.replace(/`[^`]*`/g, '``');

/** The file as sections: `{ name, start (1-based heading line), lines }`, `Earlier releases` excluded. */
function sectionsOf(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let cur = null;
  lines.forEach((l, i) => {
    if (/^## /.test(l)) {
      cur = /^## \[/.test(l) ? { name: l.replace(/^## /, '').trim(), start: i + 1, lines: [] } : null;
      if (cur) out.push(cur);
      return;
    }
    if (cur) cur.lines.push({ n: i + 1, text: l });
  });
  return out;
}

/**
 * Every list entry of a section and every table row, each with the lines it spans.
 * An entry is a `- ` line and the non-blank lines after it that are not a new bullet, heading or table row.
 */
function entriesOf(section) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  for (const { n, text } of section.lines) {
    if (!text.trim()) { flush(); continue; }
    if (/^\s*(?:[-*]|\d+\.) /.test(text)) { flush(); cur = { n, kind: 'bullet', rows: [text] }; continue; }
    if (/^\|/.test(text)) {
      flush();
      if (!/^\|[\s|:-]+\|?$/.test(text)) out.push({ n, kind: 'row', rows: [text] });
      continue;
    }
    if (/^#{1,6} /.test(text)) { flush(); continue; }
    if (cur) cur.rows.push(text);
    else flush();
  }
  flush();
  return out.map(e => ({ ...e, text: e.rows.map(r => r.trim()).join(' ') }));
}

const src = readFileSync(FILE, 'utf8');
const sections = sectionsOf(src);
const releases = sections.filter(s => /^\[\d+\.\d+\.\d+\]/.test(s.name));

/** Fail with the offenders per section, so a writer sees where to cut rather than a bare count. */
function assertNone(offenders, what, how) {
  const bySection = new Map();
  for (const o of offenders) bySection.set(o.section, (bySection.get(o.section) ?? 0) + 1);
  const summary = [...bySection].map(([s, n]) => `${s}: ${n}`).join('; ');
  const sample = offenders.slice(0, 12).map(o => `  ${FILE}:${o.n}  ${o.why}`).join('\n');
  assert.equal(offenders.length, 0,
    `${offenders.length} ${what}\n${how}\nper section — ${summary}\n${sample}`
    + (offenders.length > 12 ? `\n  ... and ${offenders.length - 12} more` : ''));
}

describe('the changelog is written for its reader', () => {
  it('finds the sections and entries to check at all (the check itself works)', () => {
    // A regex that stopped matching would turn every assertion below into a pass over nothing.
    assert.ok(sections.some(s => s.name === '[Unreleased]'), '`## [Unreleased]` is missing');
    assert.ok(releases.length >= 10, `only ${releases.length} release sections found; a heading format changed?`);
    const entries = sections.flatMap(entriesOf);
    assert.ok(entries.filter(e => e.kind === 'bullet').length >= 100,
      'fewer than 100 list entries found across the whole file; the entry reader stopped working');
    assert.ok(entries.filter(e => e.kind === 'row').length >= 5, 'no table rows found; the table reader stopped working');
  });

  it('every list entry and table row is at most two lines and 300 characters', () => {
    const offenders = [];
    for (const s of sections) {
      for (const e of entriesOf(s)) {
        const lines = e.rows.length;
        if (lines > MAX_ENTRY_LINES || e.text.length > MAX_ENTRY_CHARS) {
          offenders.push({ section: s.name, n: e.n, why: `${lines} lines, ${e.text.length} chars: ${e.text.slice(0, 70)}…` });
        }
      }
    }
    assertNone(offenders, `entries over ${MAX_ENTRY_LINES} lines or ${MAX_ENTRY_CHARS} characters.`,
      'State what changed and what it means for the reader, in one or two lines. The reasoning goes in the commit.');
  });

  it('no internal id appears in the text a reader sees', () => {
    const offenders = [];
    for (const s of sections) {
      for (const { n, text } of s.lines) {
        const t = withoutCode(text);
        for (const [re, label] of INTERNAL_IDS) {
          const m = re.exec(t);
          if (m) offenders.push({ section: s.name, n, why: `${label}: "${m[0].trim()}"` });
        }
      }
    }
    assertNone(offenders, 'lines carry an internal id.',
      'A ticket, bundle, group or PR number points into our tracker. Say what changed; leave the pointer out.');
  });

  it('nothing narrates how a defect was found or who said so', () => {
    const offenders = [];
    for (const s of sections) {
      for (const { n, text } of s.lines) {
        for (const [re, label] of NARRATION) {
          const m = re.exec(text);
          if (m) offenders.push({ section: s.name, n, why: `${label}: "${m[0]}"` });
        }
      }
    }
    assertNone(offenders, 'lines narrate provenance instead of the change.',
      'The reader needs the behaviour and what to do about it, not the story of how it reached us.');
  });

  it('every heading is one of the six kinds, once per section', () => {
    const offenders = [];
    for (const s of sections) {
      const seen = new Set();
      for (const { n, text } of s.lines) {
        const m = /^### (.+?)\s*$/.exec(text);
        if (!m) continue;
        if (!KINDS.includes(m[1])) offenders.push({ section: s.name, n, why: `"### ${m[1]}" is not one of ${KINDS.join(', ')}` });
        else if (seen.has(m[1])) offenders.push({ section: s.name, n, why: `"### ${m[1]}" appears twice` });
        seen.add(m[1]);
      }
    }
    assertNone(offenders, 'headings are not the six kinds, or repeat.',
      'Breaking changes are rows in the `Changes on upgrade` table; everything else sorts under one of the six.');
  });

  it('every entry opens with a bold subject, and the entries of one subject sit together', () => {
    const offenders = [];
    for (const s of sections) {
      // The leads, in order, per `###` heading.
      let heading = null;
      let order = [];
      const closed = new Set();
      let last = null;
      const bullets = entriesOf(s).filter(e => e.kind === 'bullet');
      const headingAt = new Map();
      for (const { n, text } of s.lines) if (/^### /.test(text)) headingAt.set(n, text);
      for (const e of bullets) {
        const h = [...headingAt].filter(([n]) => n < e.n).map(([, t]) => t).pop() ?? null;
        if (h !== heading) { heading = h; order = []; closed.clear(); last = null; }
        // A subject is a product area, so a short name: the length is the rule, checked beside the shape.
        const m = /^(?:[-*]|\d+\.) \*\*([A-Z][A-Za-z0-9 /&,.'-]*):\*\*/.exec(e.text);
        if (!m || m[1].length > SUBJECT_MAX_CHARS) { offenders.push({ section: s.name, n: e.n, why: `no \`**Subject:**\` lead: ${e.text.slice(0, 60)}…` }); continue; }
        const subject = m[1];
        if (subject !== last) {
          if (closed.has(subject)) offenders.push({ section: s.name, n: e.n, why: `"${subject}" returns after other subjects (${heading})` });
          if (last) closed.add(last);
          last = subject;
        }
        order.push(subject);
      }
    }
    assertNone(offenders, 'entries lack a subject lead or scatter a subject.',
      'Start each entry `- **Sync:** …` and keep one subject\'s entries adjacent under its heading.');
  });

  it('a release opens with one sentence, then optionally the upgrade table', () => {
    const offenders = [];
    for (const s of releases) {
      const firstHeading = s.lines.findIndex(l => /^### /.test(l.text));
      const head = (firstHeading < 0 ? s.lines : s.lines.slice(0, firstHeading)).filter(l => l.text.trim());
      const prose = head.filter(l => !/^\|/.test(l.text));
      const table = head.filter(l => /^\|/.test(l.text));
      const opening = prose.map(l => l.text.trim()).join(' ');
      const at = head[0]?.n ?? s.start;
      if (!opening) { offenders.push({ section: s.name, n: at, why: 'no opening sentence' }); continue; }
      const sentences = withoutCode(opening).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .split(/[.!?](?:\*\*|\*|_)?\s+(?=[A-Z*_`])/).filter(Boolean);
      if (sentences.length !== 1) offenders.push({ section: s.name, n: at, why: `${sentences.length} sentences in the opening: ${opening.slice(0, 60)}…` });
      else if (opening.length > MAX_OPENING_CHARS) offenders.push({ section: s.name, n: at, why: `opening is ${opening.length} chars` });
      if (table.length && table[0].text.trim() !== TABLE_HEADER) {
        offenders.push({ section: s.name, n: table[0].n, why: `table header is "${table[0].text.trim()}", not "${TABLE_HEADER}"` });
      }
      const lastProse = prose.length ? prose[prose.length - 1].n : 0;
      if (table.length && table[0].n < lastProse) offenders.push({ section: s.name, n: table[0].n, why: 'the table comes before the opening sentence' });
    }
    assertNone(offenders, 'releases do not open with exactly one sentence.',
      'One sentence saying what the release is; then `| Changes on upgrade | Action |` if anything breaks.');
  });

  it('no section, and not the file, grows past its ceiling', () => {
    const over = sections
      .map(s => ({ section: s.name, n: s.start, size: s.lines.length + 1 }))
      .filter(x => x.size > SECTION_MAX_LINES)
      .map(x => ({ ...x, why: `${x.size} lines, ceiling ${SECTION_MAX_LINES}` }));
    const bytes = Buffer.byteLength(src.replace(/\r\n/g, '\n'), 'utf8');
    if (bytes > FILE_MAX_BYTES) over.push({ section: 'the file', n: 1, why: `${bytes} bytes, ceiling ${FILE_MAX_BYTES}` });
    assertNone(over, 'sections or the file are over their ceiling.',
      'Tighten older entries to make room; the ceilings only ever go down.');
  });
});
