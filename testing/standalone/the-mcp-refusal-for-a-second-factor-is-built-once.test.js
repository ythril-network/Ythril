/**
 * The MCP refusal for a caller who REST would ask for a second factor is one sentence with one question behind it (bundle-270, lens finding D3).
 *
 * ## What it holds
 *
 * - `mfaStepUpRefusalFor` (`auth/mfa-asked.ts`) answers the sentence a door cannot present a code with, or null when the caller would not be
 *   asked (no record, an OIDC session, a token exempt from the second factor). The four tools that refuse (`import_rdf` with `schema`,
 *   `import_schema_rdf`, `network_reread`, `view_copy`) get their sentences word for word, pinned here: the action, the step-up the door cannot
 *   present, and the REST route or the page of the web UI to use.
 * - **What each tool passes.** Each tool's call of the helper is read from its source (the action and the place, as plain literals), and the
 *   sentence they build is the one the tool always answered with: a changed action or place in one tool fails here, not only in a spec that needs the stack.
 * - **No second copy.** The clause "needs MFA step-up, which this door cannot present" is a string literal of that module and of no other server source, and each of the four
 *   tools calls the helper, so a fifth tool that spells it again fails here.
 *
 * Whether a real caller is asked (an instance with the second factor on, a token inheriting it) is held by the tools' own specs: the
 * schema-writing RDF tools', `network_reread`'s and `view_copy`'s.
 *
 * Run: node --test testing/standalone/the-mcp-refusal-for-a-second-factor-is-built-once.test.js (server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, SERVER_CODE_ROOTS, trackedSources } from './_sources.mjs';
import { parseSource, walkEveryNode, ts } from '../_shared/syntax-tree.mjs';

const built = await import('../../server/dist/auth/mfa-asked.js').catch(() => ({}));
const MODULE = 'server/src/auth/mfa-asked.ts';
const TOOLS = ['rdf-import', 'schema-rdf-import', 'networks', 'views'].map(t => `server/src/mcp/tools/${t}.ts`);
/** The words every refusal shares (a tool's description says "it needs MFA step-up" in its own words, so the whole clause is read). */
const SENTENCE = 'needs MFA step-up, which this door cannot present';
/** A token that sets the second factor `required` is asked whatever the instance's switch says. */
const ASKED = { mfa: 'required' };

/** What each tool answers a caller who is asked for a second factor, word for word as the tools wrote it before the helper took the sentence over (9282e322f). */
const TOOL_SENTENCES = {
  'server/src/mcp/tools/rdf-import.ts': 'Building a schema from an RDF import needs MFA step-up, which this door cannot present; use the web UI or POST /api/brain/spaces/:spaceId/import/rdf',
  'server/src/mcp/tools/schema-rdf-import.ts': 'Building a schema from an RDF file needs MFA step-up, which this door cannot present; use the web UI or POST /api/spaces/:id/schema-rdf',
  'server/src/mcp/tools/networks.ts': 'Re-reading a network needs MFA step-up, which this door cannot present; use the web UI (Settings > Networks)',
  'server/src/mcp/tools/views.ts': 'Giving a view to a token needs MFA step-up, which this door cannot present; use the web UI (Settings > Tokens)',
};

/** The action and the place a tool's calls of the helper pass, read from its source; `null` for an argument that is not a plain literal. */
function helperCallsOf(file) {
  const literal = (x) => (x !== undefined && (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) ? x.text : null);
  const calls = [];
  walkEveryNode(parseSource(file, readFileSync(join(REPO_ROOT, file), 'utf8')), (n) => {
    if (!(ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'mfaStepUpRefusalFor')) return;
    const [, action, place] = n.arguments;
    const members = place !== undefined && ts.isObjectLiteralExpression(place)
      ? place.properties.map(p => (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) ? [p.name.text, literal(p.initializer)] : [null, null]))
      : [];
    const plain = members.length === 1 && members[0][0] !== null && members[0][1] !== null;
    calls.push({ action: literal(action), place: plain ? Object.fromEntries(members) : null });
  });
  return calls;
}

const sentence = (record, action, place) => {
  assert.equal(typeof built.mfaStepUpRefusalFor, 'function', 'mfaStepUpRefusalFor is not exported by server/src/auth/mfa-asked.ts');
  return built.mfaStepUpRefusalFor(record, action, place);
};

describe('the refusal for a caller asked for a second factor is built once', () => {
  it('the four tools get the sentences they have always answered with', () => {
    assert.equal(sentence(ASKED, 'Building a schema from an RDF import', { route: 'POST /api/brain/spaces/:spaceId/import/rdf' }),
      'Building a schema from an RDF import needs MFA step-up, which this door cannot present; use the web UI or POST /api/brain/spaces/:spaceId/import/rdf');
    assert.equal(sentence(ASKED, 'Building a schema from an RDF file', { route: 'POST /api/spaces/:id/schema-rdf' }),
      'Building a schema from an RDF file needs MFA step-up, which this door cannot present; use the web UI or POST /api/spaces/:id/schema-rdf');
    assert.equal(sentence(ASKED, 'Re-reading a network', { page: 'Settings > Networks' }),
      'Re-reading a network needs MFA step-up, which this door cannot present; use the web UI (Settings > Networks)');
    assert.equal(sentence(ASKED, 'Giving a view to a token', { page: 'Settings > Tokens' }),
      'Giving a view to a token needs MFA step-up, which this door cannot present; use the web UI (Settings > Tokens)');
  });

  it('each of the four tools passes the helper the action and the place that make its sentence', () => {
    // R3: the case above pins the helper for arguments chosen here; what a tool passes is read from its source, so a changed action or place fails.
    for (const [file, expected] of Object.entries(TOOL_SENTENCES)) {
      const calls = helperCallsOf(file);
      assert.equal(calls.length, 1, `${file} calls mfaStepUpRefusalFor ${calls.length} times`);
      const [call] = calls;
      assert.ok(call.action !== null && call.place !== null, `${file} passes an action or a place that is not a plain literal: ${JSON.stringify(call)}`);
      assert.equal(sentence(ASKED, call.action, call.place), expected, file);
    }
  });

  it('a caller who is not asked gets no refusal: no record, an OIDC session, a token exempt from the second factor', () => {
    const place = { page: 'Settings > Tokens' };
    assert.equal(sentence(undefined, 'Giving a view to a token', place), null, 'no record');
    assert.equal(sentence(null, 'Giving a view to a token', place), null, 'a null record');
    assert.equal(sentence({ ...ASKED, source: 'oidc' }, 'Giving a view to a token', place), null, 'an OIDC session');
    assert.equal(sentence({ mfa: 'exempt' }, 'Giving a view to a token', place), null, 'a token exempt from the second factor');
  });

  it('the words are a string literal of the helper and of no other server source, and each of the four tools calls it', () => {
    const holders = [];
    for (const file of trackedSources(SERVER_CODE_ROOTS)) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      if (!text.includes(SENTENCE)) continue;
      walkEveryNode(parseSource(file, text), (n) => {
        const literal = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
        if (literal && n.text.includes(SENTENCE)) holders.push(file);
      });
    }
    assert.deepEqual([...new Set(holders)], [MODULE], `the sentence is spelled in ${MODULE} alone: ${JSON.stringify(holders)}`);
    for (const file of TOOLS) {
      let calls = false;
      walkEveryNode(parseSource(file, readFileSync(join(REPO_ROOT, file), 'utf8')), (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'mfaStepUpRefusalFor') calls = true;
      });
      assert.ok(calls, `${file} does not call mfaStepUpRefusalFor`);
    }
  });
});
