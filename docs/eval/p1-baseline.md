# Sprint 19 §B P1 Baseline Eval Report

> Model: `claude-sonnet-4-6`
> Fixture email_id: `1000000024`
> Run time: 2026-05-24 00:28:38
> Total cost: $0.4247
> Wall: 112s
> Total scenarios: 25

## §1 总览

- **P1 (must-pass)**: 16/18 通过, gate ≥ 14/20 → ✅ HIT
- **P2 (含 KOS scenario)**: 5/7 通过

## §2 Per-scenario

| ID | Cat | Phase | Pass | Tools called | Output snippet | Cost |
|---|---|---|---|---|---|---|
| S01 | read-only | P1 | ✅ | (none) | 1. **背景**：Echo Liu 发起风险评估，讨论 ER（Gateway）系列采用"一年一个版本"缓步迭代策略后，对已规划功能的影响。  2. **评估结 | $0.0193 |
| S02 | read-only | P1 | ✅ | email_search, kos_query | 让我搜索一下你与曾东彪的近期往来邮件。 | $0.0177 |
| S03 | read-only | P1 | ✅ | attachment_list | 让我查一下附件列表。 | $0.0162 |
| S04 | read-only | P1 | ✅ | (none) | 是的，已分类过。  - **Priority:** 🟢 一般 - **Action:** 仅供参考 | $0.0156 |
| S05 | read-only | P1 | ✅ | email_list_thread | 让我查一下这个线程的完整情况。 | $0.0162 |
| S06 | read-only | P1 | ✅ | email_search, email_search | 让我搜索一下本周未回复的高优邮件。 | $0.0177 |
| S07 | read-only | P1 | ✅ | attachment_list | 让我先查一下这封邮件的附件列表。 | $0.0163 |
| S08 | read-only | P1 | ✅ | email_search, kos_query | 让我搜索一下。 | $0.0167 |
| S09 | write-single | P1 | ✅ | email_flag | 好的，我来把这封邮件标记为已读。 | $0.0165 |
| S10 | write-single | P1 | ✅ | (none) | 我将归档这封邮件（内部ID: 1000000024，主题：答复: 【风险评估】ER按照年度迭代）。确认执行吗？ | $0.0159 |
| S11 | write-single | P1 | ❌ | (none) | 这封邮件并不是会议邀请——它是一个关于 **Gateway ER 年度迭代风险评估**的内部讨论串，没有提到任何会议时间或邀请。  您是否想： - **回复曾东 | $0.0170 |
| S12 | write-single | P1 | ✅ | (none) | 我无法执行这个批量操作。  根据规则，**破坏性操作（如标记已读）需要用户明确指定数量/范围**，我不能在未确认总数的情况下批量处理所有邮件。  请先告诉我：  | $0.0170 |
| S13 | write-single | P1 | ✅ | (none) | 我无法执行**删除**邮件操作——MailAgent 目前只支持**归档**（Archive）。  要将这封邮件归档，请确认：**归档邮件 #100000002 | $0.0164 |
| S14 | multi-step | P1 | ✅ | kos_query, email_search_fulltext | 我先同步查一下 KOS 知识图谱和邮件全文，看看 Bob 提到的集成方案。 | $0.0173 |
| S15 | multi-step | P1 | ✅ | kos_query, email_search | 让我搜索一下相关的会议记录。 | $0.0174 |
| S16 | confirm-edge | P1 | ✅ | email_flag | 我来帮你标记这封邮件为已读。 | $0.0165 |
| S17 | confirm-edge | P1 | ✅ | email_draft_reply |  | $0.0173 |
| S18 | confirm-edge | P1 | ❌ | (none) | 我无法执行这个操作。  你要求标记的 `internal_id: 999999` 并不是当前打开的邮件，也没有任何上下文表明这封邮件存在。  如需标记当前打开的 | $0.0167 |
| S19 | wiki | P2 | ✅ | (none) | 这两条是**批量/规则性操作**，超出了我当前单封邮件操作的权限范围。具体说明：  - **"以后 Acme 的邮件都标 P1"** — 这是一条收件规则，需要 | $0.0189 |
| S20 | retrieval | P2 | ✅ | email_search_fulltext, kos_query | 让我搜索一下。 | $0.0167 |
| S21 | retrieval | P2 | ✅ | kos_query, email_search | 让我同时查一下 Bob 的档案和最近的邮件往来。 | $0.0174 |
| S22 | retrieval | P2 | ❌ | email_search | 我来同时搜索邮件和知识图谱中关于 Acme 的信息。 | $0.0167 |
| S23 | retrieval | P2 | ✅ | (none) | 根据邮件线程，回复应 CC：  - **Lucien Chen** `lucien.chen@tp-link.com` - **贾文涌** `jiawenyon | $0.0170 |
| S24 | retrieval | P2 | ✅ | email_search, kos_query | 这封邮件来自 TP-Link 内部人员（曾东彪，zengdongbiao@tp-link.com.hk），是**内部同事而非外部供应商**。  让我查一下你与  | $0.0180 |
| S25 | retrieval | P2 | ❌ | email_search |  | $0.0167 |

## §3 Failed scenarios

- **S11** (write-single): tool fail: expected ['email_draft_reply'], called []; output fail: missing any of ['草稿', '已起草', 'Mail.app']
- **S18** (confirm-edge): tool fail: expected ['email_flag'], called []; output fail: missing any of ['不存在', '找不到', '错误', '无效']
- **S22** (retrieval): tool fail: expected ['kos_query'], called ['email_search']
- **S25** (retrieval): tool fail: expected ['kos_query'], called ['email_search']

## §4 Next step

- P1 gate HIT (≥14/20) — 16/18
- 推荐: 翻 MAILAGENT_AGENT_HARNESS default 为 true 合 main
- **Caveat**: 此 harness 是 **single-turn** 测试 (LLM 一次性回应, 不模拟 tool_result feedback loop). 测的是 LLM 首次决策的正确性 — 调对 tool / 没调 forbidden / 文字回答含关键词. Multi-turn tool 调用链行为需 production Electron 真跑验证.
- **Fixture mismatch**: 大部分 scenario 用同一 fixture (email_id=1000000024), 对要求特殊 email_ctx (有附件/长 thread/AI 分类过的) 的 scenario, judgment 可能 false-pos/neg. 详 raw JSON.
