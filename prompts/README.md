# LLM Agent Prompts

This directory holds the Markdown prompt templates consumed by `src/llm_agent/`.

## Files

| File | Role | Consumed by |
|---|---|---|
| `email_inbox.md` | Mailbox-specific rules for the user's inbox (how to judge Priority / Category / Action Type / Reply Suggestion) | `PromptLoader.get_for_mailbox("收件箱")` |
| `email_sent.md` | Mailbox-specific rules for the user's sent box (follow-up judgment, different Action Type enum) | `PromptLoader.get_for_mailbox("发件箱")` |

## Hot-reload

`PromptLoader` checks file `mtime` on each `process_email` call (one `stat()` syscall, negligible cost). You can edit a `.md` file while `mail-sync` is running and the next email processed will pick up the change without a `pm2 restart`.

## Making it yours

Two recommended patterns:

### Pattern A — edit files in place
If you're the only user of this repo, just edit `email_inbox.md` / `email_sent.md` directly.

### Pattern B — ship your own files
1. Copy `email_inbox.md` → `prompts/my_inbox.md` and edit.
2. Add `prompts/my_*.md` to `.gitignore` (already covered by `.gitignore`'s private-prompt pattern if present, otherwise add it yourself).
3. Point `.env` at your own files:
   ```
   LLM_INBOX_PROMPT_PATH=prompts/my_inbox.md
   LLM_SENT_PROMPT_PATH=prompts/my_sent.md
   ```

## What NOT to put in the prompt

Already constrained elsewhere — don't repeat:
- Enum lists for `Category` / `Action Type` / `Priority` / `Language` / `Sender Priority` / `Mail Actions`: baked into the Anthropic tool schema (`src/llm_agent/schema.py`), LLM will self-correct.
- Tool invocation syntax: the tool use is forced by `tool_choice`, don't tell the model "call the classify_email tool" — the runtime does it.
- Notion-specific helpers (EmailSkill / createAndRunThread / mention-page): not applicable; this runs outside Notion Agent.
- Calendar / Daily Digest relation writing: the local code does this, not the LLM.

## Context page

`LLM_CONTEXT_PAGE_ID` (a Notion page) is loaded once per 30 min and prepended to system prompt with `cache_control: ephemeral`. Put stable per-user knowledge there:
- Your role / company / products
- Current focus projects (list your own focus projects here)
- Sender Priority mapping (e.g. Alice = 管理层)
- Timezone / language preferences
- Email signature style

**Don't** duplicate this info into `email_inbox.md` / `email_sent.md` — it's already in the system prompt via context page.
