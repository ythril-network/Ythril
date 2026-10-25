/**
 * Is this a URL only this machine or its own network can reach — so that peers on the internet could not use it to reach this instance?
 *
 * The one question the networks page asks of this brain's address before it offers the enable-networks wizard: a network announced at `localhost`, a
 * loopback or private address, or a link-local one, cannot be joined from outside. An address that does not parse is answered `true`: with no
 * address to reach, no peer can reach it, which is the safe answer to give an operator who is about to create a network. (Not the media settings'
 * "is this model host local" question, which asks about a host name with no dot; the two share a spelling and not a purpose.)
 */
export function isLocalOrPrivateUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    // `URL` keeps an IPv6 literal's brackets in `hostname`, so `[::1]` never equalled `::1` and no IPv6 address was ever classified.
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1') return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^f[cd][0-9a-f]{0,2}:/i.test(host)) return true;
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
    return false;
  } catch {
    return true;
  }
}
