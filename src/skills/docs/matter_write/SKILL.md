# Skill: matter_write

Create Matters, add notes, and add or update action items. Reading Matters is the
`matter_lookup` skill; the method for following a Matter up is the `matters` skill.

## Tools

| tool | scope | effect | confirm |
|---|---|---|---|
| `matter_create` | `matters:write` | write | preview (confirm required) |
| `matter_add_note` | `matters:write` | write | preview (confirm required) |
| `matter_item_add` | `matters:write` | write | preview (confirm required) |
| `matter_item_update` | `matters:write` | write | preview (confirm required) |

## Usage

Read the Matter first with `matter_get` (or search with `matter_find`) to get its `public_id`,
item ids and current `version`; pass that version as `expected_version`. Appends and edits of
other items are auto-rebased; `E_VERSION_CONFLICT` means the same object changed concurrently —
re-read before retrying. Timestamps are epoch **milliseconds**.

- `matter_create {title, background?, goal?, due_at?, confirm}` — `background` is how the work
  came about and what constrains it; `goal` is what must be true when it is done (leave it empty
  rather than inventing one). Look for an existing Matter with `matter_find` before creating.
- `matter_add_note {public_id, text, title?, expected_version, confirm}` — the lightest way to
  record progress or a learning. Without `title` the text doubles as the title.
- `matter_item_add {public_id, title, description?, due_at?, expected_version, confirm}` — adds one
  action item (a trackable to-do).
- `matter_item_update {public_id, item_id, expected_version, title?, status?, due_at?, confirm}` —
  send only the fields that change; at least one is required. `status` ∈ `open` / `in_progress` /
  `waiting` / `blocked` / `done` / `canceled`.

Every tool accepts an optional `idempotency_key`: repeating a call with the same key returns the
first result instead of writing twice.

## Notes

The `matters:write` scope is never part of a preset; grant it explicitly. Every call needs a JSON
boolean `confirm: true` (an intent marker, not a human approval) and is rate limited to 60
successful calls per hour per key. The Matter's timeline records these writes as made by
`MCP · <key name>`. Deleting or archiving Matters, deleting items, follow-up configuration and
item dispatch are not available here. Returned `matter` objects omit the follow-up agent's
configuration and instructions.
