# LLM Agent 启用清单

本地 LLM（Anthropic Messages 兼容网关）接管 Notion Custom Agent（Email Agent）对邮件 AI 字段的填充。默认 **关闭**。

## 启用前置条件

按顺序完成下面 5 步，然后 pm2 restart 即可。中途任何一步不明白，先不要动。

### 1. 防双跑：在 Notion Email Agent 侧加过滤（任选 A 或 B）

本地 LLM + Notion Custom Agent 都盯着同一张邮件页。如果两边都写，`Processing Status` 会被改两次 → Notion webhook 会触发两次 → Mail.app 重复标旗 + 飞书卡片重复推送。必须让其中一边退出。

**方案 A（推荐，最轻）**：改 Notion Email Agent Instructions

打开你的 Notion Email Agent Instructions 页面，在最前面追加一句硬约束：

```
⚠️ 仅处理 Processing Status = "未处理" 的邮件；其他状态（AI Reviewed / 已同步 / 草稿已创建 / 已完成）一律跳过，不做任何字段改动。
```

本地 LLM 处理完后 `Processing Status='AI Reviewed'`（收件箱）或 `'已完成'`（发件箱），Notion Agent 读到这个状态就不会再动该页。双保险，优雅。

**方案 B**：直接禁用 Notion automation

Notion Email Inbox database → Automations → 找 Email Agent → `Disable`。简单但不可逆（重新启用时要记得去掉本地开关）。

---

### 2. 确认环境变量齐备

检查 `.env`：

```bash
# 必备（Anthropic 兼容网关）
LLM_API_BASE=https://crs.chenge.ink/api
LLM_API_KEY=cr_xxx
LLM_MODEL=claude-sonnet-4-6

# 强烈建议（Lucien 个人上下文：角色 / 重点项目 / Sender Priority 映射）
LLM_CONTEXT_PAGE_ID=e68aedeccc9b4666952f997e9dabb835

# 可选（不填则跳过 Daily Digests relation 写入）
LLM_DAILY_DIGEST_DATABASE_ID=2df15375830d8019888adaa224dcedbf
LLM_DAILY_DIGEST_REPORT_DATE_PROP=Report Date

# Prompt 文件（默认仓库内模板；想自定义改成自己的 md 路径）
LLM_INBOX_PROMPT_PATH=prompts/email_inbox.md
LLM_SENT_PROMPT_PATH=prompts/email_sent.md

# 重试/截断
LLM_MAX_RETRIES=3
LLM_BODY_MAX_CHARS=12000
LLM_TIMEOUT_SEC=60
LLM_CONTEXT_CACHE_TTL_SEC=1800
```

---

### 3. 冒烟验证（可选但推荐）

**a. 网关健康检查**（不烧 Notion）：

```bash
python scripts/run_llm_on_email.py --selftest
```

期望输出 `ok=true` + 合法 `tool_input`。如果报 `HTTP 500 "No available Claude accounts"`，稍等几分钟再试（网关上游暂时没额度）。

**b. 对一封历史邮件 dry-run**（不写 Notion）：

```bash
python scripts/run_llm_on_email.py --internal-id <任意已同步邮件> --dry-run
```

期望输出 11 字段 + `dry_run: true`。如果报 AppleScript 超时，先 `pm2 stop mail-sync`（pm2 主进程会跟 CLI 抢 Mail.app Scripting）→ 跑 CLI → `pm2 start mail-sync`。

---

### 4. 打开开关

```bash
# .env
LLM_AGENT_ENABLED=true
```

---

### 5. 重启主服务

```bash
pm2 restart mail-sync && sleep 3
pm2 logs mail-sync --lines 30 --nostream | grep -E 'llm-agent|llm-hook'
```

期望看到：

```
[llm-agent] enabled (model=claude-sonnet-4-6 base=https://crs.chenge.ink/api)
```

接下来每收到一封新邮件，主进程会在同步到 Notion 后 fire-and-forget 派发 LLM 任务，填完 AI 字段 + 写 `Processing Status='AI Reviewed'`（收件箱）/ `'已完成'`（发件箱）。

---

## 关掉

反向操作：

```bash
# 1. 关本地开关
sed -i '' 's/^LLM_AGENT_ENABLED=true/LLM_AGENT_ENABLED=false/' .env
pm2 restart mail-sync

# 2. Notion Agent 那边恢复（如果用了方案 B）
# → Notion Email Inbox → Automations → Email Agent → Enable
# 如果用的是方案 A，删掉那条"仅处理未处理"的 instruction 即可
```

---

## 日常使用

### CLI 手动重跑某封邮件

```bash
# 单封干跑
python scripts/run_llm_on_email.py --internal-id 51793 --dry-run

# 单封实跑（覆盖现有 AI 字段）
python scripts/run_llm_on_email.py --internal-id 51793 --force

# 范围回填（保留用户已手改的字段）
python scripts/run_llm_on_email.py --internal-ids 51000-51100 --force --no-overwrite
```

### 监控

```bash
# 处理分布
sqlite3 data/sync_store.db "SELECT status, COUNT(*) FROM llm_processing GROUP BY status"

# 最近失败
sqlite3 data/sync_store.db "
  SELECT internal_id, status, retry_count, substr(last_error,1,60)
    FROM llm_processing
   WHERE status IN ('failed','gave_up')
  ORDER BY updated_at DESC LIMIT 10"

# 成本/延迟
sqlite3 data/sync_store.db "
  SELECT SUM(input_tokens) AS in_tok,
         SUM(output_tokens) AS out_tok,
         ROUND(AVG(latency_ms),0) AS avg_ms,
         COUNT(*) AS n
    FROM llm_processing WHERE status='success'"
```

### 改 prompt

编辑 `prompts/email_inbox.md` / `prompts/email_sent.md`，保存即可生效（`PromptLoader` 每次 process 都会 stat 文件 mtime，改了立刻重载，无需 pm2 restart）。

---

## 失败兜底语义

- 一次失败 → `retry_count++`，指数退避（1min / 5min / 15min / 1h / 2h）重试。
- 达到 `LLM_MAX_RETRIES`（默认 3）仍失败 → 状态转 `gave_up`：
  - **不写任何 AI 字段**
  - **不动 Processing Status**（保持 "未处理"）
  - 飞书告警（warning 级别，如果 `ALERT_ENABLED=true`）
  - 交给 Notion Custom Agent 自然接手（如果它还在跑）/ 或用户手动补

---

## 常见问题

**网关 `HTTP 403 + Cloudflare error code 1010`**
缺 User-Agent。`src/llm_agent/client.py` 已内置 `MailAgent-LLM/0.1`，绕过 Cloudflare WAF。

**网关 `HTTP 500 "No available Claude accounts support the requested model"`**
网关上游 Claude 账户池暂时 exhausted，通常 5-30 分钟恢复。查 `https://crs.chenge.ink/admin-next/api-stats`。

**`cache_creation_input_tokens` / `cache_read_input_tokens` 一直是 0**
当前 `crs.chenge.ink` 上游 Anthropic 账户不支持 prompt caching。协议无报错，只是 context token 不缓存。未来账户升级自然生效。

**`pages.update` 400**
Notion select 字段 option name 漂移（用户改过 Action Type / Category / Priority 的 option 名）。处理：
1. 到 Notion database 里查真实 option 名
2. 同步改 `src/llm_agent/schema.py` 对应 enum
3. `pytest tests/llm_agent/test_schema.py` 验证

**CLI AppleScript 超时**
pm2 主服务和 CLI 两个进程同时抢 Mail.app Scripting 通道。`pm2 stop mail-sync` → 跑 CLI → `pm2 start mail-sync`。生产 hook 不受影响（同进程共享 AppleScript 连接）。

---

## 多人使用

- 每人 fork/clone 后改自己的 `.env`：`LLM_API_KEY` / `LLM_CONTEXT_PAGE_ID` / `LLM_DAILY_DIGEST_DATABASE_ID` / prompt 路径。
- 想用私人版本 prompt → 复制 `prompts/email_inbox.md` 成 `prompts/myuser_inbox.md`，`.env` 指过去。
- Notion email database schema 需要全员一致（不一致的话 LLM 输出写入会 400，改 `src/llm_agent/schema.py` 同步即可）。
- 单机单配置。多 BU 并存走 `SYNC_STORE_DB_PATH` + 独立 pm2 进程隔离（跟 Evelyn 模块同一套做法）。
