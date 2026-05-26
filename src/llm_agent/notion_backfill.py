"""一次性 backfill: Notion 邮件库 AI labels → SQLite ``llm_processing``。

背景: 早期邮件由 Notion Custom Agent (Email Agent automation) 在 Notion 端
分类, AI 字段只写在 Notion property, 没回写 SQLite。本地 LLM agent 后来才
启用, 只覆盖 ~1056 封。导致 SQLite ``email_metadata.ai_priority`` 大量为空,
而 Notion 端 99.8% 的邮件页其实都有完整 AI 字段。

本模块把这些 AI 字段从 Notion 拉回 SQLite, 复用 ``LLMProcessingStore.
upsert_external_labels`` (写 labels_json 全量 + 镜像主表 ai_priority/ai_action),
让 SQLite SSoT 信息完整 — 给 KOS bulk ingest 提供丰富的 AI 上下文, 避免重跑
上万封 LLM。

目标集: ``email_metadata`` 有 notion_page_id 但 ai_priority 为空且 synced 的行。
幂等: 只处理 ai_priority 为空的, 写成功后该行 ai_priority 非空 → 重跑自动跳过,
天然支持中断续跑, 无需额外 checkpoint。

映射 (Notion property → AILabels schema key, 跟 src/llm_agent/schema.py 对齐):
    select:      Priority→priority, Action Type→action_type, Category→category,
                 Sender Priority→sender_priority, Language→language
    rich_text:   AI Summary→ai_summary, Key Points→key_points,
                 Urgency Reason→urgency_reason, Reply Suggestion→reply_suggestion_md,
                 Related Project→related_project
    checkbox:    Action Required→action_required
    multi_select: Mail Actions→mail_actions

Notion 端 Priority + Action Type 都空 → 视为没 AI 处理, skip (不写)。
"""

from __future__ import annotations

import os
import sqlite3
import time
from typing import Any, Optional

import httpx
from loguru import logger

from src.config import config as cfg
from src.llm_agent.store import LLMProcessingStore

_NOTION_API = "https://api.notion.com/v1"
_NOTION_VERSION = "2022-06-28"

# Notion select property name → AILabels schema key
_SELECT_MAP: dict[str, str] = {
    "Priority": "priority",
    "Action Type": "action_type",
    "Category": "category",
    "Sender Priority": "sender_priority",
    "Language": "language",
}

# Notion rich_text property name → AILabels schema key
_RICHTEXT_MAP: dict[str, str] = {
    "AI Summary": "ai_summary",
    "Key Points": "key_points",
    "Urgency Reason": "urgency_reason",
    "Reply Suggestion": "reply_suggestion_md",
    "Related Project": "related_project",
}


def _rich_text_plain(prop: dict) -> str:
    """Notion rich_text property → 拼接后的 plaintext。"""
    arr = prop.get("rich_text") or []
    return "".join(x.get("plain_text", "") for x in arr).strip()


def notion_props_to_ai_labels(props: dict) -> Optional[dict[str, Any]]:
    """Notion page properties → AILabels dict (key 对齐 schema.py)。

    返回 None 表示该页没有 AI 处理 (Priority + Action Type 都空) → 调用方 skip。
    """
    labels: dict[str, Any] = {}

    for nname, key in _SELECT_MAP.items():
        sel = (props.get(nname) or {}).get("select")
        if sel and sel.get("name"):
            labels[key] = sel["name"]

    for nname, key in _RICHTEXT_MAP.items():
        txt = _rich_text_plain(props.get(nname) or {})
        if txt:
            labels[key] = txt

    action_required = (props.get("Action Required") or {}).get("checkbox")
    if action_required is not None:
        labels["action_required"] = action_required

    ms = (props.get("Mail Actions") or {}).get("multi_select") or []
    mail_actions = [x.get("name") for x in ms if x.get("name")]
    if mail_actions:
        labels["mail_actions"] = mail_actions

    # 判定: 至少有 priority 或 action_type 才算 Notion 端做过 AI 处理
    if not labels.get("priority") and not labels.get("action_type"):
        return None
    return labels


class NotionAiBackfiller:
    """从 Notion 邮件库回写 AI labels 到 SQLite。只读 Notion, 写本地 SQLite。"""

    def __init__(
        self,
        db_path: Optional[str] = None,
        token: Optional[str] = None,
        rate_qps: float = 3.0,
    ):
        self.store = LLMProcessingStore(db_path)
        self.db_path = self.store.db_path
        self.token = token or getattr(cfg, "notion_token", None) or os.getenv("NOTION_TOKEN")
        if not self.token:
            raise RuntimeError("NOTION_TOKEN 未配置 (cfg.notion_token / env)")
        self._sleep = 1.0 / rate_qps if rate_qps > 0 else 0.0
        self._http = httpx.Client(
            timeout=20.0,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Notion-Version": _NOTION_VERSION,
            },
        )

    def targets(self, limit: Optional[int] = None) -> list[sqlite3.Row]:
        """有 notion_page_id 但 ai_priority 为空且 synced 的行 (最新优先)。"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        q = (
            "SELECT internal_id, notion_page_id, mailbox FROM email_metadata "
            "WHERE notion_page_id IS NOT NULL AND notion_page_id!='' "
            "AND (ai_priority IS NULL OR ai_priority='') "
            "AND sync_status='synced' ORDER BY internal_id DESC"
        )
        if limit:
            q += f" LIMIT {int(limit)}"
        rows = conn.execute(q).fetchall()
        conn.close()
        return rows

    def _fetch_props(self, page_id: str) -> Optional[dict]:
        """GET /pages/{id} → properties。429 退避重试一次。"""
        try:
            r = self._http.get(f"{_NOTION_API}/pages/{page_id}")
            if r.status_code == 429:
                time.sleep(float(r.headers.get("Retry-After", 2)))
                r = self._http.get(f"{_NOTION_API}/pages/{page_id}")
            if r.status_code != 200:
                logger.warning(f"[backfill] page {page_id} HTTP {r.status_code}")
                return None
            return r.json().get("properties")
        except httpx.HTTPError as e:
            logger.warning(f"[backfill] page {page_id} network error: {e}")
            return None

    def run(self, limit: Optional[int] = None, dry_run: bool = False) -> dict[str, int]:
        """跑 backfill, 返回统计。dry_run 时只映射不写 SQLite。"""
        targets = self.targets(limit)
        stats = {
            "total": len(targets),
            "written": 0,
            "skipped_no_ai": 0,
            "fetch_failed": 0,
            "write_failed": 0,
        }
        logger.info(
            f"[backfill] start total={stats['total']} dry_run={dry_run} "
            f"rate={1.0 / self._sleep if self._sleep else 'unlimited'}qps"
        )
        for i, row in enumerate(targets, 1):
            iid = row["internal_id"]
            pid = row["notion_page_id"]
            mbox = row["mailbox"]

            props = self._fetch_props(pid)
            if props is None:
                stats["fetch_failed"] += 1
                time.sleep(self._sleep)
                continue

            labels = notion_props_to_ai_labels(props)
            if labels is None:
                stats["skipped_no_ai"] += 1
                time.sleep(self._sleep)
                continue

            if not dry_run:
                try:
                    self.store.upsert_external_labels(
                        iid, labels, source="notion", notion_page_id=pid, mailbox=mbox
                    )
                except Exception as e:
                    # 单封写失败 (如并发 SQLite lock) 不拖垮整个 batch;
                    # ai_priority 仍为空 → 下次重跑自动 resume 补上。
                    stats["write_failed"] += 1
                    logger.warning(f"[backfill] write failed iid={iid}: {e}")
                    time.sleep(self._sleep)
                    continue
            stats["written"] += 1
            if i <= 5 or i % 200 == 0:
                logger.info(
                    f"[backfill] {i}/{stats['total']} iid={iid} "
                    f"priority={labels.get('priority')!r} "
                    f"action={labels.get('action_type')!r} fields={len(labels)}"
                )
            time.sleep(self._sleep)

        logger.info(f"[backfill] done {stats}")
        return stats


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Notion AI labels → SQLite backfill (一次性)")
    ap.add_argument("--limit", type=int, default=None, help="只处理前 N 个 (验证用)")
    ap.add_argument("--dry-run", action="store_true", help="只映射不写 SQLite")
    ap.add_argument("--db-path", default=None, help="覆盖 sync_store.db 路径")
    ap.add_argument("--rate", type=float, default=3.0, help="Notion API qps (默认 3)")
    args = ap.parse_args()

    bf = NotionAiBackfiller(db_path=args.db_path, rate_qps=args.rate)
    result = bf.run(limit=args.limit, dry_run=args.dry_run)
    print(result)
