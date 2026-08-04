"""issue #31/#32 增量2 — 读 AI 邮件预处理 Custom Agent 的运行时配置。

预处理 = Agents 页 type='preprocess' 的 Custom Agent（id='email_preprocess_agent'）。
它的模型（model 列，空 = 跟随全局 LLM_MODEL）+ 文档勾选（context_docs_json 列）+
fallback 链（fallback_models_json 列，v29：NULL = 跟随全局 LLM_FALLBACK_MODELS）存在
report_agent 表（sync_store.db）。处理后自动标已读开关（mark_read_after_processing，v32）
也在同一行，NULL / 缺列 = true。全局启用开关仍走 env（LLM_AGENT_ENABLED）。本模块取
model/docs/fallback/mark-read 供运行链热读 —— 不填 = 字节级回退既有默认。

v1.1.0 dogfood 起 persona 层已移除：身份/偏好由 Standing Context 文档注入
（context_docs 勾选 soul/user 等），不再有独立 persona 覆写；旧行残留的 prompt
列值一律忽略。

直接裸 sqlite3 读（**不** import src.reports，避免 llm_agent→reports 层耦合）；行/列缺失
一律 graceful 返回空（迁移前旧库、行被删、列不存在都不炸）。
"""

from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from typing import List, Optional

from loguru import logger

PREPROCESS_AGENT_ID = "email_preprocess_agent"


#: 🔴 分类侧的 crud 天花板 —— **硬编码 read，不是配置项**（MCP connector PRD 坑 3）。
#: 邮件预处理分类同时具备 lethal trifecta 三件套（任何人可发的 untrusted 正文 + connector
#: 能读整个工作区 + write 类工具能把数据写到攻击者可见处），且全自动逐封跑、无人值守，比
#: headless custom agent 更敞。故这条路径**结构上**只造 read 类工具：没有 owner 能配错的
#: 值，改成 write 得改代码。授权面也独立（``connector.preprocess_enabled`` 列），不复用
#: custom agent 的 ``grant_connectors`` —— 免得给某个 agent 配了 write、分类侧跟着继承。
PREPROCESS_CONNECTOR_CEILING = "read"


@dataclass
class PreprocessConfig:
    """预处理 agent 的运行时叠加配置（模型 + 文档勾选）。"""

    # model 列 —— 空串 = 跟随全局 LLM_MODEL（不覆写模型链头）。
    model: str = ""
    # context_docs_json 列 —— None = 列 NULL/缺失 → 用 build_task_identity_context 默认；
    # []（用户取消全部勾选）→ 显式不注入任何身份文档。
    context_docs: Optional[List[str]] = None
    # fallback_models_json 列（v29）—— None = 跟随全局 LLM_FALLBACK_MODELS；
    # [] = 显式不设兜底；[m, ...] = 预处理专用 fallback 链。
    fallback_models: Optional[List[str]] = None
    # mark_read_after_processing 列（v32）—— NULL / 缺列 = 默认 true。
    mark_read_after_processing: bool = True
    # context_source 列（v38）—— 参考上下文源 'standing_docs' | 'notion_context'。
    # None = 列 NULL/缺失/野值 → _resolve_context_source 按 LLM_CONTEXT_PAGE_ID 继承派生。
    context_source: Optional[str] = None


def get_preprocess_connector_grants() -> List[tuple]:
    """分类侧获授权的 connector → ``[(connector_id, 'read'), …]``（天花板恒 read）。

    授权源 = ``agent_config.db`` 的 ``connector.preprocess_enabled=1``（owner 在设置里逐个
    opt-in，默认全关）。只取 ``status='connected'`` 且 ``enabled`` 的行 —— 未连接 / 整体
    关掉的 connector 不该给分类挂工具。库不可用 / 表不存在（旧库）→ ``[]``（graceful，
    与本模块其余读一致：分类绝不因 connector 面出问题而失败）。
    """
    try:
        from src.agent_config.store import get_agent_config_store

        rows = get_agent_config_store().list_connectors()
    except Exception as e:  # noqa: BLE001 — connector 面是增强，读不到就当没授权
        logger.debug(f"[preprocess-config] connector grants skipped: {e}")
        return []
    return [
        (r.connector_id, PREPROCESS_CONNECTOR_CEILING)
        for r in rows
        if r.preprocess_enabled and r.enabled and r.status == "connected"
    ]


def get_preprocess_config(db_path: str | os.PathLike[str]) -> PreprocessConfig:
    """读 report_agent 的 preprocess 行 → model + context_docs + fallback。任何缺失 graceful 空。"""
    if not isinstance(db_path, (str, os.PathLike)):
        return PreprocessConfig()
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT model, context_docs_json, fallback_models_json, "
                "mark_read_after_processing, context_source "
                "FROM report_agent WHERE id = ?",
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
    fallback_models: Optional[List[str]] = None
    raw_fb = row["fallback_models_json"]
    if raw_fb:
        try:
            parsed_fb = json.loads(raw_fb)
            if isinstance(parsed_fb, list):
                fallback_models = [str(x) for x in parsed_fb]
        except (json.JSONDecodeError, TypeError):
            fallback_models = None
    raw_src = (row["context_source"] or "").strip().lower()
    context_source = raw_src if raw_src in ("standing_docs", "notion_context") else None
    return PreprocessConfig(
        model=model,
        context_docs=context_docs,
        fallback_models=fallback_models,
        mark_read_after_processing=(
            True
            if row["mark_read_after_processing"] is None
            else bool(row["mark_read_after_processing"])
        ),
        context_source=context_source,
    )
