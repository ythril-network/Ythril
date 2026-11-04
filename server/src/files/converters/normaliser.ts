/**
 * Markdown normaliser.
 *
 * Rules applied in order:
 *  0. **Normalise line endings to `\n`** (CRLF / lone CR → LF)
 *  1. Strip lines matching /^-{0,3}Page \d+.*$/i  (page-number noise)
 *  2. Collapse 3+ consecutive blank lines to exactly 1
 *  3. Shift all headings so the highest level present becomes H2
 *     (H1 is reserved for the document title; embedding model benefits from
 *      consistent heading depth).
 *
 * ## Rule 0 is not cosmetic — it decided whether a document was retrievable at all
 *
 * Everything downstream splits on `\n` and then anchors line-based patterns with `$`. In JavaScript, `$`
 * (without `m`) matches at the end of the string or before a *final* `\n` — never before a `\r` — and `.` does
 * not match `\r` either, because `\r` is a line terminator. So on a CRLF document every line arrived as
 * `"## Heading\r"` and **`/^#{2,3}\s+(.+)$/` did not match**.
 *
 * Consequence, measured on this repo's own docs: `sectionChunk` found zero headings and returned the **entire
 * document as one chunk**. A 58,737-byte API guide became a single ~14,700-token embed — which is
 * `14,700² × 4 bytes × 12 heads ≈ 9.6 GiB` of fp32 attention scores for one layer. A customer's pod went
 * 3.98 → 9.996 GiB inside one 15-second scrape window, was OOMKilled at a 16 GiB limit, and then sat at
 * 15.40 GiB at idle because the ONNX arena keeps its high-water mark. The same file was also unretrievable on
 * any specific term, because one averaged vector is not about anything.
 *
 * A Windows checkout, a Windows-authored file, or any tool that writes CRLF was enough to trigger it. Rule 0
 * is the one-line half of that fix; the other halves are `maxBodyLength` in `section-chunker.ts`, the ceiling's bounding pass
 * (`bound-chunks.ts`, which holds what an HTTP embedder is sent) and `truncation` in the local inference (`brain/embed-process.ts`).
 */

const PAGE_LINE_RE = /^-{0,3}Page\s+\d+.*$/i;

/** Normalise a Markdown string for embedding. Returns the normalised string. */
export function normaliseMarkdown(md: string): string {
  // Pass 0: line endings. Must come first — every rule below is line-based, and a trailing `\r` defeats the
  // `$`-anchored patterns silently rather than loudly.
  const lines = md.replace(/\r\n?/g, '\n').split('\n');

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
