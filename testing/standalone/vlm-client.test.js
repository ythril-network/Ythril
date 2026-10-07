/**
 * F11 — VLM client (`files/converters/vlm-client.ts`), tested against a mock Ollama /api/chat server so
 * no real model is needed. Covers request shaping (image + prompt), response parsing, truncation
 * detection, and error/unreachable paths.
 *
 * Run: node --test testing/standalone/vlm-client.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const state = { status: 200, body: null, lastRequest: null };
const server = http.createServer((req, res) => {
  if (req.url === '/api/chat' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { state.lastRequest = JSON.parse(raw); } catch { state.lastRequest = null; }
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end(state.body ?? JSON.stringify({ message: { content: '# Page\n\nHello world.' }, done_reason: 'stop' }));
    });
    return;
  }
  res.writeHead(404); res.end();
});
const local = await listenOnLoopback(server);
const base = local.url;

const { transcribePageImage, repairMarkdown } = await import('../../server/dist/files/converters/vlm-client.js');

describe('VLM client', () => {
  it('sends the image (base64) + prompt + model to /api/chat and returns the content', async () => {
    state.status = 200; state.body = null;
    const r = await transcribePageImage(Buffer.from('PNGDATA'), { baseUrl: base, model: 'doc-vlm', prompt: 'Transcribe.' });
    assert.equal(r.text, '# Page\n\nHello world.');
    assert.equal(r.truncated, false);
    // Verify the request shape the model receives.
    const req = state.lastRequest;
    assert.equal(req.model, 'doc-vlm');
    assert.equal(req.stream, false);
    assert.equal(req.messages[0].content, 'Transcribe.');
    assert.equal(req.messages[0].images[0], Buffer.from('PNGDATA').toString('base64'));
    assert.equal(req.options.temperature, 0);
    assert.ok(req.options.num_predict > 0, 'output is bounded');
  });

  it('repairMarkdown reconciles a draft against OCR evidence in one text-only call', async () => {
    state.status = 200;
    state.body = JSON.stringify({ message: { content: '# Fixed\n\nfull content' }, done_reason: 'stop' });
    const r = await repairMarkdown({
      baseUrl: base, model: 'repair-model',
      draft: '# Draft', evidence: 'the full OCR text', issues: ['low OCR-evidence coverage 40%'],
    });
    assert.equal(r.text, '# Fixed\n\nfull content');
    assert.equal(r.truncated, false);
    const req = state.lastRequest;
    assert.equal(req.model, 'repair-model');
    assert.equal(req.stream, false);
    assert.equal(req.options.temperature, 0);
    // Text-only: no page image, and the prompt carries both the draft and the OCR evidence + the issues.
    assert.equal(req.messages[0].images, undefined, 'repair is a text-only turn (no image)');
    assert.match(req.messages[0].content, /# Draft/);
    assert.match(req.messages[0].content, /the full OCR text/);
    assert.match(req.messages[0].content, /low OCR-evidence coverage 40%/);
    state.body = null;
  });

  it('flags truncation when done_reason is length', async () => {
    state.body = JSON.stringify({ message: { content: 'partial…' }, done_reason: 'length' });
    const r = await transcribePageImage(Buffer.from('x'), { baseUrl: base, model: 'm', prompt: 'p' });
    assert.equal(r.truncated, true);
    state.body = null;
  });

  it('throws on an Ollama error payload', async () => {
    state.body = JSON.stringify({ error: 'model not found' });
    await assert.rejects(() => transcribePageImage(Buffer.from('x'), { baseUrl: base, model: 'nope', prompt: 'p' }), /VLM error: model not found/);
    state.body = null;
  });

  it('throws on a non-200 status', async () => {
    state.status = 500; state.body = 'boom';
    await assert.rejects(() => transcribePageImage(Buffer.from('x'), { baseUrl: base, model: 'm', prompt: 'p' }), /VLM HTTP 500/);
    state.status = 200; state.body = null;
  });

  it('throws when the endpoint is unreachable', async () => {
    await local.close();
    await assert.rejects(() => transcribePageImage(Buffer.from('x'), { baseUrl: base, model: 'm', prompt: 'p' }), /unreachable/);
  });
});
