# MemoryArena

**Not released.** There is nothing to fetch, nothing to pin and no number to compare against. This folder
exists so that is a recorded fact rather than an omission somebody re-researches in three months.

| | |
|---|---|
| what it asks | does memory make an agent **finish the task**, not just recall the fact |
| state | announced by Bench'd, on their roadmap for Q3 2026 |
| available | no dataset, no harness, no published scores |
| checked | 2026-09-15, at `https://benchd.ai/benchmarks` |

## Why it is worth waiting for

LoCoMo and LongMemEval both ask a question and grade an answer. That measures memory the way a quiz measures
it, and it rewards a system that returns something plausible for every query — which is precisely how a bad
reranker looks good.

An agentic benchmark grades the outcome instead. Memory that returns the wrong thing confidently makes the
agent take a wrong action, and a wrong action fails the task whatever the retrieval scores said. It is the
only one of the three whose result cannot be improved by returning more.

That also makes it the one whose *cost* axis is real. An agent pays for every byte of memory in its own
context on every step, and a task is many steps — which is the measurement behind `includeRecordMeta` and the
MCP-side byte budget, and the axis on which this product is meant to win.

## When it lands

Pin the dataset the same way as the others: URL and sha256, refused on mismatch, never vendored. Its history
shape is task trajectories rather than dated chat sessions, so the conversation schema in `../space/` is
unlikely to fit unchanged — decide that from the released data, not from the announcement.
