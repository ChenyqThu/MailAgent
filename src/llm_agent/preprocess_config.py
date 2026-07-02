"""issue #31/#32 增量2 — 读 AI 邮件预处理 Custom Agent 的运行时配置。

预处理 = Agents 页 type='preprocess' 的 Custom Agent（id='email_preprocess_agent'）。
它的模型（model 列，空 = 跟随全局 LLM_MODEL）+ 文档勾选（context_docs_json 列）存在
report_agent 表（sync_store.db）。开关走全局 env（LLM_AGENT_ENABLED），fallback 链走
全局 env（LLM_FALLBACK_MODELS）。本模块只取 model/docs 供 LLMProcessor 叠加 ——
不填 = 字节级回退全局默认。

v1.1.0 dogfood 起 persona 层已移除：身份/偏好由 Standing Context 文档注入
（context_docs 勾选 soul/user 等），不再有独立 persona 覆写；旧行残留的 prompt
列值一律忽略。

直接裸 sqlite3 读（**不** import src.reports，避免 llm_agent→reports 层耦合）；行/列缺失
一律 graceful 返回空（迁移前旧库、行被删、列不存在都不炸）。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import List, Optional

from loguru import logger

PREPROCESS_AGENT_ID = "email_preprocess_agent"


@dataclass
class PreprocessConfig:
    """预处理 agent 的运行时叠加配置（模型 + 文档勾选）。"""

    # model 列 —— 空串 = 跟随全局 LLM_MODEL（不覆写模型链头）。
    model: str = ""
    # context_docs_json 列 —— None = 列 NULL/缺失 → 用 build_task_identity_context 默认；
    # []（用户取消全部勾选）→ 显式不注入任何身份文档。
    context_docs: Optional[List[str]] = None


def get_preprocess_config(db_path: str) -> PreprocessConfig:
    """读 report_agent 的 preprocess 行 → model + context_docs。任何缺失 graceful 空。"""
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT model, context_docs_json FROM report_agent WHERE id = ?",
                (PREPROCESS_AGENT_ID,),
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.Error as e:
        # 列不存在（迁移前旧库）/ 库锁 / 文件缺失 → graceful 回退默认行为。
        logger.debug(f"[preprocess-config] read skipped: {e}")
        return PreprocessConfig()

    if row is None:
        return PreprocessConfig()

    model = (row["model"] or "").strip()
    context_docs: Optional[List[str]] = None
    raw = row["context_docs_json"]
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                context_docs = [str(x) for x in parsed]
        except (json.JSONDecodeError, TypeError):
            context_docs = None
    return PreprocessConfig(model=model, context_docs=context_docs)
