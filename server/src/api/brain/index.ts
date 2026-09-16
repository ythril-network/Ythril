/**
 * /api/brain router — mounts the per-resource sub-routers.
 *
 * Was a single 1734-line api/brain.ts with 39 routes (A17.3). Each sub-router declares full paths
 * (`/spaces/:spaceId/...`) and is mounted at this router's root, so every URL is unchanged.
 * Within a sub-router the original route order is preserved — that matters where paths overlap
 * (e.g. entities `/by-name` and `/by-ids` must stay ahead of `/:id`).
 */
import { Router } from 'express';
import { memoriesRouter } from './facts.js';
import { entitiesRouter } from './entities.js';
import { edgesRouter } from './edges.js';
import { linksRouter } from './links.js';
import { chronoRouter } from './chrono.js';
import { fileMetaRouter } from './file-meta.js';
import { searchRouter } from './search.js';
import { bulkRouter } from './bulk.js';
import { brainEventsRouter } from './events.js';
import { embedJobsRouter } from './embed-jobs.js';

export const brainRouter = Router();
brainRouter.use(memoriesRouter);
brainRouter.use(entitiesRouter);
brainRouter.use(edgesRouter);
brainRouter.use(linksRouter);
brainRouter.use(chronoRouter);
brainRouter.use(fileMetaRouter);
brainRouter.use(searchRouter);
brainRouter.use(bulkRouter);
brainRouter.use(brainEventsRouter);
brainRouter.use(embedJobsRouter);
