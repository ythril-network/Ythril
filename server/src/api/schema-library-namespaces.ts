/**
 * The handlers of a schema-library group's namespace (Q-748, design r4 §4.2): `PUT /api/schema-library/groups/:group/namespace` and
 * `DELETE …/namespace`, declared on the library router (`api/schema-library.ts`, with its rate limit and the admin-with-MFA guard).
 *
 * ## What it prevents
 *
 * A namespace names the RDF terms of every space that links an entry of the group. Set, moved or removed without a look at those spaces, it
 * would rename terms whose exports other systems already read, or give two terms of one space one address. So each write is held to the
 * library's one RDF guard (`libraryRdfGuard`, `spaces/library-terms.ts`) BEFORE anything is stored: 409 `rdf_term_rename` unless `rebase`,
 * 409 `rdf_term_clash` always. The stored namespaces are `config.json`'s (`schemaLibraryNamespaces`), under its state-file rules.
 *
 * No MCP door: the schema library is REST-only (`testing/standalone/_capability-map.mjs`).
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { NamespaceIriZ, PrefixZ } from '@ythril-network/schema';
import { getConfig, getSchemaLibrary, saveConfig } from '../config/loader.js';
import { currentLibraryState, libraryRdfGuard, namespaceOfGroup, type LibraryNamespace } from '../spaces/library-terms.js';
import { NAME_QUOTED, peerText, refusalOfParse } from '../util/log.js';

/** The body of a namespace PUT: the prefix and the namespace IRI, and `rebase: true` to rename linked terms on purpose. */
export const NamespaceBodyZ = z.object({ prefix: PrefixZ, iri: NamespaceIriZ, rebase: z.literal(true).optional() }).strict();

/** The statuses of a namespace refusal: a body no door accepts; a group with nothing to name; a prefix or a term that stands. */
const BAD_BODY = 400 as const;
const NOTHING_TO_NAME = 404 as const;
const STANDS = 409 as const;

/** What a namespace route answers when the write cannot be made. */
type Refused = { status: typeof BAD_BODY | typeof NOTHING_TO_NAME | typeof STANDS; body: Record<string, unknown> };

/** The entry names of `group`, or a 404 when it has none (a namespace names the entries of a group, and an empty group names nothing). */
function entriesOf(group: string): string[] | Refused {
  const names = getSchemaLibrary().filter(e => e.schemaGroup === group).map(e => e.name);
  if (names.length > 0) return names;
  return { status: NOTHING_TO_NAME, body: { error: `No library entries found for group '${peerText(group, { max: NAME_QUOTED })}'`, code: 'group_not_found' } };
}

/** Store `next` as the namespaces, after the guard; answer the refusal or `null`. */
function storeNamespaces(next: Record<string, LibraryNamespace>, rebase: boolean): Refused | null {
  const cfg = getConfig();
  const before = currentLibraryState();
  const refusal = libraryRdfGuard(cfg.spaces, before, { library: before.library, namespaces: usable(next) }, rebase);
  if (refusal) return refusal;
  cfg.schemaLibraryNamespaces = Object.keys(next).length > 0 ? next : undefined;
  saveConfig(cfg);
  return null;
}

/** The namespaces of `all` a door would accept, as the effective entries read them (a hand edit of the file may hold one that names nothing). */
function usable(all: Record<string, LibraryNamespace>): Record<string, LibraryNamespace> {
  return Object.fromEntries(Object.entries(all).filter(([, ns]) => PrefixZ.safeParse(ns.prefix).success && NamespaceIriZ.safeParse(ns.iri).success));
}

/**
 * Take the namespace of every group `library` holds no entry of out of `config.json` (lens finding 7). A namespace names the terms of a
 * group's entries and holds a prefix; with the last entry gone (deleted, moved to another group, its group cleared) it names nothing, is
 * listed nowhere (`GET /groups` lists the groups that have entries) and still blocks its prefix (`namespace_prefix_taken`), so nobody could
 * see or remove it. Called by the one save every library write that changes entries goes through. Nothing is saved when none is orphaned.
 */
export function forgetNamespacesOfEmptyGroups(library: readonly { schemaGroup?: string | undefined }[]): void {
  const cfg = getConfig();
  const held = cfg.schemaLibraryNamespaces;
  if (!held) return;
  const groups = new Set(library.map(e => e.schemaGroup));
  const kept = Object.entries(held).filter(([group]) => groups.has(group));
  if (kept.length === Object.keys(held).length) return;
  cfg.schemaLibraryNamespaces = kept.length > 0 ? Object.fromEntries(kept) : undefined;
  saveConfig(cfg);
}

/** `PUT /groups/:group/namespace`. `afterEdit` is the library's own aftercare of an edit (new schema versions, conversion restarts). */
export function putNamespace(req: Request, res: Response, afterEdit: (names: readonly string[]) => void): void {
  const group = String(req.params['group'] ?? '');
  const parsed = NamespaceBodyZ.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(BAD_BODY).json(refusalOfParse(parsed.error)); return; }
  const names = entriesOf(group);
  if (!Array.isArray(names)) { res.status(names.status).json(names.body); return; }
  const { prefix, iri, rebase } = parsed.data;
  const held = getConfig().schemaLibraryNamespaces ?? {};
  const owner = Object.entries(held).find(([g, ns]) => g !== group && ns.prefix === prefix)?.[0];
  if (owner !== undefined) {
    res.status(STANDS).json({ error: `the prefix ${prefix} is the namespace of group '${peerText(owner, { max: NAME_QUOTED })}'`, code: 'namespace_prefix_taken' });
    return;
  }
  const refused = storeNamespaces({ ...held, [group]: { prefix, iri } }, rebase === true);
  if (refused) { res.status(refused.status).json(refused.body); return; }
  afterEdit(names);
  res.json({ group, namespace: { prefix, iri } });
}

/** `DELETE /groups/:group/namespace[?rebase=true]`. */
export function deleteNamespace(req: Request, res: Response, afterEdit: (names: readonly string[]) => void): void {
  const group = String(req.params['group'] ?? '');
  const held = { ...(getConfig().schemaLibraryNamespaces ?? {}) };
  if (namespaceOfGroup(held, group) === undefined) { res.status(NOTHING_TO_NAME).json({ error: `group '${peerText(group, { max: NAME_QUOTED })}' has no namespace`, code: 'namespace_not_found' }); return; }
  delete held[group];
  const refused = storeNamespaces(held, req.query['rebase'] === 'true');
  if (refused) { res.status(refused.status).json(refused.body); return; }
  const names = entriesOf(group);
  if (Array.isArray(names)) afterEdit(names);
  res.json({ group, removed: true });
}
