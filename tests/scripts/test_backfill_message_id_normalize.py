"""scripts/backfill_message_id_normalize.py 的行为测试。

这个脚本会**直接改用户的生产库**，所以每条危险路径都要有测试兜底。覆盖点全部来自
codex review 第二轮的 finding（2 CRITICAL + 3 HIGH）:

- CRITICAL-1 stale snapshot → CAS 失配必须整批回滚（不能写一半）
- CRITICAL-2 非空旧值归一成空 → 必须跳过，绝不能抹掉原始标识
- HIGH-3   两个**不同的脏值**归一到同一目标 → 按目标值分组才查得出（按原始值建
           索引会漏检，然后在第二次 UPDATE 才撞 UNIQUE）
- HIGH-4   plan journal ≠ applied journal —— 只有后者是回滚依据
- 另: 干净行零改动、UNIQUE 冲突只报告不处置、thread_id 不动
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "backfill_message_id_normalize.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("backfill_msgid", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


mod = _load_module()


def _make_db(path: Path, rows: list[tuple[int, str | None, str | None]]) -> None:
    """rows = [(internal_id, message_id, thread_id)]，带 UNIQUE 约束（跟生产同形）。"""
    conn = sqlite3.connect(path)
    conn.execute(
        """
        CREATE TABLE email_metadata (
            internal_id INTEGER PRIMARY KEY,
            mailbox TEXT DEFAULT '收件箱',
            sync_status TEXT DEFAULT 'synced',
            message_id TEXT UNIQUE,
            thread_id TEXT
        )
        """
    )
    for iid, mid, tid in rows:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, message_id, thread_id) VALUES (?,?,?)",
            (iid, mid, tid),
        )
    conn.commit()
    conn.close()


def _run(db: Path, apply: bool, journal: Path) -> int:
    argv = ["--db", str(db), "--journal", str(journal)]
    if apply:
        argv.append("--apply")
    import sys

    old = sys.argv
    sys.argv = ["backfill"] + argv
    try:
        return mod.main()
    finally:
        sys.argv = old


def _msgids(db: Path) -> dict[int, str | None]:
    conn = sqlite3.connect(db)
    out = dict(conn.execute("SELECT internal_id, message_id FROM email_metadata").fetchall())
    conn.close()
    return out


_DIRTY = "=?UTF-8?Q?=3Cbug-1@x=2Ecom?=\r\n =?UTF-8?Q?/=3E?="
_DIRTY_CLEAN = "bug-1@x.com/"


def test_dry_run_does_not_touch_db(tmp_path):
    db = tmp_path / "t.db"
    _make_db(db, [(1, _DIRTY, None), (2, "clean@x.com", None)])
    assert _run(db, apply=False, journal=tmp_path / "j.json") == 0
    assert _msgids(db) == {1: _DIRTY, 2: "clean@x.com"}
    # plan journal 写了，但 applied journal 没有 —— 只有后者代表已生效。
    assert (tmp_path / "j.json").exists()
    assert not (tmp_path / "j.json.applied.json").exists()


def test_apply_normalizes_and_leaves_clean_rows_untouched(tmp_path):
    db = tmp_path / "t.db"
    _make_db(db, [(1, _DIRTY, None), (2, "clean@x.com", None)])
    assert _run(db, apply=True, journal=tmp_path / "j.json") == 0
    assert _msgids(db) == {1: _DIRTY_CLEAN, 2: "clean@x.com"}

    applied = json.loads((tmp_path / "j.json.applied.json").read_text())
    assert applied["db_path"] == str(db.resolve())
    assert list(applied["rows"]) == ["1"]
    assert applied["rows"]["1"]["new_message_id"] == _DIRTY_CLEAN
    assert applied["applied_at"]


def test_blank_target_is_skipped_not_written(tmp_path):
    """CRITICAL-2: `<>` 归一成空串 —— 写回等于抹掉原始标识。"""
    db = tmp_path / "t.db"
    _make_db(db, [(1, "<>", None), (2, _DIRTY, None)])
    assert _run(db, apply=True, journal=tmp_path / "j.json") == 0
    ids = _msgids(db)
    assert ids[1] == "<>"  # 原值保留
    assert ids[2] == _DIRTY_CLEAN  # 不影响同批的正常行


def test_two_dirty_rows_normalizing_to_same_target_are_both_skipped(tmp_path):
    """HIGH-3: 按原始值建索引查不出来的那种冲突。

    两行原始值不同（都不等于目标值），归一化后撞在一起。首版预检会让两行都进 plan，
    然后在第二次 UPDATE 才撞 UNIQUE。
    """
    db = tmp_path / "t.db"
    _make_db(db, [(1, "(relay) <same@x.com>", None), (2, "<same@x.com> (mx)", None)])
    assert _run(db, apply=True, journal=tmp_path / "j.json") == 0
    # 整组跳过 —— 两行都保持原值，谁都不动。
    assert _msgids(db) == {1: "(relay) <same@x.com>", 2: "<same@x.com> (mx)"}
    assert not (tmp_path / "j.json.applied.json").exists()


def test_dirty_row_colliding_with_existing_clean_row_is_skipped(tmp_path):
    """脏行归一化后撞上已有干净行 —— 判定谁是真身要看 sync_status，只报告不处置。"""
    db = tmp_path / "t.db"
    _make_db(db, [(1, "(relay) <same@x.com>", None), (2, "same@x.com", None)])
    assert _run(db, apply=True, journal=tmp_path / "j.json") == 0
    assert _msgids(db) == {1: "(relay) <same@x.com>", 2: "same@x.com"}


def test_cas_mismatch_aborts_whole_batch(tmp_path, monkeypatch):
    """CRITICAL-1: 扫描后库被改动 → 整批回滚，不能写一半。"""
    db = tmp_path / "t.db"
    other_dirty = "=?UTF-8?Q?=3Cbug-2=40x=2Ecom=3E?="
    _make_db(db, [(1, _DIRTY, None), (2, other_dirty, None)])

    # 在预检之后、UPDATE 之前，模拟 app 改掉其中一行（用另一条连接写不进去——
    # BEGIN IMMEDIATE 已持锁——所以直接篡改 plan 里记录的 old 值，等价于"现值已变"）。
    real_plan_from = mod._plan_from

    def tampered(conn, normalize):
        plan, *rest = real_plan_from(conn, normalize)
        first = sorted(plan)[0]
        plan[first]["old_message_id"] = "something-else-entirely"
        return (plan, *rest)

    monkeypatch.setattr(mod, "_plan_from", tampered)

    assert _run(db, apply=True, journal=tmp_path / "j.json") == 3
    # 整批回滚：另一行本来是能改的，也必须没被写。
    assert _msgids(db) == {1: _DIRTY, 2: other_dirty}
    assert not (tmp_path / "j.json.applied.json").exists()


def test_thread_id_is_never_written(tmp_path):
    """thread_id 去括号存 + 可能含多个 msgid，用 msgid 归一化函数会造出更糟的值。"""
    db = tmp_path / "t.db"
    dirty_tid = "a@x.com>\r\n <b@x.com"
    _make_db(db, [(1, _DIRTY, dirty_tid)])
    assert _run(db, apply=True, journal=tmp_path / "j.json") == 0
    conn = sqlite3.connect(db)
    tid = conn.execute("SELECT thread_id FROM email_metadata WHERE internal_id=1").fetchone()[0]
    conn.close()
    assert tid == dirty_tid


def test_null_message_id_rows_are_ignored(tmp_path):
    db = tmp_path / "t.db"
    _make_db(db, [(1, None, None), (2, _DIRTY, None)])
    assert _run(db, apply=True, journal=tmp_path / "j.json") == 0
    assert _msgids(db) == {1: None, 2: _DIRTY_CLEAN}


def test_rerun_is_idempotent(tmp_path):
    db = tmp_path / "t.db"
    _make_db(db, [(1, _DIRTY, None)])
    assert _run(db, apply=True, journal=tmp_path / "j.json") == 0
    first = _msgids(db)
    assert _run(db, apply=True, journal=tmp_path / "j2.json") == 0
    assert _msgids(db) == first
    # 第二遍无可写项 → 不产生 applied journal
    assert not (tmp_path / "j2.json.applied.json").exists()


def test_missing_db_exits_2(tmp_path):
    assert _run(tmp_path / "nope.db", apply=False, journal=tmp_path / "j.json") == 2


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("(relay) <a@x.com>", "a@x.com"),
        ("<a@x.com> (mx1)", "a@x.com"),
        ("<a@x.com>", "a@x.com"),
        ("a@x.com", "a@x.com"),
    ],
)
def test_normalizer_contract_used_by_script(raw, expected):
    """脚本依赖的归一化语义 —— 变了这里先红，别等到改坏生产库才发现。"""
    from src.mail.backend.davmail_backend import _normalize_message_id

    assert _normalize_message_id(raw) == expected
