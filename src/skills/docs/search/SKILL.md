# Skill: search

Full-text search across email bodies and attachment text (SQLite FTS5).

## Tools

| tool | scope | effect |
|---|---|---|
| `email_search` | `email:read` | read |
| `attachment_search` | `attachment:read` | read |

## Usage

- `email_search {q, mailbox?, since?, until?, limit?, raw?}` — searches body + subject + sender.
  `q` supports a Gmail-style DSL: `from:`, `subject:`, `after:YYYY-MM-DD`, `has:attachment`,
  negation, `OR`. Returns `{items, total_indexed, total_matches, has_more, mode}`.
- `attachment_search {q, ...}` — searches extracted text inside PDF/docx/pptx/xlsx attachments.

## Convergence signal

Each hit carries `internal_id` (and `attachment_id`) — feed it to `email_get` / `email_body`
for full content. If `has_more` is `true`, **narrow the query** (add `from:`/`subject:`/date
bounds) rather than paging blindly; that is the intended self-convergence loop.

`raw: true` bypasses the smart CJK-aware rewrite and passes raw FTS5 syntax.
