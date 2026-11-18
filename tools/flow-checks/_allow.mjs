/**
 * The exceptions a flow-check probe honours, read from its `.allow.json` beside it, and the one rule every such list obeys.
 *
 * ## What it prevents
 *
 * A probe whose allow list is a blanket skip: an entry nobody explained, or one nobody looked at again. Each probe of this folder that
 * keeps exceptions (`check-i-docs-refusals-and-messages-current` first, then the source, compose and legal probes) wrote its own
 * "reason and reviewBy" loop, and the copy that forgets the date check is the one that lets an exception live for ever. The rule is here once:
 * an entry with no reason, no `YYYY-MM-DD` reviewBy, or a reviewBy before today is a violation of the probe that reads it, and the
 * verdict says how many exceptions it used.
 *
 * `allowFileFor(import.meta.url)` names the file (`<probe>.allow.json` beside the probe), `readAllow` reads it (an unreadable or malformed
 * file is `cannot answer`, never an empty list), and `allowProblem(entries, today)` returns the first thing wrong or null.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CannotAnswer } from './_verdict.mjs';

/** The allow file of the probe at `metaUrl`: its own name with `.allow.json` for `.mjs`. */
export const allowFileFor = (metaUrl) => fileURLToPath(metaUrl).replace(/\.mjs$/, '.allow.json');

/** The entries of the allow file, an array. Unreadable, not JSON, or not an array: `cannot answer`. */
export function readAllow(file) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { throw new CannotAnswer(`${file} unreadable: ${String(e.message).split('\n')[0]}`); }
  if (!Array.isArray(parsed)) throw new CannotAnswer(`${file} is not an array of exceptions`);
  return parsed;
}

/** `today` is `YYYY-MM-DD`. The first problem with an entry (a reason, a reviewBy date not yet past), or null when every entry is sound. */
export function allowProblem(entries, today) {
  for (const e of entries) {
    const what = JSON.stringify(e).slice(0, 140);
    if (typeof e.reason !== 'string' || e.reason.trim().length < 20) return `an exception needs its reason (at least 20 characters): ${what}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy ?? '')) return `an exception needs a reviewBy date (YYYY-MM-DD): ${what}`;
    if (e.reviewBy < today) return `an exception is past its reviewBy date ${e.reviewBy}: review it, then move the date: ${what}`;
  }
  return null;
}

/**
 * Findings against exceptions: `findings` are `{ id, text }`, each exception is `{ id, reason, reviewBy }` and excuses the finding with its id.
 * Returns `{ problem, open, used }`: a problem with the list itself (a missing reason, a past date, an id nothing found any more, two entries
 * for one id) or the findings no exception excuses, with the number of exceptions that excused one. An exception that matches no finding is
 * a problem, so the list is a ceiling: fixing the defect removes its entry.
 */
export function applyAllow(findings, entries, todayDate) {
  const problem = allowProblem(entries, todayDate)
    ?? ((e) => (e ? `an exception has no id: ${JSON.stringify(e).slice(0, 140)}` : null))(entries.find((x) => typeof x.id !== 'string' || !x.id));
  if (problem) return { problem, open: [], used: 0 };
  const ids = new Set(findings.map((f) => f.id));
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) return { problem: `two exceptions share the id ${e.id}`, open: [], used: 0 };
    seen.add(e.id);
    if (!ids.has(e.id)) return { problem: `the exception ${e.id} excuses nothing any more: remove it`, open: [], used: 0 };
  }
  return { problem: null, open: findings.filter((f) => !seen.has(f.id)), used: entries.length };
}

/**
 * A ratchet: measures against ceilings. `measures` are `{ id, value, text }`, each ceiling is `{ id, max, reason, reviewBy }`. A measure above 0
 * is allowed up to its ceiling (no ceiling means 0), so a defect class that exists today cannot grow and a new one cannot start. Returns
 * `{ problem, over, used, slack }`: a problem with the list (as {@link allowProblem}, a ceiling that is not a whole number, a ceiling for a
 * measure that is 0 or absent, two for one id), the measures above their ceiling, the ceilings in use, and the ceilings above their measure
 * (`slack`: say it in the verdict, the owner lowers the ceiling; a ceiling only goes down).
 */
export function applyCeilings(measures, entries, todayDate) {
  const problem = allowProblem(entries, todayDate)
    ?? ((e) => (e ? `a ceiling needs an id and a whole number max: ${JSON.stringify(e).slice(0, 140)}` : null))(entries.find((x) => typeof x.id !== 'string' || !Number.isInteger(x.max) || x.max < 0));
  if (problem) return { problem, over: [], used: 0, slack: [] };
  const byId = new Map();
  for (const e of entries) {
    if (byId.has(e.id)) return { problem: `two ceilings share the id ${e.id}`, over: [], used: 0, slack: [] };
    byId.set(e.id, e);
  }
  const live = new Map(measures.filter((m) => m.value > 0).map((m) => [m.id, m]));
  for (const id of byId.keys()) if (!live.has(id)) return { problem: `the ceiling ${id} limits a measure that is 0 or no longer exists: remove it`, over: [], used: 0, slack: [] };
  const over = [...live.values()].filter((m) => m.value > (byId.get(m.id)?.max ?? 0));
  const slack = [...live.values()].filter((m) => byId.has(m.id) && m.value < byId.get(m.id).max).map((m) => `${m.id} is ${m.value} against a ceiling of ${byId.get(m.id).max}`);
  return { problem: null, over, used: byId.size, slack };
}

/** Today as `YYYY-MM-DD` in UTC, the one place a probe asks. */
export const today = () => new Date().toISOString().slice(0, 10);
