/**
 * Markdown normaliser.
 *
 * Rules applied in order:
 *  1. Strip lines matching /^-{0,3}Page \d+.*$/i  (page-number noise)
 *  2. Collapse 3+ consecutive blank lines to exactly 1
 *  3. Shift all headings so the highest level present becomes H2
 *     (H1 is reserved for the document title; embedding model benefits from
 *      consistent heading depth).
 */

const PAGE_LINE_RE = /^-{0,3}Page\s+\d+.*$/i;

/** Normalise a Markdown string for embedding. Returns the normalised string. */
export function normaliseMarkdown(md: string): string {
  const lines = md.split('\n');

  // Pass 1: strip page-number lines
  const stripped = lines.filter(l => !PAGE_LINE_RE.test(l.trimEnd()));

  // Pass 2: collapse 3+ blank lines → 1
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of stripped) {
    if (line.trim() === '') {
      blankRun++;
      if (blankRun <= 2) collapsed.push(line); // allow up to 1 blank (two adjacents = double \n)
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }

  // Pass 3: heading shift — find the minimum heading level present, shift so it becomes H2
  const headingLevels: number[] = [];
  for (const l of collapsed) {
    const m = l.match(/^(#{1,6})\s/);
    if (m) headingLevels.push(m[1].length);
  }

  if (headingLevels.length === 0) return collapsed.join('\n');

  const minLevel = Math.min(...headingLevels);
  // We want minLevel → 2, so shift = 2 - minLevel (can be negative: shift up)
  const shift = 2 - minLevel;
  if (shift === 0) return collapsed.join('\n');

  const shifted = collapsed.map(l => {
    const m = l.match(/^(#{1,6})(\s.*|$)/);
    if (!m) return l;
    const newLevel = Math.max(1, Math.min(6, m[1].length + shift));
    return '#'.repeat(newLevel) + m[2];
  });

  return shifted.join('\n');
}
