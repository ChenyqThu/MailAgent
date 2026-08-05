"""线程虚拟头的级联写 (flag 摘旗 / pin 取消置顶) —— 服务层语义。

前端把折叠行升格成「虚拟线程头」(代表整条线程, 不再只是最新那封) 之后, 两个动作
需要一次往返把整条线程收敛掉:

  - 旗标: 母行显示「任一成员带旗」, 点一下 = 最新一封转已完成 + **其他成员摘旗**
    (只清 is_flagged, 不判它们完成);
  - 置顶: 母行显示「任一成员置顶」, 点一下 = 整条线程取消置顶。

这里锁的是级联的**边界**: 展开到谁、不展开到谁、只改什么字段、发几条 SSE。真实
SQLite + 真实 EmailRepository/SyncStore (级联判据全在 SQL 里, mock 掉就什么都没测)。
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

from src.mail.mailbox_semantics import DRAFTS_LABEL, INBOX_LABEL
from src.mail.sync_store import SyncStore
from src.repository import EmailRepository
from src.services.errors import ServiceInvalidArgError
from src.services.guards import Actor
from src.services.mail_write import MailWriteService

THREAD = "<thread-cascade@example.com>"
OTHER_THREAD = "<thread-other@example.com>"


class _Ctx:
    """结构化满足 ServiceDeps 的最小体 (flag/pin 只读 email_repo + sync_store)。"""

    def __init__(self, email_repo, sync_store):
        self.email_repo = email_repo
        self.sync_store = sync_store


def _actor() -> Actor:
    return Actor(kind="system", authenticated=True, label="test")


def _seed(
    db_path: str,
    internal_id: int,
    *,
    thread_id: str | None = THREAD,
    mailbox: str = INBOX_LABEL,
    is_flagged: bool = False,
    is_pinned: bool = False,
    processing_status: str | None = None,
) -> None:
    conn = sqlite3.connect(db_path)
    now = time.time()
    try:
        conn.execute(
            """INSERT INTO email_metadata
                 (internal_id, message_id, thread_id, subject, sender, mailbox,
                  is_read, is_flagged, is_pinned, processing_status, sync_status,
                  created_at, updated_at)
               VALUES (?, ?, ?, ?, 'a@example.com', ?, 1, ?, ?, ?, 'synced', ?, ?)""",
            (
                internal_id,
                f"<msg-{internal_id}@example.com>",
                thread_id,
                f"subject-{internal_id}",
                mailbox,
                1 if is_flagged else 0,
                1 if is_pinned else 0,
                processing_status,
                now,
                now,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _row(db_path: str, internal_id: int) -> sqlite3.Row:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            "SELECT is_flagged, is_pinned, processing_status FROM email_metadata "
            "WHERE internal_id = ?",
            (internal_id,),
        ).fetchone()
    finally:
        conn.close()


@pytest.fixture
def svc(tmp_path: Path):
    """(service, db_path) —— 空库 + v4 schema, 各用例自己 seed 线程成员。"""
    db_path = str(tmp_path / "sync_store.db")
    store = SyncStore(db_path)
    return MailWriteService(_Ctx(EmailRepository(db_path), store)), db_path


@pytest.fixture
def events(monkeypatch):
    """捕获 safe_publish —— 级联必须发**一条**批量事件, 不按封刷屏。"""
    import src.events.publisher as publisher

    captured: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        publisher,
        "safe_publish",
        lambda event_type, **kw: captured.append((event_type, kw)),
    )
    return captured


# ============================================================
# flag —— 「标完成」级联摘旗
# ============================================================


def test_flag_cascade_clears_other_flagged_members_only(svc):
    service, db_path = svc
    _seed(db_path, 1, is_flagged=True)              # 最新一封 (primary)
    _seed(db_path, 2, is_flagged=True)              # 带旗成员 → 级联摘旗
    _seed(db_path, 3, is_flagged=False)             # 无旗成员 → 不碰
    _seed(db_path, 4, is_flagged=True, thread_id=OTHER_THREAD)  # 别的线程 → 不碰

    result = service.set_flags(
        [1],
        is_flagged=False,
        processing_status="已完成",
        cascade_thread=True,
        actor=_actor(),
        allow_concurrent=True,
    )

    assert result.updated_ids == [1]
    assert result.cascade_ids == [2]
    # primary: 完整 mutation (摘旗 + 判完成)
    assert _row(db_path, 1)["is_flagged"] == 0
    assert _row(db_path, 1)["processing_status"] == "已完成"
    # 级联成员: **只**摘旗, processing_status 不动 (用户点的是母行的完成)
    assert _row(db_path, 2)["is_flagged"] == 0
    assert _row(db_path, 2)["processing_status"] is None
    # 无旗成员 / 别的线程: 纹丝不动
    assert _row(db_path, 3)["is_flagged"] == 0
    assert _row(db_path, 4)["is_flagged"] == 1


def test_flag_cascade_excludes_drafts_members(svc):
    service, db_path = svc
    _seed(db_path, 1, is_flagged=True)
    _seed(db_path, 2, is_flagged=True, mailbox=DRAFTS_LABEL)

    result = service.set_flags(
        [1], is_flagged=False, cascade_thread=True, actor=_actor(), allow_concurrent=True
    )

    assert result.cascade_ids == []
    assert _row(db_path, 2)["is_flagged"] == 1


def test_flag_cascade_no_thread_id_expands_nothing(svc):
    service, db_path = svc
    _seed(db_path, 1, is_flagged=True, thread_id=None)
    _seed(db_path, 2, is_flagged=True)  # 有线程但与 primary 无关

    result = service.set_flags(
        [1], is_flagged=False, cascade_thread=True, actor=_actor(), allow_concurrent=True
    )

    assert result.cascade_ids == []
    assert _row(db_path, 2)["is_flagged"] == 1


def test_flag_cascade_rejects_non_clearing_mutation(svc):
    """「级联加旗」没有产品语义 —— 显式 400 而不是静默忽略。"""
    service, db_path = svc
    _seed(db_path, 1)

    with pytest.raises(ServiceInvalidArgError):
        service.set_flags(
            [1], is_flagged=True, cascade_thread=True, actor=_actor(), allow_concurrent=True
        )
    with pytest.raises(ServiceInvalidArgError):
        service.set_flags(
            [1],
            processing_status="已完成",
            cascade_thread=True,
            actor=_actor(),
            allow_concurrent=True,
        )


def test_flag_cascade_emits_one_batch_event_for_members(svc, events):
    """级联成员一条批量 SSE (internal_id=None + data.internal_ids), 不按封刷屏;
    primary 仍走它自己的逐封事件 (批量 flag 的既有行为不动)。"""
    service, db_path = svc
    _seed(db_path, 1, is_flagged=True)
    _seed(db_path, 2, is_flagged=True)
    _seed(db_path, 3, is_flagged=True)

    service.set_flags(
        [1], is_flagged=False, cascade_thread=True, actor=_actor(), allow_concurrent=True
    )

    flag_events = [kw for name, kw in events if name == "email.flag_changed"]
    assert len(flag_events) == 2
    assert flag_events[0]["internal_id"] == 1                      # primary 逐封
    assert flag_events[1]["internal_id"] is None                   # 级联批量
    assert flag_events[1]["data"]["internal_ids"] == [2, 3]


def test_flag_without_cascade_is_unchanged(svc, events):
    """不传 cascade_thread = 老语义: 同线程的兄弟一个都不碰, 事件也只有一条。"""
    service, db_path = svc
    _seed(db_path, 1, is_flagged=True)
    _seed(db_path, 2, is_flagged=True)

    result = service.set_flags(
        [1], is_flagged=False, processing_status="已完成", actor=_actor(), allow_concurrent=True
    )

    assert result.cascade_ids == []
    assert _row(db_path, 2)["is_flagged"] == 1
    assert [kw["internal_id"] for name, kw in events if name == "email.flag_changed"] == [1]


# ============================================================
# pin —— 级联取消置顶 + 批量写
# ============================================================


def test_pin_cascade_unpins_whole_thread(svc):
    service, db_path = svc
    _seed(db_path, 1, is_pinned=False)   # 母邮件自己没置顶 (聚合是「任一成员」)
    _seed(db_path, 2, is_pinned=True)
    _seed(db_path, 3, is_pinned=False)
    _seed(db_path, 4, is_pinned=True, thread_id=OTHER_THREAD)

    result = service.set_pins([1], pinned=False, cascade_thread=True, actor=_actor())

    assert result.cascade_ids == [2]
    assert result.changed_ids == [2]     # 1 本来就没置顶 → 不算 changed
    assert _row(db_path, 2)["is_pinned"] == 0
    assert _row(db_path, 4)["is_pinned"] == 1


def test_pin_cascade_excludes_drafts_members(svc):
    service, db_path = svc
    _seed(db_path, 1, is_pinned=True)
    _seed(db_path, 2, is_pinned=True, mailbox=DRAFTS_LABEL)

    result = service.set_pins([1], pinned=False, cascade_thread=True, actor=_actor())

    assert result.cascade_ids == []
    assert _row(db_path, 2)["is_pinned"] == 1


def test_pin_cascade_rejects_pinned_true(svc):
    """「级联置顶整条线程」没有产品语义。"""
    service, db_path = svc
    _seed(db_path, 1)

    with pytest.raises(ServiceInvalidArgError):
        service.set_pins([1], pinned=True, cascade_thread=True, actor=_actor())


def test_pin_batch_reports_not_found_and_emits_one_event(svc, events):
    service, db_path = svc
    _seed(db_path, 1, is_pinned=True)
    _seed(db_path, 2, is_pinned=False)

    result = service.set_pins([1, 2, 999], pinned=False, actor=_actor())

    assert result.updated_ids == [1, 2]
    assert result.changed_ids == [1]     # 2 本来就没置顶
    assert result.not_found == [999]
    pin_events = [kw for name, kw in events if name == "email.pin_changed"]
    assert len(pin_events) == 1
    assert pin_events[0]["internal_id"] is None
    assert pin_events[0]["data"]["internal_ids"] == [1]


def test_pin_batch_no_change_no_event(svc, events):
    service, db_path = svc
    _seed(db_path, 1, is_pinned=False)

    service.set_pins([1], pinned=False, actor=_actor())

    assert [name for name, _ in events if name == "email.pin_changed"] == []
