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

**出口门控：**
- [ ] memory eval：写入→下轮召回 / 修改→新规则生效 / 删除→不再用 / irrelevant 不污染 —— 全 pass。
- [ ] provenance 可见；冲突/删除可回放；memory prompt 注入长度可控。
- [ ] skill disabled/unavailable/permission 四类解释清楚不幻觉。
- [ ] ≥3 条跨域 curated task pass；plan artifact 进 trace report；**未引入第二 loop**（grep gate）。
- [ ] `tests/agent_eval` 总分不低于 baseline；有 tradeoff 必在 report 写明。

**PR 拆分（建议）：** P2a memory provenance+relevance / P2b auto-capture+conflict / P2c skill transparency / P2d cross-domain plan artifact。每个独立 PR + eval before/after。

**回滚：** 每个能力 flag-gated；memory schema 变更走 `/db-migration`（bump DB_VERSION + 前端 EXPECTED_DB_VERSION 同步）。

---

## P3 —— 重定向决策（冻结 legacy UX，诉求并入 chat-panel）

**这不是独立 release，是一个决策 + 文档动作。**

06-22 roadmap **Phase 2（UX Fluidity）**要打磨的 tool timeline / thinking 展示 / confirmation polish / error recovery，全在 `MessageList`/`Composer`/`ConfirmToolDialog` 上——而这三个文件是 chat-panel phase-06 明确要删的主路径。assistant-ui 原生就提供 tool UI / thinking / approval card，多数 Phase 2 诉求是「白送」的。

**动作：**
- [ ] 在 `docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/phase-01-assistant-ui-shell.md` + `phase-04-generative-ui-hitl.md` 登记「06-22 Phase 2 UX 诉求清单由 assistant-ui shell + A2UI cards 承载」（逐条映射）。
- [ ] 在 06-22 `roadmap.md` Phase 2 标记 **superseded by 06-23 P3 → chat-panel**（留指针，不删历史）。
- [ ] 仅保留少量「不依赖视图层、当前就值得修」的 UX 微调（若有）作为 P2 附带，其余一律推迟到 P4。

**出口：** chat-panel 两份 phase 文档含 Phase 2 诉求映射表；06-22 Phase 2 不再单独排期。

---

## P4 —— 换引擎（chat-panel Phase 00→06，eval gated）

= `docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/` 全量 7 phase。assistant-ui（唯一视图层）+ Vercel AI SDK Gateway（Node 编排层）。**每个 phase 验收叠加一条：跑通 `tests/agent_eval` 27-task baseline 不回退。**

**phase 顺序（chat-panel roadmap §8 最小可用路径）：**
```txt
00 Research&Spike → 01 assistant-ui Shell → 02 AI SDK Gateway
  → 03a read tools → 04a A2UI cards → 04b high-risk approval → 03b write tools → 06 cutover
(05 AG-UI mirror 可并行，不阻塞主线)
```

**关键门控（叠加在 chat-panel 各 phase 验收之上）：**
- [ ] **Phase 00 先行 gate**：assistant-ui 视觉 parity（MailAgent token/主题三态/accent）PoC + Node Gateway 进程生命周期 PoC（第三进程打包/端口/健康检查）通过，**再决定**是否推进 01→06。
- [ ] read tools / write tools 迁移后，跑同一套 `tests/agent_eval` ≥ baseline（golden fixtures 防 parity 漂移）。
- [ ] 高风险工具：`email_prepare_send` 无 approval token 不能真实发送；外发绑 content hash + approval id + expiry + idempotency；server-side guard 二次校验。
- [ ] approval 心智模型从 `awaitConfirmation` 迁到 AI SDK two-call needsApproval/response，eval R5 重新对齐。
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
| P2 内核 | ⬜ 待开工（goal-prompts.md P2a-d） |
| P3 重定向 | ⬜ 决策已定，随 P4 文档落地 |
| P4 换引擎 | ⬜ 待开工（Phase 00 spike 先行，goal-prompts.md P4-Phase00） |
