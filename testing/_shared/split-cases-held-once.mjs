/**
 * Whether every case of a split test is held by exactly one of its files, in the file the split names, as often as it names it.
 *
 * ## What it prevents
 *
 * A test cut into several files so they run side by side is held only while every case stays in exactly one of them. A cut by hand can lose
 * a case (it stays in no file: a rule nobody checks), repeat one (it runs twice, and a fix to one copy leaves the other), or leave it in a
 * file the split moved it out of. Every file stays green in each of those, so only a reading of ALL the files together notices. Each split
 * wrote its own copy of that reading (bundle-348, the failing-space-index pair); this is the one they share (bundle-356, Q-937), so a split
 * gate only declares its files and their cases.
 *
 * ## What is inside, so no gate can drop it
 *
 * - A file of the split that is not tracked (deleted, renamed, never added) is a problem, and so is every case it held.
 * - A case title the default reader cannot read as a literal (a template with a substitution, a title built in a loop) THROWS, naming the
 *   file and line: a reader that skipped it would report the looped cases as missing at best and as nothing at worst.
 * - A split that lists one case under two files throws: the declaration itself is wrong, not the files.
 *
 * A gate with its own case naming (letters, rows) passes `namesOf`; everything else stays the same.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ts, parseSource } from './syntax-tree.mjs';
import { REPO_ROOT, trackedSources } from '../standalone/_sources.mjs';

/**
 * The titles of the `it(...)` cases a source text declares, one per declaration site, in order.
 * @throws when a title is not a literal, naming `file` and the line: a case this reading cannot name is never left out quietly
 */
export function itTitles(text, file) {
  const sf = parseSource(file, text);
  const out = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'it' && n.arguments[0]) {
      const a = n.arguments[0];
      if (!ts.isStringLiteral(a) && !ts.isNoSubstitutionTemplateLiteral(a)) {
        const line = sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1;
        throw new Error(`${file}:${line} the title of this case cannot be read as a literal: a split gate cannot hold a case it cannot name`);
      }
      out.push(a.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * What is wrong with how `files` hold `split`, one sentence each; empty when every case is held once, in its file, as often as listed.
 * @param {{ file: string, text: string }[]} files the split's files as read
 * @param {Record<string, string[]>} split each file of the split and the cases it holds (a name listed n times is declared n times there)
 * @param {(text: string, file: string) => string[]} [namesOf] the case names one file declares, one per site; default {@link itTitles}
 * @returns {string[]}
 */
export function splitCaseProblems(files, split, namesOf = itTitles) {
  const home = new Map();
  for (const [file, names] of Object.entries(split)) {
    for (const name of names) {
      const at = home.get(name);
      if (at && at.file !== file) throw new Error(`the split lists "${name}" under ${at.file} and ${file}: a case belongs to one file`);
      if (at) at.times += 1;
      else home.set(name, { file, times: 1 });
    }
  }
  const out = [];
  const read = new Set(files.map(f => f.file));
  for (const file of Object.keys(split)) if (!read.has(file)) out.push(`file gone: ${file} is not among the files read`);
  /** name -> file -> sites */
  const held = new Map();
  for (const { file, text } of files) {
    for (const name of namesOf(text, file)) {
      const per = held.get(name) ?? new Map();
      per.set(file, (per.get(file) ?? 0) + 1);
      held.set(name, per);
    }
  }
  for (const [name, { file, times }] of home) {
    const per = held.get(name) ?? new Map();
    const where = [...per.keys()];
    if (where.length === 0) out.push(`missing: "${name}" is in no file`);
    else if (where.length > 1) out.push(`twice: "${name}" is in ${where.join(' and ')}`);
    else if (where[0] !== file) out.push(`wrong file: "${name}" is in ${where[0]}, not ${file}`);
    else if (per.get(file) !== times) out.push(`count: "${name}" is declared ${per.get(file)} time(s) in ${file}, the split lists it ${times}`);
  }
  for (const [name, per] of held) if (!home.has(name)) out.push(`unlisted: "${name}" in ${[...per.keys()].join(', ')}`);
  return out;
}

/**
 * Read the split's files as the repository tracks them and throw, naming every problem, unless each case is held once where the split says.
 * @param {Record<string, string[]>} split repo-relative file -> the cases it holds
 * @param {{ namesOf?: (text: string, file: string) => string[], root?: string }} [opts]
 */
export function assertSplitCasesHeldOnce(split, { namesOf = itTitles, root = REPO_ROOT } = {}) {
  const wanted = Object.keys(split);
  const tracked = new Set(trackedSources(wanted, { ext: null, floor: 0, root }));
  const files = wanted.filter(f => tracked.has(f)).map(file => ({ file, text: readFileSync(join(root, file), 'utf8') }));
  const problems = splitCaseProblems(files, split, namesOf);
  if (problems.length > 0) throw new Error(`the split lost, repeated or misplaced a case:\n  ${problems.join('\n  ')}`);
}
