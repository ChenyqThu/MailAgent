# Rubric — search_read（检索 + 精读）

软评分锚点（LLM judge manual lane）。每维 0 / 0.5 / 1。权重见各 task.rubric。

## answer_correctness
- 1：答案与精读到的正文结论一致（如"延期"而非被干扰邮件的"按原计划"）。
- 0.5：方向对但漏关键限定（时间/范围）。
- 0：答错，或被 snippet 误导。

## evidence_grounding
- 1：给出决定性邮件的 `internal_id`，且该 id 确为正文来源。
- 0.5：给了 id 但非最关键来源。
- 0：无 id，或 id 与结论无关。

## tool_efficiency
- 1：search → body 精读一次到位，无冗余调用，未超 budget。
- 0.5：有 1-2 次冗余检索。
- 0：反复检索仍不精读，或空转到 max_iter。

## uncertainty_honesty
- 1：正文矛盾/不足时明确指出并说明取舍依据。
- 0.5：略过矛盾但未误导。
- 0：把不确定当确定下结论。
