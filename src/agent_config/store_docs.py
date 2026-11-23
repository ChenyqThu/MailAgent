"""Profile and standing-doc storage operations for AgentConfigStore."""

from __future__ import annotations

from typing import Any, Optional

from src.agent_config.store_common import (
    CONTACT_AGENT_DOC_NAME,
    CONTACT_ORG_FRAME_DOC_NAME,
    MATTER_AGENT_DOC_NAME,
    PROFILE_DOC_NAMES,
    ProfileDoc,
    ProfileHistoryEntry,
    _hash,
    _now,
    _row_to_history,
    _row_to_profile_doc,
)
from src.agent_config.templates import SEED_TEMPLATES


class AgentConfigDocsMixin:
    def get_profile_doc(self, doc_name: str, *, seed_if_absent: bool = True) -> ProfileDoc:
        """读一个 profile 文档；缺失且 ``seed_if_absent`` 时落默认 seed 并记一条初始 history。

        seed 落库是 **幂等 + 一次性**（INSERT OR IGNORE on PK）；并发首读最多一次建行。
        """
        name = self._validate_doc_name(doc_name)
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM agent_profile_docs WHERE doc_name = ?", (name,)
            ).fetchone()
            if row is not None:
                return _row_to_profile_doc(row)
            if not seed_if_absent:
                raise KeyError(f"profile doc not found: {name}")
            # memory.md 无 seed 模板（不在 SEED_TEMPLATES）→ 空串；4 份身份文档取其模板。
            seed = SEED_TEMPLATES.get(name, "")
            seed_hash = _hash(seed)
            now = _now()
            cur = conn.execute(
                "INSERT OR IGNORE INTO agent_profile_docs "
                "(doc_name, content, content_hash, updated_by, updated_at) VALUES (?,?,?,?,?)",
                (name, seed, seed_hash, "seed", now),
            )
            # 仅当本调用真正建了行才记初始 history（并发 race 下别人建的就不重复记）。
            if cur.rowcount > 0:
                conn.execute(
                    "INSERT INTO agent_profile_history "
                    "(doc_name, old_hash, new_hash, content_snapshot, changed_by, "
                    " session_id, message_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
                    (name, None, seed_hash, seed, "seed", None, None, now),
                )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM agent_profile_docs WHERE doc_name = ?", (name,)
            ).fetchone()
        return _row_to_profile_doc(row)

    def list_profile_docs(self) -> list[ProfileDoc]:
        """4 个可编辑文档（缺失的先 seed），按 PROFILE_DOC_NAMES 顺序返回。"""
        return [self.get_profile_doc(name) for name in PROFILE_DOC_NAMES]

    def set_profile_doc(
        self,
        doc_name: str,
        content: str,
        *,
        updated_by: str = "user",
        session_id: Optional[int] = None,
        message_id: Optional[int] = None,
    ) -> ProfileDoc:
        """覆盖一个 profile 文档内容 + 记一条 history（old_hash→new_hash + 完整快照）。

        ``updated_by`` ∈ {'user','agent_proposed'}。内容未变（hash 相同）则 no-op 不记 history。
        """
        name = self._validate_doc_name(doc_name)
        empty_allowed = name in {
            MATTER_AGENT_DOC_NAME,
            CONTACT_AGENT_DOC_NAME,
            CONTACT_ORG_FRAME_DOC_NAME,
        }
        if not isinstance(content, str) or (content == "" and not empty_allowed):
            raise ValueError("profile doc content must be a non-empty string")
        new_hash = _hash(content)
        now = _now()
        with self._connection() as conn:
            prev = conn.execute(
                "SELECT content_hash FROM agent_profile_docs WHERE doc_name = ?", (name,)
            ).fetchone()
            old_hash = prev["content_hash"] if prev is not None else None
            if old_hash == new_hash:
                # 内容未变 → 不写历史，直接返回当前行。
                row = conn.execute(
                    "SELECT * FROM agent_profile_docs WHERE doc_name = ?", (name,)
                ).fetchone()
                return _row_to_profile_doc(row)
            conn.execute(
                "INSERT INTO agent_profile_docs "
                "(doc_name, content, content_hash, updated_by, updated_at) VALUES (?,?,?,?,?) "
                "ON CONFLICT(doc_name) DO UPDATE SET content=excluded.content, "
                " content_hash=excluded.content_hash, updated_by=excluded.updated_by, "
                " updated_at=excluded.updated_at",
                (name, content, new_hash, updated_by, now),
            )
            conn.execute(
                "INSERT INTO agent_profile_history "
                "(doc_name, old_hash, new_hash, content_snapshot, changed_by, "
                " session_id, message_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (name, old_hash, new_hash, content, updated_by, session_id, message_id, now),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM agent_profile_docs WHERE doc_name = ?", (name,)
            ).fetchone()
        return _row_to_profile_doc(row)

    def list_profile_history(
        self, doc_name: Optional[str] = None, *, limit: int = 50
    ) -> list[ProfileHistoryEntry]:
        sql = "SELECT * FROM agent_profile_history"
        params: list[Any] = []
        if doc_name is not None:
            sql += " WHERE doc_name = ?"
            params.append(self._validate_doc_name(doc_name))
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_history(r) for r in rows]

    def rollback_profile_doc(
        self,
        doc_name: str,
        target_hash: str,
        *,
        updated_by: str = "user",
        session_id: Optional[int] = None,
    ) -> ProfileDoc:
        """把文档回滚到某历史版本（按其 ``new_hash`` 定位 content_snapshot）。

        回滚本身记一条新 history（changed_by 透传）。找不到 target_hash → KeyError。
        RULES 目标内容不过 validator → ValueError（S1 R2：历史里可能存在 validator 收紧前
        / 绕过 router 落库的版本，回滚=一次普通写，享受同一 deny-list 闸——此前只有写端点
        agent.py 校验，rollback 路径可把越权 RULES 快照重新激活）。
        """
        name = self._validate_doc_name(doc_name)
        with self._connection() as conn:
            hist = conn.execute(
                "SELECT content_snapshot FROM agent_profile_history "
                "WHERE doc_name = ? AND new_hash = ? ORDER BY id DESC LIMIT 1",
                (name, target_hash),
            ).fetchone()
        if hist is None:
            raise KeyError(f"no history version {target_hash} for doc {name}")
        if name == "rules":
            from src.agent_config.validator import validate_rules_content

            reason = validate_rules_content(hist["content_snapshot"])
            if reason:
                raise ValueError(reason)
        # 复用 set_profile_doc 写当前 + 记新 history（回滚=一次普通写，内容=历史快照）。
        return self.set_profile_doc(
            name, hist["content_snapshot"], updated_by=updated_by, session_id=session_id
        )

    def profile_hash(self) -> str:
        """4 个可编辑文档的确定性聚合 hash（agent_profile_hash 用）。

        canonical：按 doc_name 排序，``name:content_hash`` 行 join，再 sha256。文档缺失先 seed
        （故同一默认种群 hash 稳定）。
        """
        docs = {d.doc_name: d.content_hash for d in self.list_profile_docs()}
        canonical = "\n".join(f"{name}:{docs[name]}" for name in sorted(docs))
        return _hash(canonical)

