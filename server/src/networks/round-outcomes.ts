/**
 * How the rounds of a network ended, kept on THIS instance after the rounds themselves are pruned.
 *
 * ## What it answers
 *
 * *"What became of the vote I was asked about?"* A concluded round is pruned once its deadline has passed
 * (`sync/vote-round-retention.ts`), and until now nothing recorded how it ended: an operator saw a vote vanish. The conclusion
 * appends an entry in the SAME synchronous step that concludes the round ({@link recordRoundOutcome}, called by
 * `concludeRoundIfReady`), so no later step can lose it; the prune records a round that concluded before this existed as `ended`
 * (its reason was never recorded) before it removes it.
 *
 * ## What it keeps, and why that is bounded
 *
 * - **Local.** The entries are this instance's own reading of a conclusion, so they are config state that never travels
 *   (`NetworkConfig.roundOutcomes`; "what an instance derives stays local"). They are lost with the network.
 * - **The newest {@link ROUND_OUTCOMES_KEPT}, by `concludedAt`**, so the config cannot grow without bound. An undated (legacy)
 *   entry sorts after every dated one.
 * - **Inserted once.** A round already recorded is left as it was: a later pass cannot overwrite the first reading.
 * - **Clean text.** Labels and the summary are what PEERS wrote into a round, so they are cut to a length and stripped of control
 *   characters here, once, rather than at every reader.
 * - **No cast, no proposal body, no member credential.** The exception is a JOIN round's `inviteKeyHash` and subject, kept so
 *   the joiner's poll still answers "denied" after the prune; {@link outcomesFor} (the one reading the doors use) strips both.
 *
 * Nothing decides by reading an entry or a round's `outcome`: it is a label for an operator, never an input
 * (`a-round-outcome-decides-nothing-and-is-never-markup.test.js`).
 */
import type { NetworkConfig, VoteRound } from '../config/types.js';
import type { RecordedOutcomeKind, RoundOutcomeEntry } from '../config/types-networks.js';
import { roundSpaceLocalId } from '../sync/space-map.js';
import { metaChangeNote } from '../sync/change-notes.js';
import { roundElectorate } from './round-electorate.js';

/** How many entries a network keeps. */
export const ROUND_OUTCOMES_KEPT = 50;

const LABEL_CHARS = 200;
const SUMMARY_CHARS = 800;
const TIME_CHARS = 64;

/** `value` as text of at most `max` characters with control characters removed (a newline survives only where `lines` allows it). */
function clean(value: unknown, max: number, lines = false): string {
  if (typeof value !== 'string') return '';
  // Bounded BEFORE the strip, so a peer's megabyte label costs one slice and not a scan of the whole.
  const text = value.slice(0, max * 2).replace(lines ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, '');
  return Array.from(text).slice(0, max).join('');
}

const KINDS: readonly RecordedOutcomeKind[] = ['passed', 'vetoed', 'expired'];

/** What a meta_change round proposes, in words a voter reads; `undefined` for any other kind of round. */
export function roundSummary(net: NetworkConfig, round: VoteRound): string | undefined {
  if (round.type !== 'meta_change') return undefined;
  let space = '';
  try { space = roundSpaceLocalId(net, round) ?? round.spaceId ?? ''; } catch { space = typeof round.spaceId === 'string' ? round.spaceId : ''; }
  const text = metaChangeNote(
    clean(round.subjectLabel, LABEL_CHARS), clean(net.label, LABEL_CHARS), clean(space, LABEL_CHARS),
    { fields: round.metaChangedFields, changedTypes: round.changedTypes, keptTypes: round.keptTypes },
    { tense: 'proposed' },
  );
  return clean(text, SUMMARY_CHARS, true);
}

/** Newest first; an entry with no readable `concludedAt` after every dated one. */
function newestFirst(a: RoundOutcomeEntry, b: RoundOutcomeEntry): number {
  const at = (e: RoundOutcomeEntry): number => { const ms = Date.parse(e.concludedAt ?? ''); return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms; };
  const x = at(a); const y = at(b);
  return x === y ? 0 : x < y ? 1 : -1;
}

/** The entry for a concluded round. Never throws: every field a peer could have broken has a fallback. */
function entryFor(net: NetworkConfig, round: VoteRound, now: number): RoundOutcomeEntry {
  const counted = ((): { eligible: number; yes: number; veto: number } => {
    try { return roundElectorate(net, round); } catch { return { eligible: 0, yes: 0, veto: 0 }; }
  })();
  const space = ((): string => {
    try { return clean(roundSpaceLocalId(net, round) ?? round.spaceId, LABEL_CHARS); } catch { return clean(round.spaceId, LABEL_CHARS); }
  })();
  const known = KINDS.includes(round.outcome as RecordedOutcomeKind);
  const stamp = Number.isFinite(now) ? new Date(now).toISOString() : '';
  const concludedAt = known ? (Number.isNaN(Date.parse(round.concludedAt ?? '')) ? stamp : clean(round.concludedAt, TIME_CHARS)) : '';
  const summary = ((): string | undefined => { try { return roundSummary(net, round); } catch { return undefined; } })();
  const hash = typeof round.inviteKeyHash === 'string' && round.inviteKeyHash.length <= 200 ? round.inviteKeyHash : '';
  return {
    roundId: clean(round.roundId, LABEL_CHARS),
    type: round.type,
    ...(space ? { space } : {}),
    subjectLabel: clean(round.subjectLabel, LABEL_CHARS),
    openedAt: clean(round.openedAt, TIME_CHARS),
    deadline: clean(round.deadline, TIME_CHARS),
    ...(concludedAt ? { concludedAt } : {}),
    outcome: known ? (round.outcome as RecordedOutcomeKind) : 'ended',
    yes: counted.yes,
    veto: counted.veto,
    eligible: counted.eligible,
    ...(summary ? { summary } : {}),
    ...(round.type === 'join' && hash ? { inviteKeyHash: hash, subjectInstanceId: clean(round.subjectInstanceId, LABEL_CHARS) } : {}),
  };
}

/**
 * Record how a concluded round ended on `net`, once. TOTAL: it never throws, because it runs in the same step that sets
 * `concluded = true` and a throw there would leave a concluded round nobody can account for. `now` stamps an entry whose round
 * carries a label but no date; a round with neither is a legacy one, recorded `ended` with no date.
 */
export function recordRoundOutcome(net: NetworkConfig, round: VoteRound, now: number): void {
  if (!Array.isArray(net.roundOutcomes)) net.roundOutcomes = [];
  const id = clean(round.roundId, LABEL_CHARS);
  if (net.roundOutcomes.some(e => e.roundId === id)) return;
  net.roundOutcomes.unshift(entryFor(net, round, now));
  net.roundOutcomes.sort(newestFirst);
  if (net.roundOutcomes.length > ROUND_OUTCOMES_KEPT) net.roundOutcomes.length = ROUND_OUTCOMES_KEPT;
}

/**
 * The newest `limit` entries as a door shows them, and how many the log holds in all (so a short page is distinguishable from a
 * short log). Without the join round's subject and invite-key hash: a door never shows a credential.
 */
export function outcomesFor(net: NetworkConfig, limit: number): { outcomes: Omit<RoundOutcomeEntry, 'subjectInstanceId' | 'inviteKeyHash'>[]; total: number } {
  const all = Array.isArray(net.roundOutcomes) ? [...net.roundOutcomes].sort(newestFirst) : [];
  return {
    outcomes: all.slice(0, limit).map(({ subjectInstanceId: _s, inviteKeyHash: _h, ...shown }) => shown),
    total: all.length,
  };
}

/**
 * The recorded JOIN rounds about `instanceId` that kept an invite-key hash, newest first, as stored. For the joiner's poll alone: it
 * has to answer "denied" for a round the prune removed. Not for a door — {@link outcomesFor} is that.
 */
export function joinOutcomesAbout(net: NetworkConfig, instanceId: string): RoundOutcomeEntry[] {
  return (Array.isArray(net.roundOutcomes) ? net.roundOutcomes : [])
    .filter(e => e.type === 'join' && e.subjectInstanceId === instanceId && typeof e.inviteKeyHash === 'string')
    .sort(newestFirst);
}

/**
 * Did the recorded round NOT carry the joiner in? Only `passed` did; `vetoed`, `expired`, `ended` and anything unknown did not.
 * Here so the join poll asks a question and never reads the label itself: nothing outside this module and the outcome door reads
 * an `outcome` (`a-round-outcome-decides-nothing-and-is-never-markup.test.js`), and an unknown value reads as "did not pass".
 */
export function joinWasDenied(entry: RoundOutcomeEntry): boolean {
  return entry.outcome !== 'passed';
}
