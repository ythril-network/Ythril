/**
 * Webhook management API — CRUD for webhook subscriptions.
 *
 * Route prefix: /api/admin/webhooks
 *
 * Authentication: requireAdmin (PAT Bearer token with admin flag)
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import {
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  listDeliveries,
} from '../webhooks/store.js';
import { emitWebhookEvent } from '../webhooks/dispatcher.js';
import { ALL_WEBHOOK_EVENTS } from '../webhooks/types.js';
import type { WebhookEventType } from '../webhooks/types.js';
import { log } from '../util/log.js';

export const webhooksRouter = Router();

// All routes require admin token
webhooksRouter.use(globalRateLimit, requireAdmin);

// ── Validation schemas ──────────────────────────────────────────────────────

const CreateBody = z.object({
  url: z.string().url().refine(u => u.startsWith('https://'), { message: 'Webhook URL must use HTTPS' }),
  secret: z.string().min(8, 'Secret must be at least 8 characters'),
  spaces: z.array(z.string().min(1)).optional(),
  events: z.array(z.string().refine(e => ALL_WEBHOOK_EVENTS.has(e), { message: 'Invalid event type' })).optional(),
  enabled: z.boolean().optional(),
});

const UpdateBody = z.object({
  url: z.string().url().refine(u => u.startsWith('https://'), { message: 'Webhook URL must use HTTPS' }).optional(),
  secret: z.string().min(8, 'Secret must be at least 8 characters').optional(),
  spaces: z.array(z.string().min(1)).optional(),
  events: z.array(z.string().refine(e => ALL_WEBHOOK_EVENTS.has(e), { message: 'Invalid event type' })).optional(),
  enabled: z.boolean().optional(),
});

// ── GET /api/admin/webhooks — list all subscriptions ────────────────────────

webhooksRouter.get('/', async (_req, res) => {
  try {
    const webhooks = await listWebhooks();
    res.json({ webhooks });
  } catch (err) {
    log.error(`GET /api/admin/webhooks: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /api/admin/webhooks/:id — subscription detail ───────────────────────

webhooksRouter.get('/:id', async (req, res) => {
  try {
    const webhook = await getWebhook(req.params['id'] as string);
    if (!webhook) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    res.json(webhook);
  } catch (err) {
    log.error(`GET /api/admin/webhooks/:id: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /api/admin/webhooks — create a subscription ────────────────────────

webhooksRouter.post('/', async (req, res) => {
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    return;
  }

  try {
    const { subscription, id } = await createWebhook({
      url: parsed.data.url,
      secret: parsed.data.secret,
      spaces: parsed.data.spaces,
      events: parsed.data.events as WebhookEventType[] | undefined,
      enabled: parsed.data.enabled,
    });
    res.status(201).json({ ...subscription, id });
  } catch (err) {
    log.error(`POST /api/admin/webhooks: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── PATCH /api/admin/webhooks/:id — update a subscription ───────────────────

webhooksRouter.patch('/:id', async (req, res) => {
  const parsed = UpdateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    return;
  }

  try {
    const updated = await updateWebhook(req.params['id'] as string, {
      url: parsed.data.url,
      secret: parsed.data.secret,
      spaces: parsed.data.spaces,
      events: parsed.data.events as WebhookEventType[] | undefined,
      enabled: parsed.data.enabled,
    });
    if (!updated) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    res.json(updated);
  } catch (err) {
    log.error(`PATCH /api/admin/webhooks/:id: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── DELETE /api/admin/webhooks/:id — remove a subscription ──────────────────

webhooksRouter.delete('/:id', async (req, res) => {
  try {
    const deleted = await deleteWebhook(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    log.error(`DELETE /api/admin/webhooks/:id: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /api/admin/webhooks/:id/test — send a test event ───────────────────

webhooksRouter.post('/:id/test', async (req, res) => {
  try {
    const webhook = await getWebhook(req.params['id'] as string);
    if (!webhook) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    emitWebhookEvent({
      event: 'test.ping',
      spaceId: '_test',
      entry: { message: 'Test webhook delivery from Ythril' },
      tokenId: req.authToken && 'id' in req.authToken ? req.authToken.id : undefined,
      tokenLabel: req.authToken?.name,
    });

    res.json({ ok: true, message: 'Test event queued for delivery' });
  } catch (err) {
    log.error(`POST /api/admin/webhooks/:id/test: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /api/admin/webhooks/:id/deliveries — delivery log ───────────────────

webhooksRouter.get('/:id/deliveries', async (req, res) => {
  try {
    const webhook = await getWebhook(req.params['id'] as string);
    if (!webhook) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    const limit = Math.min(parseInt(req.query['limit'] as string, 10) || 100, 100);
    const deliveries = await listDeliveries(req.params['id'] as string, limit);
    res.json({ deliveries });
  } catch (err) {
    log.error(`GET /api/admin/webhooks/:id/deliveries: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
