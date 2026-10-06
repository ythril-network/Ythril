/**
 * Webhook management API — CRUD for webhook subscriptions.
 *
 * Route prefix: /api/admin/webhooks
 *
 * Authentication: requireAdmin (PAT Bearer token with admin flag)
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAdminMfa } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { isSsrfSafeUrl } from '../util/ssrf.js';
import {
  listWebhooks,
  getWebhook,
  getWebhookFull,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  listDeliveries,
} from '../webhooks/store.js';
import { deliverToWebhook } from '../webhooks/dispatcher.js';
import { ALL_WEBHOOK_EVENTS } from '../webhooks/types.js';
import type { WebhookEventType } from '../webhooks/types.js';
import { log } from '../util/log.js';
import { MAX_SPACE_IDS } from '../util/request-bounds.js';
import { parseLimit } from '../util/pagination.js';
import { sendCaughtFailure } from './send-failure.js';

export const webhooksRouter = Router();

// All routes require admin token + MFA (matches other admin endpoints)
webhooksRouter.use(globalRateLimit, requireAdminMfa);

// ── Validation schemas ──────────────────────────────────────────────────────

export const CreateBody = z.object({
  url: z.string().url()
    .refine(u => u.startsWith('https://'), { message: 'Webhook URL must use HTTPS' })
    .refine(u => isSsrfSafeUrl(u), { message: 'Webhook URL must not target private or reserved IP ranges' }),
  secret: z.string().min(8, 'Secret must be at least 8 characters'),
  spaces: z.array(z.string().min(1)).max(MAX_SPACE_IDS).optional(),
  events: z.array(z.string().refine(e => ALL_WEBHOOK_EVENTS.has(e), { message: 'Invalid event type' })).max(ALL_WEBHOOK_EVENTS.size).optional(),
  enabled: z.boolean().optional(),
});

export const UpdateBody = z.object({
  url: z.string().url()
    .refine(u => u.startsWith('https://'), { message: 'Webhook URL must use HTTPS' })
    .refine(u => isSsrfSafeUrl(u), { message: 'Webhook URL must not target private or reserved IP ranges' })
    .optional(),
  secret: z.string().min(8, 'Secret must be at least 8 characters').optional(),
  spaces: z.array(z.string().min(1)).max(MAX_SPACE_IDS).optional(),
  events: z.array(z.string().refine(e => ALL_WEBHOOK_EVENTS.has(e), { message: 'Invalid event type' })).max(ALL_WEBHOOK_EVENTS.size).optional(),
  enabled: z.boolean().optional(),
});

// ── GET /api/admin/webhooks — list all subscriptions ────────────────────────

webhooksRouter.get('/', async (_req, res) => {
  try {
    const webhooks = await listWebhooks();
    res.json({ webhooks });
  } catch (err) {
    sendCaughtFailure(res, `GET /api/admin/webhooks`, err);
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
    sendCaughtFailure(res, `GET /api/admin/webhooks/:id`, err);
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
    sendCaughtFailure(res, `POST /api/admin/webhooks`, err);
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
    sendCaughtFailure(res, `PATCH /api/admin/webhooks/:id`, err);
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
    sendCaughtFailure(res, `DELETE /api/admin/webhooks/:id`, err);
  }
});

// ── POST /api/admin/webhooks/:id/test — send a test event ───────────────────

webhooksRouter.post('/:id/test', async (req, res) => {
  try {
    const full = await getWebhookFull(req.params['id'] as string);
    if (!full) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    const payload = {
      event: 'test.ping' as const,
      timestamp: new Date().toISOString(),
      spaceId: '_test',
      spaceName: '_test',
      entry: { message: 'Test webhook delivery from Ythril' },
      ...(req.authToken && 'id' in req.authToken ? { tokenId: req.authToken.id } : {}),
      ...(req.authToken?.name ? { tokenLabel: req.authToken.name } : {}),
    };

    // Deliver directly to THIS webhook only — not broadcast via emitWebhookEvent
    deliverToWebhook(full, JSON.stringify(payload), 'test.ping', '_test').catch(err => {
      log.warn(`Test webhook delivery error for ${full.id}: ${err}`);
    });

    res.json({ ok: true, message: 'Test event queued for delivery' });
  } catch (err) {
    sendCaughtFailure(res, `POST /api/admin/webhooks/:id/test`, err);
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

    const limit = parseLimit(req.query['limit'], 100, 100);
    const deliveries = await listDeliveries(req.params['id'] as string, limit);
    res.json({ deliveries });
  } catch (err) {
    sendCaughtFailure(res, `GET /api/admin/webhooks/:id/deliveries`, err);
  }
});
