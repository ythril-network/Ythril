/**
 * Which names did the caller list?
 *
 * A filter that takes "one name or several" arrives in three spellings: one text (`reason=a`), a text with commas (`reason=a,b`), and an array
 * (`reason=a&reason=b` on the route, an array argument on a tool). Every caller needs the same answer to the same question, so it is asked here
 * and nowhere else: the unconverted list's and bulk dismissal's `reason` (`spaces/unconverted-terms.ts`) and the schema versions' `fps`
 * (`spaces/schema-versions-acts.ts`).
 *
 * ## What it prevents
 *
 * Two copies of the split, each keeping a different half of the rules: one trimmed a piece and the other did not, one read every piece of an
 * unbounded list and the other stopped at its bound, and one let a number through as a "list" of one. A caller that wrote the split again would have
 * dropped whichever half it did not see. The forgettable parts are inside, so no caller can leave them out:
 *
 *  - **Trimmed, blanks dropped.** `' a , ,b '` is `a`, `b`. A blank text is a list with no name in it; whether that means "no filter" or "nothing
 *    named" is the caller's question.
 *  - **Bounded.** At most `max + 1` names come back and the rest of the input is never split (a text is scanned piece by piece and the scan ends at
 *    the bound), with `over` saying the caller named more than `max`. The one extra name is what lets a caller's own length check fail with its own words.
 *  - **Garbage is refused, never emptied.** A value that is neither a text nor an array of only texts is `not_text`: an empty list would read as "no
 *    filter" and answer everything. The caller refuses it in its own words, naming the value.
 *
 * Order and repeats are kept; a caller that wants each name once says so itself. Whether each name is a known one is not asked here.
 */

/** The names listed, or the refusal of what could not be read as a list of names. */
export type ListedNames =
  | { kind: 'names'; names: string[]; over: boolean }
  | { kind: 'not_text' };

/**
 * The names `value` lists, split at commas, trimmed, blanks dropped, at most `max + 1` of them (`over` when there were more than `max`).
 * `value` is a text, or an array of texts; anything else, an array holding a non-text, and an absent value are `not_text`.
 */
export function listedNames(value: unknown, max: number): ListedNames {
  const texts = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (texts === null || !texts.every(t => typeof t === 'string')) return { kind: 'not_text' };
  const names: string[] = [];
  for (const text of texts as string[]) {
    let from = 0;
    while (from <= text.length) {
      const comma = text.indexOf(',', from);
      const end = comma === -1 ? text.length : comma;
      const piece = text.slice(from, end).trim();
      if (piece !== '') {
        names.push(piece);
        if (names.length > max) return { kind: 'names', names, over: true };
      }
      from = end + 1;
    }
  }
  return { kind: 'names', names, over: false };
}
