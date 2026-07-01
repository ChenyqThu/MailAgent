"""issue #31/#32 增量2 — 读 AI 邮件预处理 Custom Agent 的运行时配置。

预处理 = Agents 页 type='preprocess' 的 Custom Agent（id='email_preprocess_agent'）。
它的 persona（prompt 列）+ 文档勾选（context_docs_json 列）存在 report_agent 表
（sync_store.db）。开关/模型走全局 env（LLM_AGENT_ENABLED / LLM_MODEL），本模块只取
persona/docs 供 LLMProcessor NULL-safe 叠加进分类 system prompt —— 不填 = 字节级回退
硬编码默认。

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
    """预处理 agent 的运行时叠加配置（persona + 文档勾选）。"""

    # prompt 列 —— 空串 = 用硬编码默认（不额外注入 persona 块）。
    persona: str = ""
    # context_docs_json 列 —— None = 列 NULL/缺失 → 用 build_task_identity_context 默认；
    # []（用户取消全部勾选）→ 显式不注入任何身份文档。
    context_docs: Optional[List[str]] = None


def get_preprocess_config(db_path: str) -> PreprocessConfig:
    """读 report_agent 的 preprocess 行 → persona + context_docs。任何缺失 graceful 空。"""
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT prompt, context_docs_json FROM report_agent WHERE id = ?",
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

    persona = (row["prompt"] or "").strip()
    context_docs: Optional[List[str]] = None
    raw = row["context_docs_json"]
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                context_docs = [str(x) for x in parsed]
        except (json.JSONDecodeError, TypeError):
            context_docs = None
    return PreprocessConfig(persona=persona, context_docs=context_docs)
