/**
 * The external assist model is consented to PER USE, not per host (`F-35`).
 *
 * It does two jobs that send different things: the document repair pass (OCR text and page images) and — since
 * `ingest` — writing a conversation's claims and answering its questions when no decision model is set
 * (conversation turns). Consent was recorded once, as `acknowledgedHost`, under a dialog that named document
 * content alone, and every path checked that one field. So a host acknowledged for documents received
 * conversations too, under a consent that never mentioned them.
 *
 * `acknowledgedHost` keeps meaning what it always meant — documents — so no existing consent grows. Conversations
 * are `acknowledgedHostForConversations`, given in a dialog of their own. `assistConsented(assist, use)` is the one
 * place that knows which field is which use's; this gate holds every egress path of the assist slot to it.
 *
 * Run: node --test testing/standalone/an-assist-model-use-is-consented-on-its-own.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';

let assistConsented;
before(async () => { ({ assistConsented } = await import('../../server/dist/config/egress-consent.js')); });

const base = { baseUrl: 'https://llm.example.com/v1' };
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('each use has its own consent', () => {
  it('documents: acknowledgedHost, as it always was', () => {
    assert.equal(assistConsented({ ...base, acknowledgedHost: 'llm.example.com' }, 'repair'), true);
    assert.equal(assistConsented({ ...base, acknowledgedHostForConversations: 'llm.example.com' }, 'repair'), false);
  });
  it('conversations: only their own acknowledgement — a documents consent does not grow into one', () => {
    assert.equal(assistConsented({ ...base, acknowledgedHost: 'llm.example.com' }, 'conversations'), false);
    assert.equal(assistConsented({ ...base, acknowledgedHostForConversations: 'llm.example.com' }, 'conversations'), true);
  });
  it('a changed host withdraws both', () => {
    const moved = { baseUrl: 'https://other.example/v1', acknowledgedHost: 'llm.example.com', acknowledgedHostForConversations: 'llm.example.com' };
    assert.equal(assistConsented(moved, 'repair'), false);
    assert.equal(assistConsented(moved, 'conversations'), false);
  });
});

describe('every egress path of the assist slot asks through it', () => {
  it('no server source hands the assist slot to egressConsented directly', () => {
    // Derived: every tracked source that names the assist slot's config. A direct `egressConsented(assist…)`
    // reads `acknowledgedHost` — the DOCUMENTS consent — whatever the path sends.
    const files = trackedSources(['server/src'], { floor: 50 }).filter(f => f.endsWith('.ts'));
    const offenders = files.filter(f => !f.endsWith('egress-consent.ts'))
      .filter(f => /egressConsented\(\s*(assist\b|[\w.?]*assistModel\b|s\b)/.test(strip(readFileSync(f, 'utf8'))));
    assert.deepEqual(offenders, [], 'these read the assist model\'s consent without saying which use it is for');
  });
  it('the conversation paths ask for conversations', () => {
    for (const f of ['server/src/extractor/generate.ts', 'server/src/extractor/decide.ts']) {
      assert.match(strip(readFileSync(f, 'utf8')), /assistConsented\([^)]*'conversations'\)/, `${f} does not ask for the conversations consent`);
    }
  });
  it('the document paths ask for repair', () => {
    for (const f of ['server/src/files/converters/describe.ts', 'server/src/files/converters/vlm-extract.ts']) {
      assert.match(strip(readFileSync(f, 'utf8')), /assistConsented\([^)]*'repair'\)/, `${f} does not ask for the documents consent`);
    }
  });
});
