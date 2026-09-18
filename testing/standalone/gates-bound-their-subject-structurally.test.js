/**
 * A gate may not bound its subject with a magic number. Ratchet: the grandfathered list only shrinks.
 *
 * ## Why this exists, with the cost attached
 *
 * `src.slice(at, at + 3000)` decides in advance how much of its subject a gate can see. Grow the subject and the
 * window stops covering it, and the gate then either fails on correct code or passes while checking less than it
 * meant to. A character count also spans different LINES on CRLF than on LF, so a window that fits locally can
 * fall short in CI.
 *
 * Three of them failed in one session, 2026-08-19:
 *
 * - `index-ready-poll.test.js` at `at + 3000` — a new branch pushed its subject out.
 * - `rights-are-explained.test.js` capped a `<thead>` at 1 400 characters — a fifth column took it to 1 770.
 * - `rights-matrix.component.spec.ts` asserted a header count `toBe(4)`.
 *
 * **The last one is why the Space Admin column was reverted five releases earlier.** It had been built, it worked,
 * and it was thrown away because a count broke — which reads as *"the feature broke the tests"* rather than as
 * *"the test was written wrong"*. The owner had asked five times. His words: *"must be noob mistake what you are
 * doing, cant be real that one column creates such problems"*.
 *
 * ## Why a ratchet and not a sweep
 *
 * There are 26 of these, spread over 21 files. Rewriting them blind is how a gate quietly starts checking less than it did — each window
 * has a subject, and only someone reading it knows what the real bound is. So this refuses NEW ones and lets the
 * list shrink as they are converted, the same shape `no-new-god-files.test.js` uses for file size.
 *
 * ## What is deliberately NOT banned
 *
 * `slice(0, N)` for truncating a value inside a failure MESSAGE — 79 of those, and they are correct: a 400-line
 * JSON blob in an assertion message helps nobody. The banned shape is a window whose start is a FOUND POSITION and
 * whose end is that position plus a number, because only that shape claims to cover a subject.
 *
 * Run: node --test testing/standalone/gates-bound-their-subject-structurally.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { stripComments } from './_strip-comments.mjs';

/**
 * A window whose end is its start plus a constant: `slice(at, at + 400)`.
 *
 * Requires the SAME identifier on both sides, which is what distinguishes a window over a subject from an
 * unrelated pair of offsets — and keeps `slice(0, 300)` message truncation out of scope entirely.
 */
/**
 * A forward window: `src.slice(at, at + 1600)`, and now also `src.slice(f(x), f(x) + 900)`.
 *
 * The capture was a bare IDENTIFIER, which missed the form with the anchor inlined —
 * `src.slice(src.indexOf('async function indexServes'), src.indexOf('async function indexServes') + 900)`, found in
 * a file that already carried a comment explaining why character counts are wrong. Widened to any repeated
 * expression up to 80 characters with no comma in it. The backreference matches literally, so the two halves still
 * have to be the same text — which is what makes this a window rather than an ordinary two-index slice.
 */
const MAGIC_WINDOW = /\.slice\(\s*([^,()]{1,80}?(?:\([^()]{0,60}\))?)\s*,\s*\1\s*\+\s*\d+\s*\)/g;

/**
 * The same defect written BACKWARDS: `src.slice(Math.max(0, at - 400), at)`.
 *
 * It was outside the pattern above, so it was never counted and never grandfathered — nine of them across eight
 * files, none of which the first version of this gate could see. Found while converting the forward population,
 * which is the argument for widening a ratchet's pattern as soon as its blind spot is known: a rule that reports
 * zero because it is not looking reads exactly like a rule that is satisfied.
 *
 * Backwards is the WORSE half. A window that stops short of its subject going forwards usually breaks the
 * assertion and goes red; going backwards it silently starts inside the subject, and in this suite the backwards
 * form is mostly paired with `doesNotMatch` — an absence asserted over less text than intended, which passes.
 *
 * A LINE window (`lines.slice(Math.max(0, i - 3), i + 4).join(' ')`) is deliberately NOT matched. Those are
 * adjacency claims — "a comment within three lines of the call" — where the number IS the rule rather than a guess
 * at how much of a subject fits. The `.join(` is what separates them, and it is a reliable signal because a
 * character window has nothing to join.
 */
const MAGIC_WINDOW_BACK = /\.slice\(\s*Math\.max\(\s*0\s*,\s*[A-Za-z_$][\w$.]*\s*-\s*\d+\s*\)[^)]*\)(?!\s*\.join\()/g;

/**
 * THE THIRD SHAPE, and it is worse than both: a window found by SEARCHING FOR A BLANK LINE.
 *
 * `text.indexOf('\n\n', at)` looks structural. It is not, on this repository: the tree checks out CRLF on
 * Windows, where a blank line is `\r\n\r\n`. Both searches return -1, the fallbacks take over, and the
 * "paragraph" becomes the WHOLE FILE.
 *
 * That is not a narrower window than intended — it is no window at all, while the gate goes on reporting
 * protection. `expansion-costs-matches-and-says-so` was in exactly that state: real in CI, inert on the
 * machine it runs on before every push, and it took a red run on 2026-09-04 to find out. It was also
 * catching a genuine defect at the time, which is the only reason anyone looked.
 *
 * **This gate could not see it, and that is the finding.** It refuses a window that decides in advance how
 * much of its subject a check can see, and a blank-line search is that decision made in a way that can
 * silently mean "all of it". Matching only the `.slice(at, at + N)` spelling is the rule-versus-one-spelling
 * mistake this file exists to name.
 *
 * The fix at a call site is to normalise the newlines first — and then the search IS structural, which is why
 * this matches the raw literal rather than the function that uses it.
 */
const BLANK_LINE_SEARCH = new RegExp(
  '(?:indexOf|lastIndexOf|split|search)\\(\\s*[\'"`]' + '\\\\n\\\\n',
  'g',
);

/*
 * NOT BANNED HERE, and the reason is the whole discipline of this file: `[\s\S]{0,N}` inside a pattern.
 *
 * A first draft banned it and found 30 sites. Reading them showed two different things wearing one syntax:
 *
 *   /<thead>([\s\S]{0,1400}?)<\/thead>/          a WINDOW between markers — the cap can only stop it short,
 *                                                and this is the one that failed on a fifth table column
 *   /if \(!x\) \{[\s\S]{0,220}?return false;/    an ADJACENCY bound — "these two must be near each other",
 *                                                which is a deliberate claim, not a guessed extent
 *
 * The second is legitimate and there are many of them. Banning both without reading all 30 would be exactly the
 * blind sweep this ratchet exists to avoid — a gate rewritten without understanding its subject is a gate that
 * quietly checks less. So this PR takes the unambiguous half, and the 30 are recorded in `QA-TODO.md` as an
 * unassessed population rather than as a number someone can wave through.
 */

const ROOTS = ['testing', join('client', 'src')];

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { sources(p, out); continue; }
    if (/\.(test|spec)\.(js|mjs|ts)$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Files still allowed to carry a magic window, with how many.
 *
 * **This list may only shrink.** Converting one means removing or lowering its entry; a file not listed may have
 * none at all. Counts rather than a bare filename, so a file with three cannot silently gain a fourth.
 */
const GRANDFATHERED = new Map([
  /*
   * TWO ENTRIES LEFT, and both are here because the number is not a window at all.
   *
   * The other nineteen files are converted. `_structural-window.mjs` grew the four bounds they actually needed —
   * a bracketed group, a statement, the block an anchor sits inside, and the three markup shapes — and each
   * conversion was read individually rather than swept, because a window rewritten without understanding its
   * subject is a gate that quietly checks less.
   */

  /*
   * `parseInt(h.slice(i, i + 2), 16)` — reading the red, green and blue bytes out of a hex colour.
   *
   * A hex pair is two characters by definition. There is no subject that can grow, so there is nothing for a
   * structural bound to bound. This is a fixed-width FIELD read wearing the same syntax as a window, and the
   * distinction matters: converting it would replace a correct expression with a worse one to satisfy a pattern.
   */
  ['testing/standalone/text-contrast-meets-aa.test.js', 1],

  /*
   * `parseInt(bits.slice(i * 8, i * 8 + 8), 2)` — reading one byte out of a bit string.
   *
   * The same class as the hex pair above and found by the same widening: eight bits is what a byte IS. Both are
   * fixed-width FIELD reads, and the fact that two of the three surviving entries are this shape is the argument for
   * keeping the exemptions rather than contorting the pattern to exclude them — a pattern that tries to tell a field
   * read from a window by its arithmetic will get it wrong in the other direction eventually.
   */
  ['testing/red-team-tests/auth-surface-hardening.test.js', 1],

  /*
   * `JSON.stringify(src.slice(handlerStart, handlerStart + 90))` — inside an assertion MESSAGE.
   *
   * Nothing is asserted about those 90 characters. They are an excerpt shown to whoever reads the failure, so
   * they can find the handler; the check itself is `checkSites.some(...)` on real indices. A window only needs a
   * structural bound when something is CHECKED inside it, and a 90-character quote is the right length for a
   * message where a whole handler body would not be.
   */
  ['testing/standalone/meta-precondition.test.js', 1],
]);

/**
 * Files still allowed to carry a BACKWARDS character window, with how many.
 *
 * Nine sites the pattern could not previously see, recorded rather than converted in the same change: the forward
 * population was twenty-two, and rewriting thirty-one windows in one commit is the blind sweep this gate exists to
 * prevent. **This list may only shrink**, on the same terms as the one above.
 *
 * Named individually because each has a different subject. `theme-cannot-recolour-facts` reads 1 400 characters of
 * CSS behind a declaration; `config-key-docs-coverage` reads a doc comment above a key; `index-ready-poll` reads
 * what precedes a call. Those are three different structural bounds, not one conversion applied nine times.
 */
/**
 * A CAPPED GAP inside a regex: `/marker[\s\S]{0,400}?other/`. Files still allowed to carry one, with how many.
 *
 * **0 windows left; 20 sites remain across 9 files whose number IS the rule**, down from 66/36 when this was first measured — and the tracker had recorded
 * 30, which is why the number lives in the gate now rather than in a markdown file that drifts.
 *
 * The nine that left were the ones whose subject is a NAMED FUNCTION or a BRANCH, where the structural bound is
 * unambiguous: an update call's arguments, a 412 branch, a catch block, an abandon branch, `spaceStillExists`,
 * `selectSpace` (a 2 000-character cap — nobody chooses that number, they raise it until the test passes),
 * `chronoAllowedTypes`, `getAllowedChronoTypes`, and a try/finally.
 *
 * The ten after those emptied five files, and two of them are worth recording because they change what
 * "structural" has to mean:
 *
 * - **A NOTICE entry read with a 900-character window was 13 characters from reading the WRONG entry.** `### jszip`
 *   sits at offset 18040 and the next entry's election at 18953. The check asks whether *this* package's licence
 *   arm is recorded; at 913 characters the neighbour's election would have answered for it, and the test that
 *   would have gone green is the one whose stated purpose is refusing exactly that. Nothing maintains a
 *   13-character margin, and nothing would have reported it.
 * - **The enclosing STATEMENT is the wrong bound for a ternary.** `pass === 'structured' ? judgePair(a, b,
 *   { structuredOnly: true }) : judgePair(a, b)` is one statement holding BOTH arms, so a statement-level bound is
 *   satisfied by the flag sitting on the other branch — the opposite behaviour, and a paid model call. The bound
 *   that holds is the ARGUMENT LIST of the call the branch makes. Structural is not automatically tighter than a
 *   character count: it is tighter only when the structure chosen is the subject.
 *
 * - **A capped gap can make a gate check almost nothing and still pass.** `single-flight` asserted that every
 *   outbound `ssrfSafeFetch` carries a deadline, by matching each call plus `[\s\S]{0,700}?` up to a guessed
 *   `
  })` tail. In scope it saw **4 of 10 call sites**. The other six — the webhook dispatcher and the external
 *   face endpoint among them, both of which leave the instance — were not reported as unguarded, they were never
 *   examined: the check is an ABSENCE, so a call the pattern missed passes by not existing. All ten do carry a
 *   signal, which is the only reason this is a lesson about measurement rather than an incident.
 * - **A window can point at the WRONG instance of its subject.** `oidc-carries-a-rights-matrix` asserted
 *   `admin: perms.admin, … readOnly: perms.readOnly ?? false` within 400 characters. `admin: perms.admin` appears
 *   twice — once on the record and once inside the `migrateToken({ … })` call the assertion is about — so the match
 *   started on the outer one and reached the inner field. Two objects satisfying one claim about a single object is
 *   exactly how the hand-rolled second mapping it exists to refuse would have passed.
 *
 * **And what remains is now SORTED, not merely counted.** The prose sites carry a one-line comment saying
 * the number IS the rule — `[^.]` and `[^.
]` cannot cross a full stop or a line, so those patterns assert
 * that two things sit in ONE SENTENCE, which is exactly what a schema description has to do for a caller to
 * read it. Widening those gaps would turn a working refusal into a false positive on prose that is now
 * correct. A site left in this list without such a comment has not been read yet.
 *
 * **What remains is the fails-LOUDLY class, and that is why it is a frozen list rather than a blocker.** Every one
 * of the six negative-polarity sites — where a short window makes an absence hold and the gate pass — was converted
 * first. For a POSITIVE assertion a cap that falls short breaks the match and turns the gate red on correct code:
 * a nuisance that announces itself, not a hole.
 *
 * ## Why this is a THIRD list rather than a ban
 *
 * The syntax wears two meanings and only one is a defect:
 *
 *   - a WINDOW between two markers — the cap is a guess at how much of a subject fits, and it can only ever make
 *     the check see less. This is the defect.
 *   - an ADJACENCY claim — "these two words in one sentence", `[^.\n]{0,40}`; "the guard within three lines". The
 *     number IS the rule, and converting it would replace a correct assertion with a vaguer one.
 *
 * Banning both without reading each is the blind sweep this whole gate exists to prevent. So the population is
 * frozen, and the SIX whose assertion was NEGATIVE are converted first — that is the polarity where a short window
 * finds nothing, the absence holds, and the gate passes on the thing it was written to catch.
 *
 * Two of those six turned out not to be cap problems at all. One bounded the wrong loop, because `indexOf` found a
 * braceless one and the window landed on an object literal in its argument. The other matched ZERO occurrences in
 * any version — the three stages it names are built in a `.map`, so their key is a template and never the quoted
 * literal the regex looked for. Both had been reading as passing gates.
 *
 * **This list may only shrink.**
 */
/**
 * Capped gaps whose number is NOT a window — a permanent list, with the reason on each entry.
 *
 * This map exists because the ratchet above bottomed out. `[\s\S]{0,400}` and `[^.]{0,80}` are one syntax wearing
 * two meanings, and while both were counted together "the list may only shrink" could never reach zero: whatever
 * number it stopped at was indistinguishable from remaining debt. Nine sites are adjacency claims, a regex quoted
 * inside a failure message, or comments recording the caps that were REMOVED — the last of which is the ratchet
 * penalising its own documentation.
 *
 * So they are separated. **`GRANDFATHERED_GAP` is the debt and must reach zero; this one is a vocabulary note.**
 * A new entry here needs a reason a reader can check, not a number somebody raised.
 */
const NOT_A_WINDOW = new Map([
  // `[0-9a-f]{0,2}` inside a failure MESSAGE — the regex it suggests somebody ADD. Nothing is asserted with it.
  ['testing/red-team-tests/ssrf-ipv6.test.js', 1],

  // `.{0,40}` — an adjacency claim. `.` does not cross a newline, so this asserts ONE LINE of prose says it.
  ['testing/standalone/backups-are-not-world-readable.test.js', 1],

  // Nine adjacency claims, documented in that file: `[^.\n]` crosses neither a full stop nor a line.
  // 9 -> 8: `B-19` moved the per-status branches into `chronoStatusPredicate`, and rewriting the scanner
  // for that retired one capped regex. The list only shrinks, which is what makes it a ratchet.
  ['testing/standalone/chrono-status-descriptions-match-the-derivation.test.js', 8],

  // A COMMENT quoting the `[\s\S]{0,120}?` this file's markup walk replaced. Documentation, not a pattern.
  ['testing/standalone/infra-managed-locks-every-field.test.js', 1],

  // `updateSpace([^)]*{[\s\S]{0,120}?\bmeta\b` — `[^)]*` already bounds it to the call's own arguments.
  ['testing/standalone/meta-precondition.test.js', 1],

  // One adjacency claim in prose, plus the comment that explains why it stays.
  ['testing/standalone/notice-coverage.test.js', 2],

  // A COMMENT quoting the `[\s\S]{0,1400}?` that failed on a fifth table column. That is the lesson itself.
  ['testing/standalone/rights-are-explained.test.js', 1],

  // Three `[^.]{0,N}` — two things in ONE SENTENCE, which is what a schema description has to do to be read.
  ['testing/standalone/search-tool-schemas-document-their-response.test.js', 3],

  // A COMMENT quoting the `[\s\S]{0,400}?` that hid 13 route registrations from the analysis. Documentation.
  ['testing/standalone/route-guard-coverage.test.js', 1],

  // `(?:[^\n]*\n){0,6}?` — a LINE adjacency claim: the wait must follow the trigger within six lines.
  ['testing/standalone/sync-waits-retrigger-and-diagnose.test.js', 1],
]);

const GRANDFATHERED_GAP = new Map([
  /*
   * EMPTY — every capped gap that was a WINDOW is converted, and the list stays here for the same reason the
   * backwards one does: an empty ratchet is what keeps it empty. Delete the map and the check goes with it.
   *
   * The last three were the ones that showed what a cap costs when nothing fails:
   *
   * - `route-guard-coverage` found each route's middleware chain by matching from the path string across
   *   `[\s\S]{0,400}?` to the handler. **13 of the 209 registrations in `server/src/api` put their handler
   *   further away**, so those routes were not reported as unguarded — they were never in the analysis.
   *   `POST /api/data/backups` sits 1 105 characters in, `GET /api/tokens/rights-catalog` 6 429. Three more were
   *   skipped by the handler-SHAPE guess beside it. The last argument is the handler because it is the last
   *   argument, so `argumentsOf` replaced both guesses.
   * - `no-boot-migration-on-synced-data` looked 80 characters past a collection open for a mutating call. The
   *   ordinary two-statement spelling — open, bound to a name, written through later — was MISSED at 80 and would
   *   have been found at 200, so the number decided rather than the shape. It now follows the variable.
   * - `reembed-backfill` bounded an audit table row at 80 characters, which reaches the NEXT row's `operation` —
   *   under which a route with no audit operation of its own borrows its neighbour's.
   */
]);

/**
 * Blank-line searches that are NOT windows over a checked-out file, each with its reason.
 *
 * The one entry parses an SSE payload, where `\n\n` is the frame separator defined by the protocol and
 * arrives over the wire rather than off disk — so the CRLF hazard does not apply and normalising would be
 * wrong, not merely unnecessary. It is listed rather than pattern-exempted because "is this text a file or a
 * network payload?" is a judgement about the call site, and a pattern that guessed it would be the next
 * thing to be wrong.
 */
const NOT_A_FILE_PARAGRAPH = new Map([
  /*
   * EMPTY, and the exemption that matters is DERIVED instead — see the scan below.
   *
   * The first version of this list named `testing/sync/mcp-session.js`, which parses an SSE frame
   * separator off the network rather than a paragraph off disk. That reason is sound and the entry was
   * still wrong: the scan walks test sources, and that file is not one, so the allowance was for a
   * count that could never be produced. An exemption for something unmeasured is the exemption-rot
   * shape one step earlier.
   */
]);

const GRANDFATHERED_BACK = new Map([
  /*
   * EMPTY. All nine are converted, and the list stays here rather than being deleted because an empty ratchet is the
   * thing that keeps it empty — remove the map and the check goes with it.
   *
   * Reading the nine showed they were asking five different questions, which is why they were not swept: an
   * enclosing block, the line above, the doc comment above, the section around, and — the one that mattered — which
   * blocks CONTAIN the anchor. That last one was answering a containment question with a proximity measurement, so a
   * guard that opened and closed above a form control counted as guarding it.
   */
]);

/**
 * THIS FILE is excluded from its own scan.
 *
 * It contains the banned shape as a STRING, in the test that proves the pattern still matches — which is the one
 * assertion stopping this whole gate from silently passing on a regex that broke. A scan flagging its own fixture
 * would force that proof to be deleted.
 *
 * Two files are absent from the list on purpose, having been converted in this change:
 * `startup-index-wait.test.js` and `result-spill-suppresses-vectors.test.js`. They are the two whose subjects I
 * had just read, which is the only basis on which a conversion is safe.
 */
const SELF = 'gates-bound-their-subject-structurally.test.js';

/*
 * The helper's own spec is excluded too. It contains every banned shape as a FIXTURE — that is what proves the
 * bounds are correct, and it is the one file where a magic window is the subject rather than a defect.
 */
const FIXTURES = 'structural-window-helper.test.js';

/** A capped gap inside a regex — `{0,400}` — whichever of the two things it means. */
const CAPPED_GAP = /\{0,\d+\}/g;

const found = new Map();
const foundBack = new Map();
const foundBlank = new Map();
const foundGap = new Map();
for (const root of ROOTS) {
  for (const file of sources(root)) {
    // Split on the platform separator and rejoin with `/`, so the keys read the same on Windows and in CI. A
    // grandfathered entry that only matched on one platform would be an allowance nobody could see.
    const key = file.split(sep).join('/');
    if (key.endsWith(SELF) || key.endsWith(FIXTURES)) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    const n = [...code.matchAll(MAGIC_WINDOW)].length;
    if (n > 0) found.set(key, n);
    const back = [...code.matchAll(MAGIC_WINDOW_BACK)].length;
    if (back > 0) foundBack.set(key, back);
    /*
     * A blank-line search is only a WINDOW HAZARD on text that may carry CRLF. A file that normalises
     * first has already removed it, so its searches are structural — and that is checkable rather than a
     * judgement, which is why it is derived here instead of listed above.
     *
     * My own first attempt claimed the pattern would not see a normalising file at all. It does: the
     * literal is still in the source. The exemption has to be the normalisation, not the absence.
     */
    const normalises = new RegExp('replace\\(\\s*/' + '\\\\r\\\\n' + '/g\\s*,').test(code);
    const blank = normalises ? 0 : [...code.matchAll(BLANK_LINE_SEARCH)].length;
    if (blank > 0) foundBlank.set(key, blank);
    /*
     * Counted on the RAW source, not the comment-stripped copy. Every other count here is on `code`, and for this
     * one that would be wrong in the expensive direction: a `{0,N}` written inside a comment — which is how this
     * suite documents the lesson, and there are several — would be invisible, so a file could carry a real one and
     * a comment about it and the numbers would not add up. Counting raw keeps the frozen number checkable by hand
     * with a grep, which is what somebody converting one of these will actually do.
     */
    const gaps = [...readFileSync(file, 'utf8').matchAll(CAPPED_GAP)].length;
    if (gaps > 0) foundGap.set(key, gaps);
  }
}

describe('the scan works before anything is concluded from it', () => {
  it('walked a real tree', () => {
    // A scan that matched nothing would report every rule below as satisfied.
    const files = ROOTS.flatMap(r => sources(r));
    assert.ok(files.length >= 100, `only found ${files.length} test files — the walk is broken`);
  });

  it('the pattern still matches the shape it is about', () => {
    // Proven against a literal, so a regex that silently stopped matching cannot pass as "none left".
    const sample = 'const body = src.slice(at, at + 1600);';
    assert.equal([...sample.matchAll(MAGIC_WINDOW)].length, 1, 'MAGIC_WINDOW no longer matches a magic window');

    /*
     * The INLINED-ANCHOR form, which the identifier-only capture could not see. Pinned as its own case because it is
     * how the widening was earned: three of these were sitting in the suite, one of them in a file that already
     * carried a comment about why character counts are wrong.
     */
    const inlined = "const fn = src.slice(src.indexOf('function f'), src.indexOf('function f') + 900);";
    assert.equal([...inlined.matchAll(MAGIC_WINDOW)].length, 1,
      'MAGIC_WINDOW no longer matches a window whose anchor is written out twice');

    // And does NOT match the shapes that are fine.
    for (const ok of [
      'JSON.stringify(b).slice(0, 300)',
      'src.slice(start, end)',
      'x.slice(a, b + 4)',
      // Two DIFFERENT expressions is an ordinary slice, not a window — the backreference is what separates them.
      "s.slice(s.indexOf('a'), s.indexOf('b') + 4)",
    ]) {
      assert.equal([...ok.matchAll(MAGIC_WINDOW)].length, 0, `false positive on: ${ok}`);
    }
  });

  it('the BACKWARDS pattern matches its shape, and leaves line windows alone', () => {
    const back = 'const before = src.slice(Math.max(0, at - 400), at);';
    assert.equal([...back.matchAll(MAGIC_WINDOW_BACK)].length, 1,
      'MAGIC_WINDOW_BACK no longer matches a backwards window — it would report zero by not looking');

    /*
     * A line window is an ADJACENCY claim, where the number is the rule. `.join(` is the signal, and asserting the
     * exclusion here is what stops a future tightening from banning thirty legitimate proximity checks.
     */
    for (const ok of [
      "const near = lines.slice(Math.max(0, i - 3), i + 4).join(' ')",
      'const around = lines.slice(Math.max(0, i - 6), i + 2).join("\\n")',
      'src.slice(0, i)',
    ]) {
      assert.equal([...ok.matchAll(MAGIC_WINDOW_BACK)].length, 0, `false positive on: ${ok}`);
    }
  });
});

describe('no NEW magic window', () => {
  it('every file carrying one is grandfathered, and none has more than its entry', () => {
    const problems = [];
    for (const [file, n] of found) {
      const allowed = GRANDFATHERED.get(file) ?? 0;
      if (n > allowed) {
        problems.push(`${file}: ${n} magic window(s), allowed ${allowed}`);
      }
    }
    assert.deepEqual(problems, [],
      'a gate bounds its subject with a character count. Use `_structural-window.mjs` — `bodyOf`, `between`, or\n'
      + '`bodyOfEndingWith` — which bound by the next top-level declaration or by the closing marker. A window that\n'
      + 'can fall short of its subject is a gate that can pass while checking less than it means to.\n'
      + problems.join('\n'));
  });

  it('and no window found by searching for a blank line, which is not one on CRLF', () => {
    /*
     * The third shape, added after it cost a red run. `text.indexOf('\n\n', at)` reads as structural and
     * is not: this tree checks out CRLF on Windows, where a blank line is `\r\n\r\n`, so the search misses
     * and the window silently becomes the WHOLE FILE. Worse than a wrong number, because the gate goes on
     * reporting protection while measuring nothing.
     *
     * A call site that normalises its newlines first is fine and this does not see it — the literal is what
     * is matched, and a normalised copy has real `\n` in it.
     */
    const problems = [];
    for (const [file, n] of foundBlank) {
      const allowed = NOT_A_FILE_PARAGRAPH.get(file) ?? 0;
      if (n > allowed) problems.push(`${file}: ${n} blank-line search(es), allowed ${allowed}`);
    }
    for (const [file, allowed] of NOT_A_FILE_PARAGRAPH) {
      const actual = foundBlank.get(file) ?? 0;
      if (actual < allowed) problems.push(`${file}: allowed ${allowed}, now has ${actual} — lower it`);
    }
    assert.deepEqual(problems, [],
      'a gate finds its window by searching for a blank line. On a CRLF checkout that search MISSES and the\n'
      + 'window becomes the whole file — no window at all, while the gate still reports protection. Normalise\n'
      + 'the newlines first, and recompute the match offset through the same transform.\n'
      + problems.join('\n'));
  });

  it('no NEW backwards window either, and that list only shrinks too', () => {
    // Both directions on one ratchet, so closing the forward half cannot look like closing the problem.
    const problems = [];
    for (const [file, n] of foundBack) {
      const allowed = GRANDFATHERED_BACK.get(file) ?? 0;
      if (n > allowed) problems.push(`${file}: ${n} backwards window(s), allowed ${allowed}`);
    }
    for (const [file, allowed] of GRANDFATHERED_BACK) {
      const actual = foundBack.get(file) ?? 0;
      if (actual < allowed) problems.push(`${file}: allowed ${allowed} backwards, now has ${actual} — lower it`);
    }
    assert.deepEqual(problems, [],
      'a gate reads a fixed number of characters BEHIND its anchor. That is the same defect as a forward window\n'
      + 'and a worse one: it starts inside its subject silently, and it is usually paired with `doesNotMatch`, so\n'
      + 'an absence gets asserted over less text than intended and passes. Bound it with `_structural-window.mjs`.\n'
      + problems.join('\n'));
  });

  it('no NEW capped gap inside a regex, and that list only shrinks too', () => {
    /*
     * Frozen rather than banned, because the syntax means two different things and only one is a defect — see the
     * note on `GRANDFATHERED_GAP`. What this refuses is a NEW one appearing anywhere, which is the part that does
     * not need each site read first.
     */
    const problems = [];
    const allowance = f => (GRANDFATHERED_GAP.get(f) ?? 0) + (NOT_A_WINDOW.get(f) ?? 0);
    for (const [file, n] of foundGap) {
      const allowed = allowance(file);
      if (n > allowed) problems.push(`${file}: ${n} capped gap(s), allowed ${allowed}`);
    }
    for (const file of new Set([...GRANDFATHERED_GAP.keys(), ...NOT_A_WINDOW.keys()])) {
      const actual = foundGap.get(file) ?? 0;
      const allowed = allowance(file);
      if (actual < allowed) problems.push(`${file}: allowed ${allowed} gaps, now has ${actual} — lower it`);
    }
    assert.deepEqual(problems, [],
      'a capped gap inside a regex — `/marker[\\s\\S]{0,400}?other/`. If the number is a GUESS at how much of a\n'
      + 'subject fits, bound it with `_structural-window.mjs` instead; the cap can only make the check see less.\n'
      + 'If the number IS the rule — two words in one sentence, a guard within three lines — say so in a comment\n'
      + 'beside it and raise this file\'s entry deliberately.\n'
      + problems.join('\n'));
  });

  it('the list only shrinks — an entry that is no longer needed must be removed', () => {
    /*
     * The other half of a ratchet. Without this the list is a place numbers go up: someone converts a window,
     * leaves the entry, and the slot stays open for the next one. `no-new-god-files` reports slack as a note; here
     * it is a failure, because unlike a file size these go to zero and stay there.
     */
    const stale = [];
    for (const [file, allowed] of GRANDFATHERED) {
      const actual = found.get(file) ?? 0;
      if (actual < allowed) stale.push(`${file}: allowed ${allowed}, now has ${actual} — lower or remove it`);
    }
    assert.deepEqual(stale, [], 'the grandfathered list is above reality:\n' + stale.join('\n'));
  });

  it('the total only goes down', () => {
    /*
     * A single number, so the direction of travel is visible without diffing a map. It is the sum of the list
     * above, and the point of stating it separately is that a reviewer can see at a glance whether a change moved
     * the debt or merely shuffled it between files.
     */
    const total = [...found.values()].reduce((a, b) => a + b, 0);
    const allowed = [...GRANDFATHERED.values()].reduce((a, b) => a + b, 0);
    assert.ok(total <= allowed,
      `${total} magic windows across the suite, and the list allows ${allowed}. It may only go down.`);
  });
});
