"""S5 W5a — 读项目周报 sync Custom Agent 的运行时触发配置（type='project_progress' 单例行）。

镜像 ``src/llm_agent/preprocess_config.py`` 的**行内热读**模式：每封邮件裸 sqlite3 读
report_agent 的 project_progress 行 → ``enabled`` + trigger（sender / subject）。Settings 抽屉
PATCH 改行后**下封邮件即生效**（不重启）。总闸仍是 env ``PROJECT_PROGRESS_SYNC_ENABLED``
（在 new_watcher 的 __init__ gate 判，非本模块）。

行不存在（老库未跑 v31 迁移）→ 返回 ``row_exists=False``，caller 回退 env 构造（行为等价窗口）。

**sender 语义**：trigger_json 复用 email_filter 的 ``sender_pattern`` / ``subject_pattern`` 字段名，
但 project_progress 走 ``ProjectProgressDetector``（**子串**-sender + **正则**-subject），**非**
``AgentEmailMatcher``（正则-sender）—— 逐字保持子串匹配（行为等价）。故本模块只做 JSON 读、返回
原始 pattern 字符串（**不**经 ``parse_trigger``，那会拒空触发；project_progress 允许空 = 永不匹配）。

直接裸 sqlite3 读（不 import src.reports，避免层耦合）；行 / 列缺失一律 graceful 返回 row_exists=False。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass

from loguru import logger

PROJECT_PROGRESS_AGENT_ID = "project_progress_sync"


@dataclass
class ProjectProgressAgentConfig:
    """项目周报 agent 行的运行时触发配置。row_exists=False → caller 回退 env。"""

    row_exists: bool = False
    enabled: bool = False
    # ProjectProgressDetector 的 sender（子串匹配）+ subject_pattern（正则）。
    sender: str = ""
    subject_pattern: str = ""


def get_project_progress_agent_config(db_path: str) -> ProjectProgressAgentConfig:
    """读 report_agent 的 project_progress 行 → enabled + sender + subject_pattern。

    行 / 列 / trigger_json 缺失或坏 → graceful：行不存在返回 ``row_exists=False``（caller 回退
    env）；trigger_json 坏 / 缺 pattern → 空 pattern（detector 永不匹配 = 现状"全空永不匹配"）。
    """
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT enabled, trigger_json FROM report_agent WHERE id = ?",
                (PROJECT_PROGRESS_AGENT_ID,),
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.Error as e:
        # 列不存在（迁移前旧库）/ 库锁 / 文件缺失 → 当作行不存在（caller 回退 env）。
        logger.debug(f"[pp-config] read skipped: {e}")
        return ProjectProgressAgentConfig(row_exists=False)

    if row is None:
        return ProjectProgressAgentConfig(row_exists=False)

    sender = ""
    subject_pattern = ""
    raw = row["trigger_json"]
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                sender = str(parsed.get("sender_pattern") or "")
                subject_pattern = str(parsed.get("subject_pattern") or "")
        except (json.JSONDecodeError, TypeError):
            sender = ""
            subject_pattern = ""
    return ProjectProgressAgentConfig(
        row_exists=True,
        enabled=bool(row["enabled"]),
        sender=sender,
        subject_pattern=subject_pattern,
    )
