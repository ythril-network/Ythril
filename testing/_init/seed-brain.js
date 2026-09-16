#!/usr/bin/env node
/**
 * Seed a running Ythril instance with realistic-looking test brain data.
 *
 * Creates:
 *  - 3 extra spaces (work, personal, research)
 *  - 60 memories spread across spaces
 *  - 20 entities (people, organisations, concepts)
 *  - 15 edges linking entities
 *
 * Usage:
 *   node testing/_init/seed-brain.js [port] [token]
 *
 *   port   â€” defaults to 3200
 *   token  â€” defaults to content of testing/sync/configs/a/token.txt
 *
 * Examples:
 *   node testing/_init/seed-brain.js 3200 yt_mytoken123
 *   node testing/_init/seed-brain.js 3201 $(cat testing/sync/configs/b/token.txt)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT  = process.argv[2] ?? '3200';
const BASE  = `http://localhost:${PORT}`;
const TOKEN = process.argv[3] ?? readTokenFile();

function readTokenFile() {
  const p = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  console.error('No token provided and testing/sync/configs/a/token.txt not found.');
  console.error('Usage: node testing/_init/seed-brain.js <port> <token>');
  process.exit(1);
}

async function api(method, path_, body) {
  const res = await fetch(`${BASE}${path_}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path_} â†’ ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

// â”€â”€ Spaces â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const EXTRA_SPACES = [
  { id: 'work',     label: 'Work' },
  { id: 'personal', label: 'Personal' },
  { id: 'research', label: 'Research' },
];

async function ensureSpaces() {
  const existing = await api('GET', '/api/spaces');
  const existingIds = new Set(existing.spaces.map(s => s.id));

  for (const { id, label } of EXTRA_SPACES) {
    if (!existingIds.has(id)) {
      await api('POST', '/api/spaces', { id, label });
      console.log(`  Created space: ${id}`);
    } else {
      console.log(`  Space already exists: ${id}`);
    }
  }
}

// â”€â”€ Memories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MEMORIES = [
  // general
  { space: 'general', fact: 'The quick brown fox jumps over the lazy dog.', tags: ['animals', 'classic'] },
  { space: 'general', fact: 'Ythril stores memories, entities, and edges as a knowledge graph.', tags: ['ythril', 'product'] },
  { space: 'general', fact: 'ISO 27001 requires documented information security policies.', tags: ['security', 'compliance'] },
  { space: 'general', fact: 'The sync engine uses Merkle trees to detect divergence between instances.', tags: ['sync', 'architecture'] },
  { space: 'general', fact: 'Vector search enables semantic similarity queries over stored memories.', tags: ['search', 'embeddings'] },
  { space: 'general', fact: 'Rate limiting prevents brute-force attacks on the authentication layer.', tags: ['security'] },
  { space: 'general', fact: 'TypeScript strict mode catches many potential runtime errors at compile time.', tags: ['typescript', 'dev'] },
  { space: 'general', fact: 'bcrypt with cost factor 12 is used for all password and token hashing.', tags: ['security', 'crypto'] },
  { space: 'general', fact: 'Atomic file writes (write to tmp, then rename) prevent partial config corruption.', tags: ['reliability'] },
  { space: 'general', fact: 'MongoDB Atlas local image includes mongot for $vectorSearch support.', tags: ['mongodb', 'infrastructure'] },
  // work
  { space: 'work', fact: 'Q2 planning meeting scheduled for next Thursday at 14:00.', tags: ['meeting', 'planning'] },
  { space: 'work', fact: 'Sprint velocity has stabilised at 42 story points per two-week cycle.', tags: ['agile', 'metrics'] },
  { space: 'work', fact: 'The API latency SLO is p99 < 200 ms. Current p99 is 47 ms.', tags: ['slo', 'performance'] },
  { space: 'work', fact: 'Security audit report delivered. Three medium findings, zero criticals.', tags: ['security', 'audit'] },
  { space: 'work', fact: 'Annual penetration test booked for June 3â€“7.', tags: ['security', 'pentest'] },
  { space: 'work', fact: 'On-call rotation: Alice (Monâ€“Wed), Bob (Thuâ€“Fri), Carol (weekend).', tags: ['oncall', 'team'] },
  { space: 'work', fact: 'Customer A reported latency spikes on file upload. Traced to disk IOPS saturation.', tags: ['incident', 'files'] },
  { space: 'work', fact: 'The Kubernetes node was upgraded to 1.30.2 without downtime.', tags: ['kubernetes', 'ops'] },
  { space: 'work', fact: 'Data retention policy: logs kept 90 days, backups kept 1 year.', tags: ['policy', 'data'] },
  { space: 'work', fact: 'GDPR DPA signed with payment processor. DPO notified.', tags: ['gdpr', 'legal'] },
  { space: 'work', fact: 'Monitoring dashboard added alerts for MongoDB replication lag > 5 s.', tags: ['monitoring', 'mongodb'] },
  { space: 'work', fact: 'Code review turnaround target is 24 hours. Current average: 18 hours.', tags: ['dev', 'process'] },
  { space: 'work', fact: 'Rollback procedure documented in the runbook under /docs/runbook.md.', tags: ['ops', 'documentation'] },
  { space: 'work', fact: 'Risk register updated with three new items from the threat modelling session.', tags: ['security', 'risk'] },
  { space: 'work', fact: 'Budget approval for additional node required before end of quarter.', tags: ['budget', 'infrastructure'] },
  // personal
  { space: 'personal', fact: 'Started reading "Designing Data-Intensive Applications" by Kleppmann.', tags: ['books', 'learning'] },
  { space: 'personal', fact: 'Gym goal: 3Ã— per week. Currently averaging 2.3Ã—.', tags: ['health', 'goals'] },
  { space: 'personal', fact: 'Passport renewal due in 4 months. Book appointment online.', tags: ['admin', 'todo'] },
  { space: 'personal', fact: 'Flight booked to Amsterdam for the distributed systems conference.', tags: ['travel', 'conference'] },
  { space: 'personal', fact: 'Favourite coffee: single-origin Ethiopian, light roast, filter method.', tags: ['coffee', 'preferences'] },
  { space: 'personal', fact: 'Bought a mechanical keyboard: HHKB Professional Hybrid.', tags: ['hardware', 'tools'] },
  { space: 'personal', fact: 'Standing desk height: 118 cm sitting, 145 cm standing.', tags: ['ergonomics', 'setup'] },
  { space: 'personal', fact: 'Weekly review every Sunday at 19:00. Duration: ~30 minutes.', tags: ['productivity', 'routine'] },
  { space: 'personal', fact: 'Useful shell alias: alias k=kubectl', tags: ['dev', 'tips'] },
  { space: 'personal', fact: 'Completed the Advent of Code 2024 with Go. Finished 48/50 stars.', tags: ['programming', 'aoc'] },
  // research
  { space: 'research', fact: 'Merkle CRDT paper (Kleppmann & Beresford, 2017) covers conflict-free replicated data types over Merkle trees.', tags: ['crdt', 'sync', 'papers'] },
  { space: 'research', fact: 'The CALM theorem states: coordination-free programs maintain consistency iff they are monotone.', tags: ['distributed', 'theory'] },
  { space: 'research', fact: 'Vector clocks allow partial-order causality tracking across distributed nodes.', tags: ['distributed', 'clocks'] },
  { space: 'research', fact: 'RAFT consensus: leader election requires majority quorum. Split-brain impossible with odd node count.', tags: ['consensus', 'raft'] },
  { space: 'research', fact: 'Bloom filters enable membership tests with configurable false-positive rate and no false negatives.', tags: ['data-structures', 'probability'] },
  { space: 'research', fact: 'Consistent hashing minimises key redistribution when nodes are added or removed.', tags: ['distributed', 'hashing'] },
  { space: 'research', fact: 'LSM-tree writes are sequential (fast); reads require merging SSTables (slower without bloom filters).', tags: ['storage', 'lsm'] },
  { space: 'research', fact: 'Gossip protocols achieve eventual consistency with O(log N) convergence time.', tags: ['gossip', 'distributed'] },
  { space: 'research', fact: 'Two-phase commit (2PC) blocks if the coordinator crashes during the commit phase.', tags: ['distributed', '2pc'] },
  { space: 'research', fact: 'Paxos and RAFT are both crash fault-tolerant but not Byzantine fault-tolerant.', tags: ['consensus', 'fault-tolerance'] },
  { space: 'research', fact: 'Paxos Multi-Paxos variant reduces round-trips by electing a stable leader.', tags: ['consensus', 'paxos'] },
  { space: 'research', fact: 'Lamport clocks provide happens-before ordering but not wall-clock time.', tags: ['clocks', 'distributed'] },
  { space: 'research', fact: 'Key insight in CRDTs: commutativity + associativity + idempotency = merge without coordination.', tags: ['crdt', 'theory'] },
  { space: 'research', fact: 'Spanner uses TrueTime API (GPS + atomic clocks) to bound clock uncertainty to ~7 ms.', tags: ['spanner', 'google', 'distributed'] },
  { space: 'research', fact: 'Event sourcing: instead of mutating state, append events. State is a fold over the event log.', tags: ['event-sourcing', 'architecture'] },
  { space: 'research', fact: 'Append-only data structures simplify replication: no deleted rows, just new versions.', tags: ['architecture', 'immutability'] },
  { space: 'research', fact: 'Semantic search with nomic-embed-text achieves high recall on short factual sentences.', tags: ['embeddings', 'search', 'ml'] },
  { space: 'research', fact: 'Knowledge graph traversal: BFS for shortest path, DFS for exhaustive enumeration.', tags: ['graph', 'algorithms'] },
  { space: 'research', fact: 'HNSW index enables approximate nearest-neighbour search in O(log N) with tunable recall.', tags: ['ann', 'index', 'ml'] },
];

async function seedMemories() {
  let count = 0;
  for (const { space, fact, tags } of MEMORIES) {
    await api('POST', `/api/brain/spaces/${space}/facts`, { fact, tags });
    count++;
  }
  console.log(`  Created ${count} memories`);
}

// â”€â”€ Entities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ENTITIES = [
  { space: 'general',  name: 'Ythril',        type: 'product' },
  { space: 'general',  name: 'MongoDB',        type: 'technology' },
  { space: 'general',  name: 'TypeScript',     type: 'language' },
  { space: 'general',  name: 'Node.js',        type: 'runtime' },
  { space: 'general',  name: 'Docker',         type: 'technology' },
  { space: 'general',  name: 'Kubernetes',     type: 'technology' },
  { space: 'work',     name: 'Alice',          type: 'person' },
  { space: 'work',     name: 'Bob',            type: 'person' },
  { space: 'work',     name: 'Carol',          type: 'person' },
  { space: 'work',     name: 'Security Audit', type: 'event' },
  { space: 'research', name: 'Martin Kleppmann', type: 'person' },
  { space: 'research', name: 'CRDT',           type: 'concept' },
  { space: 'research', name: 'Raft',           type: 'algorithm' },
  { space: 'research', name: 'Paxos',          type: 'algorithm' },
  { space: 'research', name: 'HNSW',           type: 'algorithm' },
  { space: 'research', name: 'Bloom Filter',   type: 'data-structure' },
  { space: 'research', name: 'LSM Tree',       type: 'data-structure' },
  { space: 'research', name: 'Google Spanner', type: 'system' },
  { space: 'research', name: 'Event Sourcing', type: 'pattern' },
  { space: 'personal', name: 'HHKB',           type: 'product' },
];

const _entityIds = {};

async function seedEntities() {
  let count = 0;
  for (const { space, name, type } of ENTITIES) {
    const r = await api('POST', `/api/brain/spaces/${space}/entities`, { name, type });
    _entityIds[name] = { id: r._id ?? r.id, space };
    count++;
  }
  console.log(`  Created ${count} entities`);
}

// â”€â”€ Edges â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const EDGES = [
  { from: 'Ythril',          to: 'MongoDB',         label: 'stores data in',   space: 'general' },
  { from: 'Ythril',          to: 'TypeScript',      label: 'written in',       space: 'general' },
  { from: 'Ythril',          to: 'Node.js',         label: 'runs on',          space: 'general' },
  { from: 'Ythril',          to: 'Docker',          label: 'deployed via',     space: 'general' },
  { from: 'Docker',          to: 'Kubernetes',      label: 'orchestrated by',  space: 'general' },
  { from: 'Alice',           to: 'Security Audit',  label: 'owns',             space: 'work' },
  { from: 'Bob',             to: 'Security Audit',  label: 'participates in',  space: 'work' },
  { from: 'Carol',           to: 'Security Audit',  label: 'participates in',  space: 'work' },
  { from: 'Martin Kleppmann', to: 'CRDT',           label: 'authored paper on', space: 'research' },
  { from: 'CRDT',            to: 'Raft',            label: 'contrasts with',   space: 'research' },
  { from: 'Raft',            to: 'Paxos',           label: 'inspired by',      space: 'research' },
  { from: 'HNSW',            to: 'Bloom Filter',    label: 'similar trade-off to', space: 'research' },
  { from: 'LSM Tree',        to: 'Bloom Filter',    label: 'benefits from',    space: 'research' },
  { from: 'Google Spanner',  to: 'Paxos',           label: 'uses',             space: 'research' },
  { from: 'Event Sourcing',  to: 'CRDT',            label: 'related to',       space: 'research' },
];

async function seedEdges() {
  let count = 0;
  for (const { from, to, label, space } of EDGES) {
    const fromId = _entityIds[from]?.id;
    const toId   = _entityIds[to]?.id;
    if (!fromId || !toId) {
      console.warn(`  Skipping edge "${from} â†’ ${to}": entity not found`);
      continue;
    }
    await api('POST', `/api/brain/spaces/${space}/edges`, { from: fromId, to: toId, label });
    count++;
  }
  console.log(`  Created ${count} edges`);
}

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function main() {
  console.log(`Seeding brain at ${BASE}`);
  console.log('='.repeat(40));

  try {
    // Check connectivity
    const health = await fetch(`${BASE}/health`);
    if (!health.ok) throw new Error(`Health check failed: ${health.status}`);
    console.log('Health check: OK');

    // Verify token
    const me = await fetch(`${BASE}/api/tokens/me`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!me.ok) throw new Error(`Token verification failed: ${me.status}`);
    const meData = await me.json();
    console.log(`Authenticated as: ${meData.name}`);
    console.log();

    console.log('Creating spaces...');
    await ensureSpaces();

    console.log('\nSeeding memories...');
    await seedMemories();

    console.log('\nSeeding entities...');
    await seedEntities();

    console.log('\nSeeding edges...');
    await seedEdges();

    console.log('\nâœ“ Seed complete');
  } catch (err) {
    console.error('\nâœ— Seed failed:', err.message);
    process.exit(1);
  }
}

main();

