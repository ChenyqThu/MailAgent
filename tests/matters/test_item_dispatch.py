"""行动项执行契约（task 08-25-l4-batch3-item-execution-contract，Lane 1 后端内核）。

一条行动项可以被**派发**给执行器跑一轮 headless run。本文件钉六件事：

1. **状态机** —— 合法迁移逐条走通；非法迁移一律 `E_INVALID_STATE`，判据是服务端 CAS 的
   rowcount 而不是「先读一遍看看」（读与写之间那个窗口正是 CAS 要消灭的东西）；
2. **单活跃** —— 一条行动项同时只有一次派发（partial unique 兜底），终态之后可以再派；
3. **幂等 / 事务外 enqueue** —— 同 key 重放返回同一次派发；enqueue 失败恒收敛 failed，
   不留悬挂 queued（抄 `enqueue_run` 的纪律）；
4. **提案回钩** —— 采纳 ⇒ 派发 done，驳回 ⇒ 派发 canceled，与评审在同一个事务里；
5. **执行档** —— 只有行动项能设、词表外恒拒；派发时**冻结**进派发行；
6. **孤儿收敛** —— job 已 failed/aborted 而派发仍活跃 → failed，且**绝不 requeue**。
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.events import (
    ITEM_DISPATCH_ANSWERED,
    ITEM_DISPATCH_CANCELED,
    ITEM_DISPATCH_DELIVERED,
    ITEM_DISPATCH_FAILED,
    ITEM_DISPATCH_SETTLED,
    ITEM_DISPATCHED,
)
from src.matters.models import MatterItemDispatchState
from src.matters.repository import MatterRepository
from src.matters.service import Actor, MatterError, MatterService

NOW = 1_800_000_000_000


@pytest.fixture
def service(tmp_path):
    path = tmp_path / "dispatch.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(path), clock_ms=lambda: NOW)


def _mutation(key: str, **extra) -> dict[str, object]:
    return {"idempotency_key": key, "source": "desktop_ui", **extra}


def _seed(service: MatterService, *, kind: str = "action", **item_fields) -> tuple[str, int]:
    """建一个事项 + 一条条目，返回 `(public_id, item_id)`。"""
    matter = service.create_matter({"title": "NexPay 二期"}, **_mutation("seed-matter"))
    public_id = str(matter["matter"]["public_id"])
    item = service.create_item(
        public_id,
        {"kind": kind, "title": "回签补充协议", **item_fields},
        expected_version=matter["version"],
        **_mutation("seed-item"),
    )
    return public_id, int(item["item"]["id"])


def _version(service: MatterService, public_id: str) -> int:
    return int(service.get_matter(public_id)["matter"]["version"])


def _jobs(path) -> list[dict]:
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        return [
            dict(row)
            for row in conn.execute(
                "SELECT job_id, job_type, status, idempotency_key, params_json "
                "FROM async_jobs ORDER BY job_id"
            )
        ]


def _events(service: MatterService, public_id: str) -> list[tuple[str, object, object]]:
    timeline = service.timeline(public_id, cursor=None, limit=100)
    return [
        (event["kind"], event["item_id"], (event["payload"] or {}).get("dispatch_id"))
        for event in reversed(timeline["items"])
    ]


def _insert_delivered_update(
    service: MatterService, public_id: str, dispatch_id: int
) -> int:
    """模拟 Lane 2 的 report 端点落下的那份提案（带 `item_dispatch_id` 配对）。

    这里直接写库而不是走 `propose_update`：那条路要求一个活跃的 `matter_run` 行，而行动项
    派发**不写** matter_run（账本在派发行上）—— 借用它反而会把两套账本搅在一起。
    """
    with service.repository.transaction() as conn:
        matter = service.repository.get_matter(conn, public_id)
        cursor = conn.execute(
            "INSERT INTO matter_update (matter_id, review_status, summary, "
            "anchored_matter_version, original_proposal_json, changes_json, citations_json, "
            "created_by_kind, created_by_id, created_at, item_dispatch_id) "
            "VALUES (?, 'pending', ?, ?, '{}', '[]', '[]', 'agent', 'matter_followup', ?, ?)",
            (matter["id"], "补充协议已回签", int(matter["version"]), NOW, dispatch_id),
        )
        return int(cursor.lastrowid)


# ── 派发（queued 落地 + 事务外 enqueue）─────────────────────────────────────────


def test_dispatch_lands_a_queued_row_and_enqueues_one_run(service, tmp_path):
    public_id, item_id = _seed(service)

    result = service.dispatch_item(public_id, item_id, **_mutation("d-1"))

    dispatch = result["dispatch"]
    assert dispatch["state"] == MatterItemDispatchState.QUEUED.value
    assert dispatch["executor_kind"] == "agent"
    # 不指定执行器 = 内建跟进 Agent；不指定档 = 出厂档。
    assert dispatch["executor_id"] == "matter_followup"
    assert dispatch["exec_profile"] == "propose_only"
    assert dispatch["attempt_count"] == 1
    assert dispatch["ended_at"] is None
    assert dispatch["dispatched_at"] == NOW

    jobs = _jobs(tmp_path / "dispatch.db")
    assert [job["job_type"] for job in jobs] == ["matter_item_run"]
    assert jobs[0]["idempotency_key"] == f"item_dispatch:{dispatch['id']}:attempt:1"
    assert json.loads(jobs[0]["params_json"]) == {
        "attempt": 1,
        "dispatch_id": dispatch["id"],
        "item_id": item_id,
        "matter_id": 1,
    }
    # job id 回写进派发行 —— 孤儿收敛靠它 JOIN。
    assert dispatch["async_job_id"] == jobs[0]["job_id"]

    # 审计事件带真实 FK item_id；派发行自己的 id 只在 payload 里（matter_event 没有那根列）。
    assert (ITEM_DISPATCHED, item_id, dispatch["id"]) in _events(service, public_id)


def test_dispatch_replay_returns_the_same_dispatch_without_a_second_run(service, tmp_path):
    public_id, item_id = _seed(service)
    first = service.dispatch_item(public_id, item_id, **_mutation("d-1"))

    again = service.dispatch_item(public_id, item_id, **_mutation("d-1"))

    assert again["dispatch"]["id"] == first["dispatch"]["id"]
    assert len(service.list_dispatches(public_id)) == 1
    # 重放不落新事件 ⇒ 也不该多派一轮 run。
    assert len(_jobs(tmp_path / "dispatch.db")) == 1


def test_a_second_dispatch_while_one_is_active_is_refused(service):
    public_id, item_id = _seed(service)
    service.dispatch_item(public_id, item_id, **_mutation("d-1"))

    with pytest.raises(MatterError) as excinfo:
        service.dispatch_item(public_id, item_id, **_mutation("d-2"))
    assert excinfo.value.code == "E_DISPATCH_ACTIVE"


def test_a_terminal_dispatch_frees_the_item_for_another_round(service):
    public_id, item_id = _seed(service)
    first = service.dispatch_item(public_id, item_id, **_mutation("d-1"))
    service.cancel_dispatch(public_id, first["dispatch"]["id"], **_mutation("c-1"))

    second = service.dispatch_item(public_id, item_id, **_mutation("d-2"))

    # 终态判据是 ended_at，不是 state —— 派发史逐行留下。
    assert second["dispatch"]["id"] != first["dispatch"]["id"]
    assert len(service.list_dispatches(public_id, item_id=item_id)) == 2


@pytest.mark.parametrize("kind", ["note", "question", "milestone"])
def test_only_action_items_can_be_dispatched(service, kind):
    public_id, item_id = _seed(service, kind=kind)

    with pytest.raises(MatterError) as excinfo:
        service.dispatch_item(public_id, item_id, **_mutation("d-1"))
    assert excinfo.value.code == "E_INVALID_ARG"


@pytest.mark.parametrize("status", ["done", "canceled"])
def test_a_closed_item_cannot_be_dispatched(service, status):
    public_id, item_id = _seed(service, status=status)

    with pytest.raises(MatterError) as excinfo:
        service.dispatch_item(public_id, item_id, **_mutation("d-1"))
    assert excinfo.value.code == "E_INVALID_STATE"


def test_a_deleted_item_cannot_be_dispatched(service):
    public_id, item_id = _seed(service)
    version = _version(service, public_id)
    service.delete_item(
        public_id, item_id, expected_version=version, **_mutation("del-1")
    )

    with pytest.raises(MatterError) as excinfo:
        service.dispatch_item(public_id, item_id, **_mutation("d-1"))
    assert excinfo.value.code == "E_CHILD_NOT_FOUND"


# ── 执行器校验（派给一个跑不起来的 agent 必须当场报错）───────────────────────────


def test_unknown_executor_is_refused(service):
    public_id, item_id = _seed(service)

    with pytest.raises(MatterError) as excinfo:
        service.dispatch_item(
            public_id, item_id, executor_id="ghost_agent", **_mutation("d-1")
        )
    assert excinfo.value.code == "E_INVALID_ARG"


def test_a_disabled_custom_agent_is_refused_and_an_enabled_one_is_accepted(
    service, tmp_path
):
    public_id, item_id = _seed(service)
    with sqlite3.connect(tmp_path / "dispatch.db") as conn:
        conn.execute(
            "INSERT INTO report_agent (id, type, enabled, title, updated_at) "
            "VALUES ('deal_desk', 'custom', 0, '交易台', 1)"
        )
        conn.commit()

    # 关掉的 agent 派出去的表现会是「派发了、永远不动」—— 正是这一批要终结的失效形态。
    with pytest.raises(MatterError) as excinfo:
        service.dispatch_item(
            public_id, item_id, executor_id="deal_desk", **_mutation("d-1")
        )
    assert excinfo.value.code == "E_INVALID_STATE"

    with sqlite3.connect(tmp_path / "dispatch.db") as conn:
        conn.execute("UPDATE report_agent SET enabled=1 WHERE id='deal_desk'")
        conn.commit()
    result = service.dispatch_item(
        public_id, item_id, executor_id="deal_desk", **_mutation("d-2")
    )
    assert result["dispatch"]["executor_id"] == "deal_desk"


# ── 状态机：合法迁移逐条 ────────────────────────────────────────────────────────


def test_the_whole_legal_transition_table_walks_through(service):
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]

    # queued → running（worker claim）
    assert service.mark_dispatch_started(dispatch_id, async_job_id=1) is True
    # running → awaiting_input（run 以「缺信息」收尾）
    awaiting = service.deliver_dispatch(
        dispatch_id, question={"question": "要不要新加坡实体共签？", "options": ["要", "不要"]}
    )
    assert awaiting["state"] == MatterItemDispatchState.AWAITING_INPUT.value
    assert awaiting["awaiting_since"] == NOW
    assert awaiting["question"] == {
        "question": "要不要新加坡实体共签？",
        "options": ["要", "不要"],
    }
    # awaiting_input → queued（owner 回答，开新一轮）
    answered = service.answer_dispatch(
        public_id, dispatch_id, text="要", **_mutation("a-1")
    )["dispatch"]
    assert answered["state"] == MatterItemDispatchState.QUEUED.value
    assert answered["attempt_count"] == 2
    assert answered["question"] is None
    assert answered["answers"] == [
        {"question": "要不要新加坡实体共签？", "answer": "要", "at": NOW}
    ]
    # 🔴 新一轮还没有 job：留着上一轮的 job id 会让孤儿收敛把这一轮当场判死。
    assert answered["async_job_id"] is None or answered["async_job_id"] == 2

    # queued → running → proposed（交付落成提案）
    assert service.mark_dispatch_started(dispatch_id, async_job_id=2) is True
    update_id = _insert_delivered_update(service, public_id, dispatch_id)
    delivered = service.deliver_dispatch(dispatch_id, update_id=update_id)
    assert delivered["state"] == MatterItemDispatchState.PROPOSED.value
    assert delivered["update_id"] == update_id
    assert delivered["delivered_at"] == NOW
    assert delivered["ended_at"] is None

    # proposed → done（提案被采纳）
    version = _version(service, public_id)
    service.accept_update(
        public_id, update_id, expected_version=version, **_mutation("acc-1")
    )
    settled = service.list_dispatches(public_id)[0]
    assert settled["state"] == MatterItemDispatchState.DONE.value
    assert settled["ended_at"] == NOW

    kinds = [kind for kind, _, _ in _events(service, public_id)]
    assert kinds.count(ITEM_DISPATCH_DELIVERED) == 2  # 反问一次 + 交付一次
    assert ITEM_DISPATCH_ANSWERED in kinds
    assert ITEM_DISPATCH_SETTLED in kinds


def test_rejecting_the_proposal_cancels_the_dispatch(service):
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]
    service.mark_dispatch_started(dispatch_id, async_job_id=1)
    update_id = _insert_delivered_update(service, public_id, dispatch_id)
    service.deliver_dispatch(dispatch_id, update_id=update_id)

    version = _version(service, public_id)
    service.reject_update(
        public_id,
        update_id,
        reason="证据不足，等合规回执再说",
        expected_version=version,
        **_mutation("rej-1"),
    )

    dispatch = service.list_dispatches(public_id)[0]
    assert dispatch["state"] == MatterItemDispatchState.CANCELED.value
    assert dispatch["ended_at"] == NOW
    assert dispatch["error"] == {"code": "proposal_rejected"}


def test_reviewing_an_unrelated_proposal_touches_no_dispatch(service):
    """与派发无关的提案（跟进 run 提的那种）整段 no-op —— 回钩不许误伤。"""
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]
    with service.repository.transaction() as conn:
        matter = service.repository.get_matter(conn, public_id)
        cursor = conn.execute(
            "INSERT INTO matter_update (matter_id, review_status, anchored_matter_version, "
            "original_proposal_json, changes_json, citations_json, created_by_kind, created_at) "
            "VALUES (?, 'pending', ?, '{}', '[]', '[]', 'agent', ?)",
            (matter["id"], int(matter["version"]), NOW),
        )
        unrelated_id = int(cursor.lastrowid)

    version = _version(service, public_id)
    service.accept_update(
        public_id, unrelated_id, expected_version=version, **_mutation("acc-1")
    )

    assert (
        service.list_dispatches(public_id)[0]["state"]
        == MatterItemDispatchState.QUEUED.value
    )
    assert dispatch_id == service.list_dispatches(public_id)[0]["id"]


def test_superseding_a_delivered_proposal_also_closes_its_dispatch(service):
    """🔴 accept 会把同事项其余 pending 提案一并转 superseded。被作废的那份若是一次派发的
    交付，它的派发行必须一起收尾 —— 不收的话那一行永远停在 `proposed`：提案面看不见
    （已 superseded）、例外面看不见（`proposed` 不进面）、owner 取消不了（不在可取消态），
    而单活跃 partial unique 还把那条行动项的重派锁死。"""
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]
    service.mark_dispatch_started(dispatch_id, async_job_id=1)
    delivered_id = _insert_delivered_update(service, public_id, dispatch_id)
    service.deliver_dispatch(dispatch_id, update_id=delivered_id)
    # 另一份 pending 提案（跟进 run 提的那种）—— 采纳它会把上面那份转 superseded。
    with service.repository.transaction() as conn:
        matter = service.repository.get_matter(conn, public_id)
        cursor = conn.execute(
            "INSERT INTO matter_update (matter_id, review_status, anchored_matter_version, "
            "original_proposal_json, changes_json, citations_json, created_by_kind, created_at) "
            "VALUES (?, 'pending', ?, '{}', '[]', '[]', 'agent', ?)",
            (matter["id"], int(matter["version"]), NOW),
        )
        other_id = int(cursor.lastrowid)

    service.accept_update(
        public_id, other_id, expected_version=_version(service, public_id), **_mutation("acc-1")
    )

    dispatch = service.list_dispatches(public_id)[0]
    assert dispatch["state"] == MatterItemDispatchState.CANCELED.value
    assert dispatch["ended_at"] == NOW
    assert dispatch["error"] == {"code": "proposal_superseded"}
    # 终态 ⇒ 单活跃索引放行，这条行动项可以重派（黑洞的另一半）。
    again = service.dispatch_item(public_id, item_id, **_mutation("d-2"))["dispatch"]
    assert again["state"] == MatterItemDispatchState.QUEUED.value


@pytest.mark.parametrize(
    "state",
    [
        MatterItemDispatchState.QUEUED.value,
        MatterItemDispatchState.RUNNING.value,
        MatterItemDispatchState.AWAITING_INPUT.value,
    ],
)
def test_owner_can_cancel_from_every_active_state(service, state):
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]
    if state != MatterItemDispatchState.QUEUED.value:
        service.mark_dispatch_started(dispatch_id, async_job_id=1)
    if state == MatterItemDispatchState.AWAITING_INPUT.value:
        service.deliver_dispatch(dispatch_id, question={"question": "缺一份合同号"})

    result = service.cancel_dispatch(public_id, dispatch_id, **_mutation("c-1"))

    assert result["dispatch"]["state"] == MatterItemDispatchState.CANCELED.value
    assert result["dispatch"]["ended_at"] == NOW
    # 取消要把悬着的问题一起收掉，否则例外面还会显示「等你回答」。
    assert result["dispatch"]["question"] is None
    assert (ITEM_DISPATCH_CANCELED, item_id, dispatch_id) in _events(service, public_id)


# ── 状态机：非法迁移一律拒 ──────────────────────────────────────────────────────


def test_answering_a_dispatch_that_is_not_waiting_is_refused(service):
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]

    with pytest.raises(MatterError) as excinfo:
        service.answer_dispatch(public_id, dispatch_id, text="随便", **_mutation("a-1"))
    assert excinfo.value.code == "E_INVALID_STATE"


def test_delivering_from_a_state_other_than_running_is_refused(service):
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]

    # queued 上交付 = agent 没经 claim 就自称跑完了 —— 不信自述。
    with pytest.raises(MatterError) as excinfo:
        service.deliver_dispatch(dispatch_id, question={"question": "?"})
    assert excinfo.value.code == "E_INVALID_STATE"


def test_a_proposed_dispatch_cannot_be_cancelled_directly(service):
    """`proposed` 的逆操作是**驳回提案**（带理由留档），不是取消 —— 两条路会让同一件事
    有两种记录形态。"""
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]
    service.mark_dispatch_started(dispatch_id, async_job_id=1)
    service.deliver_dispatch(
        dispatch_id, update_id=_insert_delivered_update(service, public_id, dispatch_id)
    )

    with pytest.raises(MatterError) as excinfo:
        service.cancel_dispatch(public_id, dispatch_id, **_mutation("c-1"))
    assert excinfo.value.code == "E_INVALID_STATE"


def test_a_terminal_dispatch_refuses_every_further_transition(service):
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]
    service.cancel_dispatch(public_id, dispatch_id, **_mutation("c-1"))

    assert service.mark_dispatch_started(dispatch_id, async_job_id=9) is False
    assert service.fail_dispatch(dispatch_id, code="whatever") is False
    with pytest.raises(MatterError):
        service.cancel_dispatch(public_id, dispatch_id, **_mutation("c-2"))
    with pytest.raises(MatterError):
        service.answer_dispatch(public_id, dispatch_id, text="x", **_mutation("a-1"))


def test_claiming_twice_only_wins_once(service):
    """并发 claim：CAS 的 rowcount 裁决，输的一方拿到 False（不抛）——
    worker 据此收敛自己那个 job，而不是两个 worker 同时跑同一次派发。"""
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]

    assert service.mark_dispatch_started(dispatch_id, async_job_id=1) is True
    assert service.mark_dispatch_started(dispatch_id, async_job_id=2) is False
    assert service.list_dispatches(public_id)[0]["async_job_id"] == 1


def test_deliver_takes_exactly_one_of_changes_or_question(service):
    """🔴 分支约束在 Python 判（D11）：schema 顶层放 oneOf 两次把整条工具链打瘫过。"""
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]
    service.mark_dispatch_started(dispatch_id, async_job_id=1)

    with pytest.raises(MatterError) as neither:
        service.deliver_dispatch(dispatch_id)
    assert neither.value.code == "E_INVALID_ARG"
    with pytest.raises(MatterError) as both:
        service.deliver_dispatch(dispatch_id, update_id=1, question={"question": "?"})
    assert both.value.code == "E_INVALID_ARG"
    # 空问题同样拒：一张写着「等你回答」却没有问题的卡片比没有更糟。
    with pytest.raises(MatterError) as empty:
        service.deliver_dispatch(dispatch_id, question={"question": "   "})
    assert empty.value.code == "E_INVALID_ARG"


def test_an_empty_answer_is_refused(service):
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]
    service.mark_dispatch_started(dispatch_id, async_job_id=1)
    service.deliver_dispatch(dispatch_id, question={"question": "合同号是多少？"})

    with pytest.raises(MatterError) as excinfo:
        service.answer_dispatch(public_id, dispatch_id, text="   ", **_mutation("a-1"))
    assert excinfo.value.code == "E_INVALID_ARG"


def test_answer_replay_does_not_start_a_third_round(service, tmp_path):
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]
    service.mark_dispatch_started(dispatch_id, async_job_id=1)
    service.deliver_dispatch(dispatch_id, question={"question": "合同号是多少？"})
    first = service.answer_dispatch(
        public_id, dispatch_id, text="C-2026-118", **_mutation("a-1")
    )

    again = service.answer_dispatch(
        public_id, dispatch_id, text="C-2026-118", **_mutation("a-1")
    )

    assert again["dispatch"]["attempt_count"] == first["dispatch"]["attempt_count"] == 2
    assert len(again["dispatch"]["answers"]) == 1
    assert len(_jobs(tmp_path / "dispatch.db")) == 2


# ── enqueue 失败 / 孤儿收敛 ─────────────────────────────────────────────────────


class _BoomJobRepo:
    """enqueue 恒炸的 job 仓（磁盘满 / 库锁死的等价物）。"""

    def enqueue(self, **_kwargs):
        raise RuntimeError("disk is on fire")

    def mark_terminal(self, *_args, **_kwargs):
        return False


def test_enqueue_failure_converges_the_dispatch_to_failed(tmp_path):
    """🔴 事务外 enqueue 失败必须收敛：留一个悬挂的 queued 派发 = 那条行动项从此派不动了
    （单活跃索引占着坑），而没有任何人看得出来为什么。"""
    path = tmp_path / "dispatch.db"
    SyncStore(str(path))
    service = MatterService(
        MatterRepository(path), clock_ms=lambda: NOW, job_repo=_BoomJobRepo()
    )
    public_id, item_id = _seed(service)

    with pytest.raises(MatterError) as excinfo:
        service.dispatch_item(public_id, item_id, **_mutation("d-1"))
    assert excinfo.value.code == "E_INTERNAL"

    dispatch = service.list_dispatches(public_id)[0]
    assert dispatch["state"] == MatterItemDispatchState.FAILED.value
    assert dispatch["ended_at"] == NOW
    assert dispatch["error"]["code"] == "E_ENQUEUE_FAILED"
    # 收敛之后这条行动项可以重派 —— 单活跃索引没被一个死行占住。
    assert service.repository is not None
    with service.repository.connect() as conn:
        assert service.repository.get_active_dispatch(conn, item_id) is None


def test_orphaned_dispatches_converge_to_failed_and_are_never_requeued(service, tmp_path):
    public_id, item_id = _seed(service)
    dispatch = service.dispatch_item(public_id, item_id, **_mutation("d-1"))["dispatch"]
    service.mark_dispatch_started(dispatch["id"], async_job_id=dispatch["async_job_id"])
    with sqlite3.connect(tmp_path / "dispatch.db") as conn:
        conn.execute(
            "UPDATE async_jobs SET status='failed' WHERE job_id=?",
            (dispatch["async_job_id"],),
        )
        conn.commit()

    assert service.recover_orphaned_dispatches() == 1

    converged = service.list_dispatches(public_id)[0]
    assert converged["state"] == MatterItemDispatchState.FAILED.value
    assert converged["error"] == {"code": "claim_expired"}
    assert (ITEM_DISPATCH_FAILED, item_id, dispatch["id"]) in _events(service, public_id)
    # 🔴 LLM run 非幂等 —— 收敛过的孤儿绝不重放，也绝不再收敛第二次。
    assert service.recover_orphaned_dispatches() == 0
    assert len(_jobs(tmp_path / "dispatch.db")) == 1


def test_a_healthy_running_dispatch_is_not_treated_as_an_orphan(service):
    public_id, item_id = _seed(service)
    dispatch = service.dispatch_item(public_id, item_id, **_mutation("d-1"))["dispatch"]
    service.mark_dispatch_started(dispatch["id"], async_job_id=dispatch["async_job_id"])

    assert service.recover_orphaned_dispatches() == 0
    assert (
        service.list_dispatches(public_id)[0]["state"]
        == MatterItemDispatchState.RUNNING.value
    )


# ── 执行档（per-行动项，派发时冻结）──────────────────────────────────────────────


def test_exec_profile_is_frozen_into_the_dispatch_at_hand_off(service):
    public_id, item_id = _seed(service, exec_profile="autonomous")
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]

    # owner 事后改了行动项的默认档 —— 已经在跑的这一轮仍按冻结那档结算。
    version = _version(service, public_id)
    service.update_item(
        public_id,
        item_id,
        {"exec_profile": "propose_only"},
        expected_version=version,
        **_mutation("p-1"),
    )

    assert service.list_dispatches(public_id)[0]["exec_profile"] == "autonomous"
    assert service.list_items(public_id)[0]["exec_profile"] == "propose_only"


def test_an_explicit_profile_argument_wins_over_the_item_default(service):
    public_id, item_id = _seed(service, exec_profile="autonomous")

    result = service.dispatch_item(
        public_id, item_id, profile="propose_only", **_mutation("d-1")
    )

    assert result["dispatch"]["exec_profile"] == "propose_only"


@pytest.mark.parametrize("profile", ["", "yolo", "autonomus"])
def test_a_profile_outside_the_vocabulary_is_refused(service, profile):
    public_id, item_id = _seed(service)

    with pytest.raises(MatterError) as excinfo:
        service.dispatch_item(public_id, item_id, profile=profile, **_mutation("d-1"))
    assert excinfo.value.code == "E_INVALID_ARG"


def test_a_non_action_item_cannot_carry_an_exec_profile(service):
    matter = service.create_matter({"title": "T"}, **_mutation("seed-matter"))
    public_id = str(matter["matter"]["public_id"])

    with pytest.raises(MatterError) as excinfo:
        service.create_item(
            public_id,
            {"kind": "note", "title": "备注", "exec_profile": "autonomous"},
            expected_version=matter["version"],
            **_mutation("seed-item"),
        )
    assert excinfo.value.code == "E_INVALID_ARG"


def test_undoing_a_profile_change_restores_the_previous_one(service):
    """🔴 D15：新增可写字段漏进 undo 前像名单 = 「撤销成功但那个字段一动不动」。"""
    public_id, item_id = _seed(service, exec_profile="propose_only")
    version = _version(service, public_id)

    changed = service.update_item(
        public_id,
        item_id,
        {"exec_profile": "autonomous"},
        expected_version=version,
        **_mutation("p-1"),
    )

    assert changed["undo"]["input"]["patch"] == {"exec_profile": "propose_only"}


# ── 跨事项读面（/today 例外面第四源）────────────────────────────────────────────


def test_the_global_read_surface_only_carries_what_needs_a_human(service):
    public_id, item_id = _seed(service)
    waiting_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]
    service.mark_dispatch_started(waiting_id, async_job_id=1)
    service.deliver_dispatch(waiting_id, question={"question": "合同号是多少？"})

    second = service.create_item(
        public_id,
        {"kind": "action", "title": "催合规回执"},
        expected_version=_version(service, public_id),
        **_mutation("seed-item-2"),
    )
    running_id = service.dispatch_item(
        public_id, int(second["item"]["id"]), **_mutation("d-2")
    )["dispatch"]["id"]
    service.mark_dispatch_started(running_id, async_job_id=2)

    items = service.list_live_item_dispatches()["items"]

    # 默认两态 = 等我回答 / 挂了。running 不进面（正在跑的事不需要我处理）。
    assert [entry["id"] for entry in items] == [waiting_id]
    entry = items[0]
    # 例外面一行要说清「哪件事的哪条行动项在等我」—— 缺一个就得再发一轮请求。
    assert entry["matter_public_id"] == public_id
    assert entry["item_title"] == "回签补充协议"
    assert entry["question"]["question"] == "合同号是多少？"

    # 🔴 `failed` 是终态（写了 ended_at）却必须进面 —— 例外面最要紧的就是「挂掉了」那一半。
    service.fail_dispatch(running_id, code="no_report")
    assert {entry["id"] for entry in service.list_live_item_dispatches()["items"]} == {
        waiting_id,
        running_id,
    }


def test_only_the_latest_dispatch_of_an_item_reaches_the_exception_surface(service):
    """重派之后旧的 failed 行还在库里（派发史逐行留下）—— 不去重会让同一条行动项在例外面
    上出现两遍：一遍写着「挂了」、一遍写着「在等你」。"""
    public_id, item_id = _seed(service)
    stale_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))["dispatch"][
        "id"
    ]
    service.fail_dispatch(stale_id, code="no_report")

    fresh_id = service.dispatch_item(public_id, item_id, **_mutation("d-2"))["dispatch"][
        "id"
    ]
    service.mark_dispatch_started(fresh_id, async_job_id=2)
    service.deliver_dispatch(fresh_id, question={"question": "合同号是多少？"})

    assert [entry["id"] for entry in service.list_live_item_dispatches()["items"]] == [
        fresh_id
    ]


def test_the_global_read_surface_skips_archived_and_trashed_matters(service):
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(public_id, item_id, **_mutation("d-1"))[
        "dispatch"
    ]["id"]
    service.mark_dispatch_started(dispatch_id, async_job_id=1)
    service.deliver_dispatch(dispatch_id, question={"question": "?"})

    service.archive(
        public_id, expected_version=_version(service, public_id),
        **_mutation("arch-1"),
    )

    assert service.list_live_item_dispatches()["items"] == []


def test_an_unknown_state_filter_is_refused(service):
    with pytest.raises(MatterError) as excinfo:
        service.list_live_item_dispatches(states=["ghost"])
    assert excinfo.value.code == "E_INVALID_ARG"


# ── 数据库最终防线 ─────────────────────────────────────────────────────────────


def test_the_partial_unique_index_is_the_last_line_of_defence(service, tmp_path):
    """service 的存在性检查之外还有一层：直接写库也塞不进第二个活跃派发。"""
    public_id, item_id = _seed(service)
    service.dispatch_item(public_id, item_id, **_mutation("d-1"))

    with sqlite3.connect(tmp_path / "dispatch.db") as conn:
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            conn.execute(
                "INSERT INTO matter_item_dispatch (matter_id, item_id, state, executor_kind, "
                "executor_id, exec_profile, created_by_kind, dispatched_at, created_at, updated_at) "
                "VALUES (1, ?, 'queued', 'agent', 'matter_followup', 'propose_only', 'user', "
                "1800000000000, 1, 2)",
                (item_id,),
            )


def test_dispatch_rows_go_away_with_the_item(service, tmp_path):
    """FK 是 ON DELETE CASCADE —— 行动项被硬删时派发史一起没（软删不受影响）。"""
    public_id, item_id = _seed(service)
    service.dispatch_item(public_id, item_id, **_mutation("d-1"))

    with sqlite3.connect(tmp_path / "dispatch.db") as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("DELETE FROM matter_item WHERE id=?", (item_id,))
        conn.commit()
        assert (
            conn.execute("SELECT COUNT(*) FROM matter_item_dispatch").fetchone()[0] == 0
        )


def test_the_agent_actor_is_stamped_server_side_on_delivery(service):
    """交付事件的 actor 是服务端从派发行盖章的 —— 调用方结构上伪造不了「这是人写的」。"""
    public_id, item_id = _seed(service)
    dispatch_id = service.dispatch_item(
        public_id, item_id, **_mutation("d-1", actor=Actor(kind="user", actor_id=None))
    )["dispatch"]["id"]
    service.mark_dispatch_started(dispatch_id, async_job_id=1)
    service.deliver_dispatch(dispatch_id, question={"question": "?"})

    timeline = service.timeline(public_id, cursor=None, limit=10)["items"]
    delivered = next(e for e in timeline if e["kind"] == ITEM_DISPATCH_DELIVERED)
    assert (delivered["actor_kind"], delivered["actor_id"]) == ("agent", "matter_followup")
