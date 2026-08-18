# L4 个人 Agent 节点：MailAgent 中期规划（2026-08）

> 状态：**规划中**（trellis task `08-17-l4-agent-epic-agent-notion`，planning）
> 形成过程：2026-08-17 头脑风暴 session（owner + 4 份 Opus 5 调研）。调研档案见 [research/](./research/)，规划中所有「据调研」的论断都可在档案里溯源到 URL。
> 本文档是这条主线的 **SSoT**；分批实施时每批建独立 trellis task 引用本文档。

---

## 1. 愿景与定位

### 1.1 一句话

**MailAgent 不做团队平台，做「agent 联邦时代的个人邮件客户端」——个人主权 agent 节点：私有上下文 + 本地凭证 + 信任台账在本机，团队面借既有协作面（飞书/Notion），常规工作由 agent 在边界内自主处理，人只管例外和核心决策。**

### 1.2 三层结构（战略地图）

```
┌─ 协议层（观察 + 低成本押注）────────────────────┐
│  AAMP（mailbox-native，飞书开源）· ACP · A2A      │
│  押「异步任务式人机协作」的形状，不押具体协议      │
├─ 团队面（借用，不自建）─────────────────────────┤
│  飞书 = 消息协作 + agent 的团队脸面（小部门切换）  │
│  Notion = 组织知识库（现状即在用）                │
│  Teams = 明确出范围（现状过渡用，不投入）          │
├─ 个人节点（MailAgent 本体，全部投入在这层）───────┤
│  邮件 · 日历 · 事项 · 通讯录 · custom agents      │
│  私有 context / 本地凭证 / HITL 信任台账          │
└──────────────────────────────────────────────┘
```

### 1.3 已拍板的三条战略决策（依据见 [research/04](./research/04-team-agent-platforms-and-federation.md) §6）

1. **不另起「Claude Tag + Slack」式多人平台。** 该格 2026 上半年已被打完（Claude Tag、飞书 aily、Jira/Linear agent-assignee、OpenAI workspace agents）；采用率证据压倒性偏向「寄生既有协作面」；单人开发者的成本结构与「说服组织换协作习惯」的战场都不可行。
2. **不做「多人共享 agent」。** 入场券是组织级权限/审计/SSO，拼不过平台。差异化 = **私有 context + 本地凭证 + 个人所有权**——那是平台结构上做不了的那一半。
3. **协议押形状不押实现。** 「异步任务式协作」的 intent 状态机（dispatch/ack/help_needed/result）是四家独立实现（AAMP/Linear/Buzz/Claude Tag）收敛出的公共形状；先在 MailAgent 内部把这个形状做出来（Matter AgentSession 语义），传输层（AAMP or 其他）后置决定。

### 1.4 北极星指标

**每天需要 owner 亲自做的决定数，必须随 agent 能力增强而单调下降。** 配套观测：例外队列长度与终态率、提案采纳率（per agent / per 动作类）、撤销率。队列越审越长 = 分级是假的（[research/03](./research/03-ai-as-the-system-l4-product-map.md) §6）。

---

## 2. 现状资产盘点（规划的起点）

| 资产 | 状态 | 在本规划中的角色 |
|---|---|---|
| 邮件全链路（IMAP/SMTP/thread/FTS） | 生产 | 个人节点的证据流 + 未来 AAMP 的传输层 |
| 日历（CalDAV → SQLite SSoT + P7 triggers） | 生产 | 三角的一边；**与事项零接线（本 epic 主修）** |
| Matters（提案式跟进 agent + 拒绝记忆 + 干系人） | 生产（v2.10+） | **核心对象**：例外队列雏形 + 未来 AgentSession 载体 |
| 通讯录（email 锚点 + L0/L1 扫描） | 灰度 | 缺日历与会者源（本 epic 补） |
| Custom agents（trigger/预算/run 台账/HITL 审批档） | 生产 | 信任引擎的原料全在台账里 |
| `custom_agent_call`（父子委派，manual-only） | 生产 | 编排的雏形 |
| 飞书 IM 场地（`im_chat` 长连接 + 按钮审批） | 生产 | 团队面的第一张脸 |
| Notion（镜像 + notion_agent 工具 + 直连 MCP connector） | 生产 | 组织知识面的既有通道 |
| Skills（P8 creator + trust-by-hash + P9 plugins） | 生产 | SOP-as-skill 的基建 |

**本仓已核验的接线缺口**（[research/01](./research/01-qali-calendar-and-schedule-matter-fusion.md) §7）：
- `src/matters/triggers.py:18` 明写「会议结束」触发器被砍唯一原因 = calendar 与 matter 零接线
- `MatterResourceKind.EVENT` 死枚举（无 `event_resource_key()`，全仓零引用）
- `src/contacts/scanner.py` 不读日历与会者
- 日历前端零拖拽

---

## 3. 中期规划（≈ 两个季度，五条 workstream）

> 排序原则：**先接线（数据闭环）→ 再首屏（体验闭环）→ 再信任引擎（自主度闭环）→ 编排与联邦后置**。每条 workstream 内部按依赖排序；跨 workstream 可并行。

### WS-A 事项-日历-agent 闭环（三角接线 + 编排语义）

| # | 内容 | 量级 | 依据 |
|---|---|---|---|
| A1 | **接线批**（详见 §4 短期排期） | 1 批 | research/01 §8 |
| A2 | **Matter AgentSession 语义**：委派给 agent 时 owner 仍是负责人、agent 是 delegate；agent 工作过程以 `thought/action/response/elicitation` 四型 activity 落事项时间线；elicitation（agent 反问）进例外队列。照 Linear 的形状（research/04 §2），**与任何协议无关、单人体验先受益** | 大 | research/04 §6(c) |
| A3 | **Matter 编排者**：跟进 agent 升格为该事项的 orchestrator，`custom_agent_call` 放开到 headless（配小脑 triage 闸压成本 + hold-token 律重审免卡路径 + 形状对偶回归基准） | 大 | research/02 §5/§6 |
| A4 | **SOP-as-skill**：matter class ↔ SOP skill 绑定；run 结束后 agent 可提议 SOP 修订（走 P8 trust + 人审 + 可回滚；⚠️ cumora 教训：memory/SOP 文件会自我投毒，必须人审） | 中 | research/02 §5⑤ |

### WS-B 分诊台与信任引擎（Level 4 内核）

| # | 内容 | 量级 | 依据 |
|---|---|---|---|
| B1 | **统一例外队列首屏**：三栏有终态（需要你 / AI 已做完待抽查 / AI 建议），收敛审批卡、matter 提案、attention、elicitation；**digest 与队列严格分离**（Pulse 型可不读，队列型必须有终态）。先出设计稿再动手 | 大 | research/03 §4/§6 |
| B2 | **站会仪式**：每日一次的批处理审批会——编排 agent 出议程（昨日 digest / 待拍板项 / 计划可否决），会议纪要落 matter。队列的时间形态 | 中 | 头脑风暴 + research/03 §5.2「审批批处理」 |
| B3 | **信任引擎**：影子模式（新 agent/新规则先对历史数据假跑出对账单）→ 持续抽样审计（固定比例 + 100% 异常）→ **数据驱动升档提议**（"最近 N 次你只改了 x 次，升 auto？"附证据一键升/驳）。原料 = run 台账 + 审批记录 + 提案采纳记录 | 大 | research/03 §3.1/§6 |
| B4 | **可撤销性分级 + ask 档分类器守门**：可撤销本地→自动进 digest / 可撤销外部可见→自动+撤销窗口+事后队列 / 不可撤销→人审；`ask` 先过独立判定器（对 agent 自述致盲，Claude Code auto mode 模式），拿不准才真弹卡 | 大 | research/03 §3.3/§6 |

### WS-C 飞书联动（团队面）

| # | 内容 | 量级 | 说明 |
|---|---|---|---|
| C1 | **群场地**：agent 可被群里同事 @（从 owner 私聊扩到群聊）；同事派活 → owner 的 HITL 审批 → agent 交付回群。安全模型：群消息恒 untrusted、工具面沿用 `im_chat` 第四态矩阵、owner 是唯一审批人 | 大 | 前置：owner 小部门切飞书落地 |
| C2 | **任务进出**：飞书消息/任务一键转 matter 提案（capture 入口）；matter 结果/摘要回投飞书 | 中 | C1 之后 |
| C3 | 持续观察 aily 与 AAMP 生态，保持接口对齐（不做重复建设） | 持续 | research/04 §3 |

### WS-D Notion 联动（组织知识面）

| # | 内容 | 量级 | 说明 |
|---|---|---|---|
| D1 | **Notion 页面作为 matter 资料**：资源 kind 扩展（需先核对现有 resource kind 词表与 `resource_identity` 形状），事项可引用组织知识库页面，跟进 agent 经既有 Notion 直连 connector 读取（per-tool 档准入，`matterVenueAdmitsEntry` 语义不动） | 中 | 组织知识在 Notion 是现状 |
| D2 | **交付物出海**：报告 / matter 摘要一键发布到 Notion（经审批，outbound 语义） | 中 | 复用 notion_agent / 直连 connector |
| D3 | Notion 知识库作为 agent 参考上下文一等来源（`context_source` 机制推广到 matter/custom agent 面） | 中 | 已有机制的推广 |

### WS-E 协议押注（低成本、显式 gate）

| # | 内容 | Gate |
|---|---|---|
| E1 | **AAMP 节点 PoC**：`X-AAMP-*` 头解析/生成 + 10 intent 状态机，dispatch 进 matter、result 从 matter 出；传输层全复用既有 SMTP/JMAP 链路 | **双 gate**：① A2（AgentSession 语义）落地 ② AAMP 生态存活度复查（star/采用/规范演进）。押形状不押协议——状态机可换传输层（[research/04](./research/04-team-agent-platforms-and-federation.md) §5/§6） |

### 里程碑建议

- **M1（≈4-6 周）**：接线批完成（§4）→ 三角数据闭环，会议进事项、事项感知会议。
- **M2（≈季度末）**：A2 AgentSession + B1 例外队列设计稿定稿 + D1 Notion 资料接入。
- **M3（次季度）**：B1 首屏落地 + B3 信任引擎第一版（影子模式 + 采纳率观测）+ C1 群场地。
- **M4（次季度末）**：B4 可撤销性分级 + A3 编排 + E1 gate 复查。

---

## 4. 短期排期（第一批「接线批」，≈4-6 周）

> 全部有本仓硬证据支撑、互相独立可并行、无 DB 大改（除 #3 可能加提案来源字段）。建议作为本 epic 的第一个实施 task 启动。

| # | 任务 | 量级 | 关键点 |
|---|---|---|---|
| 1 | **`event_resource_key()` 接活 `MatterResourceKind.EVENT`**：日历事件可作为资料挂进 matter（详情页可跳转） | 小 | 插座已预留（`models.py:56`）；镜像 email/thread 的 identity 形状；顺带把资源 kind 词表纳入死列闸 |
| 2 | **`calendar_event_ended` trigger**：复用 P7 calendar trigger 基建（无状态扫描 + 幂等键），事件结束态触发跟进 | 小 | `triggers.py:18` 明说设计想要；依赖 #1（触发后要能把事件挂进事项） |
| 3 | **event → matter 自动关联提案**：attendees → `matter_contact` → open matter（按活跃度排序），走既有 `resource_proposal` + 拒绝记忆，**不自动写** | 中 | HubSpot 启发式（research/01 §6.4a）；严守提案式红线 |
| 4 | **contacts 第三源：日历与会者**：scanner 增源 + `meeting_count / last_met / next_meeting`，驱动收件人/与会人补全排序与人物卡 | 中 | qali `people.score` 形状（research/01 §4）；注意 watermark 节拍纪律（🔴 绝不挂 5s radar poll） |
| 5 | **日历拖拽改期/改时长**：4px 拖拽阈值 / 15min 吸附 / Escape 取消 / 10s 乐观 override + 失败回滚，接现成 `calendar-undo` | 中 | 🔴 只抄参数不抄代码（qali AGPL §13 会波及 `mail.chenge.ink/app`，见 research/01 §3.3） |
| 6 | **审批卡 preview 服务端化**：卡片文案由服务端从真实 payload 生成，非模型自述 | 小 | 比 `approval.verify` 拒 raw-changed input 更强一层（research/01 §4.1） |

**明确不做（本批红线）**：Motion 式静默自动排程（核实到的用户实证："把我的一天整个重置了" + 信任崩塌，research/01 §6.2/§6.3）；任何 agent 代发对外通信；对等 agent 群聊。

---

## 5. 风险与红线

| 风险 | 处置 |
|---|---|
| 🔴 qali 是 AGPL-3.0 | 只抄思路/参数，不抄代码；任何"照文件写"需 owner 知情决策（头像引擎先例） |
| AAMP 极早期（~117★），可能死 | E1 双 gate 后置；押形状不押协议，intent 状态机可迁移 |
| cumora 安全模型与本仓对立（零 HITL） | 只搬机制纪律（hold-token / 小脑闸 / prompt 极简律 / 统计判据测试），不搬架构 |
| 审批疲劳反噬（93% 批准率的教训） | B1 队列必须有终态且短；B2 批处理仪式；北极星指标守门 |
| 自动化翻车（Replit/Gemini CLI 案例） | 读回校验、可撤销性分级、对外通信恒人审、分类器对 agent 自述致盲 |
| SOP/memory 自我投毒（cumora T6） | SOP 修订恒人审 + 版本可回滚（P8 trust 机制） |
| 多 agent 成本（15x token） | 小脑 triage 闸前置；编排仅用于低耦合任务（按上下文需求切分，不按工作类型） |

## 6. 调研档案索引

| 档案 | 内容 | 支撑的决策 |
|---|---|---|
| [01 qali + 日程↔事项融合](./research/01-qali-calendar-and-schedule-matter-fusion.md) | qali 全量分析（AGPL 警示）、7 种融合模式、失败模式、本仓接线缺口证据 | §4 接线批、WS-A、红线 |
| [02 cumora + 编排原语横评](./research/02-cumora-and-multiagent-orchestration.md) | cumora 协调机制/踩坑实录、11 家编排方案对照、多 agent 何时不值得的实证 | WS-A3、决策 3、红线 |
| [03 AI as the System 产品地图](./research/03-ai-as-the-system-l4-product-map.md) | Notion Mail 死法、信任阶梯、审批疲劳数据、例外队列形态、翻车案例与兜底 | WS-B 全部、北极星指标 |
| [04 团队平台赛道 + 联邦形态](./research/04-team-agent-platforms-and-federation.md) | Claude Tag/Linear/飞书 aily/Buzz/AAMP 全景、「个人节点」定位论证 | §1 全部战略决策、WS-C/E |
