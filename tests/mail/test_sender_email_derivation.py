"""v58 —— `email_metadata.sender_email` 派生列 (task 08-14 WP-5 阶段 1)。

盯三层:
① 派生器 `derive_sender_email` 本身 (完整 From 头 / 裸地址 / 畸形值);
② 三条**写入边界**都算了这一列 (_save_email_v3 / save_emails_batch /
   update_after_fetch) —— 少一条就是一条永久产生 NULL 的路径;
③ v58 迁移: 老库补列 + 回填 + 索引; 幂等 (重入结果一致); 派生失败的行留 NULL。

🔴 降级模拟不用 DROP COLUMN (仓内教训「迁移测试禁 DROP COLUMN 一律重建」):
email_metadata 的 v57 形状 = 从当前表逐列剔掉 sender_email 重建。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.email_address import derive_sender_email, normalize_email
from src.mail.sync_store import SyncStore, UpdateAfterFetchResult


# ==================== ① 派生器 ====================

@pytest.mark.parametrize(
    "raw, expected",
    [
        # 活库 68% 的形状: AppleScript 路径写整个 From 头。
        ("Gary W <gary.w@tp-link.com>", "gary.w@tp-link.com"),
        ('"徐静雅 (Jira)" <itjsm.gm@tp-link.com>', "itjsm.gm@tp-link.com"),
        ("Atlassian <noreply+65ff4a9@id.atlassian.com>",
         "noreply+65ff4a9@id.atlassian.com"),
        ("<a@x.com>", "a@x.com"),
        # 其余 32%: davmail 路径写裸地址 (显示名另存 sender_name)。
        ("gary.w@tp-link.com", "gary.w@tp-link.com"),
        # 大小写 / 前后空白归一。
        ("  Gary W <GARY.W@TP-LINK.COM>  ", "gary.w@tp-link.com"),
        ("GARY.W@TP-LINK.COM", "gary.w@tp-link.com"),
        # 🔴 未加引号的逗号: getaddresses 切成 [('', 'Doe'), ('John', 'j@x.com')]
        # ⇒ 必须取**第一个合法项**, 取"第一项"会拿到 'Doe' → None。
        ("Doe, John <j@x.com>", "j@x.com"),
        ('"Doe, John" <j@x.com>', "j@x.com"),
        # 多地址取第一个合法项。
        ("a@x.com, b@y.com", "a@x.com"),
        # 畸形 / 空 → None (「这行没有可用的发件人地址」, 不是待补的空洞)。
        ("", None),
        ("   ", None),
        (None, None),
        ("not-an-email", None),
        ("Gary W", None),
        ("@x.com", None),
        ("a@localhost", None),   # 无点域名: 与 normalize_email 同判据
        ("weird <<a@x.com>>", None),
    ],
)
def test_derive_sender_email_shapes(raw, expected):
    assert derive_sender_email(raw) == expected


def test_derive_is_idempotent_on_its_own_output():
    """列是纯派生值 ⇒ 对已归一的值再跑一次必须不动 (回填重入 / 边界重写都靠它)。"""
    for raw in ("Gary W <gary.w@x.com>", "GARY.W@X.COM", "a@x.com, b@y.com"):
        once = derive_sender_email(raw)
        assert derive_sender_email(once) == once


def test_normalize_email_still_rejects_full_from_header():
    """🔴 消费者不能退回 normalize_email 解析 From 头 —— 它对完整头返 None,
    这正是 WP-5 之前 8850 封邮件的发件人被丢弃的机制。"""
    assert normalize_email("Gary W <gary.w@x.com>") is None
    assert normalize_email("GARY.W@X.COM") == "gary.w@x.com"


# ==================== ② 三条写入边界 ====================

@pytest.fixture
def store(tmp_path):
    return SyncStore(str(tmp_path / "sync.db"))


def _sender_cols(store, internal_id):
    with sqlite3.connect(store.db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT sender, sender_email FROM email_metadata WHERE internal_id=?",
            (internal_id,),
        ).fetchone()
    return (row["sender"], row["sender_email"]) if row else None


def test_save_email_boundary_derives_and_keeps_sender_verbatim(store):
    assert store.save_email({
        "internal_id": 1, "message_id": "<a@b>", "mailbox": "收件箱",
        "sender": "Gary W <GARY.W@TP-LINK.COM>",
    })
    sender, sender_email = _sender_cols(store, 1)
    # 🔴 sender 列一字不改 (前端 parseSender / ⌘K 结果靠它取显示名)。
    assert sender == "Gary W <GARY.W@TP-LINK.COM>"
    assert sender_email == "gary.w@tp-link.com"


def test_save_email_boundary_writes_null_when_no_address(store):
    assert store.save_email({
        "internal_id": 2, "message_id": "<c@d>", "mailbox": "收件箱", "sender": "",
    })
    assert _sender_cols(store, 2) == ("", None)


def test_batch_boundary_derives(store):
    assert store.save_emails_batch([
        {"internal_id": 10, "message_id": "<b1@x>", "sender": "A B <a.b@x.com>"},
        {"internal_id": 11, "message_id": "<b2@x>", "sender": "plain@y.com"},
        {"internal_id": 12, "message_id": "<b3@x>", "sender": "junk"},
    ]) == 3
    assert _sender_cols(store, 10) == ("A B <a.b@x.com>", "a.b@x.com")
    assert _sender_cols(store, 11) == ("plain@y.com", "plain@y.com")
    assert _sender_cols(store, 12) == ("junk", None)


def test_update_after_fetch_boundary_refreshes_derived_column(store):
    """davmail 主链路: 先 pending 落一行, fetch MIME 后经本函数刷新 sender。
    派生列必须跟着动, 否则两列长期不一致。"""
    store.save_email({
        "internal_id": 20, "message_id": None, "mailbox": "收件箱", "sender": "",
    })
    assert _sender_cols(store, 20) == ("", None)

    assert store.update_after_fetch(20, {
        "message_id": "<real@x>", "sender": "Real Person <real@x.com>",
    }) is UpdateAfterFetchResult.OK
    assert _sender_cols(store, 20) == ("Real Person <real@x.com>", "real@x.com")

    # 改成取不到地址的 sender → 派生列必须回到 NULL (不能留着上一次的陈值)。
    assert store.update_after_fetch(20, {"sender": "anonymous"}) is (
        UpdateAfterFetchResult.OK
    )
    assert _sender_cols(store, 20) == ("anonymous", None)


def test_update_after_fetch_leaves_derived_column_alone_when_sender_absent(store):
    """没动 sender 的 UPDATE 不该顺手改派生列 (否则任何 flag 写都会重算一遍)。"""
    store.save_email({
        "internal_id": 21, "message_id": "<keep@x>", "mailbox": "收件箱",
        "sender": "Keep Me <keep@x.com>",
    })
    assert store.update_after_fetch(21, {"subject": "新标题"}) is (
        UpdateAfterFetchResult.OK
    )
    assert _sender_cols(store, 21) == ("Keep Me <keep@x.com>", "keep@x.com")


# ==================== ③ v58 迁移 ====================

def _version(path) -> str:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]


def _columns(path) -> list[str]:
    with sqlite3.connect(path) as conn:
        return [row[1] for row in conn.execute("PRAGMA table_info(email_metadata)")]


def _index_count(path, name: str) -> int:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?",
            (name,),
        ).fetchone()[0]


def _downgrade_to_v57(path) -> None:
    """email_metadata 重建成 v57 形状 (无 sender_email 列), version 拨回 57。

    🔴 不用 DROP COLUMN (仓内教训): 逐列剔掉后重建, 顺带把 v58 建的索引一并清掉,
    模拟真实的「从 v57 库启动」。
    """
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys = OFF")
        # 🔴 DROP/RENAME 会让 SQLite 重新解析 email_body 上的 FTS 触发器 (它们引用
        # email_metadata) → "no such table"。legacy_alter_table=ON 关掉那次重解析,
        # 与 tests/mail/test_sync_store_v33/v36_migration.py 同款做法。
        conn.execute("PRAGMA legacy_alter_table=ON")
        cols = [
            row[1] for row in conn.execute("PRAGMA table_info(email_metadata)")
            if row[1] != "sender_email"
        ]
        assert "sender_email" not in cols
        collist = ", ".join(cols)
        types = {
            row[1]: row[2]
            for row in conn.execute("PRAGMA table_info(email_metadata)")
        }
        decls = ", ".join(
            f"{c} {types[c]}" + (" PRIMARY KEY" if c == "internal_id" else "")
            + (" UNIQUE" if c == "message_id" else "")
            for c in cols
        )
        conn.execute(f"CREATE TABLE em_v57_shape ({decls})")
        conn.execute(
            f"INSERT INTO em_v57_shape ({collist}) SELECT {collist} FROM email_metadata"
        )
        conn.execute("DROP TABLE email_metadata")
        conn.execute("ALTER TABLE em_v57_shape RENAME TO email_metadata")
        conn.execute("DROP INDEX IF EXISTS idx_email_sender_email")
        conn.execute("UPDATE sync_state SET value='57' WHERE key='db_version'")
        conn.commit()


def test_fresh_db_has_column_and_index(tmp_path):
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    assert "sender_email" in _columns(path)
    assert _index_count(path, "idx_email_sender_email") == 1
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v57_upgrade_adds_column_backfills_and_indexes(tmp_path):
    path = tmp_path / "up.db"
    store = SyncStore(str(path))
    rows = [
        (1, "Gary W <gary.w@tp-link.com>", "gary.w@tp-link.com"),
        (2, "plain@y.com", "plain@y.com"),
        (3, "", None),                    # 派生失败 → 留 NULL
        (4, "not-an-email", None),        # 同上
    ]
    for internal_id, sender, _ in rows:
        store.save_email({
            "internal_id": internal_id, "message_id": f"<m{internal_id}@x>",
            "mailbox": "收件箱", "sender": sender,
        })
    _downgrade_to_v57(path)
    assert "sender_email" not in _columns(path)
    assert _index_count(path, "idx_email_sender_email") == 0

    SyncStore(str(path))   # 重新初始化 = 走 v58 迁移

    assert "sender_email" in _columns(path)
    assert _index_count(path, "idx_email_sender_email") == 1
    assert _version(path) == str(SyncStore.DB_VERSION)
    with sqlite3.connect(path) as conn:
        got = dict(conn.execute(
            "SELECT internal_id, sender_email FROM email_metadata"
        ).fetchall())
    assert got == {internal_id: expected for internal_id, _, expected in rows}


def test_v58_migration_is_idempotent(tmp_path):
    """重入 (半程失败后下次启动重跑) 结果与一次跑完一致, 且不覆盖已有值。"""
    path = tmp_path / "idem.db"
    store = SyncStore(str(path))
    for internal_id, sender in ((1, "A <a@x.com>"), (2, ""), (3, "b@y.com")):
        store.save_email({
            "internal_id": internal_id, "message_id": f"<i{internal_id}@x>",
            "mailbox": "收件箱", "sender": sender,
        })

    def snapshot():
        with sqlite3.connect(path) as conn:
            return conn.execute(
                "SELECT internal_id, sender, sender_email FROM email_metadata "
                "ORDER BY internal_id"
            ).fetchall()

    first = snapshot()
    for _ in range(3):
        with sqlite3.connect(path) as conn:
            conn.execute("UPDATE sync_state SET value='57' WHERE key='db_version'")
            conn.commit()
        SyncStore(str(path))
        assert snapshot() == first


def test_backfill_handles_more_rows_than_one_chunk(tmp_path, monkeypatch):
    """回填是 keyset 分页 + executemany。🔴 判据不能是 `WHERE sender_email IS NULL
    LIMIT n` 的纯偏移循环 —— 派生失败的行永远留 NULL, 那种写法会死循环。这里把
    chunk 调到 2, 并**故意混入**派生失败的行, 逼出该形态。"""
    import src.mail.sync_store as sync_store_mod

    path = tmp_path / "chunk.db"
    store = SyncStore(str(path))
    expected = {}
    for i in range(1, 12):
        sender = "" if i % 3 == 0 else f"P{i} <p{i}@x.com>"
        expected[i] = None if i % 3 == 0 else f"p{i}@x.com"
        store.save_email({
            "internal_id": i, "message_id": f"<c{i}@x>", "mailbox": "收件箱",
            "sender": sender,
        })
    _downgrade_to_v57(path)

    monkeypatch.setattr(sync_store_mod, "SENDER_EMAIL_BACKFILL_CHUNK", 2)
    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        got = dict(conn.execute(
            "SELECT internal_id, sender_email FROM email_metadata"
        ).fetchall())
    assert got == expected
