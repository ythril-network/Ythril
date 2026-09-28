/**
 * A network invite as ONE opaque line — the whole handshake bundle, base64url, behind a readable prefix.
 *
 * ## Why this exists
 *
 * Owner, 2026-09-02: *"i just would like it to be a single string at the end and not something that looks
 * like a json object — thats too frightening for some tech-averse people i had to learn from my wife."*
 *
 * `/api/invite/generate` returns an object with a PEM key in it, and the inviting operator sends that whole
 * thing to the other party. It is already one paste — of a multi-line blob that does not survive a chat
 * client, wraps in email, and gives the recipient nothing to check. This is the same data as one line.
 *
 * ## Carrying the bundle is the SAFER option, not the lazy one
 *
 * The obvious alternative is a short URL the joiner fetches the rest from. The inviter's RSA public key is
 * what pins the handshake to the intended instance, and today it travels out of band — so a fetch is a
 * place to substitute a key, after which the joiner encrypts to whoever answered and that party relays.
 * Carrying everything keeps the key out of band, adds no unauthenticated GET, and costs about a kilobyte.
 *
 * ## THIS IS AN ENCODING, NOT ENCRYPTION
 *
 * Anyone can decode it in one command, and it contains the `handshakeId` — which `apply` and `finalize`
 * accept as their only credential. So it is a secret in transit and the UI says so. What limits the damage
 * is what limits an SSE ticket: the handshake session expires after an hour and is consumed on apply.
 *
 * ## The format
 *
 *     ythril1_<base64url of the JSON bundle, unpadded>
 *
 * The prefix is the one part a person can read — without it, an invite and any other long opaque string are
 * indistinguishable in a chat window. It carries a version because a format with no version cannot change.
 *
 * base64url rather than base64: `+` and `/` are re-encoded by some transports, and a `/` invites a chat
 * client to read the tail as a URL path. Padding is dropped for the same reason.
 *
 * **The browser has a decoder of its own** (`client/src/app/core/invite-code.ts`) because there is no module
 * both can import. It decodes only — a code minted in a browser would name a handshake session that exists
 * on no server. `an-invite-code-is-one-opaque-string.test.js` compares the two prefixes directly, since a
 * drift there rejects every invite the product produces.
 */

/** The readable half, and the version. Compared against the client's copy by a gate. */
export const INVITE_CODE_PREFIX = 'ythril1_';

/** What a joiner must have to complete a handshake. A code missing any of these is refused, not half-used. */
const REQUIRED = ['handshakeId', 'networkId', 'inviteUrl', 'rsaPublicKeyPem'] as const;

/** The handshake bundle, as `/api/invite/generate` builds it. */
export interface InviteBundle {
  handshakeId: string;
  networkId: string;
  inviteUrl: string;
  rsaPublicKeyPem: string;
  expiresAt?: string;
  spaces?: string[];
  /** The network's id for each of `spaces`, index-aligned (`Q-133`); absent from an older instance. */
  networkSpaces?: string[];
  /** The bundle as one line, when the instance that produced it was new enough to have one. */
  inviteCode?: string;
  [k: string]: unknown;
}

/** The bundle as one line. */
export function encodeInviteCode(bundle: unknown): string {
  const payload = Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64url');
  return `${INVITE_CODE_PREFIX}${payload}`;
}

/**
 * The bundle back, or `null` for anything that is not one of ours.
 *
 * Whitespace at either end is tolerated: selecting a line picks up spaces, and mail clients add them.
 * Refusing that would be a failure whose cause the recipient cannot see.
 *
 * Every rejection returns `null` rather than throwing, because the caller is a paste box: the useful
 * answer is "that is not an invite code", never a stack trace about JSON.
 */
export function decodeInviteCode(code: unknown): InviteBundle | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (!trimmed.startsWith(INVITE_CODE_PREFIX)) return null;

  const payload = trimmed.slice(INVITE_CODE_PREFIX.length);
  // Node's base64url decoder ignores what it cannot read rather than refusing, so a payload with a stray
  // character decodes to something shorter instead of failing — which is how a corrupted paste becomes a
  // confusing error further on. Checked against the alphabet first.
  if (payload.length === 0 || /[^A-Za-z0-9_-]/.test(payload)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const bundle = parsed as Record<string, unknown>;
  for (const field of REQUIRED) {
    if (typeof bundle[field] !== 'string' || bundle[field] === '') return null;
  }
  return bundle as unknown as InviteBundle;
}
