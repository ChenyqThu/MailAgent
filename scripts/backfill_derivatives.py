#!/usr/bin/env python3
"""v4 衍生附件补救脚本：扫 email_attachment 找漏 derived 的 Office 附件，单独补齐。

为什么需要这个：
    - backfill_email_body.py 的 _convert_office_attachments 失败时静默返回空 list
      （convert_to_csv / convert_to_pdf 内部 except → []，外层不抛异常）
    - 不动现有 attachment row（避免影响 notion_file_id 回写）
    - 只追加 derived row，对已上传到 Notion 的页面无副作用

幂等性：
    - 候选条件 `NOT EXISTS (derived child)` 保证已补过的不重补
    - 失败的不写 SQLite，下次扫还能再试

Usage:
    # dry-run 看候选清单
    python scripts/backfill_derivatives.py --dry-run

    # 限单封
    python scripts/backfill_derivatives.py --internal-id 53677

    # 全量补
    python scripts/backfill_derivatives.py

注意:
    - 补完 derived row 后，已经在 Notion 的页面**不会自动出现 CSV/PDF 附件**；
      要更新 Notion 上的页面需要再跑 scripts/resync_notion.py --replace-existing
    - 灰度切到 NOTION_READ_FROM_SQLITE=true 后，新建邮件页会直接带上 derived
"""

import argparse
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from typing import List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from loguru import logger

from src.config import config as cfg
from src.converter.office_converter import convert_office_attachment, is_convertible
from src.repository import AttachmentStore, EmailRepository


def _find_candidates(
    db_path: str, internal_id_filter: int | None = None
) -> List[Tuple[int, int, str, str]]:
    """找 is_convertible 且无 derived child 的附件。

    Returns:
        list of (att_id, internal_id, filename, local_path)
    """
    conn = sqlite3.connect(db_path)
    try:
        sql = """
            SELECT a.id, a.internal_id, a.filename, a.local_path
              FROM email_attachment a
             WHERE a.derived_from IS NULL
               AND a.local_path IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM email_attachment c
                  WHERE c.derived_from = a.id
               )
        """
        params: list = []
        if internal_id_filter is not None:
            sql += " AND a.internal_id = ?"
            params.append(internal_id_filter)
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    # is_convertible 在 Python 端过滤（SQL 不便做扩展名判断）
    return [
        (r[0], r[1], r[2], r[3])
        for r in rows
        if is_convertible(r[2])
    ]


def _insert_derived(
    repo: EmailRepository,
    parent_att_id: int,
    parent_internal_id: int,
    derived_path: Path,
    derived_format: str,
) -> int:
    """落盘 derived 文件 + INSERT email_attachment 行。返回新 row id。"""
    content = derived_path.read_bytes()
    _target, used_filename = repo.attachment_store.save(
        parent_internal_id, derived_path.name, content,
    )
    sha = AttachmentStore.sha256(content)
    local_path = repo.attachment_store.relative_path(parent_internal_id, used_filename)

    content_type = "application/pdf" if derived_format == "pdf" else "text/csv"
    conn = sqlite3.connect(str(repo.db_path))
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        cur = conn.execute(
            """INSERT INTO email_attachment
               (internal_id, content_id, filename, content_type, size_bytes,
                is_inline, local_path, sha256, derived_from, derived_format,
                created_at, schema_version)
               VALUES (?, NULL, ?, ?, ?, 0, ?, ?, ?, ?, ?, 1)""",
            (
                parent_internal_id, used_filename, content_type, len(content),
                local_path, sha, parent_att_id, derived_format, time.time(),
            ),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def _resolve_local_path(local_path: str) -> Path:
    """email_attachment.local_path 存的可能是相对路径，按项目根解析。"""
    p = Path(local_path)
    return p if p.is_absolute() else Path.cwd() / p


def main():
    parser = argparse.ArgumentParser(
        description="Backfill Office derivatives (PDF/CSV) into SQLite",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--internal-id", type=int, help="只补这一封")
    parser.add_argument("--dry-run", action="store_true", help="只列候选不实际转换")
    parser.add_argument(
        "--max-failures", type=int, default=10,
        help="连续失败 N 次自动停（默认 10）"
    )
    parser.add_argument(
        "--progress-every", type=int, default=20,
        help="每 N 个打印速率（默认 20）"
    )
    args = parser.parse_args()

    candidates = _find_candidates(cfg.sync_store_db_path, args.internal_id)
    print(f"[plan] {len(candidates)} attachments needing derivatives", flush=True)

    if not candidates:
        print("[done] nothing to do", flush=True)
        return

    if args.dry_run:
        for i, (att_id, iid, fn, _lp) in enumerate(candidates[:30], 1):
            print(f"  [{i}] att_id={att_id} internal_id={iid} filename={fn!r}", flush=True)
        if len(candidates) > 30:
            print(f"  ... ({len(candidates) - 30} more)", flush=True)
        return

    repo = EmailRepository(db_path=cfg.sync_store_db_path)
    succeeded = 0
    failed = 0
    consecutive_failures = 0
    t_start = time.time()

    for idx, (att_id, iid, fn, local_path) in enumerate(candidates, 1):
        try:
            src_p = _resolve_local_path(local_path)
            if not src_p.is_file():
                raise FileNotFoundError(f"source file missing: {src_p}")
            src_bytes = src_p.read_bytes()

            with tempfile.TemporaryDirectory(prefix=f"derive-{iid}-") as tmp:
                tmp_dir = Path(tmp)
                tmp_src = tmp_dir / fn
                tmp_src.write_bytes(src_bytes)

                converted = convert_office_attachment(str(tmp_src), str(tmp_dir))
                if not converted:
                    raise RuntimeError("conversion returned empty list")

                for c_path in converted:
                    c = Path(c_path)
                    ext = c.suffix.lower()
                    derived_format = "pdf" if ext == ".pdf" else "csv"
                    new_id = _insert_derived(repo, att_id, iid, c, derived_format)
                    logger.info(
                        f"[att_id={att_id}→{new_id}] {fn} → {c.name} ({derived_format})"
                    )
            succeeded += 1
            consecutive_failures = 0
        except Exception as e:
            logger.warning(f"[att_id={att_id}] failed on {fn!r} (internal_id={iid}): {e}")
            failed += 1
            consecutive_failures += 1
            if consecutive_failures >= args.max_failures:
                print(
                    f"[abort] {consecutive_failures} consecutive failures, stop",
                    flush=True,
                )
                break

        if idx % args.progress_every == 0 or idx == len(candidates):
            elapsed = time.time() - t_start
            rate = idx / elapsed if elapsed > 0 else 0.0
            remaining = len(candidates) - idx
            eta = remaining / rate if rate > 0 else 0
            print(
                f"[progress] {idx}/{len(candidates)} "
                f"success={succeeded} failed={failed} "
                f"rate={rate:.2f}/s eta={eta / 60:.1f}min",
                flush=True,
            )

    elapsed = time.time() - t_start
    print(
        f"\n[summary] total={len(candidates)} success={succeeded} "
        f"failed={failed} elapsed={elapsed / 60:.1f}min",
        flush=True,
    )


if __name__ == "__main__":
    main()
