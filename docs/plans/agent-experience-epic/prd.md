# PRD —— Agent 体验大版本专项（整合 06-22 剩余阶段 + chat-panel 换引擎）

> task: `06-23-agent-eval-memory-skill-assistant-ui-ai-sdk`
> status: in_progress（P0 止血已落地）
> last-verified: 2026-06-23
> owner: chenyqThu
> 基线：v0.13.0 Custom AI Harness epic（P1/P2/P3 + cleanup 已发布）+ 06-22 Phase -1/0A/0/1 已完成。

---

## 0. 这份专项要解决的真问题

当前有**两个独立的 planning 体**，它们对「agent 编排层」的根本假设**直接对立**：

- **`.trellis/tasks/06-22-harness-agent-polish/`**（eval 基准先行）—— 把当前自研 TS 单 loop `harness.ts` 当作**稳定地基**，在它上面打磨质量 / UX / memory / skill。roadmap §0.1 明文「不移动 harness.ts、不新建第二 loop」。已完成 Phase -1/0A（合 main）+ Phase 0（eval 网）+ Phase 1（质量收敛）。
- **`docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/`**（换引擎）—— 用 **assistant-ui（视图层）+ Vercel AI SDK Gateway（Node 编排层）替换**整套自研编排（`harness.ts`/`runtime.ts`/`dispatcher`/`ChatStreamEvent`）+ 删 `MessageList`/`Composer`/`ConfirmToolDialog`。纯计划，零代码。

如果两者各自推进，会出现两类浪费：
1. **返工**：06-22 Phase 2（UX）要打磨的 `MessageList`/`Composer`/`ConfirmToolDialog`，正是 chat-panel phase-06 明确要删的三个文件 → 在注定被删的旧 UI 上做精装修。
2. **盲切**：chat-panel 自己把「工具从 TS harness 迁到 AI SDK tools 出现 parity 差异」列为主要风险，但它没有量化回归网 → 换引擎后无法证明「质量没回退」。

**本专项的判断**：两者不是竞争，是**有依赖顺序的接力**。06-22 提供「怎么衡量 agent 好不好」的尺子（eval 网）+「memory/skill 业务语义」的内核；chat-panel 提供「用什么视图层 + 编排引擎承载」。**先用 06-22 把尺子和内核做扎实（且别在旧 UI 上做注定被删的精装修），再用 chat-panel 换引擎，并用那把尺子保证换引擎零回退。**

本专项把这条接力固化为一个**有序、有门控的大版本**，分 P0→P4 五个阶段，对应用户拍板的 ①②③④⑤。

---

## 1. 五步 → 五阶段映射

| 用户原始步骤 | 本专项阶段 | 一句话 | 状态 |
|---|---|---|---|
| ① 立即止血 | **P0** | rebase Phase 1 侧分支 → main + push 积压 commit | ✅ 本 session 已完成 |
| ② eval 固化 | **P1** | `eval/` → git-tracked `tests/agent_eval/`（脱敏审计 + 零-LLM CI 闸） | 进行中 |
| ③ memory/skill 内核 | **P2** | 06-22 roadmap Phase 3(memory) + Phase 4(skill/cross-domain)，视图层无关 | 待 P1 |
| ④ Phase 2 重定向 | **P3** | 冻结「在 legacy UI 上做 UX」，诉求并入 chat-panel assistant-ui shell | 决策已定，随 P4 落地 |
| ⑤ chat-panel 换引擎 | **P4** | chat-panel Phase 00→06：assistant-ui + AI SDK Gateway | 待 P1（+P2 早期） |

---

## 2. 产品目标

- **G1 可信度可度量**：agent 行为有可运行、可回放、可比较的回归网（`tests/agent_eval/`，27 curated tasks + hard rules R1-R8）。任何 prompt / 工具策略 / 编排引擎改动，都能量化证明「不低于 baseline」。
- **G2 内核增值与视图解耦**：memory（provenance / 相关性 / 冲突 / 可撤销）与 skill 透明（capability summary / why-not-call / 轻量 plan artifact）做成**视图层无关**的后端语义 + 工具行为，换引擎后直接复用。
- **G3 视图层与编排层现代化**：聊天面板迁到 assistant-ui（唯一视图层），LLM streaming / tool calling / approval / multi-step 从自研 harness 迁到 Vercel AI SDK Gateway（Node 编排层）。
- **G4 业务域不动摇**：AI SDK 只接管「chat / LLM 编排层」。邮件解析、DavMail 写路径、SQLite SSoT、Notion 同步、outbox FanoutWorker、KOS、附件抽取继续由 Python domain services 拥有。
- **G5 换引擎零回退**：P4 每个 phase 的验收门槛 = 跑通 `tests/agent_eval/` 的 27-task baseline 不回退 + 高风险写操作无静默执行路径。

---

## 3. 非目标

- 不把 MailAgent 后端业务栈改写成 Node / Next.js（只新增一个 Node 编排 Gateway）。
- 不引入第二个 agent loop：换引擎期间 harness 与 AI SDK Gateway 不同时跑；harness 退役前作为 legacy / rollback / parity-test 通道。
- 不在 P2 阶段引入向量库 / 不用 KOS 替代本地 memory SSoT / 不允许不可见的静默长期记忆。
- 不在 legacy `MessageList`/`Composer`/`ConfirmToolDialog` 上做注定被删的 UX 精装修（P3 重定向的核心）。
- P1 固化 eval 时，**不把任何真实邮件内容/真实人名/真实业务细节**带进公开仓库（脱敏审计是 P1 硬闸）。
- 不一次性把所有 builtin tools 全量 cutover 到 AI SDK manifest——只切语义/schema parity 已验证的工具。

---

## 4. 阶段间依赖与门控（核心）

```txt
P0 止血 (done)
  └─ P1 eval 固化  ←── 硬前置：没有共用回归网，P2 改 prompt / P4 换引擎都无法证明不回退
        ├─ P2 内核打磨 (memory + skill/cross-domain)   ── 视图层无关，可与 P4 早期并行
        └─ P3 重定向决策 (冻结 legacy UX)  ──喂给──> P4
              └─ P4 换引擎 (chat-panel 00→06)  ── 每 phase 被 tests/agent_eval gated
```

**不变量（贯穿全程）：**
1. **单 loop**：任何时刻只有一个活跃编排 loop。
2. **eval 是金标准**：P2 改 prompt/工具、P4 换引擎，验收都以 `tests/agent_eval` rule gate 为准（candidate vs baseline，零 LLM 可进 CI；judge / live recorder 不进 CI）。
3. **业务权威在 Python**：Gateway/harness 只编排，写操作落到 Python domain services 做二次鉴权 + 业务校验。
4. **安全底线**：send / delete / archive / reply-all / Notion 批量 / 邮件移动等高风险动作必须人类确认 + server-side guard；外发邮件绑 content hash + approval id + expiry + idempotency key。
5. **memory/skill 内核 view-agnostic**：P2 产物不耦合具体 loop，P4 换引擎后 Gateway 调同一套 Python domain services + 同一套 memory/skill 语义即复用。

---

## 5. 版本与发布切分（建议）

这个 epic 跨度大，不是一个 release。建议切成多个对外版本：

| 发布 | 含阶段 | 性质 |
|---|---|---|
| **v0.14.x**（近期 minor） | P1（eval 固化）+ P2（memory/skill 内核） | 纯增值，无视图层风险，当前 harness 上做 |
| **v0.15.x ~ v1.0**（换引擎，分多个 release） | P4 chat-panel Phase 00→06，按 feature flag 灰度 | 视图+编排换代，每 phase dogfood + eval gate |

> P3（重定向决策）不是独立 release，是写进 chat-panel phase-01/04 的设计约束。

---

## 6. 各阶段验收口径（提要，详见 roadmap.md）

- **P1**：`tests/agent_eval/` git-tracked；脱敏审计通过（零真实 PII）；`pytest tests/agent_eval -q` 零-LLM 全绿；`run_baseline --compare` 回归闸可跑；CLAUDE.md 文档地图加一行。
- **P2**：memory eval 类任务 pass（写入→召回→修改→删除→不污染）；provenance 可见；skill disabled/unavailable/permission 四类解释正确不幻觉；≥3 条跨域任务 pass；plan artifact 进 trace；**没有引入第二 loop**；总分不低于 baseline。
- **P3**：在 chat-panel phase-01/04 文档登记「Phase 2 UX 诉求由 assistant-ui 承载」；06-22 roadmap Phase 2 标记 superseded。
- **P4**：每 phase 对应 chat-panel acceptance-checklist；新会话默认 AI SDK 后旧会话可读；`email_prepare_send` 无 approval token 不能真实发送；A2UI 卡片可改后确认；Electron/Web 各 ≥10 dogfood；**全程 `tests/agent_eval` 不回退**。

---

## 7. 主要风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| eval fixtures 含真实邮件内容泄漏到公开仓库 | 隐私/合规 | P1 脱敏审计硬闸；可疑即合成替换或 hold push |
| P4 引入第三个常驻进程（Node Gateway，叠加 serve-api + DavMail JVM） | 打包 / 生命周期 / 端口复杂度 | Electron lifecycle 管理 + 健康检查 + 端口注入；Phase 00 spike 先验证 |
| AI SDK approval 是「两次模型调用」≠ 当前 `awaitConfirmation` 原地暂停 | 确认语义心智模型变更 | P4 文档 + UI 明确 approval-request/response；eval R5 重新对齐到新模型 |
| 工具从 harness 迁 AI SDK tools 出现 parity 漂移 | 质量回退 | `tests/agent_eval` 27-task baseline 每 phase gate + golden fixtures |
| P2 内核做成耦合 legacy loop | P4 换引擎后白做 | P2 强制 view-agnostic：只动 Python domain services + 工具语义 + prompt |
| 大 epic 拖期 / 范围蔓延 | 交付不收敛 | 严格按 P0→P4 门控；每阶段独立 release；高风险工具不赶进度 |

---

## 8. 开放决策（待用户拍板，给推荐默认）

| 问题 | 推荐默认 |
|---|---|
| eval 固化范围（哪些进公开 `tests/agent_eval/`） | runner（零-LLM rule gate）+ 27 tasks + 脱敏 fixtures + rubrics + baseline + deterministic recorder；**排除** live_recorder.ts（烧真 token）/ runs/live-* / __pycache__ |
| eval rule gate 是否进 CI | 进（零-LLM）；judge + live recorder 仅 manual lane |
| P2 先做 memory 还是 skill | 先 memory（Phase 3）——provenance/冲突是信任地基；skill 透明(Phase 4) 紧随 |
| P4 是否现在全做 | 否。先 Phase 00（research/spike）验证 assistant-ui 视觉 parity + Gateway PoC，再决定是否推进 01→06 |
| AI SDK Gateway 进程形态 | 第一版随 Electron main 内嵌 Node server；稳定后独立本地服务 |
| 这个 epic 的对外版本号 | P1+P2 = v0.14.x；P4 换引擎 = v0.15→v1.0 分多 release |

---

## 9. 关联文档

- 06-22 剩余阶段权威：`.trellis/tasks/06-22-harness-agent-polish/roadmap.md`（Phase 2/3/4/5）+ `eval/`（被 P1 固化）。
- chat-panel 换引擎权威：`docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/`（prd / architecture / roadmap / phase-00~06 / acceptance-checklist）。
- 本专项执行手册：本目录 `roadmap.md`（阶段图 + 门控）+ `goal-prompts.md`（P1/P2/P3/P4 可粘贴 session 启动 prompt）。
