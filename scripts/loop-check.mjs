#!/usr/bin/env node
/**
 * `npm run loop:check` — may the turn end here?
 *
 * ## Why this exists
 *
 * The dev-loop in `todo/_THE_LOOP.md` is a discipline, and it kept failing in the same way: I would finish a
 * unit of *bookkeeping* — a tracker updated, a blocker recorded, a revert explained — and write the reply. A
 * reply ends the turn. So the loop did not stop because the work ran out; it stopped because something felt
 * like a finished thought.
 *
 * The owner corrected this five separate times in one session ("are you still in the loop?", "why did you leave
 * the loop again?", "your loop is buggy"). Five corrections of one behaviour means the rule was never the
 * problem. Every other rule here that kept being broken became a gate — the god-file ratchet, the reachability
 * check, `todo:check`, the audit-route allowlist. This is that, for the loop itself.
 *
 * ## What it decides
 *
 * One question, answered from repo state rather than from how finished I feel: **is something in flight, or is
 * the queue drained?** Those are the only two states in which a turn may end.
 *
 *  - **In flight** — an open PR I authored. Then "Running" is a fact with a number attached, which is what the
 *    reply format's last slot is supposed to carry.
 *  - **Drained** — no open rows in the queue's work section. That is the release boundary the loop is designed to
 *    stop at. Work sections are identified by heading, not by row ID; see `parseRows`.
 *
 * Anything else means work is available and nothing is executing, so the turn must continue. It prints the next
 * row, so the verdict is "keep going, on this" rather than just "keep going".
 *
 * ## The three excuses it refuses by construction
 *
 *  - **"I recorded the blocker, so that item is handled."** A blocker on item N is not a stopping condition; it
 *    is item N being replaced by item N+1 in the same turn. The script sees no PR and open rows, not my reasoning.
 *  - **"Context is low."** Not a state this reads. Deliberately.
 *  - **"This is a natural stopping point."** Neither.
 *
 * A genuine stop — an owner decision, a live-cluster change, something outward-facing, an external failure — is
 * still a stop. `--reason "<which>"` puts that claim on the record instead of leaving it implied.
 *
 * ## Why it is not wired into preflight
 *
 * Preflight guards a *push*. This guards a *turn ending*, which is not an event any hook can observe — so it is
 * run at the point of writing a reply, and exits non-zero so it reads like every other gate. `todo/` is
 * gitignored, so like `todo:check` this only ever runs locally; with the folder absent it exits 0 rather than
 * inventing a verdict.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isEntryPoint } from './_shared/script-cli.mjs';

const ORDERED = 'todo/_TODO-ORDERED.md';
/** The authority for what is parked. A tier in the ordered file is bookkeeping; this is what the owner reads. */
const PARKED = 'todo/_PARKED-DECISIONS.md';
const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' };
const reason = process.argv.includes('--reason') ? process.argv[process.argv.indexOf('--reason') + 1] : null;

const sh = (cmd) => {
  // NOT trimmed. `git status --porcelain` puts a meaningful SPACE in column 1 for an unstaged change, and
  // trimming the aggregate output eats it on the first line only — which is how this once reported `ackage.json`.
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
};

/**
 * Sections that are listed in the ordered file but are NOT the queue.
 *
 * `W-` (watching), `P-` (parked) and the release section are exactly why the file can be drained while still
 * listing things; counting them would make "the queue is empty" unreachable, which is the defect the retired
 * *behind the tag* tier had.
 *
 * Matched on the HEADING rather than on the row ID, and the direction of the rule is deliberate: everything is
 * work unless its section says otherwise. A new non-work section nobody taught this script about gets COUNTED,
 * so the gate says "keep working" — an annoyance. The reverse default drains the queue silently, which is the
 * failure this file exists to prevent and the one it shipped with for two weeks.
 */
const NOT_WORK_HEADING = /watch|parked|not work|release|reference|note/i;

/** A done marker and nothing else: `shipped`, `merged (#812)`, `done 2026-08-04`. */
const DONE_ONLY = /^(?:done|shipped|merged)\b[^a-z]*$/i;

/**
 * A queue row's ID: `B-3`, `RX-1`, `P0-1`, `D-8d`.
 *
 * Loose on purpose — see `parseRows`. No `g` flag: `test()` on a global regex advances `lastIndex` between calls
 * and would skip every other row.
 */
const ROW_ID = /^[A-Z][A-Z0-9]{0,3}-\d+[a-z]?$/;

/**
 * Open rows in the ordered queue.
 *
 * The file is a table, one task per line (owner, 2026-08-09), so a row is a `|`-delimited line whose first cell
 * is an ID like `B-2`. Anything else — headers, the `|---|` separator, prose between tables — is not a task.
 *
 * **A row's tier is the section it sits under, never the letter in its ID.** The first version keyed on
 * `id.startsWith('Q-')`, from a period when every row was a `Q-`. The queue was later re-keyed per domain — `B-`
 * architecture, `U-` UX, `T-` sync — and this went on counting a prefix that no longer existed: it reported *the
 * queue is drained* with eleven rows open, in green. Sections are what the owner maintains by hand, and `W-8`
 * proves the ID cannot stand in for one — it is open work carrying a watch-tier ID because its home tracker keyed
 * it that way.
 *
 * **The ID SHAPE drifted the same way the prefix did, and cost the same eleven rows.** The replacement rule was
 * `^[A-Z]-\d+$` — one letter, a dash, digits — which was every ID that existed when it was written. The queue
 * has since keyed rows by domain initials and by sub-item: `RX-1` reindex, `EJ-1` embed jobs, `SA-1` space admin,
 * `P0-1` for a priority-zero report, `D-8d` for the fourth part of deprecation row 8. None of those are one
 * letter, so none of them were rows. On 2026-08-15 the file held eleven open rows and the gate reported two —
 * the identical failure, in the identical direction, one regex further along.
 *
 * So the pattern is now deliberately loose: an uppercase letter, up to three more uppercase-or-digit characters,
 * a dash, digits, and an optional lowercase sub-item letter. It is written to admit an ID nobody has invented
 * yet, because the two failure directions are not symmetric — over-counting says *keep working* on a drained
 * queue, which costs a wasted lens; under-counting says *drained* on a full one, which is what this file exists
 * to prevent and what it has now shipped twice.
 *
 * A row whose status is *only* a done marker is not open either — the queue is what is left, not what was listed.
 * That test used to match `done|shipped|merged` anywhere in the cell, which read `2 wrappers shipped (#842,
 * #843)` as finished when it means three fifths remain. Partial progress is the most common status in this file,
 * so the marker now has to be the whole cell.
 */
export function parseRows(text) {
  const rows = [];
  let inWork = true; // Rows above the first heading are work; an unlabelled table is the file's oldest shape.
  for (const line of text.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) { inWork = !NOT_WORK_HEADING.test(heading[1]); continue; }
    if (!inWork || !line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    const id = cells[0];
    if (!id || !ROW_ID.test(id)) continue;
    if (DONE_ONLY.test(cells[3] ?? '')) continue;
    rows.push({ id, what: cells[1] ?? '', status: cells[3] ?? '' });
  }
  return rows;
}

function openRows() {
  if (!existsSync(ORDERED)) return null;
  return parseRows(readFileSync(ORDERED, 'utf8'));
}

/** An open PR authored by me is the only thing that makes "Running" a fact rather than an intention. */
function openPr() {
  const out = sh('gh pr list --author @me --state open --json number,title,headRefName --limit 5');
  if (!out) return null;
  try { return JSON.parse(out); } catch { return null; }
}

/**
 * `XY <path>` lines to paths.
 *
 * Anchored on the separating whitespace rather than a fixed width, and accepting one OR two status columns. A
 * fixed `slice(3)` breaks the moment anything upstream trims the output, and it fails by returning a filename
 * with its first letter missing — which then matches no extension and reads as a clean tree. A gate that
 * under-reports is worse than no gate.
 *
 * A rename reports `old -> new`; the new path is the one that exists. `todo/` is excluded on purpose: a tracker
 * edit is precisely what must not count as work in progress.
 */
export function sourceFiles(porcelain) {
  return porcelain.split('\n')
    .map((l) => l.replace(/^[A-Z?! ]{1,2}\s+/, '').replace(/^.* -> /, '').trim())
    .filter((f) => f && !f.startsWith('todo/') && /\.(ts|js|mjs|html|css|json|yml|md)$/.test(f));
}

/** Uncommitted source changes mean a task is half-done in the tree, which is never a place to stop. */
function dirtySource() {
  const out = sh('git status --porcelain');
  return out ? sourceFiles(out) : [];
}

// Only the CLI renders a verdict; the test imports the two pure helpers above.
if (isEntryPoint(import.meta.url)) main();

function main() {
  const rows = openRows();
  const prs = openPr();
  const dirty = dirtySource();

  console.log(`${C.bold}loop:check${C.off} ${C.dim}— may this turn end?${C.off}\n`);

  if (rows === null) {
    console.log(`${C.dim}todo/ is absent — nothing to check.${C.off}`);
    process.exit(0);
  }

  const inFlight = prs !== null && prs.length > 0;
  console.log(`  open work rows in ${ORDERED}: ${rows.length}` +
    (rows.length ? ` ${C.dim}-> ${rows.slice(0, 4).map((r) => r.id).join(', ')}${rows.length > 4 ? ', …' : ''}${C.off}` : ''));
  console.log(`  open PRs authored by me:    ${prs === null ? '(gh unavailable)' : prs.length}` +
    (inFlight ? ` ${C.dim}-> #${prs.map((p) => p.number).join(', #')}${C.off}` : ''));
  console.log(`  uncommitted source files:   ${dirty.length}` +
    (dirty.length ? ` ${C.dim}-> ${dirty.slice(0, 3).join(', ')}${C.off}` : ''));
  console.log('');

  if (reason) {
    // A claimed OWNER DECISION is checkable, and it is the one that has been abused.
    //
    // Twice now a turn ended on "Your move" while the ordered queue held work — once on an item that was already
    // decided and documented, once on a phantom: a row sitting in the ordered file's parked tier while
    // `_PARKED-DECISIONS.md` said "Nothing open". A decision nobody is actually waiting on is not a stop, it is a
    // manufactured one, and it is the same failure as claiming "Running" with nothing running.
    //
    // Two facts settle it. **Parked never blocks** while other work exists (owner, 2026-08-10: "if its in parked you
    // dont wait for me if there are other things in ordered"). And `_PARKED-DECISIONS.md` is the authority for what
    // is parked — a tier in the ordered file is bookkeeping, not a queue the owner reads for decisions.
    if (/owner|decision|your move|sign.?off|approval/i.test(reason)) {
      const parkedOpen = existsSync(PARKED) && !/^\s*##\s+Nothing open\s*$/mi.test(readFileSync(PARKED, 'utf8'));
      if (rows.length > 0) {
        console.log(`${C.red}NOT A STOP${C.off} — an owner decision is claimed, but ${rows.length} work row(s) are open.`);
        console.log('Parked never blocks while other work exists. Go build the next row and batch the decision.');
        console.log(`${C.bold}Next: ${rows[0].id} — ${rows[0].what}${C.off}`);
        process.exit(1);
      }
      if (!parkedOpen) {
        console.log(`${C.red}NOT A STOP${C.off} — an owner decision is claimed, but ${PARKED} says nothing is open.`);
        console.log('Either file it there with a recommended default, or decide it yourself (the TINA rule).');
        process.exit(1);
      }
    }
    // Naming a stop puts the claim on the record. The script cannot verify the other kinds, but an unnamed stop and
    // a named one should not look identical afterwards.
    console.log(`${C.yellow}STOP CLAIMED${C.off} — ${reason}`);
    console.log(`${C.dim}The genuine stops: an owner decision, a live-cluster change, something${C.off}`);
    console.log(`${C.dim}outward-facing, or an external failure. Nothing else.${C.off}`);
    process.exit(0);
  }

  if (dirty.length) {
    console.log(`${C.red}DO NOT STOP${C.off} — ${dirty.length} source file(s) are uncommitted.`);
    console.log('A half-applied change in the tree is a task in progress, not a finished one.');
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log(`${C.green}MAY STOP${C.off} — the queue is drained.`);
    console.log('That is the release boundary: cut the tag, then open the next audit lens.');
    process.exit(0);
  }

  if (inFlight) {
    console.log(`${C.green}MAY STOP${C.off} — #${prs[0].number} is in flight.`);
    console.log(`${C.dim}"Running" must name it. Prepare the next PR locally while the Monitor waits on green.${C.off}`);
    process.exit(0);
  }

  console.log(`${C.red}DO NOT STOP${C.off} — nothing is in flight and ${rows.length} row(s) are open.`);
  console.log(`${C.bold}Next: ${rows[0].id} — ${rows[0].what}${C.off}` +
    (rows[0].status ? ` ${C.dim}(${rows[0].status})${C.off}` : ''));
  console.log('');
  console.log(`${C.dim}"Running" with no PR number is the failure signature. So is a reply whose newest${C.off}`);
  console.log(`${C.dim}work is a tracker edit. Go build ${rows[0].id}, then come back to this.${C.off}`);
  process.exit(1);
}
