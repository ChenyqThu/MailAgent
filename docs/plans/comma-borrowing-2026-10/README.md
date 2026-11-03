# Comma 设计评审 → MailAgent 借鉴清单（2026-10）

> 状态：**评审结论 / 待 owner 拍板**（不是实施方案；每条被采纳后另建 trellis task）。
> 评审对象：[AFK-surf/Comma](https://github.com/AFK-surf/Comma) `main@ddcdcc5`（2026-10-20），
> 只读其 `docs/`（product-features / agent-runtime / tasks-background-execution /
> meetings-calendar / clients / verification / architecture/PRODUCT_MODEL + DOMAIN_CONCEPTS）、
> 内置 `proactive` skill 与 `clients/packages/app` 的组件结构。
> 🔴 **许可证 AGPL-3.0**：与 qali 同纪律——**只借思想、契约形状与参数，不抄代码**。
> 与本仓规划的关系：本文是 [`l4-personal-agent-node`](../l4-personal-agent-node/README.md) 的外部输入，
> 各条已标注落到哪条 workstream；不另起 epic。

---

## 0. TL;DR —— 五条最值得做的

| # | 借鉴点 | 解决本仓什么问题 | 落点 | 量级 |
|---|---|---|---|---|
| 1 | **主动关注管线**：确定性紧急度地板 + 双预算 + `notify/quiet/snooze` 决策留痕 | 飞书推送是逐封静态规则（priority∈{紧急,重要} ∧ action∈6 类），无频控、无「为什么没打扰你」 | WS-B（B1 例外面延伸 / B4 动态审批前置） | 中 |
| 2 | **在场感知路由**（`app_active`）：人在电脑前只走 app 内，离开才走飞书 | 桌面通知与飞书互不知情，人在电脑前也双响 | 通知中心 fanout + 飞书推送 | 小 |
| 3 | **Loop 语义**：`cadence` + `max_runs / ends_at / until`（自然语言停止条件） | custom agent 只有 `max_runs_per_day`，事项跟进触发器无终止条件；「盯这封邮件直到对方回复」表达不了 | WS-A（A2 行动项契约）+ `src/agents/trigger.py` / `src/matters/triggers.py` | 中 |
| 4 | **决策不写模型、投影确定性渲染**的「关注簿」(Notebook) | `/today` 只有「等我处理」，看不到 agent 静默掉的事及理由 | `/today` 新增一组 + 资料库 `agent-docs/` 投影 | 小 |
| 5 | **领域概念台账**（DOMAIN_CONCEPTS）+「投影不是实体」纪律 | notification / matter_attention / today / island / run_log 多套相近概念并存，新增实体无门槛 | E0-E4 收敛路线（architecture-review-2026-07） | 小（文档）|

---

## 1. Comma 是什么（够用的速写）

**定位**：「sessionless, relentless personal agent」。对话只是界面，**Task 才是持久执行态**；Task
被自动转成独立 agent loop（plan → execute → review → verify），直到目标完成。macOS / Web / iOS / Watch
多端，可自托管（docker compose）。

**技术栈**：服务端 Elixir/OTP（每个 agent 一个 BEAM 进程）+ Lean（Session 内核，含证明）+ TLA+
（≤5000 行，只建模系统级核心协议）；客户端 Electron + React 组件库 + 原生 Apple 端；Postgres / Redis /
MinIO / ClickHouse。

**核心概念模型**（`PRODUCT_MODEL.md`）：

```text
Workspace（授权范围 = agent 工作范围）
├─ Router [0..1]   协调者，全 Workspace 唯一 canonical Runtime Session（所有入口汇进同一上下文）
├─ Worker [0..N]   执行者，每个 Task 一个新 Session
├─ Assistant Chat  与 Router 的长期对话（一个 Group 一条）
├─ Agent Task      = 一条 agent_task Conversation + 恰好 1 个负责 Worker
│  ├─ 生命周期唯一权威 = Conversation.status（active / escalated / ready_for_review / completed …）
│  ├─ Loop（可选，0..1）周期/监听型工作的节拍、上限、运行计数
│  └─ Milestone   普通消息上的 block，只在 Activity 投影，不是实体
└─ Recommendation  成员级 briefing 投影（不是消息）
```

**和本仓的同构点**：Router≈主 agent、Worker≈custom agent / 事项跟进 agent、Task≈matter_item
派发、Loop≈触发器、Recommendation≈日报/今日域、proactive attention≈matter_attention + 飞书推送。
两边都收敛到了 **work-first**（本仓 L4 §1.3），这是借鉴成本低的前提。

**差异点**：Comma 是多租户云服务 + 计算节点 + 消费级 skill 市场（78 个外卖/打车/购物 skill）；
本仓是单用户本地优先、邮件为证据流的个人节点。下文凡涉及多租户、云 VM、计费的一律不借。

---

## 2. 功能借鉴

### F1 主动关注管线（最高优先）

**Comma 怎么做**（`DOMAIN_CONCEPTS §Comma proactive attention` + `skills/proactive/SKILL.md`）：

1. **采集与基线**：每 15 分钟采一次（Gmail 有推送时提前）。**首次见到的源 = 基线，不打扰任何人**；
   关掉再打开自动开关会重置基线，「关闭期间到达的东西」不会补响。
2. **先归并再判断**（零模型调用）：同一 PR / issue / 页面 / Slack 线程 / **邮件地址**的条目归成一个
   matter；某个键被 >6 条共享则不参与归并（防超级节点）。
3. **便宜的一次性筛选**：最多 24 条 + 2.4KB 历史，产出
   `urgency ∈ {critical, high, ask, normal, low}` + `assessment = {cost（不处理的代价）, due, reversible}`
   + 是否 `continues` 某个已有 matter。
4. **服务端确定性地板**（不信模型的分级）：代价 48h 内到期 → critical；**不可逆**且 7 天内到期 →
   critical；有任何代价 → 至少 high。登录 / 验证码 ≤10 分钟 → critical，超龄直接 quiet。
5. **只把 critical / high / ask 交给 Router**，normal / low 留给日报。Router 读当前上下文后
   **必须先记录决策**：`notify` / `quiet + reason` / `snooze + run_at`，再回复。
6. **双预算**：自动交接 ≤12 次/24h（控 Router 成本）；自动提醒 **间隔 ≥30 分钟、≤5 次/24h**，
   critical 跳过间隔但不跳过日上限；预算关闭时**不丢**，而是 `snooze` 到 `notification_budget.next_at`。
   用户主动要的提醒 / 盯梢汇报 / 回复**不消耗**预算。
7. **提醒文案契约**：1-2 句说「谁需要你做什么、为什么是现在」，最后一句**恒为一个提供具体下一步的问句**
   （「要我起草回复吗？」），附源链接；不加按钮列表、不重复推送。
8. **回复动作统一**：`handled` / `snooze` / `draft`（起一个 Task 干活）/ `source`，任一渠道（app /
   Telegram / 微信）改的是同一份状态。

**本仓现状**：`src/mail/new_watcher.py::_maybe_notify_feishu` —— 本地 LLM 分完类后逐封判
`priority ∈ {🔴紧急, 🟡重要} ∧ action ∈ {需要回复, 需要决策, …6 类} ∧ 非发件箱 ∧ 文件夹开了通知
∧ 非超龄补抓`，满足即推飞书；去重只有 page_id 10 分钟 + 3 天时效。`matter_attention` 有
`open/snoozed/resolved/dismissed` 状态机和 episode 语义，但**新邮件 → 打扰决策**这条链不经过它。

**建议落地**（拆三步，可独立上线）：

| 步 | 内容 | 关键约束 |
|---|---|---|
| F1a | 分类 schema 加三个**可选**字段 `cost_if_ignored`（一句话）/ `due_at`（ISO 或空）/ `reversible`（bool\|null）；新增纯函数 `urgency_floor(labels, now)` 实现 Comma 的地板规则，结果写 `notify_level` | 改 `src/llm_agent/schema.py` 必跑 `schema-consistency-reviewer`；地板是**单向抬升**，永不降级模型给的等级；缺字段 = 现行为 |
| F1b | 飞书推送前加**频控门**：`notify_budget` 行（间隔 30min / 日上限 5 / critical 跳间隔），预算关闭时写 `matter_attention` 或 `notification` 的 `snoozed` 并带 `snooze_until = next_at`，**不丢** | 门放在 `_maybe_notify_feishu` 的判据之后、发送之前；用户主动订阅的提醒不过门；默认值 owner 拍板，先观测再收紧 |
| F1c | **决策留痕**：每封进入判定的重要邮件落一条 `{decision: notify\|quiet\|snooze, reason, decided_by: rule\|agent}`，quiet 理由在 `/today` 可见（见 F2） | 这是 L4 北极星「每天要 owner 亲自做的决定数单调下降」的唯一可观测原料 |
| F1d（可选） | critical/high 交给主 agent 做二次判断（读线程最新回复、日历、事项），12 次/24h 上限 | 依赖 F1a-c；先跑影子模式（只记决策不改推送）对比采纳率 |

额外两条**直接可抄的小规则**：
- **归并键**：同 `thread_id` / 同发件人 + 同事项资料的多封新邮件归为一次判定，只推最新一封 + 「另有 N 封相关」。本仓已有 `src/matters/resource_identity.py` 可当归并键单源。
- **验证码邮件**：≤10 分钟才推，超龄静默；**验证码永不进飞书**（Comma 明令不发到个人 IM 目标），只在桌面通知。

### F2 「关注簿」：没打扰你的事也要看得见

**Comma**：`/Comma/Notebook.md` 是**投影不是实体**——服务端从 matter 值、watch loop、源状态、最近判定
**确定性渲染**（无模型写入），分组：需要你的 / 之后再说的 / 在等的 / **没打扰你的（附理由）** / 已完成；
1 分钟内合并渲染，内容不变不写盘，被手改会被下次渲染覆盖。Router 被问「你为什么没提醒我」时据此回答。

**本仓现状**：`/today` 例外面（`frontend/src/shared/components/today/`）是拉取侧聚合，五组分组、
「等我处理」浮顶，但**没有「静默掉的」那一组**；通知中心只记发生了的事件。

**建议**：
- `/today` 加第六组「**我替你挡掉的**」（读 F1c 的 quiet 决策，默认折叠，每条带 reason + 「其实该告诉我」反馈按钮——这一下就是 B3 信任引擎要的隐式投票）。
- 可选：把同一份投影渲染到资料库 `agent-docs/notebook.md`，让主 agent / 飞书对话能读（资料库已有 `agent-docs/` 免卡写区，正好是「系统写、人只读」的位置）。🔴 纪律照抄：**只由服务端渲染，模型不写**。

### F3 用户画像：带证据日期的「偏好 / 排除」行

**Comma**：`user.md` 中 `<!-- comma:portrait -->` 标记段，≤1.5KB，一行一个事实 + **最后确认日期**；
三种特殊行：`watch:`（要额外盯的频道 / 仓库）、`exclusion`（「别读这里」）、`preference`
（「账号要被删前一定告诉我」「dependabot 永远别提醒」）。每日刷新**只保留有证据的条目**，60 天未确认
自动删除，但 **exclusion / preference 永不过期**，且每次关注判定都读它们。用户纠正时 agent 只改该段。

**本仓现状**：memory.md 有界记忆 + 分层抽取（`MAILAGENT_MEMORY_LAYERS`）+ 编译进 user.md；
联系人画像 Agent 已在 run_log 里。但**没有「通知偏好」这种会被确定性门直接消费的结构化行**，
也没有按确认日期衰减。

**建议**：在 user.md 编译产物里加一个机器可读段（同样的标记段形状），F1 的判定把 `preference /
exclusion` 当硬输入（「永远别提醒 Jenkins 构建邮件」→ 直接 quiet，reason=「你说过」）。普通事实行
加 `confirmed_at`，60 天未被证据确认的进 memory 待清理候选（**走人审**，与本仓「memory 文件会自我投毒，
恒人审」纪律一致，不照搬 Comma 的自动删除）。

### F4 Loop 语义：周期 / 盯梢型工作的终止条件

**Comma**（`PRODUCT_MODEL §Task delegation` + `DOMAIN_CONCEPTS §Loop Tasks`）：

- `cadence` 三选一：`cron + IANA timezone` / `every_minutes`（5..1440）/ `events`（≤32 字的标签，只写「源 + 变化」，如「PR #12 新评论」）。
- 限制三件套：`max_runs`（1..1000）/ `ends_at` / `until`（自然语言停止条件 ≤500B）。**只从用户原话取，agent 永不自己编上限**；没说节拍就**问一次并给一个具体提议**，回答前什么都不建。
- Task 在两次运行之间保持 `active`；**一次失败不让整个 Task 失败**；Loop 未结束时服务端**拒绝** `ready_for_review`（一份汇报 ≠ 工作完成）；到上限自动结束并完成 Task；Worker 报告 `until` 成立时 Router 完成 Task。
- UI 只显示触发类型 chip（`定时` / `有更新时` / `其他`）+ 规则；**刻意不显示**下次运行、运行次数、截止时间。

**本仓现状**：custom agent `trigger_json` 有 cron / schedule / email_filter + `max_runs_per_day`；
事项触发器 v2 有 schedule / event / condition / manual，但**都没有生命周期上限和停止条件**。
「每天 9 点汇总某客户来信，持续到项目结项」「盯这个线程，对方回复了就告诉我然后停」这类邮件场景
最常见的请求，现在只能人肉关。

**建议**：
- 两处触发器 envelope 加可选 `limits: {max_runs?, ends_at?, until?}`，`until` 由执行 agent 每次运行末尾判定并在结构化输出里报 `stop_condition_met: bool + evidence`；服务端据此结束触发器（**服务端写状态，不接受 agent 自述改状态**——与 `MatterItemDispatchState` 现有纪律同向）。
- 「盯线程直到回复」做成事项跟进的一等预设：`events = 线程有新来信` + `until = 对方已回复`。本仓有 inbox 事件流和 thread_id，成本很低。
- chat 侧 prompt 规则照抄：**不编上限、缺节拍问一次并提议**。

### F5 执行者沉默看守（stall watch）

**Comma**：`TaskWorkerWatch` —— 宽限期后 Worker 仍沉默则**提醒一次**，再沉默就**在 Task 里告诉发起人一次**；
桌面/云 station 有分阶段判据表（`vm_not_ready / station_offline / not_given / running(2h 不算卡) /
idle_no_reply / cannot_start(登录·额度类失败立即报)`）。是否已提醒**从消息记录读**，重启不重复发。

**本仓现状**：`matter_item_dispatch` 七值状态机服务端 CAS，契约已比 Comma 严；但「派出去之后没动静」
靠人看。

**建议**：给 dispatch 行加一个看守：`queued` 超 N 分钟未认领 / `running` 超 M 小时无 activity →
打开一条 `matter_attention(kind=dispatch_stalled)`；**认证 / 额度类失败立即升级**（不等阈值）；
幂等判据读 attention 表现有 episode，不靠内存。复用 `src/matters/attention.py` 的事件驱动信号通道即可。

### F6 简报项「暂存到输入框」而不是自动执行

**Comma**：Recommendation 上的动作 `send_to_comma` 只把文本**暂存为输入框上方的附件卡**，用户手动
发送才进入对话；处理过（handled）的条目在简报栏与关注面**共享同一份状态**，一处处理处处隐藏。

**建议**：日报 / 周报 / `/today` 条目的「交给 AI」动作统一成「暂存到 chat composer」（附件卡 +
来源 deep-link），不自动开 run；同一封邮件在日报、通知、`/today` 三处的 handled 态共用一个键
（本仓 `dedupe_key` / resource identity 已具备）。

### F7 会前准备的两条不变式

**Comma**（`meetings-calendar.md`）：
- 会前 20 分钟开始调研；**调研失败不压制基础提醒**（标题 / 时间 / 链接恒发）。
- 起草 → **独立 source review**（审稿者只拿草稿 + 当前时间 + 源材料，不带会话上下文）→ 纠正无出处的人名 / 日期 / 来源 → 才保存；首次保存的 review 不可变。

**本仓现状**：日历「会前 N 秒」trigger + Agent Plugins 会前准备模板已有。

**建议**：模板里把这两条写成硬约束；独立审稿可用 `custom_agent_call` 起一个无上下文子会话。

### F8 外部系统入站：一个 key 投一条消息给主 agent

**Comma**：`POST /v1/agent-groups/{id}/router/post-message`，调用方拿到**排队回执，没有回复通道**，
由 Router 决定是否 / 在哪回应；key 明文只返回一次，记录创建者（key 以创建者权限行事），
**agent 自己铸的 key 不带任何成员身份**，防止 agent 给自己扩权。

**建议**（低优先）：本仓已有 scoped key + `/api/skills`；可加一个 `inbox` scope，Jenkins / Notion
automation / 脚本往主 agent 投「事件消息」，走 F1 同一条判定链。

---

## 3. 界面借鉴

| # | Comma 做法 | 本仓建议 | 优先级 |
|---|---|---|---|
| U1 | Task 看板三列：**进行中 / 待你（Needs Review + Needs input）/ 已完成**；`escalated` 显示为「需要你输入」 | 事项行动项跨事项看板视图，列 = dispatch 状态的三段投影；Loop 型条目带触发类型 chip | 中 |
| U2 | 「待审」小红点用**设备本地的 revision 标记**：记录打开时的 `updatedAt`，`updatedAt > seenAt` 即亮，重新进入待审自动重新点亮，服务端零状态 | agent run / 事项 / 会话的未读点统一成这一个 hook（本仓已有会话溯源未读点，可收敛） | 小 |
| U3 | **Quick Chat**：双击 ⌘ 唤起、可录 ≤60s 语音、Esc/点外面关闭但**保留已输入的字**；Notch 显示已发送的话，Router 若由此建了 Task，该行变成 Task 进度 | 灵动岛移除评估已完成——可用「全局速记窗 + 菜单栏进度行」替代岛的「随手交代一句」场景；文字保留、失败可原样重试 | 中 |
| U4 | 提醒文案契约（见 F1-7）：1-2 句 + 一个具体下一步的问句 + 源链接，不堆按钮 | 飞书重要邮件卡片精简：摘要一句 + 「要我起草回复吗？」主按钮 + 次级 `稍后 / 已处理 / 打开原文` | 小 |
| U5 | Loop 详情只显示规则 + 状态（设置中 / 运行中 / 暂停原因 / 已结束），**不显示**下次运行与次数，避免用户对「精确调度」产生错误预期 | custom agent 卡片的触发区按此精简；运行台账仍在详情页可查 | 低 |
| U6 | 里程碑只进 Activity，不进 transcript，按「请求 / Loop 运行」分组 | 本仓 run_log 步骤已存在，可在事项时间线按 run 分组折叠 | 低 |

---

## 4. 架构与工程治理借鉴

### A1 领域概念台账 + 新增实体门槛（强烈建议）

**Comma**：`DOMAIN_CONCEPTS.md`（288KB）+ `AGENTS.md` 硬规则——**只有当现有实体 / 关系 / 值 / 显式投影
都无法表达时才能加实体**，并在同一改动里写清：为什么复用不够、身份与范围、owner（唯一写者）、生命周期、
关系、代码锚点。典型示范：Loop Task **不是新实体**（= Task + 一条 Loop 关系值）；Milestone 是消息上的
block；Notebook / Recommendation 是投影。「把存储的数据叫投影，不等于授权删除它」。

**本仓痛点**：`notification` / `matter_attention` / `/today` / 灵动岛卡片 / `agent_run_log` /
`run_state` 是同一族「有事找我」与「做过什么」概念的多套表示，彼此靠文档里的「划界纪律」维持
（`notification-center.md §1.1`）。这种划界写一次就要维护一次。

**建议**：在 `docs/reference/architecture/` 新建 `domain-concepts.md`（≤20KB 起步），每行：
概念 / 实体·值·关系·投影 / 唯一写者（文件锚点）/ 生命周期权威 / 与谁不是同一个东西。
CLAUDE.md「开发指南」加一条：**加表或加状态枚举前先查台账**。与 E0-E4 收敛路线天然合流。

### A2 文档锚点漂移检测

**Comma**：`generate-inventory.mjs` 校验架构文档里的代码锚点（`file.ex#L185`）仍存在，生成
`generated/inventory.md`；`pnpm docs:check` 进 CI。

**本仓**：文档大量引用 `models.py:56`、`triggers.py:18` 这类行号锚点，已出现过漂移（L4 README 说
「插座已预留（models.py:56）」，但 `MatterResourceKind` 现在在 `src/matters/models.py:115`，第 56 行已是
`MatterItemDispatchState` 的 docstring）。**建议**加一个只校验「文件存在 + 被引符号仍在该文件」
的脚本（行号不校验，改为 `file.py::symbol` 形式），挂 pre-commit 或 CI。与本仓「跨边界手抄常量必建闸」
是同一种思路的文档版。

### A3 「副作用先落账、中断不自动重放」的工具调用账本

**Comma 不变式**：side-effecting action 在开始**之前**落账；被中断的 mutating action **不会自动再跑**；
恢复时对未知结局标 `unknown`、交给人。批量里只有「可重放的只读调用」才允许与持久化并发。

**本仓**：mail 写路径已有 outbox（intent 先落库再 fanout），这是同一纪律；但 gateway 侧不可逆工具
（`email_send` SMTP、日历删除、Notion 写、`run_command`）在进程崩溃 / detached run 中断时的语义
需要核查。**建议**：审一遍 gateway 对 edit-tier 工具的崩溃恢复路径，若无「调用前落 intent 行 → 结束写
outcome → 重启时未结行标 `unknown_outcome` 并开一条通知、永不自动重试」，补上。

### A4 依赖活性：每个外部依赖都有截止、取消与过期结果栅栏

**Comma 参数**：模型请求含重试 600s 总预算；流式 **120s 无首事件即失败、事件间隔 >30s 即失败**
（`: keep-alive` 注释不算事件）；无 `[DONE]` 或已知 finish reason 返回可重试的 `incomplete_stream`；
**有效流数据之后不再做传输层重试**；迟到结果不能复活已取消的 owner。

**建议**：拿这组数字对照 `frontend/src/ai-gateway` 的 provider 调用与 `src/llm_agent` 本地 LLM 调用做一次
审计；过期结果栅栏（generation / revision 号）优先补在**日报 / 事项跟进 run 的发布点**——Comma 的
Recommendation 发布会校验 run、generation、source_revision，新一代启动后迟到结果标 `superseded`。

### A5 「状态 ≠ 送达」的用词纪律

Comma 文档反复区分：`queued` ≠ 开始处理、accepted ≠ displayed、发送成功 ≠ provider 送达、
Router completed ≠ 人类验收（`ready_for_review → completed` 需校验**被审阅的精确版本**）。
本仓 feature-flags-rationale 已有类似精度；建议在通知中心与飞书推送日志的 `ok` 字段上同样拆开
（「飞书 API 接受」≠「用户看到」）。

### A6 独立架构审查

**Comma**：架构模型通过程序化校验后，**必须由另一个架构师 agent** 读生产代码与直接测试，按
blocker / important / suggestion 输出；「生成模型的 agent 不能自行宣告语义已收敛」。

**建议**：本仓已有 `schema-consistency-reviewer` subagent；E 系列收敛 epic 与 L4 批次的设计稿可加同样
的独立审查步骤（`.claude/agents/` 新增 `architecture-reviewer`）。

### A7 可选：TLA+ 只建模一两个核心协议

Comma 把 TLA+ 限定在「持久状态安全、所有权与 fencing、已接受工作不丢、授权完整性」，总预算 5000 行，
功能级行为留给实现测试。本仓最值得建模的是 **outbox + FanoutWorker** 与 **入向已读回收**（文档里写着
「一处有意保留的竞态」）——用 ~200 行模型把「有意保留」变成「已证明无害」。**低优先，有余力再做。**

### A8 可选：文档规模预算

Comma：`docs/` 通用文档 ≤20 个文件、每个 ≤20KB，**不留 archive 目录、历史放 git**。本仓 CLAUDE.md
本身已 ~45KB、`docs/archive/` 体量大。不建议照搬「无 archive」，但可借「**常青文档单文件上限 +
按主题合并**」：给 `docs/reference/` 加体积检查（超限告警不阻断），CLAUDE.md 的「关键开关现状」表
是首个瘦身候选（已有 feature-flags-rationale 承接细节）。

---

## 5. 明确不借的

| Comma 设计 | 不借的理由 |
|---|---|
| Elixir/OTP + Lean 内核重写 | 本仓 Python + TS 栈稳定，收益不抵迁移成本；借的是**不变式**不是实现 |
| 多租户 Workspace / BFT / 计费 / 云计算节点 / Cloud VM | 违反 L4 D1/D2（不做多人平台、不做共享 agent） |
| 消费级 skill 市场（外卖、打车、购物） | 与「邮件为证据流的个人工作节点」定位不符 |
| 完整 IFC 标签体系 | 单用户场景过重。**但**飞书群场地（C1）与群聊 G 系列上线时，需要 IFC 的最小子集：「邮件 / 私有源内容不得流入群会话」，届时按 Comma `verification.md` 的「源 → 目的地检查」做一个白名单闸 |
| Router 单一 canonical Session（所有入口汇进同一上下文） | 战略级选择，与本仓多会话 + compact 模型冲突；本仓用「事项 = 持久工作态」已达成同一目的（work-first）。**仅记录为候选**：飞书私聊与桌面主对话是否共享一个主会话，可在 C1 时再评估 |
| Recommendation 远程图片经 Main 进程解码重编码 | 本仓无此场景 |

---

## 6. 建议排期（嵌入 L4，不另起 epic）

| 序 | 批次 | 内容 | 依赖 / 并行 |
|---|---|---|---|
| 1 | **关注管线 P1** | F1a 紧急度地板 + F1b 频控门 + F1c 决策留痕 + F2「我替你挡掉的」组 + 在场感知路由（§0 #2） | 与 G 系列并行；只动飞书推送与 `/today` |
| 2 | **Loop 语义** | F4 两处触发器 `limits` + 「盯线程直到回复」预设 + chat 侧不编上限规则 | 落在 A2 行动项契约之上 |
| 3 | **治理小批** | A1 领域概念台账 + A2 文档锚点检测 + A6 架构审查 agent | 纯文档 / 脚本，随时可插 |
| 4 | **关注管线 P2** | F1d 主 agent 二次判断（影子模式起步）+ F3 偏好 / 排除行 + F5 stall watch | 依赖 1；数据喂 B3 信任引擎 |
| 5 | 体验小批 | U2 revision 未读点 + U4 飞书卡片精简 + F6 暂存到 composer | 随发版插 |
| 6 | 审计 | A3 工具调用账本核查 + A4 依赖活性参数对照 | 发现缺口再立 task |

**在场感知路由**的最小实现：Electron main 用 `powerMonitor.getSystemIdleTime()` + 主窗口可见性，
≤1 次/分钟上报 `app_active`（10 分钟内有输入且窗口开着且通知权限开）；后端飞书推送前读这个值，
`app_active=true` 时只走通知中心 → macOS 原生通知，否则才推飞书。critical 两边都发。

---

## 7. 参考（Comma 仓内路径）

- 产品概念与 Task 委派：`docs/architecture/PRODUCT_MODEL.md`
- 概念台账（含 Loop Tasks / proactive attention / 新增实体规则）：`docs/architecture/DOMAIN_CONCEPTS.md`
- Task 生命周期、TaskWorkerWatch、Background Loop：`docs/salix/tasks-background-execution.md`
- Agent 运行时（活性、fence、压缩、condensed workspace 偏航检查）：`docs/agent-runtime.md`
- 会议准备不变式：`docs/meetings-calendar.md`
- 主动关注 prompt 契约：`resources/salix-system-files/skills/proactive/SKILL.md`
- 客户端契约（Quick Chat、Dynamic UI 沙箱）：`docs/clients.md`
- 仓库治理规则（实体门槛、文档预算、TLA+ 预算、PR 文本）：`AGENTS.md`
