# Skill: notion_agent

Bridge to the `notion-agent` CLI for Notion-backed knowledge Q&A.

## Tools

| tool | scope | effect | confirm |
|---|---|---|---|
| `notion_agent_chat` | `notion_agent:invoke` | external_call | preview |

## Usage

- `notion_agent_chat {prompt, thread_id?, model?}` — ask the Notion knowledge agent. Pass
  `thread_id` (returned from a prior call) to continue the same conversation. Returns
  `{final_content, thread_id}`.

## Notes

This tool spawns the `notion-agent` subprocess (the tool's own domain implementation — it is
**not** a fork of the mailagent CLI). It is **disabled by default**, `mcp_exposed: false`, and
the `notion_agent:invoke` scope is **not** part of the default handoff key. Grant it only when an
external agent genuinely needs Notion knowledge access.
