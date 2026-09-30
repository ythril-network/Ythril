/**
 * A client source with its comments removed — line, block and HTML (`<!-- -->` in an inline template).
 *
 * A gate that reads source must not read its subject's explanation: on the raw text it fires on the comment that
 * describes the fix, or passes because of it, which punishes writing the reasoning down. Written by hand in two
 * gates before it was written once; the third gate (`one-date-formatter.spec.ts`) is why it is a module.
 *
 * A `//` preceded by `:` is kept, so a URL in a string (`https://…`) survives. Stripped text is replaced by spaces,
 * never by nothing, so two tokens either side of a comment cannot fuse into one that a pattern then matches — and
 * every NEWLINE inside a comment is kept, so a line number computed on the stripped text is the line in the file.
 * (The first version replaced a whole block comment with one space, and the gate reported line 35 for line 79.)
 */
export function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, pre: string) => `${pre} `);
}
