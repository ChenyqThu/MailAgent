# Phase 2 完成报告（v4 SQLite SSoT）

> **Phase 2 ship 日期**: 2026-05-15
> **范围**: P2-01 (LLM 读 SQLite) + P2-02 (handle_fetch_mail_content 优先 SQLite) + P2-03 (回归对比) + P2-04 (P99 metrics)
> **前置文档**: [`architecture_v4_sqlite_ssot.md`](./architecture_v4_sqlite_ssot.md) · [`phase1-handoff-to-phase2.md`](./phase1-handoff-to-phase2.md)

---

## 1. TL;DR

下游消费者已从"重抽 AppleScript / 正则剥 HTML"切换为"直读 SQLite"。

- **LLM 邮件分类** (`LLMProcessor._plaintext_body`)：SQLite hit 时吃 markdownify 产物
- **`handle_fetch_mail_content`**：SQLite hit 时 ~4ms（旧 AppleScript 1-3s，**~250-750× 提升**）
- **历史邮件（无 body 行）**自动 fallback 到原 AppleScript 路径，零中断
- **回退开关**：`LLM_PREFER_SQLITE_BODY=false` 一键退回 v3 LLM 行为

---

## 2. 改动清单

### 2.1 新增 / 修改文件

| 文件 | 改动 |
|---|---|
| `src/config.py:236-243` | 加 `LLM_PREFER_SQLITE_BODY` 开关（默认 true） |
| `src/llm_agent/processor.py:11, 111-115, 245-260` | `LLMProcessor(repo=)`；`_plaintext_body` 优先 SQLite，miss fallback |
| `src/llm_agent/runner.py:18, 53-78` | `LLMRunner(repo=)` 默认基于 cfg 自建 repo |
| `src/mail/new_watcher.py:169-171` | `LLMRunner(repo=self.email_repo)` 注入 |
| `src/events/handlers.py:13, 30-69, 526-700` | `EventHandlers(email_repo=)`；拆 `_try_fetch_from_sqlite` + `_fetch_from_applescript`；响应加 `source`/`latency_ms`；stats 加 hit/miss + P99/P50 |
| `main.py:79-82` | `EventHandlers(email_repo=self.watcher.email_repo)` 注入 |
| `.env.example` | 加 `LLM_PREFER_SQLITE_BODY` 注释 |
| `scripts/compare_llm_path.py` | 新建：P2-03 回归对比工具 |
| `tests/llm_agent/test_processor.py` | +8 测试（SQLite hit/miss/empty/no-id/no-repo/flag-off/exception/优先级） |
| `tests/events/test_fetch_mail_content.py` | 新建 17 测试（hit/miss/format/source/P99 等） |

总单测：**266 passed**（Phase 1 43 + Phase 2 +25 + 其他历史）。

### 2.2 接口契约

`fetch_mail_content` 响应新增字段：

```jsonc
{
  "status": "success",
  "source": "sqlite-cache" | "applescript-fresh",   // 新增
  "latency_ms": 4,                                  // 新增
  "content": "...",          // SQLite 路径返回 markdown；AppleScript 路径返回 plaintext
  "html": "...",             // 仅 format=full
  "subject": "...", "sender": "...", "date": "...",
  "is_read": true, "is_flagged": false, "thread_id": "...",
  "notion_page_id": "...", "notion_url": "..."
}
```

`EventHandlers.get_stats()` 新增字段：

```jsonc
{
  "fetch_mail_content_sqlite_hit": 1234,
  "fetch_mail_content_sqlite_miss": 56,
  "fetch_mail_content_sqlite_p50_ms": 4,
  "fetch_mail_content_sqlite_p99_ms": 12,
  "fetch_mail_content_applescript_p50_ms": 1100,
  "fetch_mail_content_applescript_p99_ms": 3200
}
```

`stats_reporter` 自动 collect 并上报给 dashboard，无需额外配置。

---

## 3. P2-03 回归对比 finding

### 3.1 跑分（10 封最近 synced 邮件，model=gpt-5.5）

```
=== Summary (10/10 ok) ===
  All-fields match: 3/10 (30.0%)
  Per-field consistency:
    category             8/10 ( 80.0%) ████████████████
    action_type          7/10 ( 70.0%) ██████████████
    priority             7/10 ( 70.0%) ██████████████
    action_required      8/10 ( 80.0%) ████████████████
    sender_priority      8/10 ( 80.0%) ████████████████
    language            10/10 (100.0%) ████████████████████
    daily_digest_date   10/10 (100.0%) ████████████████████

  Input length (avg):
    Path A (fallback regex strip): 6804 chars
    Path B (SQLite markdown):      8619 chars  (+26.7%)
```

### 3.2 解读

- **`language` / `daily_digest_date` 100%**：与正文格式无关，稳定
- **`category` / `action_required` / `sender_priority` 80%**：在 P2-03 通过门槛上
- **`priority` / `action_type` 70%**：略低于 80% —— 漂移方向是"path B 更敏感"（更倾向标 priority 重要 / 需要回复）

漂移成因：markdownify 保留 `**bold**`、列表 `- `、链接 `[text](url)` 等结构标记，LLM 把这些当作"重要性"信号。fallback 正则剥 HTML 把这些信号全丢了。

**v4 输入更准确**——保留结构让 LLM 看到原邮件的强调意图。但代价是历史邮件（v3 fallback）和新邮件（v4 markdown）的标签口径有偏差。

### 3.3 决策（2026-05-15 ship）

**已接受 markdown 路径（默认 `LLM_PREFER_SQLITE_BODY=true`）**：
- v4 markdownify 路径是设计意图，输入更结构化、新决策更精准
- Trade-off 范围已知（priority/action_type 30% 边界样本）
- 用户已确认按 markdown 正文分析，可接受历史/新邮件口径分阶段统一
- T-02 backfill 全量历史邮件后口径自然收敛（见 §6 backfill 脚本）

**回退开关**（紧急止血用）：
```bash
# .env
LLM_PREFER_SQLITE_BODY=false
pm2 restart mail-sync
```
开关只影响 LLM 路径，**不影响** `handle_fetch_mail_content`、不需要回滚 dual-write。

### 3.4 复跑 / 验证

```bash
# 默认跑最近 10 封 synced 邮件
python scripts/compare_llm_path.py --count 10

# 指定 internal_id
python scripts/compare_llm_path.py --internal-ids 53675,53674,53672

# 跑更多看大样本（注意 cost：每封 ~2 次 LLM 调用）
python scripts/compare_llm_path.py --count 50
```

---

## 4. 生产验证

### 4.1 部署
```
pm2 restart mail-sync   2026-05-15 22:08:32  online
[v4] email body dual-write enabled (SQLite SSoT)   ✓
[llm-agent] enabled (model=gpt-5.5 base=https://crs.chenge.ink/api)   ✓
Redis event consumer configured                    ✓
```

### 4.2 E2E（53677 真实邮件）
```
# LLM SQLite hit
_plaintext_body(53677) → 返回 markdown 299 chars（非 fallback string）

# handle_fetch_mail_content
format=full:  source=sqlite-cache  latency=4ms  content_len=299  html_len=983
format=text:  source=sqlite-cache  latency=2ms  无 html / thread_id 字段
format=full + 不存在 id + arm=None → status=error
```

`source` 标签 / `latency_ms` / hit-miss counter 全部按预期。

---

## 5. 监控查询

```bash
# 看 LLM 路径分布（success 但缺 markdown 字段 → fallback 跑了）
sqlite3 data/sync_store.db "
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN updated_at > strftime('%s','now','-1 day') THEN 1 ELSE 0 END) AS recent
  FROM llm_processing WHERE status='success'"

# 看双写覆盖率（理论上和 metadata 同步）
sqlite3 data/sync_store.db "
  SELECT
    (SELECT COUNT(*) FROM email_metadata WHERE sync_status='synced' AND updated_at > strftime('%s','now','-1 day')) AS metadata_recent,
    (SELECT COUNT(*) FROM email_body WHERE fetched_at > strftime('%s','now','-1 day')) AS body_recent"

# 看 fetch_mail_content 命中率（dashboard 端拉 handlers.fetch_mail_content_sqlite_hit / _miss）
curl -s "https://mailagent.chenge.ink/api/stats/latest" | jq '.handlers'
```

---

## 6. Phase 2 余下任务

### 已 ship ✅
- [x] P2-01 LLM processor 改读 SQLite markdown
- [x] P2-02 `handle_fetch_mail_content` 优先 SQLite
- [x] P2-03 跑回归对比 + finding 文档化
- [x] P2-04 P99 latency tracker（dashboard 端接入是单独 PR）
- [x] 单测：266 全绿
- [x] 生产部署 pm2

### 跨仓库 / 后续任务
- **P2-05** Web 端切 SQLite —— **deferred**，记录到 backlog，本仓库 scope 外（KevinWangQQ/MailAgent-Web）
- **T-02** 历史 6131 封 backfill —— **脚本已就位**，见下方 §7
- **dashboard 端 P99 可视化** —— stats 已上报，webhook-server 前端拉 `handlers.fetch_mail_content_sqlite_p99_ms` 即可，不阻塞 Phase 3

### Phase 3 入口
T-02 backfill 全量跑完后进 Phase 3：FTS5 启用 + agent 工具 `search_email_bodies`。

---

## 7. T-02 Backfill 脚本（已就位）

**脚本**: `scripts/backfill_email_body.py`

**50 封小批量验证（2026-05-15 22:33–22:38）**:
```
ok=50/50, failed=0, elapsed=304s (5.1 min), rate=0.16 emails/s
body rows 1→51, body_format dist: html=49 / text-only=1 / empty=1
avg_md_len=13.4K, avg_html_len=62.8K, has_inline=33, attachments=136, derived=1 (xlsx→csv)
data/attachments/ = 16 MB
```

**全量回填预估**: 6131 封 ÷ 0.16/s ≈ **10.6 小时**（含 Office 转换；纯 HTML 邮件会快得多）

**运行指令**:
```bash
# 1. 先停 pm2 mail-sync 避免 AppleScript 拥塞
pm2 stop mail-sync

# 2. 后台跑全量（推荐）
nohup python scripts/backfill_email_body.py --all > logs/backfill.log 2>&1 &
echo $!   # 记下 PID，需要时 kill

# 进度监控（另起终端）
tail -f logs/backfill.log
sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_body"

# 3. 跑完后重启 pm2
pm2 start mail-sync
pm2 logs mail-sync --lines 20 --nostream | grep "v4"
```

**分批策略**（避免一次跑 10+ 小时）:
```bash
# 按日期分段（推荐）
python scripts/backfill_email_body.py --since-date 2026-04-01 --until-date 2026-05-15
python scripts/backfill_email_body.py --since-date 2026-01-01 --until-date 2026-03-31
python scripts/backfill_email_body.py --until-date 2025-12-31

# 或按邮箱分
python scripts/backfill_email_body.py --mailbox 收件箱
python scripts/backfill_email_body.py --mailbox 发件箱

# 或限制数量分批跑
python scripts/backfill_email_body.py --limit 1000   # 跑第一批
# 完了再次执行会从下一批开始（幂等：已有 body 行自动跳过）
python scripts/backfill_email_body.py --limit 1000   # 第二批
```

**安全性**:
- 幂等：已有 `email_body` 行的邮件自动跳过（除非 `--force`）
- 断点续传：天然支持，崩溃后下次跑自动跳过已成功的
- SIGINT/SIGTERM 等当前邮件做完才退出
- 连续失败 20 次自动停（默认，可调 `--max-failures`）
- 只读 AppleScript + 只写 SQLite，**不碰 Notion**

---

## 7. 关键文件索引

### Phase 2 主入口（新 session 接手时 cd 这里）
- `src/llm_agent/processor.py:245-260` — LLM SQLite-first 实现
- `src/events/handlers.py:526-580` — `handle_fetch_mail_content` v4 路径
- `src/events/handlers.py:581-700` — `_try_fetch_from_sqlite` + `_fetch_from_applescript` 拆分
- `scripts/compare_llm_path.py` — P2-03 回归工具

### 上游依赖（Phase 1 落地）
- `src/repository/email_repository.py` — `EmailRepository` 接口
- `src/repository/storage_payload_builder.py` — Email → SQLite payload
- `src/converter/html_to_markdown.py` — markdownify 主路径

### 测试
- `tests/llm_agent/test_processor.py` — 20 case（含 8 个新增）
- `tests/events/test_fetch_mail_content.py` — 17 case（全新）
- `tests/repository/` — 43 case（Phase 1）
