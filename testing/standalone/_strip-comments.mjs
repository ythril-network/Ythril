/**
 * Remove comments from source before a gate reads it — LINE comments first.
 *
 * ## Why the order is the whole point
 *
 * `server/src/api/data.ts:281` reads:
 *
 *     // Follow the symlink — useful for /mnt/* or volume-mount points
 *
 * A stripper that removes block comments FIRST sees that `/*` as an opener and deletes everything through the
 * next `*​/` — **5,907 characters**, taking `PUT /backup-config`, `POST /restore` and `POST /migrate` with it.
 * Removing line comments first makes the phantom opener disappear along with its line.
 *
 * That is not hypothetical. It made the capability matrix report 202 routes when the routers serve 208, and
 * before that it kept three mutating `/api/files` routes invisible to `every-space-route-has-an-area` — so they
 * carried no rights row for as long as nothing could see them.
 *
 * ## Two variants, because gates want different things
 *
 * `stripComments` also removes TRAILING comments (`const x = 1; // note`), guarding `://` so a URL survives.
 * `stripFullLineComments` removes only comment-only lines, which is what a gate wants when it asserts on code
 * that carries explanatory trailing comments.
 *
 * Both put line comments first. `comment-strippers-are-ordered.test.js` fails on the other order anywhere in the
 * suite; the 57 files that still carry their own copy are correct today and tracked for migration as `Q-1`.
 */

/** Comments out, including trailing ones. `://` is preserved so URLs are not truncated. */
export function stripComments(src) {
  return src
    .replace(/(^|[^:])\/\/.*/gm, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Comment-only lines out; a trailing comment on a line of code is left alone. */
export function stripFullLineComments(src) {
  return src
    .replace(/^[ \t]*\/\/.*/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Comments out, LINE NUMBERS kept — every comment character becomes a space, every newline stays.
 *
 * ## Why this exists beside `stripComments`
 *
 * `stripComments` deletes the comment text, so a gate that reports where it found something reports a line
 * number from a shorter file. Measured: a mention on line 44 of `mcp/tools/chrono.ts` was reported as line
 * 34, and ten lines is far enough that the reader looks at an unrelated sentence, concludes the gate is
 * wrong, and goes looking for the bug in the gate.
 *
 * So a gate that only ASKS a question can use `stripComments`; a gate that TELLS you where has to use this.
 * That is the whole difference between them, and it is the reason both exist.
 */
export function blankComments(src) {
  const blank = ch => (ch === '\n' ? '\n' : ' ');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') out += blank(src[i++]);
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) out += blank(src[i++]);
      continue;
    }
    const q = src[i];
    if (q === '"' || q === "'" || q === '`') {
      // Strings are COPIED, not blanked — they are the thing a caller reads, and a `//` inside one
      // (`https://…`) is not a comment. Skipping them is also what stops a quote inside a comment from
      // swallowing the rest of the file.
      out += src[i++];
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += src[i++];
  }
  return out;
}
