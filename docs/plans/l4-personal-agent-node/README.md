# L4 个人 Agent 节点：MailAgent 中期规划（v2，2026-08-18）

> 状态：**规划定稿，进入实施**（trellis epic task `08-17-l4-agent-epic-agent-notion`；每个实施批另建独立 task，本 epic 是索引）
> 形成过程：2026-08-17/18 头脑风暴 session（owner 愿景 + 7 份 Opus 5 调研，档案见 [research/](./research/)，所有「据调研」论断可溯源到 URL）。
> v2 修订（2026-08-18）：吸收 owner 的 **work-first 架构原则** + 调研档案 05/06 的机制修正 + 三项拍板（契约挂行动项层 / 例外队列=回顾面 / 接线批先行）。
> 本文档是这条主线的 **SSoT**。

---

## 1. 愿景与定位

### 1.1 一句话

**MailAgent 不做团队平台，做「agent 联邦时代的个人邮件客户端」——个人主权 agent 节点：工作对象（事项/行动项）是第一对象，agent 与人同为执行者；私有上下文 + 本地凭证 + 信任台账在本机，团队面借既有协作面（飞书/Notion）；常规工作由 agent 在边界内自主处理，人只管例外和核心决策。**

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
│  邮件 · 日历 · 事项/行动项 · 通讯录 · agents      │
│  私有 context / 本地凭证 / HITL 信任台账          │
└──────────────────────────────────────────────┘
```

### 1.3 架构原则：work-first（v2 新增，owner 2026-08-18 拍板）

agent-first（先找 agent、开对话、派任务）是 chat 形态的延续，人仍是驱动者 = L3。L4 的基石是 **work-first**：

1. **第一对象是工作对象**（matter 事项 + matter_item 行动项），不是 agent 名册也不是对话。信任、流程、SOP、审计都长在工作对象上。旁证：Linear/Jira 的 agent-assignee 是赛道落地最快的形态；Inbox Zero 把信任绑到「规则」上；LobeHub（agent-first 顶配）也在长 Task/GTD 对象；AAMP 协议词表是 task.* 不是 chat.*（档案 02/04/05/06）。
2. **工作侧契约统一，执行侧可插拔**：每件可执行工作暴露同一契约——派发 / 接单确认 / 过程可见（thought/action）/ 反问（elicitation）/ 交付（result）。契约背后可以是一个 agent+skill（现阶段大多数够用）、编排 agent 拆派、**或一个人**——工作对象不关心。multi-agent 是 per-事项类别的执行策略选择，不用现在下注。
3. **契约挂行动项层**（🔴 拍板 D4）：matter_item 升格为**有状态机的一等对象**（可派发最小单元）；matter 是行动项的容器与上下文；编排 agent 的职责 = 管理本事项的行动项队列。
4. **双车道防官僚化**：ad-hoc 车道（chat，即抛，不产生 work 对象）+ work 车道（事项/行动项），中间留廉价升格动作。不强行把 chat 塞进 work，也不让 work 退化回 chat。
5. **agent 的正确位置 = 有身份的执行器**：身份保留三个作用——问责审计（"authorization does not erase authorship"）、信任账本单位（采纳率按 agent×动作类记）、能力打包（policy bundle）。Agents 页降为执行器配置面。

### 1.4 已拍板决策

| # | 决策 | 依据 |
|---|---|---|
| D1 | 不另起「Claude Tag + Slack」式多人平台 | 档案 04 §6：赛道已被打完，采用率证据压倒性偏向寄生既有协作面 |
| D2 | 不做多人共享 agent | 入场券是 org 权限/审计/SSO；差异化 = 私有 context + 本地凭证 + 个人所有权 |
| D3 | 协议押形状不押实现 | 「异步任务式协作」intent 状态机是四家独立收敛的公共形状 |
| D4 | **执行契约挂行动项（matter_item/run）层** | owner 2026-08-18；行动项升格一等对象，事项内多行动项可并行派不同执行器 |
| D5 | **例外队列 = 回顾面，不是审批队列** | Inbox Zero 废弃 per-email 审批的学费（档案 06 §1）；闸门在能力/规则授予时点一次，执行层用草稿降级 + 影子信任分 |
| D6 | **批次顺序：接线批先行** | 证据最硬（本仓死枚举/注释实证）、与 work-first 修订正交 |

### 1.5 北极星指标

**每天需要 owner 亲自做的决定数，随 agent 能力增强单调下降。** 配套观测：例外面条目终态率、提案采纳率（per 事项类别 × 动作类 × agent）、撤销率。队列越审越长 = 分级是假的。

---

## 2. 现状资产盘点

| 资产 | 状态 | 在本规划中的角色 |
|---|---|---|
| 邮件全链路（IMAP/SMTP/thread/FTS） | 生产 | 证据流 + 未来 AAMP 传输层 |
| 日历（CalDAV → SQLite SSoT + P7 triggers） | 生产 | 三角一边；**与事项零接线（批次 1 主修）** |
| Matters（提案式跟进 agent + 拒绝记忆 + 干系人 + matter_item） | 生产 | **核心工作对象**；matter_item 将升格一等对象（D4） |
| 通讯录（email 锚点 + L0/L1 扫描） | 灰度 | 缺日历与会者源（批次 1 补） |
| Custom agents（trigger/预算/run 台账/审批档） | 生产 | 执行器 + 信任引擎原料 |
| `custom_agent_call`（父子委派，manual-only） | 生产 | 编排雏形 |
| 飞书 IM 场地（长连接 + 按钮审批 + 绑定码） | 生产 | 团队面第一张脸（绑定码 ≈ LobeHub Pairing 档） |
| Notion（镜像 + notion_agent 工具 + 直连 MCP） | 生产 | 组织知识面通道 |
| Skills（P8 creator + trust-by-hash + P9 plugins） | 生产 | SOP-as-skill 基建（供应链闸是相对 LobeHub 的领先项） |
| chat compact（P3/P4） | 生产 | dreaming 记忆沉淀的现成钩子位 |

**本仓已核验的接线缺口**（档案 01 §7）：`src/matters/triggers.py:18` 明写「会议结束」被砍唯一原因 = calendar 与 matter 零接线；`MatterResourceKind.EVENT` 死枚举（无 `event_resource_key()`）；`src/contacts/scanner.py` 不读日历与会者；日历前端零拖拽。

---

## 3. 中期规划（≈ 两个季度，五条 workstream）

> v2 排序：**B 上调为第一优先**（与 A1 接线批并行不冲突——接线批是数据闭环，B 是体验与信任闭环）。

### WS-B 例外面与信任引擎（Level 4 内核，第一优先）

| # | 内容 | 蓝本（可溯源） |
|---|---|---|
| B1 | **例外面最小版（=批次 2）**：run/会话/行动项列表按状态分组，`waitingForHuman` 类状态浮顶；审批卡补 **`edit`（改参数再执行）/ `response`（不批但给文字指导）/ `remember`（记住本决定）** 三个响应维度；例外条目带 `triage.logic`（为什么进队列，一等字段）。**定位 = 回顾面**（D5）：「agent 做了什么 + 我可事后改」，不是「想做什么 + 等点头」 | LobeHub topic 状态分组（05 §4b#2）· agent-inbox 4 布尔×4 响应契约（06 §3）· LobeHub `remember`（05 §5） |
| B2 | **站会仪式**：每日批处理审批会——编排面出议程（昨日 digest / 待拍板项 / 计划可否决），纪要落 matter。例外面的时间形态；digest 与队列严格分离 | 审批批处理（03 §5.2）· Pulse vs Queue 不可混（03 §4.4） |
| B3 | **信任引擎**：绑定单位 = **事项类别 × 动作类**。影子分 = DraftSendLog 形状（AI 草稿 vs 用户实发算相似度，零用户操作）；隐式投票 = ClassificationFeedback 形状（手动改标签/状态 = 对某规则在某对象上的一票）；账本 = Expertise 形状（命中 pass/violation + 用户 agree/reject + 用进废退 + **成熟后单向编译成机器可跑的验收判据**，"不适用不产生命中、误报由 reject 承担"）；**升档提议**：「这类最近 N 次你只改了 x 次，升自动？」附证据一键升/驳 | Inbox Zero schema（06 §1 机制②③）· LobeHub Expertise（05 §4b#3）· Unit21 per-案型设档（03 §3.1） |
| B4 | **可撤销性分级 + 动态审批**：可撤销本地→自动进 digest / 可撤销外部可见→自动+撤销窗口+事后队列 / 不可撤销→人审且一天几条；**pathScopeAudit 式「只在越界时打断」**（file 工具的目录界、web_fetch 的域名界、compose 的收件人界——界内静默、越界 ask、抽不到判据 fail-closed）；`ask` 档可先过独立判定器（对 agent 自述致盲） | LobeHub interventionAudit（05 §4b#1）· Claude Code auto mode（03 §3.3）· 读回校验（03 §5） |

### WS-A 事项-日历-agent 闭环（数据闭环 + 执行契约）

| # | 内容 | 蓝本 |
|---|---|---|
| A1 | **接线批（=批次 1，先行）**：详见 §4 | 档案 01 §8 |
| A2 | **行动项执行契约（=批次 3，架构中心）**：matter_item 升格有状态机的一等对象（D4）；契约 = 派发/接单 ack/过程 activity（thought/action）/反问 elicitation/交付 result；**委派 ≠ 转移责任**（owner 恒为负责人，agent 是 delegate）；elicitation 进例外面；执行器可以是 agent 或人。Notion database+agent 调研（档案 07，进行中）到货后补充状态流转与可观测性设计 | Linear AgentSession（04 §2）· AAMP intents（04 §5）· agent-inbox 契约（06 §3） |
| A3 | **事项编排者**：跟进 agent 升格为本事项的 orchestrator（管理行动项队列）；`custom_agent_call` 放开 headless，配小脑 triage 闸（判据取 DB 事实非措辞，底压确定性地板）+ hold-token 律（任何免卡旁路必须是对服务端已展示状态的确认，绑 seq/短 TTL/turn 死）+ 形状对偶回归基准 | cumora 协调纪律（02 §5）· Anthropic orchestrator-worker（02 §6） |
| A4 | **SOP-as-skill**：事项类别 ↔ SOP skill 绑定；run 后 agent 可提议 SOP 修订（走 P8 trust + 人审 + 可回滚；⚠️ memory/SOP 文件会自我投毒，恒人审） | cumora T6（02 §2.8）· P8 trust-by-hash |
| A5 | **预约链接**：照抄 Inbox Zero 四表极简 schema（weekday+分钟整数避 DST / cancelTokenHash 无账号取消 / idempotencyToken 防重），不看 cal.diy（官方自认非生产用） | 档案 06 §1 机制④ |

### WS-C 飞书联动（团队面）

| # | 内容 | 蓝本 |
|---|---|---|
| C1 | **群场地**：agent 可被群里同事 @；同事派活 → owner HITL → agent 交付回群。权限照搬四件套：**DM Policy 四档（Open/Allowlist 空名单 fail-closed/Pairing/Disabled）× Group Policy 三档独立** + 防自锁（owner ID 隐式信任）+ 带备注白名单 | LobeHub channels（05 §4b#4）。前置：owner 小部门切飞书落地 |
| C2 | **任务进出 + 按用途分路**：飞书消息一键转行动项/matter 提案；结果回投走 `purpose` 分路（通知/简报/digest/跟进分频道，防刷屏） | Inbox Zero MessagingRoute（06 §1 机制④） |
| C3 | 持续观察 aily 与 AAMP 生态，保持接口对齐 | 档案 04 §3 |

### WS-D Notion 联动（组织知识面）

| # | 内容 |
|---|---|
| D1 | **Notion 页面作为 matter 资料**：资源 kind 扩展，跟进 agent 经既有 Notion 直连 connector 读取（per-tool 档准入语义不动） |
| D2 | **交付物出海**：报告/matter 摘要一键发布 Notion（经审批，outbound 语义） |
| D3 | Notion 知识库作为 agent 参考上下文一等来源（`context_source` 机制推广） |
| D4' | （待档案 07）「MailAgent 行动项 ↔ Notion database 任务」对接形态评估（镜像/单向投影/互链） |

### WS-E 协议押注（低成本、显式 gate）

| # | 内容 | Gate |
|---|---|---|
| E0 | **最小证伪实验**：两个 MailAgent 实例之间跑通一次 agent-to-agent 邮件握手（`X-AAMP-*` 头 + dispatch/ack/result 三 intent），并写清「为什么不是 MCP over email」的回答 | 先于任何协议规范投入 |
| E1 | AAMP 节点：10 intent 状态机接行动项契约（dispatch 进行动项、result 从行动项出），传输复用既有 SMTP 链路 | 双 gate：A2 落地 + E0 通过 + AAMP 生态存活复查 |

### 搭车小批（随发版可插的纯增量）

- **dreaming 挂 compact**：P3/P4 compact 的 onFinish 上挂一次记忆沉淀（现在只压缩不沉淀）——Letta 蓝本，近零成本接线点（06 §2）。
- **记忆 gatekeeper 前置门**：一次便宜调用判「要不要抽、抽哪层」，恒定付费变按需付费（05 §4b#5）。
- **provider 小缺口**：`checkModel` per-provider 连通自检、per-model pricing 配成本 roll-up（05 §5）。
- 长期观察：MemFS 文件树代替固定 5 层记忆（层不够时 agent 自己开目录、树在 prompt 里当路标）。

### 里程碑

- **M1（≈4-6 周）**：批次 1 接线批 → 三角数据闭环。
- **M2（≈季度末）**：批次 2 例外面最小版 + A2 契约设计定稿（含档案 07 输入）+ D1。
- **M3（次季度）**：A2 落地 + B3 信任引擎第一版（影子分 + 采纳率观测）+ C1 群场地。
- **M4（次季度末）**：B4 动态审批 + A3 编排 + E0 证伪实验。

---

## 4. 短期排期

### 批次 1「接线批」（≈4-6 周，先行——D6）

全部有本仓硬证据、互相独立可并行、无大 DB 改动。

| # | 任务 | 量级 | 关键点 |
|---|---|---|---|
| 1 | `event_resource_key()` 接活 `MatterResourceKind.EVENT` | 小 | 插座已预留（models.py:56）；镜像 email/thread identity 形状；资源 kind 词表纳入死列闸 |
| 2 | `calendar_event_ended` trigger | 小 | 复用 P7 基建；triggers.py:18 明说设计想要；依赖 #1 |
| 3 | event → matter 自动关联提案 | 中 | attendees → `matter_contact` → open matter；走 `resource_proposal` + 拒绝记忆，**不自动写** |
| 4 | contacts 第三源：日历与会者 + meeting_count/last_met/next_meeting | 中 | qali people.score 形状；🔴 独立节拍，绝不挂 5s radar poll |
| 5 | 日历拖拽改期/改时长 | 中 | 🔴 只抄参数不抄代码（qali AGPL）：4px 阈值/15min 吸附/Escape 取消/10s 乐观 override；接 `calendar-undo` |
| 6 | 审批卡 preview 服务端化 | 小 | 卡片文案由服务端从真实 payload 生成，非模型自述 |

**批次红线**：不做静默自动排程；agent 不代发对外通信；不做对等 agent 群聊。

### 批次 2「例外面最小版」（B1，D5 定位）
列表按状态分组 + waitingForHuman 浮顶 + 审批卡 edit/response/remember + triage.logic 字段。

### 批次 3「行动项执行契约」（A2，D4 挂层）
matter_item 状态机一等对象 + 五段契约 + delegate-not-assignee；设计输入含档案 07。

---

## 5. 风险与红线

| 风险 | 处置 |
|---|---|
| 🔴 qali AGPL-3.0 / **LobeHub Community License 禁衍生分发** | 两家都**只抄思路/参数/设计，不抄代码**；任何"照文件写"需 owner 知情决策 |
| 🔴 **Inbox Zero 正面竞品**（12k★、周 100+ commits、2026-08-16 发桌面版） | 不追功能清单；差异化钉死 local-first / Exchange(davmail) / Matters 语义对象 / 主权 |
| AAMP 极早期（~117★） | E0 证伪实验前置；押形状不押协议，intent 状态机可迁移 |
| cumora 安全模型对立（零 HITL） | 只搬机制纪律（hold-token/小脑闸/prompt 极简/统计判据测试），不搬架构 |
| 审批疲劳反噬（93% 批准率教训） | D5 回顾面定位；北极星指标守门；影子分代替逐项点头 |
| 自动化翻车（Replit/Gemini CLI 案例） | 读回校验、可撤销性分级、对外通信恒人审、判定器对 agent 自述致盲 |
| SOP/memory 自我投毒（cumora T6） | SOP 修订恒人审 + 版本可回滚 |
| 多 agent 成本（15x token） | 小脑闸前置；编排仅用于低耦合事项；per-类别执行策略 |
| 不抄的清单 | LobeHub 假 off（禁用仍注册）/ headless skip-not-block / always 档（=已退役的 BYPASS_STILL_ASK）；Twenty 式通用元模型（域集成只对固定对象生效的教训） |

## 6. 调研档案索引

| 档案 | 内容 | 支撑 |
|---|---|---|
| [01 qali + 日程↔事项融合](./research/01-qali-calendar-and-schedule-matter-fusion.md) | qali 全量（AGPL 警示）、融合模式（二次核实版）、本仓接线缺口证据 | 批次 1、A1、红线 |
| [02 cumora + 编排原语横评](./research/02-cumora-and-multiagent-orchestration.md) | 协调机制/踩坑实录、11 家编排对照、多 agent 何时不值得 | A3、D3、红线 |
| [03 AI as the System 产品地图](./research/03-ai-as-the-system-l4-product-map.md) | Notion Mail 死法、信任阶梯、审批疲劳、例外队列形态、翻车兜底 | WS-B、北极星 |
| [04 团队平台赛道 + 联邦形态](./research/04-team-agent-platforms-and-federation.md) | Claude Tag/Linear/aily/Buzz/AAMP、「个人节点」定位论证 | D1-D3、WS-C/E |
| [05 LobeHub/lobe-chat](./research/05-lobehub-lobe-chat.md) | fork 零 delta；license 禁衍生分发；pathScopeAudit/状态分组/Expertise/IM 矩阵/gatekeeper | B1/B3/B4、C1、搭车批 |
| [06 邻接开源版图](./research/06-oss-adjacent-landscape.md) | 11 项目三选一；Inbox Zero 学费与竞品警觉；Letta MemFS；booking 四表；agent-inbox 契约 | D5、B3、A5、E0 |
| 07 Notion database+agent（进行中） | db 任务 + agent 认领/状态流转/权限/SOP/可观测性 | A2、WS-D4' |
