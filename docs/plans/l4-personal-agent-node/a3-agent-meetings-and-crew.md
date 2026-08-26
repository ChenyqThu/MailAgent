# A3 方案：事项工作群 · Agent 会议 · Agent 成员面

> 状态：方案定稿（2026-08-25 owner 三拍板），未开工；每个批次开工时另建 trellis task。
> 来源：owner 原始想法「行动项 Assign 给不同 Agent（批次 3 已落地）；Agent 之间约日程开会，
> 开会 = 一群 agent 在一个 session 里，根据事项对齐和推进任务」+ 三项拍板（见 §1）。
> 位置：L4 epic WS-A A3 的具体化，取代 README §3 A3 行的旧一句话描述；A3 原有的
> `custom_agent_call` headless 放开 + 小脑闸内核后置到 A3d。

## 1. 已拍板（owner 2026-08-25）

| # | 决策 |
|---|---|
| P1 | 会议内核 = **议程驱动轮替发言**（确定性主持人，不是 LLM 自由群聊）；呈现 = **群聊形态**：事项有任务群，群里有飞书式「话题」，会议在话题里进行，各 agent 各自发言，主持人调度点名、推进议程、形成结论或落地行动项 |
| P2 | 会议**上真日历**；日历可**按 agent 筛选**（像按邮箱筛选那样），能分别看每个 agent 的日程；**每个 agent 有详情页**（token 消耗 / 预算 / 人设 / 提示词 / 工具 / 待办任务等） |
| P3 | 会议产出**全部走提案**（纪要、决议、新派发都要 owner 采纳才落地；信任引擎 B3 起来后再逐步放权） |
| P4 | 每个 agent 有**自己的待办任务项**，可以**自己安排日程**去做 |

## 2. 概念映射（新概念全部映射到既有结构，不另起体系）

| 产品概念 | 底层实现 | 现成基建 |
|---|---|---|
| 任务群（一个事项一个群） | 事项的会话容器视图（该 matter 锚点下的全部 session） | `listSessionsForMatter` / `ai_chat_sessions.anchor` |
| 话题（群里的 thread） | 一个 session = 一个话题（会议话题 / 讨论话题 / 行动项执行话题） | 批次 3 的 `item_id` 会话锚天然是「行动项话题」 |
| 会议室 | 一个共享 session，多 agent 按序发言 | session transcript + 逐 turn 换发言者身份 |
| 发言者身份 | 每 turn 一次 LLM 调用，带该 agent 的人设/模型（后续 + 只读记忆/技能面），气泡按 agent 渲染 | bot-avatar 模块（per-agent `avatar_json`）+ 会话溯源 |
| 主持人 | **确定性代码**：从 DB 事实生成议程（派发状态/待答反问/卡点/上次会以来的进展），点名、限轮、小结；主持人文本以「主持人」身份入群 | 批次 3 dispatch 账本 + matter_progress + attention |
| 会议纪要 | 进展提案（decision/progress）+ 行动项动作提案（新派发/改期/答复），恒提案（P3） | `matter_update` 提案机制 + `item_dispatch_id` 回钩 |
| agent 待办 | 按 `executor_id` 跨事项聚合活跃派发 | `matter_item_dispatch` 已有 executor 列 |
| agent 日程 | **本地叠加轨**（纯本地表，🔴 不写 CalDAV/Exchange——agent 日程对外可见会造成组织者/与会者语义混乱，且写路径过 DavMail 风险面大）；日历 UI 与真日历同面呈现、按 agent 筛选 | calendar_event SSoT 旁挂新 source；UI 筛选轴复用 |
| agent 自排程 | agent 对自己的待办产出「计划条目」（何时做哪条）= 一条定时触发器 + 一条 agent 日程；到点触发该行动项的派发 run。计划创建本身低风险可 auto（恒可见可删），执行产出仍走提案 | TRIGGER_V2 + 批次 3 dispatch run |
| agent 详情页 | 聚合读面：人设/提示词（agent_config）、工具（能力卡）、预算（report_agent 预算）、token 消耗（run 台账 tokens 聚合）、待办（上）、日程（上） | 全部已有数据源，纯新读端点 + UI |

## 3. 成本与安全护栏（会议内核红线）

1. 🔴 主持人恒确定性代码；发言轮数 = 议程条数 × 每条 ≤2 轮 + 收尾一轮，**硬上限**；预算沿用 headless run 预算体系。
2. 🔴 **议程为空不开会**（无新进展/无卡点/无待答 → 跳过，零 token；watermark 判据抄跟进 run）。
3. 🔴 每个发言 turn 与行动项执行 run 同姿态：无写工具、连接器只读天花板、对外通信恒禁；一切落地经提案（P3）。
4. 🔴 会议不嵌套：会议里不允许再约会议、不允许 `custom_agent_call`；递归禁止不变。
5. owner 打开会议话题插话 = 转为有人在场语境（后续批细化；最小版先只支持旁听回放）。
6. 多 agent 独立上下文（真分身）后置 A3d，gate = A3a 用出真需求（15x token 教训 + 行业收敛异步任务式协作，档案 02/04）。

## 4. 拆批

| 批次 | 内容 | 依赖 |
|---|---|---|
| **A3a 会议最小版** | 会议 run kind + 确定性主持人 + 轮替发言共享 session；群聊渲染（多 agent 气泡 + 主持人身份 + avatar）；事项详情「任务群/话题」容器视图（含既有跟进/行动项话题归置）；「现在开会」手动触发；纪要与动作全提案 | 批次 3（已落地） |
| **A3b Agent 成员面** | Agent 详情页（人设/提示词/工具/预算/**token 消耗聚合**/待办/日程 tab）+ per-agent 待办队列读面（跨事项派发聚合）。纯读聚合，可与 A3a 并行 | 批次 3 |
| **A3c 约日程** | 会议定时/条件触发（复用 TRIGGER_V2/P7）；agent 本地日历叠加轨 + 日历按 agent 筛选；agent 自排程（计划条目 = 触发器 + 日程，创建 auto、产出恒提案）；会前准备材料挂会议话题（P9 模板先例） | A3a + A3b |
| **A3d 真分身**（gated） | 每 agent turn 注入自己的记忆/技能/连接器只读面；agent 主动请求临时会议（小脑闸 + hold-token 律，原 A3 内核）；`custom_agent_call` headless 放开 | A3a-c dogfood 出真需求 |

关联：agent 会议纪要是 owner 站会（B2）的输入素材；采纳率按 agent×动作类记（B3 信任引擎原料）。

## 5. 显式假设（做前再确认成本最低的三条）

- A1 agent 日程**不写 Exchange**（§2 表），日历「上真日历」理解为同一日历界面的本地叠加轨。若 owner 要的是真写 Outlook 日历，需单独评估 DavMail 写路径与对外可见性，另拍板。
- A2 「任务群」首版是**事项详情里的容器视图**，不是独立顶级域；群聊只读回放 + 手动开会先行，owner 插话的交互语境切换放 A3a 之后细化。
- A3 token 消耗统计从 run 台账现有 `tokens` 字段聚合（近似值，不含缓存细分）；精确计费面后置。
