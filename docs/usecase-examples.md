# Ythril — Use Case Examples

Practical scenarios showing how Ythril spaces and networks solve real knowledge management challenges.

> **How entity linking works in these examples:**
>
> - **The parameter is `entityIds`, and it takes IDs — not `entities`, and not names.** `save_fact`'s schema declares `entityIds` with `additionalProperties: false`, so a call passing `entities` is refused outright rather than ignored. Look the entity up first (`find_entities_by_name`) and pass its id.
> - **An unresolved reference is a HARD ERROR, not a skipped one.** It is refused before the write, so the memory is not stored at all. This note described a warning on a write that had already happened, and quoted a message (*"Unresolved entity names — create them first"*) that appears nowhere in the product.
> - **`strictLinkage` is ON by default** — an absent setting means strict. So passing entity NAMES where an id is wanted fails on an ordinary space: chrono `entityIds` answers *"must contain valid UUID v4 values (entity IDs), not names"*, and an unresolvable edge endpoint is refused too. This note said strict was off by default, which made every example below it look like it would work as written.

---

## Contents

### [Sharing & Distribution](usecase-examples/01-sharing-and-distribution.md#sharing--distribution)

- [1. Personal Multi-Device Sync](usecase-examples/01-sharing-and-distribution.md#1-personal-multi-device-sync)
- [2. Engineering Team Knowledge Base](usecase-examples/01-sharing-and-distribution.md#2-engineering-team-knowledge-base)
- [3. Company Policy Distribution](usecase-examples/01-sharing-and-distribution.md#3-company-policy-distribution)
- [4. Multi-Tier R&D Knowledge Cascade](usecase-examples/01-sharing-and-distribution.md#4-multi-tier-rd-knowledge-cascade)
- [5. Open Source Project — Maintainer Group](usecase-examples/01-sharing-and-distribution.md#5-open-source-project--maintainer-group)
- [6. Consultant ↔ Client Knowledge Handoff](usecase-examples/01-sharing-and-distribution.md#6-consultant--client-knowledge-handoff)
- [7. Cross-Department Knowledge Sharing (Multiple Networks)](usecase-examples/01-sharing-and-distribution.md#7-cross-department-knowledge-sharing-multiple-networks)
- [8. Federated AI Training Dataset Curation](usecase-examples/01-sharing-and-distribution.md#8-federated-ai-training-dataset-curation)
- [9. LLM With Persistent Memory Across Conversations](usecase-examples/01-sharing-and-distribution.md#9-llm-with-persistent-memory-across-conversations)

### [Operations, Research & Agents](usecase-examples/02-operations-research-and-agents.md#operations-research--agents)

- [10. On-Call Runbook That Learns From Incidents](usecase-examples/02-operations-research-and-agents.md#10-on-call-runbook-that-learns-from-incidents)
- [11. Legal / Compliance Audit Trail With Temporal Proof](usecase-examples/02-operations-research-and-agents.md#11-legal--compliance-audit-trail-with-temporal-proof)
- [12. Multi-Tenant SaaS Knowledge Isolation With MCP](usecase-examples/02-operations-research-and-agents.md#12-multi-tenant-saas-knowledge-isolation-with-mcp)
- [13. Personal CRM — Your LLM Remembers Every Person You Meet](usecase-examples/02-operations-research-and-agents.md#13-personal-crm--your-llm-remembers-every-person-you-meet)
- [14. Competitive Intelligence With Source Tracking](usecase-examples/02-operations-research-and-agents.md#14-competitive-intelligence-with-source-tracking)
- [15. Dev Environment Bootstrap — New Hire Onboarding in Minutes](usecase-examples/02-operations-research-and-agents.md#15-dev-environment-bootstrap--new-hire-onboarding-in-minutes)
- [16. Research Paper Writing With Citation Graph](usecase-examples/02-operations-research-and-agents.md#16-research-paper-writing-with-citation-graph)

### [Proxy, Multi-Space & Personal](usecase-examples/03-proxy-multi-space-and-personal.md#proxy-multi-space--personal)

- [17. M&A Due Diligence — Multi-Space Deal Rooms With Proxy Oversight](usecase-examples/03-proxy-multi-space-and-personal.md#17-ma-due-diligence--multi-space-deal-rooms-with-proxy-oversight)
- [18. Global Engineering Org — Same Space in Multiple Networks](usecase-examples/03-proxy-multi-space-and-personal.md#18-global-engineering-org--same-space-in-multiple-networks)
- [19. Consulting Firm — Client Spaces, Internal Space, Proxy Dashboard](usecase-examples/03-proxy-multi-space-and-personal.md#19-consulting-firm--client-spaces-internal-space-proxy-dashboard)
- [20. Hospital Network — Departmental Spaces With Hierarchical Distribution and Cross-Department Search](usecase-examples/03-proxy-multi-space-and-personal.md#20-hospital-network--departmental-spaces-with-hierarchical-distribution-and-cross-department-search)
- [21. Multi-Account Portfolio Intelligence — Personal Finance Without a Cloud](usecase-examples/03-proxy-multi-space-and-personal.md#21-multi-account-portfolio-intelligence--personal-finance-without-a-cloud)
- [22. Market Analysis Desk — Analysts + Feeds + Broker Overlay](usecase-examples/03-proxy-multi-space-and-personal.md#22-market-analysis-desk--analysts--feeds--broker-overlay)
- [23. Intelligence Collection — Compartmented Sources With Fusion Proxy](usecase-examples/03-proxy-multi-space-and-personal.md#23-intelligence-collection--compartmented-sources-with-fusion-proxy)
- [24. Family Knowledge Hub — Shared Household, Personal Privacy](usecase-examples/03-proxy-multi-space-and-personal.md#24-family-knowledge-hub--shared-household-personal-privacy)
- [25. Smart Home — Device Logs, Automations, and Energy Intelligence](usecase-examples/03-proxy-multi-space-and-personal.md#25-smart-home--device-logs-automations-and-energy-intelligence)
- [26. Dev Project Brain — Per-Dependency Documentation Spaces](usecase-examples/03-proxy-multi-space-and-personal.md#26-dev-project-brain--per-dependency-documentation-spaces)
- [27. Public Documentation Hub — Zero-Friction Knowledge Distribution](usecase-examples/03-proxy-multi-space-and-personal.md#27-public-documentation-hub--zero-friction-knowledge-distribution)
- [Entity Merge — Deduplication & Aggregation](usecase-examples/03-proxy-multi-space-and-personal.md#entity-merge--deduplication--aggregation)
