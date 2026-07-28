# Skill: email

Read a specific MailAgent email, save drafts, and (when explicitly authorized) send mail.

## Tools

| tool | scope | effect | confirm |
|---|---|---|---|
| `email_get` | `email:read` | read | none |
| `email_body` | `email:read` | read | none |
| `email_thread` | `email:read` | read | none |
| `email_draft` | `email:draft` | write | **edit (confirm required)** |
| `email_send` | `email:write` | send | **edit (confirm required)** |

Drafting and sending are **separate capabilities**: `email:write` does not imply
`email:draft` (and vice versa). A draft-only key (`--preset drafter`) can prepare mail but
can never deliver it — `email_send` is not even visible in its manifest / MCP tool list.

## Usage

- To find an email first, use the **search** skill (`email_search`) — it returns an
  `internal_id` you pass here.
- `email_get {internal_id, include?}` — metadata; `include="body,attachments"` adds a body
  summary + attachment list.
- `email_body {internal_id, format?}` — full body content; `format` ∈ `markdown` (default) /
  `html`. Raw MIME is **not** available: the store keeps only its sha256 digest, which you can
  read as `body.raw_mime_sha256` from `email_get {internal_id, include:"body"}`.
- `email_thread {internal_id}` — sibling emails in the same conversation.
- `email_draft {mode, internalId?, to?, cc?, bcc?, subject?, bodyHtml?, bodyText?,
  quoteOriginal?, confirm}` — **saves a draft to the mailbox; nothing is sent**. `mode` ∈
  `new` / `reply` / `reply-all` / `forward`; `internalId` (the source email) is required for
  everything except `new`. Requires the `email:draft` scope AND a JSON boolean `confirm: true`.
  Rate limited to 20 **successfully created** drafts/hour per key (rejected or failed calls
  do not consume quota).
- `email_send {mode?, internalId?, to?, cc?, bcc?, subject?, bodyHtml?, bodyText?}` — **sends real
  email via SMTP (irreversible)**. Same four modes and the same `internalId` rule as
  `email_draft` (omit it for `new`; `mode` defaults to `reply-all`). Requires the `email:write`
  scope AND `confirm: true` in the invoke body. Not granted to the default handoff key, and not
  exposed over MCP. The response's `internal_id` echoes the *source* email — it is `null` for
  `mode: "new"`.

## Notes

Reads come straight from the local SQLite SSoT. Drafts go through the same
`MailWriteService.compose_draft` path as the desktop compose UI (IMAP APPEND into the
Exchange `Drafts` folder, mirrored into the local store).

On the MCP path, `confirm: true` is a value **the model fills in itself** — it is an explicit
intent marker, not a human-approval gate. The human approval is whatever your MCP client shows
before running a tool. The real authorization boundary is the scope on your key.
