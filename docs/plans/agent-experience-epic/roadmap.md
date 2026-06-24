# Roadmap —— Agent 体验大版本专项（P0→P4 有序门控）

> task: `06-23-agent-eval-memory-skill-assistant-ui-ai-sdk`
> status: in_progress
> last-verified: 2026-06-23
> 方法论：eval 网先行 → 内核（view-agnostic）→ 换引擎（eval gated）。

本文件是执行脊柱。每阶段只写**范围 / 出口门控 / PR 拆分 / 回滚**，不重复 06-22 与 chat-panel 的细节（指针见 prd §9）。

---

## 阶段图

```txt
P0 止血 ✅ ── P1 eval 固化 ──┬─ P2 内核(memory+skill) ──┐
                            └─ P3 重定向决策 ───────────┴─ P4 换引擎(chat-panel 00→06)
```

门控铁律：**P1 不绿，P2 不改 prompt、P4 不换引擎**（无回归网 = 无法证明不回退）。

---

## P0 —— 止血（✅ 本 session 完成）

**做了什么：**
- `feat/harness-eval-recorder`（Phase 1：2 commit，soul.md/soul.ts `## Working method` + report.ts `report_id` grounding）rebase 到 main（零冲突，已验证落后的 3 个 main commit 不碰这 3 文件）。
- ff-merge 到 main（tip `6518b7a5`），线性历史。
- `git push origin main`：`882320c9..6518b7a5`，28 commit（26 积压 Phase -1/0A + 2 Phase 1），origin/main 已同步（0 0）。
- 删除已合并分支 `feat/harness-eval-recorder`，工作树干净。

**出口：** ✅ Phase 1 落地 main + 推送公开 origin；无悬空分支；无未 push 积压。

---

## P1 —— eval 固化为 `tests/agent_eval/`（✅ 完成，commit `7a74a922`）

把 06-22 gitignored 的 `.trellis/tasks/06-22-harness-agent-polish/eval/` 提升为 git-tracked 共用回归网。

**范围（进 git 的）：**
- `runner/`（rules.py / loader.py / validate.py / validate_catalog.py / run_baseline.py / report.py / models.py / judge.py + `runner/tests/`）—— 零-LLM rule gate 是核心。
- `tasks/*.json`（27）+ `fixtures/{emails,memory,reports}`（**脱敏后**）+ `rubrics/*.md`（8）+ `baselines/v0.13.0*` + `schema.md` + `tool_catalog.json` + `recorder-contract.md` + `recorder/recorder.ts`（deterministic，零 token）。

**排除（不进 git）：**
- `recorder/live_recorder.ts`（驱动真 LLM，烧 token）—— 留在 06-22 task 目录或单独 gitignored。
- `runs/live-*.jsonl`（非确定 live 产物）、`runs/*-smoke`、`__pycache__`、`*.report.compare.json` 临时物。

**出口门控（全部达成）：**
- [x] **脱敏审计通过**：fixtures 全用 RFC 保留 `.test` 域 + 合成 persona；`grep /Users` 与 `grep tp-link|omadanetworks` 均零命中。含绝对路径的 generated report 已排除不入 git。
- [x] `pytest tests/agent_eval -q` 零-LLM 全绿（独立复跑 **85 passed 0.1s**）。
- [x] `run_baseline --compare`（在 `tests/agent_eval/` 下）回归闸可跑：自比对 base=20 candidate=20 OK exit0。
- [x] `validate_catalog --source-ref main` 工具目录 **45==45** 不漂移。
- [x] import 隔离：新增 `tests/agent_eval/conftest.py` 注入 sys.path，`runner` 包名不变；主仓 `pytest tests/` 收集 **3048 零 error**（无串台）。
- [x] CLAUDE.md 开发指南登记 `tests/agent_eval/`（回归网入口 + 怎么跑 + judge/live recorder 不进 CI）。

**遗留（非阻塞）：** ① `.trellis/.../eval/` 的 live_recorder.ts 仍指向旧 fixtures，P2 起可改读 `tests/agent_eval/`（去重）。② "Lucien" first-name persona 在 `.test` 合成域上，非真实 PII；若要彻底中性化可后续 swap（不阻塞）。

**PR 拆分：** 单 PR（`test(agent-eval): 固化 eval 回归网到 tests/agent_eval`）。**push 前**必须脱敏审计绿。

**回滚：** 纯新增 `tests/` 目录，无生产行为改动；回滚 = 删目录。

---

## P2 —— 内核打磨（memory + skill/cross-domain，view-agnostic）

= 06-22 roadmap **Phase 3（Memory Intelligence）** + **Phase 4（Skill Transparency + Cross-domain）**。在当前 harness 上做，eval 网兜底。**强制 view-agnostic**：只动 Python domain services + 工具语义 + prompt + 轻量 artifact，不耦合 `MessageList`/`Composer`（它们将在 P4 被换）。

**范围（权威细节见 06-22 roadmap Phase 3/4）：**
- Memory：provenance（来源 session/message/tool）、规则化相关性选择、auto-capture（确认制）、冲突处理（不静默覆盖 + tombstone）、memory eval 类任务。
- Skill 透明：对话内 capability summary、why-not-call-tool 四类解释（禁用/无 scope/不可用/需确认）、禁用 skill 不幻觉调用。
- Cross-domain：轻量 plan/subgoal artifact（同一 harness loop 执行，可视化/可回放，**不是第二 engine**）。

**出口门控（全部达成，2026-06-23）：**
- [x] memory eval：写入→下轮召回（004）/ 修改→新规则生效（006）/ 删除→不再用（003/009）/ irrelevant 不污染（005）/ 冲突→不静默覆盖（007）/ 本轮信息不入长期记忆（008）—— 全 pass（memory 9/9）。
- [x] provenance 可见（P2a）；冲突先读现值再 old→new 确认（P2b prompt policy）；删除可回放；memory prompt 注入长度可控 + `memorySummaryMeta` 可观测（P2a）。
- [x] skill disabled/unavailable/needs-confirm 四类解释清楚不幻觉（P2c：SOUL honesty value + skillFragments header 四类 + AGT-SKILL-004 capability summary；skill_enablement 4/4）。
- [x] ≥3 条跨域 task pass（report_cross 4/5：001/002/004/005）；plan artifact（plan_update 工具）进 trace report；**未引入第二 loop**（grep gate：仅 harness.ts `while(iter<MAX_ITER)`）。
- [x] `tests/agent_eval` 总分不低于 baseline（36 tasks / hard_pass 29 ↑23，零既有回退，7 失败均既有 v0.13.0 设计缺陷样本）；无 tradeoff。

**PR 拆分（建议）：** P2a memory provenance+relevance / P2b auto-capture+conflict / P2c skill transparency / P2d cross-domain plan artifact。每个独立 PR + eval before/after。

**回滚：** 每个能力 flag-gated；memory schema 变更走 `/db-migration`（bump DB_VERSION + 前端 EXPECTED_DB_VERSION 同步）。

---

## P3 —— 重定向决策（冻结 legacy UX，诉求并入 chat-panel）

**这不是独立 release，是一个决策 + 文档动作。**

06-22 roadmap **Phase 2（UX Fluidity）**要打磨的 tool timeline / thinking 展示 / confirmation polish / error recovery，全在 `MessageList`/`Composer`/`ConfirmToolDialog` 上——而这三个文件是 chat-panel phase-06 明确要删的主路径。assistant-ui 原生就提供 tool UI / thinking / approval card，多数 Phase 2 诉求是「白送」的。

**动作（2026-06-23 全部落地）：**
- [x] 在 `phase-01-assistant-ui-shell.md` **§8**（baseline primitive）+ `phase-04-generative-ui-hitl.md` **§12**（A2UI rich cards）各加一张「06-22 Phase 2 五诉求 → assistant-ui 承载」逐条映射表，两表交叉引用。
- [x] 在 06-22 `roadmap.md` Phase 2 标题标记 **SUPERSEDED by 06-23 P3 → chat-panel** + blockquote 指针（phase-01 §8 / phase-04 §12 / 本 roadmap P3），目标/候选/出口保留作历史不删。
- [x] 「不依赖视图层、当前就值得修」的 UX 微调列为 06-22 roadmap Phase 2「fix-now 清单」F1（通用工具错误转写）/F2（latency·cost trace instrumentation）/F3（确认 tier taxonomy verify-only），标为**可选 P2.x 附带**；其余（工具时间线/thinking/卡片富文案/error 卡片/前台 latency 信号）推迟 P4。

**出口（✅ 达成）：** chat-panel 两份 phase 文档含 Phase 2 诉求映射表；06-22 Phase 2 不再单独排期。**纯文档，零运行代码改动。**

---

## P4 —— 换引擎（chat-panel Phase 00→06，eval gated）

= `docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/` 全量 7 phase。assistant-ui（唯一视图层）+ Vercel AI SDK Gateway（Node 编排层）。**每个 phase 验收叠加一条：跑通 `tests/agent_eval` 27-task baseline 不回退。**

**phase 顺序（实际落地序，chat-panel roadmap §8）：**
```txt
00 Spike ✅ → 01 Shell ✅ → 02 Gateway ✅ → 03a read ✅ → 03b write ✅ → 04a A2UI cards ✅
  → 04b high-risk send ✅ → 05 AG-UI mirror（旁路，进行中选定）
  → 〔AI SDK 生产 parity：standing-context 注入 + 会话重载 = cutover 真前置〕→ 06 cutover
```
> 🔴 05（AG-UI）是互操作旁路、**不解锁 cutover**；06 切流前必须先补「AI SDK 生产 parity」（AI SDK 路径当前 context-light，见进度表 P4 注 + phase-06 §2）。

**关键门控（叠加在 chat-panel 各 phase 验收之上）：**
- [x] **Phase 00 先行 gate**（✅ 2026-06-23，裁决 **GO**）：assistant-ui 视觉 parity（token/主题三态/6 accent，4 截图）PoC + Node AI SDK Gateway 嵌入 main PoC（`/health`+echo+真实 streamText+abort，harness **4/4 PASS**）通过；第三进程成本走「嵌入 main」近零。证据见 chat-panel [architecture.md §13](../chat-panel-ai-sdk-assistant-ui-refactor/architecture.md) / [roadmap §10](../chat-panel-ai-sdk-assistant-ui-refactor/roadmap.md)。→ 决定推进 01→06。
- [x] **Phase 01 assistant-ui Shell**（✅ 2026-06-23，commit `b82ee24e`，全程 flag-off）：`frontend/src/shared/assistant/` headless primitives + MailAgent token，legacy ExternalStore adapter 喂 `useEmailChat`（**非** AI SDK），AIChatPanel 经 `lazy()` flag 分流（flag-off 字节级一致），删 Phase 00 PoC。验收 typecheck 0 / vitest 1700·0fail（+22）/ agent_eval 85（≥baseline，view-only）/ 4 组 parity 截图 / 不新增 provider 路径；code-reviewer(opus) APPROVE。落地结论见 chat-panel [phase-01 §9](../chat-panel-ai-sdk-assistant-ui-refactor/phase-01-assistant-ui-shell.md)。
- [x] read tools / write tools 迁移后，跑同一套 `tests/agent_eval` ≥ baseline（golden fixtures 防 parity 漂移）。（03a/03b/04a/04b ✅；eval 89 ≥ baseline、`run_baseline --compare` 29==29）
- [x] 高风险工具：`email_prepare_send` 无 approval token 不能真实发送；外发绑 content hash + approval id + expiry + idempotency；server-side guard 二次校验。（**04b ✅** `66d1b489`：双 guard〔gateway `consume` 一次性幂等 + content hash ↔ Python 签名 + `SendLedger.reserve` 在 send 前 fail-closed〕+ 真发 dogfood 落 Sent + replay 拒）
- [x] approval 心智模型从 `awaitConfirmation` 迁到 AI SDK two-call needsApproval/response，eval R5 重新对齐。（03b recorder 适配层 + 04a/04b fixture，rules.py 零改）
- [ ] **🔴 cutover 前置（AG-UI 05 不解锁）**：standing-context 注入（SOUL/AGENT/RULES/USER + memory_summary + skill 能力 + 邮件/anchor 上下文 → AI SDK 路径，当前 context-light）+ 会话重载接线（prior `ui_message_json` → `useChatRuntime({messages})`，§13.8.5）+ body cap 提升 + remote-web CORS 收紧。**05 之后的「AI SDK 生产 parity」phase 做**。
- [ ] 旧会话可读（UIMessage 双写 + legacy mapper）；Gateway 不可用自动降级 legacy + 非阻断提示。
- [ ] cutover 前 AI SDK 新会话连续 dogfood 7 天无 P0/P1（chat-panel phase-06 §8）。

**PR 拆分：** 直接复用 chat-panel roadmap §4（PR-00a/b → PR-06a/b）。

**回滚：** chat-panel feature flags（`MAILAGENT_CHAT_RUNTIME=legacy` / `MAILAGENT_AI_SDK_GATEWAY=0` 等，见 chat-panel roadmap §6 + phase-06 §7）。**harness 退役前始终作为 rollback 通道保留**（phase-06 §4：先移除 legacy UI 主路径，dogfood 后再归档 harness）。

---

## 与现有 Trellis task 的关系

- 本 epic **不取代** `06-22-harness-agent-polish`（伞 task 留作 P2 权威细节 + eval 出处）与 chat-panel planning body（P4 权威细节）。本 epic 是**串起它们的执行 master plan + 门控**。
- P2 落地时可派生 `06-2x-phase3-memory` / `06-2x-phase4-skill` 独立实现 task（复用 06-22 roadmap 内容 + 本专项门控）。
- P4 落地时按 chat-panel PR 拆分派生实现 task。

---

## 当前进度

| 阶段 | 状态 |
|---|---|
| P0 止血 | ✅ 完成（main 同步 origin `6518b7a5`，分支已删） |
| P1 eval 固化 | ✅ 完成（commit `7a74a922` 推送 origin；85 passed 0.1s 零-LLM；脱敏审计零命中；CLAUDE.md 已登记） |
| P2 内核 | ✅ 完成（P2a `7c93c3be` + P2b `19b3f381` + P2c `ef9115d8` + P2d `c9e0b8c5`；eval 36 tasks/hard_pass 29↑23 零回退；pytest 85 + vitest 151 + typecheck node+web 0；code-reviewer(opus) APPROVE 6/6 护栏） |
| P3 重定向 | ✅ 文档落地（2026-06-23）：chat-panel phase-01 §8 + phase-04 §12 映射表 / 06-22 Phase 2 superseded 指针 + fix-now 清单（F1/F2/F3）；纯文档零代码 |
| P4 换引擎 | ◐ 进行中：Phase 00 spike ✅ GO（`bc5c1e80`）+ **01 Shell ✅**（`b82ee24e`）+ **02 AI SDK Gateway ✅**（`a6d189ac`）+ **03a read tools ✅**（vitest 1756、eval 85）+ **03b write tools + HITL approval ✅**（2026-06-24，`ae268c67`，flag-off：5 写工具 + needsApproval 两调 + 两层 guard[ai@6 签名 + domain ApprovalGuard id/hash/expiry] + R5 recorder 重对齐 rules 零改；vitest 1786、eval 87≥baseline、reviewer APPROVE）+ **04a A2UI 富工具卡片 + edit→re-approve ✅**（2026-06-24，`09424fd4`，flag-off `MAILAGENT_A2UI_TOOL_CARDS`：ComponentRegistry + DraftReplyCard[可编辑]/NotionSyncCard/通用审批卡 + 域内 re-approve 侧信道[编辑不进 ai@6 history input、secret 保持 on] + ui_payload_json[CHAT_DB_VERSION 11]；vitest 1828、eval 88≥baseline、reviewer APPROVE 6 不变式）+ **04b 高风险外发 email_prepare_send + SendApprovalCard + 双 guard ✅**（2026-06-25，`66d1b489`，flag-off `MAILAGENT_AI_SDK_SEND_TOOL`：blocking send 经人工确认 + gateway〔consume 幂等 + content hash〕↔Python〔签名 + SendLedger reserve fail-closed〕双 guard，跨语言 hash golden 两侧断言，CHAT_DB_VERSION 12，catalog gateway_only；vitest 1856、eval 89、compare 29==29、rules.py 零改、真发 dogfood 落 Sent、reviewer APPROVE 9 不变式）；**Phase 05 AG-UI interop mirror 待开工**（goal-prompts.md P4-Phase05，gated `MAILAGENT_AG_UI_MIRROR`）。**🔴 cutover〔06〕真前置 = standing-context 注入 + 会话重载（AI SDK 路径当前 context-light），05 AG-UI 旁路不解锁切流** |
