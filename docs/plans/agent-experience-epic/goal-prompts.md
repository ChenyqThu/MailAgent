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

## P2 —— 内核打磨（memory + skill/cross-domain，view-agnostic）✅ 全部完成（2026-06-23）

> **P2a–P2d 全部落地**（commit `7c93c3be` / `19b3f381` / `ef9115d8` / `c9e0b8c5`）。eval 36 tasks /
> hard_pass 29（↑23，零既有回退）；pytest tests/agent_eval 85 + 相关 vitest 151 + typecheck node+web 0；
> code-reviewer(opus) APPROVE 6/6 护栏。**下一 session 接 P3（重定向决策，纯文档）/ P4（换引擎，Phase 00 spike 先行）。**

> 权威细节：`.trellis/tasks/06-22-harness-agent-polish/roadmap.md` Phase 3 + Phase 4。
> **铁律：view-agnostic** —— 只动 Python domain services + 工具语义 + prompt + 轻量 artifact，**不碰** `MessageList`/`Composer`/`ConfirmToolDialog`（P4 会换）。每改一处 prompt/工具，跑 `tests/agent_eval` 对比 baseline。

### P2a — Memory provenance + relevance ✅ 已落地（2026-06-23, commit `7c93c3be` feat + `79bb793f` docs）

> **DONE**。落地事实见下（= P2b/P2c 复用地基）；原 /goal 折叠备查。
>
> **落地**：`agent_memory_kv` **v7→v8**（schema owner=`frontend/src/electron/main/chat_db.ts`，bump
> `CHAT_DB_VERSION` 7→8；加 `source_session_id/source_message_id/source_tool_use_id` + `priority`）。
> 写路径=serve-api `POST /chat/memory`→`src/chat/db.py ChatDb.upsert_memory_entry`（chat_db.ts 是 owner+镜像，db.py 绝不 DDL）。
> `ToolExecCtx` 加 `messageId`(=harness `assistantMessageId`)/`toolUseId`(=`use.toolUseId`)，`dispatch.ts runSingleTool` 注入；
> `memory_write` 写 provenance + 可选 `priority`，工具结果暴露 `source{}`+`updated_at`（chat trace 可见）。
> 相关性=`memory_summary` `ORDER BY priority DESC, updated_at DESC` + 条数/字符上限 +
> `memory_summary_meta()`→`/chat/config.memorySummaryMeta`{injected,total,chars,truncated,caps} 可观测。
> `priority` **COALESCE 保留**（value-only 改写不清零）+ 负值夹紧 0。eval +AGT-MEMORY-004/005/006 + fixtures + baseline trace。
> **验证**：pytest tests/agent_eval **85 passed** / compare **无回退（hard_pass 23↑20，memory 6/6）** / vitest **1670 passed** / tsc node+web 0 / Python 177+71。code-reviewer(opus) APPROVE 0 CRITICAL/HIGH。
>
> **🔴 版本纪律纠正（写给后续所有 memory 阶段）**：memory 动的是 **`ai_chat.db`（前端 owned）**，它有
> **独立版本梯 `CHAT_DB_VERSION`** —— bump 它 + 同步 `src/chat/db.py` 头注释镜像即可，**不要动
> `backend_lifecycle.EXPECTED_DB_VERSION`**（那个 gate 的是 `sync_store.db` 后端库，与 chat 库无关；
> `frontend/tests/main/db_version_consistency.test.ts` 只校验它===sync_store.DB_VERSION，碰了反破）。
> 原 P2a /goal 第(5)条按 sync_store 措辞，chat 库场景按此纠正。**迁移坑**：手工 seed v≥3 的 vitest
> 漏建 `agent_memory_kv`→v8 ALTER 炸；v8 块已加表存在性 guard（生产任何 v≥3 库必有该表）。

<details><summary>原 P2a /goal（备查）</summary>

```
/goal 给 agent memory 加 provenance + 规则化相关性，满足可验证：
(1) 每条写入记录来源(session/message/tool)，UI 与 trace 可见来源+更新时间；
(2) 注入走规则化相关性(scope/key/最近更新/显式优先级)，注入长度有上限可观测；
(3) memory eval：写入→下轮召回 pass、irrelevant 不污染 pass；
(4) tests/agent_eval 总 hard_pass ≥ baseline；
(5) DB schema 走迁移、幂等。view-agnostic。证据贴对话。codex/code-reviewer 过 diff 再收。
```
</details>

### P2b — Memory auto-capture + conflict（确认制）✅ 已落地（2026-06-23, commit `19b3f381`）

> **DONE**（接力判断验证正确：**零 DB schema 变更**，纯 prompt policy + eval）。落地：AGENT_TEMPLATE
> "Memory capture"（区分本轮任务信息 vs 长期偏好、只后者提议 memory_write、绝不静默写）+ memory_write
> 工具 description 冲突指引（覆盖前先 memory_get 现值、消息里呈现 old→new）。eval +AGT-MEMORY-007（冲突
> →不静默覆盖，must_use memory_get+write+R5）/ 008（本轮信息不入长期记忆，forbidden memory_write）/
> 009（已删/不存在偏好不被使用，memory_get found:false 诚实）。memory 9/9 pass。原 /goal 备查于下。

```
开工先读（按序）：
- docs/plans/agent-experience-epic/{README,roadmap}.md + 本文「通用收尾」+ 上方 P2a ✅ 落地块（地基）
- .trellis/tasks/06-22-harness-agent-polish/roadmap.md Phase 3（出口标准：provenance/relevance/eval 已勾，剩 conflict + auto-capture；conflict 那条标 [~]）
- frontend/src/shared/chat/tools/builtin/memory.ts（memory_write 已 preview tier + provenance；conflict 在此加「先读现值再 diff」语义）
- agent 行为策略入口：Standing Context（SOUL/AGENT/RULES via backend agent_config.db，见 docs/reference/llm-agent/capability-context-foundation.md）+ memory_write 工具 description —— auto-capture「何时主动提议长期偏好」靠 prompt 引导
- tests/agent_eval/tasks/AGT-MEMORY-00{2,3,6}.json（写/删/改确认范式）+ baselines/v0.13.0.jsonl（confirmed-write trace 结构，R5 confirmation 序）；新任务照此写 + 追加 baseline trace

/goal 让 agent 在发现长期偏好时提议 memory_write（必人类确认 preview tier），冲突不静默覆盖：
(1) auto-capture 区分「本轮任务信息」vs「长期偏好」，只后者触发提议，不确认不写（prompt policy，非新 loop）；
(2) 冲突先确认再改：写同 key 前先 memory_get 现值，preview 呈现 old→new；支持 delete/tombstone；
(3) tests/agent_eval 加：冲突→不静默覆盖 pass、删除→不再使用 pass（修改→新规则已由 AGT-MEMORY-006 覆盖，可加强）；
(4) memory 写/删全走 pending_confirmation（eval R5 不破）；pytest tests/agent_eval -q 全绿 + run_baseline --compare 总 hard_pass ≥ baseline（贴输出）；
(5) 若再动 DB schema：bump CHAT_DB_VERSION（**非** EXPECTED_DB_VERSION，见 P2a 纠正）+ src/chat/db.py 头注释镜像 + 迁移幂等。
铁律 view-agnostic（不碰 MessageList/Composer/ConfirmToolDialog）+ 单 loop。证据贴对话。完成用 codex/code-reviewer 过 diff 再收。
```

### P2c — Skill transparency ✅ 已落地（2026-06-23, commit `ef9115d8`）

> **DONE**：SOUL_TEMPLATE capability-honesty value + custom_api.ts skillFragments header 四类不可用
> 措辞（禁用 / 未装·无 scope / 服务未配置 / 需确认）+「绝不调用/模拟缺失工具」；capability summary 走
> 既有 skill_list_installed（经 resolved_skills 已带 unavailableReason，无需注入）。eval +AGT-SKILL-004
> capability summary，skill_enablement 4/4。四类的「无 scope/需确认」chat 态 owner 全 scope → prompt
> policy + judge 软评，硬闸覆盖禁用/不可用 + 不幻觉。原 /goal 备查于下。

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

### P2d — Cross-domain plan artifact（同一 loop，不引入第二 engine）✅ 已落地（2026-06-23, commit `c9e0b8c5`）

> **DONE**：新增 builtin 工具 `plan_update`（plan.ts，silent meta，纯计算无 platform I/O）= {plan_id,
> goal, steps:[{id,domain,status,evidence?}]}，注册进 createBuiltinTools + tool_catalog（counts 45→46）。
> 缺能力步骤标 'unavailable'（接 P2c honesty）。plan 经 tool_use/tool_result 进 trace（可视化/可回放，
> 无 view 改动）。eval +AGT-CROSS-004（mail↔report 用 plan 串核对，双 evidence R8）/ 005（mail↔calendar
> 把 calendar 步标 unavailable，从 .ics 取时间）。report_cross 4/5 pass。**单 loop**：仅 harness.ts
> `while(iter<MAX_ITER)`（grep 证），plan_update 只是工具零新 loop。原 /goal 备查于下。

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

### P4-Phase00 — Research & Spike ✅ 已落地（2026-06-23, 裁决 GO, commit `bc5c1e80`）

> **DONE（GO）**：三项核心技术风险全 flag-off PoC 打通。(1) assistant-ui **headless primitives**
> （0.14 不发 styled Thread）+ MailAgent token 视觉 parity，4 截图（`frontend/src/electron/renderer/poc/`
> + `vite.poc.config.ts` harness）；主题三态 × accent 正交、零组件改动重皮肤。(2) Node AI SDK Gateway
> **嵌入 Electron main**（`frontend/src/electron/main/ai_gateway_poc.ts` 纯 Node 核 + `scripts/poc/` harness
> 4/4：/health + echo + abort + 真实 streamText 经 CRS）；第三进程走嵌入式（非独立 OS 进程）→ 成本近零。
> (3) approval = AI SDK v6 两次调用 needsApproval/response（内建签名守卫）vs 当前同进程 `awaitConfirmation`；
> eval R5 规则逻辑零改，重对齐落点 = recorder 适配层。装 `ai@6 / @ai-sdk/anthropic / @assistant-ui/react(+react-ai-sdk) / zod`（devDeps，全 React19）。
> 结论入 chat-panel `architecture.md §13` + `roadmap.md §10`；epic roadmap P4 gate / README 标 GO。
> code-reviewer(opus) APPROVE（fresh build 实证 ai_gateway 打成 777kB 懒 chunk、flag-off 字节不变）。
> **踩坑**：`@ai-sdk/anthropic` baseURL 须含 `/v1`（否则命中 `…/api/messages` 404）。原 /goal 备查于下。

<details><summary>原 P4-Phase00 /goal（备查）</summary>

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
</details>

### P4-Phase01 — assistant-ui Shell（下一个 session，PR-01a+b）

> 只换**视图层**：assistant-ui shell + ExternalStore adapter 包 legacy `useEmailChat`，**不接 AI SDK Gateway**
> （那是 Phase 02）、不迁工具执行、不改 Python service。flag `MAILAGENT_ASSISTANT_UI_PANEL` 默认 off。
> 可选先建子任务：`task.py create "chat-panel Phase 01 assistant-ui shell" --parent 06-23-agent-eval-memory-skill-assistant-ui-ai-sdk`。

```
开工先读：
- docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/{phase-01-assistant-ui-shell,architecture,roadmap,protocol-contracts}.md
  （phase-01 = DoD 主规格：§2 目录 / §3 实施 / §4 功能范围 / §6 验收 / §8 06-22 Phase 2 诉求映射；architecture §13 = Phase 00 spike 实测结论）
- frontend/src/electron/renderer/poc/AssistantUiThreadPoc.tsx（Phase 00 spike 已验证的 headless primitives +
  MailAgent token 样式范式 + useExternalStoreRuntime 用法——本 phase 把它收编成正式 shared/assistant/components）
- frontend/src/shared/components/chat/{AIChatPanel,MessageList,Composer,ConfirmToolDialog}.tsx（legacy 主路径，flag 后并存、绝不改默认）
- frontend/src/shared/hooks/useEmailChat.ts + shared/chat/{runtime,types}.ts（ChatStreamEvent / 流式状态 = ExternalStore adapter 的数据源）
前置已绿（引用即可，勿重验/重装）：P4 Phase 00 spike ✅ GO（commit bc5c1e80，architecture §13）；
ai@6 / @assistant-ui/react(+react-ai-sdk) / zod 已装（devDeps）；markdown 渲染复用现有 streamdown。

/goal 完成 chat-panel Phase 01（assistant-ui Shell，只换视图层），产出可验证：
(1) 新建 frontend/src/shared/assistant/{components,runtime,tools,context}：用 assistant-ui headless primitives
    （ThreadPrimitive/MessagePrimitive/ComposerPrimitive）+ MailAgent token（ink-*/--c-accent/主题三态/accent）
    建正式 Thread/Message/Composer（收编 Phase 00 spike PoC 范式，删除/归并 renderer/poc + vite.poc.config + poc/ demo）；
(2) runtime = useExternalStoreRuntime（legacy adapter，**非** AI SDK Gateway）：useLegacyExternalStoreRuntime(useEmailChat/useGeneralChat)
    + legacyMessageMapper（ChatStreamEvent chunk/thinking/tool_use/tool_result/pending_confirmation/usage/done/error → UIMessage parts，见 protocol-contracts §4）；
(3) AIChatPanel 经 flag MAILAGENT_ASSISTANT_UI_PANEL 分流：on → AssistantUIChatPanel，off（默认）→ 旧 LegacyAIChatPanel 字节级不变；
(4) 功能（phase-01 §4）：文本 streaming / stop / retry / edit user message / session history 切换 / context chips /
    pending tool trace（generic ToolTraceCard）/ legacy ConfirmToolDialog fallback 全可用；
(5) 测试：legacyMessageMapper.test.ts（事件→part golden）+ AssistantUIChatPanel 渲染/交互测试。
验收：pnpm -C frontend typecheck 0 + pnpm -C frontend test 无新增失败 + flag-off 默认行为字节级不变 +
  同一会话新旧 UI 内容一致 + 视觉与右侧面板宽度/header/composer/scroll 一致 + 不新增 LLM provider 调用路径 +
  tests/agent_eval ≥ baseline（view-only 理应不影响 harness/trace，跑一次兜底）。
不改默认行为（全程 flag-off）。不接 AI SDK Gateway / 不迁工具执行 / 不删 legacy harness / 不改 Python service。
.env.example 登记 MAILAGENT_ASSISTANT_UI_PANEL / MAILAGENT_CHAT_RUNTIME。证据（截图 + 测试输出）贴对话。
完成用 codex（codex-rescue）或 code-reviewer 过 diff 再收。
```

### P4-Phase02+ — 按 chat-panel roadmap §4 PR 拆分逐 phase 推进

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
