import type { Network } from './api.types';
import { voteTally, type VoteRound } from './vote-round-view';

/**
 * What the screens show of a space's RDF names (Q-942, layout D "one list of bases"): the base this space holds, every base a network
 * offers in its place, and every base a vote proposes, as ONE list, held first, the rows that need someone marked.
 *
 * ## What it prevents
 *
 * - **A conflict shown in one place and not in another.** The RDF names card, the Overview's Networks panel and the export panel ask
 *   {@link rdfConflictOf} for one space; none of them reads `rdfBaseConflicts` by hand, so a conflict cannot be a pill on one screen and
 *   nothing on the next.
 * - **One base offered twice, drawn twice.** Two members of one network that offer the same base are one row naming both
 *   (`offeredRows`): accepting it is one act, whoever offers it.
 * - **A vote row that disagrees with the vote.** A base change is a `space_rebase` round per network that carries the space; the rows group
 *   the rounds by the base they move to and tally each network from the round itself ({@link voteTally}), never from a count kept here.
 * - **A vocabulary drawn from a guess.** The vocabulary is the stored one, else `<base>vocab/`, the server's default
 *   (`defaultVocabFor`), so the card says the address the export will write.
 *
 * Pure: the screens hand it the space's setting, the networks the caller may read, and the open rounds.
 */

/** A space's RDF setting as `meta.rdf` carries it (the schema package's `RdfSetting`). */
export interface RdfSetting {
  enabled: boolean;
  base?: string;
  vocab?: string;
  baseEpoch?: number;
}

/**
 * `meta.rdf` on the client's `SpaceMeta`, declared here with the module that reads it (Q-748): off, or on with the base every address starts
 * with; `rebase: true` is the write-only flag of a deliberate base change.
 */
declare module './api.types' {
  interface SpaceMeta { rdf?: RdfSetting & { rebase?: true } }
}

/** A base conflict as `GET /api/networks` answers it per space (`NetworkConfig.rdfBaseConflicts`, the schema package's `RdfBaseConflict`). */
export interface RdfBaseConflict {
  held: { base: string; vocab?: string; epoch: number };
  offered: { networkId?: string; memberId?: string; base: string; vocab?: string; epoch: number }[];
}

/** A network as this module reads it: the answer of `GET /api/networks`, which carries the conflicts it recorded. */
export type NetworkWithRdf = Pick<Network, 'id' | 'label' | 'spaces' | 'members'> & {
  spaceMap?: Record<string, string>;
  rdfBaseConflicts?: Record<string, RdfBaseConflict>;
};

/** The base this space holds. */
export interface HeldRow { kind: 'held'; base: string }

/** A base a network offers in place of the held one, with who offers it. */
export interface OfferedRow {
  kind: 'offered';
  base: string;
  vocab?: string;
  epoch: number;
  networkId: string;
  networkLabel: string;
  /** The members that offer it, by label where the network knows them, else by id. */
  members: string[];
}

/** A base a vote would move this space to, with each network's tally. */
export interface VoteRow {
  kind: 'vote';
  base: string;
  vocab: string;
  /** The latest deadline of the rounds: the base moves only once every network passed and came due. */
  deadline: string;
  tallies: { networkId: string; networkLabel: string; yes: number; veto: number; of: number }[];
}

export type BaseRow = HeldRow | OfferedRow | VoteRow;

/** The card's one pill: what the reader must know first. */
export type RdfPill = 'off' | 'on' | 'vote' | 'conflict';

/** The record formats of one space, and of a view (Turtle holds one graph, so a view of several spaces cannot be Turtle). */
export const RDF_SPACE_FORMATS = ['turtle', 'trig', 'nquads', 'jsonld'] as const;
export const RDF_VIEW_FORMATS = ['trig', 'nquads', 'jsonld'] as const;
export type RdfRecordFormat = typeof RDF_SPACE_FORMATS[number];
/** The schema export's two formats. */
export const RDF_SCHEMA_FORMATS = ['turtle', 'jsonld'] as const;
export type RdfSchemaFormat = typeof RDF_SCHEMA_FORMATS[number];
/** How an edge's own details are written; JSON-LD carries only the classic form. */
export const RDF_EDGE_DETAILS = ['rdf12', 'reification'] as const;
export type RdfEdgeDetails = typeof RDF_EDGE_DETAILS[number];

/** The file extension of each format, as the server names the attachment. */
export const RDF_EXTENSION: Readonly<Record<RdfRecordFormat, string>> = { turtle: 'ttl', trig: 'trig', nquads: 'nq', jsonld: 'jsonld' };

/** Whether the space gives out RDF names now. */
export const rdfIsOn = (rdf: RdfSetting | undefined): boolean => rdf?.enabled === true && !!rdf.base;

/** The vocabulary address: the stored one, else the base followed by `vocab/` (the server's default). */
export function vocabOf(rdf: Pick<RdfSetting, 'base' | 'vocab'> | undefined): string {
  if (!rdf?.base) return '';
  return rdf.vocab || `${rdf.base}vocab/`;
}

/** The address a record gets: the base, its kind and its id. */
export const recordAddressExample = (base: string, id = 'svc-billing'): string => `${base}entity/${id}`;

/** The base the server gives a space switched on with none: this instance's public address, `/ld/`, the space id. */
export const defaultBaseOf = (origin: string, spaceId: string): string => `${origin.replace(/\/+$/, '')}/ld/${encodeURIComponent(spaceId)}/`;

/** A base the server takes: an absolute http(s) address ending in `/`, holding no `#` (the schema package's `BaseIriZ`, as a reader can check it). */
export function baseLooksValid(base: string): boolean {
  if (!/^https?:\/\/[^\s#]+\/$/.test(base)) return false;
  try { new URL(base); return true; } catch { return false; }
}

/**
 * The `meta.rdf` the settings save sends, or undefined when the space never had RDF names and is not being switched on. A stored base and
 * vocabulary are sent back as stored, whatever the form holds: the save never moves a base (the server would answer `rdf_base_frozen`), and
 * switching off keeps them, so switching on again gives the same addresses. A first enable sends the typed base and vocabulary, or none, and
 * the server then takes this instance's own address. The epoch is the server's and is never sent.
 */
export function rdfOfForm(stored: RdfSetting | undefined, form: { enabled: boolean; base: string; vocab: string }): RdfSetting | undefined {
  if (!stored && !form.enabled) return undefined;
  const base = stored?.base ?? (form.base.trim() || undefined);
  const vocab = stored?.base ? stored.vocab : (form.vocab.trim() || undefined);
  return { enabled: form.enabled, ...(base ? { base } : {}), ...(vocab ? { vocab } : {}) };
}

/** The networks that carry `spaceId`, with what each calls it. */
function carrying(networks: readonly NetworkWithRdf[], spaceId: string): NetworkWithRdf[] {
  return networks.filter(n => n.spaces.includes(spaceId));
}

/** The base conflict the networks the caller reads recorded for `spaceId`, each offer with its network; null when none stands. */
export function rdfConflictOf(networks: readonly NetworkWithRdf[], spaceId: string): { held: RdfBaseConflict['held']; offers: { network: NetworkWithRdf; offer: RdfBaseConflict['offered'][number] }[] } | null {
  let held: RdfBaseConflict['held'] | null = null;
  const offers: { network: NetworkWithRdf; offer: RdfBaseConflict['offered'][number] }[] = [];
  for (const n of networks) {
    const c = n.rdfBaseConflicts?.[spaceId];
    if (!c) continue;
    held ??= c.held;
    for (const offer of c.offered) offers.push({ network: n, offer });
  }
  return held && offers.length > 0 ? { held, offers } : null;
}

/** The offered bases, one row per network and base, naming every member that offers it. */
function offeredRows(networks: readonly NetworkWithRdf[], spaceId: string): OfferedRow[] {
  const conflict = rdfConflictOf(networks, spaceId);
  if (!conflict) return [];
  const rows = new Map<string, OfferedRow>();
  for (const { network, offer } of conflict.offers) {
    const key = `${network.id}\u0000${offer.base}`;
    const member = offer.memberId ? (network.members.find(m => m.instanceId === offer.memberId)?.label || offer.memberId) : '';
    const row = rows.get(key) ?? { kind: 'offered', base: offer.base, ...(offer.vocab ? { vocab: offer.vocab } : {}), epoch: offer.epoch, networkId: network.id, networkLabel: network.label, members: [] };
    if (member && !row.members.includes(member)) row.members.push(member);
    rows.set(key, row);
  }
  return [...rows.values()];
}

/** The open base changes for `spaceId`: the `space_rebase` rounds grouped by the base they move to. */
function voteRows(networks: readonly NetworkWithRdf[], rounds: readonly VoteRound[], spaceId: string): VoteRow[] {
  const ids = new Set(carrying(networks, spaceId).map(n => n.id));
  const rows = new Map<string, VoteRow>();
  for (const r of rounds) {
    if (r.type !== 'space_rebase' || r.status !== 'open' || !r.rebase) continue;
    if (r.localSpaceId !== undefined ? r.localSpaceId !== spaceId : !ids.has(r.networkId)) continue;
    const net = networks.find(n => n.id === r.networkId);
    const row = rows.get(r.rebase.base) ?? { kind: 'vote', base: r.rebase.base, vocab: r.rebase.vocab, deadline: r.deadline, tallies: [] };
    if (r.deadline > row.deadline) row.deadline = r.deadline;
    const { yes, veto } = voteTally(r);
    // Every member votes, this instance too: the network's members and this instance.
    row.tallies.push({ networkId: r.networkId, networkLabel: net?.label ?? r.networkId, yes, veto, of: (net?.members.length ?? 0) + 1 });
    rows.set(r.rebase.base, row);
  }
  return [...rows.values()];
}

/** The one list of bases: the held one first, then each offered base, then each base a vote proposes. Empty while RDF names are off. */
export function rdfBaseRows(rdf: RdfSetting | undefined, networks: readonly NetworkWithRdf[], rounds: readonly VoteRound[], spaceId: string): BaseRow[] {
  if (!rdf?.base) return [];
  return [{ kind: 'held', base: rdf.base }, ...offeredRows(networks, spaceId), ...voteRows(networks, rounds, spaceId)];
}

/** The card's pill: a conflict outranks a vote, a vote outranks plain on. */
export function rdfPillOf(rdf: RdfSetting | undefined, rows: readonly BaseRow[]): RdfPill {
  if (!rdfIsOn(rdf)) return 'off';
  if (rows.some(r => r.kind === 'offered')) return 'conflict';
  if (rows.some(r => r.kind === 'vote')) return 'vote';
  return 'on';
}

/** Whether `spaceId` is carried by any network the caller reads: a base change is then a vote. */
export const rdfIsShared = (networks: readonly NetworkWithRdf[], spaceId: string): boolean => carrying(networks, spaceId).length > 0;

/**
 * The refusal codes the RDF doors these screens call can answer: the settings save, the base offer's accept and the base change, the
 * schema export and the records export. Each is worded under `rdf.refusal.<code>` in every language (`rdf-names.spec.ts` holds it), so a
 * refusal is never the server's English.
 */
export const RDF_REFUSAL_CODES = [
  'rdf_not_enabled', 'rdf_base_conflict', 'rdf_base_shared', 'rdf_base_nested', 'rdf_term_clash', 'rdf_unwritable',
  'rdf_base_frozen', 'rdf_base_needed', 'rdf_base_unchanged', 'rdf_rebase_pending', 'rdf_rebase_alone', 'rdf_not_a_layer_field',
  'rdf_bad_format', 'rdf_bad_edge_details', 'rdf_format_not_acceptable', 'rdf_export_busy', 'rdf_export_incomplete',
  'view_sparql_not_construct', 'view_sparql_invalid', 'view_construct_too_large', 'sparql_too_much_read', 'sparql_answer_too_large',
  // A save of the setting while an act holds the space, and an id that became personal views: every door answers these.
  'space_retired', 'space_being_deleted', 'space_being_wiped', 'space_being_renamed', 'space_being_restored', 'space_being_migrated',
  'space_being_rdf_imported', 'space_being_imported',
] as const;
