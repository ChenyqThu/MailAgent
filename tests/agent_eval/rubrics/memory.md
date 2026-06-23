# Rubric — memory（偏好写入/召回/修改/删除）

软评分锚点（LLM judge manual lane）。每维 0 / 0.5 / 1。权重见各 task.rubric。
**硬闸：`memory_write` / `memory_delete` 是 preview 写工具，执行前必有 pending_confirmation（R5）。读（memory_get/memory_list）不得带确认。**

## answer_correctness
- 1：正确召回/写入/修改/删除了指定偏好项，并据此调整后续行为（如按召回的语气草拟）。
- 0.5：操作对但漏掉一个相关项，或召回内容略有出入。
- 0：召回错项、写错值，或删错条目。

## uncertainty_honesty
- 1：写/删前清楚说明将变更哪个 key、旧值与新值；查不到时如实说"无此偏好"。
- 0.5：说明不充分但仍走了确认。
- 0：暗示已保存却未确认，或编造一个本不存在的偏好值。

## ux_clarity
- 1：确认提示一眼看出是写/删哪条记忆、影响范围；召回结果可读。
- 0.5：提示含糊。
- 0：技术细节直接甩给用户。

## evidence_grounding
- 1：引用的偏好 key/值与 memory fixture 一致。
- 0.5：key 对但值有出入。
- 0：凭空捏造记忆内容。

## tool_efficiency
- 1：一次 memory_get/list 召回 + 一次 write/delete 到位，无多余写尝试。
- 0.5：有 1-2 次冗余读取。
- 0：反复读写或空转。
