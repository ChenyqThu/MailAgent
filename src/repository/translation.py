"""TranslationRepository - email_translation 表 CRUD 入口 (v4 SSoT, DB v12).

沉浸式翻译双路径共享的缓存层。两条路径写出来的 segments_json shape 完全一致:
    [{"src": "原文段落", "tgt": "中文译文"}, ...]

Path A (source='llm_agent'):
    LLMRunner.run_for_internal_id 在 mark_success 之前调 save_segments。
    LLM 分类时 tool_use 顺带返回 translation_segments，零额外 RTT。

Path B (source='on_demand'):
    Frontend translate.ts:translate:batch IPC, 用户点 "翻译" 触发。

读路径:
    Frontend EmailDetail 用 useQuery 经 IPC translation:get 拉缓存; 命中 → 在
    iframe.contentDocument 上按 src→DOM 节点 fuzzy 配对注入译文 div。
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Optional

from loguru import logger


# 单封邮件 translation_segments 写入上限 — 防 LLM 输出失控
# (典型邮件 5-30 段，>200 段几乎必然是 LLM 幻觉)
MAX_SEGMENTS_PER_EMAIL = 200


class TranslationRepository:
    """email_translation 表的 CRUD 封装。

    Connection 策略与 EmailRepository 对齐 (per-call open/close + WAL + FK ON),
    避免长连接锁; better-sqlite3 主进程也是 readonly 单例, write conn 只在本类内部
    短期持有, 不与其他写者共享。
    """

    def __init__(self, db_path: str = "data/sync_store.db"):
        self.db_path = Path(db_path)

    # ---------- internal ----------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @staticmethod
    def _validate_segments(segments: list[dict]) -> list[dict]:
        """形状校验 + 截断。返回干净的副本; 输入异常时返回空列表。"""
        if not isinstance(segments, list):
            logger.warning(f"[translation-repo] segments not a list: {type(segments).__name__}")
            return []
        clean: list[dict] = []
        for i, seg in enumerate(segments[:MAX_SEGMENTS_PER_EMAIL]):
            if not isinstance(seg, dict):
                continue
            src = seg.get("src")
            tgt = seg.get("tgt")
            if not isinstance(src, str) or not isinstance(tgt, str):
                continue
            src_s = src.strip()
            tgt_s = tgt.strip()
            if not src_s or not tgt_s:
                continue
            clean.append({"src": src_s, "tgt": tgt_s})
        if len(segments) > MAX_SEGMENTS_PER_EMAIL:
            logger.warning(
                f"[translation-repo] truncated {len(segments)} segments → "
                f"{MAX_SEGMENTS_PER_EMAIL}"
            )
        return clean

    # ---------- public ----------

    def get_segments(
        self, internal_id: int, target_lang: str = "zh"
    ) -> Optional[list[dict]]:
        """返回 [{src, tgt}] 数组，未命中返回 None (非空 []表示翻译过但 LLM 空输出)。"""
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT segments_json FROM email_translation
                 WHERE internal_id = ? AND target_lang = ?
                """,
                (internal_id, target_lang),
            ).fetchone()
        if row is None:
            return None
        try:
            data = json.loads(row["segments_json"])
        except json.JSONDecodeError as e:
            logger.warning(
                f"[translation-repo] corrupt segments_json for internal_id={internal_id}: {e}"
            )
            return None
        if not isinstance(data, list):
            return None
        return data

    def save_segments(
        self,
        internal_id: int,
        segments: list[dict],
        *,
        model: str = "",
        source: str = "llm_agent",
        target_lang: str = "zh",
    ) -> bool:
        """UPSERT (internal_id, target_lang) 一行。

        source 必须是 'llm_agent' | 'on_demand' (DB CHECK)。
        segments 内部会校验+截断, 空列表会被显式写入 (表示 "翻译跑过但 LLM 没产出段落",
        避免下次重复触发)。
        """
        if source not in ("llm_agent", "on_demand"):
            raise ValueError(
                f"source must be 'llm_agent' or 'on_demand', got {source!r}"
            )
        clean = self._validate_segments(segments)
        payload = json.dumps(clean, ensure_ascii=False, separators=(",", ":"))
        now = time.time()
        with self._connect() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO email_translation
                      (internal_id, target_lang, segments_json, model, source, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(internal_id) DO UPDATE SET
                      target_lang   = excluded.target_lang,
                      segments_json = excluded.segments_json,
                      model         = excluded.model,
                      source        = excluded.source,
                      updated_at    = excluded.updated_at
                    """,
                    (internal_id, target_lang, payload, model, source, now, now),
                )
                conn.commit()
                return True
            except sqlite3.IntegrityError as e:
                # FK 失败 (internal_id 不存在 email_metadata) → 不致命, warning 后跳过
                logger.warning(
                    f"[translation-repo] save failed for internal_id={internal_id}: {e}"
                )
                return False

    def delete(self, internal_id: int, target_lang: str = "zh") -> bool:
        """删一行 (用户点 "重新翻译" 时调)。返回是否真删了一行。"""
        with self._connect() as conn:
            cur = conn.execute(
                """
                DELETE FROM email_translation
                 WHERE internal_id = ? AND target_lang = ?
                """,
                (internal_id, target_lang),
            )
            conn.commit()
            return cur.rowcount > 0
