"""SQLite access for the Matter aggregate."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping

from .models import (
    MATTER_SEARCH_FIELDS,
    MATTER_TAG_DEFAULT_COLOR,
    MATTER_TAG_DEFAULT_SHAPE,
)
from .resource_identity import parse_resource_key

#: 「下一步」的档位表（越小越优先）。值域与前端 `matterDerive.MatterNextActionKind` 的
#: 条目那三档同名 —— 状态派生的 monitoring / done / missing 三档不在这里（见
#: `MatterRepository.list_next_action_summaries` 的说明）。
#: 🔴 blocker 在 schema 上恒 `status IS NULL`（`matter_item` 的 CHECK 约束只允许 action
#: 带 status），所以这里不判 blocker 的 status —— 判了也永远为真，只会让人以为它有状态机。
_NEXT_ACTION_RANKS: tuple[tuple[int, str, str, frozenset[str] | None], ...] = (
    (0, "action", "action", frozenset({"open", "in_progress"})),
    (1, "waiting", "action", frozenset({"waiting"})),
    (2, "blocker", "blocker", None),
)


def _next_action_rank(kind: str, status: Any) -> tuple[int, str] | None:
    for rank, next_kind, item_kind, statuses in _NEXT_ACTION_RANKS:
        if kind != item_kind:
            continue
        if statuses is not None and str(status or "") not in statuses:
            continue
        return rank, next_kind
    return None


class MatterRepository:
    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def get_matter(
        self, conn: sqlite3.Connection, public_id: str, *, include_deleted: bool = True
    ) -> dict[str, Any] | None:
        sql = "SELECT * FROM matter WHERE public_id=?"
        params: list[Any] = [public_id]
        if not include_deleted:
            sql += " AND deleted_at IS NULL"
        row = conn.execute(sql, params).fetchone()
        return self._matter_row(row) if row else None

    def get_matter_by_id(
        self, conn: sqlite3.Connection, matter_id: int
    ) -> dict[str, Any] | None:
        row = conn.execute("SELECT * FROM matter WHERE id=?", (matter_id,)).fetchone()
        return self._matter_row(row) if row else None

    def public_id_of(self, conn: sqlite3.Connection, matter_id: int) -> str | None:
        """内部主键 → `MAT-0001`。只取一列, 给 `_append_event` 的事件登记用 (S1)。

        走 `get_matter_by_id` 会把整行 + JSON 反序列化一遍, 而这里每条事件都要调一次。
        """
        row = conn.execute(
            "SELECT public_id FROM matter WHERE id=?", (matter_id,)
        ).fetchone()
        return str(row["public_id"]) if row else None

    def find_event(
        self, conn: sqlite3.Connection, dedupe_key: str
    ) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT * FROM matter_event WHERE dedupe_key=?", (dedupe_key,)
        ).fetchone()
        return self._event_row(row) if row else None

    def allocate_sequence(self, conn: sqlite3.Connection, created_at: int) -> int:
        cursor = conn.execute(
            "INSERT INTO matter_seq(created_at) VALUES (?)", (created_at,)
        )
        return int(cursor.lastrowid)

    def insert_matter(self, conn: sqlite3.Connection, values: Mapping[str, Any]) -> int:
        columns = tuple(values)
        cursor = conn.execute(
            f"INSERT INTO matter ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )
        return int(cursor.lastrowid)

    def cas_update_matter(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        expected_version: int,
        changes: Mapping[str, Any],
    ) -> bool:
        assignments = [f"{column}=?" for column in changes]
        assignments.append("version=version+1")
        cursor = conn.execute(
            f"UPDATE matter SET {', '.join(assignments)} WHERE id=? AND version=?",
            (*changes.values(), matter_id, expected_version),
        )
        return cursor.rowcount == 1

    def insert_event(self, conn: sqlite3.Connection, values: Mapping[str, Any]) -> int:
        columns = tuple(values)
        cursor = conn.execute(
            f"INSERT INTO matter_event ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )
        return int(cursor.lastrowid)

    def insert_update(self, conn: sqlite3.Connection, values: Mapping[str, Any]) -> int:
        columns = tuple(values)
        cursor = conn.execute(
            f"INSERT INTO matter_update ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )
        return int(cursor.lastrowid)

    def insert_item(self, conn: sqlite3.Connection, values: Mapping[str, Any]) -> int:
        columns = tuple(values)
        cursor = conn.execute(
            f"INSERT INTO matter_item ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )
        return int(cursor.lastrowid)

    def update_item(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        item_id: int,
        changes: Mapping[str, Any],
    ) -> bool:
        assignments = [f"{column}=?" for column in changes]
        assignments.append("version=version+1")
        cursor = conn.execute(
            f"UPDATE matter_item SET {', '.join(assignments)} WHERE id=? AND matter_id=?",
            (*changes.values(), item_id, matter_id),
        )
        return cursor.rowcount == 1

    def get_item(
        self, conn: sqlite3.Connection, matter_id: int, item_id: int
    ) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT * FROM matter_item WHERE id=? AND matter_id=?", (item_id, matter_id)
        ).fetchone()
        return self._item_row(row) if row else None

    def list_items(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        *,
        kind: str | None = None,
        status: str | None = None,
        include_deleted: bool = False,
    ) -> list[dict[str, Any]]:
        clauses = ["matter_id=?"]
        params: list[Any] = [matter_id]
        if kind:
            clauses.append("kind=?")
            params.append(kind)
        if status:
            clauses.append("status=?")
            params.append(status)
        if not include_deleted:
            clauses.append("deleted_at IS NULL")
        rows = conn.execute(
            f"SELECT * FROM matter_item WHERE {' AND '.join(clauses)} ORDER BY position, id",
            params,
        ).fetchall()
        return [self._item_row(row) for row in rows]

    def list_events(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        *,
        cursor: int | None,
        limit: int,
    ) -> tuple[list[dict[str, Any]], int | None]:
        clauses = ["matter_id=?"]
        params: list[Any] = [matter_id]
        if cursor is not None:
            clauses.append("id < ?")
            params.append(cursor)
        params.append(limit + 1)
        rows = conn.execute(
            f"SELECT * FROM matter_event WHERE {' AND '.join(clauses)} ORDER BY id DESC LIMIT ?",
            params,
        ).fetchall()
        next_cursor = int(rows[limit - 1]["id"]) if len(rows) > limit else None
        return [self._event_row(row) for row in rows[:limit]], next_cursor

    def list_updates(
        self, conn: sqlite3.Connection, matter_id: int
    ) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT * FROM matter_update WHERE matter_id=? ORDER BY created_at DESC, id DESC",
            (matter_id,),
        ).fetchall()
        return [self._update_row(row) for row in rows]

    def list_matters(
        self,
        conn: sqlite3.Connection,
        *,
        filters: Mapping[str, Any],
        cursor: tuple[int, int] | None,
        limit: int,
        sort: str,
    ) -> tuple[list[dict[str, Any]], tuple[int, int] | None, int]:
        clauses: list[str] = []
        params: list[Any] = []
        deleted = filters.get("deleted")
        archived = filters.get("archived")
        view = filters.get("view")
        if deleted is True or view == "trash":
            clauses.append("deleted_at IS NOT NULL")
        else:
            clauses.append("deleted_at IS NULL")
        if archived is True or view == "archived":
            clauses.append("archived_at IS NOT NULL")
        elif archived is False or view not in ("archived", "trash"):
            clauses.append("archived_at IS NULL")
        for field in ("status", "health", "priority"):
            value = filters.get(field)
            if value:
                clauses.append(f"{field}=?")
                params.append(value)
        if filters.get("type"):
            clauses.append("matter_type=?")
            params.append(filters["type"])
        if filters.get("tag"):
            clauses.append(
                "EXISTS (SELECT 1 FROM json_each(matter.tags_json) WHERE value=?)"
            )
            params.append(filters["tag"])
        query_text = str(filters.get("q") or "").strip()
        search_join = ""
        select_prefix = "matter.*"
        if query_text:
            search_join = " JOIN matter_search_document search_doc ON search_doc.matter_id=matter.id"
            if len(query_text) >= 3:
                search_join += " JOIN matter_fts ON matter_fts.rowid=matter.id"
                clauses.append("matter_fts MATCH ?")
                params.append(self._fts_query(query_text))
            else:
                like = f"%{self._escape_like(query_text)}%"
                clauses.append(
                    "(" + " OR ".join(
                        f"search_doc.{column} LIKE ? ESCAPE '\\'"
                        for column in self._search_columns()
                    ) + ")"
                )
                params.extend(like for _ in self._search_columns())
            select_prefix += ", " + ", ".join(
                f"search_doc.{column} AS search_{column}"
                for column in self._search_columns()
            )
        order_column = "updated_at" if sort != "created_at" else "created_at"
        if cursor:
            clauses.append(
                f"(matter.{order_column} < ? OR "
                f"(matter.{order_column}=? AND matter.id < ?))"
            )
            params.extend((cursor[0], cursor[0], cursor[1]))
        where = " AND ".join(clauses) or "1=1"
        total = int(
            conn.execute(
                f"SELECT COUNT(*) FROM matter{search_join} WHERE {where}", params
            ).fetchone()[0]
        )
        rows = conn.execute(
            f"SELECT {select_prefix} FROM matter{search_join} WHERE {where} "
            f"ORDER BY matter.{order_column} DESC, matter.id DESC LIMIT ?",
            (*params, limit + 1),
        ).fetchall()
        next_cursor = None
        if len(rows) > limit:
            last = rows[limit - 1]
            next_cursor = (int(last[order_column]), int(last["id"]))
        results = [self._matter_row(row) for row in rows[:limit]]
        if query_text:
            for result in results:
                self._add_search_match(result, query_text)
        return results, next_cursor, total

    def list_stakeholder_summaries(
        self,
        conn: sqlite3.Connection,
        matter_ids: list[int],
        *,
        preview_limit: int = 6,
    ) -> dict[int, tuple[list[dict[str, Any]], int]]:
        """清单行头像组（design `list.jsx::MatterRow` 的 `AvatarStack`）的**批量**投影。

        🔴 一次查询覆盖整页事项，绝不按行发请求 —— 清单是随事项数线性增长的面，逐行取
        干系人会把一次列表加载放大成 N 次往返（`frontend/ARCHITECTURE.md` §7.1-7.2 的
        列表性能铁律）。排序与 `MatterService.context_snapshot` 的干系人段同口径
        （等待中优先、其次入库序），头像组截断后仍给出总数好让 UI 显示 `+N`。
        """
        if not matter_ids:
            return {}
        placeholders = ", ".join("?" for _ in matter_ids)
        rows = conn.execute(
            "SELECT matter_id,display_name,email_normalized,is_waiting_on "
            f"FROM matter_stakeholder WHERE matter_id IN ({placeholders}) "
            "AND deleted_at IS NULL "
            "ORDER BY matter_id, is_waiting_on DESC, id",
            tuple(matter_ids),
        ).fetchall()
        summaries: dict[int, tuple[list[dict[str, Any]], int]] = {
            matter_id: ([], 0) for matter_id in matter_ids
        }
        for row in rows:
            preview, count = summaries[int(row["matter_id"])]
            if len(preview) < preview_limit:
                preview.append(
                    {
                        "display_name": row["display_name"],
                        "email_normalized": row["email_normalized"],
                        "is_waiting_on": bool(row["is_waiting_on"]),
                    }
                )
            summaries[int(row["matter_id"])] = (preview, count + 1)
        return summaries

    def list_next_action_summaries(
        self,
        conn: sqlite3.Connection,
        matter_ids: list[int],
    ) -> dict[int, dict[str, Any]]:
        """清单行「下一步」的**批量**投影（design `list.jsx::nextAction` 的条目那一段）。

        🔴 存在的理由：列表端点不返回 `items`，于是前端的 `nextAction()` 在清单里恒落到
        「缺少下一步」兜底 —— 一屏事项全在喊自己没有下一步，而详情页打开就有。Focus 页的
        「健康活跃率」同源（`hasNextAction`），跟着一起失真。

        🔴 优先级与前端 `matterDerive.nextAction` **逐条对齐**（同一份语义在两处实现，改一处
        必改另一处）：可执行 action（open/in_progress）> 等待中 action（waiting）> 未完成
        blocker；同级取 `position, id` 靠前的那条 —— 与详情端点列条目的排序同口径，免得
        清单说的下一步和详情列表第一条对不上。三档都没有 ⇒ 不产出这个键，前端按事项**状态**
        自己派生（监控中 / 已完成 / 缺少下一步），那部分留在前端单源。

        🔴 一次查询覆盖整页事项，绝不按行发请求（`list_stakeholder_summaries` 同一条列表
        性能铁律，`frontend/ARCHITECTURE.md` §7.1-7.2）。
        """
        if not matter_ids:
            return {}
        placeholders = ", ".join("?" for _ in matter_ids)
        rows = conn.execute(
            "SELECT matter_id,kind,status,title,due_at FROM matter_item "
            f"WHERE matter_id IN ({placeholders}) AND deleted_at IS NULL "
            "AND kind IN ('action','blocker') "
            "ORDER BY matter_id, position, id",
            tuple(matter_ids),
        ).fetchall()
        best: dict[int, tuple[int, dict[str, Any]]] = {}
        for row in rows:
            ranked = _next_action_rank(str(row["kind"]), row["status"])
            if ranked is None:
                continue
            rank, kind = ranked
            matter_id = int(row["matter_id"])
            current = best.get(matter_id)
            # `<=` ⇒ 同档保留先遇到的那条（rows 已按 position,id 排序）。
            if current is not None and current[0] <= rank:
                continue
            best[matter_id] = (
                rank,
                {
                    "kind": kind,
                    "title": row["title"],
                    "due_at": row["due_at"],
                },
            )
        return {matter_id: value for matter_id, (_, value) in best.items()}

    def list_tags(self, conn: sqlite3.Connection) -> list[dict[str, Any]]:
        rows = conn.execute(
            """
            WITH referenced AS (
                SELECT json_each.value AS name, COUNT(DISTINCT matter.id) AS usage_count
                FROM matter, json_each(matter.tags_json)
                WHERE matter.deleted_at IS NULL
                  AND json_each.type = 'text'
                  AND length(trim(json_each.value)) > 0
                GROUP BY json_each.value
            )
            SELECT * FROM (
                SELECT
                    t.name AS name,
                    t.color AS color,
                    t.shape AS shape,
                    t.created_at AS created_at,
                    COALESCE(r.usage_count, 0) AS usage_count,
                    0 AS inferred
                FROM matter_tag t
                LEFT JOIN referenced r ON r.name = t.name
                UNION ALL
                SELECT
                    r.name AS name,
                    ? AS color,
                    ? AS shape,
                    NULL AS created_at,
                    r.usage_count AS usage_count,
                    1 AS inferred
                FROM referenced r
                LEFT JOIN matter_tag t ON t.name = r.name
                WHERE t.name IS NULL
            )
            ORDER BY lower(name), name
            """,
            (MATTER_TAG_DEFAULT_COLOR.value, MATTER_TAG_DEFAULT_SHAPE.value),
        ).fetchall()
        return [self._tag_row(row) for row in rows]

    def get_tag(self, conn: sqlite3.Connection, name: str) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT name,color,shape,created_at FROM matter_tag WHERE name=?",
            (name,),
        ).fetchone()
        return self._tag_row(row) if row else None

    def tag_is_referenced(
        self, conn: sqlite3.Connection, name: str, *, include_deleted: bool = True
    ) -> bool:
        clauses = ["json_each.value=?"]
        if not include_deleted:
            clauses.append("matter.deleted_at IS NULL")
        return (
            conn.execute(
                "SELECT 1 FROM matter, json_each(matter.tags_json) "
                f"WHERE {' AND '.join(clauses)} LIMIT 1",
                (name,),
            ).fetchone()
            is not None
        )

    def upsert_tag(
        self,
        conn: sqlite3.Connection,
        *,
        name: str,
        color: str,
        shape: str,
        created_at: int,
    ) -> dict[str, Any]:
        conn.execute(
            "INSERT INTO matter_tag(name,color,shape,created_at) VALUES (?,?,?,?) "
            "ON CONFLICT(name) DO UPDATE SET color=excluded.color,shape=excluded.shape",
            (name, color, shape, created_at),
        )
        tag = self.get_tag(conn, name)
        if tag is None:
            raise RuntimeError(f"failed to upsert matter tag {name!r}")
        return tag

    def merge_or_rename_tag_definition(
        self,
        conn: sqlite3.Connection,
        *,
        old_name: str,
        new_name: str,
        created_at: int,
    ) -> dict[str, Any]:
        old_tag = self.get_tag(conn, old_name)
        new_tag = self.get_tag(conn, new_name)
        if old_tag and new_tag:
            conn.execute("DELETE FROM matter_tag WHERE name=?", (old_name,))
        elif old_tag:
            conn.execute(
                "UPDATE matter_tag SET name=? WHERE name=?", (new_name, old_name)
            )
        elif not new_tag:
            conn.execute(
                "INSERT INTO matter_tag(name,color,shape,created_at) VALUES (?,?,?,?)",
                (
                    new_name,
                    MATTER_TAG_DEFAULT_COLOR.value,
                    MATTER_TAG_DEFAULT_SHAPE.value,
                    created_at,
                ),
            )
        tag = self.get_tag(conn, new_name)
        if tag is None:
            raise RuntimeError(f"failed to resolve renamed matter tag {new_name!r}")
        return tag

    def delete_tag(self, conn: sqlite3.Connection, name: str) -> bool:
        cursor = conn.execute("DELETE FROM matter_tag WHERE name=?", (name,))
        return cursor.rowcount > 0

    def list_matter_rows_with_tag(
        self, conn: sqlite3.Connection, name: str
    ) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT DISTINCT matter.id, matter.public_id, matter.tags_json, matter.version "
            "FROM matter, json_each(matter.tags_json) "
            "WHERE json_each.value=? ORDER BY matter.id",
            (name,),
        ).fetchall()
        return [dict(row) for row in rows]

    def rename_tag_references(
        self, conn: sqlite3.Connection, *, old_name: str, new_name: str, updated_at: int
    ) -> list[dict[str, Any]]:
        changed: list[dict[str, Any]] = []
        for row in self.list_matter_rows_with_tag(conn, old_name):
            before = self._json(row["tags_json"], [])
            after = self._rename_tag_values(before, old_name, new_name)
            if after == before:
                continue
            conn.execute(
                "UPDATE matter SET tags_json=?, updated_at=?, last_activity_at=?, "
                "version=version+1 WHERE id=?",
                (self._dump(after), updated_at, updated_at, row["id"]),
            )
            changed.append(
                {
                    "id": int(row["id"]),
                    "public_id": row["public_id"],
                    "version": int(row["version"]),
                    "before": before,
                    "after": after,
                }
            )
        return changed

    def remove_tag_references(
        self, conn: sqlite3.Connection, *, name: str, updated_at: int
    ) -> list[dict[str, Any]]:
        changed: list[dict[str, Any]] = []
        for row in self.list_matter_rows_with_tag(conn, name):
            before = self._json(row["tags_json"], [])
            after = self._remove_tag_values(before, name)
            if after == before:
                continue
            conn.execute(
                "UPDATE matter SET tags_json=?, updated_at=?, last_activity_at=?, "
                "version=version+1 WHERE id=?",
                (self._dump(after), updated_at, updated_at, row["id"]),
            )
            changed.append(
                {
                    "id": int(row["id"]),
                    "public_id": row["public_id"],
                    "version": int(row["version"]),
                    "before": before,
                    "after": after,
                }
            )
        return changed

    def get_tag_mutation(
        self, conn: sqlite3.Connection, dedupe_key: str
    ) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT value FROM sync_state WHERE key=?", (f"matter_tag_mutation:{dedupe_key}",)
        ).fetchone()
        if not row:
            return None
        return self._json(row["value"], None)

    def put_tag_mutation(
        self,
        conn: sqlite3.Connection,
        dedupe_key: str,
        *,
        value: Mapping[str, Any],
        updated_at: int,
    ) -> None:
        conn.execute(
            "INSERT OR REPLACE INTO sync_state(key,value,updated_at) VALUES (?,?,?)",
            (
                f"matter_tag_mutation:{dedupe_key}",
                self._dump(value),
                updated_at,
            ),
        )

    def upsert_resource(
        self, conn: sqlite3.Connection, values: Mapping[str, Any]
    ) -> tuple[dict[str, Any], bool]:
        """按 (provider, external_key) upsert 一份资料身份行。

        v56 前这里是 INSERT-ONLY（命中既有行原样返回、一个字段都不更新）——后果是
        后算出来的摘要（`sum` 三列）对**存量资料永远写不进去**。现在命中既有行走一个
        **显式白名单**的增量更新（`_resource_update_assignments`），其余列恒不覆盖：

          - ``kind`` / ``provider`` / ``external_key``：身份，永不改（kind 冲突在
            service `_upsert_resource` 已 raise `E_RESOURCE_IDENTITY_CONFLICT`）；
          - ``revision`` / ``content_hash`` / ``permission_state`` / ``sync_state`` /
            ``last_checked_at``：全仓唯一写者是 URL 抓取路径（service
            ``fetch_url_resource`` 直 UPDATE），upsert 调用方对它们一律传 None ——
            收进更新面 = 每次 re-link 都用 None 冲掉抓取结果；
          - ``access_policy``：owner 经 ``patch_resource`` 设的可见性档；upsert 调用方
            带的是默认 'allowed'，收进来会把「仅元数据」静默翻回放行；
          - ``created_at``：恒不改（``updated_at`` 只在真有增量时跟着 bump）。
        """
        existing = conn.execute(
            "SELECT * FROM resource WHERE provider=? AND external_key=?",
            (values["provider"], values["external_key"]),
        ).fetchone()
        if existing:
            updates = self._resource_update_assignments(existing, values)
            if updates:
                assignments = ", ".join(f'"{column}"=?' for column in updates)
                conn.execute(
                    f"UPDATE resource SET {assignments} WHERE id=?",
                    (*updates.values(), existing["id"]),
                )
                row = conn.execute(
                    "SELECT * FROM resource WHERE id=?", (existing["id"],)
                ).fetchone()
                return self._resource_row(row), False
            return self._resource_row(existing), False
        columns = tuple(values)
        cursor = conn.execute(
            f"INSERT INTO resource ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )
        row = conn.execute("SELECT * FROM resource WHERE id=?", (cursor.lastrowid,)).fetchone()
        return self._resource_row(row), True

    @classmethod
    def _resource_update_assignments(
        cls, existing: sqlite3.Row, values: Mapping[str, Any]
    ) -> dict[str, Any]:
        """命中既有行时允许更新的字段增量（🔴 白名单；恒不覆盖清单见 upsert_resource）。

        三类语义各不相同：

          - ``title`` / ``canonical_url``：**只补空** —— 既有值可能来自更权威的源
            （URL 抓取回的页面标题 / 已被用户看到过的原文地址），re-link 不 churn；
          - ``metadata_json``：**浅合并，调用方非 None 键胜出，绝不丢既有键** ——
            URL 缓存（cached_excerpt / cache_meta）只由抓取路径写、合并天然保留；
            调用方带来的身份元数据（sender/to_addr/cc_addr 等）借此补进老行
            （干系人候选正是从这几个键推的，v56 前对存量行结构性恒缺）；
          - ``sum`` / ``sum_src`` / ``sum_at``：调用方给出**非空 sum** 才三列一起写
            （新摘要胜出——邮件摘要重跑 / Agent 重新概括都以最新为准；被冲掉的那份**不**
            在这里留档 —— v57 版本轨迹只在**版本真的变了**的那一刻归档，落点是
            ``service.fetch_url_resource``，同一版本内换个说法不是历史）；没给 = 一列
            都不碰（re-link 不许把已有摘要冲成 NULL）。
            既有行 ``access_policy='metadata_only'`` 时整组跳过 —— 「仅元数据」的资料
            停止更新摘要（H3§5.3），policy 翻回 allowed 后下次触到再恢复。
        """
        updates: dict[str, Any] = {}
        for column in ("title", "canonical_url"):
            if existing[column] is None and values.get(column) is not None:
                updates[column] = values[column]
        existing_meta = cls._json(existing["metadata_json"], {})
        incoming_meta = cls._json(values.get("metadata_json"), {})
        merged_meta = dict(existing_meta)
        for key, value in incoming_meta.items():
            if value is not None:
                merged_meta[key] = value
        if merged_meta != existing_meta:
            updates["metadata_json"] = cls._dump(merged_meta)
        new_sum = values.get("sum")
        if new_sum and existing["access_policy"] != "metadata_only":
            if (existing["sum"], existing["sum_src"]) != (new_sum, values.get("sum_src")):
                updates["sum"] = new_sum
                updates["sum_src"] = values.get("sum_src")
                updates["sum_at"] = values.get("sum_at")
        if updates:
            updates["updated_at"] = values.get("updated_at", existing["updated_at"])
        return updates

    def get_resource(self, conn: sqlite3.Connection, resource_id: int) -> dict[str, Any] | None:
        row = conn.execute("SELECT * FROM resource WHERE id=?", (resource_id,)).fetchone()
        return self._resource_row(row) if row else None

    def get_resource_link(
        self, conn: sqlite3.Connection, matter_id: int, resource_id: int, *, live_only: bool = False
    ) -> dict[str, Any] | None:
        sql = "SELECT * FROM matter_resource WHERE matter_id=? AND resource_id=?"
        if live_only:
            sql += " AND deleted_at IS NULL"
        sql += " ORDER BY id DESC LIMIT 1"
        row = conn.execute(sql, (matter_id, resource_id)).fetchone()
        return self._resource_link_row(row) if row else None

    # ── 资料版本轨迹 (v57, 设计稿 H3§5.4) ──────────────────────────────────────
    # 三个方法就是本表的全部写读面。表里**只有历史**: 当前版本是 `resource` 行自己。

    def archive_resource_version(
        self, conn: sqlite3.Connection, resource: Mapping[str, Any], superseded_at: int
    ) -> int:
        """把 ``resource`` 当前的版本身份 + 当时那份摘要留档成一条轨迹行。

        入参是**被取代前**的资料行快照 —— 调用方必须在 UPDATE 之前把它读出来，
        否则留下的是新版本的副本（轨迹全变成当前值的复读）。
        """
        cursor = conn.execute(
            "INSERT INTO resource_version "
            '(resource_id, revision, content_hash, superseded_at, diff_text, '
            '"sum", sum_src, sum_at) '
            "VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
            (
                int(resource["id"]),
                resource.get("revision"),
                resource.get("content_hash"),
                superseded_at,
                resource.get("sum"),
                resource.get("sum_src"),
                resource.get("sum_at"),
            ),
        )
        return int(cursor.lastrowid)

    def list_resource_versions(
        self, conn: sqlite3.Connection, resource_id: int, *, limit: int = 50
    ) -> list[dict[str, Any]]:
        """该资料的历史版本，新的在前（索引 idx_resource_version_trail 同序）。"""
        rows = conn.execute(
            "SELECT * FROM resource_version WHERE resource_id=? "
            "ORDER BY superseded_at DESC, id DESC LIMIT ?",
            (resource_id, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def fill_latest_version_diff(
        self, conn: sqlite3.Connection, resource_id: int, diff_text: str
    ) -> bool:
        """把「变了什么」一句补进**最新**那条轨迹行的空位，返回是否真写了。

        为什么是「最新一条」: 那一行留档的正是被当前版本取代的上一版，而 Agent 手上
        读到的就是当前版本 —— 它给的差异说明描述的正是这一次取代。

        ``diff_text IS NULL`` 是幂等闸: 已经写过的不覆盖（同一份提案被重放、或后一轮
        run 又提了一次 diff，都不该改写已经给 owner 看过的那句）。轨迹为空（这份资料
        还没检出过新版本）时一行都不匹配，返回 False —— 不新建行，因为没有"上一版"。
        """
        cursor = conn.execute(
            "UPDATE resource_version SET diff_text=? WHERE id = ("
            "SELECT id FROM resource_version WHERE resource_id=? AND diff_text IS NULL "
            "ORDER BY superseded_at DESC, id DESC LIMIT 1)",
            (diff_text, resource_id),
        )
        return cursor.rowcount > 0

    def insert_resource_link(self, conn: sqlite3.Connection, values: Mapping[str, Any]) -> int:
        columns = tuple(values)
        cursor = conn.execute(
            f"INSERT INTO matter_resource ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )
        return int(cursor.lastrowid)

    def get_resource_rejection(
        self, conn: sqlite3.Connection, matter_id: int, resource_key: str
    ) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT * FROM matter_resource_rejection WHERE matter_id=? AND resource_key=?",
            (matter_id, resource_key),
        ).fetchone()
        return dict(row) if row else None

    def upsert_resource_rejection(
        self, conn: sqlite3.Connection, values: Mapping[str, Any]
    ) -> None:
        conn.execute(
            "INSERT INTO matter_resource_rejection "
            "(matter_id,resource_key,rejected_at,evidence_fingerprint,reason) "
            "VALUES (?,?,?,?,?) ON CONFLICT(matter_id,resource_key) DO UPDATE SET "
            "rejected_at=excluded.rejected_at,evidence_fingerprint=excluded.evidence_fingerprint,"
            "reason=excluded.reason",
            (
                values["matter_id"],
                values["resource_key"],
                values["rejected_at"],
                values["evidence_fingerprint"],
                values.get("reason"),
            ),
        )

    def list_duplicate_candidate_rows(
        self, conn: sqlite3.Connection, *, exclude_matter_id: int | None = None
    ) -> list[dict[str, Any]]:
        params: list[Any] = []
        excluded = ""
        if exclude_matter_id is not None:
            excluded = " AND m.id<>?"
            params.append(exclude_matter_id)
        rows = conn.execute(
            "SELECT m.*, d.title AS search_title, d.description AS search_description, "
            "d.current_summary AS search_summary, d.items_text, d.stakeholders_text, d.notes_text "
            "FROM matter m JOIN matter_search_document d ON d.matter_id=m.id "
            "WHERE m.deleted_at IS NULL" + excluded + " ORDER BY m.updated_at DESC, m.id DESC LIMIT 500",
            params,
        ).fetchall()
        results: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["stakeholder_emails"] = [
                value[0]
                for value in conn.execute(
                    "SELECT email_normalized FROM matter_stakeholder "
                    "WHERE matter_id=? AND deleted_at IS NULL AND email_normalized IS NOT NULL",
                    (row["id"],),
                ).fetchall()
            ]
            item["resource_keys"] = [
                f"{value[0]}:{value[1]}"
                for value in conn.execute(
                    "SELECT r.provider,r.external_key FROM matter_resource mr "
                    "JOIN resource r ON r.id=mr.resource_id "
                    "WHERE mr.matter_id=? AND mr.deleted_at IS NULL",
                    (row["id"],),
                ).fetchall()
            ]
            results.append(item)
        return results

    def list_resources(self, conn: sqlite3.Connection, matter_id: int, filters: Mapping[str, Any]) -> list[dict[str, Any]]:
        clauses = ["mr.matter_id=?"]
        params: list[Any] = [matter_id]
        if not filters.get("include_deleted"):
            clauses.append("mr.deleted_at IS NULL")
        if filters.get("kind"):
            clauses.append("r.kind=?")
            params.append(filters["kind"])
        if filters.get("pinned") is not None:
            clauses.append("mr.pinned=?")
            params.append(1 if filters["pinned"] else 0)
        if filters.get("access_policy"):
            clauses.append("r.access_policy=?")
            params.append(filters["access_policy"])
        if filters.get("sub_state"):
            clauses.append("mr.sub_state=?")
            params.append(filters["sub_state"])
        rows = conn.execute(
            "SELECT r.*, mr.id AS link_id, mr.matter_id AS link_matter_id, mr.relation_type, mr.pinned, mr.added_by_kind, "
            "mr.added_by_id, mr.confidence, mr.provenance_json, mr.confirmed_at, mr.sub_state, "
            "mr.deleted_at AS link_deleted_at, mr.created_at AS link_created_at, mr.updated_at AS link_updated_at "
            f"FROM matter_resource mr JOIN resource r ON r.id=mr.resource_id WHERE {' AND '.join(clauses)} "
            "ORDER BY mr.pinned DESC, mr.created_at, mr.id",
            params,
        ).fetchall()
        return [self._joined_resource_row(conn, row) for row in rows]

    def lookup_resource_links(self, conn: sqlite3.Connection, provider: str, keys: list[str]) -> dict[str, list[dict[str, Any]]]:
        results = {key: [] for key in keys}
        if not keys:
            return results
        placeholders = ",".join("?" for _ in keys)
        rows = conn.execute(
            "SELECT r.id AS resource_id, r.external_key, r.kind, mr.id AS link_id, mr.pinned, mr.sub_state, "
            "m.public_id, m.title, m.status, m.health, m.priority, m.archived_at "
            "FROM resource r JOIN matter_resource mr ON mr.resource_id=r.id "
            "JOIN matter m ON m.id=mr.matter_id "
            f"WHERE r.provider=? AND r.external_key IN ({placeholders}) AND mr.deleted_at IS NULL "
            "AND m.deleted_at IS NULL ORDER BY m.updated_at DESC, m.id DESC",
            (provider, *keys),
        ).fetchall()
        for row in rows:
            item = dict(row)
            item["available"] = self.resource_available(conn, provider, row["kind"], row["external_key"])
            results[row["external_key"]].append(item)
        return results

    def resource_available(self, conn: sqlite3.Connection, provider: str, kind: str, external_key: str) -> bool:
        if provider != "mailagent" or kind not in {"email", "thread"}:
            return True
        try:
            parsed_kind, identifier = parse_resource_key(
                external_key if ":" in external_key else f"{kind}:{external_key}"
            )
        except ValueError:
            return False
        if parsed_kind != kind:
            return False
        if kind == "email":
            internal_id = int(identifier)
            return conn.execute("SELECT 1 FROM email_metadata WHERE internal_id=?", (internal_id,)).fetchone() is not None
        return conn.execute("SELECT 1 FROM email_metadata WHERE thread_id=? LIMIT 1", (identifier,)).fetchone() is not None

    def rebuild_all_search_documents(self) -> int:
        with self.transaction() as conn:
            ids = [int(row[0]) for row in conn.execute("SELECT id FROM matter")]
            for matter_id in ids:
                self.refresh_search_projection(conn, matter_id)
            return len(ids)

    def refresh_search_projection(self, conn: sqlite3.Connection, matter_id: int) -> None:
        row = conn.execute("SELECT * FROM matter WHERE id=?", (matter_id,)).fetchone()
        conn.execute("DELETE FROM matter_fts WHERE rowid=?", (matter_id,))
        conn.execute("DELETE FROM matter_search_document WHERE matter_id=?", (matter_id,))
        if not row:
            return
        tags = self._json(row["tags_json"], [])
        title = " ".join([row["title"], *(f"#{tag}" for tag in tags)])
        items_text = self._aggregate_items(conn, matter_id, note=False)
        notes_text = self._aggregate_items(conn, matter_id, note=True)
        stakeholders_text = "\n".join(
            " ".join(str(value or "") for value in stakeholder)
            for stakeholder in conn.execute(
                "SELECT display_name,email_normalized,organization,role FROM matter_stakeholder "
                "WHERE matter_id=? AND deleted_at IS NULL ORDER BY id",
                (matter_id,),
            ).fetchall()
        )
        values = (
            matter_id, title, row["description"] or "", row["current_summary"] or "",
            row["status"] or "", items_text, stakeholders_text, notes_text, row["updated_at"],
        )
        conn.execute(
            "INSERT INTO matter_search_document "
            "(matter_id,title,description,current_summary,status_text,items_text,stakeholders_text,notes_text,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            values,
        )
        conn.execute(
            "INSERT INTO matter_fts(rowid,title,description,current_summary,status_text,items_text,stakeholders_text,notes_text) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (matter_id, *values[1:8]),
        )

    def delete_matter(self, conn: sqlite3.Connection, matter_id: int) -> None:
        conn.execute("DELETE FROM matter WHERE id=?", (matter_id,))

    @staticmethod
    def _json(value: Any, fallback: Any) -> Any:
        if value is None:
            return fallback
        try:
            return json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return fallback

    @staticmethod
    def _dump(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _rename_tag_values(value: Any, old_name: str, new_name: str) -> list[str]:
        if not isinstance(value, list):
            return []
        result: list[str] = []
        seen: set[str] = set()
        for raw_tag in value:
            tag = str(raw_tag).strip()
            if not tag:
                continue
            if tag == old_name:
                tag = new_name
            if tag in seen:
                continue
            seen.add(tag)
            result.append(tag)
        return result

    @staticmethod
    def _remove_tag_values(value: Any, name: str) -> list[str]:
        if not isinstance(value, list):
            return []
        result: list[str] = []
        seen: set[str] = set()
        for raw_tag in value:
            tag = str(raw_tag).strip()
            if not tag or tag == name or tag in seen:
                continue
            seen.add(tag)
            result.append(tag)
        return result

    @classmethod
    def _matter_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["tags"] = cls._json(result.pop("tags_json"), [])
        result["goal_checks"] = cls._json(result.pop("goal_checks_json", None), [])
        result["waiting_context"] = cls._json(result.pop("waiting_context_json"), None)
        return result

    @staticmethod
    def _tag_row(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["usage_count"] = int(result.get("usage_count") or 0)
        result["inferred"] = bool(result.get("inferred", False))
        return result

    @classmethod
    def _resource_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["metadata"] = cls._json(result.pop("metadata_json"), {})
        return result

    @classmethod
    def _resource_link_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["pinned"] = bool(result["pinned"])
        result["provenance"] = cls._json(result.pop("provenance_json"), {})
        return result

    def _joined_resource_row(self, conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        raw = dict(row)
        resource = {key: raw[key] for key in (
            "id", "kind", "provider", "external_key", "canonical_url", "title", "metadata_json",
            "sum", "sum_src", "sum_at",
            "revision", "content_hash", "permission_state", "sync_state", "access_policy", "last_checked_at",
            "created_at", "updated_at",
        )}
        resource["metadata"] = self._json(resource.pop("metadata_json"), {})
        resource["available"] = self.resource_available(conn, resource["provider"], resource["kind"], resource["external_key"])
        link = {
            "id": raw["link_id"], "matter_id": raw["link_matter_id"], "resource_id": raw["id"],
            "relation_type": raw["relation_type"], "pinned": bool(raw["pinned"]),
            "added_by_kind": raw["added_by_kind"], "added_by_id": raw["added_by_id"],
            "confidence": raw["confidence"], "provenance": self._json(raw["provenance_json"], {}),
            "confirmed_at": raw["confirmed_at"], "sub_state": raw["sub_state"],
            "deleted_at": raw["link_deleted_at"], "created_at": raw["link_created_at"], "updated_at": raw["link_updated_at"],
        }
        return {"resource": resource, "link": link}

    @staticmethod
    def _aggregate_items(conn: sqlite3.Connection, matter_id: int, *, note: bool) -> str:
        comparator = "=" if note else "<>"
        rows = conn.execute(
            f"SELECT title,description FROM matter_item WHERE matter_id=? AND kind {comparator} 'note' "
            "AND deleted_at IS NULL ORDER BY position,id",
            (matter_id,),
        ).fetchall()
        return "\n".join(" ".join(str(value or "") for value in row) for row in rows)

    @staticmethod
    def _search_columns() -> tuple[str, ...]:
        return ("title", "description", "current_summary", "status_text", "items_text", "stakeholders_text", "notes_text")

    @staticmethod
    def _escape_like(value: str) -> str:
        return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    @staticmethod
    def _fts_query(value: str) -> str:
        return '"' + value.replace('"', '""') + '"'

    def _add_search_match(self, result: dict[str, Any], query: str) -> None:
        lowered = query.lower()
        matched_fields: list[str] = []
        snippets: dict[str, str] = {}
        column_map = dict(zip(MATTER_SEARCH_FIELDS, self._search_columns(), strict=True))
        for field, column in column_map.items():
            text = str(result.pop(f"search_{column}", "") or "")
            if lowered in text.lower():
                matched_fields.append(field)
                snippets[field] = self._snippet(text, query)
        result["matched_fields"] = matched_fields
        result["snippets"] = snippets

    @staticmethod
    def _snippet(text: str, query: str) -> str:
        compact = " ".join(text.split())
        index = compact.lower().find(query.lower())
        start = max(0, index - 40) if index >= 0 else 0
        return compact[start:start + 120]

    @classmethod
    def _item_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["checklist"] = cls._json(result.pop("checklist_json"), [])
        result["source_locator"] = cls._json(result.pop("source_locator_json"), None)
        return result

    @classmethod
    def _event_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["payload"] = cls._json(result.pop("payload_json"), {})
        return result

    @classmethod
    def _update_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        for source, target, fallback in (
            ("original_proposal_json", "original_proposal", {}),
            ("reviewed_result_json", "reviewed_result", None),
            ("changes_json", "changes", []),
            ("accepted_change_ids_json", "accepted_change_ids", None),
            ("citations_json", "citations", []),
        ):
            result[target] = cls._json(result.pop(source), fallback)
        return result
