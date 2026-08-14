"""资料摘要数据链（v56，H3§6）+ `upsert_resource` 增量更新白名单（批 M4）。

盯三件事：
① 三类来源的落库语义 —— 邮件/会话恒复用邮件自带 ai_summary（`sum_src='mail'`，
   不重新生成、caller 给的 sum 被忽略）；无摘要留空走空态（不合成不编造）；
   非邮件 provider 吃 caller 显式给的 sum（Agent 提案落库通道，M6 接线）。
② INSERT-ONLY 修复 —— 后到的摘要能写进**已存在**的资料行（re-link 触发惰性回填）。
③ 更新白名单 —— re-link 不许冲掉 owner 侧字段（access_policy / 既有 title）、
   不许丢 metadata 既有键（URL 缓存同款保护）、不许把已有摘要冲成 NULL。
"""

from __future__ import annotations

import json

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterError, MatterService

CLOCK_MS = 1_800_000_000_000
LLM_UPDATED_AT = 1_754_000_000.5  # REAL 秒（llm_processing 的时间基）


@pytest.fixture
def service(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(path), clock_ms=lambda: CLOCK_MS)


def _mutation(version: int, key: str):
    return {"expected_version": version, "idempotency_key": key, "source": "desktop_ui"}


def _create(service: MatterService, key: str, title: str = "Matter"):
    return service.create_matter({"title": title}, idempotency_key=key, source="desktop_ui")


def _seed_email(
    service: MatterService,
    internal_id: int,
    *,
    thread_id: str | None = None,
    date_received: str = "2026-08-11T00:00:00Z",
    ai_summary: str | None = None,
) -> None:
    with service.repository.transaction() as conn:
        conn.execute(
            "INSERT INTO email_metadata(internal_id,message_id,thread_id,subject,date_received) "
            "VALUES (?,?,?,?,?)",
            (internal_id, f"msg-{internal_id}", thread_id, f"Subject {internal_id}", date_received),
        )
        if ai_summary is not None:
            conn.execute(
                "INSERT INTO llm_processing(internal_id,status,labels_json,created_at,updated_at) "
                "VALUES (?,?,?,?,?)",
                (
                    internal_id,
                    "success",
                    json.dumps({"ai_summary": ai_summary, "priority": "normal"}),
                    LLM_UPDATED_AT,
                    LLM_UPDATED_AT,
                ),
            )


def _link_email(service: MatterService, public_id: str, version: int, internal_id: int, *, key: str, scope: str = "single"):
    return service.add_resource(
        public_id,
        {
            "source_resource": {
                "provider": "mailagent",
                "kind": "email",
                "internal_id": internal_id,
                "link_scope": scope,
            }
        },
        **_mutation(version, key),
    )


def _resource_by_key(result, external_key: str):
    for item in result["resources"]:
        if item["resource"]["external_key"] == external_key:
            return item["resource"]
    raise AssertionError(f"resource {external_key} not in result")


def test_email_link_carries_mail_summary_with_generation_timestamp(service):
    _seed_email(service, 101, ai_summary="客户确认了交付时间。")
    created = _create(service, "m1")
    linked = _link_email(service, created["matter"]["public_id"], created["version"], 101, key="l1")
    resource = _resource_by_key(linked, "email:101")
    assert resource["sum"] == "客户确认了交付时间。"
    assert resource["sum_src"] == "mail"
    # sum_at = 摘要真实生成时刻（llm 行 updated_at 秒→毫秒），不是关联时刻。
    assert resource["sum_at"] == int(LLM_UPDATED_AT * 1000)


def test_email_without_ai_summary_stays_empty_no_synthesis(service):
    """LLM 未跑/无摘要 → 空态。不合成、不回退主题+正文（owner 拍板 + H3「不得编造」）。"""
    _seed_email(service, 102, ai_summary=None)
    created = _create(service, "m2")
    linked = _link_email(service, created["matter"]["public_id"], created["version"], 102, key="l2")
    resource = _resource_by_key(linked, "email:102")
    assert resource["sum"] is None
    assert resource["sum_src"] is None
    assert resource["sum_at"] is None


def test_thread_resource_takes_latest_thread_summary(service):
    """会话摘要 = 线程内最新一封带摘要邮件的 ai_summary（H3§6.1「最新一次会话摘要」）。"""
    _seed_email(service, 201, thread_id="T1", date_received="2026-08-01T00:00:00Z", ai_summary="旧一轮讨论。")
    _seed_email(service, 202, thread_id="T1", date_received="2026-08-02T00:00:00Z", ai_summary="最新结论。")
    created = _create(service, "m3")
    linked = _link_email(
        service, created["matter"]["public_id"], created["version"], 201, key="l3", scope="thread"
    )
    assert _resource_by_key(linked, "email:201")["sum"] == "旧一轮讨论。"
    assert _resource_by_key(linked, "thread:T1")["sum"] == "最新结论。"
    assert _resource_by_key(linked, "thread:T1")["sum_src"] == "mail"


def test_relink_backfills_summary_into_existing_resource(service):
    """INSERT-ONLY 修复的核心断言：先关联（当时无摘要）→ LLM 后补摘要 →
    再触到同一份资料时，**存量行**被惰性回填。"""
    _seed_email(service, 301, ai_summary=None)
    m_a = _create(service, "m4a", title="Matter A")
    linked_a = _link_email(service, m_a["matter"]["public_id"], m_a["version"], 301, key="l4a")
    assert _resource_by_key(linked_a, "email:301")["sum"] is None

    with service.repository.transaction() as conn:
        conn.execute(
            "INSERT INTO llm_processing(internal_id,status,labels_json,created_at,updated_at) "
            "VALUES (301,'success',?,?,?)",
            (json.dumps({"ai_summary": "补跑出的摘要。"}), LLM_UPDATED_AT, LLM_UPDATED_AT),
        )

    m_b = _create(service, "m4b", title="Matter B")
    _link_email(service, m_b["matter"]["public_id"], m_b["version"], 301, key="l4b")

    refreshed = service.list_resources(m_a["matter"]["public_id"])
    assert refreshed[0]["resource"]["sum"] == "补跑出的摘要。"
    assert refreshed[0]["resource"]["sum_src"] == "mail"


def test_relink_does_not_clobber_owner_fields_or_summary(service):
    """更新白名单的反面：re-link 不动 access_policy / 既有 title；
    metadata_only 的资料停止更新摘要（H3§5.3）。"""
    created = _create(service, "m5")
    public_id = created["matter"]["public_id"]
    linked = service.add_resource(
        public_id,
        {"provider": "x", "external_key": "doc:1", "kind": "doc", "title": "Original"},
        **_mutation(created["version"], "l5"),
    )
    resource_id = linked["resources"][0]["resource"]["id"]
    service.patch_resource(
        public_id,
        resource_id,
        {"scope": "resource", "access_policy": "metadata_only"},
        **_mutation(linked["version"], "policy"),
    )

    m_b = _create(service, "m5b", title="Matter B")
    relinked = service.add_resource(
        m_b["matter"]["public_id"],
        {
            "provider": "x", "external_key": "doc:1", "kind": "doc",
            "title": "Other title", "sum": "Agent text", "sum_src": "agent",
        },
        **_mutation(m_b["version"], "l5b"),
    )
    resource = relinked["resources"][0]["resource"]
    assert resource["title"] == "Original"
    assert resource["access_policy"] == "metadata_only"
    assert resource["sum"] is None  # 仅元数据：不生成、不更新


def test_relink_fills_missing_title_and_merges_metadata(service):
    """title 只补空；metadata 浅合并不丢既有键（URL 缓存同款保护）。"""
    created = _create(service, "m6")
    public_id = created["matter"]["public_id"]
    linked = service.add_resource(
        public_id,
        {"provider": "x", "external_key": "doc:2", "kind": "doc", "metadata": {"a": 1}},
        **_mutation(created["version"], "l6"),
    )
    resource_id = linked["resources"][0]["resource"]["id"]
    assert linked["resources"][0]["resource"]["title"] is None
    with service.repository.transaction() as conn:
        conn.execute(
            "UPDATE resource SET metadata_json=? WHERE id=?",
            (json.dumps({"a": 1, "cached_excerpt": "cached text"}), resource_id),
        )

    m_b = _create(service, "m6b", title="Matter B")
    relinked = service.add_resource(
        m_b["matter"]["public_id"],
        {
            "provider": "x", "external_key": "doc:2", "kind": "doc",
            "title": "Filled later", "metadata": {"b": 2, "a": None},
        },
        **_mutation(m_b["version"], "l6b"),
    )
    resource = relinked["resources"][0]["resource"]
    assert resource["title"] == "Filled later"
    # 既有键保留（None 不冲掉 a=1）、新键补进。
    assert resource["metadata"] == {"a": 1, "cached_excerpt": "cached text", "b": 2}


def test_agent_provided_summary_lands_for_non_mail_provider(service):
    """Agent 发现资料的落库通道（M6 从提案 schema 接 `summary` → 这里的 `sum`）。"""
    created = _create(service, "m7")
    linked = service.add_resource(
        created["matter"]["public_id"],
        {
            "provider": "notion", "external_key": "page:abc", "kind": "doc",
            "sum": "  这份页面记录了排期结论。  ", "sum_src": "agent",
        },
        **_mutation(created["version"], "l7"),
    )
    resource = linked["resources"][0]["resource"]
    assert resource["sum"] == "这份页面记录了排期结论。"
    assert resource["sum_src"] == "agent"
    assert resource["sum_at"] == CLOCK_MS  # 未显式给 → 本次写入时刻


def test_invalid_sum_src_is_rejected(service):
    created = _create(service, "m8")
    with pytest.raises(MatterError) as exc:
        service.add_resource(
            created["matter"]["public_id"],
            {
                "provider": "notion", "external_key": "page:bad", "kind": "doc",
                "sum": "text", "sum_src": "synthesized",
            },
            **_mutation(created["version"], "l8"),
        )
    assert exc.value.code == "E_INVALID_ARG"


def test_caller_sum_is_ignored_for_mail_kinds(service):
    """邮件类不重新生成（H3§6.1）：caller 给的 sum 被忽略，邮件侧无摘要就是空态。"""
    _seed_email(service, 401, ai_summary=None)
    created = _create(service, "m9")
    linked = service.add_resource(
        created["matter"]["public_id"],
        {
            "provider": "mailagent", "external_key": "email:401", "kind": "email",
            "sum": "模型编的", "sum_src": "agent",
        },
        **_mutation(created["version"], "l9"),
    )
    resource = linked["resources"][0]["resource"]
    assert resource["sum"] is None
    assert resource["sum_src"] is None
