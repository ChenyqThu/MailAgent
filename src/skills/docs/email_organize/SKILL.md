# Skill: email_organize

Flag, pin and archive MailAgent emails. All three are reversible.

## Tools

| tool | scope | effect | confirm |
|---|---|---|---|
| `email_flag` | `email:organize` | write | preview (confirm required) |
| `email_pin` | `email:organize` | write | preview (confirm required) |
| `email_archive` | `email:organize` | write | preview (confirm required) |

## Usage

Find the email's `internal_id` with the **search** skill first.

- `email_flag {internal_id, is_flagged, confirm}` — set (`true`) or clear (`false`) the follow-up
  flag. Syncs to the mail server and Notion through the same outbox as the desktop app. Unknown
  `internal_id` → `E_NOT_FOUND`.
- `email_pin {internal_id, pinned, confirm}` — keep an email at the top of the list. Local to
  MailAgent; nothing is written to the mail server.
- `email_archive {internal_id, confirm}` — move the email into the Archive folder so it leaves the
  inbox. Not a delete: body and attachments are kept and it can be moved back. Already archived →
  `E_INVALID_ARG`. Works on the DavMail backend only.

## Notes

The `email:organize` scope is never part of a preset; grant it explicitly. Every call needs a
JSON boolean `confirm: true` (an intent marker the model fills in, not a human approval) and is
rate limited to 60 successful calls per hour per key.
