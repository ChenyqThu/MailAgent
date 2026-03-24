---
name: debug
description: 系统化排查 MailAgent 服务问题
user_invocable: true
---

# /debug — 系统化服务排查

按标准流程排查 MailAgent 各组件状态，快速定位问题。

## 使用方式

- `/debug` — 全面健康检查
- `/debug redis` — 排查 Redis 连接/消费问题
- `/debug sync` — 排查邮件同步问题
- `/debug notion` — 排查 Notion API 问题
- `/debug webhook` — 排查远程 webhook-server 问题

## 全面健康检查流程

按顺序执行，遇到异常立即深入：

### 1. 进程状态
```bash
pm2 status
```

### 2. 最近日志错误
```bash
pm2 logs mail-sync --lines 30 --nostream 2>&1 | grep -i 'error\|critical\|exception\|traceback'
```

### 3. SQLite 同步统计
```bash
sqlite3 data/sync_store.db "SELECT sync_status, COUNT(*) FROM email_metadata GROUP BY sync_status ORDER BY COUNT(*) DESC;"
```

### 4. Dead letter 队列
```bash
sqlite3 data/sync_store.db "SELECT internal_id, subject, sync_error, retry_count FROM email_metadata WHERE sync_status='dead_letter' LIMIT 10;"
```

### 5. Redis 连接状态
检查日志中是否有 Redis consumer started / Redis 断连告警

### 6. 重试队列
```bash
sqlite3 data/sync_store.db "SELECT internal_id, sync_status, retry_count, next_retry_at FROM email_metadata WHERE sync_status IN ('fetch_failed', 'failed') ORDER BY next_retry_at LIMIT 10;"
```

## 输出格式

生成简洁的状态报告表格：

| 组件 | 状态 | 详情 |
|------|------|------|
| PM2 进程 | ✅/❌ | ... |
| SQLite 雷达 | ✅/❌ | ... |
| Redis 消费 | ✅/❌ | ... |
| Notion 同步 | ✅/❌ | ... |
| Dead letter | ⚠️/✅ | N 条 |

发现问题时给出具体修复建议。
