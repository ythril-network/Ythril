/**
 * May the session token be sent to `url`? Only when the URL stays on this page's origin.
 *
 * ## Why this is a module
 *
 * Two places attach the session bearer by hand: the HttpClient interceptor and the shared download
 * (`authenticated-download.ts`, for bytes a browser-native element cannot fetch with a header). Each had its
 * own spelling of "same origin", and the interceptor's was the weaker of the two:
 *
 * - `url.startsWith('/')` is also true of a PROTOCOL-RELATIVE URL, `//other.example/x`, which leaves the origin;
 * - `url.startsWith(location.origin)` is also true of `https://ythril.example.com.evil.net/`, because the
 *   origin was compared without the `/` that ends it.
 *
 * Both sent the token to another host. The rule is written once, so the two cannot drift again.
 *
 * ## The rule
 *
 * A relative URL resolves against the page, so it stays. An absolute one (a scheme, or `//`) stays only when
 * it begins with this origin followed by `/`. Anything else keeps the token.
 */
export function tokenMayReach(url: string): boolean {
  const u = String(url);
  // Browsers read a backslash as a slash here, so `/\evil.example` and `\\evil.example` leave the origin too;
  // leading whitespace is stripped by URL parsing, so it is stripped before the test.
  const absolute = /^([a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(u.trimStart());
  return !absolute || u.startsWith(`${location.origin}/`);
}
