/**
 * Linked Data addresses: `GET /ld/...` answers the statements an RDF export writes about the address asked for (bundle-271, Q-758;
 * design §3, r2 R1.3, R1.4, R1.5, R4.6, R5, R8; DEC-2). It replaces the 404 placeholder of Q-750.
 *
 * ## The routes
 *
 * | Route | Rung (on the space whose base holds the address) | Answer |
 * |---|---|---|
 * | `/ld/:spaceId/:kind/:id`, `:kind` one of `entity`, `fact`, `chrono`, `edge` | knowledge read | the record's statements, then those pointing at it |
 * | `/ld/:spaceId/file/*path` | knowledge read, and files read | the file's, likewise |
 * | `/ld/:spaceId/agent/:id` | knowledge read | the agent's statements |
 * | `/ld/:spaceId/` (the base root) | knowledge read | the graph's description as a whole export of the space writes it (`graphDescription`) |
 * | `/ld/:spaceId/schema` | schema read | the ontology's statements (the schema act, `term`) |
 * | `/ld/:spaceId/schema/shape/*path` | schema read | the shape and its property shapes (`#<prop>`), likewise |
 * | `/ld/:spaceId/schema/:fp` | schema read | that schema version as OWL and SHACL (`rdfSchemaExportAct` with the version) |
 * | `/ld/:spaceId/vocab/*path` | schema read | the term's statements in the current schema (the same act, `term`); a type records use and the schema does not declare, its definition (`used`), asked only of a caller who also reads the records |
 *
 * Any other path under `/ld/` answers `404 ld_not_found`, an RFC 9457 problem body (`api/problem-body.ts`), as every refusal here does.
 *
 * ## What it prevents
 *
 * - **Rights read off the URL segment** (r2 R1.3). The address is the public URL (`getPublicBaseUrl`) followed by the request's path, and
 *   the space is the one with RDF on whose base is the longest start of it, never the segment: a renamed space keeps its frozen base, and
 *   another space may hold `<public url>/ld/<other>/` as its explicit base. `requireResolvedRung` asks the rights row of the route (scope
 *   `resolved`, `auth/space-rights.ts`) of that space, then asks the transfer hold as every path door does (`refuseHeldPeer`: a peer token on
 *   a space held for it is `423 space_held`, as the export answers). A space with a base outside the public URL's `/ld/` is not served here.
 * - **An answer that tells who may not read what.** No rung on the space, an address no base holds and a record that is not there answer
 *   the same `404` problem body, byte for byte; a file address without `files: read` answers it too.
 * - **A browser shown a document it cannot read, or a token asked of it.** An `Accept` that prefers `text/html` over every RDF format is
 *   decided first, before authentication: `303` to `/brain?space=<segment>&tab=<the kind's tab>`, reading nothing and naming nothing beyond
 *   the URL the client sent. Every other read is authenticated (`requireAuth`) and rate limited, and every answer says `Vary: Accept`.
 * - **An unbounded answer.** A record's answer reads the quad source of S1 (`match(<address>, ?, ?, ?)`, the chrono entry's `#start` and
 *   `#end` time nodes too, then `match(?, ?, <address>, ?)`) in a slot of family `sparql`, under the query bounds. It holds at most
 *   `sparql.maxResults` statements: the pointing half stops at the cap (counting statements about other records only), at the read's record
 *   bound and at its deadline, and says so (`X-Ythril-Truncated: inbound`), the record's own half answered whole; a record whose own
 *   statements pass the cap is `413 sparql_too_many_results`.
 * - **A second writer or chooser.** Statements are written by the export's writer (`renderGraph`, `createRdfWriter`) in a format the
 *   export's chooser picks from Turtle, N-Quads and JSON-LD; the schema answers by the schema export's act.
 * - **An unaudited read.** `ld.read` (a read: logged with `audit.logReads`) names the space whose base holds the address, the record's id
 *   (`entryId`), and counts only: the kind, the statements answered and whether the pointing half was cut.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { DataFactory } from 'n3';
import { requireAuth, refuseHeldPeer } from '../auth/middleware.js';
import { rungFor } from '../auth/required-rung.js';
import { mayReadArea } from '../auth/reachable-spaces.js';
import type { TokenRights } from '../config/rights-shape.js';
import { getConfig } from '../config/loader.js';
import { getPublicBaseUrl } from '../config/public-url.js';
import { sparqlLimits } from '../config/sparql-limits.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { registeredPathOf } from '../http/route-map.js';
import { preferredByAccept } from '../http/accept-weigh.js';
import { log, peerText } from '../util/log.js';
import { takeSlot, SLOT_FAMILIES } from '../util/slots.js';
import { schemaFingerprintOf } from '../spaces/schema-stamp.js';
import { readSchemaVersionAct } from '../spaces/schema-versions-acts.js';
import { networkIdsSharedWithCaller } from '../networks/network-spaces.js';
import { EXPORT_OK } from '../export/export-statuses.js';
import { chooseRdfFormat, RDF_MEDIA_TYPES, RDF_FORMAT_NOT_ACCEPTABLE } from '../rdf/export-format.js';
import { rdfMembers, type RdfMember } from '../rdf/rdf-members.js';
import { addressNames, recordOfAddress, shapeOfAddress, termOfIri } from '../rdf/term-reverse.js';
import { exportReportIri, graphDescription } from '../rdf/export-act.js';
import { createQuadSource } from '../rdf/quad-source.js';
import { fromRdfJs } from '../rdf/rdf-js-terms.js';
import type { Quad } from '../rdf/literals.js';
import { rdfSchemaExportAct, type UsedType } from '../rdf/schema-export-act.js';
import { renderGraph, SPARQL_GRAPH_FORMATS } from '../rdf/sparql-answer.js';
import {
  sparqlRefusalOf, SPARQL_BUSY, SPARQL_UNAVAILABLE, SPARQL_TOO_LARGE, SPARQL_TOO_MANY_RESULTS, SPARQL_TOO_MUCH_READ, SPARQL_TIMEOUT,
  SPARQL_STORE_UNAVAILABLE,
} from '../rdf/sparql-refusal.js';
import { RDF_NOT_ENABLED, RDF_BASE_SHARED, RDF_BASE_NESTED, RDF_BASE_CONFLICT, RDF_TERM_CLASH, RDF_UNWRITABLE, type RdfCaller } from '../rdf/rdf-space-state.js';
import { sendProblem } from './problem-body.js';

/** An address no reader of this caller may read, of any kind: one code for all of them. */
export const LD_NOT_FOUND = 'ld_not_found';
const NOT_FOUND = 404;
const SEE_OTHER = 303;
const INTERNAL_ERROR = 500;
/** The header that names the half of an answer the cap cut. */
export const LD_TRUNCATED_HEADER = 'X-Ythril-Truncated';

/**
 * Every code a Linked Data address answers: its own, the export chooser's and the space state's (each answered only to a caller who reads
 * the space), the bounds of a read and the slot. Listed in `docs/integration-guide/06f-exports.md` (`every-code-a-linked-data-address-answers-is-listed`).
 */
export const LD_CODES: readonly string[] = Object.freeze([
  LD_NOT_FOUND, RDF_FORMAT_NOT_ACCEPTABLE, RDF_NOT_ENABLED, RDF_BASE_CONFLICT, RDF_BASE_SHARED, RDF_BASE_NESTED, RDF_TERM_CLASH, RDF_UNWRITABLE,
  SPARQL_TOO_MANY_RESULTS, SPARQL_TOO_MUCH_READ, SPARQL_TIMEOUT, SPARQL_STORE_UNAVAILABLE, SPARQL_BUSY,
]);

/** The record kinds `/ld/:spaceId/:kind/:id` answers; a file, an agent, a schema version and a term have routes of their own. */
const RECORD_KINDS: ReadonlySet<string> = new Set(['entity', 'fact', 'chrono', 'edge']);

/** What a route answers, and the Brain tab a browser is sent to for it. */
type LdKind = 'entity' | 'fact' | 'chrono' | 'edge' | 'file' | 'agent' | 'schema' | 'vocab' | 'graph' | 'ontology' | 'shape';
const TAB_OF: Readonly<Record<LdKind, string>> = Object.freeze({
  entity: 'entities', fact: 'facts', chrono: 'chrono', edge: 'edges', file: 'files', agent: 'overview', schema: 'overview', vocab: 'overview',
  graph: 'overview', ontology: 'overview', shape: 'overview',
});
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
/** The media types a browser's `Accept` is weighed against: the RDF formats first, so a tie (`*\/*`) is a machine read. */
const WEIGHED = Object.freeze([...SPARQL_GRAPH_FORMATS.map(f => RDF_MEDIA_TYPES[f]), 'text/html']);

const DETAIL = 'Nothing this caller may read has this address. Under /ld/ an address in a space\'s base (by default <public url>/ld/<space>/) '
  + 'resolves: the base itself, a record, a file, an agent, a vocabulary term, the ontology, a shape or a schema version, read with a token '
  + 'holding read rights on that space. '
  + 'A space\'s records are exported as RDF by GET /api/brain/spaces/{spaceId}/export/rdf (MCP export_rdf), and its schema by '
  + 'GET /api/spaces/{spaceId}/schema-rdf (MCP space_schema_rdf).';

/** The one not-found answer: the same bytes for every reason an address is not answered. */
function sendNotFound(res: Response): void {
  sendProblem(res, { status: NOT_FOUND, title: 'Not found', detail: DETAIL, code: LD_NOT_FOUND });
}

/** What a resolved request carries to its handler. */
interface Resolved { address: string; space: string }
const RESOLVED = new WeakMap<Request, Resolved>();

/** The request's path as sent (percent-encoding kept), without its query. */
const pathOf = (req: Request): string => (req.originalUrl.split('?')[0] ?? '');

/** The space with RDF on whose base is the longest start of `address`, or null. */
function spaceOfAddress(address: string): string | null {
  let best: { id: string; base: string } | null = null;
  for (const s of getConfig().spaces) {
    const rdf = s.meta?.rdf;
    if (rdf?.enabled !== true || typeof rdf.base !== 'string' || rdf.base === '' || !address.startsWith(rdf.base)) continue;
    if (best === null || rdf.base.length > best.base.length) best = { id: s.id, base: rdf.base };
  }
  return best?.id ?? null;
}

/** Let `/:kind/:id` answer the record kinds only; any other kind goes on to the routes after it (the 404). */
function recordKindOnly(req: Request, _res: Response, next: NextFunction): void {
  next(RECORD_KINDS.has(String(req.params['kind'])) ? undefined : 'route');
}

/** Let `/:spaceId/` answer the base root only, which ends in `/`: `/ld/<space>` is no address and goes on to the 404. */
function baseRootOnly(req: Request, _res: Response, next: NextFunction): void {
  next(pathOf(req).endsWith('/') ? undefined : 'route');
}

/** Send a browser to the app, before any token is asked: `303` when `Accept` prefers HTML over every RDF format. */
function browsersToTheApp(kindOf: (req: Request) => LdKind) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.vary('Accept');
    const pick = preferredByAccept(req.headers['accept'], WEIGHED);
    if (pick.kind !== 'chosen' || pick.mediaType !== 'text/html') { next(); return; }
    const space = encodeURIComponent(String(req.params['spaceId']));
    res.redirect(SEE_OTHER, `/brain?space=${space}&tab=${TAB_OF[kindOf(req)]}`);
  };
}

/**
 * The area rung of the route's rights row (scope `resolved`), asked of the space whose base holds the address. Every refusal is the one
 * not-found answer. Records the space for the audit row (`authorisedSpaces`).
 */
function requireResolvedRung(req: Request, res: Response, next: NextFunction): void {
  const verdict = rungFor(req.method, registeredPathOf(req));
  if (verdict.kind !== 'requires' || verdict.scope !== 'resolved') {
    log.warn(`Linked Data: no resolved rights row decides '${peerText(registeredPathOf(req))}' — refused`);
    sendNotFound(res);
    return;
  }
  const address = getPublicBaseUrl() + pathOf(req);
  const space = spaceOfAddress(address);
  const rights = (req.authToken as { rights?: TokenRights | null } | undefined)?.rights;
  if (space === null || !mayReadArea(rights, space, verdict.area)) { sendNotFound(res); return; }
  // After the rung, as on every path door: a token without the rung gets the one not-found answer and never learns the space is held. A
  // peer-bound token on a space held for it (a wipe or deletion only this side has applied) is `423 space_held`, as the export answers it.
  if (refuseHeldPeer(res, space, req.authToken)) return;
  RESOLVED.set(req, { address, space });
  req.authorisedSpaces = [space];
  next();
}

const callerOf = (req: Request): RdfCaller | undefined => req.authToken as RdfCaller | undefined;

/** The member read: the resolved space as RDF for this caller; or the refusal of its state, answered. */
function memberOf(req: Request, res: Response, space: string): RdfMember | null {
  const scope = rdfMembers([space], callerOf(req), schemaFingerprintOf);
  const member = scope.members[0];
  if (member) return member;
  const left = scope.leftOut[0];
  if (left) sendProblem(res, { status: left.status, title: 'Not readable as RDF', detail: left.error, code: left.code, ...(left.detail ? { extra: left.detail } : {}) });
  else sendNotFound(res);
  return null;
}

/**
 * At most `limit` quads of a match that `keep` admits, and whether there were more of them; the stream is closed either way. A quad `keep`
 * refuses is neither counted nor answered, so the cap and the "more" are about the statements the answer would carry.
 */
async function take(stream: AsyncIterable<unknown>, limit: number, keep: (q: unknown) => boolean = () => true): Promise<{ quads: unknown[]; more: boolean }> {
  const quads: unknown[] = [];
  for await (const q of stream) {
    if (!keep(q)) continue;
    if (quads.length >= limit) return { quads, more: true };
    quads.push(q);
  }
  return { quads, more: false };
}

/** A statement in the default graph: an address's answer describes one resource, in one graph. */
const statementOf = (q: unknown): Quad => {
  const { subject, predicate, object } = fromRdfJs(q as never);
  return { subject, predicate, object };
};

/** Answer a refusal the read met (a bound, the store, the deadline) as a problem body, with the wait a 503 tells. */
function sendRefusal(res: Response, err: unknown): boolean {
  const named = sparqlRefusalOf(err);
  if (!named) return false;
  if (named.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(named.retryAfterSeconds));
  sendProblem(res, { status: named.status, title: 'Not answered', detail: named.message, code: named.code });
  return true;
}

/** A slot of family `sparql` for this caller's read of the store; or `null`, the busy answer sent. */
function readSlotOf(req: Request, res: Response): ReturnType<typeof takeSlot> | null {
  const callerKey = (req.authToken as { id?: string } | undefined)?.id ?? req.ip ?? '';
  const slot = takeSlot('sparql', callerKey);
  if (slot) return slot;
  const { retryAfterSeconds, instance, perCaller } = SLOT_FAMILIES.sparql;
  res.setHeader('Retry-After', String(retryAfterSeconds));
  sendProblem(res, {
    status: SPARQL_UNAVAILABLE, title: 'Busy', code: SPARQL_BUSY, extra: { retryAfterSeconds },
    detail: `A read is already running for this caller, or as many as the instance runs at once (${instance}, ${perCaller} per caller): try again when it ends`,
  });
  return null;
}

/** The statements of a record, a file or an agent (`kind`), read from the quad source. */
async function answerStatements(req: Request, res: Response, kind: LdKind): Promise<void> {
  const { address, space } = RESOLVED.get(req)!;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Expose-Headers', `${LD_TRUNCATED_HEADER}, Retry-After`);
  const choice = chooseRdfFormat({ accept: req.headers['accept'], members: 1, offered: SPARQL_GRAPH_FORMATS });
  if (!choice.ok) { sendProblem(res, { status: choice.status, title: 'Not acceptable', detail: choice.error, code: choice.code, extra: { formats: choice.formats } }); return; }
  const member = memberOf(req, res, space);
  if (!member) return;
  const read = recordOfAddress(address, addressNames(member.meta));
  const id = kind === 'agent'
    ? (read.answer === 'other' && read.what === 'agent' ? read.name : undefined)
    : (read.answer === 'record' && read.kind === kind ? read.id : undefined);
  // A file's statements are the caller's only with `files: read`, as on the export: without it the file is not there for them. The quad source
  // withholds a file's statements from a member read without it (`findsOf`), so this check is a second line of defence: the answer would be 404
  // for want of statements anyway, and it keeps that true if the source's predicate ever moves.
  if (id === undefined || (kind === 'file' && !member.files)) { sendNotFound(res); return; }

  const slot = readSlotOf(req, res);
  if (!slot) return;
  const ended = new AbortController();
  res.once('close', () => { if (!res.writableFinished) ended.abort(); });
  try {
    const { timeoutMs, maxResults } = sparqlLimits(getConfig());
    const source = createQuadSource({ members: [space], caller: callerOf(req), fingerprintOf: schemaFingerprintOf }, { deadline: Date.now() + timeoutMs, signal: ended.signal });
    // The chrono entry's time nodes are its own statements: a fragment never travels, so they are answered at the entry's address.
    const subjects = kind === 'chrono' ? [address, `${address}#start`, `${address}#end`] : [address];
    const about: unknown[] = [];
    for (const s of subjects) {
      const got = await take(source.match(DataFactory.namedNode(s), undefined, undefined, undefined) as AsyncIterable<unknown>, maxResults + 1 - about.length);
      about.push(...got.quads);
      if (about.length > maxResults) {
        sendProblem(res, {
          status: SPARQL_TOO_LARGE, title: 'Too many statements', code: SPARQL_TOO_MANY_RESULTS,
          detail: `The address has more than ${maxResults} statements of its own (sparql.maxResults), so none of them is answered: ask a SPARQL query for a part of them`,
        });
        return;
      }
    }
    if (about.length === 0) { sendNotFound(res); return; }
    let pointing: unknown[] = [];
    let truncated = false;
    // An agent is pointed at by every record it wrote: its answer is its own statements.
    if (kind !== 'agent') {
      const own = new Set(subjects);
      try {
        // A statement of the record's own (a self-reference) is answered in its own half: it is filtered before the cap counts, so an answer
        // that fits the cap is not called cut because of a statement it would not carry twice.
        const got = await take(source.match(undefined, undefined, DataFactory.namedNode(address), undefined) as AsyncIterable<unknown>, maxResults - about.length,
          q => !own.has((q as { subject: { value: string } }).subject.value));
        pointing = got.quads;
        truncated = got.more;
      } catch (err) {
        // The pointing half stops at a bound of the read (the records read, the time) as it stops at the cap: what was read about the record is
        // answered whole, and the answer says its inbound half was cut.
        const named = sparqlRefusalOf(err);
        if (named?.code !== SPARQL_TOO_MUCH_READ && named?.code !== SPARQL_TIMEOUT) throw err;
        truncated = true;
      }
    }
    const statements = [...about, ...pointing].map(statementOf);
    const rendered = renderGraph(choice.format, statements);
    if ('code' in rendered) { sendProblem(res, { status: rendered.status, title: 'Not writable', detail: rendered.error, code: rendered.code }); return; }
    if (truncated) res.setHeader(LD_TRUNCATED_HEADER, 'inbound');
    req.auditEntryId = id;
    req.auditChangesExplicit = [{ field: 'kind', to: kind }, { field: 'statements', to: statements.length }, { field: 'truncated', to: truncated }];
    res.status(EXPORT_OK).setHeader('Content-Type', rendered.contentType);
    res.end(rendered.body);
  } catch (err) {
    if (ended.signal.aborted) return;
    if (!sendRefusal(res, err)) throw err;
  } finally {
    slot.release();
  }
}

/**
 * The base root (`<base>`), the graph a space's records are in: the statements the records export's description writes about it
 * (`graphDescription`, as a whole export of this one space writes them: its report, and its shapes at the current version). Knowledge read.
 */
async function answerGraph(req: Request, res: Response): Promise<void> {
  const { address, space } = RESOLVED.get(req)!;
  res.setHeader('Cache-Control', 'no-store');
  const choice = chooseRdfFormat({ accept: req.headers['accept'], members: 1, offered: SPARQL_GRAPH_FORMATS });
  if (!choice.ok) { sendProblem(res, { status: choice.status, title: 'Not acceptable', detail: choice.error, code: choice.code, extra: { formats: choice.formats } }); return; }
  const member = memberOf(req, res, space);
  if (!member) return;
  const read = recordOfAddress(address, addressNames(member.meta));
  if (read.answer !== 'other' || read.what !== 'graph') { sendNotFound(res); return; }
  const report = exportReportIri([{ space: member.space, fingerprint: member.fingerprint }], undefined, undefined);
  const statements = graphDescription(member.meta, member.fingerprint, report);
  const rendered = renderGraph(choice.format, statements);
  if ('code' in rendered) { sendProblem(res, { status: rendered.status, title: 'Not writable', detail: rendered.error, code: rendered.code }); return; }
  req.auditChangesExplicit = [{ field: 'kind', to: 'graph' }, { field: 'statements', to: statements.length }, { field: 'truncated', to: false }];
  res.status(EXPORT_OK).setHeader('Content-Type', rendered.contentType);
  res.end(rendered.body);
}

/**
 * The type a vocab address names when the space's schema does not declare it (`termOfIri` reads it by the Direct Mapping alone), or
 * undefined for any other address: a declared term, a property, a file's document.
 */
function undeclaredTypeOf(address: string, meta: RdfMember['meta']): UsedType | undefined {
  const term = termOfIri(address, addressNames(meta));
  if (term.answer !== 'term' || term.of !== 'space' || term.how !== 'vocabulary') return undefined;
  const owner = term.owners[0];
  if (owner === undefined || owner.prop !== undefined || owner.type === null || owner.kind === 'file') return undefined;
  return { kind: owner.kind, type: owner.type };
}

/**
 * Does a record of the space use the undeclared type at `address`: a record typed with it (`?s rdf:type <address>`), or for an edge label
 * an edge under it (`?s <address> ?o`)? One statement of the quad source, read in a slot of family `sparql` under the query bounds. Asked
 * only of a caller who reads the records (`knowledge: read`): the vocab address is read with schema read, and it must not tell such a
 * caller that a record of a type exists. `null` when the answer (busy, a bound) was sent.
 */
async function typeInUse(req: Request, res: Response, space: string, address: string, used: UsedType): Promise<boolean | null> {
  const rights = (req.authToken as { rights?: TokenRights | null } | undefined)?.rights;
  if (!mayReadArea(rights, space, 'knowledge')) return false;
  const slot = readSlotOf(req, res);
  if (!slot) return null;
  const ended = new AbortController();
  res.once('close', () => { if (!res.writableFinished) ended.abort(); });
  try {
    const { timeoutMs } = sparqlLimits(getConfig());
    const source = createQuadSource({ members: [space], caller: callerOf(req), fingerprintOf: schemaFingerprintOf }, { deadline: Date.now() + timeoutMs, signal: ended.signal });
    const term = DataFactory.namedNode(address);
    const stream = used.kind === 'edge' ? source.match(undefined, term, undefined, undefined) : source.match(undefined, DataFactory.namedNode(RDF_TYPE), term, undefined);
    return (await take(stream as AsyncIterable<unknown>, 1)).quads.length > 0;
  } catch (err) {
    if (ended.signal.aborted) return null;
    if (sendRefusal(res, err)) return null;
    throw err;
  } finally {
    slot.release();
  }
}

/**
 * A schema version (`schema/:fp`), the ontology (`schema`), a shape (`schema/shape/<kind>/<type>`) or a vocabulary term (`vocab/...`),
 * answered by the schema export's act; a vocab address of a type records use and the schema does not declare by the act's `used`.
 */
async function answerSchema(req: Request, res: Response, kind: 'schema' | 'vocab' | 'ontology' | 'shape'): Promise<void> {
  const { address, space } = RESOLVED.get(req)!;
  res.setHeader('Cache-Control', 'no-store');
  const member = memberOf(req, res, space);
  if (!member) return;
  const token = req.authToken as { rights?: TokenRights | null } | undefined;
  let version: { fingerprint: string; typeSchemas: Record<string, unknown>; rules: Record<string, unknown> } | undefined;
  let used: UsedType | undefined;
  if (kind === 'ontology') {
    const read = recordOfAddress(address, addressNames(member.meta));
    if (read.answer !== 'other' || read.what !== 'ontology') { sendNotFound(res); return; }
  } else if (kind === 'shape') {
    const read = shapeOfAddress(address, addressNames(member.meta));
    if (read.answer !== 'shape' || read.of !== 'space') { sendNotFound(res); return; }
  } else if (kind === 'vocab') {
    const undeclared = undeclaredTypeOf(address, member.meta);
    if (undeclared !== undefined) {
      const inUse = await typeInUse(req, res, space, address, undeclared);
      if (inUse === null) return;
      if (inUse) used = undeclared;
    }
  } else {
    const read = recordOfAddress(address, addressNames(member.meta));
    if (read.answer !== 'other' || read.what !== 'schema-version' || read.name === undefined) { sendNotFound(res); return; }
    // The version's read asks what the schema versions door asks: a peer-bound token has only what the sync door serves it.
    const held = await readSchemaVersionAct(space, read.name, {}, {
      shared: networkIdsSharedWithCaller(space, req.authToken as object | undefined), transport: 'rest', rights: token?.rights,
    });
    if (held.status !== EXPORT_OK) { sendNotFound(res); return; }
    const schema = (held.body['schema'] ?? {}) as { typeSchemas?: Record<string, unknown>; rules?: Record<string, unknown> };
    version = { fingerprint: read.name, typeSchemas: schema.typeSchemas ?? {}, rules: schema.rules ?? {} };
  }
  const outcome = rdfSchemaExportAct({
    spaceId: space, accept: req.headers['accept'], caller: callerOf(req), fingerprintOf: schemaFingerprintOf, formats: SPARQL_GRAPH_FORMATS,
    ...(version ? { version } : { term: address }), ...(used ? { used } : {}),
  });
  if (outcome.status !== EXPORT_OK) {
    sendProblem(res, { status: outcome.status, title: 'Not answered', detail: outcome.error, code: outcome.code, ...(outcome.detail ? { extra: outcome.detail } : {}) });
    return;
  }
  if (outcome.statements === 0) { sendNotFound(res); return; }
  if (version) req.auditEntryId = version.fingerprint;
  req.auditChangesExplicit = [{ field: 'kind', to: kind }, { field: 'statements', to: outcome.statements }, { field: 'truncated', to: false }];
  res.status(EXPORT_OK).setHeader('Content-Type', outcome.contentType);
  res.end(outcome.text);
}

/** A handler that answers a failure nobody named as a problem body, logged. */
function answered(route: string, handle: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handle(req, res).catch((err: unknown) => {
      // The class only: a store or driver message can carry the query, the address and the ids around it, and the log is read by more than may read the space.
      log.error(`${route}: ${err instanceof Error ? err.constructor.name : typeof err}`);
      if (!res.headersSent) sendProblem(res, { status: INTERNAL_ERROR, title: 'Internal server error', detail: 'The address could not be read; the server log says why' });
    });
  };
}

export const linkedDataRouter = Router();

const kindParam = (req: Request): LdKind => String(req.params['kind']) as LdKind;
const fixed = (k: LdKind) => (): LdKind => k;

// GET /ld/:spaceId/ - the base root: the graph the space's records are in, described as the export describes it; knowledge read.
linkedDataRouter.get('/:spaceId/', baseRootOnly, globalRateLimit, browsersToTheApp(fixed('graph')), requireAuth, requireResolvedRung,
  answered('GET /ld/:spaceId/', answerGraph));
// GET /ld/:spaceId/schema - the ontology (the shapes graph's description), schema read.
linkedDataRouter.get('/:spaceId/schema', globalRateLimit, browsersToTheApp(fixed('ontology')), requireAuth, requireResolvedRung,
  answered('GET /ld/:spaceId/schema', (req, res) => answerSchema(req, res, 'ontology')));
// GET /ld/:spaceId/schema/shape/... - one SHACL shape with its property shapes (`#<prop>` is read at its document), schema read.
linkedDataRouter.get('/:spaceId/schema/shape/*path', globalRateLimit, browsersToTheApp(fixed('shape')), requireAuth, requireResolvedRung,
  answered('GET /ld/:spaceId/schema/shape/*path', (req, res) => answerSchema(req, res, 'shape')));
// GET /ld/:spaceId/schema/:fp - a schema version as OWL and SHACL, schema read on the space whose base holds the address.
linkedDataRouter.get('/:spaceId/schema/:fp', globalRateLimit, browsersToTheApp(fixed('schema')), requireAuth, requireResolvedRung,
  answered('GET /ld/:spaceId/schema/:fp', (req, res) => answerSchema(req, res, 'schema')));
// GET /ld/:spaceId/vocab/... - a vocabulary term's statements, schema read on the space whose base holds the address.
linkedDataRouter.get('/:spaceId/vocab/*path', globalRateLimit, browsersToTheApp(fixed('vocab')), requireAuth, requireResolvedRung,
  answered('GET /ld/:spaceId/vocab/*path', (req, res) => answerSchema(req, res, 'vocab')));
// GET /ld/:spaceId/agent/:id - the statements about the instance that wrote records, knowledge read.
linkedDataRouter.get('/:spaceId/agent/:id', globalRateLimit, browsersToTheApp(fixed('agent')), requireAuth, requireResolvedRung,
  answered('GET /ld/:spaceId/agent/:id', (req, res) => answerStatements(req, res, 'agent')));
// GET /ld/:spaceId/file/... - a file's statements, knowledge read and files read.
linkedDataRouter.get('/:spaceId/file/*path', globalRateLimit, browsersToTheApp(fixed('file')), requireAuth, requireResolvedRung,
  answered('GET /ld/:spaceId/file/*path', (req, res) => answerStatements(req, res, 'file')));
// GET /ld/:spaceId/:kind/:id - a record's statements (entity, fact, chrono, edge), knowledge read.
linkedDataRouter.get('/:spaceId/:kind/:id', recordKindOnly, globalRateLimit, browsersToTheApp(kindParam), requireAuth, requireResolvedRung,
  answered('GET /ld/:spaceId/:kind/:id', (req, res) => answerStatements(req, res, kindParam(req))));
// Anything else under /ld/ is no address: the one not-found answer, to every caller and every Accept.
linkedDataRouter.use((_req, res) => { res.vary('Accept'); sendNotFound(res); });
