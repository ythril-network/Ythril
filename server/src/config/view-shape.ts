/**
 * What a personal view IS, as plain data: its name rule, its caps, its owner key, and the check a config file's `views` must pass
 * (Q-531, 6.0).
 *
 * ## Why this is its own module and not part of `config/views.ts`
 *
 * `loadConfig` has to refuse a malformed `views` list at boot, and `config/views.ts` (the store) imports the loader. The shape and its
 * validation depend on nothing, so the loader and the store both read them from here and neither imports the other.
 *
 * ## What it prevents
 *
 * A boot that half-understood its views would serve a view nobody can name or delete: a name outside `^[a-z0-9-]+$` cannot be a URL
 * segment after the `@`, two views of one owner with one name cannot both be addressed, a member that is itself a view would make
 * a read recurse, and an owner key of a kind nothing issues can never be matched by a live token or swept.
 */
import type { ViewRecord } from './types.js';

/** A view's name: what follows the `@` in its id. */
export const VIEW_NAME_PATTERN = /^[a-z0-9-]+$/;
export const VIEW_NAME_MAX = 40;
/** Views one owner may hold. A copy counts against the receiver's cap. */
export const MAX_VIEWS_PER_OWNER = 50;
/** Members one view may name; `'*'` counts as one. */
export const MAX_VIEW_MEMBERS = 1000;
/** The member list that means "every space the caller reads". */
export const WILDCARD_MEMBER = '*';

/** The owner-key kinds a view may carry, one per way a caller is identified. */
export const VIEW_OWNER_KINDS = Object.freeze(['token', 'oauth', 'oidc'] as const);
export type ViewOwnerKind = typeof VIEW_OWNER_KINDS[number];

/** A view id begins with `@`, which no space id may. */
export const isViewId = (id: string): boolean => id.startsWith('@');

/** The kind of an owner key, or `null` for a string no issuer produces. */
export function viewOwnerKind(ownerId: string): ViewOwnerKind | null {
  const kind = VIEW_OWNER_KINDS.find(k => ownerId.startsWith(`${k}:`) && ownerId.length > k.length + 1);
  return kind ?? null;
}

/** Whether `name` can be a view's name. */
export const isValidViewName = (name: unknown): name is string =>
  typeof name === 'string' && name.length > 0 && name.length <= VIEW_NAME_MAX && VIEW_NAME_PATTERN.test(name);

/**
 * The views list of a parsed config, validated; throws an `Error` naming every defect (the first few) so the operator can find the entry.
 * Nothing is repaired: a view is personal data of its owner, and a file the loader cannot understand is the operator's to fix.
 */
export function validateViews(views: unknown): void {
  if (views === undefined) return;
  if (!Array.isArray(views)) throw new Error('config.json: `views` must be a list of personal views');
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const v of views as Partial<ViewRecord>[]) {
    const where = `view '${String(v?.id ?? v?.name ?? '?')}'`;
    if (!isValidViewName(v?.name)) problems.push(`${where}: name '${String(v?.name)}' must match ${VIEW_NAME_PATTERN.source} and be at most ${VIEW_NAME_MAX} characters`);
    else if (v.id !== `@${v.name}`) problems.push(`${where}: id must be '@${v.name}'`);
    if (typeof v?.ownerId !== 'string' || !viewOwnerKind(v.ownerId)) {
      problems.push(`${where}: owner '${String(v?.ownerId)}' is not a token:, oauth: or oidc: key`);
    } else if (typeof v.name === 'string') {
      const key = `${v.ownerId}\u0000${v.name}`;
      if (seen.has(key)) problems.push(`${where}: owner '${v.ownerId}' holds two views named '${v.name}'`);
      seen.add(key);
    }
    if (!Array.isArray(v?.members) || v.members.some(m => typeof m !== 'string')) problems.push(`${where}: members must be a list of space ids`);
    else for (const m of v.members) if (isViewId(m)) problems.push(`${where}: member '${m}' is itself a view; a view lists spaces only`);
  }
  if (problems.length > 0) {
    throw new Error(`config.json: ${problems.length} personal view problem(s): ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '; ...' : ''}`);
  }
}

/** What identifies a caller as a view owner: a stored token, a connector token (it has a client id), or an OIDC identity. */
export interface ViewOwnerSource {
  id: string;
  oauthClientId?: string | undefined;
  oidcIssuer?: string | undefined;
  oidcSubject?: string | null | undefined;
}

/**
 * The key a caller's views are stored under, or `null` for a caller that cannot own one.
 *
 * `token:<id>` for a stored token; `oauth:<clientId>` for an MCP connector token (its id changes on every rotation, its client id does
 * not, so the views survive a reconnect); `oidc:<issuer>#<sub>` for an OIDC caller. An OIDC caller whose token carries no `sub` has NO
 * key: a shared 'unknown' principal would make every such caller one owner of every other's views.
 */
export function viewOwnerOf(token: ViewOwnerSource): string | null {
  if (token.oidcIssuer !== undefined) return token.oidcSubject ? `oidc:${token.oidcIssuer}#${token.oidcSubject}` : null;
  if (token.oauthClientId) return `oauth:${token.oauthClientId}`;
  return `token:${token.id}`;
}

/** The lowest free `<name>-N` (N from 2) beside `taken`, the base trimmed so the whole stays within the name limit. */
export function freeViewName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${name.slice(0, VIEW_NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
