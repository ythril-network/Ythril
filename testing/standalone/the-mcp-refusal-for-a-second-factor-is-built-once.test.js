/**
 * The MCP refusal for a caller who REST would ask for a second factor is one sentence with one question behind it (bundle-270, lens finding D3).
 *
 * ## What it holds
 *
 * - `mfaStepUpRefusalFor` (`auth/mfa-asked.ts`) answers the sentence a door cannot present a code with, or null when the caller would not be
 *   asked (no record, an OIDC session, a token exempt from the second factor). The four tools that refuse (`import_rdf` with `schema`,
 *   `import_schema_rdf`, `network_reread`, `view_copy`) get their sentences word for word, pinned here: the action, the step-up the door cannot
 *   present, and the REST route or the page of the web UI to use.
 * - **No second copy.** The words "needs MFA step-up" are a string literal of that module and of no other server source, and each of the four
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
/** A token that sets the second factor `required` is asked whatever the instance's switch says. */
const ASKED = { mfa: 'required' };

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
      if (!text.includes('needs MFA step-up')) continue;
      walkEveryNode(parseSource(file, text), (n) => {
        const literal = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
        if (literal && n.text.includes('needs MFA step-up')) holders.push(file);
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
