"""Evelyn 周项目同步的端到端 runner。

流程（sync_from_email）:
  1. 从 SyncStore 取 email_metadata（mailbox, message_id, subject, sender, date_received,
     notion_page_id）
  2. detector 再检查一遍（防呆）
  3. AppleScriptArm.fetch_email_content_by_id(internal_id, mailbox) 拉 RFC 822 源码
  4. email.message_from_bytes → 遍历找第一个 .xlsx 附件 → 计算 md5 + bytes
  5. EvelynSyncStore: 按 internal_id 查是否 completed；若 completed 且 md5 一致且未 force
     → mark skipped 直接返回
  6. xlsx_parser.parse_xlsx → ParseResult(projects=[..])
  7. asyncio 并发 upsert_project（限流 4 并发），汇总 created/updated/failed
  8. 成功 → EvelynSyncStore.complete(...)；失败 → .fail(..)
"""

from __future__ import annotations

import asyncio
import email
import email.header
import email.policy
import re
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from loguru import logger

from src.config import config

from .detector import EvelynProjectDetector
from .notion_sync import (
    ProjectProgressNotionClient,
    STATUS_DONE,
    UpsertOutcome,
    upsert_project,
)
from .sync_store import EvelynSyncRecord, EvelynSyncStore
from .xlsx_parser import ParseResult, parse_xlsx


# Notion page URL 生成（从 page_id UUID → https://www.notion.so/<hex>）
def notion_page_url(page_id: Optional[str]) -> Optional[str]:
    if not page_id:
        return None
    clean = str(page_id).replace("-", "")
    return f"https://www.notion.so/{clean}"


@dataclass
class SyncSummary:
    internal_id: int
    status: str
    error: Optional[str] = None
    xlsx_filename: Optional[str] = None
    xlsx_md5: Optional[str] = None
    week_tag: Optional[str] = None
    total_rows: int = 0
    enbu_rows: int = 0
    projects_total: int = 0
    created: int = 0
    updated: int = 0
    skipped_idempotent: int = 0
    failed: int = 0
    marked_done: int = 0  # 本次从 Notion 标记为 Done（xlsx 已消失）的项目数
    failed_samples: List[str] = field(default_factory=list)
    done_samples: List[str] = field(default_factory=list)
    duration_sec: float = 0.0
    dry_run: bool = False

    def as_log_line(self) -> str:
        return (
            f"internal_id={self.internal_id} status={self.status} "
            f"week={self.week_tag} total={self.total_rows} enbu={self.enbu_rows} "
            f"projects={self.projects_total} "
            f"created={self.created} updated={self.updated} "
            f"skipped_idempotent={self.skipped_idempotent} failed={self.failed} "
            f"marked_done={self.marked_done} "
            f"dry_run={self.dry_run} dur={self.duration_sec:.1f}s"
        )


class EvelynProjectRunner:
    """端到端 runner。线程安全不保证（单 asyncio event loop 内使用）。"""

    # Notion 全局限流约 3 req/s。单项目 2~3 次 API，并发 2 峰值约 4 req/s
    # 实测并发 4 在 1000+ 项目规模会触发 429（Retry-After 可达 392s）。
    # 降并发 + 让 429 重试自然 smooth 掉尖峰。
    UPSERT_CONCURRENCY = 2

    def __init__(
        self,
        sync_store_db_path: Optional[str] = None,
        project_database_id: Optional[str] = None,
        filter_bu: Optional[str] = None,
        detector: Optional[EvelynProjectDetector] = None,
        arm=None,  # AppleScriptArm，延迟导入避免在 detector-only 上下文污染
    ):
        self.sync_store_db_path = sync_store_db_path or config.sync_store_db_path
        self.project_database_id = project_database_id or getattr(
            config, "project_progress_database_id", ""
        )
        if not self.project_database_id:
            raise RuntimeError(
                "PROJECT_PROGRESS_DATABASE_ID not set; cannot run Evelyn sync"
            )
        self.filter_bu = filter_bu or getattr(
            config, "project_progress_filter_bu", "TPS-ENBU"
        )
        self.detector = detector or EvelynProjectDetector(
            sender=getattr(config, "evelyn_sender", "evelyn.wei@tp-link.com"),
            subject_pattern=getattr(
                config,
                "evelyn_subject_pattern",
                r"【项目进度】项目deadline汇报.*市场产品",
            ),
        )
        self._arm = arm
        self._evelyn_store: Optional[EvelynSyncStore] = None

    # ---------- lazy deps ----------

    @property
    def arm(self):
        if self._arm is None:
            from src.mail.applescript_arm import AppleScriptArm

            self._arm = AppleScriptArm()
        return self._arm

    @property
    def evelyn_store(self) -> EvelynSyncStore:
        if self._evelyn_store is None:
            self._evelyn_store = EvelynSyncStore(self.sync_store_db_path)
        return self._evelyn_store

    # ---------- entry points ----------

    async def sync_from_email(
        self,
        *,
        internal_id: int,
        notion_email_page_id: Optional[str] = None,
        force: bool = False,
        dry_run: bool = False,
        project_limit: Optional[int] = None,
        rebuild_body: bool = False,
    ) -> SyncSummary:
        """同步一封 Evelyn 周项目邮件。

        Args:
            project_limit: 若提供，只 upsert 前 N 个项目（小批量验证时用）
        """
        started = time.time()
        logger.info(
            f"[evelyn] sync_from_email internal_id={internal_id} "
            f"force={force} dry_run={dry_run} project_limit={project_limit}"
        )

        email_row = self._load_email_row(internal_id)
        if email_row is None:
            msg = f"email internal_id={internal_id} not in SyncStore"
            logger.warning(f"[evelyn] {msg}")
            return SyncSummary(
                internal_id=internal_id, status="failed", error=msg, dry_run=dry_run
            )

        subject = email_row.get("subject") or ""
        sender = email_row.get("sender") or ""
        mailbox = email_row.get("mailbox") or config.mail_inbox_name
        date_received = email_row.get("date_received") or ""
        if not self.detector.is_match(sender=sender, subject=subject):
            msg = f"not an Evelyn project email (sender={sender!r}, subject={subject!r})"
            logger.info(f"[evelyn] {msg}")
            return SyncSummary(
                internal_id=internal_id,
                status="skipped",
                error=msg,
                dry_run=dry_run,
            )

        notion_email_page_id = notion_email_page_id or email_row.get("notion_page_id")

        # 已处理检查
        existing = self.evelyn_store.get(internal_id)
        if existing and existing.status == "completed" and not force:
            msg = f"already completed (week={existing.week_tag}, md5={existing.xlsx_md5})"
            logger.info(f"[evelyn] skip internal_id={internal_id}: {msg}")
            return SyncSummary(
                internal_id=internal_id,
                status="skipped",
                error=msg,
                xlsx_md5=existing.xlsx_md5,
                week_tag=existing.week_tag,
                dry_run=dry_run,
            )

        # AppleScript 拉源码 + 抽 xlsx
        xlsx_filename, xlsx_bytes = self._fetch_xlsx(internal_id, mailbox)
        if xlsx_bytes is None:
            msg = "no .xlsx attachment found in email"
            return SyncSummary(
                internal_id=internal_id, status="failed", error=msg, dry_run=dry_run
            )
        import hashlib

        md5 = hashlib.md5(xlsx_bytes).hexdigest()

        # md5 去重（转发链）
        same_md5 = self.evelyn_store.get_by_md5(md5)
        if (
            same_md5
            and same_md5.email_internal_id != internal_id
            and not force
        ):
            msg = (
                f"xlsx md5 {md5} already processed by "
                f"internal_id={same_md5.email_internal_id}"
            )
            logger.info(f"[evelyn] skip internal_id={internal_id}: {msg}")
            self.evelyn_store.skip(internal_id, msg, md5=md5)
            return SyncSummary(
                internal_id=internal_id,
                status="skipped",
                error=msg,
                xlsx_md5=md5,
                dry_run=dry_run,
            )

        # 解析
        try:
            parsed: ParseResult = parse_xlsx(
                xlsx_bytes, xlsx_filename, filter_bu=self.filter_bu
            )
        except Exception as e:
            logger.exception(f"[evelyn] parse_xlsx failed: {e}")
            msg = f"parse_xlsx failed: {e}"
            self._record_fail(internal_id, subject, date_received, md5, xlsx_filename, msg)
            return SyncSummary(
                internal_id=internal_id, status="failed", error=msg, dry_run=dry_run
            )

        logger.info(
            f"[evelyn] parsed xlsx={xlsx_filename!r} md5={md5} "
            f"total={parsed.total_rows} enbu={parsed.filtered_rows} "
            f"projects={parsed.projects_total} week={parsed.week_tag}"
        )

        if project_limit and project_limit > 0 and project_limit < len(parsed.projects):
            head = parsed.projects[:project_limit]
            # 若切片内 child 的 parent 未被包含，把 parent 也加进来（保证 relation 完整）
            head_ext_ids = {p.external_id for p in head}
            missing_parent_ids = {
                p.parent_external_id for p in head
                if p.parent_external_id and p.parent_external_id not in head_ext_ids
            }
            if missing_parent_ids:
                extras = [
                    p for p in parsed.projects
                    if p.external_id in missing_parent_ids and p.external_id not in head_ext_ids
                ]
                head.extend(extras)
                logger.info(
                    f"[evelyn] +{len(extras)} missing parents pulled into slice"
                )
            logger.info(
                f"[evelyn] project_limit={project_limit} applied: "
                f"{len(parsed.projects)} → {len(head)}"
            )
            parsed.projects = head

        record = EvelynSyncRecord(
            email_internal_id=internal_id,
            email_message_id=email_row.get("message_id"),
            email_subject=subject,
            email_date=date_received,
            xlsx_filename=xlsx_filename,
            xlsx_md5=md5,
            week_tag=parsed.week_tag,
            total_rows=parsed.total_rows,
            enbu_rows=parsed.filtered_rows,
            projects_total=parsed.projects_total,
        )

        if dry_run:
            logger.info(
                f"[evelyn] DRY-RUN internal_id={internal_id}: "
                f"would upsert {parsed.projects_total} projects"
            )
            return SyncSummary(
                internal_id=internal_id,
                status="completed",
                xlsx_filename=xlsx_filename,
                xlsx_md5=md5,
                week_tag=parsed.week_tag,
                total_rows=parsed.total_rows,
                enbu_rows=parsed.filtered_rows,
                projects_total=parsed.projects_total,
                created=parsed.projects_total,
                duration_sec=time.time() - started,
                dry_run=True,
            )

        self.evelyn_store.start(record)

        # 执行 upsert
        email_url = notion_page_url(notion_email_page_id)
        # mark-done 扫描只在 "全量 xlsx" 模式下启用；
        # project_limit 切片时 xlsx 的项目集不完整，跳过避免误标
        do_mark_done = project_limit is None or project_limit <= 0
        try:
            (
                created,
                updated,
                skipped,
                failed,
                marked_done,
                failed_samples,
                done_samples,
            ) = await self._upsert_all(
                parsed,
                email_url,
                mark_missing_as_done=do_mark_done,
                rebuild_body=rebuild_body,
            )
        except Exception as e:
            logger.exception(f"[evelyn] upsert_all fatal: {e}")
            self.evelyn_store.fail(record, str(e))
            return SyncSummary(
                internal_id=internal_id,
                status="failed",
                error=str(e),
                xlsx_filename=xlsx_filename,
                xlsx_md5=md5,
                week_tag=parsed.week_tag,
                total_rows=parsed.total_rows,
                enbu_rows=parsed.filtered_rows,
                projects_total=parsed.projects_total,
                duration_sec=time.time() - started,
            )

        record.projects_created = created
        record.projects_updated = updated
        record.projects_failed = failed

        if failed == parsed.projects_total and parsed.projects_total > 0:
            self.evelyn_store.fail(record, "all projects failed")
            status = "failed"
            err: Optional[str] = "all projects failed"
        else:
            self.evelyn_store.complete(record)
            status = "completed"
            err = None

        summary = SyncSummary(
            internal_id=internal_id,
            status=status,
            error=err,
            xlsx_filename=xlsx_filename,
            xlsx_md5=md5,
            week_tag=parsed.week_tag,
            total_rows=parsed.total_rows,
            enbu_rows=parsed.filtered_rows,
            projects_total=parsed.projects_total,
            created=created,
            updated=updated,
            skipped_idempotent=skipped,
            failed=failed,
            marked_done=marked_done,
            failed_samples=failed_samples[:5],
            done_samples=done_samples[:5],
            duration_sec=time.time() - started,
        )
        logger.info(f"[evelyn] done: {summary.as_log_line()}")
        return summary

    async def _upsert_all(
        self,
        parsed: ParseResult,
        email_url: Optional[str],
        *,
        mark_missing_as_done: bool,
        rebuild_body: bool = False,
    ) -> Tuple[int, int, int, int, int, List[str], List[str]]:
        sem = asyncio.Semaphore(self.UPSERT_CONCURRENCY)
        created = updated = skipped = failed = 0
        marked_done = 0
        failed_samples: List[str] = []
        done_samples: List[str] = []

        # 两阶段 upsert：先所有 parent/solo（parent_external_id 为 None）；
        # 第二阶段 children 用母任务 page_id 设置 relation。
        phase1_rows = [p for p in parsed.projects if p.parent_external_id is None]
        phase2_rows = [p for p in parsed.projects if p.parent_external_id is not None]
        logger.info(
            f"[evelyn] phase1 (parent+solo)={len(phase1_rows)} "
            f"phase2 (children)={len(phase2_rows)}"
        )

        ext_to_page: Dict[str, str] = {}

        async with ProjectProgressNotionClient(
            database_id=self.project_database_id
        ) as client:

            def tally(outcome: UpsertOutcome):
                nonlocal created, updated, skipped, failed
                if outcome.action == "created":
                    created += 1
                elif outcome.action == "updated":
                    updated += 1
                elif outcome.action == "skipped_idempotent":
                    skipped += 1
                elif outcome.action == "failed":
                    failed += 1
                    if len(failed_samples) < 10:
                        failed_samples.append(
                            f"{outcome.external_id}: {outcome.error}"
                        )

            async def run_one(row, parent_page_id):
                async with sem:
                    return await upsert_project(
                        client, row,
                        week_tag=parsed.week_tag,
                        evelyn_email_url=email_url,
                        rebuild_body=rebuild_body,
                        parent_page_id=parent_page_id,
                    )

            # Phase 1: parent + solo
            tasks1 = [run_one(p, None) for p in phase1_rows]
            for i, fut in enumerate(asyncio.as_completed(tasks1), 1):
                outcome: UpsertOutcome = await fut
                tally(outcome)
                if outcome.page_id:
                    ext_to_page[outcome.external_id] = outcome.page_id
                if i % 20 == 0 or i == len(tasks1):
                    logger.info(
                        f"[evelyn] phase1 {i}/{len(tasks1)}: "
                        f"created={created} updated={updated} "
                        f"skipped_idempotent={skipped} failed={failed}"
                    )

            # Phase 2: children（需要母 page_id）
            # 未知 parent page_id 的子任务退化为无 parent（只有当母 upsert 失败时）
            tasks2 = []
            orphan_children = 0
            for row in phase2_rows:
                parent_pid = ext_to_page.get(row.parent_external_id)
                if not parent_pid:
                    orphan_children += 1
                tasks2.append(run_one(row, parent_pid))
            if orphan_children:
                logger.warning(
                    f"[evelyn] {orphan_children} children lost parent page_id (parent upsert likely failed)"
                )
            for i, fut in enumerate(asyncio.as_completed(tasks2), 1):
                outcome = await fut
                tally(outcome)
                if i % 40 == 0 or i == len(tasks2):
                    logger.info(
                        f"[evelyn] phase2 {i}/{len(tasks2)}: "
                        f"created={created} updated={updated} "
                        f"skipped_idempotent={skipped} failed={failed}"
                    )

            # 标记 xlsx 中消失的项目为 Done
            if mark_missing_as_done:
                marked_done, done_samples = await self._mark_missing_done(
                    client, parsed
                )

        return created, updated, skipped, failed, marked_done, failed_samples, done_samples

    async def backfill_project_start(
        self, *, internal_id: int, dry_run: bool = False
    ) -> Dict[str, int]:
        """批量回填"项目开始时间"到所有已入库项目页。

        - 从指定邮件的 xlsx 重新解析每行项目的 earliest_progress_date
        - 查 Notion BU=filter_bu 的所有活跃页（external_id → page_id 映射）
        - 对每个 xlsx 行：若 Notion 有对应页 → set "项目开始时间" = earliest_progress_date
        - 不触碰其它 property / 正文 / Status
        """
        started = time.time()
        logger.info(
            f"[evelyn] backfill_project_start internal_id={internal_id} dry_run={dry_run}"
        )
        email_row = self._load_email_row(internal_id)
        if email_row is None:
            raise RuntimeError(f"email internal_id={internal_id} not in SyncStore")
        mailbox = email_row.get("mailbox") or config.mail_inbox_name
        xlsx_filename, xlsx_bytes = self._fetch_xlsx(internal_id, mailbox)
        if xlsx_bytes is None:
            raise RuntimeError("no .xlsx attachment found in email")
        parsed: ParseResult = parse_xlsx(xlsx_bytes, xlsx_filename)
        logger.info(
            f"[evelyn] parsed {len(parsed.projects)} projects, "
            f"enbu={parsed.filtered_rows} week={parsed.week_tag}"
        )

        stats = {"total": len(parsed.projects), "updated": 0, "skipped": 0, "missing": 0, "failed": 0}
        sem = asyncio.Semaphore(self.UPSERT_CONCURRENCY)

        async with ProjectProgressNotionClient(
            database_id=self.project_database_id
        ) as client:
            logger.info(f"[evelyn] fetching Notion ext_id map...")
            ext_to_page = await client.list_all_by_external_id(bu=parsed.filter_bu)
            logger.info(f"[evelyn] found {len(ext_to_page)} pages in Notion")

            async def update_one(row):
                if row.earliest_progress_date is None:
                    stats["skipped"] += 1
                    return
                page_id = ext_to_page.get(row.external_id)
                if page_id is None:
                    stats["missing"] += 1
                    return
                if dry_run:
                    stats["updated"] += 1
                    return
                async with sem:
                    try:
                        await client.set_project_start(page_id, row.earliest_progress_date)
                        stats["updated"] += 1
                    except Exception as e:
                        logger.warning(
                            f"[evelyn] set_project_start failed {row.external_id}: {e}"
                        )
                        stats["failed"] += 1

            tasks = [update_one(r) for r in parsed.projects]
            done_count = 0
            for fut in asyncio.as_completed(tasks):
                await fut
                done_count += 1
                if done_count % 50 == 0 or done_count == len(tasks):
                    logger.info(
                        f"[evelyn] backfill {done_count}/{len(tasks)}: "
                        f"updated={stats['updated']} skipped_no_date={stats['skipped']} "
                        f"missing_page={stats['missing']} failed={stats['failed']}"
                    )

        stats["duration_sec"] = round(time.time() - started, 1)
        return stats

    async def _mark_missing_done(
        self, client: ProjectProgressNotionClient, parsed: ParseResult
    ) -> Tuple[int, List[str]]:
        """查 Notion 中 BU=TPS-ENBU & Status != Done 的所有页，
        对比本次 xlsx 的 external_id 集合，把"xlsx 消失"的项目标记为 Done。

        只在"全量 xlsx 同步"时做（不做切片 / project_limit 时 skip），避免误标。
        """
        bu = parsed.filter_bu
        try:
            active_pages = await client.list_active_pages(bu=bu)
        except Exception as e:
            logger.warning(f"[evelyn] list_active_pages failed, skip mark-done: {e}")
            return 0, []
        xlsx_ext_ids = {p.external_id for p in parsed.projects}
        to_mark = [
            pg
            for pg in active_pages
            if pg["external_id"] and pg["external_id"] not in xlsx_ext_ids
        ]
        logger.info(
            f"[evelyn] mark-done scan: notion_active={len(active_pages)} "
            f"xlsx_ext_ids={len(xlsx_ext_ids)} missing_in_xlsx={len(to_mark)}"
        )
        samples: List[str] = []
        cnt = 0
        sem = asyncio.Semaphore(self.UPSERT_CONCURRENCY)

        async def mark_one(pg):
            nonlocal cnt
            async with sem:
                try:
                    await client.mark_status(pg["id"], STATUS_DONE)
                except Exception as e:
                    logger.warning(
                        f"[evelyn] mark Done failed {pg['external_id']!r}: {e}"
                    )
                    return
            cnt += 1
            if len(samples) < 10:
                samples.append(f"{pg['external_id']}: {pg['title'][:60]}")

        await asyncio.gather(*[mark_one(pg) for pg in to_mark])
        return cnt, samples

    # ---------- helpers ----------

    def _load_email_row(self, internal_id: int) -> Optional[Dict[str, Any]]:
        """从 email_metadata 取一行。"""
        with sqlite3.connect(self.sync_store_db_path, timeout=30) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT internal_id, message_id, subject, sender, mailbox, "
                "date_received, notion_page_id, sync_status "
                "FROM email_metadata WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
        return dict(row) if row else None

    def find_latest_pending(self) -> Optional[int]:
        """从 email_metadata 找最近的一封 Evelyn 周项目邮件（未在 evelyn_project_sync 中 completed）。"""
        sender_like = f"%{self.detector.sender}%"
        # Subject regex 在 SQLite 里难做；用 LIKE 粗筛，再 Python 精筛
        with sqlite3.connect(self.sync_store_db_path, timeout=30) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT internal_id, subject, sender, date_received FROM email_metadata "
                "WHERE (sender LIKE ? OR sender LIKE ?) "
                "AND subject LIKE '%项目deadline汇报%' "
                "ORDER BY date_received DESC LIMIT 50",
                (sender_like, sender_like.upper()),
            ).fetchall()
        for row in rows:
            if not self.detector.is_match(sender=row["sender"], subject=row["subject"]):
                continue
            rec = self.evelyn_store.get(row["internal_id"])
            if rec and rec.status == "completed":
                continue
            return int(row["internal_id"])
        return None

    def find_all_history(self, limit: int = 20) -> List[int]:
        sender_like = f"%{self.detector.sender}%"
        with sqlite3.connect(self.sync_store_db_path, timeout=30) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT internal_id, subject, sender, date_received FROM email_metadata "
                "WHERE (sender LIKE ? OR sender LIKE ?) "
                "AND subject LIKE '%项目deadline汇报%' "
                "ORDER BY date_received ASC LIMIT ?",
                (sender_like, sender_like.upper(), limit * 3),
            ).fetchall()
        out: List[int] = []
        for row in rows:
            if not self.detector.is_match(sender=row["sender"], subject=row["subject"]):
                continue
            out.append(int(row["internal_id"]))
            if len(out) >= limit:
                break
        return out

    def _fetch_xlsx(
        self, internal_id: int, mailbox: str
    ) -> Tuple[Optional[str], Optional[bytes]]:
        """从 AppleScript 拉源码 → 提取第一个 .xlsx 附件。"""
        try:
            result = self.arm.fetch_email_content_by_id(internal_id, mailbox)
        except Exception as e:
            logger.error(f"[evelyn] AppleScript fetch failed for {internal_id}: {e}")
            return None, None
        if not result or not result.get("source"):
            return None, None
        source = result["source"]
        if isinstance(source, str):
            source = source.encode("utf-8", errors="replace")
        try:
            msg = email.message_from_bytes(source, policy=email.policy.default)
        except Exception as e:
            logger.error(f"[evelyn] parse MIME failed: {e}")
            return None, None

        for part in msg.walk():
            fn = part.get_filename()
            if not fn:
                continue
            fn_decoded = _decode_header(fn)
            if not fn_decoded.lower().endswith(".xlsx"):
                continue
            payload = part.get_payload(decode=True) or b""
            if not payload:
                continue
            return fn_decoded, payload
        return None, None

    def _record_fail(
        self,
        internal_id: int,
        subject: str,
        date_iso: str,
        md5: str,
        xlsx_filename: str,
        msg: str,
    ) -> None:
        rec = self.evelyn_store.get(internal_id) or EvelynSyncRecord(
            email_internal_id=internal_id
        )
        rec.email_subject = subject
        rec.email_date = date_iso
        rec.xlsx_md5 = md5
        rec.xlsx_filename = xlsx_filename
        self.evelyn_store.fail(rec, msg)


def _decode_header(raw: str) -> str:
    try:
        parts = email.header.decode_header(raw)
        out: List[str] = []
        for piece, enc in parts:
            if isinstance(piece, bytes):
                out.append(piece.decode(enc or "utf-8", errors="replace"))
            else:
                out.append(piece)
        return "".join(out)
    except Exception:
        return raw
