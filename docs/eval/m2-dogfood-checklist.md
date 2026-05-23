# Sprint 19 M2 Dogfood 验收清单 (PR-2g)

> Sprint 19 M2 (Agent harness + KOS 集成) PR-2a 到 PR-2f 全部 ship 完毕,
> 默认所有 flag OFF. 这份 checklist 教你怎么按 layer 启用 + 验收每层
> 行为. 不需要全部一次开 — 按顺序 enable + verify 出问题立即定位.
>
> **快速回滚**: 任何一步出问题, 把对应 flag 改 `false` + `pm2 restart
> mail-sync` 即可. KOS 不可达 / 错误码 / token 失效都不阻塞主同步 (主路径
> Mail.app + Notion 仍 SSoT).

---

## 0. 前置

### 0.1 Python deps

```bash
cd /Users/chenyuanquan/Documents/MailAgent
source venv/bin/activate
pip install -r requirements.txt 2>&1 | tail -3
python3 -c "import pypdf, docx, pptx, calamine, httpx; print('all deps OK')"
```

期望: `all deps OK`

### 0.2 Frontend deps + rebuild native binding

```bash
cd /Users/chenyuanquan/Documents/MailAgent/frontend
pnpm install
pnpm rebuild better-sqlite3  # Node 版本变了才需要
```

### 0.3 配置在 .env (PR-2g 已写好默认 OFF)

```bash
grep -E "^(KOS_|MAILAGENT_(KOS_|AGENT_HARNESS))" /Users/chenyuanquan/Documents/MailAgent/.env
```

期望看到 7 行 KOS env (其中 `*_ENABLED=false`).

---

## Layer 1: KOS 连通性 (PR-2c, 不依赖 mail-sync)

启用条件: KOS_MCP_BASE / KOS_OAUTH_CLIENT_ID / KOS_OAUTH_CLIENT_SECRET 在 .env (已配).

### 1.1 Smoke 3 步

```bash
cd /Users/chenyuanquan/Documents/MailAgent
bash scripts/dev/kos_smoke_test.sh
```

期望输出:
```
[1/4] /health ............... OK (status=ok version=0.38.2.0 engine=postgres)
[2/4] OAuth /token .......... OK (access_token len=74 expires_in=3600s)
[3/4] MCP query "redis" ..... OK (3 hits, top score=0.881)
[4/4] Python KOSClient e2e .. OK (configured=True, query returned 3)
```

### 1.2 单测全过 (CI sanity)

```bash
source venv/bin/activate
python -m pytest tests/kos/ -q  # 期望 82 passed
cd frontend && pnpm vitest run tests/main/kos/  # 期望 80+ passed
```

---

## Layer 2: PR-2a/2b 本地 FTS5 fallback (跟 KOS 解耦)

### 2.1 中文 smart wrapper

```bash
mailagent email search "产品" --limit 3 -o json | jq '.meta.mode, .meta.transformed_query, .meta.total_hits'
```

期望:
```
"smart"
"(产品* OR (产* AND 品*))"
<number ≥ 1>
```

### 2.2 附件文本化

历史邮件还没抽过, 跑一次补 enqueue + 抽 50 个看 baseline:

```bash
mailagent attachment extract --include-missing --pending --limit 50 --dry-run
```

dry-run 看 `enqueued_missing` + `processed` 数. 真跑去 `--dry-run` 即可:

```bash
mailagent attachment extract --include-missing --pending --limit 50
```

抽完后试搜:

```bash
mailagent attachment search "redis" --limit 3 -o json | jq '.meta.total_hits'
```

期望 ≥ 1 (有 attachment 含 redis 才命中).

---

## Layer 3: M1 harness + KOS consumer (前端 chat 路径)

### 3.1 启用 flag

```bash
# .env 改:
sed -i.bak \
  -e 's/^MAILAGENT_AGENT_HARNESS=false/MAILAGENT_AGENT_HARNESS=true/' \
  -e 's/^MAILAGENT_KOS_CONSUMER_ENABLED=false/MAILAGENT_KOS_CONSUMER_ENABLED=true/' \
  -e 's/^MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED=false/MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED=true/' \
  /Users/chenyuanquan/Documents/MailAgent/.env
```

### 3.2 启动 Electron

```bash
cd /Users/chenyuanquan/Documents/MailAgent/frontend
pnpm electron:dev
```

期望主进程 console 看到:
```
[Sprint 19] registered 13 builtin tools: email_search, email_get, email_body,
  email_list_thread, email_search_fulltext, email_get_ai_fields,
  attachment_list, email_search_attachments, email_flag, email_archive,
  email_draft_reply, kos_query, kos_digest
```

> 注: `kos_query` + `kos_digest` 在 list 里 = `MAILAGENT_KOS_CONSUMER_ENABLED=true` 生效.

### 3.3 跑 M1 harness eval (20 scenario)

打开任一邮件 → BackendSelector 选 **Custom AI** → 复制 `docs/eval/email_scenarios.md` 每条 prompt 测试. 见 §10 计算 pass rate, **P1 gate ≥ 70% (14/20)**.

### 3.4 跑 PR-2e/2f KOS scenario (5 个新 case)

见 `docs/eval/email_scenarios.md` §P2 加 S21-S25.

**预期效果** (跟 M1-only 对比):
- 跨 sender / 跨 source 检索 (KOS 看到 Notion / Slack / 其他邮件)
- L1 hot block 注入 — chat 启动时已知 sender = 谁, 不用用户重复 prompt

### 3.5 KOS 调用监控

跑 1-2 个 chat turn 后:

```bash
# main process console 看 KOSClient debug log
# 期望看到: 'KOS token refreshed, expires in 3600s' 一次
# 后续 turn 无 token refresh (cache 命中)

# chat_tool_call audit 表
sqlite3 ~/.mailagent/frontend/ai_chat.db "
  SELECT tool_name, status, duration_ms
    FROM chat_tool_call
    WHERE tool_name LIKE 'kos_%'
    ORDER BY id DESC LIMIT 10"
```

期望: `kos_query` / `kos_digest` status='ok', duration_ms ~500-2000ms (取决于网络).

---

## Layer 4: PR-2d producer (mail-sync 推 KOS, 影响主同步路径!)

⚠️ **谨慎启用** — 这一步开始往 KOS 图谱写数据. 启用前推荐先用 dry-run 模式看 payload 几小时.

### 4.1 Dry-run 模式 (先看不真发)

```bash
sed -i.bak \
  -e 's/^MAILAGENT_KOS_INGEST_ENABLED=false/MAILAGENT_KOS_INGEST_ENABLED=true/' \
  -e 's/^KOS_INGEST_DRY_RUN=false/KOS_INGEST_DRY_RUN=true/' \
  /Users/chenyuanquan/Documents/MailAgent/.env
pm2 restart mail-sync
```

等 5-10 min 让新邮件流过, 看 pm2 log:

```bash
pm2 logs mail-sync --lines 100 --nostream | grep -E "kos-(hook|producer)"
```

期望:
```
[kos-hook] dispatching internal_id=54123 priority='important' floor='normal' subject='...'
[kos-producer] dry-run internal_id=54123 slug=sources/mailagent-... content_bytes=2856
```

如果看到 `[kos-producer] skip ... priority='low' < floor='normal'` 也正常 — priority floor 在工作.

### 4.2 真启用 (推 KOS)

```bash
sed -i.bak 's/^KOS_INGEST_DRY_RUN=true/KOS_INGEST_DRY_RUN=false/' /Users/chenyuanquan/Documents/MailAgent/.env
pm2 restart mail-sync
```

等新邮件 → 看 log:
```
[kos-producer] pushed internal_id=54123 slug=sources/mailagent-... status=created_or_updated
```

### 4.3 KOS 端验证 (mac mini)

```bash
# 远程 KOS 端查 mailagent 推上去的 page
ssh chenyuanquan@100.98.144.119 \
  'curl -s -X POST "https://kos.chenge.ink/mcp" \
    -H "Authorization: Bearer $(cat ~/.gbrain/oauth-clients/mailagent-tok)" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"tools/call\",\"params\":{\"name\":\"list_pages\",\"arguments\":{\"limit\":10,\"tag\":\"mailagent-ingest\"}}}" \
    | grep ^data: | sed s/^data:.// | jq'
```

期望看到几条 `sources/mailagent-...` slug. 没看到 → 检查 mail-sync log producer 是否真推了.

---

## 监控指标 (持续跑 1-2 天)

### KOS cost / latency

```bash
# Frontend chat 调 KOS 的 token / cost
sqlite3 ~/.mailagent/frontend/ai_chat.db "
  SELECT
    DATE(created_at/1000, 'unixepoch') AS day,
    COUNT(CASE WHEN tool_name LIKE 'kos_%' THEN 1 END) AS kos_calls,
    AVG(CASE WHEN tool_name LIKE 'kos_%' THEN duration_ms END) AS avg_ms,
    COUNT(CASE WHEN tool_name LIKE 'kos_%' AND status='error' THEN 1 END) AS errors
  FROM chat_tool_call
  GROUP BY day ORDER BY day DESC LIMIT 7"
```

期望: error 率 < 5%, avg_ms < 3000.

### Producer 成功率

```bash
pm2 logs mail-sync --lines 200 --nostream | grep -c "kos-producer.*pushed"
pm2 logs mail-sync --lines 200 --nostream | grep -c "kos-producer.*push failed"
```

期望 pushed >> failed.

---

## 翻 default flag 准备

跑完 dogfood 1 周, 错误率低 + pass rate ≥ 85% 后, 翻 default flag 上 main:

```bash
# 改 frontend/src/electron/main/chat/config.ts 默认 true
sed -i.bak "s/readEnvBool('MAILAGENT_AGENT_HARNESS', false)/readEnvBool('MAILAGENT_AGENT_HARNESS', true)/" \
  /Users/chenyuanquan/Documents/MailAgent/frontend/src/electron/main/chat/config.ts

# KOS flag 看是否值得默认 ON — 取决于 KOS 端可用性 + cost
# 推荐保留默认 false, 让用户 explicit opt-in (因为 KOS 是外部依赖)
```

---

## 已知限制 / 未做

- **`mailagent admin health` 不含 KOS probe**: 启动时 KOS 不可达不会立即 alert. 跑 `bash scripts/dev/kos_smoke_test.sh` 手动 verify.
- **KOS 端无 mailagent 自动 retry queue**: 推送失败邮件不重试 (主路径 Mail.app + Notion 仍 SSoT, 接受少量数据丢失).
- **L1 hot block 仅 sender digest, 不含 thread context**: 多轮 chat 上下文不会注入 sender 之外的 entity (PR-2f 限制).
- **PR-2c rate limit 50 req/15min**: 高频 chat 可能撞到 → 看 chat_tool_call 表的 `code='E_KOS_RATE_LIMIT'` 计数; 撞到了考虑降级 L1 prefetch 频率.

---

## 回滚 — 任何 layer 出问题

按 layer 反向关 flag:

```bash
# 单 flag 关 (例如 producer 出问题)
sed -i.bak 's/^MAILAGENT_KOS_INGEST_ENABLED=true/MAILAGENT_KOS_INGEST_ENABLED=false/' \
  /Users/chenyuanquan/Documents/MailAgent/.env
pm2 restart mail-sync

# 全关回 M1
sed -i.bak \
  -e 's/^MAILAGENT_AGENT_HARNESS=true/MAILAGENT_AGENT_HARNESS=false/' \
  -e 's/^MAILAGENT_KOS_INGEST_ENABLED=true/MAILAGENT_KOS_INGEST_ENABLED=false/' \
  -e 's/^MAILAGENT_KOS_CONSUMER_ENABLED=true/MAILAGENT_KOS_CONSUMER_ENABLED=false/' \
  -e 's/^MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED=true/MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED=false/' \
  /Users/chenyuanquan/Documents/MailAgent/.env
pm2 restart mail-sync
# frontend 重启 Electron 进程
```

---

## 验收 checklist (每 layer 跑完打勾)

- [ ] **L0** Python + frontend deps 完整, 单测全过 (后端 215+, 前端 251+)
- [ ] **L1.1** `kos_smoke_test.sh` 4 步全 OK
- [ ] **L1.2** `pytest tests/kos/` + `vitest tests/main/kos/` 全过
- [ ] **L2.1** `mailagent email search "产品" --limit 3` smart 模式命中
- [ ] **L2.2** `mailagent attachment extract --include-missing` 跑完无 fatal error
- [ ] **L3.1** Electron 启动 console 看到 13 个 tool 注册
- [ ] **L3.3** M1 20 scenario pass rate ≥ 70%
- [ ] **L3.4** PR-2e/2f S21-S25 KOS scenario ≥ 3/5
- [ ] **L3.5** kos_query / kos_digest 调用 audit 表 status='ok'
- [ ] **L4.1** Dry-run mode 看到 `[kos-producer] dry-run` log
- [ ] **L4.2** 真启用后 `[kos-producer] pushed` log 出现
- [ ] **L4.3** KOS 端 `list_pages` 看到 mailagent slug
- [ ] **监控** 1 周 error 率 < 5%, KOS avg_ms < 3s

跑完 ≥ 11/12 → M2 ship gate 通过, 翻 default flag 合 main.
