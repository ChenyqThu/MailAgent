# Skill: custom_agent

Create and update MailAgent Custom Agents through conversation. This skill is the configuration
contract and workflow; execution stays on the existing six Custom Agent CRUD tools and their
mandatory approval cards.

## Workflow

1. Understand the job the user wants the agent to own.
2. Ask only for missing information in three areas:
   - trigger: manual draft, schedule plus timezone, or matching email conditions;
   - capability scope: choose every tier below;
   - output: conversational result, saved report, or another clearly described deliverable.
3. For an update, list or fetch the existing agent first. Preserve anything the user did not ask to
   change.
4. Optionally collect a description of at most 1000 characters. It explains when the main agent
   should discover and choose this specialist in the Agent Catalog; it is not the run instruction.
5. Show a complete configuration summary: id/title/description, instructions, trigger, timezone, all six
   capability tiers, output, daily run limit, maximum runtime, enabled state, and mounted skills.
6. Ask the user to agree to that summary. Only then call the create or update tool. The tool's
   approval card is the final authorization gate; never bypass or pre-approve it.
7. Report success only from the returned tool result. A rejected, failed, or missing result is not a
   successful change.

## Capability vocabulary

Use these tiers in summaries and tool inputs. Do not expose or guess individual atomic tool names in
the normal workflow.

| Capability | Tiers | Meaning |
|---|---|---|
| Email | `read` / `organize` / `draft` | Read mail; additionally organize the mailbox; additionally create and update drafts. |
| Calendar | `off` / `read` / `write` | No calendar access; read events; additionally propose calendar changes. |
| Knowledge and sessions | `off` / `on` | Access conversation history, identity documents, installed Skills, and the knowledge system. Defaults off unless the task needs it. |
| Reports | `read` / `produce` | Read saved reports; additionally save structured reports from runs. |
| Web | `off` / `gated` / `open` | No web; owner-controlled domain access; any URL. `open` is high risk. |
| Files and commands | `off` / `on` | No local execution; or local file/command execution. `on` is high risk. |

## Trigger contract

- Manual draft: no trigger. The agent can still be run manually.
- Schedule: collect the intended frequency, local time, and IANA timezone. Prefer the structured
  daily/weekly/monthly schedule form; use a cron expression only when the schedule cannot express
  the request.
- Email event: collect at least one sender, subject, or folder condition. Never invent a broad match
  when the user has not supplied one.
- Calendar change (`calendar_event_change`): runs when matching event business fields change; key
  filters are `title_pattern`, `organizer_pattern`, `attendee_pattern`, and `calendar_ids`.
- Before start (`calendar_before_start`): runs at event start minus `lead_seconds`, optionally using
  the same filters; lead time must be from 60 seconds through 30 days (2,592,000 seconds).

## Safety floors

- Calendar write always needs human approval. It cannot receive a card-free rule.
- Email draft and mailbox-organizing writes ask for approval unless the owner separately creates a
  narrow rule in Settings.
- Web and Files/commands grants only make those capabilities available. They do not create domain or
  command allowlists and do not remove first-run approval.
- Knowledge and sessions defaults off because it can expose historical and identity context.
- Creating, updating, deleting, and running an agent are capability changes and remain unavailable
  to headless agents.

## CRUD selection

- Use the list/get reads to find and inspect agents before editing.
- Use create only for a new id and update only for an existing id.
- Use delete only when the user explicitly asks to remove an agent.
- Use run-now only when the user explicitly asks to execute it immediately.

For normal create/update requests, pass the capability-tier object. The Advanced atomic
configuration is only for a user who explicitly asks to preserve or edit individual tools; never mix
the two vocabularies in one proposal.
