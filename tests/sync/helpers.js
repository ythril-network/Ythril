/**
 * Shared HTTP helpers for integration tests.
 * Assumes instances are running at http://localhost:320{0,1,2}.
 */

export const INSTANCES = {
  a: 'http://localhost:3200',
  b: 'http://localhost:3201',
  c: 'http://localhost:3202',
};

/**
 * Make an authenticated request.
 * @param {string} baseUrl  - instance base URL
 * @param {string} token    - PAT token
 * @param {string} path     - URL path including leading /
 * @param {RequestInit} opts
 */
export async function req(baseUrl, token, path, opts = {}) {
  const url = `${baseUrl}${path}`;
  const resp = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(opts.headers ?? {}),
    },
  });
  return resp;
}

/** req() but parse JSON body automatically */
export async function reqJson(baseUrl, token, path, opts = {}) {
  const resp = await req(baseUrl, token, path, opts);
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

/** POST with JSON body */
export async function post(baseUrl, token, path, data) {
  return reqJson(baseUrl, token, path, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** DELETE */
export async function del(baseUrl, token, path) {
  return reqJson(baseUrl, token, path, { method: 'DELETE' });
}

/** DELETE with JSON body */
export async function delWithBody(baseUrl, token, path, data) {
  return reqJson(baseUrl, token, path, {
    method: 'DELETE',
    body: JSON.stringify(data),
  });
}

/** GET */
export async function get(baseUrl, token, path) {
  return reqJson(baseUrl, token, path);
}

/** Poll until condition() returns true or timeout (ms) */
export async function waitFor(condition, timeout = 15_000, interval = 500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}

/** Trigger a sync run on an instance for a given networkId */
export async function triggerSync(baseUrl, token, networkId) {
  const r = await post(baseUrl, token, '/api/notify/trigger', { networkId });
  if (r.status !== 200) throw new Error(`triggerSync failed: ${r.status} ${JSON.stringify(r.body)}`);
}

/** Create a memory on an instance's general space */
export async function createMemory(baseUrl, token, fact, tags = []) {
  return post(baseUrl, token, '/api/brain/general/memories', { fact, tags });
}

/** List memories on an instance's general space */
export async function listMemories(baseUrl, token) {
  return get(baseUrl, token, '/api/brain/general/memories');
}
