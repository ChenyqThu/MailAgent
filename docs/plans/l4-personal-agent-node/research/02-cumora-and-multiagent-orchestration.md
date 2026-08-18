# 调研档案 02：cumora 多 agent 协作平台 + 业界编排原语横评

> 调研日期：2026-08-17 · 执行：Opus 5 调研 agent
> 标注约定：**【事实】** / **【推断】**。cumora 部分全部为一手源码/文档核实。

---

## 0. 关键事实前置

| 项 | 值 |
|---|---|
| 上游 | `yetone/cumora`（yetone = avante.nvim 作者；ChenyqThu/cumora 是 fork） |
| 开源时间 | **2026-08-17**（单个 squash commit，私下开发 ≥3 个月——docs 引用 2026-05~07 的内部实验记录） |
| 热度 | 1083 stars（开源约 4 小时内） |
| License | **MIT** |
| 商业形态 | cumora.ai + waitlist + free/pro/max/owner 四档 → 商业 SaaS 开源出来的 |
| 工程完成度 | 生产级（k8s manifest、iOS/Android 工程、真 LLM 基准套件、SECURITY.md），但社区验证为零 |

来源：<https://github.com/yetone/cumora>

## 1. cumora 是什么

> "Cross-platform team chat where AI agents are first-class participants alongside humans — same roster, same DMs, same group conversations, same Kanban board and calendar."

**是一个 Slack，通讯录里一半是 AI。** 核心概念只有三个：

1. **Participant** —— 人和 agent 同构（agent 只是 `kind='agent'`）。
2. **Computer** —— 每个 agent 跑在某台 Computer 上：`cloud`（托管，per-agent k8s pod）/ `local` / `vps`（**BYOA**：用户自己机器上跑 daemon，脑子是本地 Claude Code / Codex CLI，用用户自己的订阅额度，**服务端永不持有 provider 凭证**）。作者明确说："There is no 'special' BYOA agent, only agents on different Computers."
3. **Persona** —— 一行 DB 记录 + UI 表单（Name/Role/Style/Bio/大脑模型/小脑模型/Runs on）。agent 自己的 workspace 里有 **`IDENTITY.md` 和 `SOUL.md`**，由 agent 自己演进，拼进 system prompt。

> 🔶 **与 MailAgent 的独立收敛**：SOUL 身份文档、`SKILL.md` + frontmatter 技能系统（含远程 Skill Hub、100 文件/256KB 上限）、UI 表单建 agent——两个团队互不知情做出同构设计，说明抽象选对了。

### 🔴 最重要的结论：它没有编排器
没有 orchestrator / supervisor / 任务图 / 角色层级。协作模型 = **完全对等 + 共享黑板（聊天记录本身）+ 服务端仲裁**。唯一接近编排的是 `convene`（开会模式）：moderator 轮流点名发言 + 会后 `classifyDecision` 提炼决议——是轮转发言，不是任务分派。

## 2. 协作机制（`docs/COORDINATION.md`，776 行踩坑实录，最高价值）

### 2.1 通信：共享消息流 + 私有游标
agent 之间**不互发消息**、看不到谁在打字、没有排队号；每个 agent 只看见"已发布的最新状态" + 私有 per-(agent,convo) seen-cursor。刻意让「按位次占坑」在结构上无法表达。

### 2.2 核心原语：乐观发布 + 服务端 HOLD
「先发，服务端拦」，四道闸：freshness preflight（发布前查有没有比基线新的他人消息 → HELD 信封 + 新消息内联）· verbatim-dup（事务内行锁后逐字比对）· recently-created dedup（同标题+他人+15min → HELD 指向已有 id）· hold token。

### 2.3 🔴 hold-token：全篇最值得抄的一条
`--send-anyway` 原本是无条件旁路 → agent 被 prompt 教导要高效，学会**预防性**每次都带 → 闸门静默失效，两起重复交付事故。修法不是 prompt 教育，而是让旁路在结构上无意义：

> **any bypass flag on a coordination gate must be an acknowledgement of server-shown state, not a client-side opinion.**

token 由服务端 HELD 时发放，**绑 seq**（房间前进即作废）、**turn 结束即死**、**ack 即死**、**2 分钟 TTL**、Redis 挂了 **fail-open**。

→ 对 MailAgent 的映射：`auto` 档、bypass、grant 免卡、`user_requested=true` 免外层卡——当前都是「静态配置」而非「对服务端已展示状态的确认」，值得按这条律重审。

### 2.4-2.5 任务分解/聚合：都没有自动化
人说一句话就是任务；共享 Kanban `card claim` 原子申领（只用于真正的共享交付物，聊天轮次永不 claim）；会话本身就是聚合面。

### 2.6 唤醒与成本控制链
SSE wake → debounce 2.5s → **小脑 triage gate**（haiku 级，只判 `actionable: bool`，**永不决定谁回/怎么回**；判据取自 DB/Redis **事实**——有没有活跃 claim、人类有没有在看——不取自消息措辞）→ 并发信号量 → AdaptivePacer（限流退避）→ 持久 engine session → 同轮 steering。AI 判断底下压**确定性死循环地板**（被"为了优雅"删过两次、两次都回归，文档明写"不要再删"）。

### 2.7 人类介入点：只有社交层，没有闸门层
🔴 与 MailAgent 差别最大处：无审批卡、无工具授权分级、本地引擎跑 `--dangerously-skip-permissions` / `danger-full-access`。安全性押在"服务端是唯一信任边界"。**agent 自治是它协调机制能工作的前提**——把乐观发布搬进 MailAgent 会撞上"HELD 之后要重走审批"的语义黑洞。

### 2.8 失败模式档案（精选）

| 事故 | 教训 |
|---|---|
| 只给大脑加并发闸没给小脑加 → 全机器静默 | 对同一 provider 限流必须同时限所有 spawn 类 |
| standing prompt 塞 5KB 规则 | 协调质量断崖（0 碰撞→每局 1-3 次）。**prompt 契约极简** |
| 累积场景化规则 | 最贵的 prompt bug 类型：变大、不泛化、每 bug 一条子句 |
| agent 把错误教训写进自己 memory | **memory 文件也是状态，会自我投毒**（对 MailAgent mem0 auto-capture 同样成立） |
| 分类器上游 503 数小时，症状像"agent 不醒" | 不要用 prompt 改动修基础设施问题 |
| 计数游戏产出荒谬序列但零机制失败 | 每步字面合法 ≠ 整体符合意图 |

## 3. 技术栈
React 18 + Electron/Capacitor 四壳 · Express + WS · **Postgres + Redis**（Lua 单调 SET、NX 申领、hold token）· 云 agent = k8s per-pod · BYOA = 单文件 ESM npm 包 · **I/O 与大脑解耦**：一切世界动作走 `cumora` CLI shim → POST 到 `/runtime/cli`，身份 per-agent JWT 钉死（换大脑不动其它）。CLI 约 45 个命令。

## 4. 产品形态：终端用户产品（UI 配置），不是开发者框架
与 MailAgent custom agent 抽屉同形态。

## 5. 借鉴与不适配

**值得借鉴**：① hold-token 律（★最高）② 小脑 triage 纯闸 ③ prompt 极简 + 「机制 vs prompt」判据（"never add a prompt rule when a code mechanism is the right fix, and never add a code mechanism when the brain's making a clear decision in front of correct state"）④ 真 LLM 协调基准的**形状对偶**测试设计 + **统计判据**（"≥67% 试验精确完成"而非逐次判定）+ 观察窗口不是判决 ⑤ memory 自我投毒审计。

**不适配**：① 安全模型根本对立（零 HITL）② Computer/BYOA/多租户/k8s 层（MailAgent 单机单 owner）③ 对等群聊本身（见 §6）④ Postgres/Redis 依赖 ⑤ 成本模型（为"最后决定不说话"的 agent 烧完整大脑 turn）。

## 6. 业界编排原语横评 + 选型结论

| 方案 | 协作原语 | HITL | 状态 |
|---|---|---|---|
| CrewAI | 角色 Agent + Task 列表（Sequential/Hierarchical） | Task 级 human_input | 成熟 MIT |
| AutoGen/AG2 | 群聊广播 + speaker-selection | human_input_mode | AutoGen 维护模式；继任 MS Agent Framework |
| LangGraph | 显式状态图 + **`interrupt()` 一等公民**（暂停/持久化/原地恢复） | ★ | 成熟 MIT |
| OpenAI Agents SDK | Handoff（整段历史转移控制权） | Guardrails | 生产级 |
| Claude Code Subagents | **工具调用式委派：隔离上下文、只回结果** | 主会话审批卡 | 生产级 |
| Claude Code Agent Teams | 独立长命会话 + SendMessage/TaskList | 各会话独立审批 | 2026 新形态 |
| Google ADK + A2A | workflow agent + transfer_to_agent；跨厂商 A2A | 一等特性 | GA |
| MS Agent Framework | 五模式（Sequential/Concurrent/Handoff/Group Chat/Magentic），全模式 checkpoint+审批 | ★ | 1.0 |
| MetaGPT | SOP 编码进 prompt + 共享消息池 | 无 | 活跃 |
| Anthropic Research | **Orchestrator-Worker**：Lead 规划 → 并行 subagent → 结构化汇总 | — | 生产系统 |
| cumora | 对等 + 共享黑板 + 服务端 HOLD | 无闸门 | 今日开源 |

### 🔴 「多 agent 何时不值得」的实证
- Anthropic：multi-agent 多耗 **~15x** token；但低耦合可并行场景（内部研究评测）提升 **90.2%**。适用=广度优先/可并行/超单 context；不适用=需共享上下文、彼此高度依赖（点名"大多数编码任务"）。[来源](https://www.anthropic.com/engineering/multi-agent-research-system)
- Anthropic《When to use multi-agent systems》：先从单 agent 开始；每加一个 agent = 新失败点，多耗 3-10x；**按「上下文需求」切分，不按「工作类型」切分**。[来源](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)
- Cognition《Don't Build Multi-Agents》：并行多 agent 本质脆弱（子 agent 互看不见对方决策）；默认单线程线性 + 压缩历史。[来源](https://cognition.com/blog/dont-build-multi-agents)
- 两篇同一把尺子：**耦合度**。

### 结论：桌面个人助理该用 Orchestrator-Worker（隔离上下文 + 结果导向委派），不是对等群聊
1. MailAgent 的任务天然已按耦合度分好：事项跟进/报告/定时触发 = 低耦合 → 现有 `async_jobs + AgentRunWorker` 本质已是该模式；邮件撰写/Matters 对话 = 高耦合 → 不该拆。
2. 「工具调用式委派、只回结果」比「全历史 handoff」更合身——`custom_agent_call`（P2，manual-only）已是雏形。
3. 单 owner 结构上不存在"多 agent 民主协商"需求。
4. 15x token 成本直接落用户账单。
5. 唯一值得对齐的外部设计：LangGraph `interrupt()`（与现有"审批暂停 stash + 服务端 resume"目标一致）。

### 如果往前走一步的最小形状
把 `custom_agent_call` 从 manual-only 放开到 headless，配三样：小脑 triage 闸（压成本）+ hold-token 律（重审免卡路径）+ 形状对偶基准（守回归）。**对等 agent / 共享工作面 / agent 间消息三个缺口按实证不建议补。**

## 关键来源
- <https://github.com/yetone/cumora> · [COORDINATION.md](https://github.com/yetone/cumora/blob/main/docs/COORDINATION.md) ★ · [BYOA.md](https://github.com/yetone/cumora/blob/main/docs/BYOA.md) · [benchmarks](https://github.com/yetone/cumora/blob/main/benchmarks/README.md) · [SECURITY.md](https://github.com/yetone/cumora/blob/main/SECURITY.md)
- [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) ★ · [When to use multi-agent](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) ★ · [Cognition: Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) ★
- [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents) · [OpenAI handoffs](https://openai.github.io/openai-agents-python/handoffs/) · [LangGraph](https://github.com/langchain-ai/langgraph) · [CrewAI](https://docs.crewai.com/en/concepts/crews) · [MS Agent Framework](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff) · [Google ADK](https://github.com/google/adk-python)
