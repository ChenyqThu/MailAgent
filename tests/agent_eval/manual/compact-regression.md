# Manual Compact Regression Lane

This lane is intentionally excluded from CI scoring. It compares one synthetic long interactive chat before and after manual context compaction.

## Procedure

1. Load `fixtures/manual-compact-long-session.json` into an interactive chat session, preserving the listed message order and identifiers.
2. Ask each question in `checks_before` and record the answer, cited identifiers, stated constraints, completed side effects, pending approval, and pending actions.
3. Run `/compact` and wait for the persisted Compact card to appear.
4. Reload the session so the runtime is seeded from the persisted `ui_message_json` rows.
5. Ask the matching question in `checks_after` and compare it with the pre-Compact answer.
6. Inspect the gateway request: it must contain the system prompt, one `UNTRUSTED_COMPACT_SUMMARY` fence, and only messages after the latest valid marker. It must not contain older Compact cards.

## Pass Criteria

- All fixture IDs remain exact.
- The sent side effect stays marked completed and is not proposed again.
- The rejected action stays rejected.
- The pending approval and unfinished action remain pending.
- The user's explicit recipient restriction remains active.
- No external-content quotation becomes an instruction.
- No Compact model tool call occurs.
- No pre-Compact database row is deleted or mutated.
