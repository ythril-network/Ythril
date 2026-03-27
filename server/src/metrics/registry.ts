/**
 * Prometheus metrics registry for Ythril.
 *
 * Defines and exports all application metrics collected by prom-client.
 * Default process metrics (CPU, memory, event loop lag, GC) are registered
 * automatically via `collectDefaultMetrics()`.
 *
 * Async gauges (brain counts, storage usage) use the `collect` callback to
 * query MongoDB / disk at scrape time so the data is always fresh.
 */

import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
} from 'prom-client';
import { col } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { measureUsage } from '../quota/quota.js';

export const register = new Registry();

// ── Default process metrics (CPU, memory, event loop lag, GC) ──────────────
collectDefaultMetrics({ register });

// ── HTTP ────────────────────────────────────────────────────────────────────

export const httpRequestsTotal = new Counter({
  name: 'ythril_http_requests_total',
  help: 'Total HTTP requests by method, route pattern, and status code',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'ythril_http_request_duration_seconds',
  help: 'HTTP request latency in seconds by method and route pattern',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const httpRequestSizeBytes = new Histogram({
  name: 'ythril_http_request_size_bytes',
  help: 'HTTP request body size in bytes',
  labelNames: ['method', 'route'] as const,
  buckets: [0, 100, 1000, 10_000, 100_000, 1_000_000, 10_000_000],
  registers: [register],
});

export const httpResponseSizeBytes = new Histogram({
  name: 'ythril_http_response_size_bytes',
  help: 'HTTP response body size in bytes',
  labelNames: ['method', 'route'] as const,
  buckets: [0, 100, 1000, 10_000, 100_000, 1_000_000, 10_000_000],
  registers: [register],
});

// ── Brain data (gauges collected at scrape time) ────────────────────────────

export const memoriesTotal = new Gauge({
  name: 'ythril_memories_total',
  help: 'Total number of memories by space',
  labelNames: ['space'] as const,
  registers: [register],
  async collect() {
    try {
      const cfg = getConfig();
      for (const space of cfg.spaces.filter(s => !s.proxyFor)) {
        const count = await col(`${space.id}_memories`).countDocuments({});
        this.set({ space: space.id }, count);
      }
    } catch { /* MongoDB may not be ready at startup */ }
  },
});

export const entitiesTotal = new Gauge({
  name: 'ythril_entities_total',
  help: 'Total number of entities by space',
  labelNames: ['space'] as const,
  registers: [register],
  async collect() {
    try {
      const cfg = getConfig();
      for (const space of cfg.spaces.filter(s => !s.proxyFor)) {
        const count = await col(`${space.id}_entities`).countDocuments({});
        this.set({ space: space.id }, count);
      }
    } catch { /* ignore */ }
  },
});

export const edgesTotal = new Gauge({
  name: 'ythril_edges_total',
  help: 'Total number of edges by space',
  labelNames: ['space'] as const,
  registers: [register],
  async collect() {
    try {
      const cfg = getConfig();
      for (const space of cfg.spaces.filter(s => !s.proxyFor)) {
        const count = await col(`${space.id}_edges`).countDocuments({});
        this.set({ space: space.id }, count);
      }
    } catch { /* ignore */ }
  },
});

export const chronoEntriesTotal = new Gauge({
  name: 'ythril_chrono_entries_total',
  help: 'Total number of chrono entries by space',
  labelNames: ['space'] as const,
  registers: [register],
  async collect() {
    try {
      const cfg = getConfig();
      for (const space of cfg.spaces.filter(s => !s.proxyFor)) {
        const count = await col(`${space.id}_chrono`).countDocuments({});
        this.set({ space: space.id }, count);
      }
    } catch { /* ignore */ }
  },
});

export const spacesTotal = new Gauge({
  name: 'ythril_spaces_total',
  help: 'Number of configured spaces',
  registers: [register],
  collect() {
    try {
      const cfg = getConfig();
      this.set(cfg.spaces.length);
    } catch { /* ignore */ }
  },
});

// ── Embeddings ───────────────────────────────────────────────────────────────

export const embeddingDurationSeconds = new Histogram({
  name: 'ythril_embedding_duration_seconds',
  help: 'Time to compute a single embedding vector',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const embeddingQueueDepth = new Gauge({
  name: 'ythril_embedding_queue_depth',
  help: 'Number of pending embedding operations',
  registers: [register],
});

export const reindexInProgress = new Gauge({
  name: 'ythril_reindex_in_progress',
  help: '1 if a reindex operation is currently running, 0 otherwise',
  registers: [register],
});

// ── Storage (collected at scrape time) ──────────────────────────────────────

export const storageUsedBytes = new Gauge({
  name: 'ythril_storage_used_bytes',
  help: 'Storage used in bytes by area (brain, files, total)',
  labelNames: ['area'] as const,
  registers: [register],
  async collect() {
    try {
      const usage = await measureUsage();
      const GiB = 1024 ** 3;
      this.set({ area: 'files' }, usage.files * GiB);
      this.set({ area: 'brain' }, usage.brain * GiB);
      this.set({ area: 'total' }, usage.total * GiB);
    } catch { /* ignore */ }
  },
});

export const storageLimitBytes = new Gauge({
  name: 'ythril_storage_limit_bytes',
  help: 'Configured storage limit in bytes by area and tier (soft, hard)',
  labelNames: ['area', 'tier'] as const,
  registers: [register],
  collect() {
    try {
      const cfg = getConfig();
      const GiB = 1024 ** 3;
      const storage = cfg.storage;
      if (!storage) return;
      if (storage.total?.softLimitGiB != null) this.set({ area: 'total', tier: 'soft' }, storage.total.softLimitGiB * GiB);
      if (storage.total?.hardLimitGiB != null) this.set({ area: 'total', tier: 'hard' }, storage.total.hardLimitGiB * GiB);
      if (storage.files?.softLimitGiB != null) this.set({ area: 'files', tier: 'soft' }, storage.files.softLimitGiB * GiB);
      if (storage.files?.hardLimitGiB != null) this.set({ area: 'files', tier: 'hard' }, storage.files.hardLimitGiB * GiB);
      if (storage.brain?.softLimitGiB != null) this.set({ area: 'brain', tier: 'soft' }, storage.brain.softLimitGiB * GiB);
      if (storage.brain?.hardLimitGiB != null) this.set({ area: 'brain', tier: 'hard' }, storage.brain.hardLimitGiB * GiB);
    } catch { /* ignore */ }
  },
});

// ── Authentication ───────────────────────────────────────────────────────────

export const authAttemptsTotal = new Counter({
  name: 'ythril_auth_attempts_total',
  help: 'Authentication attempts by result (success, invalid, expired)',
  labelNames: ['result'] as const,
  registers: [register],
});

export const tokensActive = new Gauge({
  name: 'ythril_tokens_active',
  help: 'Number of active (non-expired) tokens',
  registers: [register],
  collect() {
    try {
      const cfg = getConfig();
      const now = new Date();
      const active = cfg.tokens.filter(
        t => !t.expiresAt || new Date(t.expiresAt) > now,
      ).length;
      this.set(active);
    } catch { /* ignore */ }
  },
});

// ── MCP ──────────────────────────────────────────────────────────────────────

export const mcpConnectionsActive = new Gauge({
  name: 'ythril_mcp_connections_active',
  help: 'Current number of active MCP SSE connections',
  registers: [register],
});

export const mcpToolCallsTotal = new Counter({
  name: 'ythril_mcp_tool_calls_total',
  help: 'MCP tool invocations by tool name and space',
  labelNames: ['tool', 'space'] as const,
  registers: [register],
});

// ── Sync ─────────────────────────────────────────────────────────────────────

export const syncCyclesTotal = new Counter({
  name: 'ythril_sync_cycles_total',
  help: 'Sync cycles by network and status (success, partial, error)',
  labelNames: ['network', 'status'] as const,
  registers: [register],
});

export const syncItemsPulledTotal = new Counter({
  name: 'ythril_sync_items_pulled_total',
  help: 'Items received during sync by type (memories, entities, edges, files, chrono)',
  labelNames: ['type'] as const,
  registers: [register],
});

export const syncItemsPushedTotal = new Counter({
  name: 'ythril_sync_items_pushed_total',
  help: 'Items sent during sync by type (memories, entities, edges, files, chrono)',
  labelNames: ['type'] as const,
  registers: [register],
});

export const syncDurationSeconds = new Histogram({
  name: 'ythril_sync_duration_seconds',
  help: 'Time per sync cycle in seconds',
  labelNames: ['network'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});
