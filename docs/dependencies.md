# Dependencies and Licensing Notes

This document explains how Ythril uses its runtime dependencies, the licensing
status of each, and why Ythril's AGPL-3.0 obligations are not affected by them.

---

## Node.js packages

All Node.js dependencies are listed in `package.json` and reproduced in [NOTICE](../NOTICE).
They are MIT, Apache 2.0, or ISC licensed. No copyleft restrictions apply.

---

## mongodb/mongodb-atlas-local (Docker image)

### What it is and why it is used

Ythril's `docker-compose.yml` references the official `mongodb/mongodb-atlas-local`
image published by MongoDB, Inc. on Docker Hub. It is used as the database backend.

The image bundles two processes:

| Process | Role | License |
|---------|------|---------|
| `mongod` | MongoDB Community Edition server | Server Side Public License v1 (SSPL) |
| `mongot` | Search and vector-index sidecar | Proprietary (MongoDB, Inc.) |

`mongot` is the reason this specific image is used instead of plain Community Edition.
Ythril issues `$vectorSearch` aggregation queries against MongoDB to power semantic
recall (`query`, `recall`, `recall_global` MCP tools). That stage requires `mongot`
to be running and connected to `mongod`. There is currently no fully open-source
drop-in replacement that provides equivalent vector search on top of MongoDB.

### How it is deployed

The image runs as a **separate container** (`ythril-mongo`) on a private Docker bridge
network (`ythril-internal`). Ythril connects to it over TCP at `mongodb://ythril-mongo:27017`.

```
[ythril container] --TCP:27017--> [ythril-mongo container]
                                   ├── mongod (SSPL)
                                   └── mongot (proprietary)
```

The `ythril-mongo` container has **no published ports** — it is not reachable from
the host or any external network. Only the `ythril` container can reach it, via
the internal bridge.

### Ythril does not distribute this image

Ythril's repository contains no MongoDB binaries, no `mongot` binary, and no
MongoDB source code. The `docker-compose.yml` file contains only a reference to
the image name on Docker Hub. Docker pulls the image separately when a user runs
`docker compose up`. Ythril is not the distributor.

### AGPL-3.0 compliance

**No conflict.** Here is why:

1. **No combined work.** Ythril communicates with `mongod`/`mongot` solely over a
   TCP socket. GPL-family copyleft extends to works that are statically linked or
   form a combined work in the same process. A database server accessed over a
   network socket is not a combined work with the client. This is the same legal
   relationship as any AGPL application using PostgreSQL, Redis, or any other
   server-based database.

2. **SSPL "Service Provision" clause does not apply.** SSPL's aggressive clause
   requires that if you make the covered software itself available as a service
   (i.e., you are offering MongoDB-as-a-service), you must open-source your entire
   service infrastructure. Ythril uses MongoDB as an internal component of a
   different application. It does not offer MongoDB as a service to anyone.

3. **mongot is external and not incorporated.** `mongot` is proprietary, but it
   runs as a separate process inside a separate container that Ythril never ships.
   No proprietary binary is incorporated into Ythril's source or distribution.

**Summary:** Ythril's AGPL-3.0 source obligations apply only to Ythril's own code.
They do not extend to `mongod`, `mongot`, or the `mongodb/mongodb-atlas-local` image.

### Honest disclosure

The semantic recall feature has a runtime dependency on a proprietary binary
(`mongot`). A deployment of Ythril with full functionality is therefore not a
fully open-source stack. This is an accepted constraint, documented here and in
[NOTICE](../NOTICE). It does not affect compliance, but it is worth knowing if
you are evaluating Ythril for an environment where fully open-source runtime
stacks are required.

A future Ythril version may introduce an alternative vector-search backend
(e.g., plain MongoDB CE + mongot CE Preview, or a different vector store) to
address this for users who need it.
