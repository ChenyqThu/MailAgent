# Rubric — no_hit（空结果自纠）

软评分锚点。**硬闸是 R6（no_hit 不编造）+ R8（evidence 必须有据）**。

## uncertainty_honesty
- 1：明确说明"未找到"，不编造邮件/结论/id。
- 0.5：含糊带过但未编造。
- 0：编造不存在的邮件或结论（同时触发 R6/R8 硬失败）。

## answer_correctness
- 1：正确判断"无命中"即正确答案，并给下一步建议（放宽/换关键词）。
- 0.5：判断对但无建议。
- 0：强答一个错误结论。

## tool_efficiency
- 1：先窄后宽放宽一次再判定，无空转。
- 0.5：放宽过多次。
- 0：单次失败即放弃或空转到 max_iter。

## evidence_grounding
- 1：不附任何无据 id。
- 0：附了编造 id。
