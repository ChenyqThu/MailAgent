# Skill: email

Read a specific MailAgent email and (when explicitly authorized) send mail.

## Tools

| tool | scope | effect | confirm |
|---|---|---|---|
| `email_get` | `email:read` | read | none |
| `email_body` | `email:read` | read | none |
| `email_thread` | `email:read` | read | none |
| `email_send` | `email:write` | send | **edit (confirm required)** |

## Usage

- To find an email first, use the **search** skill (`email_search`) — it returns an
  `internal_id` you pass here.
- `email_get {internal_id, include?}` — metadata; `include="body,attachments"` adds a body
  summary + attachment list.
- `email_body {internal_id, format?}` — full body content; `format` ∈ `markdown` (default) /
  `html` / `raw`.
- `email_thread {internal_id}` — sibling emails in the same conversation.
- `email_send {internalId, mode, to?, cc?, bcc?, subject?, bodyHtml?, bodyText?}` — **sends real
  email via SMTP (irreversible)**. Requires the `email:write` scope AND `confirm: true` in the
  invoke body. Not granted to the default handoff key.

## Notes

Reads come straight from the local SQLite SSoT. Sending is gated three ways: scope, edit-tier
confirmation, and exclusion from the default key.
