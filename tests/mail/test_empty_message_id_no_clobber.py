"""空 Message-ID 不得静默删除老邮件 (2026-08-11 丢邮件事故的第三个 bug)。

## 洞

``email_metadata.message_id`` 是 ``TEXT UNIQUE``, 两条写入路径 (``_save_email_v3`` /
``save_emails_batch``) 都是 ``INSERT OR REPLACE``。davmail 侧 ``_normalize_message_id``
把缺失的 Message-ID 归一成**空字符串**而非 None:

1. 空串在 merge guard 的 ``if message_id:`` 门前 falsy → 跳过跨 backend 合并保护;
2. 落到 ``INSERT OR REPLACE`` 撞 ``UNIQUE('')`` → SQLite **删掉冲突的老行**再插新行;
3. **不抛异常**, ``save_email`` 返回 ``True``。

⇒ 丢的是**老邮件**整行 (连 ``notion_page_id`` 一起 → Notion 端孤儿页), 不是新邮件
写失败。所以「把 save_email 返回值纳入游标判定」这类修法**拦不住它**, 必须在
持久化边界把 '' 归一成 NULL (NULL 在 SQLite UNIQUE 下可共存)。

🔴 活库实测过: ``message_id=''`` 恒只剩 1 行 —— 每来一封无 Message-ID 的邮件就
删掉前一封, 所以「库里只有 1 行」**不代表只影响过 1 封**, 历史损失查不出来。
"""
from __future__ import annotations

from pathlib import Path

from src.mail.sync_store import SyncStore


def _email(internal_id: int, message_id, subject: str, **extra) -> dict:
    payload = {
        "internal_id": internal_id,
        "message_id": message_id,
        "subject": subject,
        "sender": "someone@example.test",
        "date_received": "2026-08-11T10:00:00+00:00",
        "mailbox": "收件箱",
        "sync_status": "pending",
        "backend_origin": "davmail",
    }
    payload.update(extra)
    return payload


def test_two_emails_without_message_id_both_survive(tmp_path: Path):
    """两封无 Message-ID 的邮件必须共存, 第一封的同步状态不得被抹掉。

    改动前必红: 第一封整行被 INSERT OR REPLACE 删除。
    """
    store = SyncStore(str(tmp_path / "t.db"))

    # 第一封: 已同步到 Notion (davmail 归一出的空串)
    assert store.save_email(
        _email(
            1_000_000_001, "", "第一封-已同步",
            sync_status="synced", notion_page_id="notion-page-AAA",
        )
    )
    # 第二封: 同样没有 Message-ID
    assert store.save_email(_email(1_000_000_002, "", "第二封"))

    first = store.get(1_000_000_001)
    second = store.get(1_000_000_002)

    assert first is not None, (
        "第一封被静默删除 —— INSERT OR REPLACE 撞 UNIQUE('') 删掉了老行"
    )
    assert second is not None, "第二封没入库"
    # 老行的同步状态必须原封不动 (被删重插会丢 notion_page_id → Notion 孤儿页)
    assert first["notion_page_id"] == "notion-page-AAA"
    assert first["sync_status"] == "synced"
    # 空串必须落成 NULL, 不能是 ''
    assert first["message_id"] is None
    assert second["message_id"] is None


def test_batch_path_also_normalizes(tmp_path: Path):
    """save_emails_batch 是第二条 INSERT OR REPLACE 路径, 且**没有** merge guard。"""
    store = SyncStore(str(tmp_path / "t.db"))

    saved = store.save_emails_batch([
        _email(1_000_000_011, "", "batch-第一封"),
        _email(1_000_000_012, "", "batch-第二封"),
        _email(1_000_000_013, None, "batch-第三封-None"),
    ])
    assert saved == 3

    rows = [store.get(i) for i in (1_000_000_011, 1_000_000_012, 1_000_000_013)]
    assert all(r is not None for r in rows), "batch 路径下无 Message-ID 的邮件互相覆盖"
    assert all(r["message_id"] is None for r in rows)


def test_whitespace_only_message_id_normalized(tmp_path: Path):
    """纯空白也要归一 —— 折行 header 清洗后可能只剩空格。"""
    store = SyncStore(str(tmp_path / "t.db"))

    assert store.save_email(_email(1_000_000_021, "   ", "空白-第一封"))
    assert store.save_email(_email(1_000_000_022, "\t\n", "空白-第二封"))

    assert store.get(1_000_000_021) is not None
    assert store.get(1_000_000_022) is not None
    assert store.get(1_000_000_021)["message_id"] is None


def test_real_message_id_still_merges(tmp_path: Path):
    """归一不能误伤正常路径: 同一个真 Message-ID 仍走 merge guard 复用老行。"""
    store = SyncStore(str(tmp_path / "t.db"))
    mid = "real-msgid-001@example.test"

    assert store.save_email(
        _email(
            1_000_000_031, mid, "原始",
            sync_status="synced", notion_page_id="notion-page-BBB",
        )
    )
    # 同 message_id、不同 internal_id (davmail↔davmail 重复抓取, 如 inclusive 边界重叠)
    assert store.save_email(
        _email(1_000_000_032, mid, "重复抓取", imap_uid=999)
    )

    old = store.get(1_000_000_031)
    assert old is not None, "merge guard 失效: 老行被删"
    assert old["notion_page_id"] == "notion-page-BBB", "同步状态被覆盖"
    assert old["imap_uid"] == 999, "merge 应更新漂移的 imap_uid"
    assert store.get(1_000_000_032) is None, "不该建重复行"


def test_update_after_fetch_normalizes_empty(tmp_path: Path):
    """🔴 第三条写路径: update_after_fetch (davmail 主链路 fetch MIME 后回填)。

    codex round-2 BLOCKER: 前两条路径收口后, 这条仍会把 '' 写回库 ——
    v51 迁移只清一次存量, 之后写入的空串没人管; 第二封撞 UNIQUE 后
    走冲突分支 → FAILED → 重试 → 死信。
    """
    store = SyncStore(str(tmp_path / "t.db"))

    # 两封 pending 行 (message_id 尚未回填, 正是 v3 pending 的形态)
    for iid in (1_000_000_051, 1_000_000_052):
        assert store.save_email(_email(iid, None, f"pending-{iid}"))

    # fetch 回来发现都没有 Message-ID → davmail _normalize_message_id 给出 ''
    r1 = store.update_after_fetch(1_000_000_051, {"message_id": "", "subject": "A"})
    r2 = store.update_after_fetch(1_000_000_052, {"message_id": "", "subject": "B"})

    assert store.get(1_000_000_051) is not None
    assert store.get(1_000_000_052) is not None
    assert store.get(1_000_000_051)["message_id"] is None, (
        "update_after_fetch 把空串写回了库 —— 绕过了 _storage_message_id"
    )
    assert store.get(1_000_000_052)["message_id"] is None
    # 两封都不该失败 (失败会进重试→死信)
    assert "FAILED" not in str(r1), r1
    assert "FAILED" not in str(r2), r2
    assert store.get(1_000_000_051)["subject"] == "A"
    assert store.get(1_000_000_052)["subject"] == "B"


def test_migration_clears_legacy_empty_string(tmp_path: Path):
    """v51 迁移: 存量 message_id='' 行改成 NULL, 且幂等。"""
    import sqlite3

    db = tmp_path / "legacy.db"
    store = SyncStore(str(db))
    store.save_email(_email(1_000_000_041, "legit@example.test", "正常"))

    # 绕过归一, 手工塞一行空串模拟存量 (改动前的写入形态)
    conn = sqlite3.connect(str(db))
    conn.execute(
        "UPDATE email_metadata SET message_id = '' WHERE internal_id = ?",
        (1_000_000_041,),
    )
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value, updated_at) "
        "VALUES ('db_version', '50', 0)"
    )
    conn.commit()
    conn.close()

    # 重开 → 触发 v51 迁移
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    assert conn.execute(
        "SELECT COUNT(*) FROM email_metadata WHERE message_id = ''"
    ).fetchone()[0] == 0
    assert conn.execute(
        "SELECT COUNT(*) FROM email_metadata WHERE message_id IS NULL"
    ).fetchone()[0] == 1
    conn.close()

    # 幂等: 再开一次不炸
    SyncStore(str(db))
