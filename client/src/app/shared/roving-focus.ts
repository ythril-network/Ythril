/**
 * Where a roving-tabindex group moves on a key: the one rule of a strip of tabs and of a listbox, so the two never disagree on what
 * Home, End and the arrows do.
 *
 * The arrows of the group's axis step (Right/Left across, Down/Up down a list), Home and End go to the ends. A strip wraps at its
 * ends; a listbox stays (WAI-ARIA's listbox does not wrap). Any other key is not a move, answered as -1, so the caller leaves the
 * event alone rather than swallowing a key it does not handle.
 *
 * First written inline in the schema tab's collection strip; the type history's listbox (Q-744) is the second site.
 */
export function rovingIndex(key: string, at: number, count: number, opts: { axis: 'horizontal' | 'vertical'; wrap: boolean }): number {
  if (count <= 0 || at < 0) return -1;
  const last = count - 1;
  const next = opts.axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const prev = opts.axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  if (key === next) return at === last ? (opts.wrap ? 0 : last) : at + 1;
  if (key === prev) return at === 0 ? (opts.wrap ? last : 0) : at - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return -1;
}
