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
from src.kos.producer import (
    LABEL_MISSING,
    LABEL_UNKNOWN,
    build_kos_page_payload,
    make_bulk_kos_client,
    passes_priority_gate,
    priority_label_state,
    resolve_thread_refs,
)
from src.repository import EmailRepository


class KOSBulkIngester:
    """存量邮件 → KOS mailagent-emails source 批量导入器。"""

    def __init__(
        self,
        db_path: str = "data/sync_store.db",
        client: Optional[KOSClient] = None,
        rate_qps: float = 2.0,
        priority_floor: str = "low",
        require_labeled: bool = False,
    ):
        self.db_path = db_path
        self.repo = EmailRepository(db_path=db_path)
        self.client = client or make_bulk_kos_client()
        self._sleep = 1.0 / rate_qps if rate_qps > 0 else 0.0
        # 与增量 producer 同款过滤：priority < floor 的邮件不入 KOS (排除噪音)。
        # 默认 "low" = 不过滤 (向后兼容原全量行为); "normal" = 排除低优先。
        self.priority_floor = priority_floor
        # issue #49: 「AI 从未标注」是独立于优先级枚举的第三态, 不该隐式并入
        # normal 被 floor 放行。默认 False = 现状行为不变。
        self.require_labeled = require_labeled
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
        # Thread 链接反查 (parent=In-Reply-To, root=thread_id) — 与增量 hook 共用
        # 同一 SQLite 反查 → 同一封邮件两路径 payload 一致。
        refs = resolve_thread_refs(self.db_path, internal_id)
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
            thread_parent=refs.get("parent"),
            thread_root=refs.get("root"),
        )

    # 瞬时错误 → 退避重试: 429 限流 + 网络/DNS 抖动 (公司内网 DNS 偶发解析失败,
    # 实测 2026-05-26 抖了 ~3min)。其余 (404 / 协议错 / 鉴权) 不重试直接 raise。
    _RETRY_CODES = {"E_KOS_RATE_LIMIT", "E_KOS_NETWORK", "E_KOS_TOKEN_NETWORK"}

    def _put_with_retry(self, slug: str, content: str, max_retries: int = 4) -> dict:
        """put_page + 瞬时错误退避重试 (429 / 网络 / DNS)。退避 2/4/8/16s。"""
        attempt = 0
        while True:
            try:
                return self.client.put_page(slug, content)
            except KOSError as e:
                if e.code in self._RETRY_CODES and attempt < max_retries:
                    attempt += 1
                    wait = 2 ** attempt
                    logger.warning(
                        f"[bulk] {e.code} on {slug}, backoff {wait}s (attempt {attempt})"
                    )
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
        # priority_floor 启用时，limit 作用在「实际 ingest 数」而非「候选数」：否则 SQL 先
        # 按 internal_id DESC 截断 limit 个候选、再按 priority 跳过，会让带 --limit 的分批
        # 永远卡在最近一批低优先邮件上（codex review HIGH）。故有 floor 时取全部候选、由循环
        # 累计 pushed 到 limit；无 floor 时 SQL LIMIT 截断（候选=处理，等价）。
        floor_active = bool(self.priority_floor and self.priority_floor != "low")
        # require_labeled 与 floor 独立: 要「只入已标注」时, floor='low' 不该把
        # 未标注邮件放行 —— 否则 gate 形同虚设 (issue #49)。
        gate_active = floor_active or self.require_labeled
        candidates = self._candidates(None if gate_active else limit, retry_failed, require_body)
        stats = {
            "total": len(candidates),
            "pushed": 0,
            "failed": 0,
            "skipped_no_meta": 0,
            "skipped_low_priority": 0,
            "skipped_unlabeled": 0,
            "skipped_invalid_priority": 0,
        }
        logger.info(
            f"[bulk] start total={stats['total']} dry_run={dry_run} "
            f"verify_canary={verify_canary} priority_floor={self.priority_floor!r} "
            f"require_labeled={self.require_labeled} "
            f"rate={1.0 / self._sleep if self._sleep else 'unlimited'}qps"
        )

        for i, iid in enumerate(candidates, 1):
            # floor 启用 + 带 limit：累计到 limit 个实际 ingest（pushed，含 dry-run）就停 ——
            # priority 跳过的不计入 limit，故分批不会被低优先批卡死（codex review HIGH）。
            if gate_active and limit and stats["pushed"] >= limit:
                break
            # 排除低优先噪音 (与增量 producer 共用 passes_priority_gate, 语义单源)。
            # floor='low' + require_labeled=False 时不过滤 —— 未分类/无 priority
            # 视为 normal 保留 (历史语义); require_labeled=True 时未标注直接挡掉。
            if gate_active:
                pri = self._get_labels(iid).get("priority")
                if not passes_priority_gate(pri, self.priority_floor, self.require_labeled):
                    # 三种跳过原因分开计数 —— 合成一个数字正是 issue #49 的病根。
                    state = priority_label_state(pri)
                    if self.require_labeled and state == LABEL_MISSING:
                        key = "skipped_unlabeled"
                    elif self.require_labeled and state == LABEL_UNKNOWN:
                        key = "skipped_invalid_priority"
                    else:
                        key = "skipped_low_priority"
                    stats[key] += 1
                    continue
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
    ap.add_argument(
        "--priority-floor",
        default="low",
        help="排除低于此优先级的邮件 (low/normal/important/urgent/critical; "
        "默认 low=不过滤; normal=排除低优先噪音, 未分类视为 normal 保留)",
    )
    ap.add_argument(
        "--require-labeled",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="只入 AI **有效**标注过优先级的邮件, 未标注/野值直接跳过 (issue #49)。"
        "不传则跟随 KOS_REQUIRE_LABELED env; env 开着时可用 --no-require-labeled "
        "临时关掉 (store_true 做不到这个方向的覆盖, codex review LOW-3)",
    )
    args = ap.parse_args()

    # CLI 显式传 --require-labeled / --no-require-labeled 优先; 都不传 (None)
    # 才跟随 env (config 缺省 False)。
    require_labeled = args.require_labeled
    if require_labeled is None:
        try:
            from src.config import settings

            require_labeled = bool(getattr(settings, "kos_require_labeled", False))
        except Exception:
            require_labeled = False

    ing = KOSBulkIngester(
        db_path=args.db_path,
        rate_qps=args.rate,
        priority_floor=args.priority_floor,
        require_labeled=require_labeled,
    )
    result = ing.run(
        limit=args.limit,
        retry_failed=args.retry_failed,
        require_body=args.require_body,
        dry_run=args.dry_run,
        verify_canary=not args.no_canary,
    )
    print(result)
