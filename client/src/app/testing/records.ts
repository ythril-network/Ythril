import type { Fact, Entity, Edge, ChronoEntry } from '../core/api.types';

/**
 * Valid record fixtures for component specs, with the server-assigned fields already filled in.
 *
 * ## Why these exist
 *
 * Every spec that needed a memory wrote `{ _id: 'm1', fact: 'x', tags: [] }` and left out `createdAt`,
 * `updatedAt` and `seq` — the fields the server always sets and the interfaces require. Twenty such literals
 * meant twenty type errors, and worse: adding a required field to `Fact` meant editing twenty specs, so the
 * pressure was always to loosen the type rather than complete the fixture. `updatedAt` had gone missing from
 * three client interfaces for exactly that reason.
 *
 * One factory per kind, overridable, so the type stays honest and a new required field is one edit here.
 *
 * ## The values are deliberately boring and deliberately DISTINCT
 *
 * A fixed timestamp rather than `new Date()`: a spec that renders a date and asserts on it must not depend on
 * when it ran, and a rendered date is formatted in the RUNNER's zone — an exact assertion passes in CEST and
 * fails on CI in UTC. `createdAt` and `updatedAt` differ, because a fixture where they match cannot catch code
 * that reads the wrong one.
 */

/** 2026-01-01T00:00:00Z, chosen for being unambiguous in every zone the suite might run in. */
const CREATED = '2026-01-01T00:00:00.000Z';
/** A day later, so "created" and "updated" are never interchangeable in an assertion. */
const UPDATED = '2026-01-02T00:00:00.000Z';

export function aMemory(over: Partial<Fact> = {}): Fact {
  return {
    _id: 'm1',
    fact: 'a fact',
    tags: [],
    entityIds: [],
    properties: {},
    createdAt: CREATED,
    updatedAt: UPDATED,
    seq: 1,
    ...over,
  };
}

export function anEntity(over: Partial<Entity> = {}): Entity {
  return {
    _id: 'e1',
    name: 'An Entity',
    tags: [],
    properties: {},
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...over,
  };
}

export function anEdge(over: Partial<Edge> = {}): Edge {
  return {
    _id: 'x1',
    from: 'e1',
    to: 'e2',
    label: 'relates_to',
    tags: [],
    properties: {},
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...over,
  };
}

export function aChrono(over: Partial<ChronoEntry> = {}): ChronoEntry {
  return {
    _id: 'c1',
    spaceId: 'general',
    title: 'An Event',
    type: 'event',
    startsAt: CREATED,
    status: 'upcoming',
    tags: [],
    entityIds: [],
    memoryIds: [],
    properties: {},
    author: { instanceId: 'test-instance', instanceLabel: 'Test Instance' },
    createdAt: CREATED,
    updatedAt: UPDATED,
    seq: 1,
    ...over,
  };
}
