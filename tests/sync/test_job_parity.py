"""C1 parity: resync job runner 输出 == CLI _resync_batch 的 unit 形状 (service-layer 安全网)。

job_runners.run_resync_job 的 unit 逐字段对齐 CLI src/cli/commands/email.py
``_resync_batch._make_unit`` —— 同调 ``NotionSync.create_email_page_from_sqlite``,
同 ``{page_id, archived_page_id, action}`` 形状; 仅 ``CliNotFoundError`` →
``ServiceNotFoundError`` (二者 code 同为 ``E_NOT_FOUND``)。

本测试用 stub notion_sync 隔离 Notion, 锁定:
1. 成功 unit 的 data 形状 == golden (与 CLI emit 同)
2. 调用 create_email_page_from_sqlite 的 kwargs == CLI 透传的 (replace_existing /
   skip_parent_lookup)
3. 缺 body (ValueError) → UnitResult.status='failed' + error_code='E_NOT_FOUND'
   (与 CLI CliNotFoundError 同 code)
4. summary 计数 (succeeded / failed / partial_failure)
"""
from __future__ import annotations

from src.mail.sync_store import SyncStore
from src.sync.job_runners import run_resync_job, summary_to_status


class _FakeResult:
    def __init__(self, page_id, archived_page_id, action):
        self.page_id = page_id
        self.archived_page_id = archived_page_id
        self.action = action


class _FakeNotionSync:
    """stub: per-iid 返回 _FakeResult 或 raise ValueError (模拟缺 body)。记录调用 kwargs。"""

    def __init__(self, behavior: dict):
        self.behavior = behavior
        self.calls: list[dict] = []

    async def create_email_page_from_sqlite(
        self, internal_id, *, repo, sync_store, replace_existing, skip_parent_lookup,
    ):
        self.calls.append({
            "internal_id": internal_id,
            "replace_existing": replace_existing,
            "skip_parent_lookup": skip_parent_lookup,
        })
        outcome = self.behavior[internal_id]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class _FakeDeps:
    """resync runner 要的最小 ServiceDeps (sync_store 真实, notion_sync stub, repo 透传)。"""

    def __init__(self, sync_store, notion_sync):
        self._sync_store = sync_store
        self._notion_sync = notion_sync

    @property
    def sync_store(self):
        return self._sync_store

    @property
    def email_repo(self):
        return object()  # stub 不读 repo, 只透传

    @property
    def notion_sync(self):
        return self._notion_sync


def _deps(tmp_path, behavior):
    db = tmp_path / "sync.db"
    sync_store = SyncStore(str(db))
    return _FakeDeps(sync_store, _FakeNotionSync(behavior))


def test_resync_job_success_unit_shape_matches_cli_golden(tmp_path):
    behavior = {
        1: _FakeResult(page_id="p-1", archived_page_id=None, action="created"),
        2: _FakeResult(page_id="p-2", archived_page_id="old-2", action="replaced"),
    }
    deps = _deps(tmp_path, behavior)
    results, summary = run_resync_job(
        deps, target_kind="ids", target_key="ids:1,2",
        params={"internal_ids": [1, 2], "replace_existing": True},
        on_unit_done=None, resume_from=None,
    )
    # golden: 与 CLI _make_unit 返回逐字段同
    assert [r.data for r in results] == [
        {"page_id": "p-1", "archived_page_id": None, "action": "created"},
        {"page_id": "p-2", "archived_page_id": "old-2", "action": "replaced"},
    ]
    assert (summary.succeeded, summary.failed) == (2, 0)
    assert summary_to_status(summary) == "succeeded"


def test_resync_job_passes_same_kwargs_as_cli(tmp_path):
    behavior = {7: _FakeResult("p-7", None, "created")}
    deps = _deps(tmp_path, behavior)
    run_resync_job(
        deps, target_kind="ids", target_key="ids:7",
        params={"internal_ids": [7], "replace_existing": True, "skip_parent_lookup": True},
        on_unit_done=None, resume_from=None,
    )
    assert deps.notion_sync.calls == [
        {"internal_id": 7, "replace_existing": True, "skip_parent_lookup": True},
    ]


def test_resync_job_missing_body_maps_to_not_found(tmp_path):
    """缺 body (ValueError) → UnitResult error_code='E_NOT_FOUND' (CLI CliNotFoundError parity)。"""
    behavior = {
        1: _FakeResult("p-1", None, "created"),
        2: ValueError("body row missing"),
    }
    deps = _deps(tmp_path, behavior)
    results, summary = run_resync_job(
        deps, target_kind="ids", target_key="ids:1,2",
        params={"internal_ids": [1, 2]},
        on_unit_done=None, resume_from=None,
    )
    by_id = {r.internal_id: r for r in results}
    assert by_id[1].status == "success"
    assert by_id[2].status == "failed"
    assert by_id[2].error_code == "E_NOT_FOUND"
    assert (summary.succeeded, summary.failed) == (1, 1)
    assert summary_to_status(summary) == "partial_failure"


def test_resync_job_range_target_resolves_ids(tmp_path):
    behavior = {n: _FakeResult(f"p-{n}", None, "created") for n in range(10, 13)}
    deps = _deps(tmp_path, behavior)
    results, summary = run_resync_job(
        deps, target_kind="range", target_key="10-12", params={},
        on_unit_done=None, resume_from=None,
    )
    assert [r.internal_id for r in results] == [10, 11, 12]
    assert summary.succeeded == 3
