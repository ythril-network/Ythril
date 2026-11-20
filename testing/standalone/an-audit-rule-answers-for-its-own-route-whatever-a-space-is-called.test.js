/**
 * No audit rule answers for another route's path because of what a space is called (bundle-269, review finding 3).
 *
 * ## What it prevents
 *
 * The brain rules in `ROUTE_RULES` read the space out of `/api/brain/(?:spaces/)?<space>/...`, the `spaces/` being optional. A space whose id
 * is a word a rule names after the space (`facts`, `entities`, `edges`, `chrono`, `files`) made that optional part ambiguous:
 * `GET /api/brain/spaces/files/export/rdf` could be read as the space `spaces` with the tail `files/export/rdf`, which the file-list rule
 * (a prefix, no end) answered, so the export was recorded as `file.list` of a space `spaces` - a read, dropped when `audit.logReads` is
 * off - and the records export of that space left no row. Any rule placed after one of the five could be lost the same way (a `PATCH` of
 * the file metadata of a space called `facts` was the fact rule's).
 *
 * ## What it holds
 *
 * For each of those words, and for `spaces`, as the space id, each brain route of the space is recorded under the operation of its own
 * rule, with the space id as sent. The expected outcomes are written out here by hand (not derived from the rules), one row per route.
 *
 * Run: node --test testing/standalone/an-audit-rule-answers-for-its-own-route-whatever-a-space-is-called.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { resolveOperation } = await import('../../server/dist/audit/middleware.js');

const WORDS = ['facts', 'entities', 'edges', 'chrono', 'files', 'spaces'];

/** Each brain route of a space: method, the path after the space, the operation of its own rule, whether it is a read, and the entry it names. */
const ROUTES = [
  ['POST', '/facts', 'fact.create', false, null],
  ['PATCH', '/facts/f1', 'fact.update', false, 'f1'],
  ['DELETE', '/facts/f1', 'fact.delete', false, 'f1'],
  ['POST', '/entities', 'entity.create', false, null],
  ['PATCH', '/entities/e1', 'entity.update', false, 'e1'],
  ['DELETE', '/entities/e1', 'entity.delete', false, 'e1'],
  ['POST', '/entities/e1/merge/e2', 'entity.merge', false, 'e1'],
  ['GET', '/entities/e1/cascade-preview', 'entity.cascade_preview', true, 'e1'],
  ['POST', '/edges', 'edge.create', false, null],
  ['PATCH', '/edges/g1', 'edge.update', false, 'g1'],
  ['DELETE', '/edges/g1', 'edge.delete', false, 'g1'],
  ['POST', '/links', 'link.create', false, null],
  ['DELETE', '/links/l1', 'link.delete', false, 'l1'],
  ['POST', '/chrono', 'chrono.create', false, null],
  ['PATCH', '/chrono/c1', 'chrono.update', false, 'c1'],
  ['DELETE', '/chrono/c1', 'chrono.delete', false, 'c1'],
  ['GET', '/files/extract', 'file.list', true, null],
  ['PATCH', '/files', 'file.meta.update', false, null],
  ['POST', '/reindex', 'space.reindex', false, null],
  ['POST', '/bulk', 'bulk.write', false, null],
  ['POST', '/ingest', 'brain.ingest', false, null],
  ['GET', '/ingest/run1', 'brain.ingest.status', true, null],
  ['POST', '/traverse', 'brain.traverse', true, null],
  ['POST', '/events/ticket', 'brain.events.ticket', true, null],
  ['GET', '/stats', 'brain.stats', true, null],
  ['GET', '/forks', 'fork.list', true, null],
  ['POST', '/forks/k1/resolve', 'fork.resolve', false, 'k1'],
  ['POST', '/embedding-queue/media/retry-failed', 'file.retry_embedding_all', false, null],
  ['POST', '/embedding-queue/records/retry', 'brain.retry_embedding', false, null],
  // The records export is an act, written whichever way `audit.logReads` is set: never a read.
  ['GET', '/export/rdf', 'rdf.export', false, null],
];

describe('a brain route is recorded under its own rule whatever the space is called', () => {
  for (const word of WORDS) {
    for (const [method, tail, operation, read, entry] of ROUTES) {
      const sent = `/api/brain/spaces/${word}${tail}`;
      it(`${method} ${sent} is ${operation} of the space '${word}'`, () => {
        const hit = resolveOperation(method, sent);
        assert.ok(hit, `${method} ${sent} leaves no row at all`);
        assert.deepEqual(
          { operation: hit.operation, spaceId: hit.spaceId, entryId: hit.entryId, read: hit.read },
          { operation, spaceId: word, entryId: entry, read },
          `${method} ${sent} is recorded as ${hit.operation} of the space '${hit.spaceId}'`,
        );
      });
    }
  }

  it('a neutral space name resolves the same table (the expected rows are the rules\' own)', () => {
    for (const [method, tail, operation, read, entry] of ROUTES) {
      const hit = resolveOperation(method, `/api/brain/spaces/notes${tail}`);
      assert.deepEqual({ operation: hit?.operation, spaceId: hit?.spaceId, entryId: hit?.entryId, read: hit?.read }, { operation, spaceId: 'notes', entryId: entry, read }, `${method} ${tail}`);
    }
  });
});
