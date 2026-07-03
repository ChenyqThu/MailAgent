---
name: db-migration
description: SQLite schema 升级（bump DB_VERSION + idempotent migration + 一致性更新）
user_invocable: true
---

# /db-migration — SQLite schema 升级清单

为 `data/sync_store.db`（当前版本看 `src/mail/sync_store.py` 的 `DB_VERSION` 常量，勿信文档硬编码）安全地加列 / 建表 / 改 schema。SQLite 是本项目 SSoT，迁移必须 **idempotent + 向后兼容**（emergency 回切不丢数据）。

## 使用方式

- `/db-migration` — 交互式：先问要改什么（加列？建表？改 CHECK 枚举？）
- `/db-migration 给 calendar_event 加 reminder_minutes 列` — 直接按描述执行

## 标准流程（逐步，每步验证）

1. **定位 schema 定义**：`src/mail/sync_store.py`（`DB_VERSION` 常量 + `_init_database` / migration 块）。确认当前 `DB_VERSION`。
2. **写 idempotent migration**：
   - 加列：SQLite 无 `ADD COLUMN IF NOT EXISTS`，先 `PRAGMA table_info(x)` 判断列是否已存在再 `ALTER TABLE x ADD COLUMN ...`
   - 建表：`CREATE TABLE IF NOT EXISTS ...` + 配套 index/trigger 同样 `IF NOT EXISTS`
   - 改 CHECK 枚举：SQLite 不支持 ALTER CONSTRAINT，**只增不删**（见 `calendar_event` 保留 `legacy_calendar_app` 先例）；要去掉旧值需重建表
   - migration 必须能在已迁移的库上重复跑不报错
3. **bump `DB_VERSION`** +1，迁移逻辑放进版本分支（`if current_version < N`）。**同步前端 `frontend/src/electron/main/backend_lifecycle.ts` 的 `EXPECTED_DB_VERSION`**（TS 手抄常量，`frontend/tests/main/db_version_consistency.test.ts` 兜底）。
4. **更新 CLAUDE.md** 对应 schema 速查表（字段说明 + `DB vN` 标注 + 表结构块）。
5. **跑测试**：`venv/bin/pytest tests/repository/ tests/mail/ -q`（动 EmailRepository 必跑 `tests/repository`）。
6. **副本验证**：`cp data/sync_store.db /tmp/mig_test.db`，针对副本跑一次启动/migration，确认无报错且 version 已更新。

## 迁移守卫纪律（E0-WP3，2026-07 起强制）

`_init_database` 已带三条守卫，新迁移块**默认继承**这套纪律，不得开倒车：

1. **禁止吞真失败**：ALTER / 建索引不许写 `except sqlite3.OperationalError → logger.warning("skipped") → 继续`。PRAGMA 预检已挡「列已存在」，except 抓到的只会是真失败（disk I/O / malformed / locked）——except 分支必须复查目标对象，仍缺失即 raise：
   ```python
   try:
       cols = {r[1] for r in cursor.execute("PRAGMA table_info(t)").fetchall()}
       if "new_col" not in cols:
           cursor.execute("ALTER TABLE t ADD COLUMN new_col TEXT")
   except sqlite3.OperationalError as e:
       # 复查 + 真失败 raise SyncStoreMigrationError（缺失即中断，version 不前进）
       _migration_guard_columns(cursor, "t", {"new_col"}, "vN migration", e)
   # 建索引类迁移用 _migration_guard_index(cursor, "index_name", "vN migration", e)
   ```
2. **version 只在全部迁移成功后写**：任何迁移块 raise 都会中断 `_init_database_impl`，末尾的 `db_version` INSERT 与 commit 不执行 → 下次启动以旧 version 重试。**不要**在迁移块内部提前写 version、不要把 version 写入挪进 try。
3. **降级守卫**：入口处 `current_version > DB_VERSION → raise SyncStoreMigrationError`（库来自更新版本的 app，拒启动防静默降级）。前端 `EXPECTED_DB_VERSION` 门控是 `>=` 容错，与此不冲突，勿动 TS 门控。

单测参照 `tests/mail/test_sync_store_migration_guard.py`（真实类型注入代理模拟 ALTER 失败 → 断言 version 不前进 + 重试成功）。

## 死硬约束

- **emergency 回切不丢数据**：AppleScript fallback 路径始终可用，migration 不能删 / 改已有列语义。
- **CHECK 枚举只增不删**：删枚举值会让历史行违反约束。
- **大表 backfill 单独跑**（如 date_received 时区归一那种 5000+ 行），不塞进启动 migration（阻塞服务启动）。

## 失败处理

- migration 在生产库报错 → 不强推；先在 `/tmp/mig_test.db` 副本复现定位。
- migration 真失败（E0-WP3 后）→ 服务 fail-fast 退出、version 停在旧值：修好根因后重启即自动重试，**无需**手动回退 version。
- 已 bump `DB_VERSION` 但 migration 漏写 → 服务启动会跳过迁移（version 已 ≥ N），需手动补 ALTER 或临时回退 version 再跑。
- 启动前损坏兜底：`run_startup_db_safety`（E0-WP2，`src/mail/db_safety.py`）在 serve 启动早期做 quick_check + 滚动备份到 `<DATA_ROOT>/data/backups/`；恢复步骤见 `docs/reference/packaging/packaging-release.md`「数据恢复」。
