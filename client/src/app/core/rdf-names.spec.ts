/**
 * Q-942: the one list of bases the RDF screens draw, the setting the settings save sends, and every refusal an RDF door can answer worded in
 * en, de and pl (never the server's English).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RDF_REFUSAL_CODES, rdfBaseRows, rdfConflictOf, rdfOfForm, rdfPillOf, vocabOf, baseLooksValid, type NetworkWithRdf,
} from './rdf-names';
import { rdfRefusalText } from './rdf-refusal';
import type { VoteRound } from './vote-round-view';

const I18N = join(process.cwd(), 'public', 'assets', 'i18n');
const dict = (lang: string): Record<string, string> => JSON.parse(readFileSync(join(I18N, `${lang}.json`), 'utf8')) as Record<string, string>;

const BASE = 'https://w3id.org/acme/platform/';
const KIEL = 'https://data.kiel-node.example/ld/platform/';
const NEW = 'https://w3id.org/acme/knowledge/';

function nets(): NetworkWithRdf[] {
  return [
    {
      id: 'acme', label: 'Acme partners', spaces: ['platform'],
      members: [{ instanceId: 'i-kiel', label: 'kiel-node' }, { instanceId: 'i-mirror', label: 'kiel-mirror' }, { instanceId: 'i-berlin', label: 'berlin-lab' }] as NetworkWithRdf['members'],
      rdfBaseConflicts: { platform: { held: { base: BASE, epoch: 0 }, offered: [
        { networkId: 'acme', memberId: 'i-kiel', base: KIEL, epoch: 0 },
        { networkId: 'acme', memberId: 'i-mirror', base: KIEL, epoch: 0 },
      ] } },
    },
    { id: 'berlin', label: 'Berlin lab', spaces: ['platform'], members: [{ instanceId: 'i-berlin', label: 'berlin-lab' }] as NetworkWithRdf['members'] },
  ];
}

const round = (networkId: string, yes: number): VoteRound => ({
  id: `r-${networkId}`, networkId, type: 'space_rebase', subject: 'platform', openedAt: '2026-11-25T18:00:00Z', deadline: '2026-12-02T18:00:00Z',
  status: 'open', votes: Array.from({ length: yes }, (_, i) => ({ instanceId: `v${i}`, vote: 'yes' as const })), localSpaceId: 'platform',
  rebase: { base: NEW, vocab: `${NEW}vocab/`, epoch: 1 },
});

describe('the one list of bases (layout D)', () => {
  it('holds the held base first, one offered row per network and base naming every member, one vote row tallied per network', () => {
    const rows = rdfBaseRows({ enabled: true, base: BASE }, nets(), [round('acme', 2), round('berlin', 1)], 'platform');
    expect(rows.map(r => r.kind)).toEqual(['held', 'offered', 'vote']);
    const offered = rows[1]!;
    expect(offered.kind === 'offered' && offered.members).toEqual(['kiel-node', 'kiel-mirror']);
    expect(offered.kind === 'offered' && offered.networkLabel).toBe('Acme partners');
    const vote = rows[2]!;
    expect(vote.kind === 'vote' && vote.tallies.map(t => [t.networkLabel, t.yes, t.of])).toEqual([['Acme partners', 2, 4], ['Berlin lab', 1, 2]]);
  });

  it('is empty while the space holds no base, and the pill says off, on, vote open or conflict, a conflict first', () => {
    expect(rdfBaseRows(undefined, nets(), [], 'platform')).toEqual([]);
    expect(rdfPillOf(undefined, [])).toBe('off');
    expect(rdfPillOf({ enabled: false, base: BASE }, [])).toBe('off');
    expect(rdfPillOf({ enabled: true, base: BASE }, rdfBaseRows({ enabled: true, base: BASE }, [], [], 'platform'))).toBe('on');
    expect(rdfPillOf({ enabled: true, base: BASE }, rdfBaseRows({ enabled: true, base: BASE }, [nets()[1]!], [round('berlin', 1)], 'platform'))).toBe('vote');
    expect(rdfPillOf({ enabled: true, base: BASE }, rdfBaseRows({ enabled: true, base: BASE }, nets(), [round('acme', 1)], 'platform'))).toBe('conflict');
  });

  it('reads a conflict for the space asked about only', () => {
    expect(rdfConflictOf(nets(), 'platform')?.offers).toHaveLength(2);
    expect(rdfConflictOf(nets(), 'other')).toBeNull();
  });

  it('says the vocabulary the export writes: the stored one, else the base and vocab/', () => {
    expect(vocabOf({ base: BASE })).toBe(`${BASE}vocab/`);
    expect(vocabOf({ base: BASE, vocab: 'https://w3id.org/acme/terms/' })).toBe('https://w3id.org/acme/terms/');
  });

  it('checks a typed base as the server does: http(s), ending in /, no #', () => {
    expect(baseLooksValid(BASE)).toBe(true);
    expect(baseLooksValid('https://w3id.org/acme/platform')).toBe(false);
    expect(baseLooksValid('https://w3id.org/acme#x/')).toBe(false);
    expect(baseLooksValid('urn:acme/')).toBe(false);
  });
});

describe('the setting the settings save sends (rdfOfForm)', () => {
  it('sends nothing for a space that never had RDF names and stays off', () => {
    expect(rdfOfForm(undefined, { enabled: false, base: '', vocab: '' })).toBeUndefined();
  });
  it('a first enable sends the typed base and vocabulary, or none (the server takes this instance\'s address)', () => {
    expect(rdfOfForm(undefined, { enabled: true, base: ` ${BASE} `, vocab: '' })).toEqual({ enabled: true, base: BASE });
    expect(rdfOfForm(undefined, { enabled: true, base: '', vocab: '' })).toEqual({ enabled: true });
  });
  it('a stored base is sent back as stored, whatever the form holds, and switching off keeps it', () => {
    const stored = { enabled: true, base: BASE, vocab: `${BASE}terms/`, baseEpoch: 2 };
    expect(rdfOfForm(stored, { enabled: false, base: 'https://elsewhere.example/', vocab: '' })).toEqual({ enabled: false, base: BASE, vocab: `${BASE}terms/` });
  });
});

describe('every refusal an RDF door answers is worded in en, de and pl', () => {
  const langs = ['en', 'de', 'pl'].map(l => [l, dict(l)] as const);
  it.each(RDF_REFUSAL_CODES.map(c => [c]))('%s', (code) => {
    for (const [lang, d] of langs) expect(d[`rdf.refusal.${code}`], `${lang}: rdf.refusal.${code}`).toBeTruthy();
  });

  it('the status words exist for an answer with no code the family words', () => {
    for (const [lang, d] of langs) {
      for (const k of ['failed', 'forbidden', 'notFound', 'unreachable', 'badRequest']) expect(d[`rdf.refusal.${k}`], `${lang}: ${k}`).toBeTruthy();
    }
  });

  it('rdfRefusalText words a code from the dictionary and never shows the server\'s English, coded or not', () => {
    const t = { translate: (k: string) => `T:${k}` };
    const english = 'Space \'x\' has RDF switched off, so its records have no addresses to export';
    expect(rdfRefusalText(t, { status: 409, error: { error: english, code: 'rdf_not_enabled' } })).toBe('T:rdf.refusal.rdf_not_enabled');
    expect(rdfRefusalText(t, { status: 403, error: { error: 'Forbidden: knowledge read needed' } })).toBe('T:rdf.refusal.forbidden');
    expect(rdfRefusalText(t, { status: 409, error: { error: 'something new', code: 'brand_new_code' } })).toBe('T:rdf.refusal.failed');
    expect(rdfRefusalText(t, { status: 0 })).toBe('T:rdf.refusal.unreachable');
    expect(rdfRefusalText(t, { status: 400, error: { error: 'Invalid body', issues: [] } })).toBe('T:rdf.refusal.badRequest');
  });
});
