/**
 * Ticking "Instance administrator" sets space admin on the floor, in the draft the dialogs show (S-11).
 *
 * The server stores every instance admin with the space-admin floor (`auth/instance-admin-grants.ts`). A draft
 * that ticked the box without it would show a floor switched off that the server switches on at save — the
 * matrix disagreeing with what the token will hold.
 */
import { describe, it, expect } from 'vitest';
import { withInstanceFlag } from './token-capability';
import type { TokenRights } from '../pages/settings/rights-glyph.component';

const base = (): TokenRights => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, spaceAdmin: { floor: false, spaces: ['qa'] } });

describe('withInstanceFlag', () => {
  it('ticking instance admin sets the space-admin floor and keeps the named spaces', () => {
    const r = withInstanceFlag(base(), 'instanceAdmin', true);
    expect(r.instanceAdmin).toBe(true);
    expect(r.spaceAdmin).toEqual({ floor: true, spaces: ['qa'] });
  });

  it('unticking it leaves the floor to the matrix, where it is its own grant', () => {
    const on = withInstanceFlag(base(), 'instanceAdmin', true);
    const off = withInstanceFlag(on, 'instanceAdmin', false);
    expect(off.instanceAdmin).toBe(false);
    expect(off.spaceAdmin?.floor).toBe(true);
  });

  it('create spaces changes only itself', () => {
    const r = withInstanceFlag(base(), 'createSpaces', true);
    expect(r.createSpaces).toBe(true);
    expect(r.spaceAdmin).toEqual({ floor: false, spaces: ['qa'] });
  });
});
