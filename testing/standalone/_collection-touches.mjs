/**
 * Does this source open a collection or call a driver `Collection` method — the question "does it touch the store".
 *
 * ## Why it is a module
 *
 * `a-write-planner-touches-no-collection` asks it of every `plan-*.ts`; `an-edge-refusal-writes-nothing-and-embeds-
 * nothing` asks it of the file the edge refusal lives in, which need not be named `plan-*.ts`. Two copies of the
 * opener list is the second implementation of a rule — the one that drifts: a new way to open a collection added to
 * one list protects half the subjects. The method list is DERIVED from the table `db/record-write-observer.ts`
 * classifies, never listed, less the names an array, map, set, string or promise also has.
 *
 * Needs `server/dist` built, like the gate it was lifted from.
 */
const { COLLECTION_METHOD_EFFECT } = await import('../../server/dist/db/record-write-observer.js');

const AMBIENT = [Array.prototype, Map.prototype, Set.prototype, String.prototype, Promise.prototype, Object.prototype];

/** Collection methods that cannot be mistaken for a method of an ordinary value. */
export const COLLECTION_METHODS = Object.keys(COLLECTION_METHOD_EFFECT).filter(m => !AMBIENT.some(p => m in p));

export const OPENERS = [
  { what: 'opens a collection with col(…)', re: /(^|[^\w$.])col\s*(<[^>(]*>)?\s*\(/ },
  { what: 'opens the database with getDb()', re: /\bgetDb\s*\(/ },
  { what: 'opens a collection with .collection(…)', re: /\.\s*collection\s*(<[^>(]*>)?\s*\(/ },
  { what: 'names a collection with spaceCollection(…)', re: /\bspaceCollection\s*\(/ },
  { what: 'imports a value from mongodb', re: /import\s+(?!type\b)[^;]*from\s+['"]mongodb['"]/ },
  { what: 'imports from db/mongo', re: /import\s+(?!type\b)[^;]*from\s+['"][./]*db\/mongo(\.js)?['"]/ },
];

/** What in this (comment-stripped) source touches a collection, one sentence each. */
export function collectionTouches(src) {
  const out = [];
  for (const { what, re } of OPENERS) if (re.test(src)) out.push(what);
  for (const m of COLLECTION_METHODS) {
    if (new RegExp(String.raw`\.\s*${m}\s*(<[^>(]*>)?\s*\(`).test(src)) out.push(`calls .${m}(`);
  }
  return out;
}
