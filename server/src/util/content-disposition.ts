/**
 * The `Content-Disposition` header a download is served with, for a file of ANY name.
 *
 * ## What it prevents
 *
 * A header value may hold only Latin-1, and Node refuses one that does not. The download route wrote the name straight
 * into `filename="…"`, so every file whose name has a character above U+00FF — `日本.txt`, an emoji, an accent a macOS
 * client sends decomposed — answered `500 Failed to read file` with its bytes on disk (bundle-71 verify drive).
 *
 * So the header carries two names (RFC 6266 §4.3): `filename*`, the real name as UTF-8 percent-encoded (RFC 5987), which
 * every current browser reads first; and `filename`, an ASCII stand-in for a client that knows only the old form. A
 * quote, backslash or line break never reaches either: in the quoted one it is replaced, in the encoded one it is
 * percent-encoded, so a name cannot end the parameter or start a header.
 */
export function contentDispositionOf(disposition: 'attachment' | 'inline', name: string): string {
  const fallback = name.normalize('NFC').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/** RFC 5987 `value-chars`: UTF-8 percent-encoding, which `encodeURIComponent` does except for the five it leaves bare. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
