# Ythril Integration Guide

API and MCP reference for developers building on Ythril. The guide is split by topic; each part below
stands on its own.

> This page is **only an index** — every statement lives in exactly one part, so there is no second
> place to keep in sync. `split-guide-indexes.test.js` fails if this list and the files on disk
> disagree.

## Contents

1. [Getting Ythril](integration-guide/01-getting-ythril.md)
2. [Hosting](integration-guide/02-hosting.md)
3. [Authentication, Errors & Rate Limits](integration-guide/03-auth-and-limits.md)
   Error Format · Rate Limits
4. [Brain API](integration-guide/04-brain-api.md)
   [Recall & Similarity](integration-guide/04a-recall-api.md) · [Entities, Edges & Graph](integration-guide/04b-graph-api.md) · [Chrono](integration-guide/04c-chrono-api.md) · [Stats, Maintenance & Bulk](integration-guide/04d-brain-ops-api.md) · [Choosing a Search](integration-guide/04e-choosing-a-search.md) · [Write & Read Semantics](integration-guide/04f-write-semantics.md) · [Links](integration-guide/04g-links-api.md)
5. [Files API](integration-guide/05-files-api.md)
   [Conversion Pipeline](integration-guide/05a-conversion-pipeline.md) · [Media Embedding](integration-guide/05b-media-embedding.md) · [Face Recognition](integration-guide/05c-face-recognition.md)
6. [Spaces API](integration-guide/06-spaces-api.md)
   [Space Schemas & Validation](integration-guide/06a-schema-api.md) · [Schema Library](integration-guide/06b-schema-library-api.md)
7. [Tokens API](integration-guide/07-tokens-api.md)
8. [Networks & Invite APIs](integration-guide/08-networks-api.md)
   Invite API
9. [Notify & Sync APIs](integration-guide/09-sync-api.md)
   Sync API
10. [MFA & Conflicts APIs](integration-guide/10-mfa-and-conflicts.md)
   Conflicts API
11. [Setup API](integration-guide/11-setup-api.md) — first-run setup, health and readiness probes, and the
    **Prometheus metrics reference** (every series `/metrics` exposes, with what each one means)
12. [Admin & Data Management APIs](integration-guide/12-admin-api.md)
   Reference integrity · Data Management API
13. [Audit Log API](integration-guide/13-audit-log-api.md)
14. [Duplicates & Webhooks](integration-guide/14-duplicates-and-webhooks.md)
   Webhooks API
15. [About, Theme & Embedded Mode](integration-guide/15-about-and-embedding.md)
   Theme API · Embedded (chrome-less) Mode
16. [MCP (Model Context Protocol)](integration-guide/16-mcp.md)
17. [Quotas, Pagination & OIDC](integration-guide/17-quotas-pagination-oidc.md)
   Pagination · OIDC (OpenID Connect) Authentication
