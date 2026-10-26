# Skill: agents

Read the owner's custom agents (agents the owner configured to run on a schedule, on matching
mail, or on calendar events) and trigger one manual run of an enabled agent.

For *configuring* custom agents, see the `custom_agent` skill; that happens inside the MailAgent
app with the owner's approval, never through these tools.

## Tools

| tool | scope | effect | confirm |
|---|---|---|---|
| `custom_agent_list` | `agents:read` | read | none |
| `custom_agent_get` | `agents:read` | read | none |
| `custom_agent_run_now` | `agents:run` | write | **edit (confirm required)** |

## Usage

- `custom_agent_list {limit?}` — `{count, truncated, items}`; each item is `id, title, enabled,
  trigger`. `limit` is 1..100 (default 50).
- `custom_agent_get {agent_id, runs_limit?}` — `id, type, title, description, enabled, trigger,
  budget, updated_at` plus `recent_runs` (`job_id, state, outcome, approval_state, session_id,
  created_at, finished_at, error`). `runs_limit` is 0..20 (default 5). `state` is authoritative:
  `skipped` means the daily run limit prevented execution, and a `paused_*` run is not finished.
- `custom_agent_run_now {agent_id}` — queue one run now and return
  `{job_id, agent_id, status, was_created}` without waiting; `status` is `queued`, or `skipped`
  when the agent's daily run limit is already used up. Check the outcome later with
  `custom_agent_get`.

An unknown `agent_id` (or one that is not a custom agent) returns `E_NOT_FOUND`. Out-of-range
numbers are rejected with `E_INVALID_ARG`.

## custom_agent_run_now rules

- Requires the separate `agents:run` scope and `confirm: true` (a JSON boolean). On the MCP path
  `confirm` is filled in by the calling model; it marks intent, it is not a human approval — set
  the tool to "ask before running" in your MCP client if a person should approve each run.
- At most 10 calls per key per hour (`E_RATE_LIMITED`, HTTP 429).
- A disabled agent is refused with `E_CONFLICT` (409); nothing is queued and the daily run count
  is not touched.
- The only input is `agent_id`. The run uses the agent's own instructions and permissions;
  nothing in the call can add instructions or change its configuration. Write tools inside the run
  still follow the owner's approval rules, so a run may pause waiting for the owner.
- When the owner has turned custom agents off (`MAILAGENT_CUSTOM_AGENTS_ENABLED=false`), all three
  tools return `E_SKILL_DISABLED` (409).

The agent's instructions, model and tool permissions are not exposed.
