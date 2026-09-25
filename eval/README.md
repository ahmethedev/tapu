# Manual task evaluation

Tapu's claim is a hypothesis: a persistent, deterministic, selectively retrievable schema representation lets a coding agent finish the same database task with fewer total tokens, fewer interactions and less waiting, without losing correctness. This protocol tests that claim with an external coding agent. Tapu and its test suite make no LLM calls.

**Status: not run.** No results exist yet. Do not quote numbers from this directory until a results file records real observations.

## What is measured

Primary efficiency metrics, per task run:

- Total agent input and output tokens for the whole task, including tool definitions and every tool result, as reported by the agent or its API usage logs.
- Tool calls and agent-model round trips, counted separately.
- End-to-end task duration (wall clock), plus local retrieval time and database access time where the agent's logs expose them.

Required quality guardrails:

- Correctness against the task's predefined rubric in [tasks.md](tasks.md), including business-rule violations.
- Human corrections and review effort (minutes, number of requested changes).
- Relevant facts omitted, semantics lost, or stale snapshot data treated as live.

Adoption costs, recorded separately from the task runs:

- Time from a fresh checkout to the first useful Tapu result (install, `tapu init`, MCP setup).
- Optional note-authoring and maintenance effort (only for the enriched suite).

If actual token usage is unavailable, record it as unavailable. Do not substitute output character counts or the `scripts/token-compare.ts` estimates for measured whole-task consumption.

## Conditions

Run every task under each condition:

1. **Existing project baseline.** The agent's normal workflow for this repository and database: reading migrations, running `psql`, using whatever efficient tools it already has.
2. **Equivalent-knowledge baseline.** The same supported schema facts, and for the enriched suite the same human notes, in a compact ordinary form: for example a checked-in DDL dump plus a notes file, or an existing schema tool. This separates the value of Tapu's compilation, selection, batching and freshness checks from the value of simply having the facts or newly written notes.
3. **Tapu.** The same repository and database, with `tapu init` run and the documented workflow available through the CLI or MCP (the AGENTS.md paragraph from `tapu init`).

## Procedure

1. Fix the task set and rubrics in [tasks.md](tasks.md) before the first run. Agree any numeric success thresholds before collecting results; do not adjust them after seeing runs.
2. Hold constant: model and version, task wording, agent permissions, initial database state (load `test/fixture.sql`, plus `createBulkSchema` from `test/helpers.ts` for the "many unrelated objects" task), and the rubric.
3. Use a fresh agent session per run. Reset the repository and database between runs.
4. For the enriched suite only, apply the reviewed example notes (`applyExampleNotes` in `test/fixture-notes.ts`) under both condition 2 (as a plain notes file) and condition 3.
5. Repeat each task/condition pair several times where practical, in an interleaved order. Keep failed and abandoned runs.
6. Record every run in a copy of [results-template.md](results-template.md).

## Reporting

- Report the metadata-only suite and the enriched suite separately. If benefits appear only in the enriched suite, the agent-native interface hypothesis is not supported by these runs; report that plainly.
- Report medians and ranges with the number of runs. With a small exploratory sample, do not claim statistical significance.
- Report efficiency together with the guardrails; an efficiency gain that required extra human repair is not a gain.
- Keep representation sizes from `npm run token-compare` separate: they describe response sizes, not task efficiency.
