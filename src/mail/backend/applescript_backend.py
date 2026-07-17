"""AppleScriptBackend — IMailBackend 实现, FALLBACK 模式.

Wraps 现有 `AppleScriptArm` (机械臂) + `SQLiteRadar` (雷达) + `scripts/create_reply_draft.sh`.
现有类零改动, 本类按 E1 收口后的 Protocol (真实 arm/radar 面, legacy dict 契约)
逐方法委托给内部 arm / radar 对象.

`backend_origin = "applescript"`: 新邮件抓进来时 SyncStore 写 backend_origin='applescript',
internal_id = Mail.app SQLite ROWID (< 1_000_000_000).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from loguru import logger

from src.mail.applescript_arm import AppleScriptArm
from src.mail.backend.base import IMailBackend
from src.mail.backend.types import (
    BackendOrigin,
    DraftAppendResult,
    DraftRequest,
    SendResult,
)
from src.mail.sqlite_radar import SQLiteRadar

if TYPE_CHECKING:
    from src.config import Config


# create_reply_draft.sh 的定位 —— dev 与打包 .app 布局不同, 单点 parents[N] 会算错 (Issue #41):
#   - dev:   <repo>/src/mail/backend/applescript_backend.py → parents[3] = <repo>,
#            脚本在 <repo>/scripts/create_reply_draft.sh。
#   - 打包:  __file__ 落在 <.app>/Contents/Resources/python/lib/python3.11/site-packages/
#            src/mail/backend/…, parents[3] 只到 site-packages/ (无 scripts/); 脚本经
#            electron-builder extraResources 落在 <.app>/Contents/Resources/scripts/
#            (见 frontend/electron-builder.yml), 与内嵌 CPython (sys.prefix =
#            …/Contents/Resources/python) 同级 —— 故 sys.prefix 的父目录即 Resources。
# 按优先级探测多候选, 取首个存在者。
def _draft_script_candidates() -> list[Path]:
    """create_reply_draft.sh 候选路径, 按优先级降序。"""
    candidates: list[Path] = []
    # 1) 显式 env 覆盖 (ops 逃生口, 镜像 MAILAGENT_DATA_ROOT 路径纪律; 默认不设)。
    env_root = os.environ.get("MAILAGENT_RESOURCES_ROOT")
    if env_root:
        candidates.append(Path(env_root) / "scripts" / "create_reply_draft.sh")
    # 2) 打包 .app: 内嵌 CPython 的 Resources 同级 scripts/ (sys.prefix 父目录);
    #    dev venv (repo/venv) 恰好也命中 repo/scripts。
    candidates.append(Path(sys.prefix).parent / "scripts" / "create_reply_draft.sh")
    # 3) dev 仓库根兜底 (venv 不在 repo/venv 时): <repo>/scripts/ (原行为)。
    candidates.append(Path(__file__).resolve().parents[3] / "scripts" / "create_reply_draft.sh")
    return candidates


def _resolve_draft_script() -> Path:
    """取首个存在的候选; 都不存在时返回最后一个 (dev 布局) 供上层报清晰错误。"""
    candidates = _draft_script_candidates()
    for candidate in candidates:
        if candidate.exists():
            return candidate
    logger.warning(
        "[applescript-backend] create_reply_draft.sh 未在任何候选路径找到: "
        + " | ".join(str(c) for c in candidates)
    )
    return candidates[-1]


_DRAFT_SH = _resolve_draft_script()


class AppleScriptBackend(IMailBackend):
    """AppleScript + Mail.app 后端 (现有 v3 路径)."""

    backend_origin: BackendOrigin = "applescript"

    def __init__(self, cfg: "Config", *, sync_store=None):
        self.cfg = cfg
        # sync_store 接受但不使用 — 接口统一 (DavMailBackend 需要), 这里只是签名对齐
        self.sync_store = sync_store
        mailboxes = [m.strip() for m in cfg.sync_mailboxes.split(",") if m.strip()]
        # 内部委托对象 (真 arm / radar, 非影子 alias — DavMailBackend 自身实现同名方法)
        self.arm = AppleScriptArm(
            account_name=cfg.mail_account_name,
            inbox_name=cfg.mail_inbox_name,
        )
        self.radar = SQLiteRadar(
            mailboxes=mailboxes,
            account_url_prefix=cfg.mail_account_url_prefix,
        )

    # =========================================================================
    # 启动 probe
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

    # =========================================================================
    # 正向 sync — 雷达面 (委托 SQLiteRadar)
    # =========================================================================

    def is_available(self) -> bool:
        return self.radar.is_available()

    def get_current_max_row_id(self) -> int:
        return self.radar.get_current_max_row_id()

    def check_for_changes(self, last_max_row_id: int) -> tuple[bool, int, int]:
        return self.radar.check_for_changes(last_max_row_id)

    def get_new_emails(self, since_row_id: int) -> list[dict]:
        return self.radar.get_new_emails(since_row_id=since_row_id)

    def set_last_max_row_id(self, row_id: int) -> None:
        self.radar.set_last_max_row_id(row_id)

    def get_last_max_row_id(self) -> int:
        return self.radar.get_last_max_row_id()

    # =========================================================================
    # 正向 sync — 邮件抓取面 (委托 AppleScriptArm)
    # =========================================================================

    def fetch_email_content_by_id(
        self, internal_id: int, mailbox: Optional[str] = None, *, update_uid: bool = True
    ) -> Optional[dict]:
        # update_uid: applescript 路径无 imap_uid/uidvalidity 元数据回写, 参数仅为满足
        # IMailBackend 契约 (davmail dry-run 懒自愈用), 此处忽略。
        return self.arm.fetch_email_content_by_id(internal_id, mailbox=mailbox)

    def fetch_email_by_message_id(
        self, message_id: str, mailbox: Optional[str] = None
    ) -> Optional[dict]:
        return self.arm.fetch_email_by_message_id(message_id, mailbox=mailbox)

    def fetch_emails_by_position(
        self, count: int, mailbox: Optional[str] = None
    ) -> list[dict]:
        return self.arm.fetch_emails_by_position(count=count, mailbox=mailbox)

    # =========================================================================
    # 反向 sync — flag / read (委托 AppleScriptArm)
    # =========================================================================

    def mark_as_read_by_id(
        self, internal_id: int, read: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        return self.arm.mark_as_read_by_id(internal_id, read=read, mailbox=mailbox)

    def set_flag_by_id(
        self, internal_id: int, flagged: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        return self.arm.set_flag_by_id(internal_id, flagged=flagged, mailbox=mailbox)

    def mark_as_read(
        self, message_id: str, read: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        return self.arm.mark_as_read(message_id, read=read, mailbox=mailbox)

    def set_flag(
        self, message_id: str, flagged: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        return self.arm.set_flag(message_id, flagged=flagged, mailbox=mailbox)

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

        forward 模式 sh 不支持 (create_reply_draft.sh 只有 reply-all/reply/new) — 直接报错,
        emergency fallback 只覆盖 reply*; 转发请用 davmail backend.
        """
        if draft.mode == "forward":
            return DraftAppendResult(
                success=False,
                drafts_folder="Drafts",
                error="forward draft 仅 davmail backend 支持 (create_reply_draft.sh 无 forward 模式)",
            )

        if not _DRAFT_SH.exists():
            attempted = " | ".join(str(c) for c in _draft_script_candidates())
            return DraftAppendResult(
                success=False,
                drafts_folder="Drafts",
                error=f"create_reply_draft.sh 未找到 (已尝试: {attempted})",
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

    def reconcile_drafts(self) -> tuple[list[dict], list[int]]:
        """davmail-only 能力 — AppleScript 模式恒 noop (inventory §3 ②)."""
        return [], []

    # =========================================================================
    # 真实发送 — SMTP (fallback 也走 DavMail SMTP, cfg 端口指向 DavMail JVM)
    # =========================================================================

    def send_email(self, draft: DraftRequest) -> SendResult:
        """fallback 发送: 走 DavMail SMTP (复用 sender). 失败返回 success=False 不抛.

        即使 MAILAGENT_BACKEND=applescript, cfg 的 SMTP 端口仍指向 DavMail JVM —
        sh GUI send 脆弱且 create_reply_draft.sh 无 send 能力, 故 send 统一走 SMTP.
        """
        from src.mail.backend.sender import build_outgoing_mime, smtp_send

        try:
            mime_bytes = build_outgoing_mime(self.cfg, draft)
        except Exception as e:
            logger.error(f"[applescript-backend] send_email MIME build failed: {e}")
            return SendResult(success=False, error=f"MIME build failed: {e}")
        return smtp_send(
            self.cfg, mime_bytes, method="smtp_applescript",
            archive_sent=getattr(self.cfg, "davmail_archive_sent", False),
        )
