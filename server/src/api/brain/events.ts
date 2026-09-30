/**
 * /api/brain/spaces/:spaceId/events — Server-Sent Events stream of brain changes (F12).
 *
 * Every REST/MCP write funnels through `emitWebhookEvent`, which publishes to the in-process
 * `brain-events` bus (see brain/brain-events.ts); this endpoint fans those out to the browser so the
 * Brain page can refresh its lists and count badges live — most valuably when an MCP agent (or another
 * session) mutates the space. Changes applied by the SYNC engine are intentionally not surfaced here
 * (they don't emit an attributed webhook event); those still appear on the next load.
 *
 * Auth: space-scoped, read-only tokens allowed (watching is a read). EventSource cannot set an
 * Authorization header, so the token is passed as `?token=` — this path is added to the auth layer's
 * query-token allowlist. Modeled on the admin log-stream SSE in api/about.ts.
 */
import { Router } from 'express';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { requireSpaceAuth } from '../../auth/middleware.js';
import { mintSseTicket } from '../../auth/sse-ticket.js';
import { getConfig } from '../../config/loader.js';
import { subscribeBrainChanges } from '../../brain/brain-events.js';
import { openEventStream } from '../../util/sse-stream.js';

export const brainEventsRouter = Router();

/**
 * Mint a single-use ticket for the SSE stream below. `EventSource` can't set an `Authorization` header,
 * and a raw token in the URL would leak into logs/history/`Referer` — so the client POSTs here
 * (authenticated normally, space-scope enforced), then opens the stream with `?ticket=`. The ticket
 * aliases this request's bearer, is single-use, expires in ~1 min, and is bound to THIS space's stream.
 */
brainEventsRouter.post('/spaces/:spaceId/events/ticket', globalRateLimit, requireSpaceAuth, (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  if (!getConfig().spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) {
    res.status(400).json({ error: 'Ticket minting requires an Authorization: Bearer header' });
    return;
  }
  res.json(mintSseTicket(bearer, `/api/brain/spaces/${spaceId}/events`));
});

brainEventsRouter.get('/spaces/:spaceId/events', globalRateLimit, requireSpaceAuth, (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  if (!getConfig().spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  // Bounded in count and in what a slow reader may queue — see util/sse-stream.ts (`Q-108`).
  const stream = openEventStream(req, res, { pool: 'brain-events' });
  if (!stream) return;

  const unsubscribe = subscribeBrainChanges(spaceId, (ev) => {
    const id = (ev.entry as { _id?: unknown })?._id;
    // Minimal payload — the client uses `event` (e.g. "fact.created") to refresh the right tab/badges.
    stream.send(`data: ${JSON.stringify({ event: ev.event, id: typeof id === 'string' ? id : undefined })}\n\n`);
  });
  stream.onClose(unsubscribe);
});
