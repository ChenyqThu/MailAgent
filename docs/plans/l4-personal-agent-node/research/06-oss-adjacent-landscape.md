# 调研档案 06：邻接开源项目版图（抄模式 / 直接集成 / 忽略）

> 调研日期：2026-08-18 · 执行：Opus 5 调研 agent（stars/commit 数来自 GitHub REST API 实测；全部 URL 实际访问；查不到的如实标注）
> 标注约定：**【事实】** / **【推断】**。

## 0. 结论总表

| 项目 | License | 判断 |
|---|---|---|
| **Inbox Zero** | AGPL-3.0 + 商业附加条款 | **抄模式**（最高价值，五 workstream 全覆盖对照组 + 正面竞品） |
| Zero / Mail-0 | MIT | 忽略（主干停摆 ~12 个月，10.7k star 仅 17 open issue） |
| Khoj | AGPL-3.0 | 忽略（活跃度崩塌：52 周仅 204 commits；能力被 MailAgent 覆盖） |
| **Letta**（原 MemGPT） | Apache-2.0（活跃仓已换 `letta-ai/letta-code`，老仓 2026-08-16 立墓碑） | **抄模式**（MemFS git 化记忆 + dreaming） |
| Cal.com → cal.diy | MIT（2026-04 闭源转身后的公开仓） | 忽略 cal.diy（官方自认非生产用）；**booking 模型改抄 Inbox Zero** |
| Twenty | AGPL-3.0 + EE + MIT SDK + Application Exception | 抄模式（有限）；**明确不抄其通用元模型** |
| Huly | EPL-2.0 | 忽略（hosted 因断资关停；30+ 微服务架构与 local-first 反向） |
| n8n | Sustainable Use（非 OSI，禁嵌入分发） | 抄模式（审批挂在 (agent,tool) **边级**而非工具级全局；9 渠道审批；但仅 Approve/Deny 两档——MailAgent 表达力已超） |
| **LangChain agent-inbox** | MIT | **抄模式**（例外队列最小协议契约） |
| HumanLayer | Apache-2.0 | 忽略（作者 README 自述 deprecated） |

## 1. Inbox Zero 深挖（elie222/inbox-zero）⭐

**【事实】** 12,022★，52 周 4,752 commits **在加速**（最近 8 周最高 121/周）；**2026-08-16 刚发 `desktop-v0.1.0`**。License = AGPL-3.0 + 三条附加（商业化限制 / ≥5 业务用户须企业授权 / 个人·教育·<5 人豁免）。以下机制读自 `apps/web/prisma/schema.prisma`（2,173 行全文）。

### 机制① 审批位点上移【事实，schema @deprecated 注释 + changelog】
- `Rule.automate` 注释："@deprecated - No longer used. **All rules are now automated.**"
- `ExecutedRuleStatus.PENDING / REJECTED`："@deprecated - No longer created. Kept for historical data only."
- changelog 2026-03-22："The assistant now asks for confirmation **before creating automation rules** that send, reply, or forward emails on your behalf."
- **读法**：他们**做过 per-email 审批队列然后废弃了**——改为：能力级审批（创建规则时弹一次卡）+ 执行全自动 + 危险动作降级 `DRAFT_EMAIL`（草稿躺 Drafts）+ 置信度闸（`DraftReplyConfidence: ALL_EMAILS|STANDARD|HIGH_CONFIDENCE`）。
- **【推断】这是别人付过学费的失败**：例外队列 ≠ 审批队列——它是「做了什么+可事后改」的回顾面，不是「想做什么+等点头」的闸门；闸门在能力授予时点一次。

### 机制② 影子模式工业实现【事实】
`DraftSendLog`：AI 草稿 vs 用户**实际发出**文本算 `similarityScore`/`bodySimilarityScore` → 异步抽成 `ReplyMemory`（**FACT / PREFERENCE / PROCEDURE** 三类 + scope）回灌后续草稿。changelog："Draft replies now learn from your edits."——**相似度就是免费的信任分，用户零额外操作**。

### 机制③ 隐式纠错信号【事实】
`ClassificationFeedback`：用户手动加/删标签 = 对某规则在某发件人上的投票，去重键 `(emailAccountId, sender, ruleId, messageId, eventType)`；`ExecutedRule.matchMetadata` 存 learned patterns。

### 机制④ 五 workstream 对照组【事实，schema 同时存在】
- Booking 四表极简 schema：`BookingLink`(slug/duration/minimumNoticeMinutes/maxDaysAhead) + `AvailabilitySchedule`(timezone) + `AvailabilityWindow`(**weekday+startMinutes/endMinutes 整数**——避 DST) + `Booking`(cancelTokenHash 无账号取消 / `@@unique(bookingLinkId, idempotencyToken)` 防重)。**预约链接照抄这个，不看 cal.diy。**
- `MessagingRoute.purpose` 枚举（RULE_NOTIFICATIONS/SCHEDULED_CHECK_INS/MEETING_BRIEFS/DIGESTS/FOLLOW_UPS…）+ `@@unique(channelId, purpose)`——**按用途分路**，飞书进群后必然需要。
- `OrganizationRule` 物化成成员 `Rule` 副本 + `organizationRuleMemberEnabled` 成员级 opt-in（`enabled = OrgRule.enabled && memberEnabled`）——团队规则下发但保留个人否决权。
- `MeetingBriefing`/`ContactResearch`/`Meeting`/`MeetingRecording`、`Knowledge`/`ChatMemory`/`ChatCompaction`、`McpIntegration/McpConnection/McpTool` 均在。

### 🔴 竞品判断【推断】
Inbox Zero 是正面竞品且在往桌面走。MailAgent 差异化必须钉死在它结构上做不到的：**local-first 数据不出机 / Exchange 强管控租户（davmail）/ Matters 有语义的工作对象 / 主权定位**。只追功能清单 = 跟每周 100+ commits 的领先团队赛跑。

## 2. Letta（letta-ai/letta-code，Apache-2.0）⭐

**【事实】** 老仓 24k★ 已归档（"landing page"，2026-08-16）；活跃仓 letta-code 3,025★、52 周 3,136 commits。

- **MemFS**（docs.letta.com/concepts/memfs）：记忆 = git 仓投影成真实文件树（`system/persona.md`、`reference/`、`skills/`）；`system/` 每轮进 system prompt；**文件树本身恒在 prompt 里当路标**（目录名即导航）；Markdown+YAML frontmatter；**每次记忆编辑都 git commit**（版本史/冲突解决/已保存 vs 未提交边界）；skills 就住在记忆里。
- **Dreaming**：后台子代理整理记忆，触发时机含 **"when the context window is compacted"**；用 **git worktrees** 并发不阻塞主 agent。
- Memory block 四元组：label + **description（驱动读写决策的主信息）** + value + limit；`read_only` block；多 agent 挂同一 block = 共享记忆。
- **【推断】对 MailAgent**：① dreaming 挂 compact——MailAgent P3/P4 compact 钩子现成、目前只压缩不沉淀，**近零成本接线点**；② 文件树代替固定 5 层——层不够时 agent 自己开目录，且树在 prompt 里解决「模型不知道自己记了什么」；③ 每次编辑 git commit 比 history 表更进一步。

## 3. 其余各项（浓缩）

- **Zero/Mail-0【事实】**：默认分支 `staging` 最新 commit 2025-08-31，最近 12 周 0 commits——实质停摆；停摆原因无官方声明，不断言。
- **Khoj【事实】**：36.5k★ 但 52 周 204 commits、五个月没发版仍 beta。Automations = NL + cron + 邮件投递，**弱于 MailAgent TRIGGER_V2**；仅 Obsidian/Emacs 端与多格式本地 RAG 领先。
- **cal.diy【事实，一手验证】**：`calcom/cal.com` 301 重定向到 `calcom/cal.diy`；官方博客 2026-04-15 宣布生产库转私有、公开仓改 MIT；README 明写 "strictly recommended for personal, non-production use"、维护者是前实习生；Teams/Workflows/Routing Forms 等全被剥离。
- **Twenty【事实】**：55k★、极活跃（最近 8 周 100-250/周）。License 三段式 + **"Twenty Application Exception"**（经 Application Interfaces 交互不受 AGPL 传染——未来 MailAgent 开放 skill 生态可参考的条款模板）。**关键自我约束**："Email and calendar sync only works with People, Companies, and Opportunities"——**通用元模型 + 域集成 = 域集成只对固定子集生效**，文档还劝阻滥建对象。→ **不要**把 Matters 泛化成自定义对象系统。值得抄：① agent 可见性由 role/permission 派生（agent ⊆ 用户权限），不是第二套授权表——多人场景（飞书群）更省心；② Notes/Tasks 一等对象挂任意 record——确认 matter resource/action item 形状。
- **Huly【事实】**：README 顶部 IMPORTANT："Hosted Huly is shutting down… because its hosting is no longer being funded"；最近 8 周 commit 断崖。架构 = 30+ 微服务 + CockroachDB + Redpanda 事件流——「域对象互链」的答案是单库+事务引擎+事件流，**MailAgent 的 SQLite+outbox+进程内总线就是同一答案的单机版**，无增量。Tx/mixin 核心模型与 AI 现状未在实际读到的文档中，不断言。
- **n8n【事实】**：201k★。Sustainable Use License 禁嵌入分发（连非主干分支都不授权）。HITL：审批挂在 **AI Agent 节点的 Tools 连线上**（(agent,tool) 边级，同一工具不同 agent 可不同策略）；9 个审批渠道；语义仅 Approve/Deny 两档，无 edit/respond；超时文档未提及。**【推断】** 边级模型对「同一 `web_fetch` 主 agent auto、跟进 run off」更自然；审批表达力 MailAgent 已超（三档+destructive 红警告）。
- **LangChain agent-inbox【事实】**（MIT，1,072★，小而活）：例外队列最小契约 = `HumanInterruptConfig{allow_ignore, allow_respond, allow_edit, allow_accept}` 四布尔（发起方声明本次中断允许什么）× `HumanResponse.type: accept|ignore|response|edit`（人的选择）。**MailAgent 审批卡缺 `edit`（改参数再执行）与 `response`（不批但给文字指导）**——例外队列区别于审批弹窗的关键。另：`triage.logic`（为什么进队列）是一等字段。
- **HumanLayer【事实】**：README 自述 "the code here is pretty much all deprecated"。

## 4. 综合判断【推断，证据标注见上】

1. **WS-B 设计要改、优先级上调为第一**：例外队列做成回顾面不是闸门（Inbox Zero 学费）；影子=DraftSendLog、抽样=ClassificationFeedback、升档=置信度连续维度、条目契约=agent-inbox 4 布尔×4 响应（补 edit/response）。
2. **Booking 不自研设计**：照抄 Inbox Zero 四表（含避 DST 整数分钟/无账号取消 token/幂等键），不看 cal.diy。
3. **AAMP 是真空白**：11 个项目零 mailbox-native agent 互联。真空白 = 没竞争也没人验证过需求；押注前先做最小证伪实验（两个 MailAgent 实例跑通一次 agent-to-agent 邮件握手），并回答「为什么不是 MCP over email」（Inbox Zero 已把 MCP 做进 schema，行业默认在向 MCP 收敛）。
4. **飞书场地结构改进**：`MessagingRoute.purpose` 按用途分路 + Organization 规则物化/成员 opt-in。
5. **Memory 低成本红利**：dreaming 挂 compact 钩子（纯增量）；长期看 MemFS 文件树。
6. **竞品警觉**：Inbox Zero（见 §1 🔴）。

## 引用一览（实际访问）
GitHub API：`/repos`、`/stats/participation`、`/commits`、`/releases/latest`、`/branches` 覆盖全部 11 仓。
源码/LICENSE/README（raw.githubusercontent.com）：inbox-zero `apps/web/prisma/schema.prisma`(2173 行全文)+LICENSE+README · Mail-0/Zero README · khoj README · letta README · letta-code LICENSE · cal.diy README+LICENSE · twenty LICENSE · huly README+ARCHITECTURE_OVERVIEW.md · n8n LICENSE.md · activepieces LICENSE · agent-inbox README+`src/components/agent-inbox/types.ts` · humanlayer README+LICENSE
文档站：docs.getinboxzero.com/changelog · docs.letta.com/concepts/memfs + /letta-code/memory + /v1-sdk/memory/memory-blocks · docs.khoj.dev/features/automations · docs.twenty.com（data-model/ai/self-hosting）· docs.n8n.io/build/integrate-ai/ai-examples/human-in-the-loop-for-tools · cal.com/blog/cal-diy-open-source-to-closed-source
404/取不到（如实）：docs.letta.com/concepts/memory · docs.n8n.io/advanced-ai/human-in-the-loop-tools/ · docs.getinboxzero.com/essentials/email-assistant
未验证：Huly Tx/mixin 模型与 AI 现状 · Mail-0 停摆原因
