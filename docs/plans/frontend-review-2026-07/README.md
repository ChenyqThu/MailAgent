# 前端 Review 2026-07 —— findings 台账与收敛方案索引

> 2026-07-07 前端整体 review 的 findings 全台账 + 各专题落地方案的导航。
> review 出的点较多，已分批落地一部分；本目录为**需要设计的结构性专题**陆续开独立方案 doc，供 review 与落地。
>
> 单个专题 = 一份 `.md`。后续开坑：在下方「专题方案 doc 索引」加一行 + 建对应文件。

## 背景

2026-07-07 主 session 编排三个 review subagent，findings 全部由主 session 逐条抽验坐实：

| review lane | 范围 | 产出 |
|---|---|---|
| `fe-review` | 整体实现（性能 / 架构 / 可维护性 / 健壮性 / 文档） | P0-P3 分级 findings |
| `uilib-eval` | 组件库现状与走向 | 结论：不切换 shadcn CLI、不改 token；建议无排期 |
| `i18n-audit` | i18n 完整性 | 缺失 key / 硬编码中文清单 |

owner 拍板分批落地：**第一批**（快赢 + 审批卡/Settings i18n + 巨文件拆分，task `07-07-review-i18n`）✅；**第二批**（invalidate 分层 + 围栏单源化 + 面板级错误恢复，task `07-07-review-invalidate-errorboundary`）✅ 已合 main；剩余"需要设计"的项陆续在本目录开方案。

## 完整 findings 台账

状态图例：✅ 已落地 · 🔲 待排期/待决定 · 📝 记录不做 · ❓ 待确认

| 编号 | 角度 | 问题 | 状态 | 去向 |
|---|---|---|---|---|
| P0 | — | （无阻塞级 findings——review 未发现崩溃/数据丢失/安全 P0） | — | — |
| **P1-1** | 性能 | EmailRow memo 打穿（onSelect 每渲染新建闭包 → memo 失效） | ✅ | 第一批 `647180e3` |
| **P1-2** | 性能/架构 | invalidate key 分层（`['emails']` 全前缀扇出 5 族） | ✅ | 第二批 `628c322b` |
| **P1-3** | 可维护性 | 三个巨文件拆分（AgentsTab / CustomAgentDrawer / CustomAiSection） | ✅ | 第一批 `7dbc/5f70/c9d3` |
| **P1-4** | 可维护性 | EmailList 1900 行拆分（列表+线程+5 useQuery+虚拟化+键盘+拖拽，状态耦合密） | 🔲 | 未排期（风险高于 S4-S6，需设计） |
| **P2-1** | i18n | 4 处列表硬编码 | ✅ | 第一批 |
| **P2-2** | 文档 | ARCHITECTURE.md §7.1 行高铁律漂移 | ✅ | 第一批 |
| **P2-3** | a11y | EmailRow 嵌套 interactive 的 ARIA 语义重构（interactive descendants） | 📝 | 已从 review 原始记录确认编号归属（fe-review 交付原文）；= 第二批 PRD 记录项"EmailRow ARIA interactive descendants 语义重构"，需交互设计配合，记录不排期 |
| **P2-4** | 健壮性 | deleteSession fire-and-forget 无错误处理 | ✅ | 第一批 |
| **P2-5** | 性能 | 恒等 useMemo（`useMemo(()=>orderedIds,[orderedIds])`） | ✅ | 第一批 |
| **P2-6** | 架构 | useEmailChat 1200 行 God Hook（CRUD+流式+乐观+工具事件+SSE 桥） | 🔲 | 未排期（拆 useSessionList/useStreamingRun/useToolEvents） |
| **P2-7** | 架构 | IPC 错误处理不统一（各 catch 策略不一，无统一边界） | 🔲 | 未排期（抽 ipcCall wrapper） |
| **P2-8** | 类型 | queryKey 无类型约束（裸字符串数组手拼） | 🔲 | 部分被 P1-2 的 emailInvalidation.ts 覆盖 |
| **P2-9** | 健壮性 | 面板级 ErrorBoundary / 错误恢复能力 | ✅ | 第二批 `de00900a`（ErrorBoundary reset/fallback/resetKeys + chat 三挂载点 ChatPanelBoundary + BlockRenderer 边界）。⚠️ 方案 doc 原"现状坐实"系幻觉，修正见 [`errorboundary-consolidation.md`](./errorboundary-consolidation.md) §0 |
| **P2-10** | 安全 | mention 围栏单源化 | ✅ | 第二批 `7607b6cb` |
| **P3-1** | 动效 | GSAP 动效散落无中央 motion token | 📝 | 记录，大概率不做 |
| **P3-2** | 性能 | EmailDetail/ThreadView memo 边界过宽 | 📝 | 记录（收益低、回归中） |

**i18n-audit 专项**：16 双侧缺失 key ✅ · 审批卡 ~10 文件 ✅ · Settings/agents ✅（均第一批）· 5 处 aria-label 英文 🔲记录可缓 · Wave 2 三个遗留（skill pack 术语 / `SendApprovalCard` join 全角标点 / `ApprovalActionCard` a2ui 中文 summary 数据层 i18n）🔲记录

**uilib-eval 专项**：组件库不切换 / 不接 CLI / 不改 token（已否决，无改动）· 裸 `<button>` → `<Button>` 收编 🔲无排期

**明确不做**：ThreadBundle.tsx 预存 dead code（指出不删）· shadcn CLI / token 改名（否决）

## 专题方案 doc 索引

| doc | 对应 finding | 状态 |
|---|---|---|
| [`errorboundary-consolidation.md`](./errorboundary-consolidation.md) | P2-9 | ✅ 已落地 `de00900a`（doc 原"现状坐实"大半为不稳定 session 幻觉，落地按仓库实态修正，见 doc §0） |

> 后续候选开坑：P1-4（EmailList 拆分）、P2-6（useEmailChat God Hook）、P2-7（IPC 错误统一）。

## 两个待确认的空缺（已解决，2026-07-08）

1. **P2-3 编号** ✅ 已确认：翻 2026-07-07 review session 原始记录（fe-review 交付原文），P2-3 = "EmailRow 嵌套 interactive 的 ARIA 语义重构"——即第二批 PRD 记录项里的 ARIA 项，不是跳号。台账已回填。
2. **P0 无列项** ✅ 与 review 结论一致：fe-review 无阻塞级发现（最高 P1），记忆记录同（"fe-review：无 P0"）。

## 约定

- 一个"需要设计"的专题 = 本目录一份 `.md`；快赢/机械项直接进 trellis task 落地，不在此开 doc。
- 每开一个专题 doc：在「专题方案 doc 索引」加一行；落地后在台账更新状态 + commit 号。
- 相关 trellis task：`07-07-review-i18n`（第一批）、`07-07-review-invalidate-errorboundary`（第二批）、`07-08-frontend-review-batch2-placeholder`（剩余项占位）。
