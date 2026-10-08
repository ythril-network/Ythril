/**
 * Red-team tests: file subsystem hardening (H8 chunked-upload limits, H9
 * stored-XSS-safe downloads)
 *
 * H9 — download headers:
 *  - HTML/SVG downloads must carry Content-Disposition: attachment and a
 *    sandbox CSP so user-uploaded markup can never run script in the
 *    instance origin
 *  - passive types (txt, png) stay inline (previews keep working)
 *
 * H8 — chunked uploads:
 *  - Content-Range totals above maxChunkedUploadBytes are rejected 413
 *  - chunked uploads respect the storage quota (507), which the old code
 *    bypassed entirely
 *
 * Uses the same config-patch + reload-config mechanism as quota.test.js.
 *
 * Run: node --test testing/red-team-tests/file-hardening.test.js
 * Pre-requisite: docker compose test stack up + testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'config.json');
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

// On Linux CI the container's node user owns config.json — patch via docker exec.
const USE_DOCKER_EXEC = process.platform !== 'win32';
const CONTAINER_A = 'ythril-a';

let token;
let originalConfig;

function readConfig() {
  if (USE_DOCKER_EXEC) {
    return JSON.parse(execSync(`docker exec ${CONTAINER_A} cat /config/config.json`).toString('utf8'));
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function writeConfig(cfg) {
  if (USE_DOCKER_EXEC) {
    const json = JSON.stringify(cfg, null, 2);
    execSync(
      `docker exec -i ${CONTAINER_A} sh -c 'cat > /config/config.json && chmod 600 /config/config.json'`,
      { input: json },
    );
    return;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { encoding: 'utf8' });
}

async function applyConfig(cfg) {
  writeConfig(cfg);
  const r = await post(INSTANCES.a, token, '/api/admin/reload-config', {});
  assert.equal(r.status, 200, `reload-config failed: ${JSON.stringify(r.body)}`);
}

async function uploadRaw(filePath, bytes, contentType = 'application/octet-stream', extraHeaders = {}) {
  const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': contentType,
      ...extraHeaders,
    },
    body: bytes,
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

async function download(filePath) {
  const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  const text = await r.text().catch(() => '');
  return { status: r.status, headers: r.headers, text };
}

async function deleteFile(filePath) {
  const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
  await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
}

describe('File hardening (H8 + H9)', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    originalConfig = readConfig();
  });

  after(async () => {
    // Restore original config
    await applyConfig(originalConfig).catch(() => {});
  });

  // ══════════════════════════════════════════════════════════════════════════
  // H9 — stored-XSS-safe downloads
  // ══════════════════════════════════════════════════════════════════════════

  describe('Download headers (stored XSS guard)', () => {
    const run = Date.now();
    const uploads = [];

    after(async () => {
      for (const p of uploads) await deleteFile(p);
    });

    async function uploadAndFetch(name, content, contentType) {
      const p = `xss-test-${run}/${name}`;
      uploads.push(p);
      const up = await uploadRaw(p, Buffer.from(content), contentType);
      assert.ok(up.status === 201 || up.status === 202, `upload ${name}: ${up.status} ${JSON.stringify(up.body)}`);
      return download(p);
    }

    it('HTML is served as attachment with sandbox CSP', async () => {
      const r = await uploadAndFetch('evil.html', '<script>alert(document.domain)</script>', 'text/html');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition') ?? '', /^attachment/);
      assert.match(r.headers.get('content-security-policy') ?? '', /sandbox/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    });

    it('SVG is served as attachment with sandbox CSP', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("//evil")</script></svg>';
      const r = await uploadAndFetch('evil.svg', svg, 'image/svg+xml');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition') ?? '', /^attachment/);
      assert.match(r.headers.get('content-security-policy') ?? '', /sandbox/);
    });

    it('XML is served as attachment', async () => {
      const r = await uploadAndFetch('evil.xml', '<?xml version="1.0"?><x/>', 'application/xml');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition') ?? '', /^attachment/);
    });

    it('plain text stays inline (previews unaffected)', async () => {
      const r = await uploadAndFetch('note.txt', 'just text', 'text/plain');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition') ?? '', /^inline/);
      // The app-wide baseline CSP is fine — only the sandbox directive is reserved
      // for active-content types.
      assert.ok(!(r.headers.get('content-security-policy') ?? '').includes('sandbox'));
    });

    it('PNG stays inline', async () => {
      // 1x1 transparent PNG
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      );
      const p = `xss-test-${run}/pixel.png`;
      uploads.push(p);
      const up = await uploadRaw(p, png, 'image/png');
      assert.ok(up.status === 201 || up.status === 202, `upload png: ${up.status}`);
      const r = await download(p);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition') ?? '', /^inline/);
    });

    it('filename in Content-Disposition is quote/CRLF-sanitised', async () => {
      const p = `xss-test-${run}/a"b.html`;
      uploads.push(p);
      const up = await uploadRaw(p, Buffer.from('<b>x</b>'), 'text/html');
      assert.ok(up.status === 201 || up.status === 202, `upload: ${up.status}`);
      const r = await download(p);
      const cd = r.headers.get('content-disposition') ?? '';
      assert.ok(!cd.includes('a"b'), `raw quote must not survive in header: ${cd}`);
    });

    it('a name outside Latin-1 downloads, and the header names it (filename*)', async () => {
      // Node refuses a header value above U+00FF, so this answered 500 with the bytes on disk (bundle-71 verify).
      for (const name of ['日本.txt', 'café.txt', '📄 notes.md']) {
        const r = await uploadAndFetch(name, `bytes of ${name}`, 'text/plain');
        assert.equal(r.status, 200, `GET ${name}: ${r.status}`);
        const cd = r.headers.get('content-disposition') ?? '';
        const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        assert.ok(star, `no filename* in: ${cd}`);
        assert.equal(decodeURIComponent(star[1]).normalize('NFC'), name.normalize('NFC'), cd);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // H8 — chunked upload limits
  // ══════════════════════════════════════════════════════════════════════════

  describe('Chunked upload limits', () => {
    const run = Date.now();

    after(async () => {
      await applyConfig(originalConfig).catch(() => {});
    });

    it('rejects a Content-Range total above maxChunkedUploadBytes with 413', async () => {
      const cfg = readConfig();
      cfg.maxChunkedUploadBytes = 1024 * 1024; // 1 MiB cap
      await applyConfig(cfg);

      const declared = 5 * 1024 * 1024; // declares 5 MiB
      const chunk = Buffer.alloc(1024, 0x41);
      const r = await uploadRaw(`chunk-test-${run}/too-big.bin`, chunk, 'application/octet-stream', {
        'Content-Range': `bytes 0-1023/${declared}`,
      });
      assert.equal(r.status, 413, `expected 413, got ${r.status}: ${JSON.stringify(r.body)}`);
    });

    it('rejects chunks once the files hard quota would be exceeded (507)', async () => {
      const cfg = readConfig();
      delete cfg.maxChunkedUploadBytes;
      cfg.storage = { files: { hardLimitGiB: 0.000001 } }; // ~1 KiB — instantly exceeded
      await applyConfig(cfg);

      const chunk = Buffer.alloc(4096, 0x42);
      const r = await uploadRaw(`chunk-test-${run}/quota.bin`, chunk, 'application/octet-stream', {
        'Content-Range': 'bytes 0-4095/8192',
      });
      assert.equal(r.status, 507, `expected 507, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.storageExceeded, true);
    });

    it('accepts a normal chunked upload within limits (regression)', async () => {
      await applyConfig(originalConfig);

      const p = `chunk-test-${run}/ok.bin`;
      const part1 = Buffer.alloc(1024, 0x43);
      const part2 = Buffer.alloc(1024, 0x44);
      const r1 = await uploadRaw(p, part1, 'application/octet-stream', {
        'Content-Range': 'bytes 0-1023/2048',
      });
      assert.equal(r1.status, 202, `first chunk: ${r1.status} ${JSON.stringify(r1.body)}`);
      const r2 = await uploadRaw(p, part2, 'application/octet-stream', {
        'Content-Range': 'bytes 1024-2047/2048',
      });
      assert.ok(r2.status === 201 || r2.status === 202, `final chunk: ${r2.status} ${JSON.stringify(r2.body)}`);
      assert.ok(r2.body?.sha256, 'assembled response should include sha256');
      await deleteFile(p);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // L3 — a filename with a literal % round-trips (no double URL-decode)
  // ══════════════════════════════════════════════════════════════════════════

  describe('Literal % in filenames (L3)', () => {
    const run = Date.now();

    it('uploads and downloads a file named with a literal % (previously 500)', async () => {
      const p = `pct-test-${run}/50%.png`;
      // Before the fix, resolveSafePath ran decodeURIComponent again on the
      // already-decoded path — '50%.png' → URIError → HTTP 500.
      const up = await uploadRaw(p, Buffer.from('percent'), 'application/octet-stream');
      assert.ok(up.status === 201 || up.status === 202, `upload: ${up.status} ${JSON.stringify(up.body)}`);

      const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(p)}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const body = await r.text();
      assert.equal(r.status, 200, `download of a %-named file must not 500: got ${r.status}`);
      assert.equal(body, 'percent');
      await deleteFile(p);
    });
  });
});
