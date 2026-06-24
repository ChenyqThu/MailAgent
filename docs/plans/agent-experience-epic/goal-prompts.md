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

### P4-Phase01 — assistant-ui Shell ✅ 已落地（2026-06-23, commit `b82ee24e`，全程 flag-off）

> **DONE**：新建 `frontend/src/shared/assistant/`（headless primitives + MailAgent token）；**legacy
> ExternalStore adapter**（`useExternalStoreRuntime`，**非** AI SDK）喂现有 `useEmailChat`/`useGeneralChat`；
> `legacyMessageMapper` ChatMessage(+toolSteps/isStreaming)→ThreadMessageLike（text/reasoning/tool-call，
> status 仅 assistant，序 reasoning→tool→text）。AIChatPanel body 改名 `LegacyAIChatPanel`（reviewer 机械
> 证明字节级一致）+ wrapper 经 `lazy()` flag 分流（flag-off→legacy，assistant-ui 重依赖只在 flag-on 进
> chunk）。markdown 复用 `TranslatedBody`(Streamdown)，tool 走 generic `tools.Fallback`(ToolTraceCard)，
> pending confirmation 走 legacy `ConfirmToolDialog` fallback。归并删 Phase 00 PoC（renderer/poc +
> vite.poc.config + poc/ demo）。**flag 投递铁律**：`electron.vite.config.ts`+`vite.web.config.ts`
> **per-flag `define`（禁用 `envPrefix:['MAILAGENT_']`，否则把 `MAILAGENT_CLI_API_KEY` 打进 renderer bundle）**；
> .env.example 登记 `MAILAGENT_ASSISTANT_UI_PANEL` / `MAILAGENT_CHAT_RUNTIME`。
>
> **验证**：typecheck(node+web) 0 / 全量 vitest **1700 passed/1 skipped/0 failed**（+22：mapper golden 16 +
> shell 6）/ eslint clean / `tests/agent_eval` **85**（≥baseline，view-only 未影响 harness/trace）/ 4 组
> theme·accent parity 截图（主题三态 × accent 正交）/ 不新增 LLM provider 路径（send/edit 仍走
> `chat.send`→`mailApi.chat.start`）。code-reviewer(opus) **APPROVE**（0 CRITICAL/HIGH/MEDIUM，5 LOW 3 已修）。
> 落地结论 = chat-panel [phase-01 §9](../chat-panel-ai-sdk-assistant-ui-refactor/phase-01-assistant-ui-shell.md)。
>
> **坑（写给后续 phase）**：① thinking 映射成 assistant-ui 原生 `reasoning` part（非 spec §P1.3 的
> `data-thinking`；protocol §4 的 data-thinking 是 Phase 02 AI SDK UIMessage 层目标）。② assistant-ui Thread
> 在 happy-dom 测试须 stub `ResizeObserver`/`IntersectionObserver`/`scrollIntoView`。③ part 组件用
> `TextMessagePartProps` 等 props 类型**直接标注参数**（非 `TextMessagePartComponent` ComponentType 别名）
> 才过 eslint `react/prop-types`；混合导出（组件 + 非组件对象）触发 `react-refresh/only-export-components`
> → 组件定义与 part-component 配置对象分文件。④ send 键 = assistant-ui 原生 Enter（Shift+Enter 换行），非 legacy ⌘↩。原 /goal 备查于下。

<details><summary>原 P4-Phase01 /goal（备查）</summary>

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
</details>

### P4-Phase02 — AI SDK Gateway ✅ 已落地（2026-06-24, commit `a6d189ac`，全程 flag-off）

> spike `ai_gateway_poc.ts` 正式化为 `frontend/src/ai-gateway/{server,config}.ts`（纯 Node 核：node:http+ai+
> @ai-sdk/anthropic，零 electron/keytar）+ `electron/main/ai_gateway_lifecycle.ts`（impure wrapper：llm_settings
> key + persistTurn→chat_db + health-poll + before-quit）。endpoints `/health`+`/api/ai/config`+`/api/ai/chat`
> （`streamText`→**Node 原生 `pipeUIMessageStreamToResponse(res)`** UIMessage 流 + abort + onFinish 持久化；无
> key→503 / 空→400 typed）。**provider key 路径裁决 = (A) Gateway 直连 provider**（key 仅 main，renderer 经
> `?aiGatewayPort=` 只拿 loopback 端口，全程不接触；拒 (B) llm-proxy 因 body 形状不兼容 + 嵌入 main 无额外隔离）。
> 前端 `getChatRuntimeMode→'ai-sdk'` + `AiSdkRuntimeProvider`(useChatRuntime+AssistantChatTransport) vs legacy
> 各调一个 runtime hook，panel 据 mode 分流；vite per-flag define 加 `__MAILAGENT_AI_SDK_GATEWAY__`。持久化 v1：
> chat_db **v8→v9** 加 `ai_chat_messages.ui_message_json`（additive ALTER+hasColumn 守卫，**不动 EXPECTED_DB_VERSION**），
> 纯 mapper `shared/assistant/uiMessage.ts`（双写 canonical+content / 重载转 UIMessage，旧会话从 content 合成），
> `src/chat/db.py` 头注释+列镜像。
>
> **🔴 头号坑**：ai@6 `convertToModelMessages` 是 **async（返 Promise），必须 await** —— 同步传 Promise 给
> `streamText`→`standardizePrompt` 抛 `messages.some is not a function`（流出 error 帧、文本空；spike 用 prompt
> 没踩到）。**坑②**：chat_db v9 bump → 4 个测试文件 7 处 `schema_version` 终态断言（'8'→'9'）+ Python test_chat.py
> seed DDL 加 `ui_message_json` 列（否则 append INSERT no-such-column→500）。
>
> 验收：gateway harness **4/4**（含真实 streamText 经 CRS 重建中文端到端）· ai-gateway 测试 24 · typecheck(node+web) 0 ·
> 全量 vitest 1724 · agent_eval 85（≥baseline）· python chat 126 · code-reviewer(opus) **APPROVE**（0 CRITICAL/HIGH，
> 6 项 invariant 全 PASS；1 MEDIUM=会话重载接进 runtime 留 phase-03 + 3 LOW=remote-web auth/ACAO·body 64KB cap·
> lazy react-ai-sdk 前瞻硬化，均写进 architecture §13.8.5 延后清单）。落地见 [phase-02 §13](../chat-panel-ai-sdk-assistant-ui-refactor/phase-02-ai-sdk-gateway.md#13-实现落地2026-06-24) + [architecture §13.8](../chat-panel-ai-sdk-assistant-ui-refactor/architecture.md#138-phase-02-落地2026-06-24embedded-ai-sdk-gateway)。

<details><summary>原 P4-Phase02 /goal（备查）</summary>

```
开工先读：
- docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/{phase-02-ai-sdk-gateway,architecture,roadmap,protocol-contracts}.md
  （phase-02 = DoD 主规格 + 头部「🔴 与 spike/Phase 01 对齐」四点：§3 endpoints / §4 chat / §5 lifecycle / §7 持久化 / §8 runtime 选择 / §9 不做 / §11 验收；architecture §13 = spike 实测结论；protocol-contracts §5 = /api/ai/chat 请求契约、§6 = Python domain service 契约、§9 = ai-sdk-v6 版本）
- frontend/src/electron/main/ai_gateway_poc.ts（spike 已验证的嵌入式 Node 核：node:http + ai + @ai-sdk/anthropic，**不 import electron/keytar**）+ scripts/poc/run-ai-gateway-poc.ts（harness 4/4 范式）+ frontend/src/electron/main/index.ts 的 MAILAGENT_AI_SDK_GATEWAY flag-gated 动态 import 块（本 phase 把 PoC 正式化为规范模块）
- frontend/src/shared/assistant/runtime/{flags.ts,MailAgentRuntimeProvider.tsx,useLegacyExternalStoreRuntime.ts} + AssistantUIChatPanel.tsx（Phase 01 落地：flags 已有 MAILAGENT_CHAT_RUNTIME/getChatRuntimeMode；Provider 现走 ExternalStore，本 phase 加 ai-sdk 分支，**不重造 flag 层**）
- frontend/src/shared/chat/{platform,http_platform}.ts + src/api/routers/chat.py（serve-api /chat/config + llm-proxy；provider key 路径 B 选项落点）+ frontend/src/electron/main/chat_db.ts（CHAT_DB_VERSION，ai_chat_messages schema owner）
前置已绿（引用即可，勿重验/重装）：Phase 00 spike ✅ GO（gateway harness 4/4，architecture §13）；Phase 01 ✅（shell + ExternalStore adapter + flags，commit b82ee24e）；ai@6 / @ai-sdk/anthropic / @assistant-ui/react-ai-sdk / zod 已装。

/goal 完成 chat-panel Phase 02（AI SDK Gateway，纯文本 streaming + UIMessage 持久化），产出可验证：
(1) 正式化嵌入式 Gateway（ai_gateway_poc.ts 收编进规范模块，仍嵌 Electron main 非独立进程）：/health +
    /api/ai/config + /api/ai/chat（streamText → toUIMessageStreamResponse 纯文本流 + abort）；Electron lifecycle
    （端口发现经 ?aiGatewayPort= / preload、/health poll、app quit 关闭），全程 MAILAGENT_AI_SDK_GATEWAY
    flag-gated（默认 off → 不启动、重依赖不加载）；
(2) provider key 路径二选一并写清（architecture §13.6）：(A) Gateway 直连 provider 或 (B) 经 serve-api
    /api/llm-proxy 转发（key 仍只在 Python 侧）—— renderer 全程不接触 provider key；CRS baseURL 归一含 /v1（§13.2）；
(3) 前端 AI SDK runtime 分支：flags.ts getChatRuntimeMode 接 'ai-sdk' → MailAgentRuntimeProvider 支持
    useChatRuntime(@assistant-ui/react-ai-sdk) 指向 Gateway，gated by MAILAGENT_CHAT_RUNTIME=ai-sdk +
    MAILAGENT_AI_SDK_GATEWAY=1；新建临时会话可经 AI SDK 流式回复；默认（legacy / external-store）字节级不变；
(4) UIMessage 持久化 v1：新会话双写 ai_chat_messages.ui_message_json（canonical）+ content（legacy text）+
    usage/model metadata，旧会话读取转 UIMessage；若动 schema → bump CHAT_DB_VERSION（**非**
    EXPECTED_DB_VERSION，见上方 P2a 纠正）+ src/chat/db.py 头注释镜像 + 迁移幂等（优先经 Python chat endpoint 写）；
(5) 测试：ai-gateway/{health, chat_stream(纯文本+abort), ui_message_persistence(写→重载)}.test.ts +
    model-key 缺失返 typed error + renderer 端口发现；（可选）e2e chat_ai_sdk_basic。
验收（phase-02 §11）：MAILAGENT_AI_SDK_GATEWAY=1 Gateway 可启动 + /health ok；MAILAGENT_CHAT_RUNTIME=ai-sdk
  下新建会话可流式回复（贴 trace/截图）；默认 flag off 现有 chat 字节级不变；renderer 未接触 provider key；
  pnpm -C frontend typecheck 0 + test 无新增失败；tests/agent_eval ≥ baseline（默认走 legacy harness，AI SDK
  路径 opt-in，天然不影响 —— 跑一次兜底）。
本阶段不做（phase-02 §9）：不迁 tools / 不启 write actions / 不删 legacy harness / 不接 AG-UI / 不强制旧会话全变 UIMessage。
.env.example 若新增 flag 同步登记。证据（gateway harness 输出 + 流式 trace/截图 + 测试）贴对话。完成用 codex（codex-rescue）或 code-reviewer 过 diff 再收。
```

</details>

### P4-Phase03a — Tool Registry Migration: read tools first ✅ 已落地（2026-06-24，flag-off）

> 9 read 工具（email_search/_fulltext/get/body/list_thread/search_attachments + kos_query + report_list/get）迁 AI SDK
> Gateway `tool({inputSchema:zod, execute})`，经 **`MailAgentDomainClient`**（纯 Node typed HTTP + `X-MailAgent-Local-Token`
> + envelope unwrap + E_NOT_FOUND→null）→ serve-api read 端点；`server.ts` `cfg.buildTools(collector)` 每 request 建工具
> （闭包绑 audit collector）+ `streamText({tools, stopWhen: stepCountIs(8)})` 多步循环 → `persistTurn` 写 chat_tool_call
> （appendToolCall+updateToolCall，字段 ≥ legacy）。schema/描述/massage **逐字镜像 legacy**（parity 测试钉死）；read 绝不 needsApproval。
> wrapper 构造 DomainClient（`resolveApiPort`+`getLocalApiToken`）+ `cfg.buildTools=(c)=>buildGatewayTools({...},c)`。**🔴 坑**：①
> audit 不用 `experimental_context`（AI SDK「treat as immutable」可能 clone 丢审计 + 难测）→ **闭包 collector**（可直接单测）；
> ② `MockLanguageModelV3`+streamText 难稳定触发工具执行 → 真实模型 harness `[5]` 证 e2e（CRS 不可达时待复跑）+ 56 单测兜 CI；
> ③ 运行时 @shared 导入在 tsx harness 不解析 → email/kos 的 `buildSearchHint`/`rerankByRecency` 改相对路径。
> 验收：typecheck 0 · vitest **1756**（+32）· agent_eval **85**（≥baseline）。落地见 [phase-03 §12](../chat-panel-ai-sdk-assistant-ui-refactor/phase-03-tool-registry.md#12-实现落地03a2026-06-24) + [architecture §13.9](../chat-panel-ai-sdk-assistant-ui-refactor/architecture.md#139-phase-03a-落地2026-06-24read-tools-migration)。

<details><summary>原 P4-Phase03a /goal（备查）</summary>

```
开工先读：
- docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/{phase-03-tool-registry,architecture,roadmap,protocol-contracts}.md
  （phase-03 = DoD 主规格：§2.1 read tools 清单+Python endpoint 映射 / §3 tool 定义模板 / §4 Domain Client / §5 ToolFactoryContext / §6 audit 写入 / §7 legacy 并存 / §8 schema 权威 / §9 测试 / §10 验收 / §11 回滚；architecture §13.8 = Phase 02 落地实测【tools 加在 server.ts 的 streamText({tools}) 调用；Gateway 须保持纯核——domain client + tool registry 经 cfg 注入，与 persistTurn/createModel 同纪律】；protocol-contracts §6 = Python domain read 端点契约、§3 = A2UI envelope【03a 可先不填 a2ui，留 04a】、§9 = ai-sdk-v6）
- frontend/src/ai-gateway/{server.ts,config.ts}（Phase 02 纯核：streamText 在此，本 phase 加 tools + 把 domain client/tool registry 经 AiGatewayConfig 注入，勿 import electron/chat_db）+ frontend/src/electron/main/ai_gateway_lifecycle.ts（impure wrapper：本 phase 在此构造 DomainClient 注入 serve-api baseURL[resolveApiPort] + 内部 auth token，并把 read-tool registry 注入 cfg）
- frontend/src/shared/chat/tools/{registry.ts,manifest.ts,builtin/}（legacy 工具定义 = schema/语义 SSoT，迁移时共享 fixture 防 parity 漂移）+ frontend/src/shared/chat/dispatch.ts（legacy 执行/审计语义，chat_tool_call 字段不能比它少）
- src/api/routers/email.py（read 端点：GET /{id}(:239) · /{id}/body(:294) · /search(:358)）+ src/api/routers/chat.py（/api/chat/kos-call）+ src/api/routers/reports.py（report 读）—— DomainClient 包这些，envelope unwrap + error code→tool error + abort signal
- frontend/src/electron/main/chat_db.ts 的 chat_tool_call 表（audit owner）+ tests/agent_eval/（read 场景 baseline，golden fixtures 防 parity 漂移）
前置已绿（引用即可，勿重验/重装）：Phase 02 ✅（embedded Gateway + UIMessage 流 + 持久化 v1，commit a6d189ac，architecture §13.8）；Gateway 纯核/wrapper 注入范式（persistTurn/createModel）已立；ai@6 / @ai-sdk/anthropic / @assistant-ui/react-ai-sdk / zod 已装。🔴 已知坑（沿用）：convertToModelMessages 是 async 必须 await；动 chat_db schema → bump CHAT_DB_VERSION（非 EXPECTED_DB_VERSION）+ db.py 头注释镜像 + 改对应 schema_version 终态断言。

/goal 完成 chat-panel Phase 03a（read tools 迁移到 AI SDK Gateway tools），产出可验证：
(1) AI SDK Gateway read-tool registry（frontend/src/ai-gateway/tools/）：email_search/email_get/email_body/
    email_list_thread/email_search_attachments/kos_query（+ report_list/report_get 若低成本）用 tool({inputSchema:zod,
    execute}) 定义，接进 server.ts 的 streamText({tools, stopWhen: stepCountIs(N)}) 实现多步「调读工具→回答」；
    **read tools 绝不 needsApproval**；write tools 本 phase 不暴露（gated MAILAGENT_AI_SDK_WRITE_TOOLS 默认 off）；
(2) MailAgentDomainClient（frontend/src/ai-gateway/python/domainClient.ts）：typed HTTP → serve-api read 端点，
    统一 envelope unwrap / error code→tool error / abort signal / 注入内部 auth token；**不直接读 SQLite**；
    Gateway 保持纯核——domain client + tool registry 经 AiGatewayConfig 注入（wrapper 在 ai_gateway_lifecycle.ts
    构造，serve-api baseURL=resolveApiPort + token），server.ts 不 import electron/chat_db；
(3) ToolFactoryContext（§5）：domain client + session{id,uiThreadId} + signal 注入，工具不从 React/global/
    renderer 读上下文；
(4) audit：每个 tool call 写 chat_tool_call（input/output/status/duration_ms，字段不比 legacy dispatch 少；
    若需 ui_payload_json 列 → bump CHAT_DB_VERSION 同 Phase 02 纪律；read tools 无 approval 字段）；
(5) 测试：ai-gateway/tools/{email_search,email_get,kos_query,parity}.test.ts —— input schema invalid /
    Python endpoint error→tool error / abort 取消 HTTP / read tools 不请求 approval / **parity**（legacy result
    vs gateway result 关键字段一致，共享 schema fixture）。
验收（phase-03 §10）：read tools 在 AI SDK runtime 下可用（MAILAGENT_AI_SDK_GATEWAY=1 + MAILAGENT_CHAT_RUNTIME=ai-sdk
  贴一次「问→调 read tool→带结果回答」trace）；≥5 个历史 read eval scenario 通过；write tools 未开 flag 不暴露；
  chat_tool_call 审计字段不少于 legacy；pnpm -C frontend typecheck 0 + test 无新增失败；tests/agent_eval ≥ baseline
  （默认走 legacy harness opt-in 不影响 —— 跑一次兜底；read-tool parity 由 parity.test 保）。
本阶段不做：write tools 执行（03b）/ approval 两次调用语义 + R5 recorder 重对齐（04b）/ A2UI 卡片（04a）/ AG-UI。
.env.example 若新增 flag（MAILAGENT_AI_SDK_WRITE_TOOLS 等）同步登记。证据（tool trace + parity 测试 + eval）贴对话。
完成用 codex（codex-rescue）或 code-reviewer 过 diff 再收。
```

</details>

### P4-Phase03b — write tools preview + HITL approval ✅ 已落地（2026-06-24，commit `ae268c67`，全程 flag-off）

> **DONE**：5 写工具（`email_flag`/`email_archive`/`email_pin` preview + `email_draft_reply` edit + **`email_resync`** preview
> = goal 里 `sync_to_notion` preview 的「重推 Notion」语义）迁 AI SDK Gateway，gated `MAILAGENT_AI_SDK_WRITE_TOOLS`（默认 off →
> `buildGatewayTools` 仅 `writeToolsEnabled && approvalGuard` 加写工具，字节级等同 03a）；经 `MailAgentDomainClient`(+5 写方法，
> wire 逐字镜像 HttpChatPlatform)→serve-api 写端点（MailWriteService 二次鉴权）。**HITL 两次调用**（`auditedWriteTool`，tools/types.ts）：
> `needsApproval` 恒 true + 副作用注册 `ApprovalGuard` 记录（keyed toolCallId，keep-first 绝对，跨两调存活）；`execute` 仅二调
> （已批准 + ai@6 验签）跑 `guard.verify`(expiry/hash)→domain 写→审计。**两层正交 guard**：(a) ai@6 `experimental_toolApprovalSecret`
> HMAC **绑 approvalId+toolCallId+toolName+input**（核 ai dist 确认 → 换料即 `InvalidToolApprovalSignatureError`，execute 前拒）；
> (b) domain `ApprovalGuard`（`security/approval.ts`，独有 = expiry[ai@6 无] + 审计 id + 防御纵深）。审计：`chat_tool_call` 加
> `approval_status`/`approval_hash`（`user_edited_input_json` v3 已存在）→ `CHAT_DB_VERSION 9→10`（additive ALTER + hasColumn +
> 终态断言 + db.py 头注释 + test_chat seed DDL；NOT EXPECTED_DB_VERSION）。**eval R5 重对齐（rules.py 零改）**：recorder 适配层
> `tests/agent_eval/recorder/ai_sdk_adapter.ts`（纯函数，结构对齐 ai@6 `ToolUIPart`）把 ai@6 tool parts → trace events
> （write→`pending_confirmation` 同 tier、`output-available`→`tool_result`、首调 `approval-requested` 未决→`final.status='needs_confirmation'`、
> read 绝不 pending）；fixture `runs/ai-sdk-approval.jsonl` 在未改 rules.py 下 hard_pass。
>
> **🔴 两处必须正视的契约差（architecture §13.10.2）**：① ai@6 `ToolApprovalResponse` **无 `editedInput`** 字段 + signed approval
> 绑 input → **严格 approve/reject，原生不支持 edit-tier 改料**（03b 无 UI 编辑 → 不触发；**edit→重签是 Phase 04a 的核心活**）；
> ② `sync_to_notion` 落地为 `email_resync` —— eval catalog（R5 冻结真源）+ legacy SSoT + parity 三者一致（catalog 有 `email_resync`
> preview、无 `sync_to_notion`），dry-run-diff 富卡片留 04a。**🔴 ABI runner 陷阱（本 session 踩）**：全量 vitest 须 electron-as-node
> runner（`ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/vitest/vitest.mjs run`）—— 残留 node-ABI(147) 则 144 测
> `ERR_DLOPEN_FAILED`，先 `pnpm run rebuild:electron` 还原 140；`backend_lifecycle > process.resourcesPath 缺失` 是 electron-as-node 唯一
> 伪影（node runner 62/62 过，与 diff 无关，[[reference_vitest_better_sqlite3_abi_runner]]）。
>
> **验收**：typecheck(node+web) 0 · 全量 vitest **1786 passed**（+30）· `tests/agent_eval` **87**（+2，≥baseline）· `run_baseline --compare`
> hard_pass **29==29** rc=0 · code-reviewer(opus) **APPROVE**（7 不变式全 PASS，0 BLOCKER/HIGH；1 MEDIUM=edit-tier 在 secret-on 下不可达
> = 已文档化 fail-closed 04a 延后，3 LOW 全无需改）。落地见 [phase-03 §13](../chat-panel-ai-sdk-assistant-ui-refactor/phase-03-tool-registry.md#13-实现落地03b2026-06-24) + [architecture §13.10](../chat-panel-ai-sdk-assistant-ui-refactor/architecture.md#1310-phase-03b-落地2026-06-24write-tools-preview--hitl-approval)。原 /goal 备查于下。

<details><summary>原 P4-Phase03b /goal（备查）</summary>

```
开工先读：
- docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/{phase-03-tool-registry,phase-04-generative-ui-hitl,architecture,protocol-contracts}.md
  （phase-03 §2.2 = preview write 工具清单+迁移策略 / §6 = audit 的 approval_status 列 / §7 legacy 并存；phase-04 = HITL approval（SendApprovalCard/hash/expiry）；architecture §13.4 = approval 两次调用 vs awaitConfirmation 差异 + **eval R5 重对齐落点=recorder 适配层**、§13.9 = 03a read tools 落地纪律（纯核+注入+audit）；protocol-contracts §6.2 = Python write 端点契约、§7 = ToolApprovalRequest/Response payload 契约、§3 = A2UI approval envelope）
- frontend/src/ai-gateway/{server.ts,config.ts,tools/*}（03a 落地：read 工具 + auditedReadTool + buildGatewayTools 的 writeToolsEnabled gate 占位在此；本 phase 加 write 工具 + needsApproval + 二调 flow）+ ai_gateway_lifecycle.ts（DomainClient 已建，本 phase 加 write 端点方法 + approval guard）
- frontend/src/shared/chat/tools/builtin/write.ts（legacy 写工具 = schema/语义/confirmationTier SSoT，parity）+ confirmation.ts（legacy awaitConfirmation/userEdited 语义）+ src/api/routers/email.py（写端点：/{id}/flag · /archive · /pin · /draft；MailWriteService 二次校验）
- tests/agent_eval/（R5 规则 + recorder-contract.md：approval-request→pending_confirmation 映射的重对齐落点）+ frontend/src/electron/main/chat_db.ts chat_tool_call（approval_status/approval_hash 若需则 bump CHAT_DB_VERSION）
前置已绿（引用即可，勿重验/重装）：Phase 03a ✅（9 read 工具 + DomainClient + audit + parity，commit <03a>，architecture §13.9）；Gateway 纯核/注入 + audit 范式已立；ai@6 内建 needsApproval/InvalidToolApprovalSignatureError（architecture §13.1）。🔴 已知坑（沿用）：convertToModelMessages async 必 await；动 chat_db schema → bump CHAT_DB_VERSION（非 EXPECTED_DB_VERSION）+ db.py 头注释 + 改 schema_version 终态断言 + test_chat.py seed DDL；mock-model 难驱动 tool loop（用真实模型 harness + 单测/parity 兜 CI）。

/goal 完成 chat-panel Phase 03b（write tools preview + HITL approval），产出可验证：
(1) write-tool registry（preview/edit）：email_flag/email_archive/email_pin/email_draft_reply/sync_to_notion(preview)
    用 tool({inputSchema:zod, needsApproval, execute}) 定义，gated MAILAGENT_AI_SDK_WRITE_TOOLS（默认 off）；经 DomainClient
    → serve-api 写端点，Python domain service 二次鉴权；parity（legacy write result vs gateway）；
(2) HITL approval（needsApproval 两次调用）：首调结束于 tool-approval-request part → 前端审批卡（先复用/generic）→
    approve/edit/reject → 二调执行；approval id/hash/expiry guard（domain 侧 + ai@6 内建签名校验叠加）；
(3) eval R5 重对齐（不回退判据）：recorder 适配层把 AI SDK approval-request 映射成 trace pending_confirmation（同
    tool_use_id/tool_name/tier）、二调 output-available→tool_result、首调未决→final.status='needs_confirmation'；
    **rules.py 零改**；tests/agent_eval baseline 在新 recorder 下重过不回退；
(4) audit：write tool call 写 chat_tool_call（approval_status/approval_hash/user_edited_input_json；若加列→bump
    CHAT_DB_VERSION 同纪律）；
(5) 测试：ai-gateway/tools/{write_preview,approval}.test.ts（needsApproval 触发 / approve-edit-reject flow / hash
    mismatch 拒 / domain guard / parity）+ R5 recorder 重对齐 fixture。
验收：write tools 仅 flag-on 暴露 + 默认需 approval（无 silent 写）；approve 后二调真实写 + audit approval_status；
  无 approval token 不能真实执行；typecheck 0 + test 无新增失败；tests/agent_eval ≥ baseline（R5 新 recorder 下）。
本阶段不做：高风险外发 email_prepare_send/send_approved（04b 末，SendApprovalCard + content hash）/ 富 A2UI 卡片（04a）/ AG-UI。
.env.example 同步登记新 flag。证据（approval flow trace + R5 重对齐 eval + parity）贴对话。完成用 codex 或 code-reviewer 过 diff 再收。
```
</details>

### P4-Phase04a — Generative UI & A2UI 工具卡片 ✅ 已落地（2026-06-24，commit `09424fd4`，全程 flag-off `MAILAGENT_A2UI_TOOL_CARDS`）

> **DONE**。A2UI ComponentRegistry（`createComponentRegistry`/`byName`→assistant-ui `tools.by_name`/`resolve` miss→generic
> ToolTraceCard **不阻断**）+ 富卡片（DraftReplyCard[edit 可编辑 markdown] / NotionSyncCard[email_resync] / ApprovalActionCard
> [flag·archive·pin]）+ `buildToolA2UIPayload` 单一真源（卡片渲染 + gateway 审计共用）+ `getAssistantPartComponents` flag-off
> 字节级一致。**🔴 核心裁决 = 域内 re-approve（secret 保持 on）**：ai@6 验签绑 history 里的 `toolCall.input` 且 `signToolApproval`
> 未导出 → 无法 ai@6 格式重签；裁决「编辑从不进 ai@6 history input」—— 卡片改正文 → `POST /api/ai/approval/resolve` →
> `ApprovalGuard.applyEdit` 存 `editedInput`（仅 editableFields，identity[internal_id] pin）→ `verify` 返 `effectiveInput` →
> execute 跑编辑后 input；卡片只发 `{approved:true}`，body 走侧信道 → 二调对未变的 input 验签仍过（无安全回退）。preview 不可编辑
> （E_APPROVAL_NOT_EDITABLE）。a2ui 只进审计绝不进模型 result（保 03b parity）→ `chat_tool_call.ui_payload_json`（`CHAT_DB_VERSION
> 10→11`）。R5 零改 rules.py（recorder `userEdited`→`pending_confirmation.user_edited` + fixture `runs/ai-sdk-approval-edit.jsonl`
> AGT-ACTION-001 hard_pass）。验收：typecheck 0 · vitest **1828**（唯一 fail = backend_lifecycle resourcesPath electron-as-node
> 伪影，node runner 62/62 过）· agent_eval **88** · 卡片截图 dark+light（重建 `frontend/poc/cards/` harness）· code-reviewer(opus)
> APPROVE（6 不变式全 PASS 含对抗 edit 安全，0 CRITICAL/HIGH）。落地见 [architecture §13.11](../chat-panel-ai-sdk-assistant-ui-refactor/architecture.md#1311-phase-04a-落地2026-06-24a2ui-componentregistry--富工具卡片--editre-approve)。原 /goal 备查于下。

<details><summary>原 P4-Phase04a /goal（备查）</summary>

```
开工先读：
- docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/{phase-04-generative-ui-hitl,phase-01-assistant-ui-shell,architecture,protocol-contracts}.md
  （phase-04 §3 ComponentRegistry / §4 DraftReplyCard·NotionSyncCard / §7 UIMessage state→UI 状态表 / §8 legacy compat / §9 测试 / §10 验收 / §11 回滚；phase-01 §8 = 06-22 Phase 2 UX 诉求映射[tool timeline/thinking/confirmation polish/error recovery 由 assistant-ui+A2UI 承载]；**architecture §13.10.2(1) = 03b 留的 editedInput/re-sign gap = 本 phase 核心**、§13.10.3 = 两层 guard；protocol-contracts §3 = A2UIPayload 契约 / §7 = ToolApprovalRequest/Response payload + a2ui envelope）
- frontend/src/ai-gateway/tools/{write.ts,types.ts,email.ts,report.ts,kos.ts}（03a/03b 工具：本 phase 在 tool result + approval-request 加可选 `a2ui` envelope payload[protocol §3/§7.3]，**不改执行/审批语义**）+ server.ts（approval-request part 经 streamText 已出，本 phase 不改两调 flow）
- frontend/src/shared/assistant/{components,runtime,tools}（Phase 01 落地：headless primitives + MailAgentRuntimeProvider + 现 generic `tools.Fallback`/ToolTraceCard；本 phase 加 ComponentRegistry + 专用卡）+ AssistantUIChatPanel.tsx + 现 legacy ConfirmToolDialog fallback
- frontend/src/electron/main/chat_db.ts 的 chat_tool_call（`ui_payload_json` 列若需则 bump CHAT_DB_VERSION 10→11 同纪律）+ frontend/src/ai-gateway/security/approval.ts（ApprovalGuard：re-sign/re-issue 时 edit-tier 已放宽 hash，本 phase 接 UI 编辑触发）
前置已绿（引用即可，勿重验/重装）：Phase 03b ✅（5 write tools + needsApproval 两调 + ApprovalGuard + R5 adapter，commit `ae268c67`，architecture §13.10）；Phase 01 assistant-ui shell + generic ToolTraceCard fallback 已立；ai@6 内建 needsApproval/approval-request part + assistant-ui `hitl`/`makeAssistantToolUI`/`ToolApprovalResponse` 原语（architecture §13.1）。🔴 已知坑（沿用）：全量 vitest 须 **electron-as-node runner**（残留 node-ABI 先 `pnpm run rebuild:electron`）；assistant-ui Thread happy-dom 测试须 stub ResizeObserver/IntersectionObserver/scrollIntoView；flag 走 **per-flag vite define**（不用 envPrefix 防泄漏 CLI_API_KEY）；动 chat_db schema → bump CHAT_DB_VERSION（非 EXPECTED_DB_VERSION）+ db.py 头注释 + 终态断言 + test_chat.py seed DDL。

/goal 完成 chat-panel Phase 04a（A2UI ComponentRegistry + 富工具卡片），gated MAILAGENT_A2UI_TOOL_CARDS（默认 off），产出可验证：
(1) A2UI ComponentRegistry（frontend/src/shared/assistant/tools/）：createComponentRegistry + A2UIPayload 类型（protocol §3）+ registerToolUIs；已注册工具渲专用卡、未注册走 generic ToolTraceCard fallback、**registry miss 不阻断对话**；
(2) 富卡片接 03b 写工具的 approval-request + tool-result part（assistant-ui makeAssistantToolUI/hitl 原语）：DraftReplyCard（email_draft_reply, edit tier — 预览正文 + **可编辑 markdown** + 创建前确认 + 成功展 draft id/mailbox）/ NotionSyncCard（email_resync/sync — 目标 db·page + property mapping + conflict warning）/ generic 审批卡（flag/archive/pin preview）；tool result 的 a2ui payload → 卡片渲染；
(3) **edit → re-sign approval（03b 留的 gap，architecture §13.10.2(1)）**：用户在 DraftReplyCard 改正文 → 前端重新发起 approval 使 ai@6 签名对编辑后 input 有效（重签/re-issue approval-request，或域内 re-approve），编辑后仍经 needsApproval 二调执行；**保 R5 不破**（edited input 仍 pending_confirmation→tool_result，recorder 适配层 userEdited 已就位）；
(4) audit：A2UI payload 进 chat_tool_call.ui_payload_json（若加列 → bump CHAT_DB_VERSION 10→11 同纪律）；
(5) 测试：assistant/tools/{ComponentRegistry(hit/miss/fallback), DraftReplyCard(render + edit→re-sign), NotionSyncCard}.test.tsx + a2ui schema invalid fallback + edit→re-sign 保 R5 fixture + tests/agent_eval ≥ baseline（view-layer 理应不影响 trace；edit→re-sign 的 trace 仍 R5 valid，跑兜底）。
验收（phase-04 §10）：MAILAGENT_A2UI_TOOL_CARDS=1 下 tool cards 正常渲染；email_draft_reply 可编辑后创建草稿（edit→re-sign 真生效）；registry miss 不阻断；flag-off（默认）走 generic ToolTraceCard 字节级不变；typecheck 0 + test 无新增失败；tests/agent_eval ≥ baseline。
本阶段不做：高风险外发 SendApprovalCard + email_prepare_send/send_approved（04b 末，content hash + idempotency）/ AG-UI（05）/ cutover 删 legacy（06）。
.env.example 登记 MAILAGENT_A2UI_TOOL_CARDS。证据（卡片截图 + edit→re-sign approval flow trace + R5 eval + 测试）贴对话。完成用 codex 或 code-reviewer 过 diff 再收。
```
</details>

### P4-Phase04b — 高风险外发 SendApprovalCard + email_prepare_send ✅ 已落地（2026-06-25, commit `66d1b489`, flag-off `MAILAGENT_AI_SDK_SEND_TOOL`）

> **DONE**：唯一真发信工具 `email_prepare_send`（blocking tier，needsApproval 恒 true，**工具名刻意不叫 email_send**=R2 禁裸发名）经
> SendApprovalCard 人工确认 + **双 guard** 才走真实 SMTP。新文件：`ai-gateway/{security/sendToken.ts,tools/send.ts}` +
> `shared/assistant/tools/{security/hashOutboundPayload.ts[纯，renderer 安全],mail/SendApprovalCard.tsx[To/CC/BCC/Subject/Body 可编辑 +
> 外部/敏感词 warning + 审批倒计时 + edit→re-approve 复用 04a 侧信道重算 hash]}` + `src/services/send_guard.py` + `POST /api/email/send-approved`。
> **🔴 跨语言 content hash**=行分隔规范串（**刻意非 JSON**，避键序/转义漂移）TS `canonicalizeOutbound`↔Python `canonicalize_outbound`，golden
> `f203073…` 两侧对同一 payload 断言（锁「canonical 漂移→每封拒发」）。**🔴 双 guard ordering**：Python `SendLedger.reserve` 在
> `MailWriteService.send` **之前**（replay/并发先拒，fail-closed）+ gateway `ApprovalGuard.consume`（一次性 usedAt→E_APPROVAL_USED）。**🔴 risk
> 双词汇**（沿用 03b sync_to_notion→email_resync 先例）：gateway/A2UI=`blocking`，持久化/eval/recorder=`edit`（chat_tool_call CHECK + catalog
> 只认 silent/preview/edit），`auditedWriteTool.risk` 类型收窄 `Exclude<…,'blocking'>`。**🔴 HMAC key=复用 local API token**（main-only，零新增密钥）。
> **🔴 eval gateway_only**：catalog 加 `email_prepare_send` 须标 `gateway_only:true`（无 legacy builtin 源，否则 `test_catalog_in_sync_with_main_source`
> DRIFT），validate_catalog 豁免其 extra+count parity 但 legacy 仍严格；**新 task 须给 baseline trace**（run_baseline `validate_all` 强制，否则「Refusing
> to score」），AGT-ACTION-004 baseline 落**新文件** `baselines/phase04b.jsonl`（保 v0.13.0 冻结，compare 仍 29==29）。chat_tool_call+`content_hash`/
> `idempotency_key`→`CHAT_DB_VERSION 11→12`（不动 EXPECTED_DB_VERSION）；send_ledger=sync_store.db feature-owned `CREATE IF NOT EXISTS`（不 bump
> DB_VERSION）。验收：typecheck 0 · vitest **1856**（唯一 fail=backend_lifecycle resourcesPath electron-as-node 伪影，node runner 62/62 过）·
> test_send_guard 9 · agent_eval **89** · compare **29==29** · **真发自测信 dogfood**（`scripts/dev/dogfood_send_approved_04b.py`：SENT + IMAP
> 实测落 Sent + replay E_SEND_ALREADY_SENT）· 卡片截图 dark+light · **rules.py 零改** · code-reviewer(opus) **APPROVE**（9 不变式全 PASS，0
> CRITICAL/HIGH，MEDIUM mark_sent 已改 best-effort）。落地见 [architecture §13.12](../chat-panel-ai-sdk-assistant-ui-refactor/architecture.md#1312-phase-04b-落地2026-06-25高风险外发-email_prepare_send--sendapprovalcard--双-guard)。原 /goal 备查于下。

<details><summary>原 P4-Phase04b /goal（备查）</summary>

```
开工先读：
- docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/{phase-04-generative-ui-hitl,architecture,protocol-contracts}.md
  （phase-04 §4.3 = SendApprovalCard 必备字段[To/CC/BCC/Subject/Body editor/附件/外部收件人·敏感词 warning/expiry countdown/允许发送·修改后继续·取消] / §5 = ApprovalService(ApprovalRecord{contentHash,idempotency,expiry,status}) / §6 = 外发 domain guard 双层校验清单[Gateway: approval exists·not expired·approved/edited·hash(finalDraft)==contentHash·idempotency 未用；Python: token 签名·未过期·payload hash·idempotency 未在 send ledger·backend 支持 send] / §10 验收 / §11 回滚；**architecture §13.11 = 04a edit→re-approve 侧信道（04b 的 edit→re-approve 复用它 + 加 content hash 重算）**、§13.10.3 = 两层 guard；protocol-contracts §3 = A2UIPayload.audit{contentHash} / §6.2 = POST /api/email/send-approved 契约 / §7 = ToolApprovalRequest.approval.contentHash）
- frontend/src/ai-gateway/{tools/write.ts,tools/types.ts,security/approval.ts,server.ts,config.ts}（04a 落地：auditedWriteTool 两调 + ApprovalGuard.applyEdit 侧信道 + /api/ai/approval/resolve；本 phase 加 blocking-tier email_prepare_send + content hash 绑定 + idempotency + ApprovalGuard 扩 contentHash/idempotency）+ ai_gateway_lifecycle.ts（DomainClient 加 send 方法）
- frontend/src/shared/assistant/tools/（04a：a2ui.ts 单一真源 + ComponentRegistry + DraftReplyCard/_cardShell；本 phase 加 SendApprovalCard[blocking] + a2ui SendApprovalCardProps + componentForTool 注册 email_prepare_send）+ security/hashOutboundPayload.ts（新）
- 真实 send 后端：src/api/routers/email.py 的 send 端点 + src/services/ MailWriteService send（复用 compose 的真实 SMTP；若无 send-approved 端点则新增，带 server-side approval token + idempotency send ledger 校验）
- tests/agent_eval/{tool_catalog.json,tasks/*,rubrics/email_action.md}（**🔴 加 email_prepare_send blocking + 更新 no_send_tool 措辞 + 保 R2/R5 baseline 零回退**；safety tasks forbidden_tools 仍禁 auto-send 名）+ frontend/src/electron/main/chat_db.ts chat_tool_call（content_hash/idempotency_key 若需→bump CHAT_DB_VERSION 11→12 同纪律）
前置已绿（引用即可，勿重验/重装）：Phase 04a ✅（A2UI ComponentRegistry + 富卡片 + edit→re-approve 侧信道 + ui_payload_json，commit `09424fd4`，architecture §13.11）；03b ✅（needsApproval 两调 + ApprovalGuard id/hash/expiry + R5 adapter）；ai@6 内建 needsApproval/InvalidToolApprovalSignatureError + assistant-ui hitl/makeAssistantToolUI 原语。🔴 已知坑（沿用）：edit→re-approve 走域内侧信道（编辑不进 ai@6 history input，secret 保持 on）；全量 vitest 须 electron-as-node runner（backend_lifecycle process.resourcesPath 是唯一伪影，node runner 全过）；flag 走 per-flag vite define；动 chat_db schema → bump CHAT_DB_VERSION（非 EXPECTED_DB_VERSION）+ db.py 头注释 + 终态断言 chat_db(_anchor).test + test_chat.py seed DDL；catalog 改动遇 materialize_ref(main) → commit 后 pytest tests/agent_eval 才全绿（pre-commit 该条 deselect），工具数断言同步改。

/goal 完成 chat-panel Phase 04b（高风险外发 SendApprovalCard + email_prepare_send），gated MAILAGENT_AI_SDK_SEND_TOOL（默认 off，须与 _GATEWAY/_WRITE_TOOLS/_A2UI 同开），产出可验证：
(1) email_prepare_send（blocking tier，永远 needsApproval，绝不 auto-send）：tool({inputSchema:zod[to/cc/bcc/subject/body/attachments/internal_id?], needsApproval, execute})；首调结束于 approval-request → SendApprovalCard；二调仅在 approve + content hash 匹配 + idempotency 未用时经 DomainClient → serve-api send 端点真实 SMTP 发送；**工具名不叫 email_send**（R2 禁用名）；
(2) SendApprovalCard（blocking，frontend/src/shared/assistant/tools/mail/）：展 To/CC/BCC/Subject/Body editor/附件列表 + 外部收件人·敏感词 warning + approval expiry countdown + 允许发送/修改后继续/取消；编辑 → re-approve 复用 04a 侧信道 + **重算 content hash**；
(3) **双层 guard（architecture §13.10.3 / phase-04 §6）**：Gateway ApprovalService（approval exists·not expired·approved/edited·hash(finalDraft)==contentHash·idempotency 未在 gateway scope 用）+ Python domain（approval token 签名·未过期·payload hash 匹配·idempotency 未在 send ledger·backend 支持 send）；任一失败 → tool_result error/canceled + **邮件绝不发出** + audit 错误码；
(4) eval 安全地板（**零回退判据**）：tool_catalog 加 email_prepare_send（blocking, write:true）+ 更新 no_send_tool 措辞（区分「无 auto-send」vs「有 human-gated prepare-send」）；R2 安全任务/forbidden_tools 仍禁裸发名；新增 AGT-ACTION/SAFETY 任务（prepare_send 须 pending_confirmation·hash mismatch 不发·idempotency 重放不重发）；run_baseline --compare 在新 catalog 下 hard_pass 不回退（rules.py 零改）；
(5) audit + 持久化：send approval 写 chat_tool_call（approval_status/content_hash/idempotency_key；若加列→bump CHAT_DB_VERSION 11→12 同纪律 + db.py + test_chat seed）；
(6) 测试 + dogfood：ai-gateway/tools/{send_approval,outbound_hash}.test.ts（needsApproval / hash mismatch 拒发 / idempotency 重放拒 / expiry / 双 guard / 外部收件人 warning）+ SendApprovalCard.test.tsx（render + edit→re-approve + warning）+ R5 send fixture；**真发一封自测信（dogfood gate，发给自己验证真实 SMTP + 落 Sent + idempotency 不重发）**。
验收（phase-04 §10）：email_prepare_send 无 approval / hash mismatch / idempotency 重放 均不能真实发送；SendApprovalCard 外部收件人 warning 正常；双 guard 任一失败邮件不发；flag-off（默认）字节级不变；typecheck 0 + test 无新增失败；tests/agent_eval ≥ baseline；真发自测信成功并落 Sent。
本阶段不做：AG-UI mirror（05）/ cutover 删 legacy harness/UI（06）/ remote-web 暴露面（resolve+send 端点 loopback CORS 收紧与 06 同批）。
.env.example 登记 MAILAGENT_AI_SDK_SEND_TOOL。证据（SendApprovalCard 截图 + 真发自测信 trace + 双 guard 拒发用例 + R5 eval + 测试）贴对话。完成用 codex 或 code-reviewer 过 diff 再收。
```

</details>

### P4-Phase05 — AG-UI Interop mirror（下一个 session）

> 04b 把高风险外发也接进了 AI SDK Gateway；05 是**互操作旁路**：把已稳定的 AI SDK UIMessage / tool parts / approval /
> context snapshot 映射成标准 **AG-UI event stream**（`/api/ai/agui/chat`），供外部 agent client / CopilotKit 生态 + 标准
> run lifecycle / interrupt / state snapshot / replay 用。gated `MAILAGENT_AG_UI_MIRROR`（默认 off）。**AG-UI 不是产品主
> runtime、不改 canonical persistence、不重实现工具**（architecture §9 / phase-05 §2）。
> **🔴 cutover（06）真正前置 ≠ AG-UI**：核实过 AI SDK chat 路径目前 **context-light** —— ① **standing-context 未注入**
> （SOUL/AGENT/RULES/USER + memory_summary + skill 能力 + 当前邮件/anchor 上下文只在 legacy `platform.ts` 组装，
> `useMailAgentAiSdkRuntime` transport 只发 `{sessionId,model}`，`server.ts` 的 system 无人填）；② **会话重载未接线**
> （prior `ui_message_json` 未喂 `useChatRuntime({messages})`，§13.8.5）。这两项 + body cap + remote-web CORS 是 cutover
> 前置（phase-06 §2），**AG-UI 旁路不解锁切流**；05 之后须补「AI SDK 生产 parity」再 06。本 phase 只做 AG-UI mirror。
> **🔴 先确认 AG-UI 官方包/版本/类型**（`@ag-ui/*` core/client + assistant-ui AG-UI runtime 适配如 `@assistant-ui/react-ag-ui`
> 是否存在/版本，依据=npm view + 包内 `.d.ts`，非凭记忆；若生态未就绪则范围降为「Gateway 侧 event adapter + golden
> snapshot 测试」，前端 smoke 标可选），装 devDeps。

```
开工先读：
- docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/{phase-05-ag-ui-interop,architecture,protocol-contracts}.md
  （phase-05 §3 新增目录[agui/{eventMapper,aguiRoute,stateSnapshot,interruptMapper}] / §4 endpoint / §5 event mapping 表 / §6 state snapshot[MailAgentAgUiState] / §7 interrupt mapping[approval→interrupt、interrupt response→ToolApprovalResponse] / §8 assistant-ui AG-UI runtime smoke / §9 测试 / §10 验收 / §11 回滚；architecture §9 = AG-UI 位置[旁路 mirror 非第一阶段主路径] / §13.8.1 = /api/ai/chat 现状[pipeUIMessageStreamToResponse] / §13.12 = 04b 双 guard approval 现状；protocol-contracts §8 = AG-UI mirror event 映射表 / §7 = ToolApprovalRequest/Response payload[interrupt 复用]）
- frontend/src/ai-gateway/{server.ts,config.ts}（02/03a/03b/04a/04b 纯核：streamText + tools + approval + pipeUIMessageStreamToResponse 在此；本 phase 加 /api/ai/agui/chat 旁路 endpoint —— **复用同一 streamText + tools + 04b 双 guard approval，只换 output 编码器为 AG-UI event**，勿 import electron/chat_db，agui route/adapter 经 cfg 注入）+ ai_gateway_lifecycle.ts（wrapper：本 phase flag-gate AG-UI route）
- frontend/src/shared/assistant/runtime/{useMailAgentAiSdkRuntime.ts,MailAgentRuntimeProvider.tsx,flags.ts}（01/02 落地：AI SDK runtime；本 phase 加**可选** aguiRuntimeProvider 仅 smoke 验互操作，非默认 runtime）
- frontend/src/ai-gateway/security/{approval.ts,sendToken.ts}（04b 双 guard：AG-UI interrupt 往返必须复用 ApprovalGuard.verify/consume + content hash + idempotency，**绝不另开绕过外发的路径**）
前置已绿（引用即可，勿重验/重装）：Phase 04b ✅（email_prepare_send + 双 guard + content hash + idempotency，commit `66d1b489`，architecture §13.12）；02 Gateway 纯核 streamText + UIMessage 流；03a/03b read+write tools + 04a/04b approval part 已在 streamText 输出。🔴 已知坑（沿用）：Gateway 纯核（agui adapter/route 经 cfg 注入，不 import electron）；flag 走 per-flag vite define；全量 vitest 须 electron-as-node runner（backend_lifecycle resourcesPath 唯一伪影 node runner 全过）；若动 chat_db schema → bump CHAT_DB_VERSION（非 EXPECTED_DB_VERSION）—— 但 AG-UI 旁路理应零 schema 改动。

/goal 完成 chat-panel Phase 05（AG-UI interop mirror），gated MAILAGENT_AG_UI_MIRROR（默认 off，不影响 AI SDK runtime 主路径），产出可验证：
(1) AG-UI event adapter（frontend/src/ai-gateway/agui/）：eventMapper（AI SDK canonical run / UIMessage parts → AG-UI RUN_STARTED / TEXT_MESSAGE_START·content·END / TOOL_CALL_START+args / TOOL_CALL_RESULT / STATE_SNAPSHOT / RUN_FINISHED / RUN_ERROR，protocol-contracts §8 表）+ interruptMapper（approval-request → AG-UI interrupt/requires-action[带 toolCallId/input/a2ui/risk/expiresAt]，interrupt response → ToolApprovalResponsePayload）+ stateSnapshot（MailAgentAgUiState：mailagentContext + thread{sessionId,anchorType,anchorId} + capabilities{enabledTools,enabledSkills,highRiskApprovalRequired:true}；**不塞完整邮件正文（大正文仍截断）、token/provider key 绝不进 state**）；
(2) endpoint POST /api/ai/agui/chat（SSE AG-UI event stream）：**复用同一 streamText + tools + 04b 双 guard approval**（不重实现工具、不绕过 content hash/idempotency），仅把 output 经 AG-UI 编码器；flag-gated，flag-off 不注册路由（默认行为字节级不变）；
(3) approval interrupt 往返：高风险外发 / 写工具 approval-request → AG-UI interrupt → interrupt response → 复用 03b/04b approval 二调（ApprovalGuard.verify/consume + content hash + idempotency，**任一失败邮件/写不发生**，与 /api/ai/chat 同一守卫）；
(4) 可选 assistant-ui AG-UI runtime smoke（useAgUiRuntime/HttpAgent 指向 /api/ai/agui/chat）渲一条基础对话 + 一条 tool call + 一条 approval，证互操作（**非默认产品 runtime**；若 assistant-ui AG-UI 适配生态未就绪 → 标可选、以 Gateway 侧 event golden snapshot 为主验收）；
(5) 测试：ai-gateway/agui/{eventMapper,interruptMapper,stateSnapshot}.test.ts（event 顺序 golden snapshot / tool args+result / approval interrupt 往返 / state snapshot 不含正文·token / error 映射）+（可选）e2e chat_agui_smoke。
验收（phase-05 §10）：MAILAGENT_AG_UI_MIRROR=1 下 endpoint 可用；不影响 AI SDK runtime 主路径（flag-off 字节级不变）；基础对话 / tool call / approval 三场景过 AG-UI smoke（或 Gateway 侧 golden snapshot）；AG-UI event sequence 有 golden snapshot；approval 经 AG-UI 仍走 04b 双 guard（**无静默外发路径**）；typecheck 0 + test 无新增失败；tests/agent_eval ≥ baseline（AG-UI 旁路天然不影响 legacy harness trace，跑一次兜底）。
本阶段不做：把 canonical persistence 改成 AG-UI event log / 把 assistant-ui 默认 runtime 切 AG-UI / 重实现 tools / **cutover（06）**；**standing-context 注入 + 会话重载 = cutover 前置，留 05 之后的「AI SDK 生产 parity」phase，不在本 phase**。
.env.example 登记 MAILAGENT_AG_UI_MIRROR。证据（AG-UI event golden snapshot + approval interrupt 往返 + smoke 截图/说明 + 测试）贴对话。完成用 codex 或 code-reviewer 过 diff 再收。
```

### P4-Phase03+ — 按 chat-panel roadmap §4 PR 拆分逐 phase 推进

> 每个 phase 用 chat-panel 对应 phase-0X 文档 + acceptance-checklist 当 DoD，外加：
> - read/write tools 迁移后跑 `tests/agent_eval` ≥ baseline（golden fixtures 防 parity 漂移）；
> - 高风险工具：`email_prepare_send` 无 approval token 不能真实发送 + 外发绑 content hash/approval id/expiry/idempotency + server-side guard；
> - approval 心智模型从 `awaitConfirmation` 迁到 AI SDK two-call needsApproval/response，eval R5 重对齐落点 = recorder 适配层（architecture §13.4，规则逻辑零改）；
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
