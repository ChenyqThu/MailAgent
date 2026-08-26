"""行动项派发 run 的**执行链**（task 08-25 批次 3，Lane 2）。

两半，都只钉服务端说了算的东西：

1. **spec 组装**（`assemble_item_spec`）—— 工具面恒 toolless（`allowedTools` 恒 `[]`、
   `grantExec` 永不写）、锚字段服务端盖章、行动项全文与既往问答史进 prompt、
   执行器是 custom agent 时**只取模型段**（工具面不继承 —— 契约挂行动项不挂 agent）；
2. **交付**（`report_item_dispatch`）—— changes/summary 与 needs_input 二选一且必居其一、
   越界 change 一律剔除、状态迁移走 CAS（重复交付撞 `E_INVALID_STATE`）、
   autonomous 档走既有 accept 内核自动采纳。
"""

from __future__ import annotations

import sqlite3
from types import SimpleNamespace

import pytest

from src.mail.sync_store import SyncStore
from src.matters.models import MatterItemDispatchState, MatterItemExecProfile
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.matters.run_spec import (
    MATTER_FOLLOWUP_MAX_RUN_SECONDS,
    MATTER_FOLLOWUP_SKILLS,
    MATTER_FOLLOWUP_WEB_GRANT,
    MATTER_ITEM_RUN_KIND,
    PERSONA_PREFIX,
    assemble_item_spec,
)
from src.matters.service import MatterError
from src.reports.store import ReportStore
from src.sync.async_jobs import AsyncJobRepository


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "item-run.db"
    SyncStore(str(path))
    service = MatterRunService(MatterRepository(path))
    settings = SimpleNamespace(sync_store_db_path=str(path))
    return SimpleNamespace(
        path=path,
        service=service,
        settings=settings,
        jobs=AsyncJobRepository(str(path)),
    )


def _mutation(key: str) -> dict[str, object]:
    return {"idempotency_key": key, "source": "desktop_ui"}


def _seed_item(env, **item_fields) -> tuple[str, int]:
    matter = env.service.create_matter({"title": "NexPay 二期"}, **_mutation("m"))
    public_id = str(matter["matter"]["public_id"])
    item = env.service.create_item(
        public_id,
        {"kind": "action", "title": "回签补充协议", **item_fields},
        expected_version=matter["version"],
        **_mutation("i"),
    )
    return public_id, int(item["item"]["id"])


def _dispatch(env, public_id: str, item_id: int, *, key="d1", **kwargs) -> dict:
    return env.service.dispatch_item(
        public_id, item_id, **kwargs, **_mutation(key)
    )["dispatch"]


def _claim(env):
    job = env.jobs.claim_next(types=env.jobs.AGENT_JOB_TYPES)
    assert job is not None
    return job


def _start(env, public_id: str, item_id: int, *, key="d1", **kwargs) -> tuple[dict, object]:
    """派发 → 认领 job → CAS 成 running（worker 那三步的测试替身）。"""
    dispatch = _dispatch(env, public_id, item_id, key=key, **kwargs)
    job = _claim(env)
    assert env.service.mark_dispatch_started(int(dispatch["id"]), async_job_id=job.job_id)
    return dispatch, job


def _state(env, dispatch_id: int) -> str:
    with env.service.repository.connect() as conn:
        return str(env.service.repository.get_dispatch(conn, dispatch_id)["state"])


def _row(env, dispatch_id: int) -> dict:
    with env.service.repository.connect() as conn:
        return env.service.repository.get_dispatch(conn, dispatch_id)


# ── spec 组装 ────────────────────────────────────────────────────────────────


def test_item_spec_is_toolless_and_server_anchored(env):
    public_id, item_id = _seed_item(env)
    dispatch, job = _start(env, public_id, item_id)

    spec = assemble_item_spec(job, settings=env.settings)

    assert spec["runKind"] == MATTER_ITEM_RUN_KIND
    # 🔴 三处强制里的第一处：Python 组装侧恒投空名单，且**永不**写 grantExec。
    assert spec["toolPolicy"]["allowedTools"] == []
    assert "grantExec" not in spec["toolPolicy"]
    assert spec["toolPolicy"]["skills"] == list(MATTER_FOLLOWUP_SKILLS)
    assert spec["toolPolicy"]["grantWeb"] == MATTER_FOLLOWUP_WEB_GRANT
    assert spec["budget"] == {"maxRunSeconds": MATTER_FOLLOWUP_MAX_RUN_SECONDS}
    # 锚字段：模型的入参 schema 里一个 id 都没有，全靠这份 spec 盖章。
    with env.service.repository.connect() as conn:
        matter_id = int(env.service.repository.get_matter(conn, public_id)["id"])
    assert spec["matterItem"] == {
        "matterId": matter_id,
        "publicId": public_id,
        "matterTitle": "NexPay 二期",
        "itemId": item_id,
        "itemTitle": "回签补充协议",
        "dispatchId": int(dispatch["id"]),
    }
    assert spec["sessionTitle"] == "行动项 · 回签补充协议"


def test_item_spec_carries_the_item_full_text_and_its_contract(env):
    public_id, item_id = _seed_item(
        env,
        description="对方法务 8/20 提了两处修改",
        status="in_progress",
        checklist=[{"id": "c1", "text": "核对付款条款", "done": True}],
    )
    _, job = _start(env, public_id, item_id)

    prompt = assemble_item_spec(job, settings=env.settings)["prompt"]["taskPrompt"]

    assert "【这条行动项】" in prompt
    assert f"item_id: {item_id}" in prompt
    assert "对方法务 8/20 提了两处修改" in prompt
    assert "in_progress" in prompt
    assert "[x] 核对付款条款" in prompt
    # 契约的三条边界必须在场（少一条 = 模型会去做它做不到的事）。
    assert "matter_item_report" in prompt
    assert "needs_input" in prompt
    assert "没有任何写工具" in prompt
    # 事项快照仍然在（判断这条行动项要做什么，得先知道整件事是什么）。
    assert "【事项快照】" in prompt


def test_item_spec_replays_the_question_and_answer_history(env):
    public_id, item_id = _seed_item(env)
    dispatch, _ = _start(env, public_id, item_id)
    dispatch_id = int(dispatch["id"])
    env.service.deliver_dispatch(
        dispatch_id, question={"question": "按哪一版报价？", "options": ["8/1 版", "8/12 版"]}
    )
    env.service.answer_dispatch(
        public_id, dispatch_id, text="按 8/12 版", **_mutation("a1")
    )
    second = _claim(env)
    assert env.service.mark_dispatch_started(dispatch_id, async_job_id=second.job_id)

    prompt = assemble_item_spec(second, settings=env.settings)["prompt"]["taskPrompt"]

    # 🔴 「反问是终止式」的解药：问答落在派发行上，下一轮整份带回来。
    assert "【已问过的问题】" in prompt
    assert "按哪一版报价？" in prompt
    assert "按 8/12 版" in prompt


def test_item_spec_takes_only_the_model_from_a_custom_executor(env):
    ReportStore(str(env.path)).create_agent(
        "profile-1",
        type="custom",
        enabled=True,
        title="合同盯梢",
        prompt="你说话简洁。",
        model="anthropic:claude-x",
    )
    # 这个 agent 自己带着一身写权限：spec 里一个键都不该出现（它只贡献模型与人设）。
    with sqlite3.connect(str(env.path)) as conn:
        conn.execute(
            "UPDATE report_agent SET tool_policy_json=? WHERE id='profile-1'",
            ('{"allowedTools": ["email_prepare_send"], "grantExec": true}',),
        )
    public_id, item_id = _seed_item(env)
    _, job = _start(env, public_id, item_id, executor_id="profile-1")

    spec = assemble_item_spec(job, settings=env.settings)

    assert spec["model"] == "anthropic:claude-x"
    assert spec["agentId"] == "profile-1"
    assert spec["agentTitle"] == "合同盯梢"
    assert PERSONA_PREFIX in spec["prompt"]["taskPrompt"]
    assert "你说话简洁。" in spec["prompt"]["taskPrompt"]
    # 🔴 工具面**一个键都不继承** —— 契约挂行动项不挂 agent。
    assert spec["toolPolicy"]["allowedTools"] == []
    assert "grantExec" not in spec["toolPolicy"]


def test_item_spec_fails_closed_on_a_broken_context(env):
    public_id, item_id = _seed_item(env)
    _, job = _start(env, public_id, item_id)
    env.service.delete_item(
        public_id,
        item_id,
        expected_version=env.service.get_matter(public_id)["matter"]["version"],
        **_mutation("del"),
    )

    with pytest.raises(MatterError) as exc:
        assemble_item_spec(job, settings=env.settings)
    assert exc.value.code == "E_SPEC_AGENT_INVALID"


# ── 交付（report）────────────────────────────────────────────────────────────


def test_report_needs_input_parks_the_dispatch_on_the_owner(env):
    public_id, item_id = _seed_item(env)
    dispatch, _ = _start(env, public_id, item_id)
    dispatch_id = int(dispatch["id"])

    result = env.service.report_item_dispatch(
        public_id,
        dispatch_id,
        {"needs_input": {"question": "用哪个签署主体？", "options": ["A 公司", "B 公司"]}},
    )

    assert result["state"] == MatterItemDispatchState.AWAITING_INPUT.value
    assert result["update_id"] is None
    row = _row(env, dispatch_id)
    assert row["question"] == {
        "question": "用哪个签署主体？",
        "options": ["A 公司", "B 公司"],
    }
    assert row["awaiting_since"] is not None


def test_report_result_lands_a_pending_proposal_paired_with_the_dispatch(env):
    public_id, item_id = _seed_item(env)
    dispatch, _ = _start(env, public_id, item_id)
    dispatch_id = int(dispatch["id"])

    result = env.service.report_item_dispatch(
        public_id,
        dispatch_id,
        {
            "summary": "对方已回签，等归档。",
            "changes": [
                {
                    "id": "chg_01",
                    "kind": "action",
                    "target": {"entity": "item", "id": item_id},
                    "after": "done",
                }
            ],
        },
    )

    assert result["state"] == MatterItemDispatchState.PROPOSED.value
    assert result["dropped"] == []
    assert result["accepted"] is False
    update = env.service.get_update_detail(public_id, result["update_id"])["update"]
    assert update["review_status"] == "pending"
    # 🔴 配对列就是 accept/reject 回钩认的那一列。
    assert update["item_dispatch_id"] == dispatch_id
    assert _row(env, dispatch_id)["update_id"] == result["update_id"]


def test_report_rejects_both_shapes_and_neither(env):
    public_id, item_id = _seed_item(env)
    dispatch, _ = _start(env, public_id, item_id)
    dispatch_id = int(dispatch["id"])

    with pytest.raises(MatterError) as both:
        env.service.report_item_dispatch(
            public_id,
            dispatch_id,
            {"summary": "写了一半", "needs_input": {"question": "还有个问题"}},
        )
    assert both.value.code == "E_INVALID_ARG"

    with pytest.raises(MatterError) as neither:
        env.service.report_item_dispatch(public_id, dispatch_id, {"changes": []})
    assert neither.value.code == "E_INVALID_ARG"
    # 两次都拒 ⇒ 派发一步没动，模型还能在同一轮里改对再报。
    assert _state(env, dispatch_id) == MatterItemDispatchState.RUNNING.value


def test_report_drops_changes_outside_this_item(env):
    public_id, item_id = _seed_item(env)
    other = env.service.create_item(
        public_id,
        {"kind": "action", "title": "另一条"},
        expected_version=env.service.get_matter(public_id)["matter"]["version"],
        **_mutation("i2"),
    )["item"]
    dispatch, _ = _start(env, public_id, item_id)
    dispatch_id = int(dispatch["id"])

    result = env.service.report_item_dispatch(
        public_id,
        dispatch_id,
        {
            "summary": "顺手想改一堆",
            "changes": [
                {
                    "id": "mine",
                    "kind": "action",
                    "target": {"entity": "item", "id": item_id},
                    "after": "done",
                },
                {"id": "new_sub", "kind": "action", "text": "拆一条子任务"},
                {
                    "id": "foreign",
                    "kind": "action",
                    "target": {"entity": "item", "id": int(other["id"])},
                    "after": "done",
                },
                {
                    "id": "matter_field",
                    "kind": "field",
                    "target": {"entity": "matter", "field": "status"},
                    "after": "done",
                },
            ],
        },
    )

    dropped = {entry["id"]: entry["reason"] for entry in result["dropped"]}
    assert dropped == {
        "foreign": "action_target_outside_dispatch",
        "matter_field": "change_kind_not_allowed_for_item_run",
    }
    kept = env.service.get_update_detail(public_id, result["update_id"])["update"]["changes"]
    assert [change["id"] for change in kept] == ["mine", "new_sub"]


def test_report_twice_in_one_attempt_is_rejected(env):
    public_id, item_id = _seed_item(env)
    dispatch, _ = _start(env, public_id, item_id)
    dispatch_id = int(dispatch["id"])
    env.service.report_item_dispatch(public_id, dispatch_id, {"summary": "第一次"})

    with pytest.raises(MatterError) as exc:
        env.service.report_item_dispatch(public_id, dispatch_id, {"summary": "第二次"})
    assert exc.value.code == "E_INVALID_STATE"


def test_report_requires_a_running_dispatch(env):
    public_id, item_id = _seed_item(env)
    dispatch = _dispatch(env, public_id, item_id)  # 只 queued，还没被认领

    with pytest.raises(MatterError) as exc:
        env.service.report_item_dispatch(
            public_id, int(dispatch["id"]), {"summary": "抢跑"}
        )
    assert exc.value.code == "E_INVALID_STATE"


def test_all_changes_dropped_leaves_the_dispatch_running_for_a_retry(env):
    public_id, item_id = _seed_item(env)
    dispatch, _ = _start(env, public_id, item_id)
    dispatch_id = int(dispatch["id"])

    result = env.service.report_item_dispatch(
        public_id,
        dispatch_id,
        {
            "changes": [
                {"id": "no_source", "kind": "fact", "text": "听说要涨价", "sources": []}
            ]
        },
    )

    assert result["update_id"] is None
    assert result["dropped"]
    # 「至多一次交付」说的是**成功**那一次：全剔之后模型还有一次改对的机会。
    assert _state(env, dispatch_id) == MatterItemDispatchState.RUNNING.value


def test_autonomous_profile_accepts_its_own_proposal(env):
    public_id, item_id = _seed_item(env)
    dispatch, _ = _start(
        env, public_id, item_id, profile=MatterItemExecProfile.AUTONOMOUS.value
    )
    dispatch_id = int(dispatch["id"])

    result = env.service.report_item_dispatch(
        public_id,
        dispatch_id,
        {
            "summary": "已回签。",
            "changes": [
                {
                    "id": "chg_01",
                    "kind": "action",
                    "target": {"entity": "item", "id": item_id},
                    "after": "done",
                }
            ],
        },
    )

    assert result["accepted"] is True
    assert result["state"] == MatterItemDispatchState.DONE.value
    # 走的是与 owner 点「接受」完全同一条路径：提案标 accepted、条目真的动了、派发结算。
    update = env.service.get_update_detail(public_id, result["update_id"])["update"]
    assert update["review_status"] == "accepted"
    items = env.service.list_items(public_id)
    assert [i["status"] for i in items if int(i["id"]) == item_id] == ["done"]
    row = _row(env, dispatch_id)
    assert row["state"] == MatterItemDispatchState.DONE.value
    assert row["ended_at"] is not None


def test_propose_only_profile_waits_for_the_owner(env):
    """出厂档：交付停在 proposed，条目一个字节都不动。"""
    public_id, item_id = _seed_item(env)
    dispatch, _ = _start(env, public_id, item_id)
    dispatch_id = int(dispatch["id"])

    result = env.service.report_item_dispatch(
        public_id,
        dispatch_id,
        {
            "summary": "已回签。",
            "changes": [
                {
                    "id": "chg_01",
                    "kind": "action",
                    "target": {"entity": "item", "id": item_id},
                    "after": "done",
                }
            ],
        },
    )

    assert result["accepted"] is False
    assert _state(env, dispatch_id) == MatterItemDispatchState.PROPOSED.value
    items = env.service.list_items(public_id)
    assert [i["status"] for i in items if int(i["id"]) == item_id] == ["open"]
