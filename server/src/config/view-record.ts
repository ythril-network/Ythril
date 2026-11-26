/**
 * A personal view as `config.json` holds it (`Config.views`): a module of the type alone, which `types.ts` names, so the record grows here
 * and not in the config's one large type file.
 */

/** A personal view as `config.json` holds it. */
export interface ViewRecord {
  /** `@<name>`: `@` is not a legal space-id character, so a view and a space never collide. */
  id: string;
  /** `^[a-z0-9-]+$`, at most 40; unique per owner, not instance-wide. */
  name: string;
  /** `token:<id>`, `oauth:<clientId>` or `oidc:<issuer>#<sub>`. */
  ownerId: string;
  /** Concrete space ids, or `['*']` for every space. Never a view id. */
  members: string[];
  createdAt: string;
  /** The pre-6.0 proxy id this view was made from, for idempotence by origin. */
  migratedFrom?: string;
  /** `<owner key>|<source view id>` of the view this one is a copy of, so a repeated copy to one receiver refreshes it instead of making `-N`. */
  copiedFrom?: string;
  /** When the last token of the owner went without the views being deleted (a cap eviction), so the grace sweep counts from there. */
  ownerLeftAt?: string;
  /**
   * A SPARQL CONSTRUCT the view stands for (Q-762): the RDF doors (export, SPARQL query, the view's Linked Data address) read the view as
   * the CONSTRUCT's statements over its members as the caller reads them, and every other door refuses it (`view_is_construct`). Checked at
   * save time (`rdf/view-construct.ts`). LOCAL, like the whole record: `config.json` only, never synced and not in a database backup.
   */
  sparql?: { query: string };
}
