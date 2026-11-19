/**
 * The `Content-Disposition` of an export's answer (standards review row 17): the one file-name rule every export of the `export_*` family
 * uses (owner, 2026-11-19), whatever its format.
 *
 * ## What it prevents
 *
 * A file name taken from a space or view id (or any name) breaks the header or the reader's disk when it holds a quote, a slash, a backslash,
 * a control character or a letter outside ASCII. {@link exportContentDisposition} quotes only safe ASCII (every other character `_`, leading
 * dots dropped, `export` when nothing is left) and carries the name's letters in an RFC 8187 `filename*`, with every character a path or a
 * header could misread replaced by `_`. Pure.
 */

/** The longest stem a file name keeps, in characters: a longer name is cut, never refused. */
const FILE_STEM_MAX = 120;

/** `attachment; filename="<safe>.<extension>"; filename*=UTF-8''<letters kept>` for `name` plus `suffix`. */
export function exportContentDisposition(name: string, extension: string, suffix = ''): string {
  const clean = [...`${name}${suffix}`].map(c => (/[\p{L}\p{N}._-]/u.test(c) ? c : '_')).join('').replace(/^[._]+/, '').slice(0, FILE_STEM_MAX);
  const ascii = clean.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '') || 'export';
  const star = encodeURIComponent(`${clean || 'export'}.${extension}`).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}.${extension}"; filename*=UTF-8''${star}`;
}
