# Agent 体验大版本专项（Agent Experience Epic）

> status: in_progress（P0 止血 + P1 eval 固化 ✅ 随 v0.14.0 发布；**P2 内核全部 ✅**：P2a provenance/relevance `7c93c3be` + P2b memory auto-capture/冲突 `19b3f381` + P2c skill 透明 `ef9115d8` + P2d cross-domain plan `c9e0b8c5`；**P3 重定向 ✅ 文档落地**（chat-panel phase-01 §8 / phase-04 §12 映射表 + 06-22 superseded 指针 + fix-now 清单）/ **P4 换引擎进行中**：Phase 00 spike ✅ GO（`bc5c1e80`）+ **Phase 01 assistant-ui Shell ✅**（2026-06-23，`b82ee24e`）+ **Phase 02 AI SDK Gateway ✅**（2026-06-24，`a6d189ac`）+ **Phase 03a read tools ✅**（2026-06-24，flag-off，9 read 工具→AI SDK Gateway tools 经 DomainClient→serve-api、parity 钉死、vitest 1756、eval 85≥baseline）+ **Phase 03b write tools + HITL approval ✅**（2026-06-24，`ae268c67`，flag-off，5 写工具 + needsApproval 两调 + 两层 guard + R5 recorder 重对齐 rules 零改、vitest 1786、eval 87≥baseline、reviewer APPROVE）+ **Phase 04a A2UI 富工具卡片 + edit→re-approve ✅**（2026-06-24，`09424fd4`，flag-off `MAILAGENT_A2UI_TOOL_CARDS`，ComponentRegistry + DraftReplyCard[可编辑]/NotionSyncCard/通用审批卡 + 域内 re-approve 侧信道[编辑不进 ai@6 history、secret 保持 on] + ui_payload_json[CHAT_DB_VERSION 11]、vitest 1828、eval 88≥baseline、reviewer APPROVE 6 不变式）+ **Phase 04b 高风险外发 email_prepare_send + SendApprovalCard + 双 guard ✅**（2026-06-25，`66d1b489`，flag-off `MAILAGENT_AI_SDK_SEND_TOOL`，blocking send 人工确认 + gateway〔consume 幂等 + content hash〕↔Python〔签名 + SendLedger reserve fail-closed〕双 guard、跨语言 hash golden 两侧断言、CHAT_DB_VERSION 12、catalog gateway_only、vitest 1856、eval 89、compare 29==29、rules.py 零改、真发 dogfood 落 Sent、reviewer APPROVE 9 不变式）+ **Phase 05 AG-UI interop mirror ✅**（2026-06-25，`7ddd09a0`，旁路端点复用同一 streamText+tools+双 guard、只换编码器）+ **06-parity 生产 parity ✅**（2026-06-25，`b758d25f`：standing-context 注入 + 会话重载，AI SDK 路径不再 context-light）+ **06a cutover A–G ✅**（2026-06-25，全程 master 默认 OFF→dark：chat_db v13 / master flag / 急切会话 latch / per-session 3-way 路由+首轮重挂修复 / 健康降级 / loopback CORS / backfill；opus code-reviewer 抓修 1 CRITICAL〔Chunk A 守卫误伤 onEnsureSession，被 mock 藏住〕`3fbafede`；vitest 1960、eval 89、typecheck 0、architecture §13.15）；**🔴 剩 06 的 H = 一行式翻 master 默认 `?? '' → '1'`，gate 在 electron+web dogfood → H 翻后进 06b 7 天观察窗删 legacy harness**）
> last-verified: 2026-06-25
> owner: chenyqThu
> Trellis 跟踪任务：`06-23-agent-eval-memory-skill-assistant-ui-ai-sdk`（`.trellis/tasks/`，本地执行壳）
> **本目录是这个大版本的权威 master plan（git-tracked，canonical）。**
>
> **✅ Chunk H cutover 已落（v0.20.0，2026-06-27）**：桌面端 `electron.vite.config.ts` 翻 master(`AI_SDK_NEW_SESSION_DEFAULT`) + `AGENT_VIEW` + `ASSISTANT_MODAL` 默认 `'1'`（CDP 验三 flag 默认开：embedded gateway 启动 + /sessions agent 视图 + "聊聊这封邮件" FAB）。**web（`vite.web.config.ts`）故意没翻**——留下一 phase。**cutover 后的代办**（web→ai-sdk / 06b 删 legacy / 完整 epic + harness 架构 review + 用户「核心调度层重构」框架 Mem0≠gbrain/user.md/SkillRegistry）→ [`next-phase-backlog.md`](./next-phase-backlog.md)。

---

## 这个专项在解决什么

把原本**两个对「agent 编排层」假设对立的 planning 体**，整合成一个**有序、有门控的大版本**：

| 子体 | 位置 | 对编排层的假设 | 在本 epic 的角色 |
|---|---|---|---|
| **harness-agent-polish** | `.trellis/tasks/06-22-harness-agent-polish/`（本地 Trellis 任务）+ git-tracked [`tests/agent_eval/`](../../../tests/agent_eval/) | 把当前自研 TS 单 loop `harness.ts` 当**稳定地基**打磨 | **P1/P2 的细节权威**（eval 出处 + memory/skill 内核），Phase 2 UX 已 superseded |
| **chat-panel × assistant-ui × AI SDK** | git-tracked [`../chat-panel-ai-sdk-assistant-ui-refactor/`](../chat-panel-ai-sdk-assistant-ui-refactor/) | 用 assistant-ui + AI SDK Gateway **替换**整套自研编排 | **P4 换引擎的细节权威**，每 phase 叠加 eval 闸 + 吸收 06-22 Phase 2 UX |

**核心判断（拍板）：两者不是竞争，是有依赖顺序的接力。** 06-22 提供「怎么衡量 agent 好不好」的尺子（eval 网）+ memory/skill 业务内核；chat-panel 提供「用什么视图层 + 编排引擎承载」。**先用 06-22 把尺子和内核做扎实（别在注定被删的旧 UI 上做 Phase 2 精装修），再用 chat-panel 换引擎，并用那把尺子保证换引擎零回退。**

---

## P0→P4 有序门控（master spine）

```txt
P0 止血 ✅ ── P1 eval 固化 ✅ ──┬─ P2 内核(memory+skill) ──┐
                               └─ P3 重定向决策 ───────────┴─ P4 换引擎(chat-panel 00→06)
```

| 阶段 | 内容 | 细节权威 | 状态 |
|---|---|---|---|
| **P0** | 止血：Phase 1 侧分支合 main + push 积压 | 本 README + roadmap | ✅ v0.14.0 |
| **P1** | eval 网固化为 git-tracked [`tests/agent_eval/`](../../../tests/agent_eval/) | `tests/agent_eval/schema.md` | ✅ v0.14.0 |
| **P2** | 内核：memory provenance/冲突 + skill 透明 + cross-domain（**view-agnostic**） | `.trellis/tasks/06-22-harness-agent-polish/roadmap.md` Phase 3/4 | ✅ 完成：P2a `7c93c3be` + P2b `19b3f381` + P2c `ef9115d8` + P2d `c9e0b8c5`（eval 36/29↑23 零回退；code-reviewer APPROVE） |
| **P3** | 重定向：冻结 06-22 Phase 2 UX，诉求并入 chat-panel assistant-ui | 本 README + chat-panel | ✅ 文档落地：chat-panel phase-01 §8 + phase-04 §12 映射表 / 06-22 Phase 2 superseded 指针 + fix-now 清单 |
| **P4** | 换引擎：assistant-ui + AI SDK Gateway，**每 phase 跑通 eval baseline 不回退** | [`../chat-panel-ai-sdk-assistant-ui-refactor/`](../chat-panel-ai-sdk-assistant-ui-refactor/) | ◐ **00 spike ✅ GO** + **01 Shell ✅**（`b82ee24e`）+ **02 AI SDK Gateway ✅**（`a6d189ac`）+ **03a read tools ✅**（vitest 1756、eval 85）+ **03b write tools + HITL approval ✅**（2026-06-24，`ae268c67`，flag-off，5 写工具 + needsApproval 两调 + 两层 guard[ai@6 签名 + domain ApprovalGuard] + R5 recorder 重对齐、vitest 1786、eval 87、reviewer APPROVE）+ **04a A2UI 富工具卡片 + edit→re-approve ✅**（`09424fd4`，flag-off，ComponentRegistry + 富卡片 + 域内 re-approve 侧信道 + ui_payload_json[v11]、vitest 1828、eval 88、reviewer APPROVE）+ **04b 高风险外发 email_prepare_send + 双 guard ✅**（`66d1b489`，flag-off `MAILAGENT_AI_SDK_SEND_TOOL`：blocking send 双 guard〔gateway consume+hash↔Python 签名+SendLedger〕、CHAT_DB_VERSION 12、vitest 1856、eval 89、compare 29==29、真发 dogfood 落 Sent、reviewer APPROVE 9 不变式）+ **05 AG-UI mirror ✅**（`7ddd09a0`）+ **06-parity 生产 parity ✅**（`b758d25f`：standing-context + 会话重载）+ **06a cutover A–G ✅**（2026-06-25，全 dark：chat_db v13/master flag/急切会话/per-session 路由/健康降级/CORS/backfill；opus reviewer 抓修 1 CRITICAL `3fbafede`；vitest 1960、eval 89）；**🔴 剩 06 H = 翻 master 默认，gate 在 dogfood → 06b 7 天观察窗删 legacy** |

**门控铁律**：P1 回归网（`tests/agent_eval`）不绿，P2 不改 prompt、P4 不换引擎。其它不变量见 [`roadmap.md`](./roadmap.md)（单 loop / 业务权威在 Python / 安全底线 / view-agnostic）。

---

## 文档地图

| 文档 | 用途 |
|---|---|
| [`prd.md`](./prd.md) | 权威 PRD：五步→五阶段映射、依赖门控、版本切分、开放决策 |
| [`roadmap.md`](./roadmap.md) | 执行脊柱：每阶段范围/出口门控/PR拆分/回滚 + 不变量 |
| [`goal-prompts.md`](./goal-prompts.md) | **P1-P4 可粘贴 `/goal` session 启动手册**（下一 session 从这里取 **P4-Phase06b（H flip + dogfood → 归档 legacy harness）**；05/06-parity/06a ✅ 已折叠） |
| [`../chat-panel-ai-sdk-assistant-ui-refactor/`](../chat-panel-ai-sdk-assistant-ui-refactor/) | P4 换引擎权威（prd/architecture/roadmap/phase-00~06/acceptance） |
| [`tests/agent_eval/schema.md`](../../../tests/agent_eval/schema.md) | P1 回归网规格（schema v1.2 + hard rules R1-R8） |
| `.trellis/tasks/06-22-harness-agent-polish/roadmap.md` | P2 内核细节（Phase 3 memory / Phase 4 skill·cross-domain）—— **本地 Trellis 任务** |

---

## 发布记录

- **v0.14.0**（2026-06-23）：P0 止血 + P1 eval 固化 + 既有 Phase -1/0A 能力地基 + Phase 1 grounding + MIME/email-detail bug 修复。真机装机验收全绿（ABI/后端/serve-api）。
- 版本切分：P2 = v0.14.x/v0.15；P4 换引擎 = v0.15→v1.0 分多 release。
