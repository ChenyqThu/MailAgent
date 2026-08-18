# 调研档案 07：Notion database + Agent 协作机制

> 调研日期：2026-08-18 · 执行：Opus 5 调研 agent（官方 help/releases/blog 20+ 页实际 fetch + owner 工作区只读探针；404 与未证实项如实列于文末）
> 标注约定：**【事实】** / **【推断】**。

---

## 0. 概念澄清：Notion 有三套 agent，身份模型不同【事实】

| | 触发 | 身份/权限 | 与 database 的关系 |
|---|---|---|---|
| **Notion Agent**（个人） | 人在 chat 发起 | 无独立身份（"same permissions you do"） | 能建/改 db/view/property |
| **Custom Agents**（3.3，2026-05-04 GA） | schedule / db 事件 / Slack / @mention | **独立身份独立权限**（"agent's own access, not the permissions of the person who triggered it"） | 主战场：db 行事件触发 + 写回 property |
| **External Agents**（3.6 GA 2026-07-01） | 从 board 派任务 / @mention | 外部 agent（Claude/Cursor）作为一等 workspace participant | "assign them tasks from a board… watch them run" |

**owner 工作区探针（只读）**：agent 是一等对象（`agent://{workspaceId}/{agentId}`）；已有 6+ Custom Agent；**已有一个 External Agent 在册（`Claude-OmadaBeacon`）**；用户表里有 `Agents API` bot 和 7 个 `Notion Agent Computer Session` bot（每次 computer-use 会话铸一个 bot 身份）。

## 1. 触发机制【事实，/help/custom-agents 逐字】
- db 触发器：page added / **property updated**（状态机的关键）/ page removed / comment added / AI Meeting Note finished；另有 Calendar 与 Mail 触发器（实测来源）。
- Schedule（daily/weekly/monthly/weekends + 时区）；Slack（仅 public channel）；手动 @mention（可 @ 进 database property）。
- **触发器可加 filter**：匹配 property 值 / 限定某个 database view——这就是「按视图分派」的官方通道。

## 2. 权限模型【事实】
- agent 有自己的权限不继承触发者；**默认零权限**，显式授予（agent 设置或页面 Share 菜单）；资源权限 view/comment/edit，最佳实践 = "只在真需要改内容时给 edit"。
- **越权放大是官方承认的风险**："Anyone who can use an agent might access information through it that they couldn't access directly."
- 权限回收即停机；**API 2026-06-10 起 bot 可被填进 people 属性 = agent 可当 assignee**。

## 3. 可观测性【事实】
- Activity tab 记每次 run（触发源/动作/错误）；"Every run is logged, so changes are visible and reversible"；可回任意历史 run 续聊。
- **关键机制**："Claude sessions appear in Agent Activity **and on the page or task where the agent runs**"；Cursor "each run remains **linked to its parent task**"——「实时看到哪个 agent 在做哪个任务」= **session 挂在任务行上**。
- Editor attribution UI 表现**未直接证实**（间接证据指向按 bot 身份归属）。

## 4. 🔴 状态流转语义（本档案最重要发现）【事实】

**Notion 没有结构化的 agent 任务状态机——状态机是用 `Status` 属性 + 每 agent 一个 `property updated` 触发器「手搓」出来的。协议是数据，不是代码。**

官方五 agent 流水线（Gong FR Pipeline 指南）：Intake→置 Status=Extraction→触发 Extractor→置 Matching→…→或置 `🚦 Review: Triage`（**人工审批点 = 一个状态值**）。要点：
1. 推进状态 = 自然语言 SOP（prompt 里写 "move the entry to 📝 Logging"），无结构化 transition；
2. 每个 agent 只写自己那几列——**列即职责边界**；
3. 人的审批 = 人改状态（周报只在人把状态改成 `Published` 时才发 Slack）；
4. **无 failed/blocked 状态原语**，失败只落 Activity log；prompt 级兜底（"If there are no updates, post 'No action needed' instead of skipping"）。

## 5. SOP 载体【事实】
Instructions 面板纯自然语言 + 可 @mention 引用 Notion 页面（**SOP 集中维护在页面里 = Notion 版 standing doc/skill**）。官方最佳实践：写结果不写步骤 / 给具体样例 / 明确落点与要填的 property / 明确边界与 avoid / **收窄到最小 scope** / 先测后挂触发器。

## 6. 多 agent + 人【事实】
- 分派 = trigger filter + per-agent access 范围；**agent 不能直接调 agent**（"chaining requires database-triggered sequencing"，实测）。
- 人介入五通道：改状态即审批 / `🚦 Review` 中间状态 / 草稿态私有 / **URL 确认闸**（"If an agent generates a URL that wasn't in your original prompt, it pauses and asks"）/ prompt 里写"有问题先问我"。
- **无 propose-only 原语**；**防重复认领零机制**（社区 workaround = `AI Processed` checkbox；官方例子靠状态值互斥天然串行）。

## 7. 边界与失败模式【事实】
- 单次运行 ~20 分钟（能力宣称即实际上限）；步数/频率/并发**官方无明确上限**；credit 耗尽自动暂停、**定时 run 跳过不补跑**；单 run 成本 $0.03-0.30。
- 翻车点：越权放大（官方承认）/ prompt injection（官方建议不可信内容用大模型）/ 触发时序坑（转录晚于 page added）/ 指令含糊产出不稳 / 超量产出（要 1 条建了多条）/ 明确反 set-and-forget（"You have to watch what they do"）。

## 8. 综合判断【推断】

### (a) Notion vs Linear：数据约定（软）vs 协议（硬）

| 维度 | Notion | Linear AgentSession |
|---|---|---|
| 执行契约在哪 | **数据里**（Status 值 + 触发 filter） | **协议里**（活动流，SDK 强制，"no manual state management"） |
| 状态谁维护 | agent 按 prompt 自己改（可能忘/改错→**静默永久卡死**） | 平台按 emitted activities 自动推 |
| 反问 | 无原语 | elicitation 一等活动类型 |
| 所有权 | agent 可直接当 assignee | **delegate ≠ assignee**，人保留 ownership |
| 上手门槛 | 极低（业务人员可配） | 要写代码 |

Notion 强在 workflow 可由业务人员用数据定义、流水线即看板天然可视、人和 agent 用同一套状态词汇；弱在无结构性保证（无 claim/lease、无 failed/blocked 原语、责任主体模糊）。**前者可编，后者可靠。**

### (b) 对 MailAgent 行动项契约（A2/D4）的五条启示

1. **状态机要硬、状态值可编，两者不冲突**：执行契约状态（`open→claimed→running→awaiting_input→proposed→done/failed/abandoned`）由服务端 CAS 强制；业务语义标签开放自定义。**执行状态 ≠ 业务状态，别合成一列**（Notion 只做了后者，教训 = agent 忘改状态即静默卡死）。
2. **claim = 带 lease 的 CAS**：复用 `async_jobs` fire_key 幂等 + `expect_status` CAS 先例，加 `lease_expires_at`（对齐 runtime 预算 1800s），到期回 open 计 `claim_expired`。**Notion 的 20 分钟上限本质是没有租约机制的替代品**。
3. **`awaiting_input` 是一等状态**：复用 `paused_handoff`/审批 stash/`approvalTtlSec` 差异化 TTL 设施；反问落 question 记录，TTL 过期转 blocked。**别让「agent 在等人」和「agent 死了」在 UI 上长一样**——Notion 当前最大可观测性缺口。
4. **过程可见性挂行动项不挂会话**：抄 "sessions appear on the task"——`ai_chat_sessions` provenance（P1 三列 + P2 父子）加 `item_id` 反查，行动项详情页渲染该行动项上的所有 run；列表行 live badge。
5. **propose-only 做成 per-行动项执行档**：`propose_only | edit_with_approval | autonomous` **挂在行动项上不挂 agent 上**（同一 agent 不同行动项可不同档）——Notion 做不到（其粒度是 agent×资源无 agent×任务）；MailAgent 的 `matter_update_propose` 已是雏形。

**两条别抄**：agent 直接当 assignee（坚持 owner=人 / executor=人或 agent 两列，delegate-not-assignee）；「agent 不能调 agent」限制（`custom_agent_call` 已更强）。

### (c) 行动项 ↔ Notion database 对接形态：**单向投影 + 回执互链，不做双向镜像**

1. 本仓血教训：Sprint 15 死循环根因就是双向直调；现在 SQLite=intent 聚合点 + 单向 fanout。双向镜像且两端都有 agent 改状态，回环比当年更难查。
2. 两边状态机语义不同不该对齐：执行语义（机器用）不投影，业务态（标题/干系人/截止/粗粒度 `待办|进行中|等人|已完成`）单向写 Notion，走 outbox+fanout 同一纪律。
3. **互链双向、数据流单向**：Notion 行存 item_id + deep link，行动项存 Notion URL。
4. Notion 侧人工改动**不自动回写**——变「Notion 侧有变更」关注信号（复用 attention episode 语义），owner 决定是否接受（提案不直改）。
5. 反向唯一例外：Notion `property updated` webhook 可当行动项的一种 **trigger kind**（比照 P7 `calendar_event_change` 形状：business hash + 合并窗 + 幂等键）——**触发 ≠ 状态同步**。
6. 现成的腿：`notion_agent_chat` 工具（办事）· Notion 自建直连 MCP（投影写入通道）· 跟进 run connector 只读已通（读资料）。

## 9. 未证实/未知【如实】
Editor attribution UI 表现；步数/频率/并发上限；External Agents API 完整文档（`developers.notion.com/docs/external-agents` 404，SDK 仍 waitlist，`/product/dev` 有端点形状 `POST /sessions/{id}` / `GET /sessions/{id}/events`）；MindStudio 一文与官方矛盾（以官方为准）。

## 10. 访问清单
官方：/help/custom-agents · /help/category/custom-agents · /help/custom-agents-sharing-and-permissions · /help/custom-agents-security-features · /help/best-practices-for-creating-and-optimizing-a-custom-agent · /help/buy-and-track-notion-credits-for-custom-agents · /help/notion-agent · /help/use-claude-agents-in-notion · /help/guides/build-your-first-custom-agent · /help/guides/build-a-multi-agent-system-that-turns-customer-feedback-into-a-monthly-report · /help/guides/automate-project-updates-and-reporting-with-custom-agents · /releases/{2025-09-18, 2026-02-24, 2026-05-13, 2026-07-01} · /blog/introducing-developer-platform · /blog/how-notion-uses-custom-agents · /product/dev · developers.notion.com/page/changelog
其他：linear.app/developers/agents · TechCrunch 2026-05-13 · matthiasfrank.de 实测 · stack-snacks 实测 · createwith Cursor 更新
404：developers.notion.com/docs/external-agents · /docs/agents · linear.app/developers/agent-sessions
工作区探针（只读）：notion-search-agents · notion-get-users ×2 · notion-search（bot created_by 过滤返回空，不作否证）
