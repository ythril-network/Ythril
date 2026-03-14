import { Router } from 'express';
import { getConfig } from '../config/loader.js';
import { listMemories, deleteMemory, countMemories } from '../brain/memory.js';
import { listEntities, deleteEntity } from '../brain/entities.js';
import { listEdges, deleteEdge } from '../brain/edges.js';
import { col } from '../db/mongo.js';
import { needsReindex } from '../spaces/spaces.js';
import { requireSettingsAuth } from '../settings/auth.js';
import { log } from '../util/log.js';

export const brainUiRouter = Router();

// ── All brain UI routes require settings session auth ────────────────────────
brainUiRouter.use(requireSettingsAuth);

// ── GET /brain — space overview ──────────────────────────────────────────────
brainUiRouter.get('/', async (_req, res) => {
  const spaces = getConfig().spaces;

  const stats = await Promise.all(spaces.map(async s => {
    const [memories, entities, edges] = await Promise.all([
      countMemories(s.id),
      col(`${s.id}_entities`).countDocuments(),
      col(`${s.id}_edges`).countDocuments(),
    ]);
    return { ...s, memories, entities, edges, reindexNeeded: needsReindex(s.id) };
  }));

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(overviewPage(stats));
});

// ── GET /brain/spaces/:spaceId — memory/entity browser ──────────────────────
brainUiRouter.get('/spaces/:spaceId', async (req, res) => {
  const { spaceId } = req.params;
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) { res.status(404).send(notFoundPage(spaceId)); return; }

  const tab = req.query['tab'] === 'entities' ? 'entities'
    : req.query['tab'] === 'edges' ? 'edges'
    : 'memories';
  const page = Math.max(1, Number(req.query['page'] ?? 1));
  const PAGE_SIZE = 25;
  const skip = (page - 1) * PAGE_SIZE;

  const [totalMemories, totalEntities, totalEdges] = await Promise.all([
    countMemories(spaceId),
    col(`${spaceId}_entities`).countDocuments(),
    col(`${spaceId}_edges`).countDocuments(),
  ]);

  const memories = tab === 'memories' ? await listMemories(spaceId, {}, PAGE_SIZE, skip) : [];
  const entities = tab === 'entities' ? await listEntities(spaceId, {}, PAGE_SIZE) : [];
  const edges = tab === 'edges' ? await listEdges(spaceId, {}, PAGE_SIZE) : [];

  const reindexNeeded = needsReindex(spaceId);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(spacePage({
    space, tab, page, PAGE_SIZE,
    totalMemories, totalEntities, totalEdges,
    memories, entities, edges, reindexNeeded,
  }));
});

// ── POST /brain/spaces/:spaceId/memories/:id/delete ─────────────────────────
brainUiRouter.post('/spaces/:spaceId/memories/:id/delete', async (req, res) => {
  const { spaceId, id } = req.params;
  const ok = await deleteMemory(spaceId, id);
  if (!ok) { log.warn(`Brain UI: memory not found spaceId=${spaceId} id=${id}`); }
  else { log.info(`Brain UI: deleted memory spaceId=${spaceId} id=${id}`); }
  res.redirect(303, `/brain/spaces/${spaceId}?tab=memories`);
});

// ── POST /brain/spaces/:spaceId/entities/:id/delete ──────────────────────────
brainUiRouter.post('/spaces/:spaceId/entities/:id/delete', async (req, res) => {
  const { spaceId, id } = req.params;
  const ok = await deleteEntity(spaceId, id);
  if (!ok) { log.warn(`Brain UI: entity not found spaceId=${spaceId} id=${id}`); }
  else { log.info(`Brain UI: deleted entity spaceId=${spaceId} id=${id}`); }
  res.redirect(303, `/brain/spaces/${spaceId}?tab=entities`);
});

// ── POST /brain/spaces/:spaceId/edges/:id/delete ─────────────────────────────
brainUiRouter.post('/spaces/:spaceId/edges/:id/delete', async (req, res) => {
  const { spaceId, id } = req.params;
  const ok = await deleteEdge(spaceId, id);
  if (!ok) { log.warn(`Brain UI: edge not found spaceId=${spaceId} id=${id}`); }
  else { log.info(`Brain UI: deleted edge spaceId=${spaceId} id=${id}`); }
  res.redirect(303, `/brain/spaces/${spaceId}?tab=edges`);
});

// ── HTML helpers ─────────────────────────────────────────────────────────────

function esc(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

const baseStyle = `
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #eee; margin: 0; padding: 2rem 1rem; }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.3rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; border-bottom: 1px solid #333; padding-bottom: 0.4rem; }
  p.sub { color: #888; font-size: 0.9rem; margin: 0 0 2rem; }
  a { color: #8080f8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .btn { display: inline-block; padding: 0.4rem 0.9rem; background: #333; color: #eee; border: 1px solid #555; border-radius: 6px; font-size: 0.85rem; cursor: pointer; }
  .btn:hover { background: #444; }
  .btn-danger { background: #5a1010; border-color: #8b1a1a; }
  .btn-danger:hover { background: #7a1818; }
  .btn-primary { background: #6060f0; border-color: #6060f0; }
  .btn-primary:hover { background: #7070ff; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #1e1e1e; vertical-align: top; }
  th { color: #888; font-weight: normal; background: #141414; }
  tr:hover td { background: #121212; }
  .chip { display: inline-block; padding: 0.15rem 0.4rem; background: #222; border: 1px solid #333; border-radius: 4px; font-size: 0.75rem; color: #aaa; margin: 0.1rem 0.1rem 0; }
  .nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; flex-wrap: wrap; gap: 0.5rem; }
  .breadcrumb { font-size: 0.9rem; color: #888; margin-bottom: 1rem; }
  .breadcrumb a { color: #8080f8; }
  .tabs { display: flex; gap: 0; margin-bottom: 1.5rem; border-bottom: 2px solid #333; }
  .tab { padding: 0.5rem 1rem; font-size: 0.9rem; color: #888; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; text-decoration: none; }
  .tab.active { color: #eee; border-bottom-color: #6060f0; }
  .tab:hover { color: #ccc; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
  .stat-card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 1rem; }
  .stat-card .num { font-size: 1.6rem; font-weight: 600; color: #8080f8; }
  .stat-card .lbl { font-size: 0.78rem; color: #888; margin-top: 0.2rem; }
  .space-card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 1.2rem; margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .space-card .info { flex: 1; }
  .space-card .title { font-size: 1rem; font-weight: 600; margin-bottom: 0.3rem; }
  .space-card .meta { font-size: 0.82rem; color: #888; }
  .warn-badge { display: inline-block; padding: 0.15rem 0.5rem; background: #3a2700; border: 1px solid #f0a030; border-radius: 4px; font-size: 0.75rem; color: #f0a030; margin-left: 0.5rem; }
  .pager { display: flex; align-items: center; gap: 0.5rem; margin-top: 1rem; font-size: 0.88rem; color: #888; }
  .fact { max-width: 520px; white-space: pre-wrap; word-break: break-word; font-size: 0.87rem; line-height: 1.5; }
`;

function shellOpen(title: string, extraNav?: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} \u2014 ythril brain</title><style>${baseStyle}</style></head><body>
<div class="wrap">
<div class="nav">
  <div>
    <h1>ythril brain</h1>
    <p class="sub">View and manage memories, entities, and edges</p>
  </div>
  <div style="display:flex;gap:0.5rem;align-items:center">
    ${extraNav ?? ''}
    <a class="btn" href="/settings">\u2190 Settings</a>
  </div>
</div>`;
}

const shellClose = `</div></body></html>`;

// ── Overview page ────────────────────────────────────────────────────────────

type SpaceStat = {
  id: string; label: string; builtIn: boolean;
  memories: number; entities: number; edges: number;
  reindexNeeded: boolean;
};

function overviewPage(stats: SpaceStat[]): string {
  const cards = stats.map(s => {
    const reindexBadge = s.reindexNeeded
      ? `<span class="warn-badge">\u26A0 re-index needed</span>`
      : '';
    return `<div class="space-card">
      <div class="info">
        <div class="title"><a href="/brain/spaces/${esc(s.id)}">${esc(s.label)}</a>${reindexBadge}</div>
        <div class="meta">
          <code style="font-size:0.78rem">${esc(s.id)}</code>${s.builtIn ? ' &middot; built-in' : ''}
          &nbsp;&middot;&nbsp; ${s.memories.toLocaleString()} memories
          &nbsp;&middot;&nbsp; ${s.entities.toLocaleString()} entities
          &nbsp;&middot;&nbsp; ${s.edges.toLocaleString()} edges
        </div>
      </div>
      <a class="btn btn-primary" href="/brain/spaces/${esc(s.id)}">Browse</a>
    </div>`;
  }).join('\n');

  return shellOpen('Overview') +
    (stats.length === 0
      ? '<p style="color:#888">No spaces configured.</p>'
      : cards) +
    shellClose;
}

function notFoundPage(spaceId: string): string {
  return shellOpen('Not found') +
    `<p class="error">Space <code>${esc(spaceId)}</code> not found.</p>` +
    `<a class="btn" href="/brain">Back to overview</a>` +
    shellClose;
}

// ── Space detail page ────────────────────────────────────────────────────────

type SpacePageParams = {
  space: { id: string; label: string; builtIn: boolean };
  tab: 'memories' | 'entities' | 'edges';
  page: number;
  PAGE_SIZE: number;
  totalMemories: number;
  totalEntities: number;
  totalEdges: number;
  memories: Awaited<ReturnType<typeof listMemories>>;
  entities: Awaited<ReturnType<typeof listEntities>>;
  edges: Awaited<ReturnType<typeof listEdges>>;
  reindexNeeded: boolean;
};

function spacePage(p: SpacePageParams): string {
  const { space, tab, page, PAGE_SIZE } = p;
  const base = `/brain/spaces/${esc(space.id)}`;

  const reindexBanner = p.reindexNeeded ? `
    <div style="background:#3a2700;border:1px solid #f0a030;border-radius:6px;padding:0.75rem 1rem;margin-bottom:1.5rem;font-size:0.88rem;color:#f0a030">
      \u26A0 This space needs re-indexing. Recall is disabled until completed.
      Use the <a href="/settings" style="color:#f0a030">Settings</a> page to trigger re-index.
    </div>` : '';

  const tabs = `<div class="tabs">
    <a class="tab${tab === 'memories' ? ' active' : ''}" href="${base}?tab=memories">
      Memories <span style="color:#555">(${p.totalMemories.toLocaleString()})</span>
    </a>
    <a class="tab${tab === 'entities' ? ' active' : ''}" href="${base}?tab=entities">
      Entities <span style="color:#555">(${p.totalEntities.toLocaleString()})</span>
    </a>
    <a class="tab${tab === 'edges' ? ' active' : ''}" href="${base}?tab=edges">
      Edges <span style="color:#555">(${p.totalEdges.toLocaleString()})</span>
    </a>
  </div>`;

  let content = '';

  if (tab === 'memories') {
    const totalPages = Math.max(1, Math.ceil(p.totalMemories / PAGE_SIZE));
    const rows = p.memories.map(m => {
      const tags = ((m as Record<string, unknown>)['tags'] as string[] | undefined ?? [])
        .map(t => `<span class="chip">${esc(t)}</span>`).join('');
      const date = String((m as Record<string, unknown>)['createdAt'] ?? '').slice(0, 10);
      const id = String((m as Record<string, unknown>)['_id'] ?? '');
      const fact = String((m as Record<string, unknown>)['fact'] ?? '');
      return `<tr>
        <td class="fact">${esc(fact)}</td>
        <td>${tags}</td>
        <td style="color:#888;white-space:nowrap">${date}</td>
        <td>
          <form method="POST" action="${base}/memories/${esc(id)}/delete" style="margin:0"
                onsubmit="return confirm('Delete this memory? This cannot be undone.')">
            <button class="btn btn-danger" type="submit" style="padding:0.25rem 0.5rem;font-size:0.78rem">Delete</button>
          </form>
        </td>
      </tr>`;
    }).join('');

    const pager = totalPages > 1 ? `<div class="pager">
      ${page > 1 ? `<a class="btn" href="${base}?tab=memories&page=${page - 1}">&larr; Prev</a>` : ''}
      <span>Page ${page} / ${totalPages}</span>
      ${page < totalPages ? `<a class="btn" href="${base}?tab=memories&page=${page + 1}">Next &rarr;</a>` : ''}
    </div>` : '';

    content = p.memories.length === 0
      ? '<p style="color:#888;font-style:italic">No memories in this space yet.</p>'
      : `<table>
          <thead><tr><th>Memory</th><th>Tags</th><th>Created</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>${pager}`;
  }

  if (tab === 'entities') {
    const rows = p.entities.map(e => {
      const tags = (e.tags ?? []).map(t => `<span class="chip">${esc(t)}</span>`).join('');
      const date = (e.createdAt ?? '').slice(0, 10);
      return `<tr>
        <td>${esc(e.name)}</td>
        <td style="color:#888">${esc(e.type)}</td>
        <td>${tags}</td>
        <td style="color:#888;white-space:nowrap">${date}</td>
        <td>
          <form method="POST" action="${base}/entities/${esc(e._id)}/delete" style="margin:0"
                onsubmit="return confirm('Delete entity \u201c${esc(e.name)}\u201d and all its edges? This cannot be undone.')">
            <button class="btn btn-danger" type="submit" style="padding:0.25rem 0.5rem;font-size:0.78rem">Delete</button>
          </form>
        </td>
      </tr>`;
    }).join('');

    content = p.entities.length === 0
      ? '<p style="color:#888;font-style:italic">No entities in this space yet.</p>'
      : `<table>
          <thead><tr><th>Name</th><th>Type</th><th>Tags</th><th>Created</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
  }

  if (tab === 'edges') {
    const rows = p.edges.map(edge => {
      const from = edge.from ?? '';
      const to = edge.to ?? '';
      const label = edge.label ?? '';
      const id = edge._id ?? '';
      const date = (edge.createdAt ?? '').slice(0, 10);
      return `<tr>
        <td style="font-family:monospace;font-size:0.8rem;color:#888">${esc(from.slice(0, 8))}&hellip;</td>
        <td style="color:#aaa">${esc(label)}</td>
        <td style="font-family:monospace;font-size:0.8rem;color:#888">${esc(to.slice(0, 8))}&hellip;</td>
        <td style="color:#888;white-space:nowrap">${date}</td>
        <td>
          <form method="POST" action="${base}/edges/${esc(id)}/delete" style="margin:0"
                onsubmit="return confirm('Delete this edge? This cannot be undone.')">
            <button class="btn btn-danger" type="submit" style="padding:0.25rem 0.5rem;font-size:0.78rem">Delete</button>
          </form>
        </td>
      </tr>`;
    }).join('');

    content = p.edges.length === 0
      ? '<p style="color:#888;font-style:italic">No edges in this space yet.</p>'
      : `<table>
          <thead><tr><th>From</th><th>Relation</th><th>To</th><th>Created</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
  }

  const statGrid = `<div class="stat-grid">
    <div class="stat-card"><div class="num">${p.totalMemories.toLocaleString()}</div><div class="lbl">Memories</div></div>
    <div class="stat-card"><div class="num">${p.totalEntities.toLocaleString()}</div><div class="lbl">Entities</div></div>
    <div class="stat-card"><div class="num">${p.totalEdges.toLocaleString()}</div><div class="lbl">Edges</div></div>
  </div>`;

  return shellOpen(space.label) +
    `<div class="breadcrumb"><a href="/brain">Brain</a> &rsaquo; ${esc(space.label)}</div>` +
    reindexBanner +
    statGrid +
    tabs +
    content +
    shellClose;
}
