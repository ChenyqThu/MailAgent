# Goal Prompts —— P1→P4 可粘贴 session 启动手册

> task: `06-23-agent-eval-memory-skill-assistant-ui-ai-sdk`
> 用法：每个阶段开一个新 session，粘贴对应 prompt。`/goal` 用停止条件式（可度量 + Claude 输出能证明 + 证据必须 surface 到对话），评估器是只读 transcript 的 Haiku，所以**完成条件必须能从对话里验证**。
> 门控：严格按 P1→P2/P3→P4。**P1（`tests/agent_eval/`）不绿，不要进 P2 改 prompt / 不要进 P4 换引擎。**

---

## P1 —— eval 固化（本专项已在执行；此条留作复跑/收尾备份）

> 多数已由本专项 session 完成（复制 `eval/` → `tests/agent_eval/` + 脱敏 + 验证）。若需复跑或补 CLAUDE.md 文档地图：

```
/goal 把 .trellis/tasks/06-22-harness-agent-polish/eval/ 的 curated 子集固化为 git-tracked tests/agent_eval/，满足：
(1) tests/agent_eval/ 下 venv/bin/python -m pytest tests/agent_eval -q 全绿且零 LLM；
(2) grep -rIn "/Users/" tests/agent_eval 与 grep -rInE "tp-link|omadanetworks" tests/agent_eval 均零命中；
(3) runner.run_baseline --validate coverage_ok=True + 自比对 --compare exit0；validate_catalog --source-ref main 45==45；
(4) 主仓 pytest tests/ 收集无新增 error；
(5) CLAUDE.md「文档地图」+「开发指南/加新文档」登记 tests/agent_eval（入口 + 怎么跑 + 零-LLM 进 CI、judge/live recorder 不进）。
排除 live_recorder.ts / runs/ / __pycache__ / 含绝对路径的 generated report。不改 task/baseline 断言凑绿。证据贴对话。
```

---

## P2 —— 内核打磨（memory + skill/cross-domain，view-agnostic）

> 权威细节：`.trellis/tasks/06-22-harness-agent-polish/roadmap.md` Phase 3 + Phase 4。
> **铁律：view-agnostic** —— 只动 Python domain services + 工具语义 + prompt + 轻量 artifact，**不碰** `MessageList`/`Composer`/`ConfirmToolDialog`（P4 会换）。每改一处 prompt/工具，跑 `tests/agent_eval` 对比 baseline。

### P2a — Memory provenance + relevance（先做）

```
开工先读：docs/plans/agent-experience-epic/{prd,roadmap}.md、
.trellis/tasks/06-22-harness-agent-polish/roadmap.md（Phase 3）、tests/agent_eval/（回归网怎么跑）、
frontend/src/electron/main/chat_db.ts（agent_memory_kv schema owner）、frontend/src/shared/chat/tools/builtin/memory*（memory 工具）。

/goal 给 agent memory 加 provenance + 规则化相关性，满足可验证：
(1) 每条 memory 写入记录来源（session_id / message_id / tool），UI 与 trace 可见来源 + 更新时间；
(2) 注入 prompt 的 memory 走规则化相关性选择（scope/key/最近更新/显式优先级），注入长度有上限可观测；
(3) 新增/更新 memory eval 任务在 tests/agent_eval 中：写入→下轮召回 pass、irrelevant memory 不污染答案 pass；
(4) tests/agent_eval 总 hard_pass 不低于 baseline（贴 run_baseline --compare 输出）；
(5) DB schema 变更走 /db-migration（bump DB_VERSION + 同步前端 EXPECTED_DB_VERSION），迁移幂等。
view-agnostic：不改 legacy 聊天 UI 组件。证据贴对话。完成后用 codex 或 code-reviewer 过一遍再收。
```

### P2b — Memory auto-capture + conflict（确认制）

```
/goal 让 agent 能在发现长期偏好时提议 memory_write（必须人类确认，preview tier），且冲突不静默覆盖：
(1) auto-capture 区分「本轮任务信息」与「长期偏好」，只有后者触发提议，且不确认不写；
(2) 新偏好与旧偏好冲突时先确认再改，支持 tombstone/delete；
(3) tests/agent_eval 加：修改→新规则生效 pass、删除→不再使用 pass、冲突→不静默覆盖 pass；
(4) 所有 memory 写/删走 pending_confirmation（eval R5 不破）；总分不低于 baseline。
view-agnostic。证据贴对话。
```

### P2c — Skill transparency

```
开工先读：frontend/src/shared/chat/runtime.ts（skill enablement）、src/skills/{registry,invoke}.py、
src/api/routers/skills.py、docs/reference/llm-agent/{skill-delivery-api,capability-context-foundation}.md。

/goal 让 agent 对「能做什么/为什么不能做」透明，不幻觉调用禁用 skill：
(1) 对话内可给 capability summary（当前启用 skills + 各 unavailable 原因）；
(2) why-not-call 四类解释清楚：禁用 / 无 scope / 不可用 / 需确认；
(3) 禁用某 skill（如 search/report/notion）后，agent 不幻觉调用，而是解释如何开启或给替代；
(4) tests/agent_eval 的 skill_enablement 类任务全 pass；总分不低于 baseline。
view-agnostic。证据贴对话。
```

### P2d — Cross-domain plan artifact（同一 loop，不引入第二 engine）

```
/goal 引入轻量 plan/subgoal artifact 支撑跨域任务，但不引入第二 agent loop：
(1) plan artifact = {plan_id, goal, steps:[{id,domain,status,evidence}]}，由同一 harness loop 产出/更新；
(2) plan 能进 trace report（可视化/可回放）；
(3) tests/agent_eval ≥3 条跨域任务（mail↔report / mail↔calendar-诚实声明不可用）pass，答案带 evidence ids；
(4) grep 证明没有第二个 orchestration loop（仍是单 harness loop）；总分不低于 baseline。
view-agnostic。证据贴对话。
```

---

## P3 —— 重定向决策（冻结 legacy UX，诉求并入 chat-panel）

> 这是**决策 + 文档动作**，不写功能代码。可与 P2 同 session 顺手做。

```
开工先读：.trellis/tasks/06-22-harness-agent-polish/roadmap.md（Phase 2 UX Fluidity 五项诉求）、
docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/{phase-01-assistant-ui-shell,phase-04-generative-ui-hitl}.md。

/goal 把 06-22 Phase 2（UX Fluidity）正式重定向到 chat-panel assistant-ui，满足：
(1) 在 chat-panel phase-01 + phase-04 文档加一张映射表：Phase 2 的 tool timeline / thinking 展示 /
    confirmation polish / error recovery / latency 信号，逐条对应 assistant-ui primitive 或 A2UI card 承载；
(2) 在 06-22 roadmap.md 的 Phase 2 标题加「superseded by 06-23 P3 → chat-panel」指针（不删历史）；
(3) 若有「不依赖视图层、当前就值得修」的 UX 微调，单列一个短清单标为可选 P2 附带，其余推迟 P4。
纯文档，不改运行代码。证据贴对话。
```

---

## P4 —— 换引擎（chat-panel，Phase 00 spike 先行，eval gated）

> 权威细节：`docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/`（prd / architecture / roadmap / phase-00~06 / acceptance-checklist）。
> **叠加门控**：每个 chat-panel phase 验收 + 一条「跑通 tests/agent_eval 27-task baseline 不回退」。
> **先 spike，再决定是否推进 01→06。**

### P4-Phase00 — Research & Spike（gate：先验证再投入）

```
开工先读：docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/{prd,architecture,roadmap,phase-00-research-and-spike,protocol-contracts}.md、
frontend/ARCHITECTURE.md（renderer 现状 + token/主题）、CLAUDE.md「打包/发布」节（第三进程的打包约束）。

/goal 完成 chat-panel Phase 00 技术 spike，产出 go/no-go 证据：
(1) assistant-ui Thread/Composer 在 MailAgent token + 主题三态 + accent 下渲染，视觉 parity 截图/说明（PoC，flag 后，不动默认行为）；
(2) Node AI SDK Gateway 最小 PoC：Electron main 内嵌 Node HTTP server，/health + 一次 streamText 纯文本流打通，端口发现 + 生命周期 + 健康检查可行性结论（第三常驻进程，叠加 serve-api + DavMail JVM 的成本评估）；
(3) approval 心智模型差异写清：AI SDK two-call needsApproval/response vs 当前 awaitConfirmation，eval R5 如何重对齐；
(4) 明确 go/no-go：若 go，列出 Phase 01 起的 PR 拆分（复用 chat-panel roadmap §4）。
不改默认行为（全程 flag-off）。证据贴对话。
```

### P4-Phase01+ — 按 chat-panel roadmap §4 PR 拆分逐 phase 推进

> 每个 phase 用 chat-panel 对应 phase-0X 文档 + acceptance-checklist 当 DoD，外加：
> - read/write tools 迁移后跑 `tests/agent_eval` ≥ baseline（golden fixtures 防 parity 漂移）；
> - 高风险工具：`email_prepare_send` 无 approval token 不能真实发送 + 外发绑 content hash/approval id/expiry/idempotency + server-side guard；
> - 旧会话可读（UIMessage 双写 + legacy mapper）；Gateway 不可用自动降级 legacy；
> - cutover 前 AI SDK 新会话连续 dogfood 7 天无 P0/P1。
> - **harness 退役前始终保留为 rollback 通道**（先删 legacy UI 主路径，dogfood 后再归档 harness）。

---

## 通用收尾（每个实现 session）

- 软件验收：相关 pytest / vitest 全绿 + typecheck 0 + （动了 prompt/工具）`tests/agent_eval` ≥ baseline。
- 作者/验证分离：实现后用 `codex`（codex-rescue）或 `code-reviewer` 过一遍再收（codex 经代理偶发 hang → 改 code-reviewer）。
- 打包前（若动了 Python 后端）：`pnpm -C frontend rebuild:electron` +（改 Python）`bash frontend/scripts/build-python-venv.sh` 重 provision，否则装机白验。
- DB schema 变更：`/db-migration`（bump DB_VERSION + 同步前端 `EXPECTED_DB_VERSION`）。
- 收尾更新本专项 `roadmap.md`「当前进度」表 + memory。
