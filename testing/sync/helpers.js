/**
 * Shared HTTP helpers for integration tests.
 * Assumes instances are running at http://localhost:320{0,1,2}.
 */

export const INSTANCES = {
  a: 'http://127.0.0.1:3200',
  b: 'http://127.0.0.1:3201',
  c: 'http://127.0.0.1:3202',
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

/**
 * POST with automatic retry on 429 (rate limit).
 * Reads the standard Retry-After HTTP header (seconds); defaults to 5 s.
 */
export async function postRetry429(baseUrl, token, path, data, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await req(baseUrl, token, path, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (resp.status !== 429) {
      const body = await resp.json().catch(() => null);
      return { status: resp.status, body };
    }
    const retryAfter = parseInt(resp.headers.get('retry-after') ?? '5', 10);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
  }
  // final attempt — return whatever we get
  return post(baseUrl, token, path, data);
}

/** PATCH with JSON body */
export async function patch(baseUrl, token, path, data) {
  return reqJson(baseUrl, token, path, {
    method: 'PATCH',
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

/**
 * List ALL memories on an instance's general space.
 * Pages through the API (up to 500 per request) until exhausted so callers
 * never silently receive a truncated result.
 */
export async function listMemories(baseUrl, token) {
  const all = [];
  let skip = 0;
  const pageSize = 500;
  while (true) {
    const r = await get(baseUrl, token, `/api/brain/general/memories?limit=${pageSize}&skip=${skip}`);
    if (r.status !== 200) return r; // surface errors to callers as-is
    const page = r.body.memories ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
    skip += pageSize;
  }
  return { status: 200, body: { memories: all } };
}
