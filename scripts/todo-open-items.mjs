/**
 * What counts as an open item in a `todo/` tracker — one answer, for every rule that needs one.
 *
 * ## Why this is its own module
 *
 * `todo-consistency.mjs` asked the question twice, six lines apart, and the two answers disagreed. Rule 2 ("the
 * ordered list indexes every item") learned about heading-style items on 2026-08-30; rule 3 ("every open item
 * says how to verify it is still open") kept its checkbox-only parser, so it went on reporting green while
 * covering **one item out of eleven**. The ten it could not see are where six of the eight stale rows found that
 * same day were sitting.
 *
 * That is this repo's signature defect — one rule, two implementations, the weaker winning silently — inside the
 * script whose job is to catch bookkeeping drift. The rule the codebase already carries applies here: when you
 * find yourself writing the same rule a second time, extract it instead.
 *
 * ## The two shapes, and why both are legitimate
 *
 * Trackers are written by hand and two styles are in use. Neither is wrong; they suit different densities:
 *
 *   - **checkbox** — `- [ ] **R-4 — seven model-call budgets are hardcoded.**`, body indented beneath.
 *     Used where items are short and the file is a list.
 *   - **heading** — `### L-5 — an edge id is still random`, body until the next heading. Used where each item
 *     carries paragraphs, tables and a design discussion, which is most of the schema work.
 *
 * A rule that understands one and not the other does not enforce a weaker version of itself. It exempts whole
 * files, silently, based on a formatting choice nobody made for that reason.
 */

/**
 * What an item id looks like — ONE definition, because EIGHT places needed the same answer.
 *
 * `R-4`, `S-L5-1`, `P-28` … and a numbered SUB-id, `G-3.1`, for a step of a decomposition its parent row
 * tracks as a whole. The owner asked for those steps to appear in the queue so progress and remaining length
 * are visible, and the three patterns below could not see one — each in its own way, and all three silently:
 *
 *   - the index row matched NOTHING, so the rule that checks a queue row against its home skipped it;
 *   - a tracker item matched the PARENT, so `G-3.1` read as `G-3` and that same rule ticked the row because
 *     the parent was declared. A step nobody had checked existed then counted as checked.
 *
 * Written out repeatedly, that is this repo's signature defect inside the script whose job is to catch it —
 * and the first attempt at this fix found three copies here and left FIVE in `todo-consistency.mjs`, in the
 * module that imports this one. Two of those mattered:
 *
 *   - **rule 2 re-implemented `openItems`** with its own two patterns, so it saw neither a dotted sub-id nor
 *     an item marked `[~]` in progress. Its copy also accepted a sub-id as indexed whenever the PARENT's id
 *     appeared in the queue, which is a false green on the rule that decides whether the queue is complete.
 *   - **a plan row** read `G-3.2` as `G-3` and then refused the job, because the queue held the sub-rows
 *     and not the parent. Loud rather than silent, which is the only reason it was found.
 *
 * The trailing dot of the older `- [ ] **A-1.**` shape is punctuation rather than a sub-number, and the two
 * are told apart by what follows: a digit continues the id, anything else ends it.
 */
const ID = String.raw`[A-Z]+-[A-Z0-9-]+(?:\.\d+)*`;

/** The first item id in a line of prose, or `null`. */
export function itemIdIn(text) {
  return new RegExp(String.raw`\b(${ID})\b`).exec(text)?.[1] ?? null;
}

/**
 * EVERY item id in a block of prose, deduplicated and in first-seen order.
 *
 * Read with the same grammar as `itemIdIn` rather than a second pattern, because a checker that recognises
 * a `G-3.1` in one rule and not in another is the shape this script was found to be full of on 2026-08-30.
 *
 * **It over-matches on purpose and the caller must be safe under that.** `UTF-8`, `ISO-8601` and anything
 * else shaped like LETTERS-ALNUM comes back as an "id". A caller asking *"is any of these still open?"* is
 * unharmed — a false id is simply not in the queue. A caller asking *"is any of these closed?"* would be
 * wrong on every one of them, so do not write that caller.
 */
export function itemIdsIn(text) {
  const re = new RegExp(String.raw`\b(${ID})\b`, 'g');
  return [...new Set([...text.matchAll(re)].map(m => m[1]))];
}

/**
 * Does `ordered` name this id — as a WHOLE TOKEN, not as a substring?
 *
 * `ordered.includes(id)` reported `L-1` as indexed because the string appears inside `L-13`, so deleting
 * L-1's row left the gate green: a check passing by matching something adjacent to its subject. With ten ids
 * in a series every single-digit one was covered by its own longer siblings.
 *
 * **The id is ESCAPED before it becomes a pattern**, which sub-ids made load-bearing. Interpolated raw,
 * `G-3.1` is a pattern whose dot matches any character — so a queue holding `G-3x1` would satisfy an item
 * declared as `G-3.1`. Unlikely to happen by accident and free to rule out.
 *
 * A sub-id is NOT satisfied by its parent. `G-3.1` needs `G-3.1` in the queue; `G-3` alone is the parent
 * row, and treating it as cover is exactly the false green this rule exists to prevent.
 */
export function isNamedIn(id, ordered) {
  const lit = id.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`(^|[^A-Z0-9-])${lit}([^A-Z0-9-]|$)`, 'm').test(ordered);
}

/**
 * The `| id | task | home.md | …` rows of `_TODO-ORDERED.md` — what the index CLAIMS exists, and where.
 *
 * Separate from `openItems` because it answers the opposite question. `openItems` reads a tracker and says what
 * is really there; this reads the index and says what it promises. Rule 2 compares them one way and rule 2b the
 * other, and until 2026-08-30 only one direction was ever checked — so `W-3` sat in the queue for weeks naming a
 * home file that had never declared it.
 *
 * @param {string} ordered  the full text of `_TODO-ORDERED.md`
 * @returns {Array<{id: string, home: string}>}
 */
export function orderedHomeRows(ordered) {
  const HOME_ROW = new RegExp(String.raw`^\|\s*(${ID})\s*\|[^|]*\|\s*([A-Za-z0-9._-]+\.md)\s*\|`, 'gm');
  return [...ordered.matchAll(HOME_ROW)].map(m => ({ id: m[1], home: m[2] }));
}

/** A `### L-5 — …` or `## R-3: …` item heading, capturing the id. Levels 2-4; level 1 is the document title. */
const HEADING_ITEM = new RegExp(String.raw`^#{2,4}[ \t]+\**(${ID})\**[ \t]*[—:-]`);

/**
 * A `- [ ] **W-2 — …` item, capturing the id when it has one.
 *
 * **`[~]` counts too, and leaving it out was a real blind spot.** Every tracker's legend reads
 * `[ ] open · [~] in progress`, so marking a row in-progress — the honest thing to do while its PR is in
 * flight — removed it from this parser's view entirely. "Every open item is indexed" then passed over a row
 * nobody could see, and the ordered queue could name a home the gate no longer found the item in. Found the
 * first time a row was actually marked `[~]`.
 *
 * `[x]` is deliberately NOT here: a ticked box is finished work, and finished work belongs in the CHANGELOG.
 */
const CHECKBOX_ITEM = new RegExp(String.raw`^[ \t]*[-*][ \t]*\[[ ~]\][ \t]*\**(${ID})?\**\.?`);

/** Any open-or-in-progress checkbox, id or not — the split point for checkbox-style bodies. */
const CHECKBOX_ANY = /^[ \t]*[-*][ \t]*\[[ ~]\]/;

/**
 * Every open item in one tracker's source, in file order, each with the body that belongs to it.
 *
 * The body is what a rule reads to answer "does this item carry X?", so getting its END right is the half that
 * decides whether a check is about the item or about its neighbour. A checkbox item ends at the next top-level
 * checkbox; a heading item ends at the next heading of any level 2-4. Both stop at a `---` rule, which the
 * trackers use to close a section.
 *
 * @param {string} src  the tracker's full text
 * @returns {Array<{id: string|null, title: string, body: string, line: number, style: 'checkbox'|'heading'}>}
 */
export function openItems(src) {
  const lines = src.split(/\r?\n/);
  const starts = [];

  for (let i = 0; i < lines.length; i++) {
    const h = HEADING_ITEM.exec(lines[i]);
    if (h) { starts.push({ i, id: h[1], style: 'heading' }); continue; }
    const c = CHECKBOX_ITEM.exec(lines[i]);
    if (c && CHECKBOX_ANY.test(lines[i])) starts.push({ i, id: c[1] ?? null, style: 'checkbox' });
  }

  return starts.map((s, n) => {
    // The body runs to whichever comes first: the next item of EITHER style, a `---` rule, or end of file.
    // "Either style" matters — a file may open with checkboxes and continue with headings, and an item whose
    // body swallowed the next item would let one verify line satisfy two rows.
    let end = starts[n + 1]?.i ?? lines.length;
    for (let i = s.i + 1; i < end; i++) {
      if (/^#{2,4}[ \t]/.test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; }
    }
    const raw = lines[s.i];
    /*
     * A checkbox wraps its whole title in bold — `- [ ] **R-4 — seven budgets are hardcoded.**` — so the bold
     * run IS the title. A heading does not, and several end with a bold status flag (`… → **P-23 = B**`), so
     * preferring bold there returns the flag and calls it the title. Take the line for a heading.
     */
    const title = (s.style === 'checkbox' ? raw.match(/\*\*(.+?)\*\*/)?.[1] ?? raw : raw)
      .replace(/^#{2,4}[ \t]+/, '')
      .replace(/^[ \t]*[-*][ \t]*\[ \][ \t]*/, '')
      .replace(/[`*[\]]/g, '')
      .trim();
    return { id: s.id, title, body: lines.slice(s.i, end).join('\n'), line: s.i + 1, style: s.style };
  });
}

const NUMBER_WORDS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
]);

/**
 * The count a sentence claims a checklist page has, or `null` where it claims none.
 *
 * An exemption's reason is prose and *"is this still true?"* has no `grep -c`. A COUNT inside it does: when a
 * reason says how many steps or boxes a page has, that is a statement about the page, and the page can be
 * counted. Narrow on purpose — the number must sit immediately before the structural noun, so `see rule 5`
 * and `2 of the 3 dissolved` are not counts of anything.
 */
export function statedStructureCount(reason) {
  const m = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+(?:steps?|boxes|rows?)\b/i
    .exec(reason);
  if (!m) return null;
  const word = m[1].toLowerCase();
  return NUMBER_WORDS.get(word) ?? Number(word);
}

/**
 * How many numbered checklist boxes a page actually has.
 *
 * Numbered specifically. `_REFERENCE.md` is thousands of lines of `- ` bullets, and counting those would give
 * every exempt page a box count and manufacture a contradiction on all of them.
 */
export function checklistBoxCount(text) {
  return (text.match(/^- \[[x ]\] \*\*\d/gm) ?? []).length;
}
