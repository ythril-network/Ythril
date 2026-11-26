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
import { requireAuth, refuseHeldPeer } from '../auth/middleware.js';
import { rungFor } from '../auth/required-rung.js';
import { mayReadArea } from '../auth/reachable-spaces.js';
import type { TokenRights } from '../config/rights-shape.js';
import { getPublicBaseUrl } from '../config/public-url.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { registeredPathOf } from '../http/route-map.js';
import { preferredByAccept } from '../http/accept-weigh.js';
import { abortWhenClientGoes, slotCallerKey } from '../http/read-caller.js';
import { log, peerText, NAME_QUOTED } from '../util/log.js';
import { schemaFingerprintOf } from '../spaces/schema-stamp.js';
import { readSchemaVersionAct } from '../spaces/schema-versions-acts.js';
import { networkIdsSharedWithCaller } from '../networks/network-spaces.js';
import { EXPORT_OK } from '../export/export-statuses.js';
import { chooseRdfFormat, RDF_MEDIA_TYPES, RDF_FORMAT_NOT_ACCEPTABLE } from '../rdf/export-format.js';
import { rdfMembers, type RdfMember } from '../rdf/rdf-members.js';
import { addressNames, recordOfAddress, shapeOfAddress } from '../rdf/term-reverse.js';
import { exportReportIri, graphDescription } from '../rdf/export-act.js';
import { rdfSchemaExportAct, type UsedType, type UsedProperties } from '../rdf/schema-export-act.js';
import { renderGraph } from '../rdf/graph-render.js';
import { SPARQL_GRAPH_FORMATS } from '../rdf/sparql-answer.js';
import { readStatements, typeInUse, usedPropertiesOf, spaceOfAddress, undeclaredTypeOf, untypedKindOf, type LdRefusal, type LdStatementsKind } from '../rdf/linked-data-act.js';
import { SPARQL_BUSY, SPARQL_TOO_MANY_RESULTS, SPARQL_ANSWER_TOO_LARGE, SPARQL_TOO_MUCH_READ, SPARQL_TIMEOUT, SPARQL_STORE_UNAVAILABLE } from '../rdf/sparql-refusal.js';
import { rdfSpaceState, RDF_NOT_ENABLED, RDF_BASE_SHARED, RDF_BASE_NESTED, RDF_BASE_CONFLICT, RDF_TERM_CLASH, RDF_UNWRITABLE, type RdfCaller } from '../rdf/rdf-space-state.js';
import { getConfig } from '../config/loader.js';
import { sendProblem } from './problem-body.js';
import { isViewId, resolveOwnView, viewOwnerOf, viewReadMembers, type ViewOwnerSource } from '../config/views.js';
import type { ViewRecord } from '../config/types.js';
import { peerBoundTo } from '../auth/peer-bound.js';
import { takeSlot } from '../util/slots.js';
import { busyRefusal, sparqlRefusalOf } from '../rdf/sparql-refusal.js';
import { sparqlLimits } from '../config/sparql-limits.js';
import { createQuadSource } from '../rdf/quad-source.js';
import { readAcrossSwaps } from '../rdf/read-across-swaps.js';
import { fromRdfJs } from '../rdf/rdf-js-terms.js';
import { constructStatements, VIEW_CONSTRUCT_TOO_LARGE } from '../rdf/view-construct.js';

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
  SPARQL_TOO_MANY_RESULTS, SPARQL_ANSWER_TOO_LARGE, SPARQL_TOO_MUCH_READ, SPARQL_TIMEOUT, SPARQL_STORE_UNAVAILABLE, SPARQL_BUSY,
  VIEW_CONSTRUCT_TOO_LARGE,
]);

/** The record kinds `/ld/:spaceId/:kind/:id` answers; a file, an agent, a schema version and a term have routes of their own. */
const RECORD_KINDS: ReadonlySet<string> = new Set(['entity', 'fact', 'chrono', 'edge']);

/** What a route answers, and the Brain tab a browser is sent to for it. */
type LdKind = 'entity' | 'fact' | 'chrono' | 'edge' | 'file' | 'agent' | 'schema' | 'vocab' | 'graph' | 'ontology' | 'shape';
const TAB_OF: Readonly<Record<LdKind, string>> = Object.freeze({
  entity: 'entities', fact: 'facts', chrono: 'chrono', edge: 'edges', file: 'files', agent: 'overview', schema: 'overview', vocab: 'overview',
  graph: 'overview', ontology: 'overview', shape: 'overview',
});
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
 * The space's settled RDF names for a schema address, read with the schema rung alone: the routes of the schema graph ask `schema: read`, so
 * a token holding that and no records right reads them (a member read asks `knowledge: read` too, and would answer such a token 404).
 */
function schemaStateOf(req: Request, res: Response, space: string): { meta: RdfMember['meta'] } | null {
  const state = rdfSpaceState(getConfig(), space, callerOf(req), schemaFingerprintOf);
  if (state.ok) return state;
  sendProblem(res, { status: state.status, title: 'Not readable as RDF', detail: state.error, code: state.code, ...(state.detail ? { extra: state.detail } : {}) });
  return null;
}

/**
 * Answer a refusal of a read (a bound, the store, the deadline, a slot that is spent) as a problem body, with the wait a 503 tells, and log it:
 * the code and the status, never the address (a refusal at this door was a silent 4xx or 5xx; the operator reads these lines to see a bound hit).
 */
function sendLdRefusal(res: Response, r: LdRefusal): void {
  log.warn(`Linked Data read refused (${peerText(r.code, { max: NAME_QUOTED })}, status ${r.status})`);
  if (r.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(r.retryAfterSeconds));
  sendProblem(res, { status: r.status, title: r.title, detail: r.detail, code: r.code, ...(r.retryAfterSeconds !== undefined ? { extra: { retryAfterSeconds: r.retryAfterSeconds } } : {}) });
}

/** The statements of a record, a file or an agent (`kind`), read from the quad source by the act. */
async function answerStatements(req: Request, res: Response, kind: LdStatementsKind): Promise<void> {
  const { address, space } = RESOLVED.get(req)!;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Expose-Headers', `${LD_TRUNCATED_HEADER}, Retry-After`);
  const choice = chooseRdfFormat({ accept: req.headers['accept'], members: 1, offered: SPARQL_GRAPH_FORMATS });
  if (!choice.ok) { sendProblem(res, { status: choice.status, title: 'Not acceptable', detail: choice.error, code: choice.code, extra: { formats: choice.formats } }); return; }
  const member = memberOf(req, res, space);
  if (!member) return;
  const outcome = await readStatements({ address, space, member, kind, caller: callerOf(req), callerKey: slotCallerKey(req), signal: abortWhenClientGoes(res) });
  if (outcome.answer === 'gone') return;
  if (outcome.answer === 'not-found') { sendNotFound(res); return; }
  if (outcome.answer === 'refused') { sendLdRefusal(res, outcome.refusal); return; }
  const rendered = renderGraph(choice.format, outcome.statements);
  if ('code' in rendered) { sendProblem(res, { status: rendered.status, title: 'Not writable', detail: rendered.error, code: rendered.code }); return; }
  if (outcome.truncated) res.setHeader(LD_TRUNCATED_HEADER, 'inbound');
  req.auditEntryId = outcome.id;
  req.auditChangesExplicit = [{ field: 'kind', to: kind }, { field: 'statements', to: outcome.statements.length }, { field: 'truncated', to: outcome.truncated }];
  res.status(EXPORT_OK).setHeader('Content-Type', rendered.contentType);
  res.end(rendered.body);
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
 * A schema version (`schema/:fp`), the ontology (`schema`), a shape (`schema/shape/<kind>/<type>`) or a vocabulary term (`vocab/...`),
 * answered by the schema export's act; a vocab address of a type records use and the schema does not declare by the act's `used`.
 */
async function answerSchema(req: Request, res: Response, kind: 'schema' | 'vocab' | 'ontology' | 'shape'): Promise<void> {
  const { address, space } = RESOLVED.get(req)!;
  res.setHeader('Cache-Control', 'no-store');
  const member = schemaStateOf(req, res, space);
  if (!member) return;
  const token = req.authToken as { rights?: TokenRights | null } | undefined;
  let version: { fingerprint: string; typeSchemas: Record<string, unknown>; rules: Record<string, unknown> } | undefined;
  let used: UsedType | undefined;
  let usedProperties: UsedProperties | undefined;
  if (kind === 'ontology') {
    const read = recordOfAddress(address, addressNames(member.meta));
    if (read.answer !== 'other' || read.what !== 'ontology') { sendNotFound(res); return; }
  } else if (kind === 'shape') {
    const read = shapeOfAddress(address, addressNames(member.meta));
    if (read.answer !== 'shape' || read.of !== 'space') { sendNotFound(res); return; }
  } else if (kind === 'vocab') {
    const untyped = untypedKindOf(address, member.meta);
    if (untyped !== undefined) {
      // The document of an untyped kind (`vocab/file`): the properties its records use, each `rdf:type rdf:Property` with its label.
      const found = await usedPropertiesOf({ space, meta: member.meta, address, kind: untyped, caller: callerOf(req), rights: token?.rights, callerKey: slotCallerKey(req), signal: abortWhenClientGoes(res) });
      if (found.answer === 'gone') return;
      if (found.answer === 'refused') { sendLdRefusal(res, found.refusal); return; }
      if (found.answer === 'read' && found.names.length > 0) usedProperties = { kind: untyped, names: found.names };
    }
    const undeclared = undeclaredTypeOf(address, member.meta);
    if (undeclared !== undefined) {
      const inUse = await typeInUse({ space, address, used: undeclared, caller: callerOf(req), rights: token?.rights, callerKey: slotCallerKey(req), signal: abortWhenClientGoes(res) });
      if (inUse.answer === 'gone') return;
      if (inUse.answer === 'refused') { sendLdRefusal(res, inUse.refusal); return; }
      if (inUse.answer === 'read' && inUse.used) used = undeclared;
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
    ...(version ? { version } : { term: address }), ...(used ? { used } : {}), ...(usedProperties ? { usedProperties } : {}),
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

/** The caller's own SPARQL view the base root's segment names (Q-762), or null: a space, a plain view and another token's view go on. */
function ownConstructView(req: Request): (ViewRecord & { sparql: { query: string } }) | null {
  const id = String(req.params['spaceId'] ?? '');
  if (!isViewId(id)) return null;
  const view = resolveOwnView(viewOwnerOf(req.authToken as ViewOwnerSource), id);
  return view?.sparql ? { ...view, sparql: view.sparql } : null;
}

/**
 * The address of the caller's own SPARQL view (`/ld/@<name>/`, Q-762): the statements its CONSTRUCT makes over its members as the caller
 * reads them (the members `viewReadMembers` accepts in the knowledge area, each read again with the caller's rights by the quad source), in
 * a slot of family `sparql`, under the query bounds and the view's cap of statements. Its owner's alone: any other caller, and a plain view,
 * get the one not-found answer, by the routes after this one.
 */
function constructViewFirst(req: Request, res: Response, next: NextFunction): void {
  const view = ownConstructView(req);
  if (!view) { next(); return; }
  answered('GET /ld/:spaceId/', (rq, rs) => answerConstructView(rq, rs, view))(req, res);
}

async function answerConstructView(req: Request, res: Response, view: ViewRecord & { sparql: { query: string } }): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  const choice = chooseRdfFormat({ accept: req.headers['accept'], members: 1, offered: SPARQL_GRAPH_FORMATS });
  if (!choice.ok) { sendProblem(res, { status: choice.status, title: 'Not acceptable', detail: choice.error, code: choice.code, extra: { formats: choice.formats } }); return; }
  const token = req.authToken as { rights?: TokenRights | null; peerInstanceId?: unknown } | undefined;
  const members = viewReadMembers({ rights: token?.rights ?? undefined, view, area: 'knowledge', needs: 'read', peerId: peerBoundTo(token ?? {}) });
  req.authorisedSpaces = members;
  const slot = takeSlot('sparql', slotCallerKey(req));
  if (!slot) {
    const busy = busyRefusal('sparql');
    sendLdRefusal(res, { status: busy.status, code: busy.code, title: 'Busy', detail: busy.error, retryAfterSeconds: busy.retryAfterSeconds });
    return;
  }
  const signal = abortWhenClientGoes(res);
  let statements;
  try {
    const { timeoutMs, maxResultBytes } = sparqlLimits(getConfig());
    const deadline = Date.now() + timeoutMs;
    statements = await readAcrossSwaps(
      recordsFor => createQuadSource({ members, caller: callerOf(req), fingerprintOf: schemaFingerprintOf },
        { deadline, signal, ...(recordsFor.length > 0 ? { recordsFor } : {}) }),
      source => constructStatements(view.sparql.query, source, { deadline, maxBytes: maxResultBytes, signal }),
    );
  } catch (err) {
    if (signal.aborted) return;
    const refused = sparqlRefusalOf(err);
    if (!refused) throw err;
    sendLdRefusal(res, {
      status: refused.status, code: refused.code, title: 'Not answered', detail: refused.message,
      ...(refused.retryAfterSeconds !== undefined ? { retryAfterSeconds: refused.retryAfterSeconds } : {}),
    });
    return;
  } finally {
    slot.release();
  }
  const rendered = renderGraph(choice.format, statements.map(fromRdfJs));
  if ('code' in rendered) { sendProblem(res, { status: rendered.status, title: 'Not writable', detail: rendered.error, code: rendered.code }); return; }
  req.auditChangesExplicit = [{ field: 'kind', to: 'view' }, { field: 'statements', to: statements.length }, { field: 'truncated', to: false }];
  res.status(EXPORT_OK).setHeader('Content-Type', rendered.contentType);
  res.end(rendered.body);
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
// The caller's own SPARQL view (`/ld/@<name>/`, Q-762) is answered first, as its CONSTRUCT's statements; any other segment goes on.
linkedDataRouter.get('/:spaceId/', baseRootOnly, globalRateLimit, browsersToTheApp(fixed('graph')), requireAuth, constructViewFirst, requireResolvedRung,
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
  // `recordKindOnly` let only a record kind through, so the kind is one `answerStatements` takes.
  answered('GET /ld/:spaceId/:kind/:id', (req, res) => answerStatements(req, res, kindParam(req) as LdStatementsKind)));
// Anything else under /ld/ is no address: the one not-found answer, to every caller and every Accept.
linkedDataRouter.use((_req, res) => { res.vary('Accept'); sendNotFound(res); });
