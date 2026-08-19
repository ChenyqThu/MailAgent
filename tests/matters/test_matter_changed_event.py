"""S1 — 事项写面广播 `matter.changed`（提交后、带 public_id）。

owner 症状（2026-08-18）：「Agent 修改事项数据后…需要切出再切换到事项才可以看到更新」。
根因之一是 matters 域**从来没发过**事项本体的变更事件（只有 worker 的
`matter.attention`）。这里钉死新事件的四条语义：

1. 一次写 → 一条事件，`data.public_id` 是 `MAT-xxxx` 而**不是**内部数字主键
2. 幂等重放 → **不发**（判据是「真的落了 matter_event」）
3. 事务回滚 → **不发**（🔴 事件先到、DB 后提交 = 前端 refetch 读到旧值）
4. 一次事务里改多次同一事项 → 只发一条

外加事务出口闸：`src/matters/` 不许再直接用 `repository.transaction()`。
"""

from __future__ import annotations

import pathlib
import re
from unittest.mock import patch

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import Actor, MatterError, MatterService

NOW = 1_760_000_000_000


def _service(tmp_path):
    path = tmp_path / "changed.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(str(path)), clock_ms=lambda: NOW)


def _published(mock) -> list[str]:
    """所有 matter.changed 事件的 public_id，按发布顺序。"""
    return [
        call.kwargs["data"]["public_id"]
        for call in mock.call_args_list
        if call.args and call.args[0] == "matter.changed"
    ]


# ============================================================
# 1 — happy path
# ============================================================

def test_create_publishes_public_id(tmp_path):
    service = _service(tmp_path)
    with patch("src.matters.service.safe_publish") as publish:
        result = service.create_matter({"title": "x"}, idempotency_key="c", source="test")
    public_id = result["matter"]["public_id"]
    assert _published(publish) == [public_id]
    assert re.fullmatch(r"MAT-\d{4,}", public_id), "必须是 public_id，不是内部数字主键"


def test_patch_publishes(tmp_path):
    service = _service(tmp_path)
    matter = service.create_matter({"title": "x"}, idempotency_key="c", source="test")["matter"]
    with patch("src.matters.service.safe_publish") as publish:
        service.patch_matter(
            matter["public_id"], {"status": "active"},
            idempotency_key="p1", source="test", expected_version=matter["version"],
            actor=Actor(kind="user", actor_id="me"),
        )
    assert _published(publish) == [matter["public_id"]]


def test_does_not_pass_a_source_literal(tmp_path):
    """🔴 不传 `source=` —— 跟随 `worker.py` 发 matter.attention 的形态。

    另一层原因：时间线的 i18n 一致性闸
    （`frontend/tests/shared/matterTimelineModel.test.ts`）会从 `src/matters/*.py` 里
    grep 所有 `source="字面量"` 并要求每个都配事件来源标签 —— 它抽的是 **matter_event 的
    source**，和 SSE 事件的 source 是两回事。这条断言把「别再给它塞一个」钉住。
    """
    service = _service(tmp_path)
    with patch("src.matters.service.safe_publish") as publish:
        service.create_matter({"title": "x"}, idempotency_key="c", source="test")
    assert "source" not in publish.call_args.kwargs


def test_payload_carries_nothing_but_public_id(tmp_path):
    """事件是 invalidation hint —— 带业务数据会诱使前端拿它当真相（总线是 lossy 的）。"""
    service = _service(tmp_path)
    with patch("src.matters.service.safe_publish") as publish:
        service.create_matter({"title": "x"}, idempotency_key="c", source="test")
    assert set(publish.call_args.kwargs["data"]) == {"public_id"}


# ============================================================
# 2 — 幂等重放不发
# ============================================================

def test_idempotent_replay_does_not_publish(tmp_path):
    """同一个 idempotency_key 第二次 → 不落新事件 ⇒ 不发 ⇒ 前端不做无谓 refetch。"""
    service = _service(tmp_path)
    matter = service.create_matter({"title": "x"}, idempotency_key="c", source="test")["matter"]
    with patch("src.matters.service.safe_publish") as publish:
        service.patch_matter(
            matter["public_id"], {"status": "active"},
            idempotency_key="same", source="test", expected_version=matter["version"],
            actor=Actor(kind="user", actor_id="me"),
        )
        first = len(_published(publish))
        service.patch_matter(
            matter["public_id"], {"status": "active"},
            idempotency_key="same", source="test", expected_version=matter["version"],
            actor=Actor(kind="user", actor_id="me"),
        )
    assert first == 1
    assert len(_published(publish)) == 1, "重放不该再发一条"


# ============================================================
# 3 — 回滚不发（🔴 最要紧的一条）
# ============================================================

def test_rollback_does_not_publish(tmp_path):
    """写失败回滚 → 一条都不发。

    ⚠️ 本用例**不能**替代下面的 `test_publish_happens_after_commit`：这里的版本冲突是在
    `_append_event` 之前抛的，待发集合根本没被填过，所以 flush 放哪儿它都绿。
    真正守住「提交后才发」的是下一个用例。
    """
    service = _service(tmp_path)
    matter = service.create_matter({"title": "x"}, idempotency_key="c", source="test")["matter"]
    with patch("src.matters.service.safe_publish") as publish:
        with pytest.raises(MatterError):
            service.patch_matter(
                matter["public_id"], {"status": "active"},
                idempotency_key="p-conflict", source="test",
                expected_version=matter["version"] + 99,   # 版本冲突 → 抛 → 回滚
                actor=Actor(kind="user", actor_id="me"),
            )
    assert _published(publish) == []


def test_publish_happens_after_commit(tmp_path):
    """🔴 发事件的那一刻，**别的连接**必须已经能读到新值。

    这条守的是整个设计的要害。事件是 invalidation hint：前端收到就立刻 refetch，
    而 refetch 走的是另一个连接。若 flush 早于 commit，前端拿到的仍是旧值 ——
    症状与修之前一模一样，只是从「永远不刷新」退化成「偶尔刷不出来」，更难查。

    WAL 模式下读不阻塞写，所以未提交时探测连接会稳定读到旧值（而不是卡在锁上）。
    """
    service = _service(tmp_path)
    matter = service.create_matter({"title": "x"}, idempotency_key="c", source="test")["matter"]
    public_id = matter["public_id"]
    observed: list[str | None] = []

    def probe(event_type, **kwargs):
        if event_type != "matter.changed":
            return
        conn = service.repository.connect()
        try:
            row = conn.execute(
                "SELECT status FROM matter WHERE public_id=?", (public_id,)
            ).fetchone()
            observed.append(row["status"] if row else None)
        finally:
            conn.close()

    with patch("src.matters.service.safe_publish", side_effect=probe):
        service.patch_matter(
            public_id, {"status": "active"},
            idempotency_key="p-after-commit", source="test",
            expected_version=matter["version"],
            actor=Actor(kind="user", actor_id="me"),
        )

    assert observed == ["active"], (
        "发 matter.changed 时数据还没提交 —— flush 必须在 commit 之后"
    )


# ============================================================
# 4 — 一次事务内合并
# ============================================================

def test_multiple_events_in_one_transaction_publish_once(tmp_path):
    """建事项时会落多条事件（matter_created + 默认排程等）→ 仍只发一条。"""
    service = _service(tmp_path)
    with patch("src.matters.service.safe_publish") as publish:
        service.create_matter(
            {"title": "x", "description": "d", "tags": ["a"]},
            idempotency_key="c", source="test",
        )
    assert len(_published(publish)) == 1


def test_publish_failure_never_breaks_the_write(tmp_path):
    """通知挂了不该让已提交的写看起来失败了。"""
    service = _service(tmp_path)
    with patch("src.matters.service.safe_publish", side_effect=RuntimeError("bus down")):
        result = service.create_matter({"title": "x"}, idempotency_key="c", source="test")
    assert result["matter"]["title"] == "x"


# ============================================================
# 事务出口闸
# ============================================================

_TX_ALLOWED = {
    # `_transaction()` 自身 —— 它就是那个唯一出口。
    ("service.py", "with self.repository.transaction() as conn:"),
}


@pytest.mark.parametrize("filename", ["service.py", "run_service.py"])
def test_no_direct_repository_transaction(filename):
    """🔴 `src/matters/` 里不许再直接用 `repository.transaction()`。

    漏一处 = 那条写路径静默不刷新，且**不会有任何测试变红**（写本身是成功的）
    —— 这正是 2026-08-18 那批 bug 的复发形态，所以用结构闸而不是靠人记得。
    """
    path = pathlib.Path("src/matters") / filename
    offenders = [
        (i, line.strip())
        for i, line in enumerate(path.read_text().splitlines(), start=1)
        if "self.repository.transaction()" in line
        and (filename, line.strip()) not in _TX_ALLOWED
    ]
    assert offenders == [], (
        f"{path} 里有直接用 repository.transaction() 的写路径 —— 改成 self._transaction()："
        f"{offenders}"
    )
