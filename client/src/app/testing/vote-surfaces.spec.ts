/**
 * The surfaces that show a vote round — what they must not do, derived from the tree.
 *
 * A round's `subjectLabel`, `summary` and a decision's stored summary are text another instance's operator wrote,
 * and this is a page that asks an operator to APPROVE what they say. The summary is rendered by interpolation
 * (`{{ }}`), which escapes; `[innerHTML]` over it, or a `bypassSecurityTrust*`, would let a peer put markup in front
 * of a voter. And the round type is shown through its translated label, never the wire value.
 *
 * The subjects are DERIVED: every tracked non-spec source that lists, casts or reads outcomes for votes, plus the
 * decisions component the plan names. A floor says the derivation found them — an empty set passes every loop.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';
import { stripComments } from './strip-comments';

/** The API service itself and its translation module are where votes are fetched, not surfaces that show them. */
const NOT_SURFACES = new Set(['src/app/core/networks-api.service.ts', 'src/app/core/vote-round-view.ts', 'src/app/core/api.types.ts']);

/** What makes a file a vote surface: it asks the API for rounds or outcomes, or is the decisions component. */
const SURFACE = /\b(?:listVotes|castVote|VoteRound|app-network-decisions|vote-outcomes)\b/;

/** Every way a file can put a string in front of the user as markup, or switch the sanitiser off. */
function htmlSinks(code: string): RegExpMatchArray[] {
  return [...code.matchAll(/\[innerHTML\]|\binnerHTML\s*=|\bbypassSecurityTrust\w+|\bouterHTML\s*=/g)];
}

describe('the surfaces that show vote rounds', () => {
  const surfaces = trackedAppSources()
    .filter(p => !NOT_SURFACES.has(p))
    .map(p => ({ path: p, code: stripComments(readFileSync(resolve(CLIENT_ROOT, p), 'utf8')) }))
    .filter(f => SURFACE.test(f.code));

  it('are found, and include the Recent decisions component', () => {
    expect(surfaces.length, `found: ${surfaces.map(s => s.path).join(', ')}`).toBeGreaterThanOrEqual(2);
    const decisions = surfaces.filter(s => /selector:\s*'app-network-decisions'/.test(s.code));
    expect(decisions.length, 'no component declares the selector app-network-decisions').toBe(1);
    expect(decisions[0].code, 'the component is not called RecentDecisionsComponent').toMatch(/class\s+RecentDecisionsComponent\b/);
  });

  it('the detector sees what it hunts (a gate that cannot match is a claim)', () => {
    expect(htmlSinks('<div [innerHTML]="summary"></div>')).toHaveLength(1);
    expect(htmlSinks('el.innerHTML = x;')).toHaveLength(1);
    expect(htmlSinks('this.sanitizer.bypassSecurityTrustHtml(x)')).toHaveLength(1);
    expect(htmlSinks('<span>{{ round.summary }}</span>')).toHaveLength(0);
  });

  it('none renders text as HTML, or opts out of sanitising', () => {
    const offenders = surfaces.flatMap(s =>
      htmlSinks(s.code).map(m => `${s.path}:${s.code.slice(0, m.index).split('\n').length}  ${m[0]}`));
    expect(offenders, 'a peer-authored sentence can reach an operator as markup:\n  ' + offenders.join('\n  ')).toEqual([]);
  });

  it('none prints a round\'s wire type: `{{ round.type }}` is the label key, not the label', () => {
    // The loop variables of every `@for (x of <something about votes, decisions or outcomes>)`.
    const offenders: string[] = [];
    let loops = 0;
    for (const s of surfaces) {
      for (const m of s.code.matchAll(/@for\s*\(\s*(\w+)\s+of\s+([^;)]*(?:[Vv]ote|[Dd]ecision|[Oo]utcome)[^;)]*)/g)) {
        loops++;
        const v = m[1];
        const raw = new RegExp(`\\{\\{\\s*${v}\\.type\\s*\\}\\}`, 'g');
        for (const hit of s.code.matchAll(raw)) {
          offenders.push(`${s.path}:${s.code.slice(0, hit.index).split('\n').length}  ${hit[0]}`);
        }
      }
    }
    expect(loops, 'the derivation found no loop over votes or decisions').toBeGreaterThanOrEqual(2);
    expect(offenders, 'show the round type through networks.roundType.<type>:\n  ' + offenders.join('\n  ')).toEqual([]);
  });
});
