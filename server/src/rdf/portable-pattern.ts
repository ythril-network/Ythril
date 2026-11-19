/**
 * Does a stored pattern mean the same as a SHACL `sh:pattern`? (Q-751, bundle-269 slice S; standards review row 7.)
 *
 * ## What it prevents
 *
 * The server checks a property's `pattern` and a type's `namingPattern` as an ECMAScript regular expression, unanchored and with no flags
 * (`spaces/schema-validation.ts`). `sh:pattern` is SPARQL `REGEX`, which is XPath's `fn:matches` (XQuery 1.0 and XPath 2.0 Functions and
 * Operators §7.6, on XML Schema's regular expressions): also unanchored, with `^` and `$` at the ends of the string, but a different dialect.
 * Written as-is, `\d` matches every Unicode digit there and only `0-9` here, `\w` and `\s` differ, `\b`, lookaround, `(?:...)`, named groups
 * and back-references do not exist there, `[a-z-[aeiou]]` subtracts there and is a literal here, and a brace or bracket ECMAScript reads as a
 * literal is an error there. A shape built from such a pattern refuses records the server accepted. So the schema export asks
 * {@link patternReadsAlike} and writes `sh:pattern` only for a pattern in the subset both read alike; the pattern's own text travels anyway.
 *
 * ## The subset
 *
 * Literal characters of the Basic Multilingual Plane (no surrogate: ECMAScript without the `u` flag quantifies half a pair); `.`, `^`, `$`;
 * `|`; plain groups `( )`; the quantifiers `* + ?` and `{n}`, `{n,}`, `{n,m}`, each optionally lazy; the escapes both grammars share
 * (`\n \r \t` and `\` before one of `\ | . ? * + ( ) { } - [ ] ^ $`); classes `[...]` and `[^...]` of such characters and escapes, with `a-z`
 * ranges, a literal `-` only first or last, and no `[` inside. `.` differs only on U+2028 and U+2029, which ECMAScript's `.` does not match
 * and XPath's does: accepted, as a pattern meant to match them would spell them out.
 *
 * `$` stays in the subset (bundle-269 review, suspicion d). SPARQL 1.1 §17.4.3.14 defines `REGEX` as `fn:matches`, and XPath and XQuery
 * Functions and Operators 3.1 §5.6.1 says that without the `m` flag `$` matches at the end of the entire string only, as ECMAScript's `$`
 * does without its own `m` flag. So `^a$` refuses `"a\n"` in both. A processor built on `java.util.regex` (Jena) lets `$` match before a final
 * line break as well. That is a departure from the SPARQL definition the shape cites, and an export cannot correct it.
 *
 * Pure.
 */

/** The characters `\` may escape in both dialects (XML Schema `SingleCharEsc` plus XPath's `\$`), and the three control escapes. */
const SHARED_ESCAPES = new Set([...'\\|.?*+(){}-[]^$', 'n', 'r', 't']);
/** An escape is a backslash and the one character it escapes. */
const ESCAPE_LENGTH = 2;
/** A counted quantifier: `{min}`, `{min,}` or `{min,max}`. */
const COUNTED = /^\{(?<min>\d+)(?:,(?<max>\d*))?\}/;

/** One character of a class at `j`, or -1 when it is no character both dialects read alike; the index after it otherwise. */
function classChar(p: string, j: number): number {
  const c = p[j];
  if (c === undefined || c === '[' || c === ']') return -1;
  if (c === '\\') return SHARED_ESCAPES.has(p[j + 1] ?? '') ? j + ESCAPE_LENGTH : -1;
  return j + 1;
}

/** The index after the class starting at `i` (`[`), or -1 when the class is outside the subset. */
function classEnd(p: string, i: number): number {
  let j = i + 1;
  if (p[j] === '^') j++;
  if (p[j] === ']') return -1; // `[]` and `[^]`: an error in XPath, nothing or everything in ECMAScript
  const first = j;
  while (p[j] !== ']') {
    if (j >= p.length) return -1;
    if (p[j] === '-') {
      if (j !== first && p[j + 1] !== ']') return -1; // a dash not at an end: a range of a range, or XPath's subtraction
      j++;
      continue;
    }
    j = classChar(p, j);
    if (j < 0) return -1;
    if (p[j] === '-' && p[j + 1] !== ']') {
      j = p[j + 1] === '-' ? -1 : classChar(p, j + 1);
      if (j < 0) return -1;
    }
  }
  return j + 1;
}

/**
 * Is `pattern`, an ECMAScript regular expression the server applies with no flags, read alike by SPARQL `REGEX` (the dialect of
 * `sh:pattern`)? False for anything outside the subset in this module's docblock, and for a pattern ECMAScript itself refuses.
 */
export function patternReadsAlike(pattern: string): boolean {
  try { new RegExp(pattern); } catch { return false; }
  if (/[\uD800-\uDFFF]/.test(pattern)) return false;
  let canQuantify = false;
  let afterQuantifier = false;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*' || c === '+' || c === '?' || c === '{') {
      if (c === '?' && afterQuantifier) { afterQuantifier = false; i++; continue; } // lazy, read alike
      const counted = c === '{' ? COUNTED.exec(pattern.slice(i)) : null;
      if (!canQuantify || (c === '{' && counted === null)) return false;
      const max = counted?.groups?.['max'];
      if (max !== undefined && max !== '' && Number(max) < Number(counted?.groups?.['min'])) return false;
      i += counted === null ? 1 : counted[0].length;
      canQuantify = false;
      afterQuantifier = true;
      continue;
    }
    afterQuantifier = false;
    if (c === '\\') {
      if (!SHARED_ESCAPES.has(pattern[i + 1] ?? '')) return false;
      i += ESCAPE_LENGTH; canQuantify = true; continue;
    }
    if (c === '[') {
      const end = classEnd(pattern, i);
      if (end < 0) return false;
      i = end; canQuantify = true; continue;
    }
    if (c === '(') {
      if (pattern[i + 1] === '?') return false; // lookaround, named and non-capturing groups
      i++; canQuantify = false; continue;
    }
    if (c === ']' || c === '}') return false;
    canQuantify = !(c === '|' || c === '^' || c === '$');
    i++;
  }
  return true;
}
