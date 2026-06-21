# Skill: report

Run and read MailAgent report agents (daily / weekly / monthly digests).

## Tools

| tool | scope | effect | confirm |
|---|---|---|---|
| `report_list` | `report:read` | read | none |
| `report_get` | `report:read` | read | none |
| `report_run` | `report:run` | external_call | preview |

## Usage

- `report_list {cadence?, agent_id?, limit?, offset?}` — list generated reports (newest first,
  no block bodies).
- `report_get {report_id}` — one report's full detail (`doc` block model + `counts`).
- `report_run {agent_id, cadence?}` — generate a fresh report **now** (calls the LLM). Returns a
  `report_id` you then pass to `report_get`.

## Handoff loop

The P1 acceptance loop is: `report_run` → take `report_id` → `report_get`. `report_run` requires
the separate `report:run` scope (it is an execute capability, not read).
