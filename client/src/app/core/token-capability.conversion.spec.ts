/**
 * "May this caller convert records?" (bundle-285, plan sections 3.1 item 11 and 7): the client's mirror of the server's price for a mass
 * rewrite (`schemaConvertPrice`, `server/src/spaces/schema-convert-acts.ts`), asked by the Schema tab's Convert records button, the dialog's
 * "Convert the records now" choice and Review's Convert again.
 *
 * The server's rule, which these rows hold: an instance administrator always may; otherwise the token needs the knowledge ADMIN rung in the
 * space AND must administer the space (`spaceAdmin`, a grant that itself resolves to admin in every area of the space, so the plan's row
 * "space admin without knowledge admin" cannot be built from a real token; its nearest case, admin on the schema area alone, is the row
 * below). The rung in a space is the higher of the space's own row and the floor, as `effectiveRung` resolves it. The answer is a display
 * hint, never the decision: unknown rights (still loading, or a token that may not read them) count as allowed, the Schema tab's own rule,
 * and the server refuses what the token may not do.
 *
 * `holdsSchemaAdmin` is the check the Schema tab computes inline for its rules and instance setting, pulled out so the tab and the
 * conversion read one rule: it asks the same `effectiveRung`, which differs from the tab's inline test only where a space's row is LOWER than
 * the floor (the server takes the higher; the tab took the row).
 *
 * ## Seen red
 *
 * Red on main 2ac9a2b1: `token-capability.ts` exports none of the four.
 */
import { describe, it, expect } from 'vitest';
import { mayConvertRecords, holdsKnowledge, knowledgeAllowed, holdsSchemaAdmin, isSpaceAdmin } from './token-capability';
import type { TokenRights } from '../pages/settings/rights-glyph.component';

type Rungs = Record<string, string>;
const rights = (p: Partial<TokenRights> = {}): TokenRights => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...p });
const floorOf = (r: Rungs): TokenRights['floor'] => r as TokenRights['floor'];
const rowsOf = (r: Record<string, Rungs>): TokenRights['perSpace'] => r as TokenRights['perSpace'];

describe('mayConvertRecords', () => {
  it('an instance administrator may, in any space, with or without a matrix', () => {
    expect(mayConvertRecords(rights({ instanceAdmin: true }), 'customers')).toBe(true);
    expect(mayConvertRecords(rights({ instanceAdmin: true, floor: floorOf({ knowledge: 'none' }) }), 'customers')).toBe(true);
  });

  it('knowledge admin without the space\'s administration may not', () => {
    expect(mayConvertRecords(rights({ floor: floorOf({ knowledge: 'admin' }) }), 'customers')).toBe(false);
    expect(mayConvertRecords(rights({ perSpace: rowsOf({ customers: { knowledge: 'admin' } }) }), 'customers')).toBe(false);
  });

  it('admin on the schema area without knowledge admin may not (the nearest row to "space admin without knowledge admin")', () => {
    expect(mayConvertRecords(rights({ floor: floorOf({ schema: 'admin', knowledge: 'read' }) }), 'customers')).toBe(false);
    expect(mayConvertRecords(rights({ perSpace: rowsOf({ customers: { schema: 'admin', knowledge: 'write' } }) }), 'customers')).toBe(false);
  });

  it('administering the space may: that grant is the top of the knowledge area in it', () => {
    expect(mayConvertRecords(rights({ spaceAdmin: { floor: false, spaces: ['customers'] } }), 'customers')).toBe(true);
  });

  it('administering one space does not reach another; administering every space (the floor) reaches all', () => {
    const named = rights({ spaceAdmin: { floor: false, spaces: ['customers'] } });
    expect(mayConvertRecords(named, 'orders')).toBe(false);
    expect(mayConvertRecords(rights({ spaceAdmin: { floor: true, spaces: [] } }), 'orders')).toBe(true);
  });

  it('a space\'s own row can raise what the floor gives, and one lower than the floor lowers nothing', () => {
    const admin = { spaceAdmin: { floor: false, spaces: ['customers'] } };
    expect(mayConvertRecords(rights({ ...admin, floor: floorOf({ knowledge: 'none' }), perSpace: rowsOf({ customers: { knowledge: 'admin' } }) }), 'customers')).toBe(true);
    expect(mayConvertRecords(rights({ ...admin, floor: floorOf({ knowledge: 'admin' }), perSpace: rowsOf({ customers: { knowledge: 'read' } }) }), 'customers')).toBe(true);
  });

  it('unknown rights count as allowed: the display hint is silent and the server decides', () => {
    expect(mayConvertRecords(null, 'customers')).toBe(true);
    expect(mayConvertRecords(undefined, 'customers')).toBe(true);
  });

  it('a matrix that holds nothing may not', () => {
    expect(mayConvertRecords(rights(), 'customers')).toBe(false);
  });
});

describe('holdsKnowledge', () => {
  it('compares on the four-rung ladder, in the space\'s own row or the floor, whichever is higher', () => {
    const r = rights({ floor: floorOf({ knowledge: 'read' }), perSpace: rowsOf({ customers: { knowledge: 'write' } }) });
    expect(holdsKnowledge(r, 'customers', 'write')).toBe(true);
    expect(holdsKnowledge(r, 'customers', 'admin')).toBe(false);
    expect(holdsKnowledge(r, 'orders', 'read')).toBe(true);
    expect(holdsKnowledge(r, 'orders', 'write')).toBe(false);
    expect(holdsKnowledge(rights(), 'customers', 'read')).toBe(false);
    expect(holdsKnowledge(rights(), 'customers', 'none')).toBe(true);
  });

  it('an instance administrator and a space administrator hold every rung in their space', () => {
    expect(holdsKnowledge(rights({ instanceAdmin: true }), 'x', 'admin')).toBe(true);
    expect(holdsKnowledge(rights({ spaceAdmin: { floor: false, spaces: ['x'] } }), 'x', 'admin')).toBe(true);
    expect(holdsKnowledge(rights({ spaceAdmin: { floor: false, spaces: ['x'] } }), 'y', 'read')).toBe(false);
  });

  it('is strict about missing rights, as the server is: no matrix holds nothing', () => {
    expect(holdsKnowledge(null, 'x', 'read')).toBe(false);
    expect(holdsKnowledge(undefined, 'x', 'read')).toBe(false);
  });

  it('a rung name it does not know is not held', () => {
    expect(holdsKnowledge(rights({ floor: floorOf({ knowledge: 'admin' }) }), 'x', 'root' as never)).toBe(false);
  });
});

describe('knowledgeAllowed (the display hint: unknown rights count as allowed)', () => {
  it('is true for unknown rights and otherwise what holdsKnowledge says', () => {
    expect(knowledgeAllowed(null, 'x', 'write')).toBe(true);
    expect(knowledgeAllowed(undefined, 'x', 'write')).toBe(true);
    expect(knowledgeAllowed(rights({ floor: floorOf({ knowledge: 'read' }) }), 'x', 'write')).toBe(false);
    expect(knowledgeAllowed(rights({ floor: floorOf({ knowledge: 'write' }) }), 'x', 'write')).toBe(true);
  });
});

describe('isSpaceAdmin (the grant) and holdsSchemaAdmin (the Schema tab\'s check)', () => {
  it('isSpaceAdmin is the grant alone: named, or the floor; an instance administrator is not asked here', () => {
    expect(isSpaceAdmin(rights({ spaceAdmin: { floor: false, spaces: ['a'] } }), 'a')).toBe(true);
    expect(isSpaceAdmin(rights({ spaceAdmin: { floor: false, spaces: ['a'] } }), 'b')).toBe(false);
    expect(isSpaceAdmin(rights({ spaceAdmin: { floor: true, spaces: [] } }), 'b')).toBe(true);
    expect(isSpaceAdmin(rights({ floor: floorOf({ knowledge: 'admin', schema: 'admin' }) }), 'a')).toBe(false);
    expect(isSpaceAdmin(null, 'a')).toBe(false);
  });

  it('holdsSchemaAdmin: the instance administrator, a space administrator, or admin on the schema area in the space or on the floor', () => {
    expect(holdsSchemaAdmin(rights({ instanceAdmin: true }), 's')).toBe(true);
    expect(holdsSchemaAdmin(rights({ spaceAdmin: { floor: false, spaces: ['s'] } }), 's')).toBe(true);
    expect(holdsSchemaAdmin(rights({ spaceAdmin: { floor: true, spaces: [] } }), 's')).toBe(true);
    expect(holdsSchemaAdmin(rights({ perSpace: rowsOf({ s: { schema: 'admin' } }) }), 's')).toBe(true);
    expect(holdsSchemaAdmin(rights({ floor: floorOf({ schema: 'admin' }) }), 's')).toBe(true);
    expect(holdsSchemaAdmin(rights({ perSpace: rowsOf({ s: { schema: 'admin' } }) }), 't')).toBe(false);
    expect(holdsSchemaAdmin(rights({ floor: floorOf({ schema: 'write', knowledge: 'admin' }) }), 's')).toBe(false);
    expect(holdsSchemaAdmin(null, 's')).toBe(false);
  });

  it('holdsSchemaAdmin reads the higher of the space\'s row and the floor, as the server does', () => {
    expect(holdsSchemaAdmin(rights({ floor: floorOf({ schema: 'admin' }), perSpace: rowsOf({ s: { schema: 'read' } }) }), 's')).toBe(true);
  });
});
