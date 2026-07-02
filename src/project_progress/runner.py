"""项目周报同步的端到端 runner.

流程 (sync_from_email):
  1. 从 SyncStore 取 email_metadata
  2. detector 再检查一遍 (防呆)
  3. 取第一个 .xlsx 附件字节: 优先 v4 SQLite SSoT (email_attachment.local_path),
     davmail 合成 ID 无法走 AppleScript; 仅未双写的 applescript-origin 邮件才回退 AppleScript
  4. (回退路径) email.message_from_bytes → 找第一个 .xlsx 附件 → 计算 md5 + bytes
  5. ProjectProgressSyncStore: 按 internal_id 查是否 completed; force=True 才重跑
  6. xlsx_parser.parse_xlsx_v2 → ParseResult (3 sheet 合并 + sheet_stats)
  7. ensure_schema (5min 缓存) → 缺失 7 个 property 自动补齐
  8. asyncio 并发 upsert_project (Phase 1 母+独立 → Phase 2 子任务)
  9. 成功 → store.complete(...); 失败 → .fail(...)
"""

from __future__ import annotations

import asyncio
import email
import email.header
import email.policy
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from loguru import logger

from src.config import config

from .detector import ProjectProgressDetector
from .notion_schema import ProjectProgressSchemaBootstrapper
from .notion_sync import (
    ProjectProgressNotionClient,
    STATUS_DONE,
    UpsertOutcome,
    upsert_project,
)
from .sync_store import ProjectProgressSyncRecord, ProjectProgressSyncStore
from .xlsx_parser import ParseResult, SheetKind, parse_xlsx_v2 as parse_xlsx


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
    marked_done: int = 0  # 兜底 mark Done (xlsx 完全消失) 的项目数
    # v2 4-sheet 改造新增统计
    sheet_ongoing_rows: int = 0
    sheet_shipped_rows: int = 0
    sheet_suspended_rows: int = 0
    projects_marked_done: int = 0      # 本次因 Sheet=Shipped → 写 Status=Done 的项目数
    projects_marked_suspended: int = 0  # 本次因 Sheet=Suspended → 写 Status=Suspended 的项目数
    failed_samples: List[str] = field(default_factory=list)
    done_samples: List[str] = field(default_factory=list)
    duration_sec: float = 0.0
    dry_run: bool = False

    def as_log_line(self) -> str:
        return (
            f"internal_id={self.internal_id} status={self.status} "
            f"week={self.week_tag} total={self.total_rows} enbu={self.enbu_rows} "
            f"projects={self.projects_total} "
            f"sheets[ongoing={self.sheet_ongoing_rows} shipped={self.sheet_shipped_rows} "
            f"suspended={self.sheet_suspended_rows}] "
            f"created={self.created} updated={self.updated} "
            f"skipped_idempotent={self.skipped_idempotent} failed={self.failed} "
            f"marked_done={self.marked_done} "
            f"st_done={self.projects_marked_done} st_suspended={self.projects_marked_suspended} "
            f"dry_run={self.dry_run} dur={self.duration_sec:.1f}s"
        )


class ProjectProgressRunner:
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
        detector: Optional[ProjectProgressDetector] = None,
        arm=None,  # AppleScriptArm，延迟导入避免在 detector-only 上下文污染
    ):
        self.sync_store_db_path = sync_store_db_path or config.sync_store_db_path
        self.project_database_id = project_database_id or getattr(
            config, "project_progress_database_id", ""
        )
        if not self.project_database_id:
            raise RuntimeError(
                "PROJECT_PROGRESS_DATABASE_ID not set; cannot run project-progress sync"
            )
        self.filter_bu = filter_bu or getattr(
            config, "project_progress_filter_bu", "TPS-ENBU"
        )
        self.detector = detector or ProjectProgressDetector(
            sender=getattr(config, "project_progress_sender", ""),
            subject_pattern=getattr(config, "project_progress_subject_pattern", ""),
        )
        self._arm = arm
        self._progress_store: Optional[ProjectProgressSyncStore] = None

    # ---------- lazy deps ----------

    @property
    def arm(self):
        """邮件抓取后端（lazy）。按 MAILAGENT_BACKEND 选择，与主同步链路一致。

        davmail 邮件的 internal_id 是合成 ID (>=10^9)，AppleScript 无法按
        `whose id` 抓源码；davmail 模式必须用 DavMailBackend 按 imap_uid 重抓，
        否则 _fetch_xlsx 的 SSoT-miss 回退会必然失败（合成 ID 在 Mail.app 报
        “无效的索引”）。
        """
        if self._arm is None:
            from src.mail.backend.factory import create_backend
            from src.mail.sync_store import SyncStore

            backend_name = getattr(config, "mailagent_backend", "applescript")
            sync_store = (
                SyncStore(db_path=self.sync_store_db_path)
                if backend_name == "davmail"
                else None
            )
            # E1 §3.1 Step 3: applescript 分支也走 create_backend() 而非裸构造
            # AppleScriptArm() —— 收口进 factory, 与上面 davmail 分支统一路径。
            self._arm = create_backend(config, sync_store)
        return self._arm

    @property
    def progress_store(self) -> ProjectProgressSyncStore:
        if self._progress_store is None:
            self._progress_store = ProjectProgressSyncStore(self.sync_store_db_path)
        return self._progress_store

    # ---------- entry points ----------

    async def sync_from_email(
        self,
        *,
        internal_id: int,
        notion_email_page_id: Optional[str] = None,
        force: bool = False,
        dry_run: bool = False,
        project_limit: Optional[int] = None,
        sheets: Optional[set] = None,
    ) -> SyncSummary:
        """同步一封项目周报邮件.

        Args:
            project_limit: 若提供, 只 upsert 前 N 个项目 (小批量验证)
            sheets: 限制解析哪些 sheet (默认 None = 全 3 个 ONGOING/SHIPPED/SUSPENDED).
                    传 {SheetKind.ONGOING} 仅解析 Ongoing (兼容 v1 单 sheet 行为).
        """
        started = time.time()
        logger.info(
            f"[pp] sync_from_email internal_id={internal_id} "
            f"force={force} dry_run={dry_run} project_limit={project_limit}"
        )

        email_row = self._load_email_row(internal_id)
        if email_row is None:
            msg = f"email internal_id={internal_id} not in SyncStore"
            logger.warning(f"[pp] {msg}")
            return SyncSummary(
                internal_id=internal_id, status="failed", error=msg, dry_run=dry_run
            )

        subject = email_row.get("subject") or ""
        sender = email_row.get("sender") or ""
        mailbox = email_row.get("mailbox") or config.mail_inbox_name
        date_received = email_row.get("date_received") or ""
        if not self.detector.is_match(sender=sender, subject=subject):
            msg = f"not a project-progress email (sender={sender!r}, subject={subject!r})"
            logger.info(f"[pp] {msg}")
            return SyncSummary(
                internal_id=internal_id,
                status="skipped",
                error=msg,
                dry_run=dry_run,
            )

        notion_email_page_id = notion_email_page_id or email_row.get("notion_page_id")

        # 已处理检查
        existing = self.progress_store.get(internal_id)
        if existing and existing.status == "completed" and not force:
            msg = f"already completed (week={existing.week_tag}, md5={existing.xlsx_md5})"
            logger.info(f"[pp] skip internal_id={internal_id}: {msg}")
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
        same_md5 = self.progress_store.get_by_md5(md5)
        if (
            same_md5
            and same_md5.email_internal_id != internal_id
            and not force
        ):
            msg = (
                f"xlsx md5 {md5} already processed by "
                f"internal_id={same_md5.email_internal_id}"
            )
            logger.info(f"[pp] skip internal_id={internal_id}: {msg}")
            self.progress_store.skip(internal_id, msg, md5=md5)
            return SyncSummary(
                internal_id=internal_id,
                status="skipped",
                error=msg,
                xlsx_md5=md5,
                dry_run=dry_run,
            )

        # 解析 (默认 3 sheet)
        try:
            parsed: ParseResult = parse_xlsx(
                xlsx_bytes, xlsx_filename, filter_bu=self.filter_bu, sheets=sheets,
            )
        except Exception as e:
            logger.exception(f"[pp] parse_xlsx failed: {e}")
            msg = f"parse_xlsx failed: {e}"
            self._record_fail(internal_id, subject, date_received, md5, xlsx_filename, msg)
            return SyncSummary(
                internal_id=internal_id, status="failed", error=msg, dry_run=dry_run
            )

        logger.info(
            f"[pp] parsed xlsx={xlsx_filename!r} md5={md5} "
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
                    f"[pp] +{len(extras)} missing parents pulled into slice"
                )
            logger.info(
                f"[pp] project_limit={project_limit} applied: "
                f"{len(parsed.projects)} → {len(head)}"
            )
            parsed.projects = head

        # 各 sheet 的 ENBU 行数 (用于 record + summary)
        sheet_ongoing = parsed.sheet_stats.get(SheetKind.ONGOING, 0)
        sheet_shipped = parsed.sheet_stats.get(SheetKind.SHIPPED, 0)
        sheet_suspended = parsed.sheet_stats.get(SheetKind.SUSPENDED, 0)

        record = ProjectProgressSyncRecord(
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
            sheet_ongoing_rows=sheet_ongoing,
            sheet_shipped_rows=sheet_shipped,
            sheet_suspended_rows=sheet_suspended,
        )

        if dry_run:
            logger.info(
                f"[pp] DRY-RUN internal_id={internal_id}: "
                f"would upsert {parsed.projects_total} projects "
                f"(ongoing={sheet_ongoing} shipped={sheet_shipped} suspended={sheet_suspended})"
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
                sheet_ongoing_rows=sheet_ongoing,
                sheet_shipped_rows=sheet_shipped,
                sheet_suspended_rows=sheet_suspended,
                projects_marked_done=sheet_shipped,       # dry-run 估算
                projects_marked_suspended=sheet_suspended,
                duration_sec=time.time() - started,
                dry_run=True,
            )

        self.progress_store.start(record)

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
                projects_marked_done,
                projects_marked_suspended,
                failed_samples,
                done_samples,
            ) = await self._upsert_all(
                parsed,
                email_url,
                mark_missing_as_done=do_mark_done,
            )
        except Exception as e:
            logger.exception(f"[pp] upsert_all fatal: {e}")
            self.progress_store.fail(record, str(e))
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
        record.projects_marked_done = projects_marked_done
        record.projects_marked_suspended = projects_marked_suspended

        if failed == parsed.projects_total and parsed.projects_total > 0:
            self.progress_store.fail(record, "all projects failed")
            status = "failed"
            err: Optional[str] = "all projects failed"
        else:
            self.progress_store.complete(record)
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
            sheet_ongoing_rows=sheet_ongoing,
            sheet_shipped_rows=sheet_shipped,
            sheet_suspended_rows=sheet_suspended,
            projects_marked_done=projects_marked_done,
            projects_marked_suspended=projects_marked_suspended,
            failed_samples=failed_samples[:5],
            done_samples=done_samples[:5],
            duration_sec=time.time() - started,
        )
        logger.info(f"[pp] done: {summary.as_log_line()}")
        return summary

    async def _upsert_all(
        self,
        parsed: ParseResult,
        email_url: Optional[str],
        *,
        mark_missing_as_done: bool,
    ) -> Tuple[int, int, int, int, int, int, int, List[str], List[str]]:
        """返回 (created, updated, skipped, failed, marked_done_fallback,
                  projects_marked_done_sheet2, projects_marked_suspended_sheet3,
                  failed_samples, done_samples)
        """
        sem = asyncio.Semaphore(self.UPSERT_CONCURRENCY)
        created = updated = skipped = failed = 0
        marked_done = 0
        projects_marked_done_sheet = 0       # 因 Sheet=Shipped 写 Status=Done 的项目
        projects_marked_suspended_sheet = 0  # 因 Sheet=Suspended 写 Status=Suspended 的项目
        failed_samples: List[str] = []
        done_samples: List[str] = []

        # external_id → SheetKind, 用于 tally 时区分项目所属 sheet
        ext_to_kind: Dict[str, SheetKind] = {p.external_id: p.current_sheet for p in parsed.projects}

        # 两阶段 upsert: 先 parent/solo, 后 children. 母子关系仅 ONGOING 内.
        phase1_rows = [p for p in parsed.projects if p.parent_external_id is None]
        phase2_rows = [p for p in parsed.projects if p.parent_external_id is not None]
        logger.info(
            f"[pp] phase1 (parent+solo)={len(phase1_rows)} "
            f"phase2 (children)={len(phase2_rows)}"
        )

        ext_to_page: Dict[str, str] = {}

        async with ProjectProgressNotionClient(
            database_id=self.project_database_id
        ) as client:
            # 先做 schema bootstrap (5min 缓存): 确保 7 个新 property 存在,
            # KNOWN_DB_PROPS 被填充, _safe_set 才能正确 skip 缺失字段.
            try:
                bootstrapper = ProjectProgressSchemaBootstrapper(client)
                await bootstrapper.ensure_schema()
            except Exception as e:
                logger.warning(f"[pp] schema bootstrap failed (non-fatal): {e}")

            def tally(outcome: UpsertOutcome):
                nonlocal created, updated, skipped, failed
                nonlocal projects_marked_done_sheet, projects_marked_suspended_sheet
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
                # 跨 sheet 状态写入统计 (只在成功 create/update 时计数)
                if outcome.action in ("created", "updated"):
                    kind = ext_to_kind.get(outcome.external_id)
                    if kind == SheetKind.SHIPPED:
                        projects_marked_done_sheet += 1
                    elif kind == SheetKind.SUSPENDED:
                        projects_marked_suspended_sheet += 1

            async def run_one(row, parent_page_id):
                async with sem:
                    return await upsert_project(
                        client, row,
                        week_tag=parsed.week_tag,
                        source_email_url=email_url,
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
                        f"[pp] phase1 {i}/{len(tasks1)}: "
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
                    f"[pp] {orphan_children} children lost parent page_id (parent upsert likely failed)"
                )
            for i, fut in enumerate(asyncio.as_completed(tasks2), 1):
                outcome = await fut
                tally(outcome)
                if i % 40 == 0 or i == len(tasks2):
                    logger.info(
                        f"[pp] phase2 {i}/{len(tasks2)}: "
                        f"created={created} updated={updated} "
                        f"skipped_idempotent={skipped} failed={failed}"
                    )

            # 标记 xlsx 中消失的项目为 Done
            if mark_missing_as_done:
                marked_done, done_samples = await self._mark_missing_done(
                    client, parsed
                )

        return (
            created, updated, skipped, failed,
            marked_done, projects_marked_done_sheet, projects_marked_suspended_sheet,
            failed_samples, done_samples,
        )

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
            f"[pp] backfill_project_start internal_id={internal_id} dry_run={dry_run}"
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
            f"[pp] parsed {len(parsed.projects)} projects, "
            f"enbu={parsed.filtered_rows} week={parsed.week_tag}"
        )

        stats = {"total": len(parsed.projects), "updated": 0, "skipped": 0, "missing": 0, "failed": 0}
        sem = asyncio.Semaphore(self.UPSERT_CONCURRENCY)

        async with ProjectProgressNotionClient(
            database_id=self.project_database_id
        ) as client:
            logger.info("[pp] fetching Notion ext_id map...")
            ext_to_page = await client.list_all_by_external_id(bu=parsed.filter_bu)
            logger.info(f"[pp] found {len(ext_to_page)} pages in Notion")

            async def update_one(row):
                # 优先 xlsx 立项时间 (Product Establishment Date), 兜底 earliest_progress_date
                start_date = row.establishment_date or row.earliest_progress_date
                if start_date is None:
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
                        await client.set_project_start(page_id, start_date)
                        stats["updated"] += 1
                    except Exception as e:
                        logger.warning(
                            f"[pp] set_project_start failed {row.external_id}: {e}"
                        )
                        stats["failed"] += 1

            tasks = [update_one(r) for r in parsed.projects]
            done_count = 0
            for fut in asyncio.as_completed(tasks):
                await fut
                done_count += 1
                if done_count % 50 == 0 or done_count == len(tasks):
                    logger.info(
                        f"[pp] backfill {done_count}/{len(tasks)}: "
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
            logger.warning(f"[pp] list_active_pages failed, skip mark-done: {e}")
            return 0, []
        xlsx_ext_ids = {p.external_id for p in parsed.projects}
        to_mark = [
            pg
            for pg in active_pages
            if pg["external_id"] and pg["external_id"] not in xlsx_ext_ids
        ]
        logger.info(
            f"[pp] mark-done scan: notion_active={len(active_pages)} "
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
                        f"[pp] mark Done failed {pg['external_id']!r}: {e}"
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

    # subject LIKE 粗筛关键词: 与 PROJECT_PROGRESS_SUBJECT_PATTERN 的稳定子串保持一致
    _SUBJECT_LIKE_KEYWORD = "%项目deadline汇报%"

    def _query_candidates(
        self, *, order_desc: bool, limit: int
    ) -> List[Dict[str, Any]]:
        """SQL 粗筛: subject LIKE 必筛, sender LIKE 仅在 detector 配置 sender 时启用."""
        order = "DESC" if order_desc else "ASC"
        params: List[Any] = [self._SUBJECT_LIKE_KEYWORD]
        sender_clause = ""
        if self.detector.sender_required:
            sender_clause = "AND (sender LIKE ? OR sender LIKE ?) "
            sender_like = f"%{self.detector.sender}%"
            params.extend([sender_like, sender_like.upper()])
        params.append(limit)
        sql = (
            "SELECT internal_id, subject, sender, date_received FROM email_metadata "
            f"WHERE subject LIKE ? {sender_clause}"
            f"ORDER BY date_received {order} LIMIT ?"
        )
        with sqlite3.connect(self.sync_store_db_path, timeout=30) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(sql, tuple(params)).fetchall()
        return [dict(r) for r in rows]

    def find_latest_pending(self) -> Optional[int]:
        """从 email_metadata 找最近的一封项目周报邮件（未在 project_progress_sync 中 completed）。"""
        for row in self._query_candidates(order_desc=True, limit=50):
            if not self.detector.is_match(sender=row["sender"], subject=row["subject"]):
                continue
            rec = self.progress_store.get(row["internal_id"])
            if rec and rec.status == "completed":
                continue
            return int(row["internal_id"])
        return None

    def find_all_history(self, limit: int = 20) -> List[int]:
        out: List[int] = []
        for row in self._query_candidates(order_desc=False, limit=limit * 3):
            if not self.detector.is_match(sender=row["sender"], subject=row["subject"]):
                continue
            out.append(int(row["internal_id"]))
            if len(out) >= limit:
                break
        return out

    def _fetch_xlsx(
        self, internal_id: int, mailbox: str
    ) -> Tuple[Optional[str], Optional[bytes]]:
        """取邮件的第一个 .xlsx 附件字节.

        优先从 v4 SQLite SSoT (email_attachment.local_path) 读盘. SSoT 未命中时
        (davmail 落盘失败 / 老 applescript-origin 邮件未双写) 回退当前 backend 现抓:
        davmail 邮件的 internal_id 是合成 ID (>=10^9), 必须由 DavMailBackend 按
        imap_uid 抓; AppleScript backend 按 `whose id` 抓.
        """
        fn, payload = self._fetch_xlsx_from_sqlite(internal_id)
        if payload is not None:
            return fn, payload
        return self._fetch_xlsx_from_backend(internal_id, mailbox)

    def _fetch_xlsx_from_sqlite(
        self, internal_id: int
    ) -> Tuple[Optional[str], Optional[bytes]]:
        """从 v4 email_attachment 表读第一个原始 (非 derived) .xlsx 的落盘字节."""
        try:
            with sqlite3.connect(self.sync_store_db_path, timeout=30) as conn:
                conn.row_factory = sqlite3.Row
                row = conn.execute(
                    "SELECT filename, local_path FROM email_attachment "
                    "WHERE internal_id = ? AND derived_from IS NULL "
                    "AND lower(filename) LIKE '%.xlsx' "
                    "ORDER BY id LIMIT 1",
                    (internal_id,),
                ).fetchone()
        except sqlite3.Error as e:
            logger.warning(f"[pp] sqlite attachment lookup failed for {internal_id}: {e}")
            return None, None
        if not row or not row["local_path"]:
            return None, None
        from src.repository.attachment_store import AttachmentStore

        try:
            payload = AttachmentStore().read(row["local_path"])
        except OSError as e:
            logger.warning(
                f"[pp] read xlsx from SSoT failed for {internal_id} "
                f"(local_path={row['local_path']}): {e}"
            )
            return None, None
        if not payload:
            return None, None
        logger.info(
            f"[pp] xlsx loaded from SQLite SSoT internal_id={internal_id} "
            f"({row['filename']}, {len(payload)} bytes)"
        )
        return row["filename"], payload

    def _fetch_xlsx_from_backend(
        self, internal_id: int, mailbox: str
    ) -> Tuple[Optional[str], Optional[bytes]]:
        """SSoT-miss 回退: 用当前 backend 拉源码 → 提取第一个 .xlsx 附件.

        backend 由 ``self.arm`` 按 MAILAGENT_BACKEND 决定 (davmail→IMAP imap_uid /
        applescript→whose id), 两者 fetch_email_content_by_id 接口一致.
        """
        try:
            result = self.arm.fetch_email_content_by_id(internal_id, mailbox)
        except Exception as e:
            logger.error(f"[pp] backend fetch failed for {internal_id}: {e}")
            return None, None
        if not result or not result.get("source"):
            return None, None
        source = result["source"]
        if isinstance(source, str):
            source = source.encode("utf-8", errors="replace")
        try:
            msg = email.message_from_bytes(source, policy=email.policy.default)
        except Exception as e:
            logger.error(f"[pp] parse MIME failed: {e}")
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
        rec = self.progress_store.get(internal_id) or ProjectProgressSyncRecord(
            email_internal_id=internal_id
        )
        rec.email_subject = subject
        rec.email_date = date_iso
        rec.xlsx_md5 = md5
        rec.xlsx_filename = xlsx_filename
        self.progress_store.fail(rec, msg)


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
