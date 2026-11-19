import type { VoteRound } from './api.types';
import { COLLECTION_OF_KIND, type ConvertBlock } from './conversion-counts';
import type { ConversionStep } from './conversion.types';

/**
 * A vote round as the server sends it (`GET /api/networks/:id/votes`), turned into the `VoteRound` the pages read.
 *
 * ## Why this exists
 *
 * The client's `VoteRound` was written against a shape the server never sent: it read `id`, `subject` and
 * `status`, and the server sends `roundId`, `subjectLabel` and `concluded`/`passed`. Both consumers — the Networks
 * page and the Brain overview's Governance panel — filtered on `status === 'open'`, so no open vote was ever
 * listed, and a Yes or Veto cast from the page would have posted to `/votes/undefined`. Nothing errored: an empty
 * list is what a network with no open rounds looks like.
 *
 * So the translation lives in ONE place, inside `NetworksApi.listVotes`, where neither page can skip it.
 */
export interface ServerVoteRound {
  roundId: string;
  type: string;
  subjectLabel?: string;
  subjectInstanceId?: string;
  spaceId?: string;
  /**
   * What THIS instance calls the round's space (Q-133). `spaceId` is the network's id or the proposer's, and after a
   * rename neither is the name the operator here knows. Absent from an older server, and for a space not yet carried.
   */
  localSpaceId?: string;
  openedAt: string;
  deadline: string;
  concluded?: boolean;
  passed?: boolean;
  votes?: { instanceId: string; vote: 'yes' | 'veto' }[];
  /** What a meta_change round proposes — the page shows a voter what they are asked to approve. */
  metaChangedFields?: string[];
  changedTypes?: string[];
  keptTypes?: string[];
  proposesLayer?: boolean;
  /** One sentence naming what the round does, written by the server for a voter. Plain text: peer-authored. */
  summary?: string;
  /**
   * The conversion that rides with a schema round: the steps a voter approves with the schema change (bundle-284). Peer-authored, signed by the
   * proposer's cast. Read by the vote row's conversion block, which binds every name in it as text.
   */
  convertRecords?: { steps?: ConversionStep[] };
}

/** What a round is about, as a voter reads it: the space first ("add notes" says more than "add brain-a"), then who. */
export function roundSubject(space: string | undefined, who: string): string {
  return space ? (who ? `${space} (${who})` : space) : who;
}

/** Yes and veto counts for the tally every surface shows beside a round — one counting, not one per page. */
export function voteTally(round: Pick<VoteRound, 'votes'>): { yes: number; veto: number } {
  return {
    yes: round.votes.filter(v => v.vote === 'yes').length,
    veto: round.votes.filter(v => v.vote === 'veto').length,
  };
}

/**
 * The translation key of a round type's label. ONE spelling for every surface that names a round — the vote row, the
 * Overview panel, the decisions list and the toasts — so the wire value (`space_addition`) is never what a person reads.
 */
export const roundTypeKey = (type: string): string => `networks.roundType.${type}`;

/** How a round ended, as the client words it: a value the server records, or `ended` for anything it does not know. */
export type OutcomeWord = 'passed' | 'vetoed' | 'expired' | 'ended';
const OUTCOME_WORDS: readonly string[] = ['passed', 'vetoed', 'expired'];
export const outcomeWord = (outcome: string | undefined): OutcomeWord =>
  outcome !== undefined && OUTCOME_WORDS.includes(outcome) ? (outcome as OutcomeWord) : 'ended';
export const outcomeKey = (outcome: string | undefined): string => `networks.decisions.outcome.${outcomeWord(outcome)}`;

// ── The conversion a round carries ──────────────────────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * The entries of a round's steps that can be called steps: objects that name an op. What a round carries is what a PEER sent, so anything
 * that is not a list gives none, and an entry that is not an object is skipped rather than thrown over: a voter must still read the others.
 */
function stepsOf(steps: unknown): ConversionStep[] {
  return Array.isArray(steps) ? steps.filter((s): s is ConversionStep => isRecord(s) && typeof s['op'] === 'string') : [];
}

/** The order the server applies the steps in (docs 06e): the type steps, then the property renames, then the value maps; any other op last. */
const STEP_RANK: Readonly<Record<string, number>> = { renameType: 0, splitType: 0, renameProperty: 1, mapEnum: 2 };
const rankOf = (step: ConversionStep): number => (Object.hasOwn(STEP_RANK, step.op) ? STEP_RANK[step.op]! : 3);

/** A round's steps in the order the server applies them, each group in the order the proposer wrote it. Never changes the list it is given. */
export function orderedConversionSteps(steps: unknown): ConversionStep[] {
  return stepsOf(steps).sort((a, b) => rankOf(a) - rankOf(b));
}

/**
 * Is this a step of an op this client knows, with the fields its counting reads? A step a count would trip over (a map with no `values`,
 * a split with no `cases`) is left out of the blocks: its records are not counted, and the voter still reads the step as a line.
 */
function countable(step: ConversionStep): boolean {
  const s: Record<string, unknown> = { ...step };
  if (typeof s['kind'] !== 'string' || !Object.hasOwn(COLLECTION_OF_KIND, s['kind'])) return false;
  switch (s['op']) {
    case 'renameProperty': return isName(s['type']) && isName(s['from']) && isName(s['to']);
    case 'renameType': return isName(s['from']) && isName(s['to']);
    case 'mapEnum': return isName(s['type']) && isName(s['property']) && isRecord(s['values']);
    case 'splitType':
      return isName(s['from']) && Array.isArray(s['cases']) && s['cases'].every(c => isRecord(c) && isName(c['when']) && isName(c['to']))
        && (s['otherwise'] === undefined || isName(s['otherwise']));
    default: return false;
  }
}

/**
 * The types a round's steps change, as the blocks `ConversionApi.countsFor` counts: one block per kind and type, in the order the types first
 * appear.
 *
 * - A property step names the type as the schema declares it AFTER the round, so a type rename and a property step on its new name are one
 *   block whose records are held under the OLD name (`was`): that is the name this instance counts them by.
 * - A split is the block of the type it splits; the types it moves records into are not changed here and get none.
 * - A step of an op this client does not know, or one missing a field its count reads, is in no block (see {@link countable}).
 *
 * One reader for the vote row and for the type's "Waiting for the vote" note, so the two cannot count different records for one round.
 */
export function convertBlocksOfRound(steps: unknown): ConvertBlock[] {
  const known = stepsOf(steps).filter(countable);
  const at = (kind: string, type: string): string => `${kind}:${type}`;
  const renamedFrom = new Map<string, string>();
  for (const s of known) if (s.op === 'renameType') renamedFrom.set(at(s.kind, s.to), s.from);

  const blocks = new Map<string, { kind: ConvertBlock['kind']; type: string; was?: string; steps: ConversionStep[] }>();
  for (const s of known) {
    const type = s.op === 'renameType' ? s.to : s.op === 'splitType' ? s.from : s.type;
    const key = at(s.kind, type);
    let block = blocks.get(key);
    if (!block) {
      const was = renamedFrom.get(key);
      block = { kind: s.kind, type, ...(was !== undefined && was !== type ? { was } : {}), steps: [] };
      blocks.set(key, block);
    }
    block.steps.push(s);
  }
  return [...blocks.values()];
}

export function voteRoundFromServer(networkId: string, r: ServerVoteRound): VoteRound {
  const who = r.subjectLabel || r.subjectInstanceId || '';
  return {
    id: r.roundId,
    networkId,
    type: r.type,
    subject: roundSubject(r.localSpaceId ?? r.spaceId, who),
    openedAt: r.openedAt,
    deadline: r.deadline,
    status: !r.concluded ? 'open' : r.passed ? 'passed' : 'failed',
    votes: r.votes ?? [],
    // Copied only when sent: a round that proposes nothing carries none of them, not empty stand-ins.
    ...(r.metaChangedFields !== undefined ? { metaChangedFields: r.metaChangedFields } : {}),
    ...(r.changedTypes !== undefined ? { changedTypes: r.changedTypes } : {}),
    ...(r.keptTypes !== undefined ? { keptTypes: r.keptTypes } : {}),
    ...(r.proposesLayer !== undefined ? { proposesLayer: r.proposesLayer } : {}),
    ...(r.summary !== undefined ? { summary: r.summary } : {}),
    // The conversion and the name this instance holds the round's space under: the row's conversion block reads both (bundle-285).
    ...(r.localSpaceId !== undefined ? { localSpaceId: r.localSpaceId } : {}),
    ...(r.convertRecords !== undefined ? { convertRecords: r.convertRecords } : {}),
  };
}
