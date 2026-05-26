"""KOS bulk ingest — 存量邮件批量导入 Jarvis KOS mailagent-emails source。

Scenario B 历史回填 (doc §4/§5)。从 SQLite SSoT 读 synced 邮件 → build_kos_
page_payload → bulk client put_page (不传 source, 靠 OAuth client 身份路由到
mailagent-emails isolated source)。

幂等 / resume: kos_ingest_log 表 (internal_id PK) 记每封 push 状态; 已 pushed
的 candidate 查询自动跳过, 中断重跑续上。put_page 本身也是 upsert。

Canary (doc §6 step 4): run() 第一封 push 后强制 get_page 校验 source_id ===
'mailagent-emails', 不对立刻 abort (说明 client 选错, 不是 brain 端问题)。

限速: 默认 2 put/s (保守, 避 Gemini embedding RPM); 遇 429 退避重试。

Phase 1: KOSBulkIngester(...).run(limit=50) — 跑 50 封, ping Lucien 校验。
Phase 4: 去掉 limit 跑剩余 (resume 自动跳过已 pushed)。
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Optional

from loguru import logger

from src.kos.client import KOSClient, KOSError
from src.kos.producer import build_kos_page_payload, make_bulk_kos_client
from src.repository import EmailRepository


class KOSBulkIngester:
    """存量邮件 → KOS mailagent-emails source 批量导入器。"""

    def __init__(
        self,
        db_path: str = "data/sync_store.db",
        client: Optional[KOSClient] = None,
        rate_qps: float = 2.0,
    ):
        self.db_path = db_path
        self.repo = EmailRepository(db_path=db_path)
        self.client = client or make_bulk_kos_client()
        self._sleep = 1.0 / rate_qps if rate_qps > 0 else 0.0
        self._ensure_log_table()

    # ---- resume 追踪表 (独立, 不碰主 schema migration) ----
    def _ensure_log_table(self) -> None:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS kos_ingest_log (
                internal_id INTEGER PRIMARY KEY,
                slug TEXT,
                status TEXT,            -- pushed / failed
                chunks INTEGER,
                error TEXT,
                pushed_at REAL
            )
            """
        )
        conn.commit()
        conn.close()

    def _candidates(
        self, limit: Optional[int], retry_failed: bool, require_body: bool
    ) -> list[int]:
        """synced 且未 pushed 的 internal_id (retry_failed 时也含 failed)。"""
        conn = sqlite3.connect(self.db_path, timeout=30)
        done_clause = (
            "internal_id NOT IN (SELECT internal_id FROM kos_ingest_log WHERE status='pushed')"
            if retry_failed
            else "internal_id NOT IN (SELECT internal_id FROM kos_ingest_log)"
        )
        body_join = (
            "JOIN email_body eb ON eb.internal_id = em.internal_id "
            "AND eb.body_markdown IS NOT NULL AND length(eb.body_markdown) > 0"
            if require_body
            else ""
        )
        q = (
            f"SELECT em.internal_id FROM email_metadata em {body_join} "
            f"WHERE em.sync_status='synced' AND em.{done_clause} "
            f"ORDER BY em.internal_id DESC"
        )
        if limit:
            q += f" LIMIT {int(limit)}"
        rows = conn.execute(q).fetchall()
        conn.close()
        return [r[0] for r in rows]

    def _get_labels(self, internal_id: int) -> dict[str, Any]:
        conn = sqlite3.connect(self.db_path, timeout=30)
        row = conn.execute(
            "SELECT labels_json FROM llm_processing WHERE internal_id = ?",
            (internal_id,),
        ).fetchone()
        conn.close()
        if row and row[0]:
            try:
                return json.loads(row[0])
            except (json.JSONDecodeError, TypeError):
                return {}
        return {}

    def _build_one(self, internal_id: int) -> Optional[tuple[str, str]]:
        meta = self.repo.get_metadata(internal_id)
        if meta is None:
            return None
        labels = self._get_labels(internal_id)
        body = self.repo.get_body_markdown(internal_id, max_chars=40000)
        atts = [
            {"filename": a.filename, "size": a.size_bytes, "content_type": a.content_type}
            for a in self.repo.get_attachments(internal_id)
            if not a.is_inline
        ]
        return build_kos_page_payload(
            internal_id=internal_id,
            subject=meta.subject,
            sender=meta.sender,
            sender_name=meta.sender_name,
            to_addr=meta.to_addr,
            cc_addr=meta.cc_addr,
            date_iso=meta.date_received or "",
            mailbox=meta.mailbox,
            message_id=meta.message_id,
            thread_id=meta.thread_id,
            body_markdown=body,
            labels=labels,
            attachments=atts,
            notion_page_id=meta.notion_page_id,
        )

    def _put_with_retry(self, slug: str, content: str, max_retries: int = 3) -> dict:
        """put_page + 429 退避重试。"""
        attempt = 0
        while True:
            try:
                return self.client.put_page(slug, content)
            except KOSError as e:
                if e.code == "E_KOS_RATE_LIMIT" and attempt < max_retries:
                    attempt += 1
                    wait = 2 ** attempt
                    logger.warning(f"[bulk] 429 on {slug}, backoff {wait}s (attempt {attempt})")
                    time.sleep(wait)
                    continue
                raise

    def _verify_source(self, slug: str) -> str:
        """get_page 读回 source_id (canary)。"""
        page = self.client.call_tool("get_page", {"slug": slug})
        if isinstance(page, dict):
            return page.get("source_id") or "?"
        return "?"

    def _log(self, internal_id: int, slug: str, status: str, chunks: int, error: str) -> None:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.execute(
            """
            INSERT INTO kos_ingest_log (internal_id, slug, status, chunks, error, pushed_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(internal_id) DO UPDATE SET
                slug=excluded.slug, status=excluded.status,
                chunks=excluded.chunks, error=excluded.error,
                pushed_at=excluded.pushed_at
            """,
            (internal_id, slug, status, chunks, error or None, time.time()),
        )
        conn.commit()
        conn.close()

    def run(
        self,
        limit: Optional[int] = None,
        *,
        retry_failed: bool = False,
        require_body: bool = False,
        dry_run: bool = False,
        verify_canary: bool = True,
    ) -> dict[str, int]:
        """跑 bulk ingest。返回统计。

        verify_canary: 第一封 push 后校验 source_id === mailagent-emails, 不对
        立刻 abort (doc §6 step 4)。
        """
        if not dry_run and not self.client.configured:
            raise RuntimeError(
                "bulk KOSClient not configured — 检查 MAILAGENT_BULK_CLIENT_ID/SECRET + KOS_MCP_BASE"
            )
        candidates = self._candidates(limit, retry_failed, require_body)
        stats = {"total": len(candidates), "pushed": 0, "failed": 0, "skipped_no_meta": 0}
        logger.info(
            f"[bulk] start total={stats['total']} dry_run={dry_run} "
            f"verify_canary={verify_canary} rate={1.0 / self._sleep if self._sleep else 'unlimited'}qps"
        )

        for i, iid in enumerate(candidates, 1):
            built = self._build_one(iid)
            if built is None:
                stats["skipped_no_meta"] += 1
                continue
            slug, content = built

            if dry_run:
                logger.info(f"[bulk] dry-run {i}/{stats['total']} {slug} bytes={len(content.encode())}")
                stats["pushed"] += 1
                continue

            try:
                result = self._put_with_retry(slug, content)
                chunks = result.get("chunks", 0) if isinstance(result, dict) else 0
                self._log(iid, slug, "pushed", chunks, "")
                stats["pushed"] += 1
            except (KOSError, Exception) as e:
                self._log(iid, slug, "failed", 0, str(e)[:300])
                stats["failed"] += 1
                logger.warning(f"[bulk] push failed iid={iid} {slug}: {e}")
                time.sleep(self._sleep)
                continue

            # Canary: 第一封校验 source 路由 (doc §6 step 4)
            if verify_canary and stats["pushed"] == 1:
                src = self._verify_source(slug)
                if src != "mailagent-emails":
                    raise RuntimeError(
                        f"🔴 CANARY FAIL — {slug} source_id={src!r} (期望 mailagent-emails). "
                        "client 选错了 (该用 bulk 凭据), 立刻停。已 push 的需手动清理。"
                    )
                logger.info(f"[bulk] ✅ canary green — {slug} source_id=mailagent-emails")

            if i <= 5 or i % 50 == 0:
                logger.info(f"[bulk] {i}/{stats['total']} pushed iid={iid} {slug}")
            time.sleep(self._sleep)

        logger.info(f"[bulk] done {stats}")
        return stats


if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv()  # 单跑脚本不经 main.py, 显式 load .env 让 os.getenv 读到 BULK 凭据

    import argparse

    ap = argparse.ArgumentParser(description="KOS bulk ingest 存量邮件 → mailagent-emails")
    ap.add_argument("--limit", type=int, default=None, help="只 ingest 前 N 封 (Phase 1 用 50)")
    ap.add_argument("--dry-run", action="store_true", help="只 build payload 不推 KOS")
    ap.add_argument("--rate", type=float, default=2.0, help="put/s (默认 2, 保守避 Gemini RPM)")
    ap.add_argument("--retry-failed", action="store_true", help="重试之前 failed 的")
    ap.add_argument("--require-body", action="store_true", help="只 ingest 有 body_markdown 的")
    ap.add_argument("--no-canary", action="store_true", help="跳过第一封 source 校验 (不推荐)")
    ap.add_argument("--db-path", default="data/sync_store.db")
    args = ap.parse_args()

    ing = KOSBulkIngester(db_path=args.db_path, rate_qps=args.rate)
    result = ing.run(
        limit=args.limit,
        retry_failed=args.retry_failed,
        require_body=args.require_body,
        dry_run=args.dry_run,
        verify_canary=not args.no_canary,
    )
    print(result)
