# 调研档案 05：ChenyqThu/lobe-chat fork 与上游 LobeHub

> 调研日期：2026-08-18 · 执行：Opus 5 调研 agent（全部事实来自 `gh api` 实际读取，默认分支 `canary`；访问失败项如实标注于文末）
> 标注约定：**【事实】** / **【推断】**。

---

## 1. Fork delta：纯 fork，零自有改动【事实】

- fork 创建于 **2023-12-18**；只有 `main` 一个分支；与上游 `main` **`identical`（ahead 0 / behind 0）**；`pushed_at` = 2026-08-18（交办同时刻，即刚点过 Sync fork）。
- **【推断】** 2023-12 收藏式 fork（彼时还是纯 chat UI），近期"重新打开看看"，不是持续开发。
- 运维提醒：上游 README 建议 fork 后只保留 upstream sync action、关掉其他 Actions（fork 的 Actions 启用状态未检查）。

## 2. 上游现状【事实】

- **已改名 LobeHub**（`lobehub/lobehub`，lobe-chat 重定向）。README 首句定位 = **"Your Chief Agent Operator"**："organizes your agents into 7×24 operation. It hires, schedules, reports on your entire AI team."——从 chat UI 转型 agent 运营平台。
- 81,782 stars；活跃度极高（2026-08-17 一天 6 个 canary release）；桌面端一等公民（mac/win/linux 全产物，electron-builder 栈与 MailAgent 相同）；monorepo 92 包（33 个 `builtin-tool-*`），5 个 `chat-adapter-*`（feishu/imessage/line/qq/wechat）。

## 3. 🔴 License：LobeHub Community License（Apache 2.0 + 附加条款）【事实】

- 1a：可商用**包括作为前后端服务，只要不修改源码**；1b：**开发并分发衍生作品必须购买商业授权**；2a：producer 可单方调整条款。
- **对 MailAgent 的含义【推断】**：借鉴设计/概念/枚举命名 ✅ 不受限；**抄代码进 MailAgent 并分发桌面包 ⛔ 硬阻断**（= 1b 衍生分发）；整体嵌入 ⛔；不改源码自部署自用 ✅。

## 4. 核心判断

### (a) 换/嵌 lobe-chat 当 chat 面？——否，两条各自独立即足以否决【推断】
① license 1b 直接拦死分发；② 架构哲学正面冲突（Postgres+pgvector+RBAC 多租户 vs SQLite-SSoT 单 owner；两套 HITL 内核无法共存；MailAgent 的 chat 面是邮件/日历/Matters 域能力的投影，不是可插拔外壳；LobeHub 的 chat 面也已不是可拆组件）。成立的用法：**设计参考读物**（首选）或**不改源码独立部署当补充产品**（1a 明确允许）。

### (b) 最值得抄的 5 个机制（按 ROI 排序，均有源码路径）

| # | 设计 | 机制 | 落点 |
|---|---|---|---|
| 1 | **动态审批 `pathScopeAudit`：只在越界时打断** | manifest 声明 `{dynamic:{default:'never', policy:'required', type:'pathScopeAudit'}}`；运行时从入参抽路径，**全部在工作目录内→静默执行；越界→升 required 弹卡；抽不到路径→fail-closed 要审批**（`builtin-tool-local-system/src/interventionAudit.ts`） | 例外式审批的工具层实现：`file_read/write`（目录内静默）、`web_fetch`（域白名单内静默）、compose（收件人在通讯录内 vs 陌生外域）。不放宽地板——越界仍 ask |
| 2 | **Topic 状态即首屏分组** | `status` 枚举含 `waitingForHuman/running/scheduled/failed…` 落列建索引；UI 按 By status / By time / By project / Flat 分组切换（`schemas/topic.ts` + `docs/usage/agent/topic.mdx`）；成本 roll-up 索引列（可空="未测量"防污染 AVG） | **例外队列最省力形态**：不建新页，给会话/run 列表加「按状态分组」，`waitingForHuman` 天然浮顶。MailAgent 已有 9 值 run 状态，缺的只是提为分组维度 |
| 3 | **Expertise「SCLPT」：心得→（成熟后单向编译）→机器可跑的 verify criterion** | 八表：`lessons`(bad/good/rule) → `hits`(pass/violation，"不适用不产生 hit"，误报由 `userDecision='reject'` 承担——枚举复盘原文) → 用进废退 → `compilability`(compiled/compilable/**not-compilable**——"心智模型层永不可编译") → 定时作业产出跨实践 `insights`（`schemas/expertise.ts`，中文注释） | **信任引擎骨架**：MailAgent 的 RULES/user.md 是静态的，没有「哪条规则这次用上了、用户认不认、够不够格毕业成硬闸」的账本 |
| 4 | **IM 场地权限矩阵** | `Allowed Users` 全局门（每行 ID + 仅自看 Note）；**DM 四档 Open/Allowlist(空名单 fail-closed)/Pairing(一次性配对码+`/approve`)/Disabled × Group 三档独立**；`Your Platform User ID` 隐式信任**防自锁**（`docs/usage/channels/overview.mdx`） | 飞书群场地（WS-C1）可直接照搬的四件套；MailAgent 绑定码 ≈ 他们的 Pairing |
| 5 | **记忆 gatekeeper 前置门 + 逐条溯源** | 一次便宜调用产五层各自 `{reasoning, shouldExtract}`，只对为真的层跑专属 extractor；identity 条目带 `sourceIds`（支撑该条的 source message id）+ `scoreConfidence`（`memory-user-memory/`）。🔴 五层 = identity/preference/context/activity/experience，**与 MAILAGENT_MEMORY_LAYERS 五层逐字相同**（独立收敛） | 抽取从「恒定付费」变「按需付费」；`sourceIds` 让白盒记忆可追问（"你凭什么记得我讨厌 X"） |

### 明确不抄的
- `off` = 保留注册但描述改 `[TOOL DISABLED]`（`patchManifestPermissions.ts`）——MailAgent 的「不注册」更安全省 context，**不要抄**。
- `headless` 模式危险工具 "skipped (not blocked)"——MailAgent 装配期不注册（`deny_ask_mode`/`only_auto_tools`）更早更结构化。
- `always` 档（bypass 不可绕）= MailAgent 08-05 已显式退役的 `BYPASS_STILL_ASK`，真实的设计岔路口，但不回头。

## 5. 其他值得记录的点

- **审批响应带 `remember`**（卡上勾"记住这个决定"）——MailAgent 改档要去设置台，这是低摩擦升档入口。
- **Verify 验收闸**：独立无工具评审 agent，三值裁决 + `counterEvidence` + `limitation`（"what you could not verify and why"）+ 必须恰好一次结构化提交——per-task 可开关的验收闸产品化。
- **文档注入声明式**：每份文档自声明 10 位点 × 4 加载规则（ALWAYS/BY_KEYWORDS/BY_REGEXP/BY_TIME_RANGE）× PROGRESSIVE——对照 Standing Context 固定恒注入。
- **Task 系统**：排程折叠进 Task（GTD），subtasks/dependencies(blocked-on)/assignment 到 agent/verification 闸/Max runs——**agent-first 平台也在长 work 对象**。
- **设备节点三段式**：device-identity → `listOnlineDevices` 发现 → `activateDevice` 显式激活才解锁 local-system——「桌面是有身份可发现可激活的节点」。
- **Provider 两个小缺口**：`checkModel`（per-provider 连通性自检模型）、per-model `pricing`（配合 topic 成本 roll-up）。
- **Thread 真树**：`sourceMessageId` 分叉点 + `parentThreadId` 自引用 + continuation/standalone 显式语义 + 每 thread 可绑不同 agent。
- **skill 供应链安全弱于 MailAgent**（装时弹卡+跑脚本弹卡，无 quarantine/hash/TOCTOU/trust 链）——MailAgent 领先项。
- 跨包手抄常量只有注释无闸（`heterogeneous-agents/askUser/constants.ts` 自认 "must be kept in sync"）——MailAgent 的一致性闸体系更强。

## 6. 未能验证【如实记录】
- `lobehub.com` 官网 403：Cloud 定价/credits/云社区差异未验证；市场收录审核流程未验证（"10,000+ Skills" 数字未核实）。
- GitHub code search 中途限流：`enabledSkills`/`riskLevel`/`destructive` 全仓搜索未完成。
- fork 的 Actions 启用状态未检查。

## 引用一览（实际读取）
仓库：`api.github.com/repos/ChenyqThu/lobe-chat` · `api.github.com/repos/lobehub/lobehub` · `/compare/main...ChenyqThu:lobe-chat:main` · `/branches` · `/releases`
文件（`github.com/lobehub/lobehub/blob/canary/<path>`）：`LICENSE` · `README.md` · `docs/glossary.mdx` · `docs/usage/channels/overview.mdx` · `docs/usage/agent/{agent-team,scheduled-task,gtd,sandbox,topic,artifacts,claude-code}.mdx` · `packages/types/src/tool/intervention.ts` · `packages/builtin-tool-local-system/src/{manifest.ts,interventionAudit.ts}` · `packages/builtin-tool-{remote-device,skill-store,skills,verify}/src/` · `packages/memory-user-memory/src/` · `packages/database/src/schemas/{topic.ts,expertise.ts,rag.ts,aiInfra.ts}` · `packages/agent-templates/src/types.ts` · `packages/agent-signal/src/` · `src/libs/mcp/patchManifestPermissions.ts`
访问失败：`lobehub.com/docs/usage/features/skill-store`（HTTP 403）
