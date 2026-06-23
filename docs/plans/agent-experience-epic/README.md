# Agent 体验大版本专项（Agent Experience Epic）

> status: in_progress（P0 止血 + P1 eval 固化 ✅ 随 v0.14.0 发布；**P2 内核全部 ✅**：P2a provenance/relevance `7c93c3be` + P2b memory auto-capture/冲突 `19b3f381` + P2c skill 透明 `ef9115d8` + P2d cross-domain plan `c9e0b8c5`；**P3 重定向 ✅ 文档落地**（chat-panel phase-01 §8 / phase-04 §12 映射表 + 06-22 superseded 指针 + fix-now 清单）/ **P4 换引擎进行中**：Phase 00 spike ✅ GO（`bc5c1e80`）+ **Phase 01 assistant-ui Shell ✅**（2026-06-23，`b82ee24e`）+ **Phase 02 AI SDK Gateway ✅**（2026-06-24，`a6d189ac`，flag-off，harness 4/4+真实 streamText、UIMessage 持久化 v1 chat_db v9、eval 85≥baseline、reviewer APPROVE）；**Phase 03a read tools 待开工**）
> last-verified: 2026-06-23
> owner: chenyqThu
> Trellis 跟踪任务：`06-23-agent-eval-memory-skill-assistant-ui-ai-sdk`（`.trellis/tasks/`，本地执行壳）
> **本目录是这个大版本的权威 master plan（git-tracked，canonical）。**

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
| **P4** | 换引擎：assistant-ui + AI SDK Gateway，**每 phase 跑通 eval baseline 不回退** | [`../chat-panel-ai-sdk-assistant-ui-refactor/`](../chat-panel-ai-sdk-assistant-ui-refactor/) | ◐ **Phase 00 spike ✅ GO** + **Phase 01 Shell ✅**（`b82ee24e`）+ **Phase 02 AI SDK Gateway ✅**（2026-06-24，`a6d189ac`，flag-off，harness 4/4、UIMessage 持久化 v1 chat_db v9、eval 85≥baseline、reviewer APPROVE）；**Phase 03a read tools 待开工** |

**门控铁律**：P1 回归网（`tests/agent_eval`）不绿，P2 不改 prompt、P4 不换引擎。其它不变量见 [`roadmap.md`](./roadmap.md)（单 loop / 业务权威在 Python / 安全底线 / view-agnostic）。

---

## 文档地图

| 文档 | 用途 |
|---|---|
| [`prd.md`](./prd.md) | 权威 PRD：五步→五阶段映射、依赖门控、版本切分、开放决策 |
| [`roadmap.md`](./roadmap.md) | 执行脊柱：每阶段范围/出口门控/PR拆分/回滚 + 不变量 |
| [`goal-prompts.md`](./goal-prompts.md) | **P1-P4 可粘贴 `/goal` session 启动手册**（下一 session 从这里取 **P4-Phase03a read tools**） |
| [`../chat-panel-ai-sdk-assistant-ui-refactor/`](../chat-panel-ai-sdk-assistant-ui-refactor/) | P4 换引擎权威（prd/architecture/roadmap/phase-00~06/acceptance） |
| [`tests/agent_eval/schema.md`](../../../tests/agent_eval/schema.md) | P1 回归网规格（schema v1.2 + hard rules R1-R8） |
| `.trellis/tasks/06-22-harness-agent-polish/roadmap.md` | P2 内核细节（Phase 3 memory / Phase 4 skill·cross-domain）—— **本地 Trellis 任务** |

---

## 发布记录

- **v0.14.0**（2026-06-23）：P0 止血 + P1 eval 固化 + 既有 Phase -1/0A 能力地基 + Phase 1 grounding + MIME/email-detail bug 修复。真机装机验收全绿（ABI/后端/serve-api）。
- 版本切分：P2 = v0.14.x/v0.15；P4 换引擎 = v0.15→v1.0 分多 release。
