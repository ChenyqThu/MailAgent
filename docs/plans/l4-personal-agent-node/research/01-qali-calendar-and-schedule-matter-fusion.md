# 调研档案 01：qali 日历客户端 + 「日程↔事项」融合的业界对照

> 调研日期：2026-08-17 · 执行：Opus 5 调研 agent（主 session 复核过本仓引用的 file:line 事实）
> 标注约定：**【事实】** = 源码/API/官方文档可核验；**【推断】** = 基于证据的判断。
> 本仓现状部分为调研当日实地 grep/read 核对所得。

---

## 1. qali 是什么 · 成熟度

**【事实】** 仓库 <https://github.com/NatnaelTaddese/qali>

| 项 | 值 |
|---|---|
| 定位（README） | "An AI-native calendar for Google Calendar" |
| 官网 slogan | "The calendar that runs itself" / **"Cursor for your daily schedules"** |
| 状态 | **Beta，仅 waitlist**，产品未公开可用 |
| Stars / Forks | **27 / 0** |
| 创建 / 最后推送 | 2026-07-09 / 2026-08-17 |
| 提交数 | 185（main） |
| License | **AGPL-3.0** —— 于 **2026-08-16/17 才加入**（此前 185 个 commit 绝大多数写于无 LICENSE 状态） |
| 贡献者 | 实质单人 |

**成熟度判断【推断】**：一个月零一周龄、单人、pre-launch 的 indie 项目；无任何外部报道/评测。但代码质量明显高于 star 数（111 个 Convex 单测 + 8 个集成测试、provider 抽象层重构、dual-write 灰度迁移纪律）。**当作"设计参考"读价值高，当作"成熟产品"看不成立。**

## 2. 功能清单

### 协议 / 账户【事实】
- **仅 Google**（Calendar API + People API）。schema 里 `provider` 已是 `"google" | "microsoft"` 联合类型但 **未切换**（PR #8 明说 provider seam "built and proven but not cut over"）。
- **无 CalDAV、无 ICS 订阅、无 Exchange/EWS。**

### 视图【事实】
- day / week / month 三视图。**没有 agenda / list 视图**（MailAgent 有四视图）。

### 交互亮点【事实】

| 能力 | 细节 |
|---|---|
| **拖拽改期** | `use-event-drag.ts`：move / resize-start / resize-end；**15 分钟吸附**；**4px 阈值**才算 drag（低于视作点击打开）；**Escape 取消并回滚**；乐观更新 + `PENDING_TIMEOUT_MS = 10000` 的 pending override，服务端同步回来自动清除，失败回滚 + toast |
| **Bottom Island** | 8 个 panel 共用同一容器；spring（stiffness 380 / damping 34）；圆角随形态变（pill 28 → card 20）；事件类 panel 共享同一宽度以求切换无缝 |
| **AI 助手** | DeepSeek，12 步 agent loop，流式；**所有写操作只出"提案"** |
| **预约链接（Cal.com 式）** | 公开 `$slug` 页 + slot picker + 周可用时间配置 + Live/Paused + 请求过期流 |
| **统一人物目录** | 保存的联系人 + Google "Other contacts" + 日历与会者三源合一 |
| **date-favicon** | canvas 把今天日期画进 favicon，读 CSS 变量跟随主题 |
| **视图转场** | View Transitions API，`prefers-reduced-motion` 降级 |

### 明确没有的【事实，逐文件核对】
- ❌ 无全局键盘快捷键 / 命令面板（与 "Cursor for…" 定位矛盾）
- ❌ 无 NL quick-add（NL 入口只有 AI 对话框）
- ❌ **无任务 / 待办 / 项目 / 笔记**（逐表核对 schema，零 task/todo/project/time-block 表）

## 3. 技术栈 · 架构 · License

- TypeScript monorepo (bun)：React + TanStack Router + Vite → Cloudflare Workers；后端 Convex（reactive serverless DB）；shadcn/ui + motion/react；Better Auth。
- **同步模型**：服务端权威 + Convex 响应式推送；写幂等扎实——`calendarOperations` 带 `idempotencyKey`，status 值域 `pending | succeeded | ambiguous | failed`（`ambiguous` 专门表达"不知道远端写没写成"）。
- **【推断】不是 local-first**：断网即不可用（MailAgent 的 CalDAV → SQLite SSoT 是相对它的结构性优势）。

### 🔴 License 警示
**AGPL-3.0，且是临开源才加的，无 CLA。** 对 MailAgent 的含义（结合 v2 头像引擎派生自 AGPL 上游的先例）：
- ✅ 读源码学**思路/模式/参数** —— 安全（思想不受版权保护）
- 🔴 抄代码/独特表达/成套 token —— 触发 AGPL，**§13 网络条款**波及 `mail.chenge.ink/app` 整个 linked work
- **结论：只抄参数不抄代码；任何"照文件写"需 owner 知情决策。**

## 4. 最值得借鉴的点

### ⭐ Propose-only 写模型 + 服务端生成 preview（最高价值）
AI 写工具从不直接碰 Google，只往 `assistantActions` 写 `status='pending'` 行，用户点 Confirm 才 `applyProposal`。三个细节：
1. **`preview` 字符串由服务端生成**而非模型自述——结构性杜绝"卡片上写的"与"实际执行的"漂移（比 MailAgent 现有 `approval.verify` 拒 raw-changed input 更强一层）。
2. **`claimAction` 原子认领**：`pending → applying` 单事务，防双击双发。
3. 状态机 `pending | applying | applied | rejected | failed`，各态独立文案，成功后自动滚动并高亮受影响事件。

> 与 Matters 跟进 Agent 的"只提案"哲学**完全一致**——第三方独立佐证，说明该模型是对的。

### ⭐ 拖拽改期的四个数值
`DRAG_THRESHOLD_PX = 4` · `SNAP = 15min` · Escape 中途取消 · `PENDING_TIMEOUT_MS = 10000` 乐观 override。可接 MailAgent 现成的 `calendar-undo` / `UndoToastStack`。

### ⭐ 人物目录按"共同开会"排序
`people` 表以 lowercased email 为合并键，`sources: ("connection"|"other"|"attendee")[]`，带 `score / meetingCount / lastMetMs / nextMeetingMs`，`by_user_and_score` 索引驱动 guest picker 排序。

## 5. MailAgent 现状核对（调研当日实地 grep + 主 session 复核）

**已经比 qali 强的**：四视图（含 agenda）、键盘层（`useCalendarShortcuts` + `key-nav`）、撤销（`calendar-undo`）、RRule 编辑器、RSVP、审批卡、local-first SQLite SSoT、CalDAV 协议面。

**qali 有而 MailAgent 没有的**：
- 🔴 **拖拽改期/改时长完全没有**（`grep -rniE "pointerdown|ondrag|draggable|resize" frontend/src/shared/components/calendar/` 零命中）
- 预约链接 / 可用时间（MailAgent 有邮件+日历+通讯录三块拼图，条件其实更好）
- 联系人的"共同会议"信号（`src/contacts/scanner.py` 只读 `email_metadata`，不读日历与会者）

## 6. 「日程↔事项」打通：业界融合模式

### qali 里零参考价值【事实】——纯日历客户端，不碰任务域。

### 业界融合模式分类学（7 种）

| 模式 | 代表 | 一句话机制 |
|---|---|---|
| 1 手动拖拽建块 | Amie、Notion Calendar、Akiflow | 侧栏任务拖到日历生成时间块，写回源字段 |
| 2 仪式化手动规划 | **Sunsama** | 每日仪式：回顾→拉取→估时→拖拽→晚间复盘 |
| 3 静默全自动排程 | **Motion**、Reclaim | 算法塞任务进空档，冲突时不经确认重排 |
| 4 预览-确认式排程 | **Morgen AI Planner** | AI 生成候选排程半透明叠加，批准才提交 |
| 5 弹性防御时间块 | Reclaim Time Defense | 块的忙闲随时间临近由"空闲"翻转"忙碌" |
| 6 纯视图层 | Notion Calendar、Vimcal | 只投影外部 DB 里"有日期的行" |
| 7 本地手动 timeboxing | Super Productivity | 原生任务 + 手动块，CalDAV 只读 |

关键单点：
- **Sunsama 是唯一公开表态"拒绝全自动排程"的公司**（规划中的摩擦是特性不是缺陷）：[When Less is More](https://www.sunsama.com/blog/when-less-is-more-building-thoughtful-products-in-the-age-of-ai)
- **Motion 差评核心 = 黑箱 + 无撤销**：[G2](https://www.g2.com/products/motionapp/reviews)
- **Reclaim Time Defense**（忙闲随临近翻转）值得单独抄：[文档](https://help.reclaim.ai/en/articles/4129290-time-defense-settings-for-habits)

### 已知失败模式（照抄前必须知道）
1. 黑箱不可解释（Motion）；2. 撤销缺失（递归自动化撤销工程上就难）；3. 一次中断级联重建；4. 规划的认知价值被消解（Sunsama 论点）；5. 动别人日历的社交风险。

### 🔴 关键洞察：MailAgent 的对标不在 task-calendar 产品里

**Matter 不是 task list**，形态接近 CRM 的 deal/case。真正同构的两条线：
- **(a) CRM Activity Capture**：HubSpot 的"会议→联系人→主公司→最近 open deal"自动关联启发式（[文档](https://knowledge.hubspot.com/object-settings/configure-automatic-activity-associations)）→ 映射为 `calendar_event.attendees → matter_contact → matter`。
- **(b) AI 会议纪要品类的公共缺口**：Granola / Fathom / Circleback 都停在"提取 action item"，**没有归宿**（[对比](https://circleback.ai/blog/granola-alternatives)）——而 MailAgent 的 `matter_item` 就是那个归宿。

## 7. 本仓接线缺口（主 session 已复核）

1. 🔴 [src/matters/triggers.py:18](../../../../src/matters/triggers.py) 文档注释明写：「会议结束」触发器被砍的**唯一原因**是 calendar 与 matter 零接线。
2. 🔴 `MatterResourceKind.EVENT`（[src/matters/models.py:56](../../../../src/matters/models.py)）是死枚举——`resource_identity.py` 无 `event_resource_key()`，全仓零引用。**插座预留好了，没通电。**
3. `src/contacts/scanner.py` 只扫 `email_metadata`——"和谁常开会"信号不存在。

## 8. 落地建议（按性价比排序）

| # | 动作 | 量级 |
|---|---|---|
| 1 | 接活 `MatterResourceKind.EVENT`：补 `event_resource_key()` | 最小 |
| 2 | 补 `calendar_event_ended` trigger（复用 P7 基建） | 小 |
| 3 | event → matter 自动关联提案（走 `resource_proposal` + 拒绝记忆，不自动写） | 中 |
| 4 | 日历拖拽改期（15min 吸附 / 4px 阈值 / Escape / 10s 乐观 override，接 `calendar-undo`） | 中 |
| 5 | contacts scanner 加"日历与会者"第三源，补 meetingCount / lastMet / nextMeeting | 中 |
| 6 | 审批卡 preview 文案改由服务端生成 | 小 |

**战略取舍**：不走 Motion 式静默自动排程；走预览-确认（Morgen/Sunsama/qali 三方一致收敛）；MailAgent 的独家机会 = "把会议变成事项的证据与节奏"（会前 prep 已有 → 会后 follow-up 缺 trigger → 与会人即干系人缺接线）。

## 主要来源

qali：[仓库](https://github.com/NatnaelTaddese/qali) · [schema.ts](https://raw.githubusercontent.com/NatnaelTaddese/qali/main/packages/backend/convex/schema.ts) · [assistant/tools.ts](https://raw.githubusercontent.com/NatnaelTaddese/qali/main/packages/backend/convex/domains/assistant/tools.ts) · [use-event-drag.ts](https://raw.githubusercontent.com/NatnaelTaddese/qali/main/apps/web/src/components/calendar/use-event-drag.ts)
业界：[Sunsama](https://www.sunsama.com/blog/when-less-is-more-building-thoughtful-products-in-the-age-of-ai) · [Motion G2](https://www.g2.com/products/motionapp/reviews) · [Reclaim Time Defense](https://help.reclaim.ai/en/articles/4129290-time-defense-settings-for-habits) · [Morgen AI Planner](https://www.morgen.so/ai-planner) · [HubSpot 自动关联](https://knowledge.hubspot.com/object-settings/configure-automatic-activity-associations) · [Circleback: Granola 替代品](https://circleback.ai/blog/granola-alternatives) · [Notion 收购 Cron](https://www.notion.com/blog/notion-acquires-cron)
