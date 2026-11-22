"""
SyncStore - 邮件同步状态存储模块 (v3 架构)

v3 架构变更：
- internal_id (SQLite ROWID = AppleScript id) 作为主键
- message_id 作为 UNIQUE 约束（AppleScript 成功后填充，用于去重）
- 合并 sync_failures 到 email_metadata（统一重试机制）
- 新增 next_retry_at 字段（指数退避）

状态流转：
    pending -> fetch_failed -> (retry) -> synced/failed
    pending -> synced
    pending -> failed -> (retry) -> synced/dead_letter
    * -> (物理删除)  (message_id 撞上已 synced 的真身 = 重复行, 见 update_after_fetch)

Usage:
    store = SyncStore("data/sync_store.db")

    # v3 架构：用 internal_id 保存
    store.save_email({
        'internal_id': 41457,
        'mailbox': '收件箱',
        'subject': 'Test',
        'sync_status': 'pending',
    })

    # AppleScript 成功后更新
    store.update_after_fetch(41457, {
        'message_id': '<xxx@example.com>',
        'thread_id': '<yyy@example.com>',
        'subject': 'Test (updated)',
    })

    # 标记同步成功
    store.mark_synced_v3(41457, notion_page_id)

    # 兼容旧 API（使用 message_id）
    store.mark_synced(message_id, notion_page_id)
"""

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, List, Optional, Set, Any, Iterator
from loguru import logger

from src.mail.email_address import derive_sender_email  # noqa: F401  (re-export / helpers)
# Draft→Sent 提升判定用的 mailbox label 集合（见 _save_email_v3 cross-backend merge）。
# issue #42 C 案起单源迁至 src/mail/mailbox_semantics.py，此处 re-export 保兼容
# （历史 import 点：services/mail_write.py / new_watcher.py 等）。
from src.mail.mailbox_semantics import (  # noqa: F401  (re-export)
    DRAFT_MAILBOX_LABELS,
    SENT_MAILBOX_LABELS,
    SENT_CANONICAL_LABEL,
    is_sent_mailbox,
)
# 本模块自用（非 re-export）: 内建 mailbox 的列表/计数面一律走变体展开 + IN 谓词。
from src.mail.mailbox_semantics import (
    INBOX_LABEL,
    filter_labels_for_mailbox,
    sql_in_predicate,
)
from src.mail.sync_store_migrations import run_migrations
from src.mail.sync_store_schema import (  # noqa: F401  (re-export for compatibility)
    AGENT_RUN_LOG_INDEX_DDLS,
    AGENT_RUN_LOG_TABLE_DDLS,
    CONTACT_INDEX_DDLS,
    CONTACT_SUGGESTION_INDEX_DDLS,
    CONTACT_SUGGESTION_TABLE_DDLS,
    CONTACT_TABLE_DDLS,
    CONTACT_V67_INDEXES,
    EmailMetadata,
    FOLDER_PREF_INDEX_DDLS,
    FOLDER_PREF_TABLE_DDLS,
    FolderGates,
    KOS_INGEST_LOG_INDEX_DDL,
    KOS_INGEST_LOG_RETRY_COLUMNS,
    KOS_INGEST_LOG_TABLE_DDL,
    LLM_PROCESSING_INDEX_DDLS,
    LLM_PROCESSING_TABLE_DDL,
    MATTER_INDEX_DDLS,
    MATTER_ITEM_DISPATCH_INDEX_DDLS,
    MATTER_ITEM_DISPATCH_TABLE_DDLS,
    MATTER_PROGRESS_INDEX_DDLS,
    MATTER_PROGRESS_TABLE_DDLS,
    MATTER_STAKEHOLDER_CONTACT_INDEX_DDL,
    MATTER_TABLE_DDLS,
    MATTER_UPDATE_ITEM_DISPATCH_INDEX_DDL,
    NOTIFICATION_INDEX_DDLS,
    NOTIFICATION_TABLE_DDLS,
    RESOURCE_VERSION_INDEX_DDL,
    RESOURCE_VERSION_TABLE_DDL,
    SENDER_EMAIL_BACKFILL_CHUNK,
    SyncStoreMigrationError,
    SyncStoreStats,
    UpdateAfterFetchResult,
    _UNSET,
    _V61_HEADINGS,
    _backfill_sender_email,
    _folder_pref_seed_rows,
    _local_tz,
    _migration_guard_columns,
    _migration_guard_index,
    _normalize_date_received_iso,
    _storage_message_id,
    ensure_kos_ingest_log_schema,
    split_legacy_matter_description,
)


#: 本进程已经完整 init 过的库文件, 键 = (绝对路径, st_dev, st_ino)。
#: 见 `SyncStore._init_database_impl` 里的门闩注释; 测试要重放迁移时可以 `.clear()`。
_INITIALIZED_DBS: set[tuple] = set()


class SyncStore:
    """邮件同步状态存储 - v3 架构（internal_id 为主键）

    Schema DDL 常量与辅助定义位于 ``src.mail.sync_store_schema``，
    v3..v75 历史版本迁移位于 ``src.mail.sync_store_migrations``。
    """

    DB_VERSION = 75
    def __init__(self, db_path: str = "data/sync_store.db"):
        """初始化同步存储

        Args:
            db_path: SQLite 数据库文件路径
        """
        self.db_path = Path(db_path)
        self._ensure_directory()
        self._init_database()
        logger.info(f"SyncStore initialized: {self.db_path}")

    def _ensure_directory(self):
        """确保数据目录存在"""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def _get_connection(self) -> sqlite3.Connection:
        """获取数据库连接"""
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")  # v4: CASCADE / SET NULL 生效必需
        return conn

    @contextmanager
    def _connection(self):
        """数据库连接上下文管理器

        确保连接正确关闭，即使发生异常。

        Usage:
            with self._connection() as conn:
                cursor = conn.cursor()
                ...
        """
        conn = self._get_connection()
        try:
            yield conn
        finally:
            conn.close()

    def _init_latch_key(self) -> Optional[tuple]:
        """进程内 init 门闩的键 = (绝对路径, st_dev, st_ino)。

        文件不存在 (首次建库) 或 stat 失败 → None = 不走门闩, 老老实实跑完整 init。
        """
        try:
            stat = self.db_path.stat()
        except OSError:
            return None
        return (str(self.db_path.resolve()), stat.st_dev, stat.st_ino)

    def _init_database(self):
        """初始化数据库表结构（v3 架构）

        E0-WP3: 迁移真失败 / 降级守卫会从 _init_database_impl 中 raise —— 这里兜底
        关闭连接 (未 commit 的事务随 close 自动 ROLLBACK), 防止异常 traceback 持有
        frame 导致连接 (及其写锁) 悬挂, 随后把异常原样上抛给调用方 fail-fast。
        """
        conn = self._get_connection()
        try:
            self._init_database_impl(conn)
        except BaseException:
            try:
                conn.close()
            except Exception:
                pass
            raise

    def _init_database_impl(self, conn):
        """_init_database 的实际建表 + 迁移体 (拆出以便异常路径统一释放连接)。"""
        cursor = conn.cursor()

        # 同步状态表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at REAL
            )
        """)

        # 检查是否需要迁移
        cursor.execute("SELECT value FROM sync_state WHERE key = 'db_version'")
        row = cursor.fetchone()
        current_version = int(row['value']) if row else 1

        # E0-WP3 降级守卫: 库版本比代码新 → 拒绝启动 (防旧版 app 打开新库后
        # 把 db_version 静默降回、或按旧语义误写新 schema)。前端 backend_lifecycle.ts
        # 的 EXPECTED_DB_VERSION 门控是 `>=` 容错 (不会拦更新的库), Python 侧在这里
        # fail-fast 是有意行为 —— 两者不冲突 (TS 照常开窗, serve 拒起并留明确日志)。
        # 🔴 守卫必须排在下面的进程内门闩**之前**: 门闩只跳过 DDL 重放, 不能顺带
        # 把「库被更新版本的 app 迁过了」这件事也跳过去。
        if current_version > self.DB_VERSION:
            # raise 由 _init_database 外层兜底 close 连接 (ROLLBACK), 这里不重复 close
            raise SyncStoreMigrationError(
                f"数据库 db_version={current_version} 高于本版本支持上限 "
                f"{self.DB_VERSION} —— 该数据库来自更新版本的 MailAgent。"
                f"请升级 App, 或从 backups/ 恢复与当前版本匹配的数据库备份 "
                f"(拒绝启动以防旧代码降级新库)。"
            )

        # 进程内门闩: 同一个库文件已经在本进程里跑完过一遍完整 init, 且它现在正好停在
        # 本版本 —— 后面那一百多条 `CREATE … IF NOT EXISTS` + PRAGMA 探列全是空转。
        # serve-api 每个请求 new 一个 ServiceContext ⇒ new 一个 SyncStore, 活库 log
        # 实测 37 秒内跑了 16 次全量 init, 全在共享的事件循环上。
        # 🔴 门闩键含 (dev, ino): 测试常「同一路径删掉重建」, 只按路径记会让第二个库
        #    静默拿不到建表。
        # 🔴 条件里的 `current_version == self.DB_VERSION` 是第二道保险: 库被人手工
        #    降版(迁移重放测试的标准手法)后必须重跑迁移, 不能被门闩挡住。
        latch_key = self._init_latch_key()
        if latch_key is not None and latch_key in _INITIALIZED_DBS:
            if current_version == self.DB_VERSION:
                conn.close()
                return
            _INITIALIZED_DBS.discard(latch_key)

        if not run_migrations(conn, cursor, current_version, self.db_path):
            conn.close()
            return
        # 更新数据库版本 —— E0-WP3: 只有**全部迁移成功**才会执行到这里。任何迁移块
        # 真失败都会 raise (见 _migration_guard_columns/_migration_guard_index),
        # 沿栈中断本函数 → 本 INSERT 与末尾 commit 都不执行, version 停在旧值 →
        # 下次启动以旧 version 重跑迁移 (各块 PRAGMA/IF NOT EXISTS 幂等, 已落地的
        # 半程不碍重试; 事务内未 commit 的部分随连接回收 ROLLBACK)。
        cursor.execute("""
            INSERT OR REPLACE INTO sync_state (key, value, updated_at)
            VALUES ('db_version', ?, ?)
        """, (str(self.DB_VERSION), time.time()))

        conn.commit()
        conn.close()
        # 只有全程跑到这里 (= 迁移全成功且版本已落库) 才记门闩; 任何一块 raise 都不会
        # 走到这, 下次构造照常重跑。键在 commit 后重取: 首次建库时进函数那会儿文件还
        # 不存在, 拿不到 inode。
        latch_key = self._init_latch_key()
        if latch_key is not None:
            _INITIALIZED_DBS.add(latch_key)
        logger.debug(f"Database tables initialized (v{self.DB_VERSION})")

    # ==================== 同步状态操作 ====================

    def get_state(self, key: str) -> Optional[str]:
        """获取同步状态值

        Args:
            key: 状态键名

        Returns:
            状态值，不存在返回 None
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute(
                    "SELECT value FROM sync_state WHERE key = ?",
                    (key,)
                )
                row = cursor.fetchone()
                return row['value'] if row else None

            except sqlite3.Error as e:
                logger.error(f"Failed to get state {key}: {e}")
                return None

    def set_state(self, key: str, value: str) -> bool:
        """设置同步状态值

        Args:
            key: 状态键名
            value: 状态值

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    INSERT OR REPLACE INTO sync_state (key, value, updated_at)
                    VALUES (?, ?, ?)
                """, (key, value, time.time()))
                conn.commit()
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to set state {key}: {e}")
                conn.rollback()
                return False

    def get_last_max_row_id(self) -> int:
        """获取上次记录的最大 row_id"""
        value = self.get_state('last_max_row_id')
        return int(value) if value else 0

    def set_last_max_row_id(self, row_id: int) -> bool:
        """设置最大 row_id"""
        return self.set_state('last_max_row_id', str(row_id))

    def has_last_max_row_id(self) -> bool:
        """marker 键是否已持久化（区分「真·首次运行」与「合法持久化的 0」, finding F1）。

        get_last_max_row_id() 对「键缺失」和「存了 '0'」都返回 0，无法区分。new_watcher
        首次运行判定必须用本方法——键存在即恢复（哪怕值是 0）：否则 applescript 空邮箱
        baseline 0 重启后被误判首次 → 重定基线 → 停机期间到达的首封邮件被静默跳过。
        """
        return self.get_state('last_max_row_id') is not None

    def clear_last_max_row_id(self) -> bool:
        """删除 marker 键（issue #34 reset：强制上层走 first-run baseline）。

        不能用 set_last_max_row_id(0)：F1 修复后「键存在即恢复」会把 reset 写的 0 当合法
        baseline 恢复 → 跨 backend 沿用外来 id 空间 → 重演 silent-loss/deadlock。删键后
        has_last_max_row_id() 返回 False，上层在当前 backend 重定基线。
        """
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute("DELETE FROM sync_state WHERE key = 'last_max_row_id'")
                conn.commit()
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to clear last_max_row_id: {e}")
                conn.rollback()
                return False

    def reconcile_marker_backend(self, current_backend: str) -> str:
        """issue #34: 防跨 backend 复用 last_max_row_id（不同 id 空间）。

        last_max_row_id 在 applescript 是 Mail.app ROWID、在 davmail 是 IMAP UID，
        两个空间量级/含义都不同。切 backend 时若沿用旧 marker，get_new_emails 会发
        ``UID {外来marker+1}:*``，命中 silent-loss（跳过整段未取区间 → 丢数据）或
        deadlock（超时重刷巨量 → 卡死）。启动时调用一次，按需把 marker 归一到当前 backend。

        用 sync_state KV（key='marker_backend'）记录「当前 marker 属于哪个 backend」，
        复用现有通用 KV 表，无需 schema 变更 / DB_VERSION bump。

        Returns 采取的动作:
          'first'  — 尚无 marker（真·首次运行）；上层 baseline 分支会盖 owner。
          'adopt'  — 本 guard 首次部署遇到既有 marker：认领为当前 backend、不重置
                     （不扰动存量稳态用户）。
          'noop'   — marker 已属当前 backend，无需动。
          'reset'  — marker 属于别的 backend（外来 id 空间）→ 删键，强制上层走 first-run
                     baseline，在新空间重新定基线（只向前，不回捞历史 gap）。
        """
        marker_backend = self.get_state('marker_backend')
        if self.get_state('last_max_row_id') is None:
            # 真·首次运行：无 marker（键缺失）。合法持久化的 '0'（空邮箱 baseline）不再
            # 短路成 'first'——否则跨 backend 的 '0' marker 会绕过下面的归属校验，被上层
            # 「键存在即恢复」(finding F1) 当合法 baseline 恢复 → 重演 #34 id-space 混用。
            return 'first'
        if marker_backend is None:
            # 本 guard 首次部署遇到既有 marker（升级前写的、无归属记录）。**不能盲目认领**当前
            # backend（reporter 场景：升级拿到 fix + 同时切 davmail，盲目 adopt 会把 applescript 的
            # marker 当 davmail 用 → 重演 silent-loss/deadlock）。按 email_metadata 推断归属
            # （codex HIGH + 复审 NEW-ISSUE）：
            #   ① 当前 backend 有既有行 → marker 可信属它 → adopt；
            #   ② 当前 backend 零行但有别的 backend 的行 → 检测到切换 → reset（marker 属外来 id 空间）；
            #   ③ email_metadata 全空 → marker 是孤立 baseline（从别的 backend 切来必留其行，空表即
            #      无切换证据；如全新 davmail 首跑 baseline 了 UIDNEXT 但零邮件入库）→ adopt，不 reset
            #      （否则会误跳过停机期间到达的邮件，codex 复审 NEW-ISSUE）。
            if self._has_rows_for_backend(current_backend):
                self.set_state('marker_backend', current_backend)
                return 'adopt'
            if self._has_any_email_rows():
                self.clear_last_max_row_id()
                self.set_state('marker_backend', current_backend)
                return 'reset'
            self.set_state('marker_backend', current_backend)
            return 'adopt'
        if marker_backend == current_backend:
            return 'noop'
        self.clear_last_max_row_id()
        self.set_state('marker_backend', current_backend)
        return 'reset'

    def _has_rows_for_backend(self, backend: str) -> bool:
        """email_metadata 是否有该 backend 写入的行（judge marker 归属用，codex HIGH）。

        探测失败（DB 错，近乎不可能）→ 保守返回 True（认领、不重置），避免因瞬时错误
        误 reset 掉稳态用户离线期间到达的邮件（reset 只向前定基线、不回捞）。
        """
        try:
            with self._connection() as conn:
                row = conn.execute(
                    "SELECT 1 FROM email_metadata WHERE backend_origin = ? LIMIT 1",
                    (backend,),
                ).fetchone()
                return row is not None
        except sqlite3.Error as e:
            logger.warning(f"[marker-guard] backend_origin 探测失败: {e}; 保守视作有行(adopt)")
            return True

    def _has_any_email_rows(self) -> bool:
        """email_metadata 是否有任何行（区分「空表孤立 baseline」与「切换」，codex 复审 NEW-ISSUE）。

        探测失败 → 保守返回 True（配合上层：当前 backend 零行 + 探测失败 → reset；但探测失败
        近乎不可能，且真·空表下 _has_rows_for_backend 也会走同一 conn，实践中不触发）。
        """
        try:
            with self._connection() as conn:
                row = conn.execute("SELECT 1 FROM email_metadata LIMIT 1").fetchone()
                return row is not None
        except sqlite3.Error as e:
            logger.warning(f"[marker-guard] email_metadata 空表探测失败: {e}; 保守视作有行")
            return True

    def get_last_sync_time(self) -> Optional[str]:
        """获取上次同步时间（ISO 格式）"""
        return self.get_state('last_sync_time')

    def set_last_sync_time(self, time_str: str) -> bool:
        """设置上次同步时间"""
        return self.set_state('last_sync_time', time_str)

    # ==================== v3 架构：internal_id 操作 ====================

    def get(self, internal_id: int) -> Optional[EmailMetadata]:
        """通过 internal_id 获取邮件元数据

        Args:
            internal_id: 邮件内部 ID (SQLite ROWID = AppleScript id)

        Returns:
            邮件数据字典，不存在返回 None
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT * FROM email_metadata WHERE internal_id = ?
                """, (internal_id,))

                row = cursor.fetchone()
                if row:
                    return dict(row)
                return None

            except sqlite3.Error as e:
                logger.error(f"Failed to get email by internal_id: {e}")
                return None

    def get_by_message_id(self, message_id: str) -> Optional[EmailMetadata]:
        """通过 message_id 获取邮件元数据

        Args:
            message_id: 邮件 Message-ID (RFC 2822)

        Returns:
            邮件数据字典，不存在返回 None
        """
        if not message_id:
            return None

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT * FROM email_metadata WHERE message_id = ?
                """, (message_id,))

                row = cursor.fetchone()
                if row:
                    return dict(row)
                return None

            except sqlite3.Error as e:
                logger.error(f"Failed to get email by message_id: {e}")
                return None

    def delete(self, internal_id: int) -> bool:
        """通过 internal_id 删除邮件记录

        Args:
            internal_id: 邮件内部 ID

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute(
                    "DELETE FROM email_metadata WHERE internal_id = ?",
                    (internal_id,)
                )
                conn.commit()
                logger.debug(f"Deleted email record: internal_id={internal_id}")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to delete email: {e}")
                conn.rollback()
                return False

    def update_after_fetch(
        self, internal_id: int, data: Dict[str, Any]
    ) -> UpdateAfterFetchResult:
        """AppleScript 获取成功后更新元数据

        用于 v3 架构：AppleScript 获取成功后，用准确的数据刷新 SyncStore。

        ## message_id UNIQUE 冲突 = 「当前行是重复行」（2026-07-14 幽灵行事故）

        ``email_metadata.message_id`` 是 ``TEXT UNIQUE`` **列约束**（走 sqlite_autoindex,
        在 sqlite_master 里 grep index 的 sql 看不到它）。老实现把 message_id /
        thread_id / subject / sender 拼成一条 UPDATE 直接执行 —— message_id 撞上既有
        行 → **整条 UPDATE 回滚** → 连 sender 都没写进去 → 下游 create_email_page_
        from_sqlite 读 SQLite 拿到 sender='' → Notion 400 → 重试 → 而每轮重试在 400
        之前会先把附件重传一遍（实测 image001_2.png → image001_3.png 后缀递增）。

        冲突不是"写失败重试就好": 语义上等价于「这封邮件已存在, 当前行是重复行」。
        判定对齐 _save_email_v3 的 cross-backend merge guard —— 写之前先按 message_id
        SELECT 真身, 而不是撞了再收拾。

        🔴 铁律: 只有真身 **存在且已 synced** 才认定当前行是重复行 → 物理删除幽灵行
        （CASCADE 清 body/attachment/outbox, 不进 pending/retry 队列, 不污染死信告警）。
        真身未 synced = 无法判定谁是真身 → 谁都不动, 返回 FAILED 留人工处置。宁可留一行
        垃圾, 不能吞一封真邮件。

        Args:
            internal_id: 邮件内部 ID
            data: 要更新的字段（message_id, subject, sender, date_received, thread_id 等）

        Returns:
            UpdateAfterFetchResult —— 调用方必须区分 DUPLICATE（中止本封, 勿再
            mark_failed 把它拉回重试队列）与 FAILED（不得静默吞掉）。
        """
        if not data:
            return UpdateAfterFetchResult.OK

        now = time.time()

        # 构建 SET 子句
        allowed_fields = {
            'message_id', 'thread_id', 'subject', 'sender', 'sender_name',
            'to_addr', 'cc_addr', 'date_received', 'is_read', 'is_flagged',
            'sync_status', 'sync_error',
            'is_important',  # v9 — 邮件原生重要性（reader._parse_importance 提取）
            'in_reply_to',   # v40 — 直接父邮件 message_id（KOS Thread 链接反查）
        }
        set_parts = []
        values = []

        for key, value in data.items():
            if key in allowed_fields:
                set_parts.append(f"{key} = ?")
                if key in ('is_read', 'is_flagged', 'is_important'):
                    values.append(1 if value else 0)
                elif key == 'message_id':
                    # 🔴 第三条写 message_id 的路径 (davmail 主链路: fetch MIME 后回填)。
                    # 少了这行归一, 无 Message-ID 的邮件会被重新写成 '' —— v51 迁移
                    # 只清一次存量, 之后再写入的空串没人管; 第二封撞 UNIQUE 后
                    # 走 _resolve_message_id_conflict / FAILED → 重试 → 死信。
                    # 见 _storage_message_id docstring。
                    values.append(_storage_message_id(value))
                elif key == 'date_received':
                    # 🔴 第三条**写 date_received** 的持久化边界 (另两条:
                    # _save_email_v3 / save_emails_batch)。当前无调用方传这个键,
                    # 但它一直在 allowed_fields 里 —— 归一放在边界而非各产出点,
                    # 未来任意新调用方自动被覆盖 (见 _normalize_date_received_iso)。
                    # `or ''` 与 _save_email_v3 同口径: 空值统一落空串不落 NULL。
                    values.append(_normalize_date_received_iso(value) or '')
                else:
                    values.append(value)

        # 🔴 第三条**写 sender_email** 的持久化边界。`sender_email` 不在
        # allowed_fields 里 (它不是调用方能传的字段, 是 sender 的派生值) ——
        # 只要这次 UPDATE 动了 sender, 派生列必须跟着动, 否则两列会长期不一致
        # (davmail 主链路: 先 pending 落一次 sender, fetch MIME 后经本函数刷新)。
        if 'sender' in data:
            set_parts.append("sender_email = ?")
            values.append(derive_sender_email(data.get('sender')))

        if not set_parts:
            return UpdateAfterFetchResult.OK

        set_parts.append("updated_at = ?")
        values.append(now)
        values.append(internal_id)

        # 归一后再判 UNIQUE guard: '' 是 falsy 但会真的撞约束, 用原值判会漏进 UPDATE
        new_message_id = _storage_message_id(data.get('message_id'))

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                # === message_id UNIQUE 冲突 guard（对齐 _save_email_v3 的 cross-backend
                # merge: 写之前先 SELECT 真身）===
                # 仅 message_id 非空时检查（None 不触发 UNIQUE 约束, 是 v3 pending 邮件）。
                if new_message_id:
                    owner = cursor.execute(
                        "SELECT internal_id, sync_status, notion_page_id "
                        "FROM email_metadata WHERE message_id = ?",
                        (new_message_id,),
                    ).fetchone()
                    if owner is not None and owner['internal_id'] != internal_id:
                        return self._resolve_message_id_conflict(
                            conn, cursor, internal_id, new_message_id, owner
                        )

                query = f"""
                    UPDATE email_metadata
                    SET {', '.join(set_parts)}
                    WHERE internal_id = ?
                """
                cursor.execute(query, values)
                conn.commit()
                logger.debug(f"Updated email after fetch: internal_id={internal_id}")
                return UpdateAfterFetchResult.OK

            except sqlite3.Error as e:
                logger.error(f"Failed to update after fetch: {e}")
                conn.rollback()
                return UpdateAfterFetchResult.FAILED

    def _resolve_message_id_conflict(
        self,
        conn: sqlite3.Connection,
        cursor: sqlite3.Cursor,
        internal_id: int,
        message_id: str,
        owner: sqlite3.Row,
    ) -> UpdateAfterFetchResult:
        """update_after_fetch 撞 message_id UNIQUE 时的判定 + 终结。

        判据见 update_after_fetch 文档: 真身已 synced 才敢认定当前行是重复行。
        两个分支都留下可事后追溯"是哪两行撞了"的日志。

        DUPLICATE 分支物理删除幽灵行（Fable review 2026-07-15）: 标 skipped 会留三条
        尾巴 —— 列表默认不按 sync_status 过滤(幽灵行与真身并排重复显示)、email_body
        双写在库致 FTS5 双命中、skipped 不进死信面板故需求 3 的删除按钮够不到。改为
        DELETE 靠 _get_connection 的 foreign_keys=ON CASCADE 一并清 body/attachment/
        outbox。判据已严到确证是垃圾行 → 与 owner 2026-07-15 手动清 10 行(同走
        delete_email_full)一致。**只删幽灵行**, 真身零触碰。
        """
        owner_iid = owner['internal_id']
        owner_status = owner['sync_status']

        if owner_status != 'synced':
            # 真身未 synced → 两行都可能是真邮件 → 不可判定 → 谁都不动, 留人工处置。
            logger.error(
                f"[sync_store] update_after_fetch message_id conflict: "
                f"message_id={message_id[:60]!r} owned by internal_id={owner_iid} "
                f"(sync_status={owner_status!r} — not synced, cannot tell which row is "
                f"real); refusing to touch either row, internal_id={internal_id} left "
                f"for manual triage"
            )
            return UpdateAfterFetchResult.FAILED

        # 真身存在且已 synced → 当前行是重复行（幽灵行）→ 物理删除。
        # 只删幽灵行(WHERE internal_id = 当前行): 真身那一行零触碰。
        # foreign_keys=ON (_get_connection 开) → CASCADE 清 body/attachment/outbox。
        cursor.execute(
            "DELETE FROM email_metadata WHERE internal_id = ?",
            (internal_id,),
        )
        conn.commit()
        logger.warning(
            f"[sync_store] duplicate row resolved: message_id={message_id[:60]!r} "
            f"already at internal_id={owner_iid} (sync_status='synced', "
            f"notion_page_id={owner['notion_page_id']!r}); physically deleted "
            f"duplicate internal_id={internal_id} (CASCADE body/attachment/outbox) "
            f"— no further retry"
        )
        return UpdateAfterFetchResult.DUPLICATE

    def mark_fetch_failed(self, internal_id: int, error: str) -> bool:
        """标记 AppleScript 获取失败

        Args:
            internal_id: 邮件内部 ID
            error: 错误信息

        Returns:
            是否成功
        """
        return self._update_for_retry(internal_id, 'fetch_failed', error)

    def mark_synced_v3(self, internal_id: int, notion_page_id: str, notion_thread_id: str = None) -> bool:
        """标记邮件同步成功（v3 架构，使用 internal_id）

        Args:
            internal_id: 邮件内部 ID
            notion_page_id: Notion 页面 ID
            notion_thread_id: Notion 线程页面 ID（可选）

        Returns:
            是否成功
        """
        now = time.time()

        ok = False
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'synced',
                        notion_page_id = ?,
                        notion_thread_id = ?,
                        sync_error = NULL,
                        next_retry_at = NULL,
                        updated_at = ?
                    WHERE internal_id = ?
                """, (notion_page_id, notion_thread_id, now, internal_id))

                conn.commit()
                logger.debug(f"Marked synced: internal_id={internal_id}")
                ok = True

            except sqlite3.Error as e:
                logger.error(f"Failed to mark synced: {e}")
                conn.rollback()
                ok = False

        # Sprint 15 Stage 2: SSE publish (out of transaction, silent on failure)
        if ok:
            try:
                from src.events.publisher import safe_publish
                safe_publish(
                    "email.synced",
                    internal_id=internal_id,
                    data={"notion_page_id": notion_page_id},
                    source="new_watcher",
                )
            except Exception:
                pass
        return ok

    def update_notion_page_id(self, internal_id: int, notion_page_id: str) -> bool:
        """窄回写：只 UPDATE notion_page_id + updated_at，不动其它列。

        区别于 ``mark_synced_v3``（会一并 SET notion_thread_id / sync_status /
        清 retry 态）。resync ``--replace-existing`` 建新页 + archive 老页后回写用：
        DB 若不更新 notion_page_id 会指向已 archived 死页，后续 flag fanout 打死页。

        Returns:
            是否有行被更新
        """
        now = time.time()
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET notion_page_id = ?,
                        updated_at = ?
                    WHERE internal_id = ?
                """, (notion_page_id, now, internal_id))
                conn.commit()
                return cursor.rowcount > 0
            except sqlite3.Error as e:
                logger.error(f"Failed to update notion_page_id for internal_id={internal_id}: {e}")
                conn.rollback()
                return False

    def mark_failed_v3(self, internal_id: int, error: str, max_retries: int = 5) -> bool:
        """标记 Notion 同步失败（v3 架构，使用 internal_id）

        Args:
            internal_id: 邮件内部 ID
            error: 错误信息
            max_retries: 最大重试次数

        Returns:
            是否成功
        """
        return self._update_for_retry(internal_id, 'failed', error, max_retries)

    def mark_synced_local(self, internal_id: int) -> bool:
        """标记为已同步（本地-only，无 Notion 页）。

        草稿箱等仅入本地 SQLite（不进 Notion）的邮件用：sync_status='synced' 但
        notion_page_id 保持 NULL。SSE 同 mark_synced_v3 发 email.synced 让前端
        刷新列表/badge。
        """
        now = time.time()
        ok = False
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'synced',
                        sync_error = NULL,
                        next_retry_at = NULL,
                        updated_at = ?
                    WHERE internal_id = ?
                """, (now, internal_id))
                conn.commit()
                logger.debug(f"Marked synced (local-only): internal_id={internal_id}")
                ok = True
            except sqlite3.Error as e:
                logger.error(f"Failed to mark synced local: {e}")
                conn.rollback()
                ok = False

        if ok:
            try:
                from src.events.publisher import safe_publish
                safe_publish(
                    "email.synced",
                    internal_id=internal_id,
                    data={"local_only": True},
                    source="new_watcher",
                )
            except Exception:
                pass
        return ok

    def mark_skipped(self, internal_id: int, reason: Optional[str] = None) -> bool:
        """标记邮件为跳过状态（因日期过滤等原因不同步到 Notion）

        Args:
            internal_id: 邮件内部 ID

        Returns:
            是否成功
        """
        now = time.time()

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'skipped',
                        sync_skip_reason = ?,
                        sync_error = NULL,
                        next_retry_at = NULL,
                        updated_at = ?
                    WHERE internal_id = ?
                """, (reason, now, internal_id))

                conn.commit()
                logger.debug(f"Marked skipped: internal_id={internal_id}")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to mark skipped: {e}")
                conn.rollback()
                return False

    # ==================== v62: folder_pref (per-folder 图标 + 两个开关) ====================
    #
    # 表结构 / 列语义 / 「顺序为什么不在这张表」→ FOLDER_PREF_TABLE_DDLS 头注。
    #
    # 🔴 **行内热读**: get_folder_gates 每次调用现读一行, 不缓存。这是有意的 ——
    # 写侧是 serve-api 进程 (PUT /api/folder/prefs), 读侧是 mail-sync 进程的两个
    # gate; 两个进程共享同一个 WAL 库, 现读才能让「Settings 里点一下开关」下一封
    # 邮件就生效, 而不是像旧的 `NewWatcher.__init__` frozenset 那样要重启 mail-sync。
    # 模式抄自 v31 project_progress 的行内热读 (src/project_progress/agent_config.py),
    # 只是那边为了不 import src.reports 走裸 sqlite3, 这里表就在 SyncStore 自己的
    # schema 里、调用方 (NewWatcher) 手上本来就有 SyncStore 实例, 所以直接走
    # _connection() —— 顺带拿到 WAL + 30s timeout, 不必自己配。

    def get_folder_gates(self, mailbox_label: str) -> "FolderGates":
        """按 mailbox 显示名热读 per-folder 开关。行不存在 → ``row_exists=False``。

        🔴 查的是 ``mailbox_label`` 而**不是** PK: 两个 gate 手里只有
        ``email_metadata.mailbox`` 的显示名 (见 FOLDER_PREF_TABLE_DDLS 的列注 ——
        反向 encode 回 imap_name 要赌 ``encode(decode(x)) == x``, 非规范 modified-UTF7
        编码下不成立)。

        理论上两个不同 imap_name 可以 decode 出同一个 label (非规范编码), 那种情况下
        按 imap_name 升序取第一行 —— 确定性优先于"猜哪个对"; 实践中 Exchange 只发
        规范编码, 全库零命中。
        """
        with self._connection() as conn:
            try:
                row = conn.execute(
                    "SELECT notify_enabled, llm_disabled FROM folder_pref "
                    "WHERE mailbox_label = ? ORDER BY imap_name LIMIT 1",
                    (mailbox_label,),
                ).fetchone()
            except sqlite3.Error as e:
                # 表缺失 (未迁移库) / 锁 → 当作行不存在, caller 回退 env frozenset。
                logger.debug(f"[folder-pref] gate read skipped ({mailbox_label!r}): {e}")
                return FolderGates()
        if row is None:
            return FolderGates()
        return FolderGates(
            row_exists=True,
            notify_enabled=bool(row["notify_enabled"]),
            llm_disabled=bool(row["llm_disabled"]),
        )

    def has_any_llm_disabled(self) -> bool:
        """有没有任何文件夹关掉了 LLM —— LLM 重试队列的短路探针。

        保住升级前的行为: 旧代码用 ``if llm_disabled:`` (env frozenset 非空) 决定要不要
        为每个重试行多查一次 mailbox。没有任何黑名单时这一整段依然零额外查询。
        """
        with self._connection() as conn:
            try:
                row = conn.execute(
                    "SELECT 1 FROM folder_pref WHERE llm_disabled = 1 LIMIT 1"
                ).fetchone()
            except sqlite3.Error as e:
                logger.debug(f"[folder-pref] llm_disabled probe skipped: {e}")
                return False
        return row is not None

    def list_folder_prefs(self) -> List[Dict[str, Any]]:
        """全部 folder_pref 行 (imap_name 升序)。**没有顺序语义** —— 显示顺序的权威是
        SYNC_FOLDERS 数组序 (见 FOLDER_PREF_TABLE_DDLS 头注), 前端按白名单顺序取用。"""
        with self._connection() as conn:
            try:
                rows = conn.execute(
                    "SELECT imap_name, mailbox_label, icon, notify_enabled, llm_disabled, "
                    "updated_at FROM folder_pref ORDER BY imap_name"
                ).fetchall()
            except sqlite3.Error as e:
                logger.warning(f"[folder-pref] list failed: {e}")
                return []
        return [
            {
                "imap_name": r["imap_name"],
                "mailbox_label": r["mailbox_label"],
                "icon": r["icon"],
                "notify_enabled": bool(r["notify_enabled"]),
                "llm_disabled": bool(r["llm_disabled"]),
                "updated_at": r["updated_at"],
            }
            for r in rows
        ]

    def upsert_folder_pref(
        self,
        imap_name: str,
        *,
        icon: Optional[str] = _UNSET,
        notify_enabled: Optional[bool] = None,
        llm_disabled: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        """部分更新一行 (缺省的字段保持原值; 行不存在则按列默认建行)。

        ``icon`` 用 ``_UNSET`` 而不是 ``None`` 作"不改"的哨兵 —— ``None`` 是 icon 的
        **合法值** (= 清除图标, 回到前端兜底), 两者必须分得开。
        ``mailbox_label`` 是派生列, 由 imap_name 唯一决定, 调用方给不了也改不了。
        """
        from src.mail.backend.imap_utf7 import decode_imap_utf7

        imap_name = (imap_name or "").strip()
        if not imap_name:
            return None
        label = decode_imap_utf7(imap_name)
        with self._connection() as conn:
            try:
                # 先保证行在 (列默认 = 全默认配置), 再逐字段 COALESCE 式更新。
                conn.execute(
                    "INSERT OR IGNORE INTO folder_pref "
                    "(imap_name, mailbox_label, updated_at) VALUES (?, ?, ?)",
                    (imap_name, label, time.time()),
                )
                sets = ["mailbox_label = ?", "updated_at = ?"]
                args: List[Any] = [label, time.time()]
                if icon is not _UNSET:
                    sets.insert(0, "icon = ?")
                    args.insert(0, icon or None)
                if notify_enabled is not None:
                    sets.insert(0, "notify_enabled = ?")
                    args.insert(0, 1 if notify_enabled else 0)
                if llm_disabled is not None:
                    sets.insert(0, "llm_disabled = ?")
                    args.insert(0, 1 if llm_disabled else 0)
                args.append(imap_name)
                conn.execute(
                    f"UPDATE folder_pref SET {', '.join(sets)} WHERE imap_name = ?", args
                )
                conn.commit()
                row = conn.execute(
                    "SELECT imap_name, mailbox_label, icon, notify_enabled, llm_disabled, "
                    "updated_at FROM folder_pref WHERE imap_name = ?",
                    (imap_name,),
                ).fetchone()
            except sqlite3.Error as e:
                logger.error(f"[folder-pref] upsert {imap_name!r} failed: {e}")
                return None
        if row is None:
            return None
        # perf-sse-realtime R1-2: pref 写(图标/通知/AI 开关)即广播, 前端 ['folder']
        # 前缀 invalidate (含 ['folder','prefs']) 让侧边栏/设置页即时同步。吞错。
        try:
            from src.events.publisher import safe_publish
            safe_publish(
                "folder.changed",
                data={"action": "pref", "imap_name": imap_name},
                source="sync_store.folder_pref",
            )
        except Exception:
            pass
        return {
            "imap_name": row["imap_name"],
            "mailbox_label": row["mailbox_label"],
            "icon": row["icon"],
            "notify_enabled": bool(row["notify_enabled"]),
            "llm_disabled": bool(row["llm_disabled"]),
            "updated_at": row["updated_at"],
        }

    def rename_folder_pref(self, old_imap: str, new_imap: str) -> int:
        """文件夹改名后把 pref 行跟着搬走 (精确 + **子文件夹前缀**)。返回搬动的行数。

        🔴 为什么必须有: PK 是 imap 路径, IMAP RENAME 换掉路径后原行就成孤儿 —— 图标
        和两个开关静默丢失, 而且没有任何报错。子文件夹前缀替换的理由与
        ``MailWriteService._rename_local_mailbox`` 逐字相同: 重命名父文件夹时
        ``old/子`` 的路径也跟着变, 只做精确匹配会漏掉每一个子文件夹。

        ``UPDATE OR REPLACE`` 兜住目标名已存在的情况 (先前删掉又建回同名文件夹时可能
        撞 PK): 新名那行被搬来的旧配置覆盖 —— 与 email_metadata 侧"旧行搬到新名下"的
        方向一致。
        """
        old_imap = (old_imap or "").strip()
        new_imap = (new_imap or "").strip()
        if not old_imap or not new_imap or old_imap == new_imap:
            return 0
        from src.mail.backend.imap_utf7 import decode_imap_utf7

        with self._connection() as conn:
            try:
                cur1 = conn.execute(
                    "UPDATE OR REPLACE folder_pref SET imap_name = ?, mailbox_label = ? "
                    "WHERE imap_name = ?",
                    (new_imap, decode_imap_utf7(new_imap), old_imap),
                )
                # 子文件夹: `old/...` → `new/...` (SUBSTR 1-indexed, 截 old 之后的 `/...`)。
                # mailbox_label 只能逐行重算 —— 它是 decode 的结果, 不是字符串拼接
                # (前缀是 ASCII 时看着一样, 前缀含中文时 base64 段边界会变)。
                children = conn.execute(
                    "SELECT imap_name FROM folder_pref WHERE imap_name LIKE ?",
                    (old_imap + "/%",),
                ).fetchall()
                for child in children:
                    child_new = new_imap + child["imap_name"][len(old_imap):]
                    conn.execute(
                        "UPDATE OR REPLACE folder_pref SET imap_name = ?, mailbox_label = ? "
                        "WHERE imap_name = ?",
                        (child_new, decode_imap_utf7(child_new), child["imap_name"]),
                    )
                conn.commit()
                moved = (cur1.rowcount or 0) + len(children)
            except sqlite3.Error as e:
                logger.warning(
                    f"[folder-pref] rename {old_imap!r}→{new_imap!r} failed: {e}"
                )
                return 0
        if moved:
            # 同 upsert_folder_pref: pref 行真的搬动了才广播 (无行迁移 = 无可见变化)。
            try:
                from src.events.publisher import safe_publish
                safe_publish(
                    "folder.changed",
                    data={"action": "pref_rename", "imap_name": new_imap},
                    source="sync_store.folder_pref",
                )
            except Exception:
                pass
        return moved

    def delete_folder_pref(self, imap_name: str) -> int:
        """文件夹被真删除后清掉 pref 行 (精确 + 子文件夹前缀)。返回删除行数。

        只给 ``delete_folder`` 用 (Exchange 上的文件夹没了)。**取消同步
        (cleanup_local_folder) 不调用** —— 那只是不再同步, 文件夹还在服务器上, 重新
        勾选时用户理当拿回自己设的图标和开关。
        """
        imap_name = (imap_name or "").strip()
        if not imap_name:
            return 0
        with self._connection() as conn:
            try:
                cur = conn.execute(
                    "DELETE FROM folder_pref WHERE imap_name = ? OR imap_name LIKE ?",
                    (imap_name, imap_name + "/%"),
                )
                conn.commit()
                deleted = cur.rowcount or 0
            except sqlite3.Error as e:
                logger.warning(f"[folder-pref] delete {imap_name!r} failed: {e}")
                return 0
        if deleted:
            # 同 upsert_folder_pref: 真删了行才广播。
            try:
                from src.events.publisher import safe_publish
                safe_publish(
                    "folder.changed",
                    data={"action": "pref_delete", "imap_name": imap_name},
                    source="sync_store.folder_pref",
                )
            except Exception:
                pass
        return deleted

    # ==================== v8: 置顶 / pin ====================

    def get_pin(self, internal_id: int) -> bool:
        """读取邮件置顶状态（不存在视为未置顶，返回 False）。"""
        with self._connection() as conn:
            try:
                row = conn.execute(
                    "SELECT is_pinned FROM email_metadata WHERE internal_id = ?",
                    (internal_id,),
                ).fetchone()
                if row is None:
                    return False
                return bool(row['is_pinned'])
            except sqlite3.Error as e:
                logger.error(f"Failed to get pin state for {internal_id}: {e}")
                return False

    def set_pin(self, internal_id: int, pinned: bool) -> bool:
        """设置邮件置顶状态。

        Args:
            internal_id: 邮件内部 ID
            pinned: 是否置顶；True → is_pinned=1 + pinned_at=now，False → 清零

        Returns:
            True 表示状态从 ``not pinned`` ↔ ``pinned`` 真的翻转过；
            False 表示状态未变化（idempotent no-op）或邮件不存在 / SQL 错误。
            邮件不存在时直接 False（caller 自行决定是否抛 NotFound，
            可结合 ``self.get(internal_id) is None`` 区分）。
        """
        with self._connection() as conn:
            try:
                row = conn.execute(
                    "SELECT is_pinned FROM email_metadata WHERE internal_id = ?",
                    (internal_id,),
                ).fetchone()
                if row is None:
                    return False
                current = bool(row['is_pinned'])
                target = bool(pinned)
                if current == target:
                    return False  # no-op，让 caller 区分 changed/unchanged
                now = time.time()
                conn.execute(
                    """UPDATE email_metadata
                          SET is_pinned = ?,
                              pinned_at = ?,
                              updated_at = ?
                        WHERE internal_id = ?""",
                    (
                        1 if target else 0,
                        now if target else None,
                        now,
                        internal_id,
                    ),
                )
                conn.commit()
                logger.debug(
                    f"set_pin: internal_id={internal_id} pinned={target}"
                )
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to set pin for {internal_id}: {e}")
                conn.rollback()
                return False

    def update_mailbox(self, internal_id: int, mailbox: str) -> bool:
        """改邮件所属 mailbox (收件箱归档场景: 收件箱 → 存档)。

        归档把邮件 IMAP MOVE 到 Archive 文件夹后, 调本方法把 email_metadata.mailbox
        改成目标值; 列表查询按 mailbox 过滤 (见 query_emails), 改后该邮件即不再出现在
        收件箱视图。不删行 (保 v4 body/附件 SSoT + Notion 镜像引用)。

        Returns: True=更新成功且值有变; False=邮件不存在 / 值未变 / SQL 错误。
        """
        with self._connection() as conn:
            try:
                row = conn.execute(
                    "SELECT mailbox FROM email_metadata WHERE internal_id = ?",
                    (internal_id,),
                ).fetchone()
                if row is None:
                    return False
                if (row['mailbox'] or "") == mailbox:
                    return False
                conn.execute(
                    "UPDATE email_metadata SET mailbox = ?, updated_at = ? WHERE internal_id = ?",
                    (mailbox, time.time(), internal_id),
                )
                conn.commit()
                logger.info(f"update_mailbox: internal_id={internal_id} → {mailbox!r}")
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to update mailbox for {internal_id}: {e}")
                conn.rollback()
                return False

    def update_draft_linkage(
        self,
        internal_id: int,
        *,
        draft_in_reply_to: Optional[str],
        draft_references: Optional[str],
        draft_source_internal_id: Optional[int],
        thread_id: Optional[str] = None,
        overwrite_thread_id: bool = False,
    ) -> bool:
        """草稿行 linkage 懒自愈回写 (compose 优化 epic, codex finding 1)。

        v36 迁移前的存量草稿行 draft_* 三列全 NULL 且 reconcile 永不回填 —— 消费端
        (MailWriteService._heal_draft_linkage) 从 davmail 取草稿 MIME 头解析出
        linkage 后调本方法落列。draft_* 三列按参数直写; ``thread_id`` 默认走
        COALESCE 只填空。``overwrite_thread_id=True`` (自愈回写, codex 批次2
        finding 6) 直写覆盖 —— healed 头派生的 root 为权威, 存量行的 RFC2047 碎片
        等坏 thread_id 不再被 COALESCE 保留。

        Returns: True=更新成功; False=SQL 错误 (调用方仅 warning, 自愈是 best-effort)。
        """
        thread_sql = (
            "thread_id = ?" if overwrite_thread_id
            else "thread_id = COALESCE(thread_id, ?)"
        )
        with self._connection() as conn:
            try:
                conn.execute(
                    "UPDATE email_metadata SET draft_in_reply_to = ?, "
                    "draft_references = ?, draft_source_internal_id = ?, "
                    f"{thread_sql}, updated_at = ? "
                    "WHERE internal_id = ?",
                    (
                        draft_in_reply_to,
                        draft_references,
                        draft_source_internal_id,
                        thread_id,
                        time.time(),
                        internal_id,
                    ),
                )
                conn.commit()
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to update draft linkage for {internal_id}: {e}")
                conn.rollback()
                return False

    def finalize_draft_append(
        self,
        internal_id: int,
        *,
        imap_uid: int,
        imap_uidvalidity: Optional[int] = None,
    ) -> Optional[bool]:
        """后台 IMAP APPEND 成功回填 (task 08-20 draft-save 批2 异步保存)。

        镜像行先落库 (无 uid, sync_status='synced'), APPEND 后台完成后把 APPENDUID
        落行并置 pending 让 watcher 重 fetch 规范正文 — 语义与 reconcile 的
        ``_update_draft_row_uid`` 同构 (那条链在行先有、uid 后到时同样适用)。

        Returns:
            True  已回填 (行在);
            False 行已不在 (期间被 replace/删除) — 调用方应清理刚 APPEND 的远端孤儿;
            None  SQL 错误 — 调用方**不要**清远端 (行可能仍在, reconcile 同
                  Message-ID 归并会兜底补 uid)。
        """
        with self._connection() as conn:
            try:
                cur = conn.execute(
                    "UPDATE email_metadata SET imap_uid = ?, "
                    "imap_uidvalidity = COALESCE(?, imap_uidvalidity), "
                    "sync_status = 'pending', sync_error = NULL, "
                    "next_retry_at = NULL, updated_at = ? "
                    "WHERE internal_id = ?",
                    (imap_uid, imap_uidvalidity, time.time(), internal_id),
                )
                conn.commit()
                return cur.rowcount == 1
            except sqlite3.Error as e:
                logger.error(
                    f"Failed to finalize draft append for {internal_id}: {e}"
                )
                conn.rollback()
                return None

    def mark_draft_append_failed(self, internal_id: int, error: str) -> bool:
        """后台 IMAP APPEND 失败标记 (task 08-20 draft-save 批2 异步保存)。

        行保留 (本地即真身), sync_error 落「未同步」诊断; sync_status 不动
        (维持 'synced' — 本地内容完整, 不进 watcher 重试机)。用户再次保存该草稿
        = 新 APPEND + replace 本地旧行, 即重试闭环。

        Returns: True=已标记; False=行已不在 (被 replace/删除, 无需再通知) 或 SQL 错。
        """
        with self._connection() as conn:
            try:
                cur = conn.execute(
                    "UPDATE email_metadata SET sync_error = ?, updated_at = ? "
                    "WHERE internal_id = ?",
                    (f"draft append 未同步: {(error or '')[:300]}", time.time(), internal_id),
                )
                conn.commit()
                return cur.rowcount == 1
            except sqlite3.Error as e:
                logger.error(
                    f"Failed to mark draft append failure for {internal_id}: {e}"
                )
                conn.rollback()
                return False

    def toggle_pin(self, internal_id: int) -> Optional[bool]:
        """翻转置顶状态。

        Returns:
            新的置顶状态（True / False）；邮件不存在返回 None。
        """
        with self._connection() as conn:
            try:
                row = conn.execute(
                    "SELECT is_pinned FROM email_metadata WHERE internal_id = ?",
                    (internal_id,),
                ).fetchone()
                if row is None:
                    return None
                new_state = not bool(row['is_pinned'])
            except sqlite3.Error as e:
                logger.error(
                    f"Failed to read pin for toggle on {internal_id}: {e}"
                )
                return None
        # 走同一份 set_pin 逻辑，确保 pinned_at + updated_at 时间戳一致
        self.set_pin(internal_id, new_state)
        return new_state

    def get_pinned_at(self, internal_id: int) -> Optional[float]:
        """读取置顶时间戳（未置顶 / 不存在 → None）。"""
        with self._connection() as conn:
            try:
                row = conn.execute(
                    "SELECT pinned_at FROM email_metadata WHERE internal_id = ?",
                    (internal_id,),
                ).fetchone()
                if row is None:
                    return None
                return row['pinned_at']
            except sqlite3.Error as e:
                logger.error(f"Failed to get pinned_at for {internal_id}: {e}")
                return None

    def _update_for_retry(
        self,
        internal_id: int,
        status: str,
        error: str,
        max_retries: int = 5
    ) -> bool:
        """更新重试状态（统一逻辑）

        Args:
            internal_id: 邮件内部 ID
            status: 目标状态 ('fetch_failed' 或 'failed')
            error: 错误信息
            max_retries: 最大重试次数

        Returns:
            是否成功
        """
        now = time.time()

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                # 获取当前重试次数 + mailbox（用于死信降级判断）
                cursor.execute(
                    "SELECT retry_count, mailbox FROM email_metadata WHERE internal_id = ?",
                    (internal_id,)
                )
                row = cursor.fetchone()
                current_retry = (row['retry_count'] if row else 0) + 1
                mailbox = row['mailbox'] if row else None

                # 检查是否达到最大重试次数
                if current_retry >= max_retries:
                    # 发件箱 fetch_failed 用尽：邮件已被 Mail.app 移走/索引失效，
                    # 业务上发件箱漏一封不致命，降级为 skipped，避免污染死信告警
                    if status == 'fetch_failed' and is_sent_mailbox(mailbox):
                        cursor.execute("""
                            UPDATE email_metadata
                            SET sync_status = 'skipped',
                                sync_error = ?,
                                retry_count = ?,
                                next_retry_at = NULL,
                                updated_at = ?
                            WHERE internal_id = ?
                        """, (f"Skipped (sent box unreachable): {error}", current_retry, now, internal_id))
                        conn.commit()
                        logger.warning(
                            f"Marked sent-box email as skipped after {current_retry} fetch attempts: "
                            f"internal_id={internal_id}"
                        )
                        return True

                    cursor.execute("""
                        UPDATE email_metadata
                        SET sync_status = 'dead_letter',
                            sync_error = ?,
                            retry_count = ?,
                            next_retry_at = NULL,
                            updated_at = ?
                        WHERE internal_id = ?
                    """, (f"Max retries exceeded: {error}", current_retry, now, internal_id))

                    conn.commit()
                    logger.warning(f"Marked as dead_letter: internal_id={internal_id}")
                    # Sprint 15 Stage 2: SSE publish
                    try:
                        from src.events.publisher import safe_publish
                        safe_publish(
                            "email.dead_letter",
                            internal_id=internal_id,
                            data={"retry_count": current_retry, "error": (error or "")[:200]},
                            source="sync_store",
                        )
                    except Exception:
                        pass
                    return True

                # 计算下次重试时间（指数退避：1min, 5min, 15min, 1h, 2h）
                delays = [60, 300, 900, 3600, 7200]
                delay = delays[min(current_retry - 1, len(delays) - 1)]
                next_retry = now + delay

                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = ?,
                        sync_error = ?,
                        retry_count = ?,
                        next_retry_at = ?,
                        updated_at = ?
                    WHERE internal_id = ?
                """, (status, error, current_retry, next_retry, now, internal_id))

                conn.commit()
                logger.warning(f"Marked {status}: internal_id={internal_id}, retry #{current_retry} in {delay}s")
                # Sprint 15 Stage 2: SSE publish
                try:
                    from src.events.publisher import safe_publish
                    safe_publish(
                        "email.failed",
                        internal_id=internal_id,
                        data={
                            "status": status,
                            "retry_count": current_retry,
                            "next_retry_at": next_retry,
                            "error": (error or "")[:200],
                        },
                        source="sync_store",
                    )
                except Exception:
                    pass
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to update for retry: {e}")
                conn.rollback()
                return False

    # ==================== 邮件元数据操作（兼容旧 API） ====================

    def save_email(self, email: Dict[str, Any]) -> bool:
        """保存单个邮件元数据

        支持两种模式：
        1. v3 架构：必须包含 internal_id
        2. 兼容模式：只包含 message_id（用于旧代码）

        Args:
            email: 邮件数据字典

        Returns:
            是否成功
        """
        internal_id = email.get('internal_id')
        message_id = email.get('message_id')

        # v3 架构：使用 internal_id 作为主键
        if internal_id is not None:
            return self._save_email_v3(email)

        # 兼容模式：使用 message_id（生成临时 internal_id）
        if message_id:
            return self._save_email_compat(email)

        logger.warning("Cannot save email without internal_id or message_id")
        return False

    def _save_email_v3(self, email: Dict[str, Any]) -> bool:
        """v3 架构保存邮件（internal_id 为主键）.

        v13 新增字段 (向后兼容, 老调用方不传 = 默认值):
            imap_uidvalidity / imap_uid: DavMail backend 必填; AppleScript 留 None
            backend_origin: 'applescript' (default) | 'davmail' — 标记 internal_id 是谁生成的

        ## Cross-backend merge protection (Sprint 16 dual-backend cutover 安全网)

        触发场景: backend 切换后, 同一封邮件可能被两个 backend 各看到一次 (e.g. 切到
        davmail 后, davmail 抓到该邮件分配了 >=10^9 的新 internal_id; 而该邮件的
        message_id 已经在 applescript 时代写过 row=小 ROWID). 老逻辑用 ``INSERT OR
        REPLACE`` → message_id UNIQUE 约束 → 老 row 整行被删 → ``notion_page_id``
        / ``sync_status='synced'`` / ``thread_id`` 等同步状态全丢, Notion 端孤儿.

        修复策略: 写入前 SELECT 同 message_id 的 row, 如果存在但 internal_id 不同 →
        UPDATE 老 row 的 backend-related 字段 (imap_uid / imap_uidvalidity 等), 保留
        notion_page_id / sync_status / thread_id / notion_thread_id 不动. 新分配的
        internal_id 浪费 (sequence 不回收, 但无害).

        SQLite SSoT 视角: internal_id 仅是邮件代号, 长度不同代表 origin 不同, 不影响
        message_id 这个对外唯一标识 — 一封 message_id 在 sync_store 只能有一条记录.
        """
        internal_id = email['internal_id']
        # 空串 → None: 空串会撞 UNIQUE 并让 INSERT OR REPLACE 静默删掉老行, 见
        # _storage_message_id docstring。下面的 INSERT 必须用这个局部变量而非
        # email.get('message_id'), 否则归一不生效。
        message_id = _storage_message_id(email.get('message_id'))
        now = time.time()

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                # === Cross-backend merge guard ===
                # 仅在 message_id 非空时检查 (None 不会触发 UNIQUE 冲突, 是 v3 pending 邮件).
                if message_id:
                    existing = cursor.execute(
                        "SELECT internal_id, sync_status, notion_page_id, "
                        "notion_thread_id, thread_id, backend_origin, mailbox "
                        "FROM email_metadata WHERE message_id = ?",
                        (message_id,),
                    ).fetchone()
                    if existing is not None and existing['internal_id'] != internal_id:
                        # 跨 backend 切换产生的 dup. UPDATE 老 row 的 davmail 字段,
                        # 保留同步状态.
                        old_iid = existing['internal_id']
                        old_origin = existing['backend_origin']
                        new_origin = email.get('backend_origin', 'applescript')
                        new_mailbox = email.get('mailbox')
                        # Draft→Sent 提升: 外部 (OWA/Outlook) 从草稿发送的邮件, 发送后
                        # Draft 跨文件夹移到 Sent (Message-ID 不变), Sent 副本经 msgid
                        # 合并进原草稿行。若只更 imap_uid 而保留 mailbox='草稿箱', 同一
                        # poll cycle 的 reconcile_drafts 会把它当"消失草稿"删除 → 已发
                        # 邮件本地记录被销毁 (纯本地丢失, 服务端 Sent 完好)。既有行是
                        # 草稿、新副本来自 Sent → 归一提升 mailbox='发件箱' 阻断删除, 并
                        # 置 pending + 清重试态, 让它像其它发件箱邮件重取正文 + 进 Notion。
                        # 显式 gate 在 SENT_MAILBOX_LABELS (而非"任意非草稿"): 避免同 msgid
                        # 副本先从非 Sent 文件夹进入时误提升到错误 mailbox (codex review)。
                        promote_sent = bool(
                            existing['mailbox'] in DRAFT_MAILBOX_LABELS
                            and new_mailbox in SENT_MAILBOX_LABELS
                        )
                        logger.info(
                            f"[sync_store] cross-backend merge: message_id={message_id[:40]!r} "
                            f"already at internal_id={old_iid} (origin={old_origin!r}); "
                            f"merging new internal_id={internal_id} (origin={new_origin!r}) "
                            + (
                                f"— promote 草稿箱→{SENT_CANONICAL_LABEL} + re-sync (sent from draft)"
                                if promote_sent
                                else "— keep notion_page_id/sync_status, update imap_uid"
                            )
                        )
                        # 提升 SET 片段全是常量字面量 (归一 label='发件箱' + 置 pending +
                        # 清同步/重试态), 无占位符、无注入面 → params 两分支完全一致。
                        promote_set = (
                            ", mailbox = '发件箱', sync_status = 'pending', "
                            "sync_error = NULL, retry_count = 0, next_retry_at = NULL"
                            if promote_sent else ""
                        )
                        cursor.execute(
                            f"""UPDATE email_metadata
                               SET imap_uid = COALESCE(?, imap_uid),
                                   imap_uidvalidity = COALESCE(?, imap_uidvalidity),
                                   entry_id = COALESCE(?, entry_id),
                                   thread_id = COALESCE(thread_id, ?),
                                   sender_name = COALESCE(NULLIF(sender_name, ''), ?),
                                   to_addr = COALESCE(NULLIF(to_addr, ''), ?),
                                   cc_addr = COALESCE(NULLIF(cc_addr, ''), ?){promote_set},
                                   updated_at = ?
                               WHERE internal_id = ?""",
                            (
                                email.get('imap_uid'),
                                email.get('imap_uidvalidity'),
                                # v53: outlook_com 的 EntryID 缓存, 跨 backend 合并时
                                # 同样回写老行 (COALESCE 语义: 新值优先, 无则保留)。
                                email.get('entry_id'),
                                email.get('thread_id'),
                                email.get('sender_name', ''),
                                email.get('to_addr', ''),
                                email.get('cc_addr', ''),
                                now,
                                old_iid,
                            ),
                        )
                        conn.commit()
                        return True

                # === 正常路径: 全新 row 或 internal_id 已存在 (同 backend 内重复触发) ===
                cursor.execute("""
                    INSERT OR REPLACE INTO email_metadata
                    (internal_id, message_id, thread_id, subject, sender, sender_email,
                     sender_name,
                     to_addr, cc_addr, date_received, mailbox,
                     is_read, is_flagged, sync_status, notion_page_id,
                     notion_thread_id, sync_error, retry_count, next_retry_at,
                     imap_uidvalidity, imap_uid, backend_origin,
                     draft_source_internal_id, draft_in_reply_to, draft_references,
                     in_reply_to, ingest_reason, entry_id,
                     created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                            ?, ?, ?,
                            ?, ?, ?,
                            ?, ?, ?,
                            ?,
                            COALESCE((SELECT created_at FROM email_metadata WHERE internal_id = ?), ?),
                            ?)
                """, (
                    internal_id,
                    message_id,          # 已过 _storage_message_id: '' → None
                    email.get('thread_id'),
                    email.get('subject', ''),
                    email.get('sender', ''),
                    # v58 第一条**写 sender_email** 的持久化边界 (另两条:
                    # save_emails_batch / update_after_fetch)。派生器单源
                    # derive_sender_email —— sender 列一字不改, 显示名留给
                    # 前端 parseSender / ⌘K 结果用。
                    derive_sender_email(email.get('sender', '')),
                    email.get('sender_name', ''),
                    email.get('to_addr', ''),
                    email.get('cc_addr', ''),
                    _normalize_date_received_iso(email.get('date_received', '')) or '',
                    email.get('mailbox', '收件箱'),
                    1 if email.get('is_read') else 0,
                    1 if email.get('is_flagged') else 0,
                    email.get('sync_status', 'pending'),
                    email.get('notion_page_id'),
                    email.get('notion_thread_id'),
                    email.get('sync_error'),
                    email.get('retry_count', 0),
                    email.get('next_retry_at'),
                    email.get('imap_uidvalidity'),
                    email.get('imap_uid'),
                    email.get('backend_origin', 'applescript'),
                    email.get('draft_source_internal_id'),
                    email.get('draft_in_reply_to'),
                    email.get('draft_references'),
                    email.get('in_reply_to'),
                    # v51 provenance: 邮件怎么进库的 (飞书通知门控判据)。
                    # NULL = 存量/未知, 语义等同 realtime (照常通知)。
                    email.get('ingest_reason'),
                    # v53: outlook_com EntryID 缓存 (非 outlook_com 行恒 None)。
                    email.get('entry_id'),
                    internal_id,
                    now,
                    now
                ))

                conn.commit()
                logger.debug(f"Saved email (v3): internal_id={internal_id}")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to save email (v3): {e}")
                conn.rollback()
                return False

    def allocate_davmail_internal_id(self) -> int:
        """Atomic 分配下一个 davmail internal_id (起点 1_000_000_000).

        v13: DavMail backend 抓新邮件时调用, 拿到 ID 后传给 save_email(backend_origin='davmail').
        SQLite INTEGER PRIMARY KEY 不能 ALTER 成 AUTOINCREMENT, 用 sync_state KV 维护序列.
        BEGIN IMMEDIATE 锁住 sync_state 行避免并发冲突.

        Returns:
            下一个可用的 internal_id (>= 1_000_000_000).
        """
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute("BEGIN IMMEDIATE")
                cursor.execute(
                    "SELECT value FROM sync_state WHERE key = 'davmail_next_internal_id'"
                )
                row = cursor.fetchone()
                next_id = int(row['value']) if row else 1_000_000_000
                cursor.execute(
                    """UPDATE sync_state SET value = ?, updated_at = ?
                       WHERE key = 'davmail_next_internal_id'""",
                    (str(next_id + 1), time.time()),
                )
                if cursor.rowcount == 0:
                    # 第一次分配, sync_state 还没这一行 (理论上 _init_database 已经 INSERT OR IGNORE)
                    cursor.execute(
                        """INSERT INTO sync_state (key, value, updated_at)
                           VALUES ('davmail_next_internal_id', ?, ?)""",
                        (str(next_id + 1), time.time()),
                    )
                conn.commit()
                return next_id
            except sqlite3.Error as e:
                conn.rollback()
                logger.error(f"allocate_davmail_internal_id failed: {e}")
                raise

    def _save_email_compat(self, email: Dict[str, Any]) -> bool:
        """兼容模式保存邮件（message_id 为主键，生成临时 internal_id）

        用于旧代码兼容，生成负数 internal_id 避免与真实 ID 冲突。
        """
        message_id = email['message_id']
        # 使用 message_id 的 hash 作为临时 internal_id（负数）
        internal_id = -abs(hash(message_id)) % 2147483647

        # 检查是否已存在（通过 message_id）
        existing = self.get_by_message_id(message_id)
        if existing:
            internal_id = existing['internal_id']

        email_with_id = {**email, 'internal_id': internal_id}
        return self._save_email_v3(email_with_id)

    def save_emails_batch(self, emails: List[Dict[str, Any]]) -> int:
        """批量保存邮件元数据

        使用 executemany() 优化批量插入性能。

        Args:
            emails: 邮件列表

        Returns:
            成功保存的数量
        """
        if not emails:
            return 0

        now = time.time()

        # 准备批量数据
        batch_data = []
        for email in emails:
            internal_id = email.get('internal_id')
            # 空串 → None (见 _storage_message_id): 本路径**没有** merge guard,
            # 空串撞 UNIQUE 时 executemany 的 INSERT OR REPLACE 会直接删掉老行。
            message_id = _storage_message_id(email.get('message_id'))

            # v3 架构
            if internal_id is not None:
                pass
            # 兼容模式
            elif message_id:
                internal_id = -abs(hash(message_id)) % 2147483647
            else:
                continue

            batch_data.append((
                internal_id,
                message_id,          # 已过 _storage_message_id: '' → None
                email.get('thread_id'),
                email.get('subject', ''),
                email.get('sender', ''),
                # v58 派生列, 同 _save_email_v3 (见 derive_sender_email)。
                derive_sender_email(email.get('sender', '')),
                email.get('sender_name', ''),
                email.get('to_addr', ''),
                email.get('cc_addr', ''),
                # 归一同 _save_email_v3: 排序全链路是词法字符串比较, 混入非 UTC
                # 偏移的行会让绝对时间更晚的排到前面 (见 _normalize_date_received_iso)。
                _normalize_date_received_iso(email.get('date_received', '')) or '',
                email.get('mailbox', '收件箱'),
                1 if email.get('is_read') else 0,
                1 if email.get('is_flagged') else 0,
                email.get('sync_status', 'pending'),
                email.get('notion_page_id'),
                email.get('notion_thread_id'),
                email.get('sync_error'),
                email.get('retry_count', 0),
                email.get('next_retry_at'),
                internal_id,  # for COALESCE created_at
                now,
                now
            ))

        if not batch_data:
            return 0

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.executemany("""
                    INSERT OR REPLACE INTO email_metadata
                    (internal_id, message_id, thread_id, subject, sender, sender_email,
                     sender_name,
                     to_addr, cc_addr, date_received, mailbox,
                     is_read, is_flagged, sync_status, notion_page_id,
                     notion_thread_id, sync_error, retry_count, next_retry_at,
                     created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                            ?,
                            COALESCE((SELECT created_at FROM email_metadata WHERE internal_id = ?), ?),
                            ?)
                """, batch_data)

                conn.commit()
                saved_count = len(batch_data)
                logger.info(f"Saved {saved_count} emails to database (batch)")
                return saved_count

            except sqlite3.Error as e:
                logger.error(f"Failed to save emails batch: {e}")
                conn.rollback()
                return 0

    def get_email(self, message_id: str) -> Optional[EmailMetadata]:
        """获取单个邮件元数据（兼容旧 API）

        Args:
            message_id: 邮件 Message-ID

        Returns:
            邮件数据字典，不存在返回 None
        """
        return self.get_by_message_id(message_id)

    def get_earliest_email_by_thread_id(
        self,
        thread_id: str,
        exclude_message_id: str = None
    ) -> Optional[EmailMetadata]:
        """[已废弃] 查找同一线程中最早的邮件

        新架构使用 get_latest_email_by_thread_id() 替代。
        保留此方法用于向后兼容。

        Args:
            thread_id: 线程标识
            exclude_message_id: 排除的 message_id（当前正在同步的邮件）

        Returns:
            最早邮件的元数据字典，不存在返回 None
        """
        if not thread_id:
            return None

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                if exclude_message_id:
                    cursor.execute("""
                        SELECT * FROM email_metadata
                        WHERE thread_id = ? AND message_id != ?
                        ORDER BY date_received ASC
                        LIMIT 1
                    """, (thread_id, exclude_message_id))
                else:
                    cursor.execute("""
                        SELECT * FROM email_metadata
                        WHERE thread_id = ?
                        ORDER BY date_received ASC
                        LIMIT 1
                    """, (thread_id,))

                row = cursor.fetchone()
                if row:
                    logger.debug(f"Found earliest email in thread: {thread_id[:30]}...")
                    return dict(row)
                return None

            except sqlite3.Error as e:
                logger.error(f"Failed to get earliest email by thread_id: {e}")
                return None

    def get_latest_email_by_thread_id(
        self,
        thread_id: str,
        exclude_message_id: str = None
    ) -> Optional[EmailMetadata]:
        """查找同一线程中最新的邮件

        用于新架构的 Parent Item 关联：最新邮件作为母节点，
        其他邮件的 Parent Item 指向最新邮件。

        Args:
            thread_id: 线程标识
            exclude_message_id: 排除的 message_id（当前正在同步的邮件）

        Returns:
            最新邮件的元数据字典，不存在返回 None
        """
        if not thread_id:
            return None

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                if exclude_message_id:
                    cursor.execute("""
                        SELECT * FROM email_metadata
                        WHERE thread_id = ? AND message_id != ?
                        ORDER BY date_received DESC
                        LIMIT 1
                    """, (thread_id, exclude_message_id))
                else:
                    cursor.execute("""
                        SELECT * FROM email_metadata
                        WHERE thread_id = ?
                        ORDER BY date_received DESC
                        LIMIT 1
                    """, (thread_id,))

                row = cursor.fetchone()
                if row:
                    logger.debug(f"Found latest email in thread: {thread_id[:30]}...")
                    return dict(row)
                return None

            except sqlite3.Error as e:
                logger.error(f"Failed to get latest email by thread_id: {e}")
                return None

    def get_all_emails_by_thread_id(
        self,
        thread_id: str,
        exclude_message_id: str = None,
        synced_only: bool = False
    ) -> List[EmailMetadata]:
        """获取同一线程中的所有邮件

        用于新架构的 Parent Item 批量重建：找到线程中所有邮件，
        以便设置最新邮件的 Sub-item。

        Args:
            thread_id: 线程标识
            exclude_message_id: 排除的 message_id（当前正在同步的邮件）
            synced_only: 是否只返回已同步的邮件

        Returns:
            邮件元数据列表，按日期降序排序（最新在前）
        """
        if not thread_id:
            return []

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                conditions = ["thread_id = ?"]
                params: List[Any] = [thread_id]

                if exclude_message_id:
                    conditions.append("message_id != ?")
                    params.append(exclude_message_id)

                if synced_only:
                    conditions.append("sync_status = 'synced'")

                where_clause = " AND ".join(conditions)

                cursor.execute(f"""
                    SELECT * FROM email_metadata
                    WHERE {where_clause}
                    ORDER BY date_received DESC
                """, params)

                rows = cursor.fetchall()
                result = [dict(row) for row in rows]
                logger.debug(f"Found {len(result)} emails in thread: {thread_id[:30]}...")
                return result

            except sqlite3.Error as e:
                logger.error(f"Failed to get all emails by thread_id: {e}")
                return []

    def email_exists(self, message_id: str) -> bool:
        """检查邮件是否存在

        Args:
            message_id: 邮件 Message-ID

        Returns:
            是否存在
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute(
                    "SELECT 1 FROM email_metadata WHERE message_id = ?",
                    (message_id,)
                )
                return cursor.fetchone() is not None

            except sqlite3.Error as e:
                logger.error(f"Failed to check email exists: {e}")
                return False

    def get_all_message_ids(self) -> Set[str]:
        """获取所有已保存的 message_id

        注意：对于大型数据库，考虑使用 iter_message_ids() 迭代器版本。

        Returns:
            message_id 集合
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("SELECT message_id FROM email_metadata WHERE message_id IS NOT NULL")
                return {row['message_id'] for row in cursor.fetchall()}

            except sqlite3.Error as e:
                logger.error(f"Failed to get all message_ids: {e}")
                return set()

    def iter_message_ids(self, batch_size: int = 10000) -> Iterator[str]:
        """迭代获取所有 message_id（内存友好）

        使用分页查询避免大数据集时的内存问题。

        Args:
            batch_size: 每批次获取的数量

        Yields:
            message_id 字符串
        """
        offset = 0
        with self._connection() as conn:
            cursor = conn.cursor()

            while True:
                try:
                    cursor.execute(
                        "SELECT message_id FROM email_metadata WHERE message_id IS NOT NULL LIMIT ? OFFSET ?",
                        (batch_size, offset)
                    )
                    rows = cursor.fetchall()

                    if not rows:
                        break

                    for row in rows:
                        yield row['message_id']

                    if len(rows) < batch_size:
                        break

                    offset += batch_size

                except sqlite3.Error as e:
                    logger.error(f"Failed to iterate message_ids: {e}")
                    break

    def get_synced_message_ids(self) -> Set[str]:
        """获取所有已同步的 message_id

        Returns:
            message_id 集合
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute(
                    "SELECT message_id FROM email_metadata WHERE sync_status = 'synced' AND message_id IS NOT NULL"
                )
                return {row['message_id'] for row in cursor.fetchall()}

            except sqlite3.Error as e:
                logger.error(f"Failed to get synced message_ids: {e}")
                return set()

    def get_pending_emails(
        self,
        limit: int = 100,
        since_date: str = None
    ) -> List[EmailMetadata]:
        """获取待同步的邮件

        Args:
            limit: 最大返回数量
            since_date: 只返回此日期之后的邮件（格式: YYYY-MM-DD）

        Returns:
            邮件列表
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                if since_date:
                    cursor.execute("""
                        SELECT * FROM email_metadata
                        WHERE sync_status = 'pending'
                          AND date_received >= ?
                        ORDER BY date_received DESC
                        LIMIT ?
                    """, (since_date, limit))
                else:
                    cursor.execute("""
                        SELECT * FROM email_metadata
                        WHERE sync_status = 'pending'
                        ORDER BY date_received DESC
                        LIMIT ?
                    """, (limit,))

                return [dict(row) for row in cursor.fetchall()]

            except sqlite3.Error as e:
                logger.error(f"Failed to get pending emails: {e}")
                return []

    def get_emails_by_status(
        self,
        status: str,
        limit: int = 100
    ) -> List[EmailMetadata]:
        """按状态获取邮件

        Args:
            status: 同步状态 (pending/fetch_failed/synced/failed/skipped/dead_letter)
            limit: 最大返回数量

        Returns:
            邮件列表
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT * FROM email_metadata
                    WHERE sync_status = ?
                    ORDER BY date_received DESC
                    LIMIT ?
                """, (status, limit))

                return [dict(row) for row in cursor.fetchall()]

            except sqlite3.Error as e:
                logger.error(f"Failed to get emails by status: {e}")
                return []

    def mark_synced(
        self,
        message_id: str,
        notion_page_id: str,
        notion_thread_id: str = None
    ) -> bool:
        """标记邮件同步成功（兼容旧 API，使用 message_id）

        Args:
            message_id: 邮件 Message-ID
            notion_page_id: Notion 页面 ID
            notion_thread_id: Notion 线程页面 ID（可选）

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'synced',
                        notion_page_id = ?,
                        notion_thread_id = ?,
                        sync_error = NULL,
                        next_retry_at = NULL,
                        updated_at = ?
                    WHERE message_id = ?
                """, (notion_page_id, notion_thread_id, time.time(), message_id))

                conn.commit()
                logger.debug(f"Marked synced: {message_id[:50]}...")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to mark synced: {e}")
                conn.rollback()
                return False

    def mark_pending(self, message_id: str) -> bool:
        """重置邮件状态为待同步（用于重新同步场景）

        Args:
            message_id: 邮件 Message-ID

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'pending',
                        notion_page_id = NULL,
                        notion_thread_id = NULL,
                        sync_error = NULL,
                        retry_count = 0,
                        next_retry_at = NULL,
                        updated_at = ?
                    WHERE message_id = ?
                """, (time.time(), message_id))

                conn.commit()
                logger.debug(f"Marked pending: {message_id[:50]}...")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to mark pending: {e}")
                conn.rollback()
                return False

    def delete_email(self, message_id: str) -> bool:
        """删除邮件记录（兼容旧 API，使用 message_id）

        Args:
            message_id: 邮件 Message-ID

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute(
                    "DELETE FROM email_metadata WHERE message_id = ?",
                    (message_id,)
                )
                conn.commit()
                logger.debug(f"Deleted email record: {message_id[:50]}...")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to delete email: {e}")
                conn.rollback()
                return False

    def mark_failed(
        self,
        message_id: str,
        error_message: str,
        max_retries: int = 5
    ) -> bool:
        """标记邮件同步失败（兼容旧 API，使用 message_id）

        当重试次数达到 max_retries 时，自动标记为 dead_letter 状态。

        Args:
            message_id: 邮件 Message-ID
            error_message: 错误信息
            max_retries: 最大重试次数，默认 5

        Returns:
            是否成功
        """
        # 先获取 internal_id
        email = self.get_by_message_id(message_id)
        if not email:
            logger.warning(f"Email not found for mark_failed: {message_id[:50]}...")
            return False

        internal_id = email['internal_id']
        return self._update_for_retry(internal_id, 'failed', error_message, max_retries)

    def update_thread_id(
        self,
        message_id: str,
        thread_id: str
    ) -> bool:
        """更新邮件的 thread_id

        Args:
            message_id: 邮件 Message-ID
            thread_id: 新的 Thread ID

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET thread_id = ?, updated_at = ?
                    WHERE message_id = ?
                """, (thread_id, time.time(), message_id))

                conn.commit()
                return cursor.rowcount > 0

            except sqlite3.Error as e:
                logger.error(f"Failed to update thread_id: {e}")
                conn.rollback()
                return False

    # ==================== 失败重试队列操作（v3 架构统一在 email_metadata） ====================

    def get_ready_for_retry(self, limit: int = 10) -> List[EmailMetadata]:
        """获取可以重试的失败邮件

        v3 架构：统一查询 fetch_failed 和 failed 状态的邮件。

        Args:
            limit: 最大返回数量

        Returns:
            邮件列表（包含 internal_id）
        """
        now = time.time()

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT * FROM email_metadata
                    WHERE sync_status IN ('fetch_failed', 'failed')
                      AND next_retry_at IS NOT NULL
                      AND next_retry_at <= ?
                    ORDER BY next_retry_at ASC
                    LIMIT ?
                """, (now, limit))

                return [dict(row) for row in cursor.fetchall()]

            except sqlite3.Error as e:
                logger.error(f"Failed to get ready for retry: {e}")
                return []

    def get_failure_count(self) -> int:
        """获取失败队列数量（fetch_failed + failed）"""
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT COUNT(*) FROM email_metadata
                    WHERE sync_status IN ('fetch_failed', 'failed')
                """)
                return cursor.fetchone()[0]

            except sqlite3.Error as e:
                logger.error(f"Failed to get failure count: {e}")
                return 0

    # ==================== 统计和维护 ====================

    def get_processing_statuses(self, internal_ids: List[int]) -> Dict[int, str]:
        """批量读 processing_status（只含非空行，不过滤 sync_status）。

        供 MailWriteService.set_flags 的「置旗复活已完成邮件」不变量判断用：
        EmailMetadataRecord 不含 processing_status，这里补一个最小只读面。
        """
        if not internal_ids:
            return {}

        result: Dict[int, str] = {}
        with self._connection() as conn:
            cursor = conn.cursor()
            batch_size = 500
            for i in range(0, len(internal_ids), batch_size):
                batch = internal_ids[i:i + batch_size]
                placeholders = ','.join('?' * len(batch))
                cursor.execute(f"""
                    SELECT internal_id, processing_status
                    FROM email_metadata
                    WHERE internal_id IN ({placeholders})
                      AND processing_status IS NOT NULL
                """, batch)
                for row in cursor.fetchall():
                    result[row[0]] = row[1]
        return result

    def get_synced_flags(self, internal_ids: List[int]) -> Dict[int, Dict]:
        """批量获取已同步邮件的存储 flags 和 notion_page_id

        Args:
            internal_ids: 要查询的 internal_id 列表

        Returns:
            {internal_id: {'is_read': bool, 'is_flagged': bool, 'notion_page_id': str}}
        """
        if not internal_ids:
            return {}

        result = {}
        with self._connection() as conn:
            cursor = conn.cursor()
            # 分批查询避免 SQL 参数过多
            batch_size = 500
            for i in range(0, len(internal_ids), batch_size):
                batch = internal_ids[i:i + batch_size]
                placeholders = ','.join('?' * len(batch))
                cursor.execute(f"""
                    SELECT internal_id, is_read, is_flagged, notion_page_id
                    FROM email_metadata
                    WHERE internal_id IN ({placeholders})
                      AND sync_status = 'synced'
                      AND notion_page_id IS NOT NULL
                """, batch)
                for row in cursor.fetchall():
                    result[row[0]] = {
                        'is_read': bool(row[1]),
                        'is_flagged': bool(row[2]),
                        'notion_page_id': row[3],
                    }
        return result

    def get_all_synced_flags(self) -> Dict[int, Dict]:
        """获取所有已同步邮件的存储 flags（不限数量，用于全量 flag 检测）"""
        result = {}
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT internal_id, is_read, is_flagged, notion_page_id
                FROM email_metadata
                WHERE sync_status = 'synced'
                  AND notion_page_id IS NOT NULL
            """)
            for row in cursor.fetchall():
                result[row[0]] = {
                    'is_read': bool(row[1]),
                    'is_flagged': bool(row[2]),
                    'notion_page_id': row[3],
                }
        return result

    def update_local_flags(
        self,
        internal_id: int,
        is_read: bool,
        is_flagged: bool,
        processing_status: Optional[str] = None,
    ):
        """更新本地存储的 read/flagged 状态（不触发 Notion 同步）

        Sprint 15 D 块: processing_status 也镜像到 SQLite, 让前端 listEnriched
        能立即读到 done 状态 (processing_status='已完成'), 不等 Notion fanout.

        Args:
            internal_id: 邮件 internal_id
            is_read: 新的已读状态
            is_flagged: 新的旗标状态
            processing_status: 新的 Notion Processing Status 镜像值. None 表示不动
                (e.g. 只改 flag 不改 status 的场景). 空串 '' 视为清空.
        """
        with self._connection() as conn:
            cursor = conn.cursor()
            if processing_status is None:
                cursor.execute("""
                    UPDATE email_metadata
                    SET is_read = ?, is_flagged = ?, updated_at = ?
                    WHERE internal_id = ?
                """, (1 if is_read else 0, 1 if is_flagged else 0, time.time(), internal_id))
            else:
                cursor.execute("""
                    UPDATE email_metadata
                    SET is_read = ?, is_flagged = ?, processing_status = ?, updated_at = ?
                    WHERE internal_id = ?
                """, (
                    1 if is_read else 0,
                    1 if is_flagged else 0,
                    processing_status,
                    time.time(),
                    internal_id,
                ))
            conn.commit()

    def mark_read_if_unread_on_conn(
        self,
        conn: sqlite3.Connection,
        internal_id: int,
        expected_updated_at: Optional[float],
    ) -> bool:
        """CAS 置已读: **仅当该行仍是未读、且 updated_at 与快照一致时**把 is_read 翻
        True, 返回是否真的改到。

        借用调用方的连接与事务 (issue #58 入向已读回收把「校验 + 本地镜像 + outbox
        入队」放进同一个 BEGIN IMMEDIATE), 故这里**不 commit**。

        🔴 为什么不是无条件 UPDATE: 服务器 FLAGS 复核到写库之间用户可能刚把这封标成
        未读 —— 无条件写会把用户显式的「标为未读」吞掉, 且本功能单向 (只做未读→已读),
        后续周期**不会**自愈。
        🔴 为什么 ``is_read = 0`` 还不够、要连 ``updated_at`` 一起比: 用户标未读会把
        本地写回 is_read=0 (值与快照相同), 只比 is_read 看不出"这中间发生过一次写"。
        大批量收敛时队尾邮件距快照可达数秒, 足够「用户标未读 + outbox intent 派发完成
        (于是 has_pending 也归 false)」跑完 —— 那一封就会被静默改回已读。updated_at
        是那次写留下的唯一痕迹。rowcount==0 = 期间被动过 → 调用方放弃该封, 下轮重判
        (保守失败: 顶多晚一个周期收敛, 绝不覆盖用户操作)。旗标 / processing_status
        一概不碰。
        """
        cursor = conn.execute(
            """
            UPDATE email_metadata
               SET is_read = 1, updated_at = ?
             WHERE internal_id = ? AND is_read = 0 AND updated_at IS ?
            """,
            (time.time(), internal_id, expected_updated_at),
        )
        return cursor.rowcount > 0

    def get_inbox_unread_for_read_reconcile(
        self, mailbox: str = INBOX_LABEL
    ) -> List[Dict[str, Any]]:
        """入向已读回收 (issue #58) 专用: 取某 mailbox 下本地未读行的
        internal_id + imap_uid + imap_uidvalidity + updated_at。

        只读、无副作用。davmail 入向 read-reconcile 用它做**候选集**来源 (本地未读 ∧
        不在服务器 UNSEEN 集 → 候选, 再经定向 FETCH FLAGS 复核才收敛)。imap_uid /
        imap_uidvalidity 为 NULL 的行 (AppleScript 路径) 由上层 uidvalidity 一致性
        闸自然过滤。updated_at 供提交时的 CAS 比对 (见 mark_read_if_unread_on_conn:
        本轮期间被写过的行一律放弃)。不返 is_flagged: 收敛只动 is_read, 不做全量置态。

        mailbox 按 `filter_labels_for_mailbox` 展开成变体集 IN 查 (内建 canonical
        禁止 `= ?` 精确匹配, 见 CLAUDE.md mailbox 语义单源纪律)。
        """
        predicate, params = sql_in_predicate(
            "mailbox", filter_labels_for_mailbox(mailbox)
        )
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT internal_id, imap_uid, imap_uidvalidity, updated_at
                FROM email_metadata
                WHERE is_read = 0 AND {predicate}
                """,
                params,
            )
            return [
                {
                    "internal_id": row["internal_id"],
                    "imap_uid": row["imap_uid"],
                    "imap_uidvalidity": row["imap_uidvalidity"],
                    "updated_at": row["updated_at"],
                }
                for row in cursor.fetchall()
            ]

    def get_inbox_reconcile_fingerprints(
        self, mailbox: str = INBOX_LABEL
    ) -> tuple[set, set]:
        """收件箱对账 (方案 C) 专用: 取本地"已有哪些邮件"的两套指纹。

        返回 ``(message_ids, uid_pairs)``:

        - ``message_ids``: 非空 message_id 集合 —— **对账的主判据**。
          🔴 不能用 imap_uid 当主判据: davmail 的 UID 会被重新编号 (2026-08 实测
          348 封里 110 封 / 32% 与服务器现值不符, 最大偏差 +1535), 按 uid 比对会
          产出大量假阳性"缺失"。
        - ``uid_pairs``: ``(imap_uidvalidity, imap_uid)`` 集合 —— 仅用于**无
          Message-ID 的邮件**这条异常通道 (它们没有稳定标识可比)。
          注意 uid 会漂移, 所以这条通道天然只能"尽力而为": 漂移后可能重抓一次,
          由 save_email 幂等兜住。

        🔴 **两套指纹都不按 date 窗口过滤** (曾经按, 2026-08-11 实测踩过):
        本地 ``date_received`` 来自 **Date header**, 可被发送方伪造 / 缺失 / 严重
        滞后, 而远端 SEARCH 按 INTERNALDATE 筛 —— 两者不同源, 用它做集合边界会把
        "Date 很老但最近才进 INBOX"的邮件判成缺失。实测 13 封候选里 4 封 (31%)
        是这种假阳性 (本地早已 synced)。后果虽幂等 (merge guard 兜住), 但会每轮
        重复 fetch 同几封、污染 recovered 计数、把"漏抓"这个本该罕见的信号变成噪音。

        mailbox 按 `filter_labels_for_mailbox` 展开成变体集 IN 查
        (内建 canonical 禁止 `= ?` 精确匹配, 见 CLAUDE.md mailbox 语义单源纪律)。
        """
        predicate, params = sql_in_predicate(
            "mailbox", filter_labels_for_mailbox(mailbox)
        )
        message_ids: set = set()
        uid_pairs: set = set()
        with self._connection() as conn:
            cursor = conn.cursor()
            # 主判据: 非空 message_id 全集, **不按 date 窗口过滤**。
            #
            # 🔴 2026-08-11 实测: 按窗口过滤会产生**常态假阳性** —— 13 封候选里 4 封
            # (31%) 是本地早已 synced 的邮件, 只因它们的 Date header 是 7 月的
            # (远端按 INTERNALDATE 命中窗口, 本地 date_received 落在窗口外) 而查不到。
            # 后果虽然幂等 (merge guard 兜住, 不建重复行), 但会每轮重复 fetch 同几封、
            # 污染 recovered 计数、把"漏抓"这个本该罕见的告警变成噪音。
            # 这与 uid_pairs 放弃窗口过滤是同一个理由: **date_received 来自 Date
            # header, 不可信**。
            #
            # 代价: 全表 message_id 集合。活库实测 ~1.3 万条 ≈ 800KB, 6-7 万封的
            # 大邮箱约 4MB, 一次查询几十毫秒、**每 30 分钟才一次**、用完即释放 ——
            # 相比"每轮都误报几封缺失"完全划算。
            cursor.execute(
                f"""
                SELECT message_id FROM email_metadata
                WHERE {predicate}
                  AND message_id IS NOT NULL AND message_id != ''
                """,
                params,
            )
            message_ids = {row["message_id"] for row in cursor.fetchall()}

            # 异常通道: **只**取 message_id IS NULL 的行, 且**不按窗口过滤**。
            #
            # 🔴 两处都是有意的:
            # (1) 限定 IS NULL —— 收全部行会让"某封有 Message-ID 的旧行"恰好占用了
            #     远端某封无 ID 邮件的 uid, 从而把后者**误判成已存在**而永不补抓;
            # (2) 不按窗口 —— 本地 date_received 来自 **Date header**, 而远端按
            #     INTERNALDATE 筛。Date 可被发送方伪造/缺失/严重滞后, 窗口过滤会让
            #     这类行查不到 ⇒ 每轮都判缺失 ⇒ 而 NULL 不进 merge guard ⇒
            #     **每 30 分钟真的新增一行 + 一个 Notion 页**。无 Message-ID 的行
            #     天然极少 (活库实测 21 行), 全取的代价可忽略。
            cursor.execute(
                f"""
                SELECT imap_uidvalidity, imap_uid FROM email_metadata
                WHERE {predicate}
                  AND (message_id IS NULL OR message_id = '')
                  AND imap_uid IS NOT NULL
                """,
                params,
            )
            uid_pairs = {
                (row["imap_uidvalidity"], row["imap_uid"])
                for row in cursor.fetchall()
            }
        return message_ids, uid_pairs

    def update_ai_main_columns(
        self,
        internal_id: int,
        ai_priority: Optional[str] = None,
        ai_action: Optional[str] = None,
    ) -> None:
        """v14: 把 AI 标签镜像到 email_metadata 主表列 (走索引).

        LLMProcessingStore.mark_success / upsert_external_labels 内部调; labels_json
        仍保留全量作 backup. 仅 priority / action_type 进主表 (高频排序过滤).
        其他 AI 字段 (ai_summary / key_points / reply_suggestion_md / category /
        language) 仍走 labels_json json_extract.

        Args:
            ai_priority: 新 priority 值 (None 不动, 空串清空)
            ai_action: 新 action_type 值 (None 不动, 空串清空)
        """
        sets, args = [], []
        if ai_priority is not None:
            sets.append("ai_priority = ?")
            args.append(ai_priority or None)  # 空串 → NULL
        if ai_action is not None:
            sets.append("ai_action = ?")
            args.append(ai_action or None)
        if not sets:
            return
        sets.append("updated_at = ?")
        args.append(time.time())
        args.append(internal_id)
        with self._connection() as conn:
            conn.execute(
                f"UPDATE email_metadata SET {', '.join(sets)} WHERE internal_id = ?",
                args,
            )
            conn.commit()

    def get_stats(self) -> SyncStoreStats:
        """获取同步统计信息"""
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                # 邮件统计
                cursor.execute("SELECT COUNT(*) FROM email_metadata")
                total_emails = cursor.fetchone()[0]

                cursor.execute("""
                    SELECT sync_status, COUNT(*) as count
                    FROM email_metadata
                    GROUP BY sync_status
                """)
                status_counts = {row['sync_status']: row['count'] for row in cursor.fetchall()}

                cursor.execute("""
                    SELECT mailbox, COUNT(*) as count
                    FROM email_metadata
                    GROUP BY mailbox
                """)
                mailbox_counts = {row['mailbox']: row['count'] for row in cursor.fetchall()}

                # 失败队列统计（fetch_failed + failed）
                failure_count = status_counts.get('fetch_failed', 0) + status_counts.get('failed', 0)

                # 数据库大小
                db_size = self.db_path.stat().st_size if self.db_path.exists() else 0

                return SyncStoreStats(
                    total_emails=total_emails,
                    by_status=status_counts,
                    by_mailbox=mailbox_counts,
                    pending=status_counts.get('pending', 0),
                    synced=status_counts.get('synced', 0),
                    failed=status_counts.get('failed', 0),
                    fetch_failed=status_counts.get('fetch_failed', 0),
                    dead_letter=status_counts.get('dead_letter', 0),
                    skipped=status_counts.get('skipped', 0),
                    failure_queue=failure_count,
                    last_max_row_id=self.get_last_max_row_id(),
                    last_sync_time=self.get_last_sync_time(),
                    db_size_bytes=db_size,
                    db_size_mb=round(db_size / 1024 / 1024, 2)
                )

            except sqlite3.Error as e:
                logger.error(f"Failed to get stats: {e}")
                return SyncStoreStats()

    def clear_all(self) -> bool:
        """清空所有数据（谨慎使用）"""
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("DELETE FROM email_metadata")
                cursor.execute("DELETE FROM sync_state WHERE key != 'db_version'")
                cursor.execute("DELETE FROM thread_head_cache")
                conn.commit()
                logger.warning("Cleared all data from SyncStore")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to clear all: {e}")
                conn.rollback()
                return False

    def vacuum(self):
        """压缩数据库，回收空间"""
        with self._connection() as conn:
            try:
                conn.execute("VACUUM")
                logger.info("Database vacuumed")
            except sqlite3.Error as e:
                logger.error(f"Failed to vacuum database: {e}")

    # ==================== 线程头缓存操作 ====================

    def mark_thread_head_not_found(self, thread_id: str, note: str = None) -> bool:
        """标记线程头在 Mail.app 中找不到

        用于缓存无法获取的线程头，避免重复请求 Mail.app。

        Args:
            thread_id: 线程头的 message_id
            note: 备注信息

        Returns:
            是否成功
        """
        now = time.time()

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    INSERT OR REPLACE INTO thread_head_cache
                    (thread_id, status, checked_at, note)
                    VALUES (?, 'not_found', ?, ?)
                """, (thread_id, now, note))

                conn.commit()
                logger.debug(f"Marked thread head as not_found: {thread_id[:50]}...")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to mark thread head not found: {e}")
                conn.rollback()
                return False

    def is_thread_head_not_found(self, thread_id: str) -> bool:
        """检查线程头是否已标记为找不到

        Args:
            thread_id: 线程头的 message_id

        Returns:
            True 如果已标记为 not_found，否则 False
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT 1 FROM thread_head_cache
                    WHERE thread_id = ? AND status = 'not_found'
                """, (thread_id,))
                return cursor.fetchone() is not None

            except sqlite3.Error as e:
                logger.error(f"Failed to check thread head cache: {e}")
                return False

    def get_not_found_thread_heads(self) -> List[Dict[str, Any]]:
        """获取所有标记为找不到的线程头

        Returns:
            线程头列表
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT thread_id, status, checked_at, note
                    FROM thread_head_cache
                    WHERE status = 'not_found'
                """)
                return [dict(row) for row in cursor.fetchall()]

            except sqlite3.Error as e:
                logger.error(f"Failed to get not found thread heads: {e}")
                return []

    def clear_thread_head_cache(self, thread_id: str = None) -> bool:
        """清除线程头缓存

        Args:
            thread_id: 指定线程头，为 None 时清除所有

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                if thread_id:
                    cursor.execute(
                        "DELETE FROM thread_head_cache WHERE thread_id = ?",
                        (thread_id,)
                    )
                else:
                    cursor.execute("DELETE FROM thread_head_cache")

                conn.commit()
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to clear thread head cache: {e}")
                conn.rollback()
                return False

    # ==================== 邮件搜索（query_mail API） ====================

    def search_emails(self, filters: Dict, limit: int = 10, offset: int = 0) -> Dict:
        """搜索邮件元数据

        支持多条件组合查询，用于 query_mail API。

        Args:
            filters: 筛选条件字典，支持的 key：
                - query: 全文模糊搜索（匹配 subject + sender + sender_name）
                - from: 发件人筛选（LIKE 匹配 sender 或 sender_name）
                - subject: 主题筛选（LIKE 匹配）
                - date_from: 起始日期 YYYY-MM-DD
                - date_to: 截止日期 YYYY-MM-DD
                - mailbox: 邮箱名
                - is_flagged: 旗标状态
                - is_read: 已读状态
                - has_notion: 是否已同步到 Notion
            limit: 最大返回数量（上限 50）
            offset: 分页偏移

        Returns:
            {"total": int, "limit": int, "offset": int, "emails": [...]}
        """
        limit = min(limit, 50)
        # R-03: fetched 是死代码状态（无 mark_fetched 写入路径），已从允许列表删除
        conditions = ["sync_status IN ('synced', 'pending')"]
        params: List[Any] = []

        # 全文模糊搜索
        query = filters.get("query")
        if query:
            conditions.append("(subject LIKE ? OR sender LIKE ? OR sender_name LIKE ?)")
            like_val = f"%{query}%"
            params.extend([like_val, like_val, like_val])

        # 发件人筛选
        from_filter = filters.get("from")
        if from_filter:
            conditions.append("(sender LIKE ? OR sender_name LIKE ?)")
            like_val = f"%{from_filter}%"
            params.extend([like_val, like_val])

        # 主题筛选
        subject_filter = filters.get("subject")
        if subject_filter:
            conditions.append("subject LIKE ?")
            params.append(f"%{subject_filter}%")

        # 日期范围
        date_from = filters.get("date_from")
        if date_from:
            conditions.append("date_received >= ?")
            params.append(date_from)

        date_to = filters.get("date_to")
        if date_to:
            conditions.append("date_received <= ?")
            params.append(f"{date_to} 23:59:59")

        # 邮箱名
        mailbox = filters.get("mailbox")
        if mailbox:
            conditions.append("mailbox = ?")
            params.append(mailbox)

        # 旗标状态
        is_flagged = filters.get("is_flagged")
        if is_flagged is not None:
            conditions.append("is_flagged = ?")
            params.append(1 if is_flagged else 0)

        # 已读状态
        is_read = filters.get("is_read")
        if is_read is not None:
            conditions.append("is_read = ?")
            params.append(1 if is_read else 0)

        # 是否已同步到 Notion
        has_notion = filters.get("has_notion")
        if has_notion is not None:
            if has_notion:
                conditions.append("notion_page_id IS NOT NULL")
            else:
                conditions.append("notion_page_id IS NULL")

        where_clause = " AND ".join(conditions)

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                # 查询总数
                cursor.execute(f"SELECT COUNT(*) FROM email_metadata WHERE {where_clause}", params)
                total = cursor.fetchone()[0]

                # 查询数据
                cursor.execute(f"""
                    SELECT internal_id, message_id, subject, sender, sender_name,
                           date_received, mailbox, is_read, is_flagged, notion_page_id
                    FROM email_metadata
                    WHERE {where_clause}
                    ORDER BY date_received DESC
                    LIMIT ? OFFSET ?
                """, params + [limit, offset])

                emails = []
                for row in cursor.fetchall():
                    emails.append({
                        "internal_id": row["internal_id"],
                        "message_id": row["message_id"],
                        "subject": row["subject"],
                        "sender": row["sender"],
                        "sender_name": row["sender_name"],
                        "date_received": row["date_received"],
                        "mailbox": row["mailbox"],
                        "is_read": bool(row["is_read"]),
                        "is_flagged": bool(row["is_flagged"]),
                        "notion_page_id": row["notion_page_id"],
                    })

                return {"total": total, "limit": limit, "offset": offset, "emails": emails}

            except sqlite3.Error as e:
                logger.error(f"Failed to search emails: {e}")
                return {"total": 0, "limit": limit, "offset": offset, "emails": []}

    def get_dead_letter_emails(self, limit: int = 100) -> List[EmailMetadata]:
        """获取死信队列中的邮件（超过最大重试次数的邮件）

        这些邮件需要人工检查处理。

        Args:
            limit: 最大返回数量

        Returns:
            邮件列表
        """
        return self.get_emails_by_status('dead_letter', limit)

    def retry_dead_letter(self, message_id: str) -> bool:
        """将死信邮件重新加入重试队列

        用于人工确认后重新尝试同步。

        Args:
            message_id: 邮件 Message-ID

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                # 重置状态为 pending
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'pending',
                        retry_count = 0,
                        sync_error = NULL,
                        next_retry_at = NULL,
                        updated_at = ?
                    WHERE message_id = ? AND sync_status = 'dead_letter'
                """, (time.time(), message_id))

                if cursor.rowcount == 0:
                    logger.warning(f"Email not found or not in dead_letter status: {message_id[:50]}...")
                    return False

                conn.commit()
                logger.info(f"Moved dead_letter email back to pending: {message_id[:50]}...")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to retry dead letter: {e}")
                conn.rollback()
                return False

    # ==================== 周期会议系列操作 ====================

    def get_recurring_series(self, series_uid: str) -> Optional[Dict[str, Any]]:
        """读取一条 recurring_series 记录。"""
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    "SELECT * FROM recurring_series WHERE series_uid = ?",
                    (series_uid,),
                )
                row = cursor.fetchone()
                return dict(row) if row else None
            except sqlite3.Error as e:
                logger.error(f"Failed to get recurring_series {series_uid[:60]}: {e}")
                return None

    def upsert_recurring_series(self, row: Dict[str, Any]) -> bool:
        """写入或更新一条 recurring_series 记录。

        必填: series_uid, rrule_str, master_dtstart, master_dtend
        其他字段 None/missing 视为不更新（但 created_at/updated_at 自动维护）
        """
        required = ("series_uid", "rrule_str", "master_dtstart", "master_dtend")
        for k in required:
            if not row.get(k):
                logger.error(f"upsert_recurring_series missing required field: {k}")
                return False

        now = time.time()
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    "SELECT created_at FROM recurring_series WHERE series_uid = ?",
                    (row["series_uid"],),
                )
                existing = cursor.fetchone()

                payload = {
                    "series_uid": row["series_uid"],
                    "rrule_str": row["rrule_str"],
                    "exdates_json": row.get("exdates_json", "[]"),
                    "rdates_json": row.get("rdates_json", "[]"),
                    "master_dtstart": row["master_dtstart"],
                    "master_dtend": row["master_dtend"],
                    "master_summary": row.get("master_summary"),
                    "master_organizer": row.get("master_organizer"),
                    "master_organizer_email": row.get("master_organizer_email"),
                    "master_location": row.get("master_location"),
                    "master_description": row.get("master_description"),
                    "master_tzid": row.get("master_tzid"),
                    "master_is_all_day": int(bool(row.get("master_is_all_day", False))),
                    "last_sequence": int(row.get("last_sequence", 0)),
                    "last_seen_message_id": row.get("last_seen_message_id"),
                    "last_expanded_until": row.get("last_expanded_until"),
                    "last_modified": row.get("last_modified"),
                    "created_at": existing["created_at"] if existing else now,
                    "updated_at": now,
                }

                cursor.execute(
                    """
                    INSERT INTO recurring_series (
                        series_uid, rrule_str, exdates_json, rdates_json,
                        master_dtstart, master_dtend,
                        master_summary, master_organizer, master_organizer_email,
                        master_location, master_description, master_tzid, master_is_all_day,
                        last_sequence, last_seen_message_id,
                        last_expanded_until, last_modified,
                        created_at, updated_at
                    ) VALUES (
                        :series_uid, :rrule_str, :exdates_json, :rdates_json,
                        :master_dtstart, :master_dtend,
                        :master_summary, :master_organizer, :master_organizer_email,
                        :master_location, :master_description, :master_tzid, :master_is_all_day,
                        :last_sequence, :last_seen_message_id,
                        :last_expanded_until, :last_modified,
                        :created_at, :updated_at
                    )
                    ON CONFLICT(series_uid) DO UPDATE SET
                        rrule_str=excluded.rrule_str,
                        exdates_json=excluded.exdates_json,
                        rdates_json=excluded.rdates_json,
                        master_dtstart=excluded.master_dtstart,
                        master_dtend=excluded.master_dtend,
                        master_summary=excluded.master_summary,
                        master_organizer=excluded.master_organizer,
                        master_organizer_email=excluded.master_organizer_email,
                        master_location=excluded.master_location,
                        master_description=excluded.master_description,
                        master_tzid=excluded.master_tzid,
                        master_is_all_day=excluded.master_is_all_day,
                        last_sequence=excluded.last_sequence,
                        last_seen_message_id=excluded.last_seen_message_id,
                        last_expanded_until=excluded.last_expanded_until,
                        last_modified=excluded.last_modified,
                        updated_at=excluded.updated_at
                    """,
                    payload,
                )
                conn.commit()
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to upsert recurring_series: {e}")
                conn.rollback()
                return False

    def append_exdate(self, series_uid: str, exdate_iso: str) -> bool:
        """向 exdates_json 追加一个 ISO-8601 时间（去重，原子）。"""
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute("BEGIN IMMEDIATE")
                cursor.execute(
                    "SELECT exdates_json FROM recurring_series WHERE series_uid = ?",
                    (series_uid,),
                )
                row = cursor.fetchone()
                if not row:
                    conn.rollback()
                    logger.warning(f"append_exdate: series not found {series_uid[:60]}")
                    return False

                try:
                    existing = json.loads(row["exdates_json"] or "[]")
                except (json.JSONDecodeError, TypeError):
                    existing = []
                if not isinstance(existing, list):
                    existing = []

                if exdate_iso not in existing:
                    existing.append(exdate_iso)

                cursor.execute(
                    "UPDATE recurring_series SET exdates_json = ?, updated_at = ? WHERE series_uid = ?",
                    (json.dumps(existing), time.time(), series_uid),
                )
                conn.commit()
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to append_exdate {series_uid[:60]}: {e}")
                conn.rollback()
                return False

    def update_expanded_until(self, series_uid: str, until_iso: str) -> bool:
        """更新 last_expanded_until 高水位。"""
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    "UPDATE recurring_series SET last_expanded_until = ?, updated_at = ? WHERE series_uid = ?",
                    (until_iso, time.time(), series_uid),
                )
                conn.commit()
                return cursor.rowcount > 0
            except sqlite3.Error as e:
                logger.error(f"Failed to update_expanded_until {series_uid[:60]}: {e}")
                conn.rollback()
                return False

    def iter_series_needing_expansion(self, cutoff_iso: str) -> Iterator[Dict[str, Any]]:
        """返回 last_expanded_until < cutoff（或为空）的系列行。

        Args:
            cutoff_iso: ISO-8601 字符串，期望的高水位。低于此的系列需要补展。
        """
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    """
                    SELECT * FROM recurring_series
                    WHERE last_expanded_until IS NULL
                       OR last_expanded_until < ?
                    """,
                    (cutoff_iso,),
                )
                for row in cursor.fetchall():
                    yield dict(row)
            except sqlite3.Error as e:
                logger.error(f"Failed to iter_series_needing_expansion: {e}")
                return

    # ============================================================
    # v34: email_meeting (邮件 ↔ 日历 ical_uid 映射)
    # ============================================================

    def upsert_email_meeting(
        self,
        internal_id: int,
        *,
        ical_uid: str,
        method: Optional[str] = None,
        recurrence_id: Optional[str] = None,
        sequence: int = 0,
        is_recurring: bool = False,
    ) -> bool:
        """写入/更新一封邮件的会议 uid 映射行 (PK=internal_id, upsert)。

        new_watcher 会议检测 hook / recurring_invite.replay_one 调用。
        失败仅记 error 不抛 (映射是旁路增强, 不阻断主 sync 流程)。
        """
        if not ical_uid:
            return False
        now = time.time()
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    """
                    INSERT INTO email_meeting (
                        internal_id, ical_uid, method, recurrence_id,
                        sequence, is_recurring, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (internal_id) DO UPDATE SET
                        ical_uid      = excluded.ical_uid,
                        method        = excluded.method,
                        recurrence_id = excluded.recurrence_id,
                        sequence      = excluded.sequence,
                        is_recurring  = excluded.is_recurring,
                        updated_at    = excluded.updated_at
                    """,
                    (
                        internal_id, ical_uid, method, recurrence_id,
                        int(sequence or 0), int(bool(is_recurring)), now, now,
                    ),
                )
                conn.commit()
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to upsert_email_meeting {internal_id}: {e}")
                conn.rollback()
                return False

    def get_email_meeting(self, internal_id: int) -> Optional[Dict[str, Any]]:
        """读取一封邮件的会议 uid 映射行。"""
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    "SELECT * FROM email_meeting WHERE internal_id = ?",
                    (internal_id,),
                )
                row = cursor.fetchone()
                return dict(row) if row else None
            except sqlite3.Error as e:
                logger.error(f"Failed to get_email_meeting {internal_id}: {e}")
                return None

    # ============================================================
    # v6: cli_checkpoints (PR-4 长任务 checkpoint / resume)
    # ============================================================

    def upsert_cli_checkpoint(
        self,
        *,
        command: str,
        target_kind: str,
        target_key: str,
        last_completed_internal_id: Optional[int],
        succeeded: int,
        failed: int,
        payload: Optional[Dict[str, Any]] = None,
        aborted_at: Optional[float] = None,
    ) -> None:
        """UPSERT 长任务 checkpoint 行 (PK: command, target_key)."""
        now = time.time()
        payload_json = json.dumps(payload, ensure_ascii=False) if payload else None
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO cli_checkpoints
                    (command, target_kind, target_key, last_completed_internal_id,
                     succeeded, failed, aborted_at, started_at, updated_at, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(command, target_key) DO UPDATE SET
                    target_kind = excluded.target_kind,
                    last_completed_internal_id = excluded.last_completed_internal_id,
                    succeeded = excluded.succeeded,
                    failed = excluded.failed,
                    aborted_at = excluded.aborted_at,
                    updated_at = excluded.updated_at,
                    payload = excluded.payload
                """,
                (
                    command,
                    target_kind,
                    target_key,
                    last_completed_internal_id,
                    int(succeeded),
                    int(failed),
                    aborted_at,
                    now,
                    now,
                    payload_json,
                ),
            )
            conn.commit()

    def get_cli_checkpoint(
        self, command: str, target_key: str
    ) -> Optional[Dict[str, Any]]:
        """读单条 checkpoint, 不存在返回 None."""
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT command, target_kind, target_key, last_completed_internal_id,
                       succeeded, failed, aborted_at, started_at, updated_at, payload
                  FROM cli_checkpoints
                 WHERE command = ? AND target_key = ?
                """,
                (command, target_key),
            )
            row = cursor.fetchone()
            if not row:
                return None
            return dict(row)

    def delete_cli_checkpoint(self, command: str, target_key: str) -> bool:
        """删 checkpoint (任务完成后清理)."""
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM cli_checkpoints WHERE command = ? AND target_key = ?",
                (command, target_key),
            )
            conn.commit()
            return cursor.rowcount > 0

    # ============================================================
    # v6: v4_rollout_stats (PR-4 R-06 持久化)
    # ============================================================

    def write_v4_rollout_snapshot(
        self,
        *,
        from_sqlite_hit: int,
        fallback_miss: int,
        fallback_error: int,
        route_latency_p99_ms: float,
        body_miss_internal_ids: Optional[List[int]] = None,
        window_seconds: int = 60,
        flushed_at: Optional[float] = None,
    ) -> int:
        """写一条 v4_rollout 快照, 返回 rowid (id)."""
        ts = flushed_at if flushed_at is not None else time.time()
        ids_json = (
            json.dumps(body_miss_internal_ids, ensure_ascii=False)
            if body_miss_internal_ids else None
        )
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO v4_rollout_stats
                    (flushed_at, from_sqlite_hit, fallback_miss, fallback_error,
                     route_latency_p99_ms, body_miss_internal_ids, window_seconds)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ts,
                    int(from_sqlite_hit),
                    int(fallback_miss),
                    int(fallback_error),
                    float(route_latency_p99_ms),
                    ids_json,
                    int(window_seconds),
                ),
            )
            conn.commit()
            return cursor.lastrowid

    def get_latest_v4_rollout(self) -> Optional[Dict[str, Any]]:
        """读最新一条 v4_rollout snapshot, 不存在返回 None.

        body_miss_internal_ids 字段返回 list[int] 而非 JSON 字符串.
        """
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, flushed_at, from_sqlite_hit, fallback_miss, fallback_error,
                       route_latency_p99_ms, body_miss_internal_ids, window_seconds
                  FROM v4_rollout_stats
                 ORDER BY flushed_at DESC
                 LIMIT 1
                """
            )
            row = cursor.fetchone()
            if not row:
                return None
            out = dict(row)
            raw_ids = out.get("body_miss_internal_ids")
            if raw_ids:
                try:
                    out["body_miss_internal_ids"] = json.loads(raw_ids)
                except (TypeError, ValueError):
                    out["body_miss_internal_ids"] = []
            else:
                out["body_miss_internal_ids"] = []
            return out
