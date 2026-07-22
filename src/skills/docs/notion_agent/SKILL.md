# Skill: notion_agent

Delegate Notion-workspace **questions and tasks** to the `notion-agent` CLI, which runs as a
separate AI with the owner's **bound Custom Agent persona**. The general agent calls this skill on
the user's behalf — the user does not talk to the notion-agent directly.

## Tools

| tool | scope | effect | confirm |
|---|---|---|---|
| `notion_agent_chat` | `notion_agent:invoke` | external_call | preview (edit-tier / 恒 HITL at the gateway) |

## Capabilities

The notion-agent is a full agent over the Notion workspace, so `notion_agent_chat` can:

- **Answer questions** grounded in the Notion workspace (look up a page, summarise notes, find a
  record, …).
- **Execute Notion tasks** — with the bound Custom Agent persona doing the work — such as updating a
  schedule / calendar entry, editing a **context page** or notes page, or making other Notion-side
  edits the user asks for.

## Usage

- `notion_agent_chat {prompt, thread_id?, model?}` — send a natural-language `prompt` describing
  what to find or do. Returns `{final_content, thread_id}`.
- **Continuation (`thread_id`)** — pass the `thread_id` returned by a previous call to continue the
  **same** Notion conversation (the notion-agent keeps its own thread state); omit it to start a
  fresh thread.
- **`model`** — optional override of the bound default model.

## Modes & the long-task limit

The CLI has two modes: a **synchronous `chat`** (waits for the answer, ~seconds) and an
**asynchronous `runs`** detach mode for long jobs. `notion_agent_chat` uses the **synchronous
`chat`** path only.

- 🔴 It **blocks until the notion-agent finishes**, so it is only a good fit for **quick lookups and
  small edits** (seconds). A task you expect to take **longer than ~60s** is **not** suitable for
  this synchronous call — it will tie up the turn and may hit the idle watchdog. The async `runs`
  mode is **not** exposed here in the MVP; if a request clearly needs a long-running job, tell the
  user rather than firing a synchronous call that will stall.

## Safety

- **External AI execution.** Each call hands the `prompt` to a separate AI process; the prompt (and
  any workspace data it carries) leaves this machine for the notion-agent.
- **Side effects land on the Notion side.** A task the notion-agent performs (schedule update, page
  edit, …) changes the real Notion workspace.
- **恒 HITL — approve before it runs.** At the gateway this is an edit-tier tool: the user sees an
  approval card previewing the prompt (and the continued `thread_id`) and must approve every call.
  It never auto-approves and is not on any whitelist.
- **Irreversible once approved.** A Notion write the notion-agent makes after approval **cannot be
  undone from here**.

## Configuration

Binding (which Custom Agent persona to run as), the default model, and connectivity/auth are managed
under **Settings → Custom AI → Skills → Notion Agent** (expand the skill row): pick the bound agent,
set the default model, and run **doctor** for a live connectivity/auth readout. Authentication
(`token_v2`) itself is set with the CLI — run `notion-agent init` when doctor reports no token.

## Notes

This tool spawns the `notion-agent` subprocess (the tool's own domain implementation — it is
**not** a fork of the mailagent CLI). It is **disabled by default**, `mcp_exposed: false`, and the
`notion_agent:invoke` scope is **not** part of the default handoff key. Grant it to an external agent
only when that agent genuinely needs Notion access.
