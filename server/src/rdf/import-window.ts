/**
 * The groups an RDF import holds at once: a window of the sorted file's groups, ended by a share of the import's room (bundle-384, Q-983, fix round,
 * finding 1; vet amendment G2).
 *
 * ## What it prevents
 *
 * Both passes of the act read the sorted file in windows and hold a whole window while they translate it. A window of 500 groups, whatever they
 * weigh, is up to 500 times the largest group the sort allows (`RDF_IMPORT_MAX_SUBJECT_QUADS` quads, `RDF_IMPORT_MAX_SUBJECT_CHARS` characters): gigabytes held with no meter and no cap, by a file
 * of a few large subjects. A window now ends when the next group would take it past {@link windowBudgetOf} (the room divided by
 * {@link WINDOW_DIVISOR}), and still at `size` groups.
 *
 * ## What it says of a group that is alone over the share
 *
 * A group is held whole, so one that alone passes the share is a window of its own: never an empty window, never a group split. How much one group can
 * take is bounded by the sort's own per-subject bounds (`RDF_IMPORT_MAX_SUBJECT_QUADS`, `RDF_IMPORT_MAX_SUBJECT_CHARS`), a figure that does not grow
 * with the file, and the room's share (`import-memory.ts`) leaves the heap for one such group beside the share.
 *
 * ## What a group is charged
 *
 * {@link groupBytes}: {@link GROUP_QUAD_BYTES} a quad and {@link GROUP_CHAR_BYTES} a character of every string it carries, measured on groups as the
 * spool hands them back (`the-import-group-window-ends-at-its-share-of-room.test.js` pins the heap of a window at most that and at least 0.4 of it,
 * for one-byte and two-byte text).
 */
import { termChars, type QuadGroup } from './import-spool.js';

/** The room is divided by this to give a window its share: with the index, the sets and a window, one import's room is not spent by the window alone. */
export const WINDOW_DIVISOR = 16;
/**
 * The heap bytes of the objects of one quad of a group (the quad, its terms, their string headers), before its characters. Measured 240 to 270 for
 * short text and 454 for 4 000-character literals, at one byte a character; charged a little above the middle of that.
 */
export const GROUP_QUAD_BYTES = 320;
/** The heap bytes of one character of a string: two, since a character above U+00FF makes V8 hold the whole string as two-byte text. */
export const GROUP_CHAR_BYTES = 2;

/** What a window of groups may take of an import's `room`, in {@link groupBytes}. */
export const windowBudgetOf = (room: number): number => Math.floor(room / WINDOW_DIVISOR);

/** What a group is charged: its quads and the characters of every string they carry. */
export function groupBytes(group: QuadGroup): number {
  let chars = 0;
  for (const q of group.quads) chars += termChars(q.subject) + termChars(q.predicate) + termChars(q.object) + termChars(q.graph);
  return group.quads.length * GROUP_QUAD_BYTES + chars * GROUP_CHAR_BYTES;
}

/** The groups in windows of at most `size` groups and `budgetBytes` of {@link groupBytes}, in order; a group over the budget alone is a window of its own. */
export async function* windowsOf(groups: AsyncIterable<QuadGroup>, size: number, budgetBytes: number): AsyncGenerator<QuadGroup[], void, undefined> {
  let window: QuadGroup[] = [];
  let bytes = 0;
  for await (const group of groups) {
    const cost = groupBytes(group);
    if (window.length > 0 && (window.length >= size || bytes + cost > budgetBytes)) { yield window; window = []; bytes = 0; }
    window.push(group);
    bytes += cost;
  }
  if (window.length > 0) yield window;
}
