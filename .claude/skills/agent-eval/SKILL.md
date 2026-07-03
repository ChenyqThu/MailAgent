---
name: agent-eval
description: 跑 MailAgent 的 agent 行为回归网（零-LLM 硬闸 pytest + baseline compare）。改 chat agent 的 prompt/工具/编排引擎后必跑，总分不得低于 baseline。
user_invocable: true
---

# /agent-eval — agent 行为回归网

改了 chat agent 的 **prompt / 工具 / 编排引擎** 后必跑。零 LLM、零网络，pytest ~0.1s。是「换 agent 引擎不回退」的金标准。

## 跑法

1. **pytest 硬闸**（R1–R8 规则门 + loader/compare/catalog 测试），repo 根：
   ```bash
   venv/bin/python -m pytest tests/agent_eval -q
   ```
2. **baseline 回归闸 compare**，cwd 必须 = `tests/agent_eval/`（让 `import runner` 解析到本副本）：
   ```bash
   cd tests/agent_eval
   ../../venv/bin/python -m runner.run_baseline --candidate-traces runs/<branch>.jsonl --compare
   ```
   默认 `--eval-root=tests/agent_eval`、`--traces=baselines/v0.13.0.jsonl`，无需显式传。
   - 仅校验 schema+coverage（不打分）：`../../venv/bin/python -m runner.run_baseline --validate`
   - 生成 baseline report：`../../venv/bin/python -m runner.run_baseline --run-id v0.13.0`

## 通过判据

- **pytest**：全 pass（每 task `hard_pass` = 无 R1–R8 violation）。
- **compare**：exit 0 = 无回归。exit 1（REGRESSED）触发任一条件：① 缺某 baseline task；② 任一 task pass→fail flip；③ 已失败 task 新增 rule code（尤其 R2/R5/R6/R8 算 safety regression）；④ 总 `hard_pass` 数下降。
- **总分不得低于 baseline**（`baselines/v0.13.0.jsonl`，27 tasks：20 pass / 7 fail，safety 4/4）。

## 注意

- 回归网内部文档（`schema.md` / `recorder-contract.md`）写的 `eval/` 是**旧路径**，真实位置 = `tests/agent_eval/`。
- **manual lane（不进 CI，烧 token）**：LLM judge 软评分 `runner/judge.py --task <id> [--traces runs/<branch>.jsonl]`；live recorder 需产品运行时。fixtures 全 `.test` 合成域，零真实 PII。

## 触发场景（改了这些必跑）

- chat agent 的 prompt：Standing Context（SOUL/AGENT/RULES/USER）、`src/agent_config/`
- agent 工具面：builtin 工具、`tests/agent_eval/tool_catalog.json`（漏同步 → `validate_catalog` 漂移闸 FAIL）
- 编排引擎：AI SDK Gateway / `shared/chat` / serve-api chat 端点 / harness
- mem0 记忆（CAPTURE/RETRIEVAL）、enhance epic（M4/M5）、web→ai-sdk dogfood
- `tests/agent_eval/` 自身（tasks/rubrics/runner/baseline）
