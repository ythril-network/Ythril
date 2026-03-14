#!/usr/bin/env node
/**
 * Test setup script — run once after `docker compose -f docker-compose.test.yml up`.
 *
 * For each instance:
 *  1. Reads the existing setup code from Docker logs
 *  2. Completes setup via POST /setup
 *  3. Creates a PAT
 *  4. Stores the PAT in configs/<x>/token.txt
 *
 * Pre-requisites:
 *  - All 6 containers are healthy
 *  - configs/a/, configs/b/, configs/c/ directories exist (or will be created)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS_DIR = path.join(__dirname, 'configs');

const INSTANCES = [
  { name: 'a', container: 'ythril', url: 'http://localhost:3200', port: 3200 },
  { name: 'b', container: 'ythril-b', url: 'http://localhost:3201', port: 3201 },
  { name: 'c', container: 'ythril-c', url: 'http://localhost:3202', port: 3202 },
];

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForHealth(url, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch { /* not ready yet */ }
    await wait(1000);
  }
  throw new Error(`${url} did not become healthy in ${timeout}ms`);
}

async function getSetupCode(container) {
  // The setup code is printed to logs on first run
  const logs = execSync(`docker logs ${container} 2>&1`).toString();
  const match = logs.match(/Setup code:\s+([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/i);
  if (!match) throw new Error(`Could not find setup code in logs for ${container}. Is it a first run?`);
  return match[1];
}

async function setupInstance(inst) {
  console.log(`\nSetting up instance ${inst.name} (${inst.container})...`);

  // Ensure config directory exists
  const configDir = path.join(CONFIGS_DIR, inst.name);
  fs.mkdirSync(configDir, { recursive: true });

  // Wait for the instance to be up
  console.log(`  Waiting for ${inst.url} to be healthy...`);
  await waitForHealth(inst.url);

  // Check if already setup
  const tok = path.join(configDir, 'token.txt');
  if (fs.existsSync(tok)) {
    console.log(`  Already set up — skipping (token.txt exists)`);
    return { url: inst.url, token: fs.readFileSync(tok, 'utf8').trim() };
  }

  // Get setup code from container logs
  const code = await getSetupCode(inst.container);
  console.log(`  Setup code: ${code}`);

  // Complete setup
  const setupRes = await fetch(`${inst.url}/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      label: `Test Instance ${inst.name.toUpperCase()}`,
      settingsPassword: 'testpassword123!',
      settingsPasswordConfirm: 'testpassword123!',
    }),
  });
  if (!setupRes.ok && setupRes.status !== 302) {
    const body = await setupRes.text();
    throw new Error(`Setup failed for ${inst.name}: ${setupRes.status} ${body}`);
  }
  console.log(`  Setup complete`);

  // We need the settings password to create a PAT — log in to settings
  // The settings UI uses a session cookie; for simplicity we create the token
  // via the API directly after getting a session cookie.
  // Here we directly call the API with the settings password to get a session.

  // POST /settings/login
  const loginRes = await fetch(`${inst.url}/settings/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'testpassword123!' }),
    redirect: 'manual',
  });

  const cookies = loginRes.headers.get('set-cookie') ?? '';
  if (!cookies) {
    console.warn(`  Warning: could not log into settings — creating token via another means`);
  }

  // Create a PAT via the API (requires auth — but on first run we need a cookie or something)
  // Actually the API uses Bearer tokens. We need to first create a token via the settings UI
  // or via a direct DB approach. For tests, the easiest way is to parse the token from
  // the setup response or from the container — but that's complex.
  //
  // Simpler approach: the settings UI token creation endpoint uses session auth.
  // We'll POST to /settings/tokens with the session cookie.

  const tokenRes = await fetch(`${inst.url}/settings/tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookies,
    },
    body: new URLSearchParams({ name: 'test-token' }),
    redirect: 'manual',
  });

  // The response should contain the token in the HTML or as a redirect with flash
  // Fallback: if that doesn't work, use the API endpoint directly
  let plaintext = null;

  if (tokenRes.ok) {
    const html = await tokenRes.text();
    const match = html.match(/ythril_[A-Za-z0-9]+/);
    if (match) plaintext = match[0];
  }

  if (!plaintext) {
    // Try the JSON API endpoint (POST /api/tokens)
    // The API requires a PAT — chicken-and-egg. We'll use a special bootstrap mechanism.
    // For now, throw and tell the user to create a token manually.
    throw new Error(
      `Could not auto-create a PAT token for ${inst.name}. ` +
      `Please create one manually at ${inst.url}/settings and save it to ${tok}`,
    );
  }

  fs.writeFileSync(tok, plaintext, { mode: 0o600 });
  console.log(`  PAT saved to ${tok}`);
  console.log(`  Token: ${plaintext.slice(0, 20)}...`);

  return { url: inst.url, token: plaintext };
}

async function main() {
  console.log('Ythril test setup');
  console.log('=================');

  const results = [];
  for (const inst of INSTANCES) {
    try {
      const r = await setupInstance(inst);
      results.push({ ...inst, ...r });
    } catch (err) {
      console.error(`  ERROR for instance ${inst.name}: ${err.message}`);
    }
  }

  console.log('\nSetup summary:');
  for (const r of results) {
    const tok = path.join(CONFIGS_DIR, r.name, 'token.txt');
    const exists = fs.existsSync(tok);
    console.log(`  ${r.name}: ${r.url}  token=${exists ? '✓' : '✗ MISSING'}`);
  }

  console.log('\nRun tests with:');
  console.log('  node --test tests/sync/*.test.js');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
