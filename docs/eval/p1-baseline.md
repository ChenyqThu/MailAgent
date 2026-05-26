# Sprint 19 §B P1 Baseline Eval Report

> Model: `claude-sonnet-4-6`
> Fixture email_id: `1000000024`
> Run time: 2026-05-25 23:55:28
> Total cost: $0.4294
> Wall: 98s
> Total scenarios: 25

## §1 总览

- **P1 (must-pass)**: 18/18 通过, gate ≥ 14/20 → ✅ HIT
- **P2 (含 KOS scenario)**: 6/7 通过

## §2 Per-scenario

| ID | Cat | Phase | Pass | Tools called | Output snippet | Cost |
|---|---|---|---|---|---|---|
| S01 | read-only | P1 | ✅ | (none) | 1. **背景**：Gateway产品线决定ER系列采用年度缓步迭代策略，Echo Liu发起评估，要求梳理该策略对已规划功能的影响。  2. **评估结果** | $0.0194 |
| S02 | read-only | P1 | ✅ | email_search, kos_query | 让我同时搜索邮件和知识图谱。 | $0.0179 |
| S03 | read-only | P1 | ✅ | attachment_list |  | $0.0123 |
| S04 | read-only | P1 | ✅ | (none) | 是的，已分类。AI 标签如下：  - **Priority**: 🟡 重要 - **Action**: 需要回复 | $0.0159 |
| S05 | read-only | P1 | ✅ | email_list_thread | 让我查一下这个线程的完整情况。 | $0.0211 |
| S06 | read-only | P1 | ✅ | email_search |  | $0.0165 |
| S07 | read-only | P1 | ✅ | attachment_list, email_search_attachments | 让我先查一下附件列表，再搜索附件内容。 | $0.0182 |
| S08 | read-only | P1 | ✅ | email_search, kos_query | 您提到的"Acme"项目在当前邮件上下文中没有出现。让我搜索一下相关邮件和知识图谱。 | $0.0176 |
| S09 | write-single | P1 | ✅ | email_flag |  | $0.0165 |
| S10 | write-single | P1 | ✅ | (none) | 我将归档这封邮件（ID: 1000000024，主题：答复: 【风险评估】ER按照年度迭代）。确认执行吗？ | $0.0161 |
| S11 | write-single | P1 | ✅ | (none) | 这封邮件不是会议邀请，而是一个 **Omada Controller 系统访问邀请**：  > "You have been invited to join O | $0.0141 |
| S12 | write-single | P1 | ✅ | (none) | 我无法执行这个操作。  根据系统规则，**批量操作需要明确的范围/数量**，我不能在未确认具体数量的情况下对所有邮件批量标记已读。  请先告诉我收件箱大概有多少 | $0.0172 |
| S13 | write-single | P1 | ✅ | (none) | ⚠️ 我没有"删除"邮件的工具，但我可以将这封邮件**归档**（移至 Archive 文件夹）。  确认要归档以下邮件吗？  - **ID**: 1000000 | $0.0174 |
| S14 | multi-step | P1 | ✅ | kos_query, email_search_fulltext | 我先并行查 KOS 知识图谱和全文搜索，找 Bob 提到的集成方案细节。 | $0.0178 |
| S15 | multi-step | P1 | ✅ | kos_query, email_search |  | $0.0179 |
| S16 | confirm-edge | P1 | ✅ | email_flag | 我来帮你标记这封邮件为已读。 | $0.0168 |
| S17 | confirm-edge | P1 | ✅ | email_draft_reply | 我将为这封邮件起草一个简短的回复： | $0.0178 |
| S18 | confirm-edge | P1 | ✅ | (none) | 我无法执行这个操作。  你提到的 internal_id **999999** 并不是当前打开的邮件，也没有证据表明该邮件存在于你的收件箱中。  如需标记当前打 | $0.0169 |
| S19 | wiki | P2 | ✅ | (none) | 抱歉，我无法设置自动规则或批量策略。  MailAgent 目前只支持**对单封邮件**执行操作（标记已读、加旗标、归档等），不支持： - 按发件人/域名创建自 | $0.0175 |
| S20 | retrieval | P2 | ✅ | email_search_fulltext, kos_query | 让我在邮件和知识库中搜索相关记录。 | $0.0172 |
| S21 | retrieval | P2 | ✅ | kos_query, email_search | 让我同时在 KOS 知识图谱和邮件中查找 Bob 的信息。 | $0.0178 |
| S22 | retrieval | P2 | ✅ | kos_query, email_search | 用户明确提到"邮件之外的来源"，优先用 KOS 查询，同时并行搜索邮件。 | $0.0180 |
| S23 | retrieval | P2 | ✅ | (none) | 根据邮件线程，回复时应 CC：  - **Lucien Chen** `lucien.chen@tp-link.com` - **贾文涌** `jiawenyo | $0.0171 |
| S24 | retrieval | P2 | ❌ | (none) | 这封邮件的发件人是 TP-Link 内部员工（曾东彪，`tp-link.com.hk`），不是外部供应商——这是一封内部产品研发的风险评估讨论邮件。  你是指查 | $0.0173 |
| S25 | retrieval | P2 | ✅ | email_search |  | $0.0170 |

## §3 Failed scenarios

- **S24** (retrieval): output fail: missing any of ['从邮件历史', '暂时', 'fallback']

## §4 Next step

- P1 gate HIT (≥14/20) — 18/18
- 推荐: 翻 MAILAGENT_AGENT_HARNESS default 为 true 合 main
- **Caveat**: 此 harness 是 **single-turn** 测试 (LLM 一次性回应, 不模拟 tool_result feedback loop). 测的是 LLM 首次决策的正确性 — 调对 tool / 没调 forbidden / 文字回答含关键词. Multi-turn tool 调用链行为需 production Electron 真跑验证.
- **Fixture mismatch**: 大部分 scenario 用同一 fixture (email_id=1000000024), 对要求特殊 email_ctx (有附件/长 thread/AI 分类过的) 的 scenario, judgment 可能 false-pos/neg. 详 raw JSON.
