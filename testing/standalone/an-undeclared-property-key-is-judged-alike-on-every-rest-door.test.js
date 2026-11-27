/**
 * The doors the undeclared-key gate drives are the doors the router mounts (Q-93; split out by Q-969).
 *
 * The database half, `an-undeclared-property-key-is-judged-alike-on-every-rest-door-db.test.js`, drives every REST door that stores a record from a body
 * and holds that a key the type does not declare is judged alike on each. Which doors it must drive is the question asked here, and it needs no
 * database: the doors are DERIVED from the router source (`mountedRoutesWithSource`: every POST/PATCH under `/api/brain/` that stores a record from a
 * body), floored, and held to the table both files read (`_undeclared-key-door-routes.mjs`). A table written by hand is the door added next year
 * simply not in it. The case sat in the `-db` file, so the local preflight never ran it.
 *
 * Run: node --test testing/standalone/an-undeclared-property-key-is-judged-alike-on-every-rest-door.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mountedRoutesWithSource } from './_routes.mjs';
import { KINDS, SEGMENT, routesOf } from './_undeclared-key-door-routes.mjs';

describe('an undeclared property key is judged alike on every REST door', () => {
  it('the doors under test are the doors the router mounts', () => {
    // Derived from the router source: every POST/PATCH that stores a record from a body, under the brain API.
    const mounted = mountedRoutesWithSource().filter(r => r.path.startsWith('/api/brain/') && (r.method === 'POST' || r.method === 'PATCH'));
    const storing = mounted.filter(r => /\b(upsert(Entity|Edge|Fact|Chrono)|update(Entity|Edge|Fact|Chrono)ById|bulkWrite)\s*\(/.test(r.source)
      || new RegExp(`^/api/brain/spaces/:spaceId/(${Object.values(SEGMENT).join('|')})(/:id)?$`).test(r.path));
    const derived = new Set(storing.map(r => `${r.method} ${r.path}`));
    assert.ok(derived.size >= 9, `only ${derived.size} storing REST doors derived — the derivation stopped matching: ${[...derived]}`);
    const mine = new Set(KINDS.flatMap(kind => Object.values(routesOf(kind))).map(([method, path]) => `${method} ${path}`));
    const missing = [...derived].filter(k => !mine.has(k));
    assert.deepEqual(missing, [], `a REST door stores a record from a body and this file holds no case for it: ${missing}`);
    const gone = [...mine].filter(k => !derived.has(k));
    assert.deepEqual(gone, [], `this file drives a door the router no longer mounts: ${gone}`);
  });
});
