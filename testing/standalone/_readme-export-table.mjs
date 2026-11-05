/**
 * What a section of `schema/README.md` names: the first column of its export table, and the reasons its bullets list. The ONE reader, for the gates that
 * hold the README to a list in code.
 *
 * ## The question it answers
 *
 * *"Which names does the README section `## <heading>` state?"* Two gates ask it of two sections: the app entry's table (`the-schema-readme-names-every-name-of-the-app-entry.test.js`)
 * and the from-typescript entry's (`the-schema-readme-names-every-name-of-the-from-typescript-entry.test.js`). The README is held to a list because "this
 * table names every export" and "the whole list of reasons" are claims a machine can check; a copy of the reader in each gate would read a
 * heading or a comment differently in one of them. HTML comments are not text, a heading must exist (a missing section THROWS, never reads as
 * "no names"), and the section ends at the next `##`.
 */
import assert from 'node:assert/strict';

/** The lines of the section headed `## <section>`, HTML comments removed. Throws when the README has no such section. */
export function sectionLines(readme, section) {
  const lines = readme.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const start = lines.findIndex(l => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim() === section);
  assert.ok(start >= 0, `schema/README.md has no "## ${section}" section`);
  const out = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

/** The names the first column of the section's export table holds, in order: every backticked identifier of a row's first cell. */
export function tableNames(readme, section) {
  const names = [];
  for (const line of sectionLines(readme, section)) {
    if (!line.startsWith('|')) continue;
    for (const m of (line.split('|')[1] ?? '').matchAll(/`([A-Za-z_$][\w$]*)`/g)) names.push(m[1]);
  }
  return names;
}

/** What the table lacks, what it names that the entry does not have, and what it names twice, as `{ missing, extra, repeated }`. */
export function tableGaps(readme, expected, section) {
  const names = tableNames(readme, section);
  const have = new Set(names);
  const want = new Set(expected);
  return {
    missing: [...want].filter(n => !have.has(n)).sort(),
    extra: [...have].filter(n => !want.has(n)).sort(),
    repeated: names.filter((n, i) => names.indexOf(n) !== i).sort(),
  };
}

/** The reasons the section's bullets list, in order: the first backticked name of each `- \`name\`: ...` line. */
export function bulletReasons(readme, section) {
  const out = [];
  for (const line of sectionLines(readme, section)) {
    const m = /^[-*]\s+`([a-z]+(?:-[a-z]+)*)`\s*:/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}
