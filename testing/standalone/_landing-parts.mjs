/**
 * Which lanes of the landing experiment's full table one PART file of a split experiment runs (bundle-348, Q-923).
 *
 * ## What it prevents
 *
 * A landing experiment whose lanes take longer than a file may (60 s) is cut into part files, each its own process with its own door.
 * Cut by hand, each file listing its own lane indexes, two things go wrong quietly and every file stays green: a lane is left out of
 * every part (its holder or door is held nowhere), or two parts run one lane (and another is left out). So a part file names only WHICH
 * part it is, `partOf(stem, index)`; the count of parts is this module's {@link SPLIT_EXPERIMENTS}, and the lanes are cut by
 * {@link lanesOfPart} inside `landingExperiment` from the table it derives itself. No part file can hand in a lane list.
 *
 * That the part files of each split experiment are exactly the parts 0 to count-1, one file each, is held by
 * `the-parts-of-a-split-landing-experiment-run-every-lane-once.test.js`, which reads the files and asks {@link partProblems}.
 */

/**
 * Every split experiment, by its file stem (the name of its first part without `-db.test.js`), and how many part files it is cut into.
 * Part 1 keeps the experiment's own name; part N (N >= 2) is `<stem>-part-N-db.test.js`.
 */
export const SPLIT_EXPERIMENTS = Object.freeze({
  // The count is the fewest parts whose measured time each stays well under the 60 s a file may take (the runs are in the commit that
  // set it); a new holder case that pushes a part past it is a reason to raise the count here, never to drop lanes.
  'a-write-the-bound-ended-never-lands': 2,
  'a-write-the-bound-ended-never-lands-when-the-command-is-late': 2,
});

/**
 * The part `index` (0-based) of the split experiment `stem`, as `landingExperiment` takes it.
 * THROWS for a stem that is not split or an index outside 0 to count-1: a typo would otherwise run a part nobody else covers.
 * @returns {{ stem: string, index: number, count: number }}
 */
export function partOf(stem, index) {
  const count = SPLIT_EXPERIMENTS[stem];
  if (count === undefined) throw new Error(`partOf: '${stem}' is not a split experiment (${Object.keys(SPLIT_EXPERIMENTS).join(', ')})`);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`partOf: part ${index} of '${stem}' is not one of 0 to ${count - 1}`);
  return { stem, index, count };
}

/**
 * The lane indexes (into a table of `laneCount` lanes) that part `index` of `count` runs: every `count`-th lane, starting at `index`.
 * Interleaved, so the doors (the table's first lanes) and the holder cases are spread over the parts. THROWS when a part would hold no
 * lane: it would pass and test nothing.
 * @returns {number[]}
 */
export function lanesOfPart(laneCount, index, count) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) throw new Error(`lanesOfPart: part ${index} of ${count} is not a part`);
  if (!Number.isInteger(laneCount) || count > laneCount) throw new Error(`lanesOfPart: ${count} parts for ${laneCount} lane(s): a part would hold no lane, pass, and test nothing`);
  return Array.from({ length: laneCount }, (_, n) => n).filter(n => n % count === index);
}

/** The part a file name says it is (0-based), for a file of `stem`'s experiment; `undefined` for a file of another. */
export function partNamed(file, stem) {
  if (!/^[a-z0-9-]+$/.test(stem)) throw new Error(`partNamed: '${stem}' is not a file stem`);
  const m = new RegExp(`(?:^|/)${stem}(?:-part-(\\d+))?-db\\.test\\.js$`).exec(file);
  if (!m) return undefined;
  return m[1] === undefined ? 0 : Number(m[1]) - 1;
}

/**
 * What is wrong with the part files of the split experiments, as sentences: each split experiment has exactly its count of part files,
 * each declares `const PART = <n>;` and asks `partOf('<its stem>', PART)`, the name agrees with the index, the indexes are exactly
 * 0 to count-1 one file each, and no part file hands the experiment a lane list of its own.
 * @param {Array<{ file: string, text: string }>} files  every tracked test file, its text with comments stripped
 * @param {Record<string, number>} [split]  defaults to {@link SPLIT_EXPERIMENTS}
 * @returns {string[]}
 */
export function partProblems(files, split = SPLIT_EXPERIMENTS) {
  const problems = [];
  for (const [stem, count] of Object.entries(split)) {
    const parts = files.map(f => ({ ...f, named: partNamed(f.file, stem) })).filter(f => f.named !== undefined);
    if (parts.length !== count) problems.push(`'${stem}' is cut into ${count} parts, and ${parts.length} file(s) are its parts: ${parts.map(p => p.file).join(', ') || 'none'}`);
    const seen = new Map();
    for (const { file, text, named } of parts) {
      const declared = /^const PART = (\d+);/m.exec(text)?.[1];
      if (declared === undefined) { problems.push(`${file} declares no \`const PART = <n>;\``); continue; }
      const index = Number(declared);
      if (index !== named) problems.push(`${file} runs part ${index}, which is not the part its name says (${named})`);
      if (!new RegExp(`\\bpartOf\\(\\s*'${stem}'\\s*,\\s*PART\\s*\\)`).test(text)) problems.push(`${file} does not ask partOf('${stem}', PART): its lanes are not this experiment's cut`);
      if (/\blaneIndexes\s*:/.test(text)) problems.push(`${file} hands the experiment laneIndexes of its own: a part's lanes come from partOf alone`);
      seen.set(index, [...(seen.get(index) ?? []), file]);
    }
    for (const [index, owners] of seen) if (owners.length > 1) problems.push(`part ${index} of '${stem}' is run by ${owners.length} files (${owners.join(', ')})`);
    for (let i = 0; i < count; i++) if (!seen.has(i)) problems.push(`no file runs part ${i} of '${stem}': its lanes run nowhere`);
    for (const index of seen.keys()) if (index >= count) problems.push(`part ${index} of '${stem}' is outside 0 to ${count - 1}`);
  }
  return problems;
}
