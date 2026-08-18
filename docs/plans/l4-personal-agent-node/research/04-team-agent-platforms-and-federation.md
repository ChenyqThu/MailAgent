# 调研档案 04：多人 × 多 Agent 协作平台赛道 + 个人节点联邦形态

> 调研日期：2026-08-17 · 执行：Opus 5 调研 agent
> 标注约定：**【事实】** / **【推断】**。

---

## 0. 一句话结论

**赛道已经不空了，但空的是「个人拥有的 agent」那一格。** 2026 上半年几乎所有协作面（Slack / Jira / Linear / Asana / ClickUp / 飞书 / Teams / ChatGPT）完成了「agent 成为一等成员」改造——**但全是组织拥有的 agent**。「每个人带着自己的 agent 加入团队空间」的联邦形态在 2026-01~08 同时冒出四个独立实现（OpenClaw / AAMP / Buzz / cumora BYOA）。最关键发现：**飞书 2026-04-23 开源了 AAMP——mailbox-native（SMTP/JMAP）的个人 Agent 互联协议**。

## 1. Claude Tag（Anthropic 官方 Slack）

**【事实】** 2026-06-23 发布，public beta，Team/Enterprise 限定。`@Claude` 起 session，跑在 Anthropic 托管 ephemeral sandbox，结果回帖 thread。

**多人协作语义**：一个 thread = 一个 session = 一个独立 sandbox；**频道内任何人可直接回帖转向正在跑的 session**（官方原话：会话一旦开始 *"it belongs to everyone there"*）；进已有 thread 只读 50 条。

**身份模型（与 BYOA 完全相反）**：频道里 Claude 用**自己的 service account**；权限由 org Owner 按 scope 挂 Access bundle，**同频道所有人拿到的能力完全一样**；凭证在 credential store 由 Agent Proxy 注入，sandbox 永不持有裸 key；DM 例外（用你自己的 claude.ai 账号）。

**共享 vs 私有**：一个组织**一个** agent 身份，无 per-person 实例；记忆按场所走（公开频道 → workspace memory）。**没有多 agent**、**没有任务分派/追踪语义**（没有 backlog、不能指派再跟踪）。

Anthropic 三产品分界：Claude Tag（团队权限/全频道可见）· Cowork（你的权限/只有你）· Claude Code（本地）。判据："If @Claude opens PRs as you, you're seeing Claude Code in Slack, not Claude Tag."

来源：[how-it-works](https://claude.com/docs/claude-tag/concepts/how-it-works.md) · [agent-identity](https://claude.com/docs/claude-tag/concepts/agent-identity.md) · [TechCrunch](https://techcrunch.com/2026/06/23/anthropics-claude-tag-is-learning-your-company-one-slack-message-at-a-time/)

> **含义**：Claude Tag 证明「共享 agent + 全员可转向」可行且被押注，但它是组织拥有的单一 agent，与「我的 agent、我的 context、我的凭证」正交，不是竞品。

## 2. 工作图谱工具把 agent 当 assignee（2026 已是既成事实）

**Linear for Agents（设计最干净，值得抄）**【事实】
- Agent 经 OAuth `actor=app` 成为 workspace 正式成员，有 profile 和唯一 ID。
- 核心抽象 **AgentSession**：被 @ 或委派时自动创建；activity 四型 **`thought` / `action` / `response` / `elicitation`**（elicitation = 反问用户）；收到委派 **10 秒内必须发 `thought` 确认接单**。
- 🔴 关键设计：**委派 ≠ 转移责任**——*"the human user remains the primary assignee, while the agent is added as a contributor"*（delegate-not-assignee）。
- scope 开关：`app:mentionable` / `app:assignable`。目录已有 Cursor、Codex、Devin、Sentry Seer 等 11 家；Tembo = "把活再转派给任意编码 agent"（agent 转派 agent 雏形）。

来源：[linear.app/agents](https://linear.app/agents) · [开发者文档](https://linear.app/developers/agents) · [Agent Interaction](https://linear.app/developers/agent-interaction)

**其他**【事实】：
- **Jira Agents**：assignee 下拉框直接选 agent；看板列拖入自动指派；Automation 触发；全付费档 GA。[Atlassian](https://www.atlassian.com/blog/rovo/ai-agents-in-jira)
- **GitHub Copilot coding agent**：assign issue → Actions sandbox → PR。最早跑通「assign → 交付物」闭环。
- **Asana AI Teammates**（beta）/ **ClickUp Brain 2**（agent 以真实 user 身份、可挂排程）/ Monday（预置窄 agent）。

## 3. 飞书 / 钉钉 / 企微（现实约束面）

**飞书 aily（2026-07-23 大升级）——最贴近目标的现成品**【事实】：
- 群聊/私聊/文档 @智能体；**团队共享智能体**（设定角色、喂知识、加入项目群，群里 @ 它整理需求变化/待办/风险）；个人智能伙伴（主动监控日程任务）；**多智能体协同**（"智能体队长"拆任务分派给不同 Agent）；管理员配权限边界，连消息/文档/日历/会议/任务/多维表格。
来源：[报道](https://www.163.com/news/article/L2HHS9OJ00019UD6.html) · [官网](https://www.feishu.cn/landing/feishu_aily_2026)

**飞书项目开放平台（2026-04-23 生态日）三件开放能力**【事实】：MCP（40+ 工具，月活 6000+，周调用 150 万）· 飞书项目 CLI（开源，渐进披露 + 自动 Skill 发现）· **AAMP 开源协议**（见 §5）。
来源：[量子位](https://www.qbitai.com/2026/04/406026.html) · [InfoQ](https://www.infoq.cn/article/ub0bHyfIRpbO61I876k2)

**钉钉**：AI 助理绑办公生态（日程/纪要/审批流）。**企微**：围绕客户沟通，无复杂任务执行。

> **一句话判断**：飞书生态里做「团队 agent 协作」的空间已从「做平台」缩成「做节点」——aily 把平台侧全做了，**但飞书自己开的两个口子（MCP + AAMP）恰好留给「外部个人 agent」**。

## 4. AI-native 团队工作空间创业公司

| 产品 | 形态一句话 | 成熟度 |
|---|---|---|
| **Buzz**（Block/Jack Dorsey） | 自托管 Slack 替代，建在 Nostr 上，**人和 agent 各持密钥对**，内置 Git forge，任何说 ACP 的 agent 都能进来 | 2026-07-21 发布，Apache 2.0，early stages |
| **cumora**（yetone） | 团队 chat，agent 一等成员，Cloud pod 或 BYOA | MIT，~1.1k star，极新 |
| **Helio** | AI 同事进频道接 ticket，高风险动作走审批 | 早期商业 |
| **Tanka** | 记忆优先团队 messenger（MemGraph），非 agent 平台 | 商业 |
| **Ano** | 每频道一个 Claude Code agent，本地优先 | 早期 |

**Buzz 架构要点**【事实】（联邦实现最完整）：Nostr 签名消息 + 可携带身份；**agent 拿独立密钥对**——*"authorization does not erase authorship. The agent remains the author."*；agent 跑在任何能连到 server 的地方；观察到涌现协作（"recruiting each other, splitting work into side channels"）。[Block 工程博客](https://engineering.block.xyz/blog/buzz) · [TechCrunch](https://techcrunch.com/2026/07/21/jack-dorsey-is-taking-on-slack-with-buzz-a-group-chat-platform-for-teams-and-their-ai-agents/)

**大厂补充**【事实】：OpenAI workspace agents（2026-04-22，取代 Custom GPTs，团队共享命名 agent，[公告](https://openai.com/index/introducing-workspace-agents-in-chatgpt/)）· Teams collaborative agents（SDK GA，合作方含 Linear/GitHub/Rovo/Cursor，[博客](https://devblogs.microsoft.com/microsoft365dev/build-collaborative-agents-where-work-happens/)）· Slack MCP + Real-Time Search API GA（**调用 25 倍增长**，50+ 合作方，[官方](https://slack.com/blog/news/mcp-real-time-search-api-now-available)）。

## 5. 联邦 / 互操作层（本档案最有价值部分）

- **A2A**（Linux Foundation）：150+ 组织，三大云深度集成，agent↔agent 水平协议。[一周年](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
- **MCP**：垂直（agent→工具），与 A2A 互补。
- **ACP**（Agent Client Protocol，Zed）：JSON-RPC「agent 侧通用插座」，JetBrains 合办 Registry，25+ agent 支持，Gemini CLI 原生、Claude Code/Codex 有适配器。**Buzz 和 AAMP 都选它做本地 agent 下沉接口——正在变成个人 agent 的标准插头。**[zed.dev/acp](https://zed.dev/acp)

### 🔴 AAMP（Agent Asynchronous Messaging Protocol）— 飞书开源，mailbox-native

**【事实】** [github.com/larksuite/aamp](https://github.com/larksuite/aamp)，**MIT**，维护方 Larksuite，规范 [AAMP_CORE_SPECIFICATION.md](https://github.com/larksuite/aamp/blob/main/docs/AAMP_CORE_SPECIFICATION.md) v1.1：

- 定位：*"an open protocol for asynchronous task collaboration between independent participants over ordinary mailbox infrastructure"*。
- **技术栈就是邮件**：SMTP 投递 + JMAP 同步/推送/附件，语义挂 **`X-AAMP-*` 头**。不需要自建邮件服务器。
- **身份 = 邮箱地址**；角色 Dispatcher / Executor；**会话容器 = 邮件 thread**（Message-ID / In-Reply-To / References）。
- **10 个 intent**：`task.dispatch` / `task.ack`（必须确认接单）/ `task.help_needed`（可带 SuggestedOptions 反问）/ `task.cancel` / `task.result`（completed|rejected）/ `task.stream.opened` / `pair.request` / `pair.respond` / `card.query` / `card.response`。
- **配对授权**：`aamp://connect` 一次性短时效 pair_code，用后即焚。**发现**：`/.well-known/aamp`。**安全**：信任锚在 **DKIM**（明确 MUST NOT 只信 header）。
- **本地 agent 四条接入路径**：ACP Bridge / CLI Bridge / OpenClaw 插件 / SDK（Node/Python/Go）。
- 官方演示：同事在飞书项目提需求 → AAMP 发到本地 Agent 邮箱 → agent 干活 → 结果回传。
- **成熟度：~117 star，非常早期。**

媒体解读：*"AAMP 就是给 Agent 配的 email"*；飞书动机 *"谁先把标准定下来，谁就赢了生态"*。[人人都是产品经理](https://www.woshipm.com/ai/6384119.html)

### OpenClaw——个人 agent 节点的既成事实
【事实】local-first 个人 AI 助手，IM 为主界面，24+ 渠道含飞书/微信；腾讯官方 2026-03 上线 ClawBot 插件。[Wikipedia](https://en.wikipedia.org/wiki/OpenClaw) · [CNBC](https://www.cnbc.com/2026/02/02/openclaw-open-source-ai-agent-rise-controversy-clawdbot-moltbot-moltbook.html)

### 联邦形态横向对比

| | 身份载体 | 传输 | agent 跑哪 | 团队面 | 成熟度 |
|---|---|---|---|---|---|
| AAMP | 邮箱地址（DKIM 锚） | SMTP+JMAP | 自己机器 | 飞书项目/任意 | 117★，4 个月 |
| Buzz | Nostr 密钥对 | Nostr+自托管 | 任意 | Buzz 空间 | 早期 |
| cumora BYOA | 平台账号+配对 Computer | cumora 服务器 | Mac/VPS | cumora chat | ~1.1k★ |
| OpenClaw | IM 账号 | IM bot 通道 | 自己机器 | 借微信/飞书群 | 现象级 |
| ACP | 不管身份 | JSON-RPC 本地 | 本地 | 不提供 | 事实标准 |

## 6. 综合判断（【推断】）

### (a) 新建平台 vs 寄生既有协作面：证据压倒性偏向寄生
寄生侧是**采用率**（Slack 25x 增长、Jira 全档 GA、Linear 11 家在册）；新平台侧只有**关注度**（无一家公布真实团队采用数）。结构性原因：新平台必须重建整个协作面 agent 才有活干（Buzz 自建 Git forge、cumora 自建 Kanban），Jira 只需下拉框加一行。**但所有寄生方案的 agent 都是组织拥有的——「个人拥有的 agent」缺口是真的，但它需要一个协议，不是一个新平台。**

### (b) 「个人节点 + 团队面」联邦形态：正在成型、未定型
2026-01~08 四个独立实现、三家选同一下沉接口 ACP = 收敛信号。三条共识：① agent 身份与人分离但可追溯（Linear delegate-not-assignee / Buzz "authorization does not erase authorship"——三家三方向同一结论）② agent 跑哪不由平台决定、凭证不出本机 ③ **协作是异步任务式，不是同步 chat**（AAMP 10 intent / Linear AgentSession / Claude Tag checklist 形状几乎一样）。身份载体三家三方案互不兼容 → **「共识已成、标准未定」窗口期：做实现的时候，不是等标准的时候。**

### (c) 对单人开发者最现实的切入点
**不另起平台。把 MailAgent 变成联邦网络里的「个人 agent 节点」，团队面继续用飞书。** 理由：
1. 另起平台的成本结构对单人致命（且要说服的是组织的协作习惯，不是用户）。
2. **AAMP 与 MailAgent 契合度极高**：SMTP/JMAP/thread/DKIM 全是既有资产，新写的主要是 `X-AAMP-*` 解析 + 10 intent 状态机——投入产出比全调研最悬殊。
3. AAMP 是飞书开源的，团队面现成。
4. 风险如实：AAMP 极早期有死亡概率，但实现主要是复用、沉没成本低；**押的是形状不是协议**（intent 状态机可换传输层：Buzz / Linear Agent API / cumora）。
5. **第一步与协议无关**：把「事项」升级出 AgentSession 语义（四 activity + delegate-not-assignee）——无论接哪个协议都必须做，且立刻改善单人体验。
6. **明确不做**：多人共享 agent（拼不过 org 权限/审计/SSO 入场券）。**差异化 = 私有 context + 本地凭证 + 个人所有权，那是平台结构上做不了的那一半。**

## 关键来源清单
Claude Tag：[how-it-works](https://claude.com/docs/claude-tag/concepts/how-it-works.md) · [agent-identity](https://claude.com/docs/claude-tag/concepts/agent-identity.md)
Linear：[linear.app/agents](https://linear.app/agents) · [Agent Interaction](https://linear.app/developers/agent-interaction)
Jira：[Atlassian blog](https://www.atlassian.com/blog/rovo/ai-agents-in-jira) · Asana：[官网](https://asana.com/product/ai/ai-teammates)
飞书：[aily 报道](https://www.163.com/news/article/L2HHS9OJ00019UD6.html) · [生态日/AAMP](https://www.qbitai.com/2026/04/406026.html) · **[github.com/larksuite/aamp](https://github.com/larksuite/aamp)** · **[AAMP 规范](https://github.com/larksuite/aamp/blob/main/docs/AAMP_CORE_SPECIFICATION.md)**
Buzz：[工程博客](https://engineering.block.xyz/blog/buzz) · [repo](https://github.com/block/buzz)
协议：[A2A](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year) · [ACP](https://zed.dev/acp) · [Slack MCP GA](https://slack.com/blog/news/mcp-real-time-search-api-now-available) · [OpenAI workspace agents](https://openai.com/index/introducing-workspace-agents-in-chatgpt/) · [Teams](https://devblogs.microsoft.com/microsoft365dev/build-collaborative-agents-where-work-happens/)
OpenClaw：[Wikipedia](https://en.wikipedia.org/wiki/OpenClaw) · [CNBC](https://www.cnbc.com/2026/02/02/openclaw-open-source-ai-agent-rise-controversy-clawdbot-moltbot-moltbook.html)
