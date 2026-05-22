"""AppleScriptBackend — IMailBackend 实现, FALLBACK 模式.

Wraps 现有 `AppleScriptArm` (机械臂) + `SQLiteRadar` (雷达) + `scripts/create_reply_draft.sh`.
现有类零改动, 这里只是把方法签名对齐 IMailBackend Protocol + 返回值改成 dataclass.

`backend_origin = "applescript"`: 新邮件抓进来时 SyncStore 写 backend_origin='applescript',
internal_id = Mail.app SQLite ROWID (< 1_000_000_000).
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from loguru import logger

from src.mail.applescript_arm import AppleScriptArm
from src.mail.backend.base import IMailBackend
from src.mail.backend.types import (
    BackendHealth,
    BackendOrigin,
    DraftAppendResult,
    DraftRequest,
    EmailContent,
    EmailMeta,
    RadarTick,
)
from src.mail.sqlite_radar import SQLiteRadar

if TYPE_CHECKING:
    from src.config import Config


# scripts/create_reply_draft.sh 路径 (相对仓库根)
_DRAFT_SH = Path(__file__).resolve().parents[3] / "scripts" / "create_reply_draft.sh"


class AppleScriptBackend(IMailBackend):
    """AppleScript + Mail.app 后端 (现有 v3 路径)."""

    backend_origin: BackendOrigin = "applescript"

    def __init__(self, cfg: "Config", *, sync_store=None):
        self.cfg = cfg
        # sync_store 接受但不使用 — 接口统一 (DavMailBackend 需要), 这里只是签名对齐
        self.sync_store = sync_store
        mailboxes = [m.strip() for m in cfg.sync_mailboxes.split(",") if m.strip()]
        self.arm = AppleScriptArm(
            account_name=cfg.mail_account_name,
            inbox_name=cfg.mail_inbox_name,
        )
        self.radar = SQLiteRadar(
            mailboxes=mailboxes,
            account_url_prefix=cfg.mail_account_url_prefix,
        )

    # =========================================================================
    # 启动 / 健康检查
    # =========================================================================

    def probe_readiness(self) -> tuple[bool, str]:
        """检查 Mail.app Envelope Index 可读 (隐含: Mail.app 进程在 + Full Disk Access OK)."""
        if not self.radar.is_available():
            return (
                False,
                "Envelope Index unreadable (Mail.app not running or Full Disk Access missing)",
            )
        try:
            current_max = self.radar.get_current_max_row_id()
            return True, f"Mail.app + Envelope Index OK (max_row_id={current_max})"
        except Exception as e:
            return False, f"Envelope Index query failed: {e}"

    def health_status(self) -> BackendHealth:
        ok, detail = self.probe_readiness()
        return BackendHealth(
            healthy=ok,
            backend=self.backend_origin,
            details={
                "db_path": str(self.radar.db_path) if self.radar.db_path else None,
                "applescript_calls": self.arm._stats.get("applescript_calls", 0),
                "probe_detail": detail,
            },
            error=None if ok else detail,
        )

    # =========================================================================
    # 正向 sync — 雷达 + 邮件抓取
    # =========================================================================

    def detect_new_emails(self, marker: Any = None) -> RadarTick:
        """SQLite Envelope Index 雷达检测.

        marker=None 启动 baseline: 返回当前 max_row_id, has_new=False.
        marker=int: 检测自该 row_id 后是否有新邮件; 有则附带 new_emails 列表.
        """
        if marker is None:
            try:
                current_max = self.radar.get_current_max_row_id()
            except Exception as e:
                logger.warning(f"[applescript-backend] get_current_max_row_id failed: {e}")
                current_max = 0
            return RadarTick(
                has_new=False, current_marker=current_max, estimated_new_count=0,
            )

        last_max = int(marker)
        try:
            has_new, current_max, estimated = self.radar.check_for_changes(last_max)
        except Exception as e:
            logger.error(f"[applescript-backend] check_for_changes failed: {e}")
            return RadarTick(has_new=False, current_marker=marker, estimated_new_count=0)

        new_emails: list[EmailMeta] = []
        if has_new:
            try:
                rows = self.radar.get_new_emails(since_row_id=last_max)
                new_emails = [self._radar_row_to_meta(r) for r in rows]
            except Exception as e:
                logger.warning(f"[applescript-backend] get_new_emails failed: {e}")

        return RadarTick(
            has_new=has_new,
            current_marker=current_max,
            estimated_new_count=estimated,
            new_emails=new_emails,
        )

    def fetch_email_by_id(
        self, internal_id: int, *, mailbox: Optional[str] = None
    ) -> Optional[EmailContent]:
        raw = self.arm.fetch_email_content_by_id(internal_id, mailbox=mailbox)
        if not raw:
            return None
        return EmailContent(
            message_id=raw["message_id"],
            internal_id=internal_id,
            subject=raw["subject"],
            sender=raw["sender"],
            date_received=raw["date"],
            content=raw["content"],
            source=raw["source"],
            is_read=raw["is_read"],
            is_flagged=raw["is_flagged"],
            thread_id=raw.get("thread_id"),
            mailbox=mailbox,
        )

    def fetch_recent(
        self, count: int, *, mailbox: Optional[str] = None
    ) -> list[EmailMeta]:
        raws = self.arm.fetch_emails_by_position(count=count, mailbox=mailbox)
        return [self._arm_row_to_meta(r, mailbox) for r in raws]

    # =========================================================================
    # 反向 sync — flag / read
    # =========================================================================

    def mark_as_read(
        self, internal_id: int, read: bool, *, mailbox: Optional[str] = None
    ) -> bool:
        return self.arm.mark_as_read_by_id(internal_id, read=read, mailbox=mailbox)

    def set_flag(
        self, internal_id: int, flagged: bool, *, mailbox: Optional[str] = None
    ) -> bool:
        return self.arm.set_flag_by_id(internal_id, flagged=flagged, mailbox=mailbox)

    # =========================================================================
    # 草稿创建 (调 create_reply_draft.sh)
    # =========================================================================

    def append_draft(self, draft: DraftRequest) -> DraftAppendResult:
        """调 scripts/create_reply_draft.sh, 利用 Mail.app reply 模式自带的引用 + 线程头定位.

        DraftRequest 字段映射到 sh CLI 参数:
            mode → --mode {reply-all,reply,new}
            internal_id_for_threading → --internal-id
            to/cc → --to / --cc (逗号分隔)
            subject → --subject (reply* 模式可省, 让 sh 自动加 Re:)
            reply_text → --reply-text
            in_reply_to → --message-id (sh 内部 fallback 用)

        富文本 reply_html 当前忽略 (sh 走纯文本路径). 实际富文本注入由 handle_create_draft
        在 sh 调用之前预设 NSPasteboard (现有 path A 工作流). 见 MEMORY.md "Path A".
        """
        if not _DRAFT_SH.exists():
            return DraftAppendResult(
                success=False,
                drafts_folder="Drafts",
                error=f"draft script not found: {_DRAFT_SH}",
            )

        args = ["bash", str(_DRAFT_SH), "--mode", draft.mode]

        if draft.internal_id_for_threading is not None:
            args += ["--internal-id", str(draft.internal_id_for_threading)]
        if draft.in_reply_to:
            args += ["--message-id", draft.in_reply_to]
        if draft.to:
            args += ["--to", ",".join(draft.to)]
        if draft.cc:
            args += ["--cc", ",".join(draft.cc)]
        if draft.subject:
            args += ["--subject", draft.subject]
        if draft.reply_text:
            args += ["--reply-text", draft.reply_text]
        args += ["--account", self.cfg.mail_account_name]
        args += ["--mailbox", self.cfg.mail_inbox_name]

        logger.info(
            f"[applescript-backend] append_draft mode={draft.mode} "
            f"internal_id={draft.internal_id_for_threading} sh={_DRAFT_SH.name}"
        )

        try:
            result = subprocess.run(
                args, capture_output=True, text=True, timeout=120,
            )
        except subprocess.TimeoutExpired:
            return DraftAppendResult(
                success=False, drafts_folder="Drafts", error="create_reply_draft.sh timed out (120s)",
            )
        except Exception as e:
            return DraftAppendResult(
                success=False, drafts_folder="Drafts", error=f"subprocess error: {e}",
            )

        # sh 输出 JSON {"success": bool, "method": "...", "error": "..."}
        try:
            payload = json.loads(result.stdout.strip().split("\n")[-1])
        except Exception:
            payload = {"success": False, "error": result.stderr or result.stdout or "no output"}

        return DraftAppendResult(
            success=bool(payload.get("success")),
            drafts_folder="Drafts",  # Mail.app 默认 Drafts 文件夹
            method=payload.get("method"),
            error=payload.get("error"),
        )

    # =========================================================================
    # 内部转换 helper
    # =========================================================================

    def _radar_row_to_meta(self, row: dict) -> EmailMeta:
        """SQLiteRadar.get_new_emails() 返回 dict → EmailMeta dataclass."""
        return EmailMeta(
            message_id=row.get("message_id", "") or "",
            internal_id=int(row["internal_id"]) if row.get("internal_id") else 0,
            subject=row.get("subject", "") or "",
            sender=row.get("sender", "") or "",
            date_received=row.get("date_received", "") or row.get("date", "") or "",
            is_read=bool(row.get("is_read", False)),
            is_flagged=bool(row.get("is_flagged", False)),
            thread_id=row.get("thread_id"),
            mailbox=row.get("mailbox"),
        )

    def _arm_row_to_meta(self, row: dict, mailbox: Optional[str]) -> EmailMeta:
        """AppleScriptArm.fetch_emails_by_position() 返回 dict → EmailMeta dataclass."""
        return EmailMeta(
            message_id=row.get("message_id", "") or "",
            internal_id=int(row["id"]) if row.get("id") else 0,
            subject=row.get("subject", "") or "",
            sender=row.get("sender", "") or "",
            date_received=row.get("date_received", "") or "",
            is_read=bool(row.get("is_read", False)),
            is_flagged=bool(row.get("is_flagged", False)),
            thread_id=row.get("thread_id"),
            mailbox=mailbox,
        )
