---
name: health
description: 快速服务健康检查（适合定时巡检）
user_invocable: true
---

# /health — 快速健康检查

轻量级健康检查，适合定时巡检。只报告异常，正常时简洁输出。

## 流程

并行执行以下检查：

1. `pm2 jlist` — 解析 mail-sync 进程状态、PID、uptime、重启次数
2. `pm2 logs mail-sync --lines 50 --nostream` 中最近 error/critical 数量
3. `sqlite3 data/sync_store.db` — dead_letter 数量 + 最近 1 小时同步数
4. 远程 webhook：`ssh -o ConnectTimeout=5 ubuntu@170.106.181.89 "pm2 jlist"` 检查 mailagent-webhook 状态

## 输出

正常时一行总结：
```
✅ mail-sync online (PID:xxx, uptime:2d) | synced:3463 | dead_letter:4 | webhook: online
```

异常时展开详情并建议下一步操作。
