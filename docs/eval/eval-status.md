# Sprint 19 §B Eval Harness — Status

> **Status**: harness 框架 ship 但 **未 run-through verified** (subagent
> 2026-05-23 跑了 ~14 min 写完 harness 但实际 25 scenario 没跑通,
> 缺 `docs/eval/p1-baseline.md` + `docs/eval/eval-raw.json`)
> **下次 session 接力**: 跑通 harness + 收 25 scenario pass rate 数

---

## 1. 已 ship 文件 (commit by main session, code by subagent 2026-05-23)

| 文件 | 大小 | 用途 |
|---|---|---|
| `scripts/dev/eval_chat_scenarios.ts` | 28 KB | 主 harness — 解析 `docs/eval/email_scenarios.md` 25 scenario, 调 `runHarness`, mock sink + auto-confirm, 跑完输出 `docs/eval/p1-baseline.md` + `eval-raw.json` |
| `scripts/dev/eval_smoke.ts` | 4.4 KB | 1-scenario smoke test — debug harness 用, 先跑通 1 个再 batch 25 |
| `scripts/dev/eval_electron_stub.cjs` | 1.6 KB | Electron module **CJS** stub (ipcMain/app shim) — handler 模块 import 时不崩 |
| `scripts/dev/eval_electron_stub_esm.mjs` | 1.1 KB | Electron module **ESM** stub (同上 ESM 端口) |
| `scripts/dev/eval_electron_loader.mjs` | 675 B | Node.js Loader 拦截 `from 'electron'` import 路由到 stub |
| `scripts/dev/eval_keytar_stub_esm.mjs` | 495 B | keytar (native security-store) stub — 返 null 不触发 macOS Keychain |
| `scripts/dev/eval_loader_register.mjs` | 552 B | Loader register helper (`--import` entry point) |

总 ~37 KB,~700 LOC TypeScript + JS.

## 2. 设计 (harness 内部)

`eval_chat_scenarios.ts` 流程:

1. **dotenv bootstrap**: load 项目根 `.env` (LLM_API_KEY / LLM_API_BASE /
   LLM_MODEL / 等) 到 `process.env`. Force `MAILAGENT_AGENT_HARNESS=1`,
   `AI_CHAT_DB_PATH=:memory:` (避免污染用户 chat_db), `AGENT_MAX_ITER=5`,
   `AGENT_MAX_COST_USD=0.2` (cap 每 scenario cost).

2. **Scenario extract**: 读 `docs/eval/email_scenarios.md`, 用 regex 抽
   25 个 ` ```yaml ... ``` ` block, parse 关键字段 (id, category, prompt,
   email_ctx, expected_tools, forbidden_tools, expected_substring).

3. **Fixture selection**: 默认 fixture email_id = 1000000024 (近期邮件,
   主题"答复:【风险评估】ER按照年度迭代"). 需要 has_attachments 等
   特殊 ctx 的 scenario, harness 应从 `data/sync_store.db` 自查合适
   internal_id — **此 mapping 尚未完整实现** (subagent 留作 TODO).

4. **Mock StreamSink**: 收集 chunk / tool_use / tool_result / done / error /
   pending_confirmation 事件到 array.

5. **Auto-confirm**: 收到 `pending_confirmation` event 立即调
   `resolveConfirmation(toolUseId, true)` 模拟用户 approve (eval 不能 hang).

6. **Run scenario**: 对每 prompt, 调 `runHarness` (跳 dispatcher.ts 因为
   它 `import { WebContents } from 'electron'`), 等 done event resolve.

7. **Judge pass/fail**: 简单规则 — expected_tools 至少 1 个被调 + 
   expected_substring 至少 1 个 in finalText + forbidden_tools 0 个被调.

8. **Output**: `docs/eval/eval-raw.json` (raw 数据) + `docs/eval/p1-baseline.md`
   (per-scenario 通过/失败 + cost + 总 pass rate + gate hit/miss).

## 3. 已知 issue / 跑通障碍

跑这个 harness 需要解决以下 setup 问题:

### A. Electron module import 拦截

chat 子树跨多个文件 `import { WebContents } from 'electron'` (类型) 和 main
process module `import { ipcMain, app } from 'electron'` (运行时). standalone
tsx 跑会 `Cannot find module 'electron'`. Subagent 写了 4 个 stub file
(CJS / ESM 双协议) + Node Loader register, 拦截 `electron` import 路由到
stub. 跑命令:

```bash
node --import tsx --import ./scripts/dev/eval_loader_register.mjs \
     scripts/dev/eval_chat_scenarios.ts
```

⚠️ 跑前需 verify Loader register 是否真覆盖所有 `from 'electron'` import
点. 用 `eval_smoke.ts` 先跑通 1 scenario 验证。

### B. better-sqlite3 native ABI

frontend main process 用 `better-sqlite3` (native module). standalone tsx
跑 Node 时 ABI 可能跟 frontend pnpm rebuild 的不一致 → `NODE_MODULE_VERSION
mismatch` 错误.

**Workaround**: 在 frontend dir 跑 `pnpm rebuild better-sqlite3`, 或者
harness 从 `/Users/chenyuanquan/Documents/MailAgent/frontend/node_modules/`
import.

### C. keytar (security store) native

`getLlmApiKey` 走 keytar 读 macOS Keychain → standalone Node 没 disk access
permission. Subagent 加了 keytar stub 返 null, 然后 fall back to env var
`LLM_API_KEY`. 确认 `.env` 含有效 LLM_API_KEY.

### D. Fixture mapping

不同 scenario `email_ctx` 描述差异大 (单邮件 / 有附件 / 长 thread / AI
分类过的). harness 用 1 个 fixture 跑所有 scenario 会让 ~5-8 个
scenario "fixture mismatch" 即使 LLM 表现 OK 也评判 fail. 完整的
fixture mapping 留作 TODO.

## 4. 下次接力 task

1. **Smoke run**: 跑 `scripts/dev/eval_smoke.ts` 看 1 scenario 跑通
   (~$0.05 cost). 如果挂, 修 Electron stub / better-sqlite3 ABI / keytar
   stub.

2. **Fixture mapping**: 写 `scenario_id → fixture_internal_id` 表
   (~10-15 个 entry, sqlite3 自查 data/sync_store.db 找符合 email_ctx 的
   internal_id). 加进 harness top.

3. **Batch run**: `tsx scripts/dev/eval_chat_scenarios.ts` 跑 25 scenario,
   ~$1.5-$2 token cost, ~15-30 min wall.

4. **Report**: 检查 `docs/eval/p1-baseline.md` pass rate. M1 gate ≥ 14/20 →
   翻 `MAILAGENT_AGENT_HARNESS` default flag + 合 main.

## 5. Subagent 跑了什么

2026-05-23 23:30 用户授权 spawn general-purpose subagent (isolation:
worktree, run_in_background), ~14 min runtime, ~275k tokens, 138 tool uses,
worktree path `.claude/worktrees/agent-a5df929be2cb96d49`.

Subagent 完成:
- ✅ Bootstrap harness framework (上述 7 个文件)
- ✅ scenario YAML extract + judge logic
- ✅ Electron / keytar stub
- ❌ Smoke test 跑通 (没 final report)
- ❌ 25 scenario batch run (没数据)
- ❌ p1-baseline.md / eval-raw.json (没生成)

返回的 final 字段 "Process started but no output yet" 表明 subagent 实际
卡在 smoke / batch 阶段没出 result. Token spent ($2-$3) 实际产出 = harness
代码框架, 但未跑通验证. 不视为 wasted — 后续接力直接用这套框架, 省 2-3 h
重新 bootstrap.

## 6. 风险 + 决策

- **要不要继续** 跑通 + 收 pass rate? 取决于翻 default flag 优先级.
  - Pro: dogfood 数据明确, 跟同事说 "M1 ship 通过 X% scenario gate" 比
    "我自己感觉差不多" 有说服力
  - Con: 跑通 setup 还要 1-2 h debug + $2 token

- **要不要 abandon 改人工 dogfood** (自己测 5-10 scenario UI 端)?
  - Pro: 无需 setup, 直接出反馈
  - Con: 不可重复, 后续 sprint 又要重跑测
