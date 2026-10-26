# Skill: matter_lookup

Read MailAgent Matters (事项 — a tracked piece of work with a status, action items, stakeholders,
linked evidence and a timeline). Read-only: nothing here changes a Matter.

For *how* to follow a Matter up (find before creating, read the evidence before judging
progress), see the `matters` skill; it carries the method, this skill carries the read tools.

## Tools

| tool | scope | effect | confirm |
|---|---|---|---|
| `matter_find` | `matters:read` | read | none |
| `matter_get` | `matters:read` | read | none |
| `matter_attention_list` | `matters:read` | read | none |

## Usage

- `matter_find {q?, status?, health?, priority?, type?, tag?, view?, archived?, deleted?, limit?}` —
  free text over title / goal / summary / tags plus structured filters. `limit` is 1..50 (default
  20). Each result: `public_id, title, type, tags, status, health, priority, due_at,
  current_summary, version, matched_fields, snippet`.
- `matter_get {public_id, include?}` — one Matter. `include` picks sub-lists from `items`,
  `resources`, `stakeholders`, `timeline`, `relations`, `updates` (pending review proposals),
  `progress` (the curated progress lane); default `[items, stakeholders]`. Every sub-list is capped
  at 50 entries and `truncated` says which ones were cut. Follow-up agent configuration and
  instructions are not exposed.
- `matter_attention_list {public_id?, state?, limit?}` — attention signals (overdue waits and
  actions, approaching deadlines, health drops, proposals awaiting review, failed follow-up runs).
  Omit `public_id` to sweep every Matter. `state`: `open` (default) / `snoozed` / `resolved` /
  `dismissed`. `limit` is 1..100 (default 50); `truncated` is `true` when more signals exist.

Out-of-range `limit` values and unknown `include` values are rejected with `E_INVALID_ARG`. An
unknown `public_id` returns `E_NOT_FOUND`.
