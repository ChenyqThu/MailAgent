---
name: db-migration
description: SQLite schema 升级（bump DB_VERSION + idempotent migration + 一致性更新）
user_invocable: true
---

# /db-migration — SQLite schema 升级清单

为 `data/sync_store.db`（当前 DB v17）安全地加列 / 建表 / 改 schema。SQLite 是本项目 SSoT，迁移必须 **idempotent + 向后兼容**（emergency 回切不丢数据）。

## 使用方式

- `/db-migration` — 交互式：先问要改什么（加列？建表？改 CHECK 枚举？）
- `/db-migration 给 calendar_event 加 reminder_minutes 列` — 直接按描述执行

## 标准流程（逐步，每步验证）

1. **定位 schema 定义**：`src/mail/sync_store.py`（`DB_VERSION` 常量 + `_init_db` / migration 块）。确认当前 `DB_VERSION`。
2. **写 idempotent migration**：
   - 加列：SQLite 无 `ADD COLUMN IF NOT EXISTS`，先 `PRAGMA table_info(x)` 判断列是否已存在再 `ALTER TABLE x ADD COLUMN ...`
   - 建表：`CREATE TABLE IF NOT EXISTS ...` + 配套 index/trigger 同样 `IF NOT EXISTS`
   - 改 CHECK 枚举：SQLite 不支持 ALTER CONSTRAINT，**只增不删**（见 `calendar_event` 保留 `legacy_calendar_app` 先例）；要去掉旧值需重建表
   - migration 必须能在已迁移的库上重复跑不报错
3. **bump `DB_VERSION`** +1，迁移逻辑放进版本分支（`if current_version < N`）。
4. **更新 CLAUDE.md** 对应 schema 速查表（字段说明 + `DB vN` 标注 + 表结构块）。
5. **跑测试**：`venv/bin/pytest tests/repository/ tests/mail/ -q`（动 EmailRepository 必跑 `tests/repository`）。
6. **副本验证**：`cp data/sync_store.db /tmp/mig_test.db`，针对副本跑一次启动/migration，确认无报错且 version 已更新。

## 死硬约束

- **emergency 回切不丢数据**：AppleScript fallback 路径始终可用，migration 不能删 / 改已有列语义。
- **CHECK 枚举只增不删**：删枚举值会让历史行违反约束。
- **大表 backfill 单独跑**（如 date_received 时区归一那种 5000+ 行），不塞进启动 migration（阻塞服务启动）。

## 失败处理

- migration 在生产库报错 → 不强推；先在 `/tmp/mig_test.db` 副本复现定位。
- 已 bump `DB_VERSION` 但 migration 漏写 → 服务启动会跳过迁移（version 已 ≥ N），需手动补 ALTER 或临时回退 version 再跑。
