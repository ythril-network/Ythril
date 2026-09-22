/**
 * The CHANGELOG section for one version — one implementation, two callers.
 *
 * ## Why it is a module rather than a regex in each place
 *
 * `release-gate.mjs` already located a version's section to check it is dated and non-empty. `publish.yml`
 * now needs the same section as the body of a GitHub Release. Two copies of "where does this version's
 * section start and stop" is the defect this repo produces most, and here it has a specific failure mode:
 * the gate would keep passing on a correct CHANGELOG while the workflow published half of it, and nobody
 * compares a release body against anything.
 *
 * ## Bounded by the next heading, never by a count
 *
 * The 3.1.0 body is ~74 KB. A slice bounded by a character count would ship a truncated release note that
 * reads as complete — and a count spans different lines on a CRLF working copy than in CI's LF checkout,
 * so it would not even truncate in the same place twice.
 */

/** Match a dated release heading for `version`, e.g. `## [3.1.0] — 2026-08-17`. Both dash forms. */
export function headingFor(version) {
  return new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]\\s+[—-]\\s+(\\d{4}-\\d{2}-\\d{2})`, 'm');
}

/**
 * The whole section for `version`, heading included, or `null` when there is no dated heading for it.
 *
 * Line endings are normalised to `\n` first so the same offsets hold on either checkout.
 */
export function changelogSection(changelogText, version) {
  const text = changelogText.split(/\r?\n/).join('\n');
  const m = headingFor(version).exec(text);
  if (!m) return null;
  const start = m.index;
  // Search from start+1 so the section's OWN heading does not terminate it.
  const next = text.slice(start + 1).search(/^## \[/m);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

/**
 * The section's content lines — what the gate counts to refuse an empty release.
 *
 * Headings and blank lines are not content: a section holding nothing but `### Fixed` asserts that something
 * was fixed and names none of it, which is a stronger and falser statement than saying nothing at all.
 */
export function sectionContentLines(section) {
  return section.split('\n').slice(1).filter(l => l.trim() && !/^#{1,3} /.test(l.trim()));
}

/** The body for a release note: the section without its own `## [x.y.z] — date` heading line. */
export function releaseBody(section) {
  return section.split('\n').slice(1).join('\n').trim();
}

/**
 * GitHub's hard limit on a Release body. Documented, and enforced as a `422 Validation Failed`.
 *
 * Not a style choice and not ours to tune: the API refuses the call outright, after the images have already
 * been pushed. So the failure lands at the one step that runs LAST, with everything else published.
 */
export const RELEASE_BODY_MAX = 125_000;

/**
 * What we actually fill, with headroom under the hard limit.
 *
 * Filling to 124 871 of 125 000 left 129 characters of margin, and the two sides do not necessarily count
 * the same thing: this body is full of em-dashes and curly quotes, so its BYTE length is ~600 longer than
 * its character length. Being right about which one GitHub counts is not worth 129 characters, and the cost
 * of being wrong is the failure this whole function exists to remove — at the last step, after publishing.
 */
export const RELEASE_BODY_TARGET = 118_000;

/**
 * Whatever a release says before its first bullet — kept whole, whatever else is cut.
 *
 * Every major since 3.0 opens with a few paragraphs saying what the release IS, and it is the best summary
 * of it anybody writes. Splitting a body into entries throws it away, which the previous abridger did not
 * do only because its split happened to leave it stuck to the front of the first entry. Reading it out
 * deliberately means it survives on purpose rather than by accident.
 */
export function releasePreamble(body) {
  const lines = body.split('\n');
  const first = lines.findIndex(l => /^- /.test(l) || /^#{2,3} /.test(l.trim()));
  return (first < 0 ? body : lines.slice(0, first).join('\n')).trim();
}

/**
 * The section each top-level entry belongs to, so an abridger can rank them.
 *
 * Splitting on `\n- ` alone loses that: the `### Removed` heading ends up trailing the entry BEFORE the
 * section it introduces, which is fine for output and useless for classification. This walks the lines
 * instead and carries the current heading forward.
 *
 * @param {string} body
 * @returns {Array<{section: string|null, text: string}>}
 */
export function entriesWithSection(body) {
  const out = [];
  let section = null;
  let cur = null;
  const flush = () => { if (cur) { out.push({ section: cur.section, text: cur.lines.join('\n').trimEnd() }); cur = null; } };

  for (const line of body.split('\n')) {
    const heading = /^#{2,3} (.+)$/.exec(line.trim());
    if (heading) { flush(); section = heading[1].trim(); continue; }
    if (/^- /.test(line)) { flush(); cur = { section, lines: [line] }; continue; }
    if (cur) cur.lines.push(line);
  }
  flush();
  return out;
}

/**
 * Does this entry describe something that will break a caller who does not read it?
 *
 * TWO signals, both already in the text and neither a list anybody maintains:
 *
 * - **The word.** This changelog has marked breaking entries since 3.x, in two spellings — `**BREAKING:` at
 *   the front of an entry and `(breaking)` at the end of its first sentence. Matching the word covers both,
 *   and covers the third spelling somebody uses next year.
 * - **The `Removed` section.** A removal is breaking whether or not its author wrote the word, and this is
 *   the half that caught `M-2`: the link entries sit in `Added` and `Changed` and say `breaking` outright,
 *   while several genuine removals never use the word at all.
 *
 * Scoped to the entry's own text, so a section-wide preamble mentioning breaking changes does not promote
 * every entry under it.
 */
export function isBreaking(entry) {
  return entry.section === 'Removed' || /\bbreaking\b/i.test(entry.text);
}

/**
 * Fit a release body inside GitHub's limit, keeping what a reader cannot afford to miss.
 *
 * ## What this is for, measured twice
 *
 * `v4.0.0` was tagged, both registries took the image, and the Release step failed with
 * `422 body is too long (maximum is 125000 characters)` against **335 002 characters** of notes. That is
 * why an abridger exists at all.
 *
 * Then an operator read the abridged notes and missed the largest change in the release. The link system
 * changes how every caller writing `entityIds` behaves, and it sat past the fold — they found it because
 * their own owner asked *"what about the new link system"*, not because the release told them. **The
 * finding is the truncation, not the omission: a prefix is not a summary.** 81 entries of 227 were shown,
 * chosen by nothing but document order.
 *
 * ## So breaking entries are lifted, and the rest keeps its order
 *
 * Everything that breaks a caller goes first, under its own heading, whatever the length. What follows is
 * the same document-order prefix as before, of what is left. A reader who stops after the first screen has
 * then seen the entries they had to act on, which is the one property a prefix could never offer.
 *
 * **The lift only happens when the body does not fit.** A body under the limit is returned untouched — the
 * common case, every release before 4.0.0 — because reordering notes that fit would be a change to what
 * gets published for no reason at all.
 *
 * ## And a breaking entry is never DROPPED, only shortened — measured a third time, cutting 5.0.0
 *
 * Lifting them first is not enough on its own. 5.0.0 carries 20 breaking entries totalling 26 452
 * characters, so any budget under that dropped whole entries off the end of the lifted block — the same
 * failure as the original prefix, one level in, and with the reader's guard down because the notes now
 * promise the breaking ones come first. It did not reach a reader: at the real ceiling all 20 fit, and it
 * was the gate squeezing to 20 000 that showed it.
 *
 * **So the headlines are RESERVED before anything is spent.** Every breaking entry's first line — the bold
 * sentence that says what breaks — is charged to the budget up front; what is left then upgrades entries
 * to their full text in order. Below the reserve the old greedy behaviour returns, because at that point
 * nothing can be promised and pretending otherwise is worse than the truncation notice.
 *
 * The reason to prefer twenty headlines over fifteen full entries is not space, it is what a reader DOES
 * with them: a headline they can act on sends them to the full notes, and an entry that is not there at
 * all cannot.
 *
 * @param {string} body      the full release body
 * @param {string} version   the version, for the pointer at the end
 * @param {number} [limit]   the ceiling, overridable so a test can exercise this without a 335 KB fixture
 */
export function abridgeForRelease(body, version, limit = RELEASE_BODY_TARGET) {
  if (body.length <= limit) return body;

  const entries = entriesWithSection(body);
  const preamble = releasePreamble(body);
  const link = `https://github.com/ythril-network/Ythril/blob/v${version}/CHANGELOG.md`;
  const breaking = entries.filter(isBreaking);
  const rest = entries.filter(e => !isBreaking(e));

  // `shortened` is how many breaking entries appear as their headline alone. Disclosed rather than counted
  // as shown in full: "20 of 20 shown" over five one-line entries is the reassurance this abridger's own
  // history argues against.
  const head = (kept, shownBreaking, shortened) => `> **These notes are abridged** — ${kept} of `
    + `${entries.length} entries. `
    + (breaking.length
      ? `**${shownBreaking} of ${breaking.length} breaking ${breaking.length === 1 ? 'entry is' : 'entries are'} `
        + `shown first**, ahead of everything else. `
        + (shortened
          ? `${shortened} of them ${shortened === 1 ? 'is cut to its opening line'
       : 'are cut to their opening lines'} — the link below has the rest. `
          : '')
      : '')
    + `The full ${version} notes are in [CHANGELOG.md at this tag](${link}).\n\n`;
  const foot = (kept) => `\n\n---\n\n**End of the abridged notes** — ${kept} of ${entries.length} entries `
    + `shown. GitHub caps a release body at ${RELEASE_BODY_MAX.toLocaleString('en-US')} characters and the `
    + `full ${version} notes are ${body.length.toLocaleString('en-US')}. Read all of them in `
    + `[CHANGELOG.md at this tag](${link}).`;

  const BREAKING_HEADING = '## Breaking changes\n\n';
  const REST_HEADING = '\n\n## Everything else, in order\n\n';

  // Sized against the WORST case the notices can grow to, because their own numbers are part of their
  // length: sizing against the final count could push the body back over the limit it just fitted.
  let budget = limit
    - head(entries.length, breaking.length, breaking.length).length
    - foot(entries.length).length
    - (breaking.length ? BREAKING_HEADING.length + REST_HEADING.length : 0)
    - (preamble ? preamble.length + 2 : 0);

  const take = (list) => {
    const kept = [];
    for (const e of list) {
      if (budget - (e.text.length + 1) < 0) break;
      kept.push(e.text);
      budget -= e.text.length + 1;
    }
    return kept;
  };

  /**
   * Every breaking entry, shortened to its headline rather than dropped.
   *
   * Returns `null` when even the headlines do not fit, and the caller falls back to `take` — there is no
   * honest guarantee below that line, and a silently half-kept reserve would be the same defect again.
   */
  const takeBreakingWhole = (list) => {
    const headlines = list.map(e => e.text.split('\n')[0]);
    const reserve = headlines.reduce((n, h) => n + h.length + 1, 0);
    if (reserve > budget) return null;

    const kept = [...headlines];
    let spare = budget - reserve;
    for (const [i, e] of list.entries()) {
      const extra = e.text.length - headlines[i].length;
      if (extra === 0 || extra > spare) continue;
      kept[i] = e.text;
      spare -= extra;
    }
    budget = spare;
    return kept;
  };

  const keptBreaking = takeBreakingWhole(breaking) ?? take(breaking);
  const keptRest = take(rest);
  const kept = keptBreaking.length + keptRest.length;

  // A single entry longer than the whole budget would leave nothing. Better an honest pointer than a
  // mid-sentence cut — but say so, rather than returning a body that reads as though nothing changed.
  if (kept === 0) return `**These notes are too long to show here.** Read them in [CHANGELOG.md at this tag](${link}).`;

  const parts = keptBreaking.length
    ? BREAKING_HEADING + keptBreaking.join('\n') + (keptRest.length ? REST_HEADING + keptRest.join('\n') : '')
    : keptRest.join('\n');

  const shortened = keptBreaking.filter((text, i) => text !== breaking[i]?.text).length;
  return head(kept, keptBreaking.length, shortened) + (preamble ? preamble + '\n\n' : '') + parts
    + foot(kept);
}
