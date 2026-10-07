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
import { listenOnLoopback } from './local-server.mjs';

export const FAKE_GH_TOKEN = 'ghp_fakeTestToken0123456789abcdefghijklmn';

/**
 * An artifact is `{ id, name, zip, expired? }`; `expired: true` is what the API says of an artifact past its retention (the list
 * still names it, and its bytes are gone). The lists are read live, so a test can expire one between two passes.
 *
 * `listings` (optional) is the listing as each successive READ of it sees it: read n answers `listings[n]` (the last one from
 * there on), where `runs` answers every read alike. It is what a listing that lags behind a run that has just finished looks
 * like: stale on the first read and holding the run on a later one. The page after the first is empty either way.
 *
 * `pages` (optional) is a listing of more than one page: page n answers `pages[n - 1]` (an empty list past the last), on every
 * read, where `runs` answers page 1 alone. It is what a run older than the first page's runs looks like.
 *
 * @param {{ runs: object[], listings?: object[][], pages?: object[][], jobsByRun?: Record<string, object[]>, artifactsByRun?: Record<string, Array<{id: number, name: string, zip: Buffer, expired?: boolean}>>, token?: string }} opts
 */
export async function startFakeGithub({ runs, listings, pages, jobsByRun = {}, artifactsByRun = {}, token = FAKE_GH_TOKEN }) {
  const requests = [];
  let listingReads = 0;
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
      if (pages) {
        if (page === 1) listingReads++;
        const here = pages[page - 1] ?? [];
        return json(200, { total_count: here.length, workflow_runs: here });
      }
      if (page > 1) return json(200, { total_count: 0, workflow_runs: [] });
      const held = listings ? listings[Math.min(listingReads, listings.length - 1)] : runs;
      listingReads++;
      return json(200, { total_count: held.length, workflow_runs: held });
    }
    if ((m = u.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/))) {
      const list = jobsByRun[m[1]] ?? [];
      return json(200, { total_count: list.length, jobs: page > 1 ? [] : list });
    }
    if ((m = u.pathname.match(/\/actions\/runs\/(\d+)\/artifacts$/))) {
      const list = (artifactsByRun[m[1]] ?? []).map(a => ({ id: a.id, name: a.name, size_in_bytes: a.zip.length, expired: a.expired === true }));
      return json(200, { total_count: list.length, artifacts: page > 1 ? [] : list });
    }
    if ((m = u.pathname.match(/\/actions\/artifacts\/(\d+)\/zip$/))) {
      if (!artifactById.has(m[1])) return json(404, { message: 'Not Found' });
      res.writeHead(302, { location: `/blob/${m[1]}.zip` });
      return res.end();
    }
    return json(404, { message: 'Not Found' });
  });
  const { url, close } = await listenOnLoopback(server);

  return {
    url,
    token,
    requests,
    /** How many times the first page of the runs listing was read: a read of the listing is its page 1. */
    listingReads: () => listingReads,
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
    close,
  };
}
