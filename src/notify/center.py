"""通知中心核心写面 NotifyCenter (task 08-20-notification-center, design §3)。

发布入口单源 (PRD 基线 4): 各信源挂点一律经 ``NotifyCenter.publish()`` 落
``notification`` 表, 禁止各处自拼通知行。表 DDL 在 ``src/mail/sync_store.py``
(v68), 值域单源在 ``src/notify/center_models.py``。

模块形状 (design §3.1):

- 构造**只收 db_path** —— ``AgentRunWorker`` 等挂点手里没有 SyncStore 只有路径,
  而 ``SyncStore()`` 构造会跑全量迁移梯子, 不能在挂点侧随手 new。
- per-call ``sqlite3.connect`` + 写事务 ``BEGIN IMMEDIATE`` (``MatterRepository``
  形状, src/matters/repository.py:41-62)。
- 全部方法**同步**; async 调用方自行 ``await asyncio.to_thread(...)``。
- 本模块正常 raise (单测友好); 「通知路径绝不影响业务终态」的 try/except 吞
  纪律在**挂点侧** (run_worker.py:157-160 先例)。
- 事件纪律: commit **之后**才 ``safe_publish("notification.changed", ...)``
  (事务内发 = 事件先到、DB 后提交 → 前端 refetch 读到旧值; matters/service.py
  + job_worker.py 双先例)。🔴 事件 data 里**只有 category**, 绝不携带行 id ——
  防回加闸 tests/notify/test_center.py 锁死 (matter.attention id-space 墓志铭)。
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Union

from src.events.publisher import safe_publish
from src.notify.center_models import (
    _SEVERITY_RANK,
    NOTIFICATION_CATEGORY_VALUES,
    NOTIFICATION_SEVERITY_VALUES,
)

#: 读口径单源 (design §8.d): snooze 到期唤醒是**读侧语义** —— state='snoozed'
#: 且 snoozed_until 已过期的行视同 open, 没有后台 tick 把 state 改回去。
#: list / unread_count / 未读判据一律经本片段, 禁止各查询各写一遍
#: (mailbox_semantics 纪律的同款精神)。
_OPEN_PREDICATE = (
    "(state='open' OR (state='snoozed' AND snoozed_until IS NOT NULL"
    " AND snoozed_until <= :now))"
)

#: ``list(state='snoozed')`` 的精确过滤 = **未到期**的 snoozed (活跃行内与
#: ``_OPEN_PREDICATE`` 互补, 同一行不会同时出现在两个口径里)。
_SNOOZED_PREDICATE = (
    "(state='snoozed' AND (snoozed_until IS NULL OR snoozed_until > :now))"
)

#: 「活跃」判据, 与 partial unique 索引 ``uq_notification_active_dedupe`` 的
#: WHERE 子句**逐字一致** (sync_store.py 头注红字)。
_ACTIVE_STATES_SQL = "state IN ('open','snoozed')"

#: 未读判据 = 未读位 + 视同 open (resolved/dismissed 不计未读)。
_UNREAD_PREDICATE = f"(read_at IS NULL AND {_OPEN_PREDICATE})"

_LIST_STATE_VALUES = ("open", "snoozed", "resolved", "all")


def _default_clock_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


class NotifyCenterError(RuntimeError):
    """带错误码的领域异常 (MatterError 同形, src/matters/resource_identity.py:11)。

    code ∈ E_INVALID_ARG / E_NOT_FOUND / E_INVALID_STATE —— REST 层 (步骤 6)
    按 code 映射 HTTP 状态。
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class PublishResult:
    id: int
    created: bool  # True=开了新行; False=计次更新了活跃行
    recurrence_no: int


@dataclass(frozen=True)
class ListResult:
    items: List[Dict[str, Any]]
    total: int  # 匹配当前过滤条件的总行数 (不受 limit/offset 影响)
    unread: int  # 同 category 范围内的未读数 (与 state 过滤无关, 供徽标口径)


class NotifyCenter:
    def __init__(
        self,
        db_path: Union[str, Path],
        *,
        clock_ms: Callable[[], int] = _default_clock_ms,
    ) -> None:
        self.db_path = str(db_path)
        self.clock_ms = clock_ms

    # ==================== 连接 / 事务 ====================

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ==================== 写面 ====================

    def publish(
        self,
        *,
        category: str,
        source: str,
        title: str,
        dedupe_key: str,
        body: str = "",
        severity: str = "info",
        payload: Optional[dict] = None,
        emit_event: bool = True,
    ) -> PublishResult:
        """落库一条通知; 同 dedupe_key 有活跃行则计次更新 (design §3.2)。

        枚举参数前置校验 —— 让 INSERT 阶段的 IntegrityError **只可能**来自
        partial unique 撞车, 重试路径语义才干净 (CHECK 违例混进来会被误当竞态
        重试一次再裸抛)。
        """
        if category not in NOTIFICATION_CATEGORY_VALUES:
            raise NotifyCenterError("E_INVALID_ARG", f"invalid category: {category!r}")
        if severity not in NOTIFICATION_SEVERITY_VALUES:
            raise NotifyCenterError("E_INVALID_ARG", f"invalid severity: {severity!r}")
        if not dedupe_key:
            raise NotifyCenterError("E_INVALID_ARG", "dedupe_key is required")
        now = self.clock_ms()
        payload_json = (
            json.dumps(payload, ensure_ascii=False) if payload is not None else None
        )
        with self._transaction() as conn:
            row = self._active_row(conn, dedupe_key)
            if row is not None:
                result = self._bump(
                    conn, row, now=now, severity=severity, title=title,
                    body=body, payload_json=payload_json,
                )
            else:
                try:
                    result = self._insert_new(
                        conn, now=now, category=category, source=source,
                        severity=severity, dedupe_key=dedupe_key, title=title,
                        body=body, payload_json=payload_json,
                    )
                except sqlite3.IntegrityError:
                    # BEGIN IMMEDIATE 下他连接进不来, 这是并发窗口的兜底
                    # (design §3.2 规则 4): 撞 uq_notification_active_dedupe
                    # → 重走一次活跃行查找, 转计次路径; 至多重试一次。
                    row = self._active_row(conn, dedupe_key)
                    if row is None:
                        raise
                    result = self._bump(
                        conn, row, now=now, severity=severity, title=title,
                        body=body, payload_json=payload_json,
                    )
        if emit_event:
            self.emit_changed(category=category)
        return result

    def _active_row(
        self, conn: sqlite3.Connection, dedupe_key: str
    ) -> Optional[sqlite3.Row]:
        return conn.execute(
            f"SELECT * FROM notification WHERE dedupe_key=? AND {_ACTIVE_STATES_SQL}",
            (dedupe_key,),
        ).fetchone()

    def _bump(
        self,
        conn: sqlite3.Connection,
        row: Mapping[str, Any],
        *,
        now: int,
        severity: str,
        title: str,
        body: str,
        payload_json: Optional[str],
    ) -> PublishResult:
        """计次更新活跃行: recurrence_no+1、未读化、severity 只升不降、state 不动。

        read_at 清回 NULL = 又发生了, 用户该再看见 (design §3.2 规则 2);
        state 不动 —— snoozed 保持 snoozed (用户明确说了晚点看, 重复触发不
        打断; 到期唤醒由 ``_OPEN_PREDICATE`` 读口径兜住)。
        """
        new_severity = row["severity"]
        if _SEVERITY_RANK[severity] > _SEVERITY_RANK[new_severity]:
            new_severity = severity
        new_recurrence = int(row["recurrence_no"]) + 1
        conn.execute(
            "UPDATE notification SET recurrence_no=?, last_event_at=?, read_at=NULL, "
            "title=?, body=?, payload_json=?, severity=? WHERE id=?",
            (new_recurrence, now, title, body, payload_json, new_severity, row["id"]),
        )
        return PublishResult(
            id=int(row["id"]), created=False, recurrence_no=new_recurrence
        )

    def _insert_new(
        self,
        conn: sqlite3.Connection,
        *,
        now: int,
        category: str,
        source: str,
        severity: str,
        dedupe_key: str,
        title: str,
        body: str,
        payload_json: Optional[str],
    ) -> PublishResult:
        """开新行; recurrence_no 从同 key 最近一代续接 (design §3.2 规则 3)。

        resolved / dismissed 之后再来 = 新条目复活成新行 (历史行是审计轨迹,
        不改老行); 计数续接让「第 N 次」在面板可见。
        """
        prev = conn.execute(
            "SELECT recurrence_no FROM notification WHERE dedupe_key=? "
            "ORDER BY id DESC LIMIT 1",
            (dedupe_key,),
        ).fetchone()
        recurrence_no = (int(prev["recurrence_no"]) + 1) if prev is not None else 1
        cursor = conn.execute(
            "INSERT INTO notification (category, source, severity, state, dedupe_key, "
            "recurrence_no, title, body, payload_json, first_created_at, last_event_at) "
            "VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)",
            (
                category, source, severity, dedupe_key, recurrence_no,
                title, body, payload_json, now, now,
            ),
        )
        return PublishResult(
            id=int(cursor.lastrowid), created=True, recurrence_no=recurrence_no
        )

    def resolve_by_dedupe(self, dedupe_key: str, *, emit_event: bool = True) -> int:
        """关闭该 key 的活跃行 (open|snoozed) → resolved; 返回影响行数。

        告警 RECOVER 挂点用 (design §7/§8.b): 异常恢复时把对应通知收掉。
        无活跃行 = 0, 不抛 (RECOVER 可能先于 ENTER 到达重启后的进程)。
        """
        now = self.clock_ms()
        with self._transaction() as conn:
            row = self._active_row(conn, dedupe_key)
            if row is None:
                return 0
            cursor = conn.execute(
                "UPDATE notification SET state='resolved', resolved_at=?, "
                f"snoozed_until=NULL WHERE dedupe_key=? AND {_ACTIVE_STATES_SQL}",
                (now, dedupe_key),
            )
            updated = cursor.rowcount
            category = row["category"]
        if updated and emit_event:
            self.emit_changed(category=category)
        return updated

    def mark_read(self, notification_id: int) -> Dict[str, Any]:
        """read_at=now, 幂等 (已读行不动); 返回投影。read 与 state 正交。"""
        now = self.clock_ms()
        with self._transaction() as conn:
            cursor = conn.execute(
                "UPDATE notification SET read_at=? WHERE id=? AND read_at IS NULL",
                (now, notification_id),
            )
            changed = cursor.rowcount == 1
            row = conn.execute(
                "SELECT * FROM notification WHERE id=?", (notification_id,)
            ).fetchone()
            if row is None:
                raise NotifyCenterError(
                    "E_NOT_FOUND", f"notification {notification_id} not found"
                )
            projected = self._project(row)
        if changed:
            self.emit_changed(category=projected["category"])
        return projected

    def mark_all_read(self, *, category: Optional[str] = None) -> int:
        """全部已读; 返回标掉的行数。

        ``last_event_at <= :now`` 取「请求处理时刻」快照边界 —— 并发 publish
        进来的新行 last_event_at > now, 不被顺手标掉 (design §3.1)。
        """
        if category is not None and category not in NOTIFICATION_CATEGORY_VALUES:
            raise NotifyCenterError("E_INVALID_ARG", f"invalid category: {category!r}")
        now = self.clock_ms()
        sql = (
            "UPDATE notification SET read_at=:now "
            "WHERE read_at IS NULL AND last_event_at <= :now"
        )
        params: Dict[str, Any] = {"now": now}
        if category is not None:
            sql += " AND category=:category"
            params["category"] = category
        with self._transaction() as conn:
            updated = conn.execute(sql, params).rowcount
        if updated:
            self.emit_changed(category=category)
        return updated

    def snooze(self, notification_id: int, *, until_ms: int) -> Dict[str, Any]:
        """snooze 到未来时刻; CAS 只允许活跃行 (attention.py:267-274 守卫形状)。"""
        now = self.clock_ms()
        if int(until_ms) <= now:
            raise NotifyCenterError(
                "E_INVALID_ARG", "snooze until must be in the future"
            )
        return self._close_or_snooze(
            notification_id,
            changes_sql="state='snoozed', snoozed_until=?",
            changes_params=(int(until_ms),),
        )

    def resolve(self, notification_id: int) -> Dict[str, Any]:
        """resolved + resolved_at=now; CAS 同 snooze。"""
        return self._close_or_snooze(
            notification_id,
            changes_sql="state='resolved', resolved_at=?, snoozed_until=NULL",
            changes_params=(self.clock_ms(),),
        )

    def _close_or_snooze(
        self,
        notification_id: int,
        *,
        changes_sql: str,
        changes_params: tuple,
    ) -> Dict[str, Any]:
        with self._transaction() as conn:
            cursor = conn.execute(
                f"UPDATE notification SET {changes_sql} "
                f"WHERE id=? AND {_ACTIVE_STATES_SQL}",
                (*changes_params, notification_id),
            )
            if cursor.rowcount != 1:
                exists = conn.execute(
                    "SELECT id FROM notification WHERE id=?", (notification_id,)
                ).fetchone()
                if exists is None:
                    raise NotifyCenterError(
                        "E_NOT_FOUND", f"notification {notification_id} not found"
                    )
                raise NotifyCenterError(
                    "E_INVALID_STATE", "notification is already closed"
                )
            row = conn.execute(
                "SELECT * FROM notification WHERE id=?", (notification_id,)
            ).fetchone()
            projected = self._project(row)
        self.emit_changed(category=projected["category"])
        return projected

    def emit_changed(self, *, category: Optional[str] = None) -> None:
        """commit 后的刷新信号; 批量写场景 (emit_event=False 多次) 末尾手动 flush。

        🔴 data 键集 ⊆ {category} —— 只当 invalidation hint, 绝不带行 id /
        业务实体 (design §4.1, 防回加闸锁死)。safe_publish 自身永不抛。
        """
        data = {"category": category} if category is not None else None
        safe_publish("notification.changed", data=data, source="notify-center")

    # ==================== 读面 ====================

    def list(
        self,
        *,
        category: Optional[str] = None,
        state: str = "open",
        unread_only: bool = False,
        limit: int = 50,
        offset: int = 0,
    ) -> ListResult:
        """列表面。state ∈ open|snoozed|resolved|all (open 含到期 snoozed)。"""
        if category is not None and category not in NOTIFICATION_CATEGORY_VALUES:
            raise NotifyCenterError("E_INVALID_ARG", f"invalid category: {category!r}")
        if state not in _LIST_STATE_VALUES:
            raise NotifyCenterError("E_INVALID_ARG", f"invalid state: {state!r}")
        now = self.clock_ms()
        where: List[str] = []
        params: Dict[str, Any] = {"now": now}
        if category is not None:
            where.append("category=:category")
            params["category"] = category
        if state == "open":
            where.append(_OPEN_PREDICATE)
        elif state == "snoozed":
            where.append(_SNOOZED_PREDICATE)
        elif state == "resolved":
            where.append("state='resolved'")
        if unread_only:
            where.append("read_at IS NULL")
        where_sql = " AND ".join(where) if where else "1=1"
        unread_where = _UNREAD_PREDICATE + (
            " AND category=:category" if category is not None else ""
        )
        conn = self._connect()
        try:
            total = int(
                conn.execute(
                    f"SELECT COUNT(*) FROM notification WHERE {where_sql}", params
                ).fetchone()[0]
            )
            unread = int(
                conn.execute(
                    f"SELECT COUNT(*) FROM notification WHERE {unread_where}", params
                ).fetchone()[0]
            )
            rows = conn.execute(
                f"SELECT * FROM notification WHERE {where_sql} "
                "ORDER BY last_event_at DESC, id DESC LIMIT :limit OFFSET :offset",
                {**params, "limit": int(limit), "offset": int(offset)},
            ).fetchall()
        finally:
            conn.close()
        return ListResult(
            items=[self._project(row) for row in rows], total=total, unread=unread
        )

    def unread_count(self) -> Dict[str, Any]:
        """铃铛徽标口径: {"total", "by_category", "by_severity", "open_by_category"}
        (三轴键恒全)。

        三轴出自**同一条** GROUP BY 查询 —— 口径按构造就一致, 不会出现「换个查询
        漏了到期 snoozed」的分裂。by_severity 供铃铛的 critical 红点档用 (未读里有
        critical → 红点, 否则计数点)。

        🔴 ``open_by_category`` 与前两轴的语义差是本方法的要点 (M3 批 C5, 收编
        TitleBar 旧徽标): 未读是 **edge + 人工消费型** (看过一眼就掉), 而被收编的
        `AgentPendingBadge` 是 **level 型** (审批挂着数字就在)。只留未读轴的话
        「读了通知但没去批」= 徽标清零而待办还挂着 —— 铃铛据此多一档持久指示。
        故本轴按 ``_OPEN_PREDICATE`` 统计, **不带** read 过滤。
        """
        now = self.clock_ms()
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT category, severity, (read_at IS NULL) AS is_unread, "
                f"COUNT(*) AS n FROM notification WHERE {_OPEN_PREDICATE} "
                "GROUP BY category, severity, is_unread",
                {"now": now},
            ).fetchall()
        finally:
            conn.close()
        by_category = {value: 0 for value in NOTIFICATION_CATEGORY_VALUES}
        by_severity = {value: 0 for value in NOTIFICATION_SEVERITY_VALUES}
        open_by_category = {value: 0 for value in NOTIFICATION_CATEGORY_VALUES}
        for row in rows:
            count = int(row["n"])
            open_by_category[row["category"]] += count
            # 未读 = 活跃里 read_at IS NULL 的那一半, 按定义等价于
            # ``_UNREAD_PREDICATE`` (= read_at IS NULL AND _OPEN_PREDICATE) ——
            # 分组多带一维就够, 不为第二轴再跑一条 SQL (口径分裂的常见来源)。
            if row["is_unread"]:
                by_category[row["category"]] += count
                by_severity[row["severity"]] += count
        return {
            "total": sum(by_category.values()),
            "by_category": by_category,
            "by_severity": by_severity,
            "open_by_category": open_by_category,
        }

    def get(self, notification_id: int) -> Dict[str, Any]:
        """按 id 取单条投影; 不存在 → E_NOT_FOUND。

        `POST /publish` 用 (publish 返回 PublishResult 只有 id/created/计次,
        而 REST 契约要回单条投影)。
        """
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT * FROM notification WHERE id=?", (notification_id,)
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            raise NotifyCenterError(
                "E_NOT_FOUND", f"notification {notification_id} not found"
            )
        return self._project(row)

    # ==================== 投影 ====================

    @staticmethod
    def _project(row: Union[sqlite3.Row, Mapping[str, Any]]) -> Dict[str, Any]:
        """行 → snake_case 投影 (REST 层再转 camelCase); payload 解析失败静默
        None (attention.py:473-480 先例)。"""
        result = dict(row)
        raw = result.pop("payload_json", None)
        try:
            parsed = json.loads(raw) if raw else None
        except (TypeError, json.JSONDecodeError):
            parsed = None
        result["payload"] = parsed if isinstance(parsed, dict) else None
        return result
