# Skill: report

Run and read MailAgent report agents (daily / weekly / monthly digests).

## Tools

| tool | scope | effect | confirm |
|---|---|---|---|
| `report_list` | `report:read` | read | none |
| `report_get` | `report:read` | read | none |
| `report_run` | `report:run` | external_call | **preview (confirm required)** |

## Usage

- `report_list {cadence?, agent_id?, limit?, offset?}` — list generated reports (newest first,
  no block bodies). `limit` is 1..200 (default 50) and `offset` >= 0; out-of-range values are
  rejected with `E_INVALID_ARG` rather than silently clamped.
- `report_get {report_id}` — one report's full detail (`doc` block model + `counts`).
- `report_run {agent_id, cadence?}` — generate a fresh report **now** (calls the LLM). Returns a
  `report_id` you then pass to `report_get`. Requires `confirm: true` in the invoke body:
  `preview` and `edit` tiers both need an explicit JSON boolean confirmation on the direct-invoke
  path — the tier decides what the approval card looks like, not whether one is needed.

## Handoff loop

The P1 acceptance loop is: `report_run` → take `report_id` → `report_get`. `report_run` requires
the separate `report:run` scope (it is an execute capability, not read).
