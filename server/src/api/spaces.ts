import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getConfig } from '../config/loader.js';
import { createSpace, removeSpace, slugify } from '../spaces/spaces.js';
import { z } from 'zod';

export const spacesRouter = Router();

const CreateSpaceBody = z.object({
  id: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).optional(),
  label: z.string().min(1).max(200),
  folders: z.array(z.string()).optional(),
  minGiB: z.number().positive().optional(),
});

// GET /api/spaces
spacesRouter.get('/', globalRateLimit, requireAuth, (_req, res) => {
  const spaces = getConfig().spaces.map(({ id, label, builtIn, folders, minGiB, flex }) => ({
    id, label, builtIn, folders, minGiB, flex,
  }));
  res.json({ spaces });
});

// POST /api/spaces
spacesRouter.post('/', globalRateLimit, requireAuth, async (req, res) => {
  const parsed = CreateSpaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { id: rawId, label, folders, minGiB } = parsed.data;
  const id = rawId ?? slugify(label);
  const space = await createSpace({ id, label, folders, minGiB });
  res.status(201).json({ space });
});

// DELETE /api/spaces/:id
spacesRouter.delete('/:id', globalRateLimit, requireAuth, async (req, res) => {
  const id = req.params['id'] as string;
  const ok = await removeSpace(id);
  if (!ok) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }
  res.status(204).end();
});
