#!/usr/bin/env node
/**
 * The `todo/` folder holds only actionable open work, and `_TODO-ORDERED.md` indexes all of it.
 *
 * Owner rules:
 *  - 2026-08-02: *"todos must be only actionable open items"* — no `[x]`, no SHIPPED, no standing rules. Shipped
 *    work lives in the CHANGELOG; rationale lives in `_REFERENCE.md`.
 *  - 2026-08-04: *"ordered has to reference all todos in all other todo files"* — `_TODO-ORDERED.md` is the single
 *    index. An item that exists in a domain tracker and is not referenced from the ordered list is invisible to
 *    the thing that decides what gets built next.
 *
 * ## Why this is a script and not a test
 *
 * `todo/` is **gitignored**. It never reaches CI, so a standalone test would either fail there for lack of the
 * folder or have to skip — and a check that skips in the only place it runs automatically is not a check. This is
 * a local pre-push tool instead, and it exits 0 with a clear note when `todo/` is absent, so it can be wired into
 * preflight without breaking a clean checkout.
 *
 * ## Why the second rule matters more than it sounds
 *
 * The release cadence is *"cut the tag when `_TODO-ORDERED.md` is EMPTY"*. If a domain tracker can hold an item
 * the ordered list never mentions, then "the queue is empty" is a statement about one file rather than about the
 * work — and the release gate fires on a queue that only looks drained. That already happened once: a
 * reconciliation on 2026-08-03 found five real items (2 FEATURES, 2 UX, 1 PERFORMANCE) missing from a list that
 * claimed to order all of them.
 *
 * Run: `npm run todo:check`
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { matchIndexReference } from './todo-index-match.mjs';
import {
  openItems, orderedHomeRows, itemIdIn, itemIdsIn, isNamedIn,
  statedStructureCount, checklistBoxCount,
} from './todo-open-items.mjs';
import { verifyLineOf, parseVerifyLine, evaluateClause } from './verify-line.mjs';
import { resolvedHeadings, decidedButStillFiled, rulingsLeftOnThePage } from './parked-decisions-rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// `TODO_CHECK_DIR` points the check at another folder; its tests use it, nothing else sets it.
const TODO = process.env.TODO_CHECK_DIR ?? join(ROOT, 'todo');
const R = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

if (!existsSync(TODO)) {
  console.log(`${DIM}todo/ is not present (it is gitignored) — nothing to check.${R}`);
  process.exit(0);
}

const ORDERED = '_TODO-ORDERED.md';

/**
 * Files that are reference material rather than queues, so an unindexed heading in them is not an orphan.
 *
 * Each carries its reason. `_REFERENCE.md` is where resolved rationale goes *by* the rules above.
 */
const NOT_A_QUEUE = new Map([
  ['_REFERENCE.md', 'resolved rationale — where closed work is supposed to end up'],
  ['_CRYPTO-INVENTORY.md', 'a fact sheet kept for reference; its subject is closed'],
  // Exempt from the QUEUE rules — its items are decisions, not work, so they have no verify line and are not in
  // the ordered index. It is NOT unchecked: rule 5 holds it to open-decisions-only.
  //
  // The old reason read "indexed by outcome rather than queued", which described a file that held outcomes. They
  // moved to `_REFERENCE.md` and the exemption stayed, so this page accumulated resolved history for weeks while
  // every checked page stayed clean — until the owner opened it and found seven settled items filed as open. An
  // exemption's stated reason is load-bearing: it is what the next person checks before adding a rule.
  ['_PARKED-DECISIONS.md', 'owner DECISIONS, not work — no verify line, not in the ordered index (see rule 5)'],
  ['_DEPRECATIONS.md', 'a removal checklist keyed to a future major, not the current queue'],
  ['_CLA-BOT-SETUP.md', 'setup instructions'],
  ['_NEXT-PR-PLAN.md', 'the working plan for the PR in flight; cleared on push'],
]);

/**
 * Items whose evidence genuinely cannot be a count, each with a reason and a date.
 *
 * **Four things make this cost something, and they are the difference between an escape hatch and the hole
 * reopening.** An exemption anybody can take for free is how the last four rounds of the closed-work rule went:
 *
 *  1. **It lives HERE, in a tracked file.** `todo/` is gitignored and reviewed by nobody, so a reason written
 *     beside the item costs nothing. A row in this map lands in a PR diff a human reads. That asymmetry is the
 *     whole lever.
 *  2. **A hard expiry.** On or after `by`, the gate fails. The item comes back on a date its author cannot
 *     quietly extend.
 *  3. **The expiry is bounded** to 120 days out, because an exemption dated 2099 is a deletion wearing a date.
 *  4. **A cap of three**, which makes the hatch rivalrous: taking it for a new item means retiring one.
 *
 * And a stale entry FAILS rather than warns — the existing exemption-rot check only `console.log`s, and this
 * file's own comment records that a stale `NOT_A_QUEUE` reason is how `_PARKED-DECISIONS.md` accumulated
 * resolved history for weeks while every checked page stayed clean.
 */
const MANUAL_VERIFY = new Map([
  // A-3 was the only row here before this — its verify was a corpus benchmark re-run, which no `grep -c` can
  // express — and it shipped, so the exemption went with it. The rule below is what made that happen rather
  // than leaving a stale row behind, which is exactly how `_PARKED-DECISIONS.md` accumulated resolved history
  // for weeks.
  //
  // F-19 stood here until 2026-09-23, when its exploration finished and the row became the owner's
  // build-or-close decision: the finding went to `_REFERENCE.md` and the question to `_PARKED-DECISIONS.md`.
  // The map is empty rather than gone, because the next item whose evidence cannot be a count needs a place
  // that costs a PR diff to use.
]);

const failures = [];
const fail = (why) => failures.push(why);

const files = readdirSync(TODO).filter(f => f.endsWith('.md'));
/*
 * No queue file: the project keeps its queue somewhere else (owner, 2026-09-26: tickets in a y-tickets space,
 * checked by the flows' own tracker check). That is only true while `todo/` holds no open work — an index gone
 * while a tracker file still holds open items is the original failure, work nothing will reach, and still fails.
 */
if (!files.includes(ORDERED)) {
  // Reference pages hold item-shaped headings by design (NOT_A_QUEUE), so only the other files can strand work.
  const stranded = files.filter(f => !NOT_A_QUEUE.has(f)).flatMap(f => openItems(readFileSync(join(TODO, f), 'utf8')).map(i => `${f}: ${i.id ?? i.title ?? 'an open item'}`));
  if (stranded.length) {
    console.log(`${RED}${ORDERED} is missing, and todo/ still holds open work nothing indexes:${R}`);
    for (const s of stranded) console.log(`  · ${s}`);
    process.exit(1);
  }
  console.log(`${DIM}todo/ has no queue file and no open items — the queue is kept elsewhere; nothing to check here.${R}`);
  process.exit(0);
}

const ordered = readFileSync(join(TODO, ORDERED), 'utf8');

console.log(`\n${YELLOW}todo/ consistency${R}  ${DIM}(owner rules 2026-08-02 and 2026-08-04)${R}\n`);

// ── rule 1: only actionable OPEN items
{
  // A completed marker anywhere in todo/ means shipped work is being tracked twice — here and in the CHANGELOG —
  // and the two will disagree. Two survivors labelled OPEN had already shipped when this rule was made.
  //
  // The heading patterns were added after the first three missed all of this: section 1 still listed an item
  // shipped in #678, and P1 sat in section 1b with "CLOSED" in its own heading. Both announced their closure in a
  // *heading* rather than with a checkbox, so a checkbox-only check reported the queue clean. The rule is about
  // closed work being tracked as work, not about one syntax for saying so.
  // 2026-08-13: four MORE shapes got through, and the owner had to say the rule again — *"only open and actionable
  // items here. everything else in parked, reference or changelog"*. All four announced closure somewhere this
  // check was not looking: inside a bullet rather than a heading, or in bold body text rather than a marker.
  //
  //   - [ ] **W-8 — PROMOTED TO WORK AND FIXED: …**        a bullet, not a heading
  //   - `retry_embedding` — **DONE** (#842).               a nested bullet under an open item
  //   **PROGRESS. The map shipped in #841 …**              bold body text
  //
  // The last one is the instructive one: it was ADDED during a tracker update, by me, with a note saying the
  // history was "kept because its reasoning is what made the extraction necessary". That is always the argument,
  // and the answer is that reasoning goes in `_REFERENCE.md` where it is read on demand.
  const CLOSED = [
    [/^\s*[-*]\s*\[x\]/im, 'a checked `[x]` item'],
    [/^\s*[-*]?\s*\*\*?SHIPPED/im, 'a SHIPPED marker'],
    [/^\s*#{1,4}\s+.*\b(SHIPPED|CLOSED|RESOLVED|DONE)\b/im, 'a heading announcing the item is finished'],
    [/^\s*[-*]\s*\[ \]\s*~~/im, 'a struck-through open item — delete it rather than crossing it out'],
    [/\*\*DONE\*\*|\bDONE \(#\d+\)/i, 'a DONE marker inside an item — the closed part belongs in the CHANGELOG'],
    [/\bAND FIXED\b|\bPROMOTED TO WORK AND\b/i, 'an item announcing its own fix'],
    [/^\s*\*\*PROGRESS[.:]/im, 'a PROGRESS block — a record of what shipped, which is the CHANGELOG\'s job'],
  ];
  let clean = true;
  for (const f of files) {
    if (NOT_A_QUEUE.has(f)) continue;
    const src = readFileSync(join(TODO, f), 'utf8');
    for (const [re, what] of CLOSED) {
      const m = re.exec(src);
      if (m) {
        const line = src.slice(0, m.index).split(/\r?\n/).length;
        fail(`${f}:${line} holds ${what}. Shipped work goes in the CHANGELOG; the reasoning goes in `
          + '`_REFERENCE.md`. A checkbox is not evidence — verify a survivor against the code before keeping it.');
        clean = false;
      }
    }
  }
  console.log(clean
    ? `${GREEN}  ✓${R} every queue file holds only open items`
    : `${RED}  ✗${R} a queue file tracks closed work`);
}

// ── rule 2: the ordered list references every item in every other tracker
{
  /**
   * An item is a `### N. Title` heading or a `- [ ]` checkbox. Reference is by ID token or by a distinctive title
   * fragment, because the ordered list legitimately paraphrases rather than copying a heading verbatim.
   */
  const orphans = [];
  for (const f of files) {
    if (f === ORDERED || NOT_A_QUEUE.has(f)) continue;
    const src = readFileSync(join(TODO, f), 'utf8');

    /*
     * ONE answer to "what is open in this tracker", shared with every other rule.
     *
     * This block used to ask with its own two patterns, in the file that imports `openItems`, and it was
     * weaker in two ways nobody could see from here. It matched `[ ]` only, so marking a row `[~]` while its
     * PR was in flight removed it from "every open item is indexed" — the honest bookkeeping act made the
     * check cover less. And its id pattern had no notion of a sub-id, so `G-3.1` read as `G-3` and was then
     * satisfied by the PARENT's presence in the queue: a false green on the rule that decides whether the
     * queue is complete, which is what the release cadence hangs on.
     *
     * HEADING-STYLE ITEMS COUNT TOO. Until 2026-08-30 they did not, and two trackers written in heading style
     * contributed ZERO items while the gate reported `todo/ is consistent`. A rule that is documented and not
     * enforced is worse than one that is neither, because it is believed.
     */
    const items = openItems(src);
    for (const id of new Set(items.map(i => i.id).filter(Boolean))) {
      if (!isNamedIn(id, ordered)) orphans.push(`${f} → ${id}`);
    }

    // Items with no ID: match on a contiguous phrase from the item's own wording.
    //
    // This used to be `words.some(w => ordered.includes(w))` over the first four long words, which any ONE
    // ordinary word satisfied — so this check reported a rule it did not enforce, and said "✓" while doing it.
    // See `todo-index-match.mjs` for what replaced it and for the two fixtures that prove it discriminates.
    for (const t of items.filter(i => !i.id).map(i => i.title)) {
      if (!matchIndexReference(t, ordered).referenced) orphans.push(`${f} → "${t.slice(0, 70)}"`);
    }
  }
  if (orphans.length) {
    fail(`${orphans.length} open item(s) exist in a domain tracker and are not referenced from ${ORDERED}:\n`
      + orphans.map(o => `      ${o}`).join('\n')
      + `\n\n      The release cadence is "cut the tag when ${ORDERED} is empty". An item it never mentions makes`
      + '\n      "empty" a statement about one file rather than about the work.');
    console.log(`${RED}  ✗${R} ${ORDERED} does not index every open item`);
  } else {
    console.log(`${GREEN}  ✓${R} ${ORDERED} references every open item in every tracker`);
  }
}

// ── rule 2b: every row in the ordered list resolves to a real item in the home it names
{
  /**
   * Rule 2 runs tracker → index. This is index → tracker, and nothing checked it until 2026-08-30.
   *
   * `W-3` had sat in the ordered list for weeks with `_WRITE-PATH-VALIDATION-TODOS.md` in its Home column and no
   * `W-3` anywhere in that file. The row was a phantom: a queue entry whose work had no description, no detail
   * and no verify line, because the section it pointed at was destroyed by a cleanup script whose backup went to
   * a path that did not exist (`_REFERENCE.md`, 2026-08-13). Its id had since been reused by an unrelated
   * reconstruction in `_REFERENCE.md`, so grepping the folder for "W-3" found something and looked fine.
   *
   * This matters for the same reason rule 2 does, from the other end. The release gate is "cut the tag when the
   * ordered list is EMPTY", so a phantom row can never drain — there is nothing to build and nothing to close,
   * and the queue reads one item longer than the work for as long as nobody opens the home file.
   *
   * The Home column is the claim being checked, which is what makes this independent evidence rather than more
   * status text: the row names a file, and either that file declares the id or it does not.
   */
  const declared = new Map();
  for (const f of files) {
    if (f === ORDERED) continue;
    for (const item of openItems(readFileSync(join(TODO, f), 'utf8'))) {
      if (item.id) declared.set(`${f}::${item.id}`, true);
    }
  }
  const phantoms = [];
  for (const { id, home } of orderedHomeRows(ordered)) {
    if (!files.includes(home)) { phantoms.push(`${id} → ${home} (no such file in todo/)`); continue; }
    if (NOT_A_QUEUE.has(home)) continue;  // a row may legitimately point at reference material for its rationale
    if (!declared.has(`${home}::${id}`)) phantoms.push(`${id} → ${home} declares no ${id}`);
  }
  if (phantoms.length) {
    fail(`${phantoms.length} row(s) in ${ORDERED} name a home that does not declare them:\n`
      + phantoms.map(p => `      ${p}`).join('\n')
      + '\n\n      A queue row whose home has no matching item is work with no description — it can never be'
      + '\n      built and never drains, so "the queue is empty" stays false for a row nobody can act on.');
    console.log(`${RED}  ✗${R} a row in ${ORDERED} points at an item that does not exist`);
  } else {
    console.log(`${GREEN}  ✓${R} every row in ${ORDERED} resolves to a real item in its home`);
  }
}

// ── rule 2c: every god-file raise names a decomposition task that is actually open
{
  /**
   * Owner's rule, 2026-08-30: *"raising is okay but raising means you also have to queue a task to decompose
   * and modularize."*
   *
   * `no-new-god-files.test.js` requires every `RAISED a -> b` to carry a `DECOMPOSE: <ID>` or a
   * `NO DECOMPOSITION: <reason>`. It cannot check the id, because `todo/` is gitignored and absent in CI —
   * so that gate proves a marker EXISTS and this one proves the marker is TRUE.
   *
   * Split deliberately rather than duplicated: each half runs where it can see its own evidence, and neither
   * is a weaker copy of the other. A `DECOMPOSE: G-9` naming nothing would satisfy the first check on its own,
   * which is the shape of promise this repo keeps finding.
   */
  const GATE = join(ROOT, 'testing/standalone/no-new-god-files.test.js');
  if (existsSync(GATE)) {
    const named = [...readFileSync(GATE, 'utf8').matchAll(/DECOMPOSE:[ \t]*(\S+)/g)]
      .map(m => itemIdIn(m[1])).filter(Boolean);
    // A NUMBERED SUB-ID SATISFIES ITS PARENT, and this now matters: `G-3` was broken into `G-3.1`..`G-3.5`
    // so the queue shows the remaining cuts, and the raise markers still name the parent. The boundary class
    // gives that for free — a dot is not in `[A-Z0-9-]`, so `G-3.1` matches `G-3` while `G-30` does not.
    // Stated because it reads like an accident and is depended on.
    const missing = named.filter(id => !new RegExp(`(^|[^A-Z0-9-])${id}([^A-Z0-9-]|$)`, 'm').test(ordered));
    if (missing.length) {
      fail(`${missing.length} god-file raise(s) name a decomposition task that is not in ${ORDERED}: `
        + `${missing.join(', ')}.

      A raise is allowed; a raise with no queued follow-up is how a file `
        + 'reaches four figures one defensible increment at a time.');
      console.log(`${RED}  ✗${R} a god-file raise names a task nobody queued`);
    } else {
      console.log(`${GREEN}  ✓${R} every god-file raise names a queued decomposition  ${DIM}(${named.length} `
        + `named)${R}`);
    }
  }
}

// ── rule 3: every open item states how to verify it is still open
{
  /**
   * The rule that replaces a title-matching check written and deleted in the same session.
   *
   * The problem it is really solving: **four of ten open items had already shipped**, none of them marked in any
   * way — just `- [ ]` entries describing work that was done. No closure word, no checkbox, nothing to grep.
   *
   * The first attempt compared each item's title against released CHANGELOG sections. It **survived its own
   * mutation**: a known-shipped item was restored and the check stayed green. The premise was wrong, not the
   * implementation — a todo describes the PROBLEM ("Nothing detects an unreachable component") and a CHANGELOG
   * describes the FIX ("The build now fails when a component becomes unreachable"). They share no phrase, so title
   * matching could only ever catch coincidences. A green tick that proves nothing is worse than no tick.
   *
   * So the item carries its own evidence instead. **Every open item names what to look at to confirm it is still
   * open** — a file, a symbol, a test name, a route. That turns "is this still open?" from a judgement call into a
   * one-command answer, and unlike the prose comparison it is mechanically checkable.
   *
   * ## It covered ONE item out of eleven until 2026-08-30
   *
   * This rule split the file on `- [ ]` checkboxes. Rule 2, six lines above, learned about heading-style items
   * that same day and this one did not — so `_LINKS-AND-SCHEMA-TODOS.md` (9 items) and
   * `_WRITE-PATH-VALIDATION-TODOS.md` (1 item) contributed nothing to it, and the tick meant "the single
   * checkbox item in `ARCHITECTURE-TODO.md` has a verify line".
   *
   * That is exactly the defect this codebase produces most, arriving inside the script that exists to catch
   * bookkeeping drift: one rule, two implementations, the weaker one winning without saying anything. Six of the
   * eight stale rows found on 2026-08-30 were in the two files it could not see. `openItems()` is now the single
   * answer to "what is an item", shared with rule 2 — the extraction the codebase's own rule asks for the second
   * time you write the same thing.
   */
  const missing = [];
  const unparsed = [];
  const disagree = [];
  const broken = [];
  const seenManual = new Set();
  let mechanised = 0;

  /*
   * The tracked file set, from git — never `readdirSync`. `todo/` and `dist/` are gitignored, and a path that
   * exists on disk but is not in the repo is exactly the kind of evidence that vanishes on another machine.
   *
   * A git failure is a FAILURE, not a skip. Rule 4 below catches its own `git log` and leaves the result empty,
   * which makes an error indistinguishable from a pass — the gate's one independent check reporting green
   * having compared nothing. Do not reproduce that shape here.
   */
  let tracked;
  try {
    tracked = new Set(
      execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 1 << 26 })
        .split('\0').filter(Boolean),
    );
  } catch (err) {
    fail(`could not establish the tracked file set, so no verify line could be checked: ${err}`);
    tracked = null;
  }
  const cache = new Map();
  const ctx = {
    isTracked: p => tracked.has(p),
    readLines: p => {
      if (!cache.has(p)) cache.set(p, readFileSync(join(ROOT, p), 'utf8').split(/\r?\n/));
      return cache.get(p);
    },
  };

  for (const f of files) {
    if (NOT_A_QUEUE.has(f)) continue;
    for (const item of openItems(readFileSync(join(TODO, f), 'utf8'))) {
      const where = `${f}:${item.line} — "${item.title.slice(0, 60)}"`;
      const text = verifyLineOf(item.body);
      if (text === null) { missing.push(where); continue; }

      const parsed = parseVerifyLine(text);
      if (!parsed.ok) { unparsed.push(`${where}\n        ${parsed.reason}\n        → ${parsed.hint}`); continue; }

      if (parsed.kind === 'manual') {
        if (!item.id || !MANUAL_VERIFY.has(item.id)) {
          unparsed.push(`${where}\n        says MANUAL but is not in MANUAL_VERIFY in this script — the reason `
            + 'and the expiry live in the TRACKED file, where a human reads them in a diff');
        } else {
          seenManual.add(item.id);
        }
        continue;
      }
      if (!tracked) continue;
      mechanised++;
      const result = evaluateClause(parsed, ctx);
      if (result.state === 'broken') broken.push(`${where}\n        ${result.why}`);
      else if (result.state === 'disagrees') {
        disagree.push(`${where}\n        its own line says \`grep -c "${parsed.pattern}" ${parsed.path}\` returns `
          + `${parsed.expected}. It returns ${result.actual}. Either the row shipped, or its evidence points at `
          + 'the wrong thing.');
      }
    }
  }

  // The hatch's accounting, which is what stops it becoming the hole again. See MANUAL_VERIFY.
  const today = new Date().toISOString().slice(0, 10);
  for (const [id, { by }] of MANUAL_VERIFY) {
    if (!seenManual.has(id)) {
      fail(`MANUAL_VERIFY names ${id}, which is not an open item with a MANUAL verify line. A stale exemption is `
        + 'how `_PARKED-DECISIONS.md` accumulated resolved history for weeks — remove the row.');
    } else if (today >= by) {
      fail(`the manual verify exemption for ${id} expired on ${by} — mechanise it, or re-argue the reason and `
        + 'set a new date in this script, where the argument lands in a diff somebody reads.');
    } else if (by > new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10)) {
      fail(`the manual verify exemption for ${id} expires ${by}, more than 120 days out. An exemption dated that `
        + 'far ahead is a deletion wearing a date.');
    }
  }
  if (MANUAL_VERIFY.size > 3) {
    fail(`MANUAL_VERIFY holds ${MANUAL_VERIFY.size} entries; the cap is 3. The cap is what makes the hatch cost `
      + 'something: taking it for a new item means retiring an existing one.');
  }
  for (const [what, rows] of [['could not be parsed', unparsed], ['name a file that is gone', broken],
    ['DISAGREE with their own evidence', disagree]]) {
    if (rows.length) {
      fail(`${rows.length} verify line(s) ${what}:\n` + rows.map(r => `      ${r}`).join('\n'));
    }
  }
  if (missing.length) {
    fail(`${missing.length} open item(s) do not say how to verify they are still open:\n`
      + missing.map(x => `      ${x}`).join('\n')
      + '\n\n      Add a line like "Verify: `grep -c prod-deps Dockerfile` returns 0" — a file, a symbol, a test'
      + '\n      name, anything runnable. Four of ten items were once found to have already shipped, with nothing'
      + '\n      in the file to reveal it. This is the cheapest thing that would have.');
    console.log(`${RED}  ✗${R} an open item does not say how to verify it is still open`);
  } else {
    console.log(`${GREEN}  ✓${R} every open item says how to verify it is still open`);
  }

  /*
   * The tick says "its stated evidence still holds" — NOT "it is still open", and the difference is the whole
   * honest bound on this check. They come apart whenever a fix lands somewhere other than the file the row
   * names, which in this codebase is the usual shape rather than the exception, because the convention is to
   * extract. `L-4` named `api/contradictions.ts`; its fix (#1046) went into `brain/edges.ts`, and that file is
   * byte-identical from #1041 through HEAD — so every clause faithful to the row's own words would still have
   * said "holds" four days after it shipped. Six of the eight stale rows of 2026-08-30 were fix-in-place and
   * would have been caught; two were extractions and would not. Claiming the stronger thing is how the four
   * previous rounds of this check went wrong.
   */
  const okVerify = !unparsed.length && !broken.length && !disagree.length;
  console.log(okVerify
    ? `${GREEN}  ✓${R} every mechanised verify line still holds  ${DIM}(${mechanised} checked, `
      + `${MANUAL_VERIFY.size} manual — evidence intact, not "still open": a fix that lands elsewhere is invisible)${R}`
    : `${RED}  ✗${R} a verify line disagrees with the tree, or cannot be checked`);
}


// ── rule 3b: a tracker holds WORK — not watches, and not things blocked on the owner
{
  /**
   * The other half of *"only open and actionable items"* (owner, 2026-08-13). Rule 1 catches work that is FINISHED;
   * this catches material that was never actionable in the first place, which is how the trackers actually grew:
   *
   *  - **a watch item.** Five of them, each saying so in its own text — *"A watch item, not work"*, *"WATCH, not
   *    work"*. Nothing to do until it produces evidence, so it is a note. Its trigger belongs in
   *    `_TODO-ORDERED.md §2` as one line, and its reasoning in `_REFERENCE.md`.
   *  - **something blocked on the owner.** That is `_PARKED-DECISIONS.md`, and putting it in the open list is worse
   *    than useless: it makes the queue look longer than the work, and "the queue is empty" — the release gate —
   *    unreachable. Two were sitting in section 1 when this rule was written, one of them filed there by me the same
   *    night.
   *
   * Both are matched on the item's OWN words, so an item does not become exempt by being described differently
   * somewhere else. The phrasings are the ones that actually occurred, plus the obvious near-misses.
   */
  const NOT_WORK = [
    [/\bwatch item\b/i, 'a watch item', 'its trigger goes in `_TODO-ORDERED.md §2`, its reasoning in `_REFERENCE.md`'],
    [/\bWATCH,?\s+not\s+(a\s+)?(work|task)\b/i, 'an item labelled WATCH rather than work', 'same — §2 plus `_REFERENCE.md`'],
    [/\bnot\s+work\s*[.:]/i, 'an item saying it is not work', 'same — §2 plus `_REFERENCE.md`'],
    [/\bneeds? (an? )?owner (decision|call|word|sign.?off)\b/i, 'an item waiting on the owner', 'it belongs in `_PARKED-DECISIONS.md` with a recommended default'],
    [/\bthat is a question for the owner\b/i, 'a question for the owner', 'it belongs in `_PARKED-DECISIONS.md` with a recommended default'],
    [/\bis the owner['’]s call\b/i, "an owner's call", 'it belongs in `_PARKED-DECISIONS.md` with a recommended default'],
  ];
  let clean = true;
  for (const f of files) {
    if (NOT_A_QUEUE.has(f) || f === ORDERED) continue;   // §2 of the ordered file is where watch ROWS are allowed
    const src = readFileSync(join(TODO, f), 'utf8');
    for (const [re, what, where] of NOT_WORK) {
      const m = re.exec(src);
      if (!m) continue;
      const line = src.slice(0, m.index).split(/\r?\n/).length;
      fail(`${f}:${line} holds ${what}, which is not actionable work — ${where}.`);
      clean = false;
    }
  }
  console.log(clean
    ? `${GREEN}  ✓${R} every tracker item is WORK, not a watch or an owner decision`
    : `${RED}  ✗${R} a tracker holds something that is not actionable work`);
}

// ── rule 4: the working plan must describe work that is still ahead
{
  /**
   * `_NEXT-PR-PLAN.md` is exempt from the queue rules because it is a working document — and that exemption is
   * exactly why it rotted unnoticed until the owner opened it and said "outdated again". It described the
   * pre-2.3.0 world: an item that had shipped, a release that had happened, and layer figures I later corrected.
   *
   * The check that catches it without needing network: **it must not name a PR that is already merged into main.**
   * A plan is about work ahead; a merged PR number in it is a plan describing the past. Context references belong
   * in `_REFERENCE.md`, which is exempt from this for that reason.
   *
   * ## That is ONE spelling of "describes the past", and it was the rarer one (`Q-5`)
   *
   * The version of the plan replaced on 2026-09-05 named no pull-request number at all. It described
   * `W-14..W-22`, which had shipped about twenty pull requests earlier — and this rule printed its green tick
   * every run in between. **A plan is written in tracker ids, not in PR numbers**, so the ids were the thing to
   * read and the numbers were the thing that happened to be checked. A gate matching an adjacent spelling is
   * green for exactly as long as nobody uses the other one.
   *
   * So the second half asks the question the first half was standing in for: **does this plan name any work
   * the queue still holds?** Not *"are any of its ids closed"* — a plan legitimately cites finished work as
   * evidence, and `itemIdsIn` over-matches anything shaped like an id, so a rule about closed ids would be
   * wrong twice over. One OPEN id is the floor, and `owner-directed` is the escape for work that arrived by
   * message and has not been filed yet.
   */
  const PLAN = '_NEXT-PR-PLAN.md';
  if (files.includes(PLAN)) {
    const src = readFileSync(join(TODO, PLAN), 'utf8');
    const claimed = [...new Set([...src.matchAll(/#(\d{3,5})\b/g)].map(m => m[1]))];
    /*
     * A git failure is a FAILURE, not a skip.
     *
     * This used to `catch {}` and leave `log = ''`, and the next line then read `log ? … : []` — so an error was
     * indistinguishable from a clean result, and the gate's one independent check printed its green tick having
     * compared nothing. That is the same shape as everything else this script was found to be doing on
     * 2026-08-30: reporting a rule it was not enforcing. The `timeout` matters too — preflight's own `run`
     * helper passes none, so a hung child would hang the gate with nothing to kill it.
     */
    let log = null;
    try {
      log = execFileSync('git', ['log', '--oneline', '-400'],
        { cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 1 << 24 });
    } catch (err) {
      fail(`${PLAN} could not be checked against main: \`git log\` failed (${err}). A plan naming a merged PR is `
        + 'a plan describing the past, and this is the check for it — an unreadable history is an unanswered '
        + 'question, not a pass.');
    }

    const merged = log === null ? [] : claimed.filter(n => log.includes(`(#${n})`));
    if (merged.length) {
      fail(`${PLAN} names PR(s) already merged into main: ${merged.map(n => `#${n}`).join(', ')}. A plan is about `
        + 'work ahead — a merged number in it means the file describes the past. Rewrite it to the current state, '
        + 'or move the context to `_REFERENCE.md`.');
    }

    /*
     * ## The BRANCH is the third spelling of "describes the past", and it is the one that held
     *
     * The two checks above are about the plan's CONTENT: no merged PR number, and at least one id the queue
     * still holds. A plan that says `owner-directed` skips the second entirely — that escape exists because
     * work arrives by message before it is filed, and it is honest — and the first only ever fires on a
     * spelling a plan rarely uses.
     *
     * So on 2026-09-07 the owner opened this file and found it describing a branch that had shipped two days
     * and about a dozen pull requests earlier. Both halves were green throughout: no PR number, and
     * `owner-directed` present.
     *
     * **A plan names the branch it is for, and a branch that has been CUT and is not in hand is a receipt.**
     * A branch that does not exist yet is the opposite — this file used as its name says, planning the next
     * pull request before cutting it — so absence passes and only an existing-but-other branch fails.
     *
     * The first version demanded the planned branch BE the current one, which forbade planning ahead
     * entirely. Correcting it is the point: a rule that makes the file's own purpose impossible gets
     * disabled or worked around, and then it protects nothing.
     *
     * **Two other formulations were tried and both stayed green on the very plan that prompted this.**
     * "The branch exists somewhere" passed on a local leftover, because deleting a remote branch does not
     * touch the local copy. "The branch has an `origin/` ref" passed too, because a remote-tracking ref goes
     * stale until somebody prunes it. Both were asking git about a branch instead of asking what is being
     * worked on — and every merge here squashes, so ancestry cannot answer it either.
     *
     * `owner-directed` does not excuse this one. It says the work is unfiled, which is a statement about the
     * QUEUE; whether the branch still exists is a statement about the work, and those are different claims.
     */
    const branchLine = /^\*\*Branch:\*\*\s*`([^`]+)`/m.exec(src);
    if (branchLine) {
      let current = '';
      try {
        current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
          { cwd: ROOT, encoding: 'utf8', timeout: 15_000 }).trim();
      } catch (err) {
        fail(`${PLAN} could not be checked against the branch in hand: \`git rev-parse\` failed (${err}). `
          + 'An unreadable HEAD is an unanswered question, not a pass.');
      }
      const planned = branchLine[1].trim();
      let known = null;
      try {
        known = execFileSync('git', ['branch', '-a', '--format=%(refname:short)'],
          { cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 1 << 24 })
          .split('\n').map(b => b.trim().replace(/^origin\//, ''));
      } catch (err) {
        fail(`${PLAN} could not be checked against the branch list: \`git branch\` failed (${err}).`);
      }
      /*
       * A branch that does not exist YET is the file being used as its name says — planning the next pull
       * request before cutting it. That has to stay possible: the first version of this rule demanded the
       * planned branch BE the current one, which forbade the one thing `_NEXT-PR-PLAN.md` is for.
       *
       * What is refused is a plan naming some OTHER branch that already exists. That is not a plan; it is a
       * receipt for work that has been cut, and usually shipped.
       */
      const existsElsewhere = known !== null && known.includes(planned);
      if (current && current !== 'HEAD' && planned !== current && existsElsewhere) {
        fail(`${PLAN} plans branch \`${planned}\`, which already exists and is not the one in hand `
          + `(\`${current}\`).

`
          + '      A branch that does not exist yet is fine — that is this file planning the next pull '
          + 'request. One that has been cut and is not in hand is a receipt: that is how a plan sat here for '
          + 'two days describing a branch that had shipped, green on both the checks above, because it '
          + 'carried no pull-request number and `owner-directed` switched the other one off.');
      }
    }

    // The half the PR-number check was standing in for. `orderedHomeRows` is what the queue still holds, so an
    // id of the plan's that appears there is work ahead; anything else the plan names is context.
    const ordered = readFileSync(join(TODO, ORDERED), 'utf8');
    const openIds = new Set(orderedHomeRows(ordered).map(r => r.id));
    const named = itemIdsIn(src);
    const stillOpen = named.filter(id => openIds.has(id));
    if (!stillOpen.length && !/owner-directed/i.test(src)) {
      fail(`${PLAN} names no item that ${ORDERED} still holds — ${named.length ? `it names ${named.slice(0, 8).join(', ')}` : 'it names no item id at all'}. `
        + 'A plan is about work ahead, and a plan naming only finished ids is the shape this rule exists for: '
        + `\`W-14..W-22\` sat here for about twenty pull requests after shipping, with no PR number to catch it. `
        + 'Name the open row this serves, or say `owner-directed` if it came by message and is not filed yet.');
    }

    if (merged.length || (!stillOpen.length && !/owner-directed/i.test(src))) {
      console.log(`${RED}  ✗${R} ${PLAN} describes work that has already shipped`);
    } else {
      console.log(`${GREEN}  ✓${R} ${PLAN} describes work that is still ahead`
        + `${stillOpen.length ? `  ${DIM}(${stillOpen.join(', ')})${R}` : ''}`);
    }
  }
}

// ── rule 5: the DECISIONS page lists only what the owner still has to decide
//
// Owner, 2026-08-19, reading it: *"why are there so many items? remove everything thats already done. i only
// want to see what i have todo — hence 'todo'"*. It was 312 lines, and SEVEN entries filed as open questions were
// decided — five of them already shipped.
//
// The two rules live in `parked-decisions-rules.mjs`, pure and fixture-tested, for the same reason
// `matchIndexReference` does: `todo/` is gitignored and absent in CI, so a rule that only reads those files
// directly can never be shown to fail. See that file for what each one refuses and which false positives were
// designed out of it.
{
  const PARKED = '_PARKED-DECISIONS.md';
  const REF = '_REFERENCE.md';
  let clean = true;
  if (files.includes(PARKED)) {
    const src = readFileSync(join(TODO, PARKED), 'utf8');

    for (const { heading, line } of resolvedHeadings(src)) {
      fail(`${PARKED}:${line} has a section announcing a resolution — "${heading.slice(0, 70)}". This page is what `
        + 'the owner still has to DECIDE. Record the outcome in `_REFERENCE.md` under Decisions already made.');
      clean = false;
    }

    for (const { id, marker, line } of rulingsLeftOnThePage(src)) {
      fail(`${PARKED}:${line} — ${id} records its own ruling ("${marker}"), so it is not an open decision. Move `
        + 'the outcome to `_REFERENCE.md`. A ruling of "do nothing" leaves no code to find, which is exactly how '
        + 'this one survived a manual pass that checked whether anything had shipped.');
      clean = false;
    }

    if (files.includes(REF)) {
      const both = decidedButStillFiled(src, readFileSync(join(TODO, REF), 'utf8'));
      for (const id of both) {
        fail(`${PARKED} still carries ${id}, which ${REF} records as DECIDED. One of the two is wrong, and a `
          + 'settled row on the decisions page makes every other row less believable.');
        clean = false;
      }
    }
  }
  console.log(clean
    ? `${GREEN}  ✓${R} the decisions page holds only what is still undecided`
    : `${RED}  ✗${R} the decisions page carries settled items`);
}

// ── the queue must be touched between commits, or it silently rots
//
// THE COMPLAINT THIS EXISTS FOR, owner 2026-08-30: *"i have to ask for uptodate todo-files all the time and
// ALWAYS they are out of date."* Correct, and the reason is structural rather than forgetful: every OTHER
// rule in this file checks a claim a row makes about the CODE, so a row that says nothing false stays green
// while the queue as a whole drifts — a shipped bug with no row, a header naming a PR from twelve hours ago,
// a remark quoting a line count three PRs old. Nothing was lying; nothing was current either.
//
// A rule that has to be remembered is worth less than a gate that fails, so this is the gate. `todo/` is
// gitignored, so git cannot answer "was it updated with this change" — but mtime can: if HEAD has moved since
// the ordered queue was last written, the queue predates the work and preflight refuses the push.
//
// It is deliberately blunt. Touching the file to satisfy it is one line, and the line worth touching is the
// STATE header — which is exactly what went stale.
{
  let headTime = null;
  try {
    headTime = Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()) * 1000;
  } catch { /* no git, no history, or a fresh repo — nothing to compare against */ }

  if (headTime) {
    const queueTime = statSync(join(TODO, ORDERED)).mtimeMs;
    if (queueTime < headTime) {
      const age = Math.round((headTime - queueTime) / 60000);
      fail(`${ORDERED} was last written ${age} minute(s) BEFORE the newest commit, so it describes the work `
        + 'as it was before this change.\n\n'
        + '      Update the queue as part of the change, not afterwards: close what shipped, file what you '
        + 'found,\n'
        + '      and refresh the STATE header. If this change genuinely moved nothing in the queue, say so '
        + 'there —\n'
        + '      a header that names the current PR is itself the update.');
    } else {
      console.log(`${GREEN}  ✓${R} ${ORDERED} was written after the newest commit`);
    }
  }
}

/*
 * ── the exemption REASON is checked, not only the file it names
 *
 * Two structural windows in `testing/` close on this heading, so it is a BOUNDARY as well as a title —
 * renaming it breaks them, which is what happened when it stopped being "the exemption list must not rot".
 *
 * This checked one thing and it was the harmless one. An exemption naming a page that is gone points at
 * nothing and excuses nothing, and it said so itself — a yellow `harmless, but tidy it`.
 *
 * The damaging half was never looked at. `_PARKED-DECISIONS.md` was exempted because it was "indexed by
 * outcome rather than queued"; the outcomes moved to `_REFERENCE.md` and the exemption stayed, so that page
 * accumulated resolved history for weeks while every checked page reported clean — until the owner opened it
 * and found seven settled items filed as open. The file existed the whole time.
 *
 * "Is this reason still true?" has no `grep -c`. A COUNT in it does, and the list had one that was wrong:
 * an exemption once described its file as holding SIX steps while the file had seven boxes. A count in a reason
 * is checked against the file for that reason.
 *
 * And the absent-file case now fails rather than logs — not because it became harmful, but because this
 * file's own note says a stale entry must fail rather than warn, and then left this one warning. A yellow
 * line in a green run is read as decoration, which is the mechanism the whole check exists to defeat.
 */
{
  const stale = [...NOT_A_QUEUE.keys()].filter(f => !files.includes(f));
  if (stale.length) {
    fail(`NOT_A_QUEUE exempts ${stale.join(', ')}, which todo/ does not contain.\n\n`
      + `      Harmless on its own — it excuses nothing. It fails because an exemption nobody re-reads is how\n`
      + `      a page goes unchecked for weeks, and a list with a dead row in it is a list nobody is reading.`);
  }

  for (const [f, reason] of NOT_A_QUEUE) {
    const stated = statedStructureCount(reason);
    if (stated === null || !files.includes(f)) continue;
    const actual = checklistBoxCount(readFileSync(join(TODO, f), 'utf8'));
    if (stated !== actual) {
      fail(`NOT_A_QUEUE exempts ${f} as "${reason}", and it has ${actual} ${actual === 1 ? 'box' : 'boxes'}.\n\n`
        + `      A number in a reason is a claim about the page. This one is what the next person checks before\n`
        + `      adding a rule, so correct the reason — or the page, if the count is what moved.`);
    }
  }
}

console.log(`\n${'='.repeat(78)}`);
if (!failures.length) {
  console.log(`${GREEN}todo/ is consistent${R} — open items only, all of them indexed.\n`);
  process.exit(0);
}
console.log(`${RED}todo/ is inconsistent${R} — ${failures.length} problem(s):\n`);
for (const f of failures) console.log(`  ${RED}·${R} ${f}\n`);
process.exit(1);
