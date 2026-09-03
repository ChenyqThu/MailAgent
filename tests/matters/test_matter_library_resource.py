"""资料库文件挂进事项（design §9.2）：身份键 / 提案白名单 / 存在性回调 / 摘要与摘录。

四件事分别对应 design §9.2 的四段，测的是**行为**不是实现：

  1. ``library:{id}`` 与 ``attachment:{id}`` 同为 kind='file'、同一身份空间、靠前缀区分；
  2. 跟进 run 允许提议挂库文件（``_KINDS_BY_PROVIDER['mailagent']`` 收编 ``file``），
     但只收 ``library:`` 前缀 —— 邮件附件不在提案通道内；
  3. 存在性经**注入的 resolver 回调**判定：没注册回调 fail-closed（不崩、不放行），
     注册后能挡住模型编造的 file id；
  4. ``sum`` / ``metadata.cached_excerpt`` 由服务端填（frontmatter → 首 300 字 / 前 2000 字），
     agent 显式给的摘要优先。
"""

from __future__ import annotations

import pytest

from src.library.constants import RESOURCE_KEY_PREFIX
from src.mail.sync_store import SyncStore
from src.matters import resource_identity
from src.matters.repository import MatterRepository
from src.matters.resource_identity import (
    LIBRARY_EXCERPT_MAX_CHARS,
    LIBRARY_SUMMARY_FALLBACK_CHARS,
    library_resource_key,
    parse_library_resource_key,
    set_library_file_resolver,
)
from src.matters.resource_proposal import (
    REASON_KEY_INVALID,
    REASON_NOT_FOUND,
    ResourceProposalError,
    normalize_new_resource,
)
from src.matters.service import MatterService
from src.matters.url_fetch import URL_CACHE_TEXT_KEY

ALLOWED = frozenset({"mailagent"})


@pytest.fixture
def service(tmp_path):
    path = tmp_path / "matter-library.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(path), clock_ms=lambda: 1_000)


@pytest.fixture(autouse=True)
def _clear_resolver():
    """每条用例从「没注册回调」起步 —— 进程级注册表泄漏会让后一条用例假绿。"""
    set_library_file_resolver(None)
    yield
    set_library_file_resolver(None)


def install_resolver(files):
    """files: {file_id: {'summary':…, 'text':…}}；不在表里 = 引用不了。"""
    calls = []

    def resolver(file_id, *, with_text=False):
        calls.append((file_id, with_text))
        payload = files.get(int(file_id))
        if payload is None:
            return None
        return dict(payload) if with_text else {}

    set_library_file_resolver(resolver)
    return calls


def mutation(version: int, key: str):
    return {"expected_version": version, "idempotency_key": key, "source": "desktop_ui"}


def create_matter(service: MatterService, title: str = "Matter"):
    return service.create_matter(
        {"title": title}, idempotency_key=f"create-{title}", source="desktop_ui"
    )


# ── ① 身份键 ────────────────────────────────────────────────────────────────


def test_library_resource_key_shares_the_file_namespace_with_attachments():
    key = library_resource_key(7)
    assert key == f"{RESOURCE_KEY_PREFIX}7"
    assert parse_library_resource_key(key) == 7
    # 与附件键并列：同 kind='file'、同 provider、靠前缀区分，两个字符串永不相等。
    assert key != resource_identity.attachment_resource_key(7)
    # normalize 对 kind='file' 原样透传（`file` 有意不在 MAILAGENT_IDENTITY_KINDS 里）。
    assert (
        resource_identity.normalize_resource_key(
            resource_identity.EMAIL_PROVIDER, "file", key
        )
        == key
    )
    assert "file" not in resource_identity.MAILAGENT_IDENTITY_KINDS
    assert "file" in resource_identity.MAILAGENT_PROPOSAL_KINDS


@pytest.mark.parametrize("bad", ["attachment:7", "library:", "library:abc", "library:0", "7", ""])
def test_parse_library_resource_key_rejects_everything_but_a_positive_id(bad):
    with pytest.raises(ValueError):
        parse_library_resource_key(bad)


def test_unique_key_note_is_written_where_the_prefix_is_minted():
    """design §9.2 的 🔴：唯一键不含 kind 这件事必须写在 resource_identity 的 docstring 里。"""
    doc = library_resource_key.__doc__ or ""
    assert "uq_resource_provider_key" in doc
    assert "kind" in doc


# ── ② 提案白名单 ────────────────────────────────────────────────────────────


def spec(external_key: str, **extra):
    return {
        "provider": "mailagent",
        "kind": "file",
        "external_key": external_key,
        **extra,
    }


def test_followup_proposal_accepts_a_library_file_when_the_resolver_confirms_it():
    install_resolver({5: {}})
    normalized = normalize_new_resource(
        spec(library_resource_key(5), title="上线计划", summary="窗口在周五晚"),
        allowed_providers=ALLOWED,
        exists=lambda provider, kind, key: resource_identity.library_file_available(key),
    )
    assert normalized["external_key"] == "library:5"
    assert normalized["kind"] == "file"
    # 库文件不是邮件类 —— 模型写的 summary 照收（邮件类才恒丢成 None）。
    assert normalized["summary"] == "窗口在周五晚"


def test_followup_proposal_rejects_a_fabricated_file_id():
    install_resolver({5: {}})
    with pytest.raises(ResourceProposalError) as exc:
        normalize_new_resource(
            spec(library_resource_key(999)),
            allowed_providers=ALLOWED,
            exists=lambda provider, kind, key: resource_identity.library_file_available(key),
        )
    assert exc.value.reason == REASON_NOT_FOUND


@pytest.mark.parametrize("bad_key", ["attachment:7", "library:abc", "page:xyz"])
def test_followup_proposal_only_admits_the_library_prefix(bad_key):
    """邮件附件走人工关联，不进提案通道 —— 本地无存在性判定的 file 键一律 KEY_INVALID。"""
    install_resolver({7: {}})
    with pytest.raises(ResourceProposalError) as exc:
        normalize_new_resource(
            spec(bad_key),
            allowed_providers=ALLOWED,
            exists=lambda provider, kind, key: True,
        )
    assert exc.value.reason == REASON_KEY_INVALID


# ── ③ 存在性回调 ────────────────────────────────────────────────────────────


def test_resource_available_fails_closed_without_a_resolver(service):
    with service.repository.connect() as conn:
        # 库文件：没注册回调 → 不可用（不崩、不放行）。
        assert (
            service.repository.resource_available(conn, "mailagent", "file", "library:1")
            is False
        )
        # 邮件附件：本分支之前就没有本地判定，行为一字不变。
        assert (
            service.repository.resource_available(conn, "mailagent", "file", "attachment:1")
            is True
        )
        # 其他 provider 的 file 恒 True（connector 侧发号，本地验不了）。
        assert (
            service.repository.resource_available(conn, "notion", "file", "library:1")
            is True
        )


def test_resource_available_consults_the_injected_resolver(service):
    calls = install_resolver({12: {}})
    with service.repository.connect() as conn:
        assert (
            service.repository.resource_available(conn, "mailagent", "file", "library:12")
            is True
        )
        assert (
            service.repository.resource_available(conn, "mailagent", "file", "library:13")
            is False
        )
        # 形状不对的键不问回调，直接拒。
        assert (
            service.repository.resource_available(conn, "mailagent", "file", "library:abc")
            is False
        )
    # 存在性判定是逐行调用的，绝不为它拉正文。
    assert calls == [(12, False), (13, False)]


def test_resolver_blowing_up_degrades_to_unavailable(service):
    def boom(file_id, *, with_text=False):
        raise RuntimeError("library.db is gone")

    set_library_file_resolver(boom)
    with service.repository.connect() as conn:
        assert (
            service.repository.resource_available(conn, "mailagent", "file", "library:1")
            is False
        )


# ── ④ 摘要与摘录（服务端填）─────────────────────────────────────────────────


def link_library_file(service, file_id: int, **extra):
    created = create_matter(service, f"Matter-{file_id}")
    return service.add_resource(
        created["matter"]["public_id"],
        {
            "provider": "mailagent",
            "kind": "file",
            "external_key": library_resource_key(file_id),
            **extra,
        },
        **mutation(created["version"], f"link-{file_id}"),
    )


def test_library_summary_and_excerpt_caps_match_the_design():
    """两个长度钉死在 design §9.2 的数字上 —— 别的断言都拿常量比常量，只有这里管值。"""
    assert LIBRARY_SUMMARY_FALLBACK_CHARS == 300
    assert LIBRARY_EXCERPT_MAX_CHARS == 2000


def test_frontmatter_summary_and_excerpt_are_filled_server_side(service):
    body = "正文" * 3000
    install_resolver({20: {"summary": "本文说的是上线窗口", "text": body}})
    resource = link_library_file(service, 20)["resources"][0]["resource"]
    assert resource["sum"] == "本文说的是上线窗口"
    assert resource["sum_src"] == "agent"
    excerpt = resource["metadata"][URL_CACHE_TEXT_KEY]
    assert excerpt == body[:LIBRARY_EXCERPT_MAX_CHARS]
    assert len(excerpt) == LIBRARY_EXCERPT_MAX_CHARS


def test_summary_falls_back_to_the_first_300_chars_of_extracted_text(service):
    body = "甲乙丙丁" * 500
    install_resolver({21: {"summary": None, "text": body}})
    resource = link_library_file(service, 21)["resources"][0]["resource"]
    assert resource["sum"] == body[:LIBRARY_SUMMARY_FALLBACK_CHARS]
    assert len(resource["sum"]) == LIBRARY_SUMMARY_FALLBACK_CHARS


def test_caller_supplied_summary_wins_over_the_server_default(service):
    install_resolver({22: {"summary": "frontmatter 的那句", "text": "正文"}})
    resource = link_library_file(service, 22, sum="Agent 概括的那句")["resources"][0]["resource"]
    assert resource["sum"] == "Agent 概括的那句"
    # 摘录照填 —— 它不是摘要的替代品。
    assert resource["metadata"][URL_CACHE_TEXT_KEY] == "正文"


def test_metadata_only_resources_get_neither_summary_nor_excerpt(service):
    install_resolver({23: {"summary": "不该出现", "text": "也不该出现"}})
    resource = link_library_file(service, 23, access_policy="metadata_only")["resources"][0][
        "resource"
    ]
    assert resource["sum"] is None
    assert URL_CACHE_TEXT_KEY not in (resource["metadata"] or {})


def test_missing_library_file_links_without_summary_and_shows_unavailable(service):
    """回调说文件不在 → 照样能挂（引用永不悬空），但没有摘要、列表里标不可用。"""
    install_resolver({})
    linked = link_library_file(service, 24)
    resource = linked["resources"][0]["resource"]
    assert resource["sum"] is None
    assert URL_CACHE_TEXT_KEY not in (resource["metadata"] or {})
    with service.repository.connect() as conn:
        assert (
            service.repository.resource_available(
                conn, "mailagent", "file", library_resource_key(24)
            )
            is False
        )


def test_linked_library_file_reaches_the_context_snapshot_excerpt(service):
    """已关联的库文件**自然**进快照的资料投影 —— 零新增注入路径（design §9.2）。"""
    install_resolver({25: {"summary": "上线窗口在周五晚", "text": "## 上线窗口\n2026-09-18 22:00"}})
    created = create_matter(service, "Snapshot")
    public_id = created["matter"]["public_id"]
    service.add_resource(
        public_id,
        {
            "provider": "mailagent",
            "kind": "file",
            "external_key": library_resource_key(25),
            "pinned": True,
        },
        **mutation(created["version"], "link-snapshot"),
    )
    snapshot = service.context_snapshot(public_id)
    projected = [
        item for item in snapshot["resources"] if item["external_key"] == "library:25"
    ]
    assert len(projected) == 1
    assert projected[0]["excerpt"] == "## 上线窗口\n2026-09-18 22:00"
    assert projected[0]["kind"] == "file"
