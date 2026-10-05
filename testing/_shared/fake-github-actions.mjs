/**
 * A local HTTP server that speaks the part of the GitHub Actions REST API that `scripts/test-times.mjs
 * --record-ci` reads: workflow runs, a run's jobs, a run's artifacts, and the artifact download.
 *
 * ## What it prevents
 *
 * The recorder's whole security story is "identity comes from the API's RUN OBJECT, never from the artifact", so
 * a test of it needs an API that holds run objects the recorder must refuse (a fork's push, a pull request, another
 * workflow, another branch, a run still in progress) NEXT TO ones it must take, and artifacts whose contents lie
 * about who they belong to. `requests` is the observation that matters: which run ids were ever asked about. An
 * untrusted run whose artifact endpoint was never requested was refused BEFORE its bytes were read, which is the
 * property — a refusal after parsing is a refusal after the damage.
 *
 * ## Shape it serves
 *
 * - `GET /repos/:owner/:repo/actions/runs` and `/repos/:owner/:repo/actions/workflows/:file/runs` →
 *   `{total_count, workflow_runs}` on page 1, an empty list from page 2 (so a pager ends), whatever filter
 *   parameters were sent: the server does NOT filter, because the refusal under test is the recorder's, not the API's.
 * - `GET …/actions/runs/:id/jobs` → `{total_count, jobs}`
 * - `GET …/actions/runs/:id/artifacts` → `{total_count, artifacts}`
 * - `GET …/actions/artifacts/:id/zip` → `302` to `/blob/:id.zip` on this server (real GitHub redirects the
 *   download to blob storage), which serves the bytes.
 * - Every request needs `Authorization: Bearer <token>`, as a repository read does.
 *
 * Binds 127.0.0.1 only; nothing here reaches github.com.
 */
import http from 'node:http';

export const FAKE_GH_TOKEN = 'ghp_fakeTestToken0123456789abcdefghijklmn';

/**
 * @param {{ runs: object[], jobsByRun?: Record<string, object[]>, artifactsByRun?: Record<string, Array<{id: number, name: string, zip: Buffer}>>, token?: string }} opts
 */
export async function startFakeGithub({ runs, jobsByRun = {}, artifactsByRun = {}, token = FAKE_GH_TOKEN }) {
  const requests = [];
  const sockets = new Set();
  const artifactById = new Map();
  for (const list of Object.values(artifactsByRun)) for (const a of list) artifactById.set(String(a.id), a);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    requests.push({ path: u.pathname, search: u.search, authorization: req.headers['authorization'] ?? null });
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname.startsWith('/blob/')) {
      const a = artifactById.get(u.pathname.slice('/blob/'.length).replace(/\.zip$/, ''));
      if (!a) return json(404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': a.zip.length });
      return res.end(a.zip);
    }
    if (req.headers['authorization'] !== `Bearer ${token}` && req.headers['authorization'] !== `token ${token}`) return json(401, { message: 'Bad credentials' });
    const page = Number(u.searchParams.get('page') ?? '1');
    let m;
    if ((m = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/(?:runs|workflows\/[^/]+\/runs)$/))) {
      return json(200, { total_count: runs.length, workflow_runs: page > 1 ? [] : runs });
    }
    if ((m = u.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/))) {
      const list = jobsByRun[m[1]] ?? [];
      return json(200, { total_count: list.length, jobs: page > 1 ? [] : list });
    }
    if ((m = u.pathname.match(/\/actions\/runs\/(\d+)\/artifacts$/))) {
      const list = (artifactsByRun[m[1]] ?? []).map(a => ({ id: a.id, name: a.name, size_in_bytes: a.zip.length, expired: false }));
      return json(200, { total_count: list.length, artifacts: page > 1 ? [] : list });
    }
    if ((m = u.pathname.match(/\/actions\/artifacts\/(\d+)\/zip$/))) {
      if (!artifactById.has(m[1])) return json(404, { message: 'Not Found' });
      res.writeHead(302, { location: `/blob/${m[1]}.zip` });
      return res.end();
    }
    return json(404, { message: 'Not Found' });
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    requests,
    /** Run ids whose jobs, artifacts or artifact bytes were ever requested. */
    askedAbout() {
      const ids = new Set();
      for (const r of requests) {
        const m = r.path.match(/\/actions\/runs\/(\d+)\//);
        if (m) ids.add(m[1]);
        const z = r.path.match(/\/actions\/artifacts\/(\d+)\/zip$/) ?? r.path.match(/^\/blob\/(\d+)\.zip$/);
        if (z) for (const [runId, list] of Object.entries(artifactsByRun)) if (list.some(a => String(a.id) === z[1])) ids.add(runId);
      }
      return ids;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise(r => server.close(r));
    },
  };
}
