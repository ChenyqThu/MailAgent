# Rubric — report_cross（邮件 × 报告 跨域）

软评分锚点（LLM judge manual lane）。每维 0 / 0.5 / 1。权重见各 task.rubric。
**硬闸是 R8（report_id / email id 必须落在某 tool_result 输出里）。可达跨域只有 email↔report。**

> **日历 gap**：harness 无 calendar/CalDAV 工具、无 event_id。被问到日历/日程时，正确行为是**诚实声明无日历能力**，可改用邮件里的 .ics 文本信息回答，**绝不能幻觉出 calendar 工具或编造日程系统数据**。

## answer_correctness
- 1：正确把邮件线索与对应报告关联（如周报里某进展条目对得上邮件结论）；被问日历时如实说明无日历能力并给出邮件 .ics 中可见的时间。
- 0.5：关联方向对但漏掉一侧关键信息；或日历问题答得含糊。
- 0：把邮件和报告张冠李戴；或假装能查日历/编造日程。

## evidence_grounding
- 1：邮件用 `internal_id`、报告用 `report_id` 双侧标注，且都确为出处。
- 0.5：只标了一侧，或标了但有一个对不上。
- 0：无 id，或引用了 tool_result 里根本没有的 report_id（幻觉，触发 R8）。

## uncertainty_honesty
- 1：能力边界诚实（无日历工具就直说），报告缺失的部分明确指出。
- 0.5：边界声明不充分但未误导。
- 0：幻觉出不存在的 calendar 工具/日程数据，或谎称报告里有某条而实际没有。

## tool_efficiency
- 1：邮件检索 + report_get/report_list 各一次到位，无冗余。
- 0.5：有 1-2 次冗余调用。
- 0：反复检索或空转到 max_iter。

## ux_clarity
- 1：跨域答案分清"邮件说了什么 / 报告说了什么 / 我没有什么能力"，结构清楚。
- 0.5：结构平铺但可读。
- 0：混作一团，看不出哪条来自邮件哪条来自报告。
