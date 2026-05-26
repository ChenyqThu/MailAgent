# Sprint 19 Next-Session Handoff (Refreshed 2026-05-25)

> **当前进度**: §A markdown 渲染 / §B 25 scenario eval / §D #3 ToolCallAuditRow / §D #4 OpenAI / §E KOS slug 全完成. §B 双 gate HIT.
> **基线 commit**: `026799a` (§B Python eval HIT). HEAD 上面还有 user calendar/island parallel push 的 commit.
> **Working tree**: clean (剩 untracked = user 之前 mockup/handoff/node_modules).

## 本 session ship 8 commits (接 b6cca13 baseline)

| # | commit | task |
|---|---|---|
| 1 | `a3f2df9` | docs §A — markdown 渲染调研 (317 行) |
| 2 | `c722a85` | feat §A — Streamdown 替换 TranslatedBody (150→32 LOC) |
| 3 | `ac59ae7` | feat §A — Copy 按钮接通 + Tailwind shadcn 渲染 setup + 中文 i18n |
| 4 | `2b984c7` | feat §D #3 — ToolCallAuditRow audit 折叠卡片 (~525 LOC net) |
| 5 | `7c9c4c6` | feat §E — KOS slug per Lucien 2026-05-23 spec |
| 6 | `c61d3d5` | feat §D #4 — OpenAI Chat Completions tool_calls 增量 SSE parser (~465 LOC net) |
| 7 | `d76ed11` | feat §B — subagent TS harness framework (abandoned, kept as ref) |
| 8 | `026799a` | feat §B — Python single-turn harness + 真跑 + **双 gate HIT** |

## 关键事件 / 决策点

1. **TranslatedBody → Streamdown** (§A): 自写 150 LOC regex + DOMPurify + auto-balance preprocess 换 Vercel Streamdown v2.5 包装 32 LOC. fix nested list / GFM table / triple ``` code block / single * italic / unterminated 流式跳动. **关键 setup 漏的**: tailwind.config.ts `content` array 加 `./node_modules/streamdown/dist/**/*.js` + `theme.extend.colors` 加 12 shadcn token (background/muted/border/...) + `index.css :root` 加 21 个 shadcn CSS vars (映射回 ink token), 否则 Streamdown 渲染 "一片白" 无样式 (复制按钮看不见).

2. **Copy 按钮 + i18n + Streamdown 中文 translations**: AssistantMessageFooter line 596-603 onClick 从 `soon` placeholder 改 `navigator.clipboard.writeText(content)`. 加 i18n `chat.messageActions.copyOk/copyFail` 中英双语. TranslatedBody 加 `STREAMDOWN_ZH_TRANSLATIONS` const 29 个 key (复制代码/已复制/复制表格/下载图表/全屏/etc.) inline hardcode 不接 i18next (markdown 控件 chrome 跟业务文案独立).

3. **ToolCallAuditRow** (§D #3): chat panel 内 LLM 调 tool 的 audit row UI. 5 step 接通: `chat:listToolCalls` IPC + ChatApi.listToolCalls + ElectronApi 实现 + HttpApi noop stub (V2 web) + MessageList AssistantBubble 渲染折叠卡片 "(使用了 N 个工具) [▶]". 流期间 skip fetch 避免抖动. **chat_db.ts:796 listToolCallsForMessage 函数已存在** 不写 DB 层. 加 i18n 4 个 key (summary plural / input / output / userEdited).

4. **KOS slug per Lucien spec** (§E): Lucien (gbrain KOS 维护者) 2026-05-23 回复 `conversations/` namespace 没人占但建议改 `chat-history/<source>/<email>/<session>/<message>` 上位 namespace 留位给未来 OpenClaw chat-save / Feishu signal-conversation. 落地 `kos_save.ts` SLUG_PREFIX = `chat-history/mailagent`, slug 用 `/` 分层, frontmatter 嵌套 `mailagent: {email_id, session_id, message_id}`, tags = `[chat-history, mailagent, conversation]`. 测试同步改 4 处.

5. **OpenAI Chat Completions tool_calls 增量 SSE** (§D #4): 之前 fallback 链命中 `gpt-5.4 / gemini-* / codex-*` 时 `isAnthropicModel` 直接 E_MODEL_UNSUPPORTED 退化, multi-turn + tool calling 全断. ship 完整 OpenAI 协议 ~465 LOC (buildOpenAiMessages / buildOpenAiTools / flattenSystemBlocksToText / OpenAiStreamState / processOpenAiEvent / openaiStream). CustomApiBackend.stream 三路: claude → anthropic, gpt|gemini|codex → openai, 其他 → unsupported. tool_calls 是 index-based 增量 merge (同 index 跨多 delta 累加 function.arguments string), finish_reason 'tool_calls'|'stop'|'length' 映射回 DoneEvent.stopReason. 无 prompt cache (OpenAI 协议限制), fallback 命中时全成本; 视为兜底而非常态.

6. **§B Python eval double gate HIT** (`026799a`): 之前 subagent TS harness (~37 KB / 7 file / d76ed11) 跑不通 — 硬塞 Electron main process 进 Node standalone 撞 deps 链 (unicorn-magic ESM exports / better-sqlite3 ABI / keytar native). **User pushback**: "测 LLM 行为不就直接调 LLM gateway 接口么". 改写 Python single-turn harness (~330 LOC + 50 LOC rejudge helper, pure stdlib urllib + sqlite3), 直调 CRS `/v1/messages` 测 LLM 给 prompt + email_ctx + 13 tool schemas 时首次决策正确性. **结果 P1 16/18 (89%) + KOS 5/7 (71%) 双 gate HIT**, cost $0.42, wall 112s.

## §B Eval 数据

| Gate | Pass | Threshold | Status |
|---|---|---|---|
| **P1 (S01-S18 must-pass)** | **16/18 (89%)** | ≥ 14/20 | ✅ HIT |
| **KOS (S19-S25)** | **5/7 (71%)** | ≥ 3/5 | ✅ HIT |
| 总 | 21/25 (84%) | — | — |

跑命令: `python3 scripts/dev/eval_chat_scenarios_simple.py` (花 $0.42)
重 judge (用现有 raw, 0 cost): `python3 scripts/dev/eval_rejudge.py`
报告: `docs/eval/p1-baseline.md`
Raw 数据: `docs/eval/eval-raw.json`

4 fail 实际:
- **S11** "起草确认参会": LLM detect 不是会议邀请 反问 → **安全行为对**, fixture mismatch
- **S18** "标 999999 已读": LLM 发现 id 不存在 → **正确 grounding**, scenario 假设过严
- **S22 / S25**: LLM 选 `email_search` 而非 `kos_query` — borderline, prompt 调优空间

真实 LLM 行为质量 ≥ 21/25, judge 假设过严 underestimate.

---

## 下个 session 推荐执行顺序

### 🔴 第一优先 — Production cutover (~30-60 min, 1 个 session 搞定)

**1. 翻 `MAILAGENT_AGENT_HARNESS` default flag** (~10 LOC)
- `frontend/src/electron/main/chat/config.ts` `isHarnessEnabled` default `false` → `true`
- 或 `.env.example` 加 `MAILAGENT_AGENT_HARNESS=true` 默认
- commit + PR 合 main
- **触发条件**: user UI dogfood 几天觉得 OK + §B 数据 back

**2. Multi-turn integration verify** (~30 min, production Electron 真跑)
- §B Python 是 single-turn, multi-turn 行为 (tool_use → tool_result → 下一步) 没真验.
- `pnpm dev` 启 Electron, chat panel 测 2-3 tool call chain scenario:
  - "查 Bob 最近邮件 + 总结他在说什么"(预期 email_search → email_body → 总结)
  - "找 'Q3 OKR' 邮件 + 看附件"(预期 email_search_fulltext → attachment_list)
- 看 chat panel 真出 ToolCallAuditRow 折叠卡片 + ConfirmDialog 真弹 + tool_result 真 feed 回 LLM
- 真跑通 → **关 Sprint 19 / 合 main**

### 🟡 第二优先 — Eval polish (可选, ~1-2h)

**3. Multi-fixture mapping** — 让 attachment/thread scenario 选对路 fixture
- 改 `scripts/dev/eval_chat_scenarios_simple.py` 加 `FIXTURE_MAP: dict[str, int]`
- 从 `data/sync_store.db` SELECT 有附件邮件 (S03/S07) / 长 thread (S05) / unread (S04)

**4. S11/S18 scenario refine** — 改 `docs/eval/email_scenarios.md` expected_substring 接受 LLM safety / grounding 行为

**5. S22/S25 prompt 调优** — system prompt 加 "包括邮件之外来源的查询优先考虑 kos_query"

**6. 重跑 eval** expect 89% → 95-96%

### 🟢 第三优先 — §C P2 chat-history (等 dogfood 数据)

**7. Cliff-summary** (~250 LOC, sliding window 跑稳 1 周后 if user 撞 20 turn 上限)
**8. Auto-push session end** (~400 LOC, privacy default OFF + Settings opt-in)
**9. KOS server-side time decay** (~50 LOC, Lucien 改 gbrain `time_decay=true` param)

### 🔵 Polish backlog

- **kos_save body 删 `# {title}` H1** (Lucien spec strict 对齐, 5 min)
- **加 `@streamdown/code` plugin** (chat code block 出 shiki syntax highlight + 行号, ~20 min, +$200KB bundle)
- **Cleanup subagent TS harness 7 file** (`d76ed11` ship 的, Python 已 cover, ~10 min `git rm scripts/dev/eval_chat_scenarios.ts scripts/dev/eval_*.{cjs,mjs} scripts/dev/eval_smoke.ts`)
- **OpenAI fallback 实测** (故意 disable Anthropic CRS 触发 fallback gpt-5.4, verify multi-turn 真跑, ~30 min)

---

## 启动 / 验证命令

```bash
cd /Users/chenyuanquan/Documents/MailAgent
git log --oneline -15  # 确认 HEAD 含 026799a (本 session 最后 commit) + user 之后 push
git status -s          # 应该 clean (剩 untracked node_modules / 旧 handoff / mockups)

cat frontend/SPRINT19-NEXT-SESSION-HANDOFF.md   # 本文件

# UI 测试 (你自己测)
cd frontend && pnpm dev

# §B 重跑 eval (~$0.42, ~2 min, 25 scenario)
python3 scripts/dev/eval_chat_scenarios_simple.py

# §B 重 judge (用现有 raw, 0 cost, 改了 judge 规则后用)
python3 scripts/dev/eval_rejudge.py

# Pre-commit verify (任何 commit 前)
cd frontend && pnpm run typecheck:web && pnpm run typecheck:node && pnpm test
# baseline: 1012/1015 passed (1 skipped, 2 fail preexisting)
```

---

## 注意事项

1. **calendar / island parallel push** — user 同时在 push F15-F23 + island Phase 2 等 commit. git add 用精确文件路径, 不要 `git add .`.
2. **Subagent TS harness 状态** — `scripts/dev/eval_chat_scenarios.ts` + 6 个 Electron/keytar stub (`d76ed11` ship 的) **保留作 future multi-turn 实跑 framework reference**, 不再 primary. Python (`026799a`) 是主入口.
3. **Cloudflare 1010** — 调 CRS gateway 必须加 User-Agent header (Python harness 已加 `MailAgent-Eval/0.1`, mirror `src/llm_agent/client.py`). 后续新 script 调 CRS 都得加.
4. **better-sqlite3 ABI rebuild** — vitest 跟 Electron / Node tsx 用不同 ABI. 切换跑 `cd frontend && pnpm rebuild better-sqlite3` 一次.
5. **Streamdown Tailwind setup** — `index.css :root` 已加 21 个 shadcn CSS vars 映射 ink token (`ac59ae7`). 若 dev server hot-reload 看到 Streamdown "一片白", 重启 vite (Tailwind 没扫到 streamdown dist class).
6. **§B eval fixture** — 默认 `DEFAULT_EMAIL_ID=1000000024` hardcode 在 script 顶部. 未来加 env override `EVAL_EMAIL_ID=xxx` (TODO).
7. **default.profraw artifact** — Python coverage 文件, 跑过 eval 后会出现在 project root. add to `.gitignore` 或手动 rm.
8. **OpenAI fallback 路径** — `c61d3d5` ship 但**没真测过** (没人手动 disable Anthropic 触发 fallback). prompt cache 不存在 (协议限制), 每 turn 全成本. 视为兜底.

---

## Context refs

| File | 用途 |
|---|---|
| `docs/eval/p1-baseline.md` | §B 报告 (per-scenario + 总览) |
| `docs/eval/eval-raw.json` | §B raw 数据 (LLM response + judgment) |
| `docs/eval/eval-status.md` | TS harness subagent attempt 状态 (历史, 不再 primary) |
| `docs/eval/email_scenarios.md` | 25 scenario YAML 定义 (S01-S25) |
| `docs/chat-markdown-streaming-research.md` | §A 调研 (Streamdown 推荐) |
| `docs/chat-history-design.md` | sliding window / cliff-summary / KOS ingest 设计 |
| `docs/kos-integration-design.md` | KOS 集成总体设计 |
| `frontend/SPRINT19-M1-HANDOFF.md` | 旧 M1 ship (历史) |
| `frontend/SPRINT19-M2-PLAN.md` | M2 PR 拆分表 (历史, 全 ✅) |

## File refs (chat agent harness 核心)

| File | 用途 |
|---|---|
| `frontend/src/electron/main/chat/dispatcher.ts:159` | startChat entry, sink 路由 |
| `frontend/src/electron/main/chat/dispatcher.ts:257` | harness gate `isHarnessEnabled && backendSupportsTools` |
| `frontend/src/electron/main/chat/harness.ts` | runHarness multi-turn loop |
| `frontend/src/electron/main/chat/backends/custom_api.ts` | Anthropic + OpenAI 双协议 backend (`c61d3d5`) |
| `frontend/src/electron/main/chat_db.ts:796` | listToolCallsForMessage (§D #3 用) |
| `frontend/src/electron/main/chat/kos_save.ts:27` | SLUG_PREFIX (§E) |
| `frontend/src/shared/components/email/TranslatedBody.tsx` | Streamdown 32 LOC (§A) |
| `frontend/src/shared/components/chat/MessageList.tsx:559` | AssistantMessageFooter (Copy 接通) |
| `frontend/src/shared/components/chat/MessageList.tsx:648` | ToolCallAuditRow (§D #3) |
| `scripts/dev/eval_chat_scenarios_simple.py` | §B Python single-turn harness |
| `scripts/dev/eval_rejudge.py` | §B re-judge raw JSON (no LLM call) |

## Last verified state

- **typecheck:web + :node**: exit 0
- **vitest**: 1012/1015 passed (1 skipped, 2 baseline preexisting fail — useBatchOps / sidebar-contract / useEmailChat mock, 跟本 session 0 关联)
- **§B eval**: P1 16/18 + KOS 5/7 = double gate HIT, $0.42, 112s
- **HEAD**: `026799a` (+ user calendar/island F15-F23 等 commits 026799a 之后)
- **branch**: `feat/agent-harness` (未合 main)
