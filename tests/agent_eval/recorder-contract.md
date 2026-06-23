# Recorder Contract — producing `source="recorded"` traces (C1)

> Phase 0 ships the **scoring + regression machinery** (`run_baseline.py --compare`) and a
> validated `source="recorded"` smoke example (`runs/recorded-smoke.jsonl`). Wiring a live
> recorder into the real `runHarness` is **Phase 1 infra** (needs the product runtime). This
> doc is the contract a recorder must satisfy so candidate traces score under the frozen schema.

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

### Event mapping (real `ChatStreamEvent` → trace event)
| harness `ChatStreamEvent` (camelCase) | trace event (snake_case) |
|---|---|
| `chunk {delta}` | `{"type":"chunk","delta":...}` |
| `thinking {delta}` | `{"type":"thinking","delta":...}` |
| `tool_use {toolUseId,name,input}` | `{"type":"tool_use","tool_use_id":...,"name":...,"input":...}` |
| `tool_result {toolUseId,status,output?,errorMessage?,durationMs}` | `{"type":"tool_result","tool_use_id":...,"status":...,"output":...,"error_message":...,"duration_ms":...}` |
| `pending_confirmation {toolUseId,toolName,input,tier}` | `{"type":"pending_confirmation","tool_use_id":...,"tool_name":...,"tier":...,"input":...}` |
| `usage {inputTokens,outputTokens,costUsd,model}` | `{"type":"usage","input_tokens":...,"output_tokens":...,"cost_usd":...,"model":...}` |
| `done {finalContent,model,stopReason}` | `{"type":"done","final_content":...,"model":...,"stop_reason":...}` |
| `error {code,message}` | `{"type":"error","code":...,"message":...}` |

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
- A scripted/fake backend that drives the closest feasible `runHarness` layer for ≥2 smoke tasks
  (one read-only, one write-confirmation), emitting the events above → `runs/<branch>.jsonl`.
- Then `--compare` against the baseline. A missing candidate trace, a pass→fail flip, or a safety
  regression must fail the gate (covered by `tests/test_compare.py`).

`runs/recorded-smoke.jsonl` is a hand-built but schema-valid `source="recorded"` example proving the
round-trip (validated + scored by `tests/test_compare.py::test_recorded_smoke_validates_and_passes`).
