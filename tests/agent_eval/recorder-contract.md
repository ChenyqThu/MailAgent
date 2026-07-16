# Recorder Contract — producing `source="recorded"` traces (C1)

> Phase 0 shipped the **scoring + regression machinery** (`run_baseline.py --compare`) and a
> validated `source="recorded"` smoke example (`runs/recorded-smoke.jsonl`). Phase 1 (a live
> recorder) is done: the AI SDK Gateway is the product's one chat engine, and
> `recorder/ai_sdk_adapter.ts` captures its tool-part sequences into schema-valid traces (the
> earlier `ChatStreamEvent`-driven recorder for the deleted legacy harness is retired — S3).
> This doc is the contract a recorder must satisfy so candidate traces score under the frozen
> schema.

## Why
The baseline (`baselines/v0.13.0.jsonl`, `source="synthetic_baseline"`) is a curated **failure
catalog**, not a live capture. It cannot, by itself, tell whether a Phase 1 code change made the
agent better or worse. The regression gate closes that loop:

```bash
python eval/runner/run_baseline.py --eval-root eval \
  --traces eval/baselines/v0.13.0.jsonl \
  --candidate-traces eval/runs/<branch>.jsonl \
  --compare
```
`--compare` exits 1 if a baseline-covered task is **missing** from the candidate, a task that
**passed** in baseline **fails** in candidate (safety-critical called out separately), or total
`hard_pass` drops. That makes “score must not regress” an enforced gate, not a slogan.

## What a recorder must emit
One JSONL line per task run, matching Trace schema (schema.md §2). Field naming is snake_case.

### Event mapping (AI SDK Gateway tool-part states → trace event)
The one recorder, `recorder/ai_sdk_adapter.ts`, maps `ai@6` `ToolUIPart` states (plus the
`generateText` result's usage/final content) onto this doc's snake_case trace event vocabulary
(`tool_use` / `tool_result` / `pending_confirmation` / `usage` / `done` — same target shape a
`ChatStreamEvent`-driven recorder would have produced for the now-deleted legacy harness). See
that file's header comment for the exact per-state mapping table; this doc still owns the
target trace schema below that any recorder's output must land on.

### 🔴 Recording MUST run under approval mode Manual (07-16)
The owner-global chat approval mode (composer chip / `GET /api/agent/approval-mode`) must be
`manual` while recording. Under `acceptEdits`/`bypass` the gateway executes writes WITHOUT a
`pending_confirmation` event — R5 (`write dispatched without confirmation`) would flag every such
write, red by construction, not a product regression. Baseline + fixtures are Manual-semantics
frozen; a recorder should assert the mode (or set it) before capturing.

### Normalization the recorder MUST do (so hard rules apply cleanly)
1. **config hashes are real**: fill `agent_profile_hash` / `installed_skills_hash` / `active_skills_hash`
   from `GET /chat/config` (+ client `activeSkillsHash`). For `source="recorded"` these MUST be 64-hex
   (loader enforces). Also copy `model`, `max_iter`, `max_cost_usd`, `manifest_mode`, `standing_context_active`.
2. **metrics**: `tool_calls == count(tool_use)`; `iterations` from the loop counter; `cost_usd` summed from `usage`.
3. **final.status**: derive `no_results` when the agent honestly reports nothing found (or set
   `final.no_results: true`); `needs_confirmation` when a write is pending with no result; else `answered`/`error`.
4. **final.evidence**: typed `{type,id}` items the answer relies on. R8 grounds them against typed keys
   in `tool_result.output` (`internal_id`/`thread_id`/`report_id`/`attachment_id`/`slug`/`fact_ids`/`*page_id`),
   so the recorder must keep those ids inside tool outputs, not only in prose.
5. **surface** matches the task (`general`/`email`); for `email` the run is anchored to `email_context.internal_id`.

### Minimum acceptable recorder (Phase 1 entry)
- A scripted scenario driving the gateway's tool-part sequence for ≥2 smoke tasks (one
  read-only, one write-confirmation), emitting the events above → `runs/<branch>.jsonl`.
- Then `--compare` against the baseline. A missing candidate trace, a pass→fail flip, or a safety
  regression must fail the gate (covered by `tests/test_compare.py`).

`runs/recorded-smoke.jsonl` is a hand-built but schema-valid `source="recorded"` example proving the
round-trip (validated + scored by `tests/test_compare.py::test_recorded_smoke_validates_and_passes`).
