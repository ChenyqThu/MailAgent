"""v75 2 字 CJK bigram 并行 FTS5 索引（与 trigram LIKE 等价 + 触发器清理 + 后台回填）。"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from src.mail.cjk2_backfill_worker import backfill_once
from src.mail.sync_store import SyncStore
from src.repository.attachment_store import AttachmentStore
from src.repository.cjk_bigram import extract_cjk_bigrams, is_pure_cjk_bigram
from src.repository.email_repository import AttachmentPayload, BodyPayload, EmailRepository


def test_extract_cjk_bigrams_and_purity() -> None:
    assert extract_cjk_bigrams("") == ""
    assert extract_cjk_bigrams(None) == ""
    assert extract_cjk_bigrams("合") == ""
    assert extract_cjk_bigrams("abc") == ""
    assert extract_cjk_bigrams("合同评审合同") == "合同 同评 评审 审合"
    assert extract_cjk_bigrams("3月合同/周报abc立项") == "月合 合同 周报 立项"
    assert extract_cjk_bigrams("3月/合同/周报abc立项") == "合同 周报 立项"
    assert is_pure_cjk_bigram("合同") is True
    assert is_pure_cjk_bigram("3月") is False
    assert is_pure_cjk_bigram("あ・") is False
    assert is_pure_cjk_bigram("合同书") is False


def _seed_corpus(db: Path, store: AttachmentStore) -> EmailRepository:
    repo = EmailRepository(db_path=str(db), attachment_store=store, trigram_enabled=True)
    conn = sqlite3.connect(str(db))
    now = time.time()
    emails = [
        (1, "本周合同评审安排", "zhang@example.com", "2026-06-01T10:00:00+08:00"),
        (2, "研发进展同步", "合同专员 <legal@example.com>", "2026-06-02T10:00:00+08:00"),
        (3, "例会纪要", "alice@example.com", "2026-06-03T10:00:00+08:00"),
        (4, "3月项目立项说明", "bob@example.com", "2026-06-04T10:00:00+08:00"),
    ]
    for iid, subj, sender, dt in emails:
        conn.execute(
            """INSERT INTO email_metadata
               (internal_id, sync_status, mailbox, subject, sender, date_received, created_at, updated_at)
               VALUES (?, 'synced', '收件箱', ?, ?, ?, ?, ?)""",
            (iid, subj, sender, dt, now, now),
        )
    conn.commit()
    conn.close()

    m1 = repo.commit_email_with_body(
        1,
        BodyPayload(html="", markdown="周报材料请在周三前提交。", body_format="html"),
        [AttachmentPayload(filename="采购合同A.pdf", content=b"%PDF", content_type="application/pdf")],
    )
    repo.commit_attachment_text(m1["采购合同A.pdf"], text="甲乙双方签署技术服务条款。", extractor="pypdf")

    m2 = repo.commit_email_with_body(
        2,
        BodyPayload(html="", markdown="请确认本季度周报与合同细节。", body_format="html"),
        [AttachmentPayload(filename="specs.pdf", content=b"%PDF", content_type="application/pdf")],
    )
    repo.commit_attachment_text(m2["specs.pdf"], text="附件中包含正式合同文本与立项预算。", extractor="pypdf")

    repo.commit_email_with_body(
        3,
        BodyPayload(html="", markdown="这里正文中提到合同审批已通过。", body_format="html"),
        [],
    )
    repo.commit_email_with_body(
        4,
        BodyPayload(html="", markdown="3月立项启动会议记录。", body_format="html"),
        [],
    )
    return repo


def test_cjk2_matches_like_fallback_exact_order_and_handles_mixed(tmp_path: Path) -> None:
    db = tmp_path / "sync_store.db"
    store = AttachmentStore(str(tmp_path / "att"))
    SyncStore(str(db))
    repo = _seed_corpus(db, store)

    # 1) cjk2 就绪路径（新库空库 init 置 '1'，写入走增量双写）
    for q in ("合同", "周报", "立项"):
        cjk2_body = repo.search_email_bodies_with_meta(q, limit=20)
        cjk2_att = repo.search_attachment_texts(q, limit=20)

        # 切到 LIKE 兜底对比逐条一致
        conn = sqlite3.connect(str(db))
        conn.execute("UPDATE sync_state SET value = '0' WHERE key = 'cjk2_backfill_done'")
        conn.commit()
        conn.close()

        like_body = repo.search_email_bodies_with_meta(q, limit=20)
        like_att = repo.search_attachment_texts(q, limit=20)

        assert [h.internal_id for h in cjk2_body.hits] == [h.internal_id for h in like_body.hits]
        assert [h.attachment_id for h in cjk2_att] == [h.attachment_id for h in like_att]

        conn = sqlite3.connect(str(db))
        conn.execute("UPDATE sync_state SET value = '1' WHERE key = 'cjk2_backfill_done'")
        conn.commit()
        conn.close()

    # 2) 混合 2 字符（数字+汉字）不进 cjk2，无缝走 LIKE 全召回
    mixed = repo.search_email_bodies_with_meta("3月", limit=20)
    assert [h.internal_id for h in mixed.hits] == [4]


def test_v75_migration_backfill_and_delete_cleanup(tmp_path: Path) -> None:
    db = tmp_path / "upgrade.db"
    store = AttachmentStore(str(tmp_path / "att"))
    SyncStore(str(db))
    repo = _seed_corpus(db, store)

    # 模拟老库带存量数据从 v74 升级上来：清掉 cjk2 行并把版本拨回 74
    conn = sqlite3.connect(str(db))
    conn.execute("DELETE FROM sync_state WHERE key LIKE 'cjk2_%'")
    conn.execute("DELETE FROM email_body_fts_cjk2")
    conn.execute("DELETE FROM email_attachment_fts_cjk2")
    conn.execute("UPDATE sync_state SET value = '74' WHERE key = 'db_version'")
    conn.commit()
    conn.close()

    reopened = SyncStore(str(db))
    assert reopened.get_state("db_version") == str(SyncStore.DB_VERSION)
    assert reopened.get_state("cjk2_backfill_done") == "0"

    # 回填前走 LIKE 照常有结果
    pre = repo.search_email_bodies_with_meta("合同", limit=10)
    assert len(pre.hits) >= 3

    # 后台分批回填（幂等）
    stats = backfill_once(str(db), batch_size=2, yield_sec=0)
    assert stats["done"] is True and stats["bodies"] == 4 and stats["attachments"] == 2
    assert reopened.get_state("cjk2_backfill_done") == "1"
    # 再跑一遍是 no-op
    assert backfill_once(str(db), batch_size=2, yield_sec=0) == {"done": True, "bodies": 0, "attachments": 0}

    # 验证 MATCH 直接命中，且 delete_email_full 触发器自动清两张 cjk2 虚表
    post = repo.search_email_bodies_with_meta("合同", limit=10)
    assert {h.internal_id for h in post.hits} == {h.internal_id for h in pre.hits}
    repo.delete_email_full(1)
    conn = sqlite3.connect(str(db))
    assert conn.execute("SELECT rowid FROM email_body_fts_cjk2 WHERE rowid = 1").fetchone() is None
    assert conn.execute(
        "SELECT COUNT(*) FROM email_attachment_fts_cjk2 "
        "WHERE email_attachment_fts_cjk2 MATCH '\"采购\"'"
    ).fetchone()[0] == 0
    conn.close()
