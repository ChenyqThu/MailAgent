"""E1 §3.1 Step 3: job_runners 的 backend 收编回归测试。

覆盖两个此前潜藏 id 空间不匹配的场景 (davmail-origin internal_id >= 10^9,
AppleScript `whose id` 查询无法定位):

1. backfill_body job 走 ``deps.backend`` (ServiceDeps.backend 经 create_backend()
   工厂, 尊重 MAILAGENT_BACKEND) —— 不会绕过 ServiceDeps 自己另建一个 backend。
2. backfill_metadata job 在 davmail 模式下 source=applescript 显式
   raise ServiceInvalidArgError, 不会静默用错 id 空间的 AppleScriptArm 查询。
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from src.mail.sync_store import SyncStore
from src.services.errors import ServiceInvalidArgError
from src.sync.job_runners import run_backfill_job


class _FakeDeps:
    """backfill runner 要的最小 ServiceDeps (镜像 test_job_parity.py 的 _FakeDeps)。"""

    def __init__(self, *, sync_store, config, backend=None, email_repo=None, notion_sync=None):
        self._sync_store = sync_store
        self._config = config
        self._backend = backend if backend is not None else object()
        self._email_repo = email_repo if email_repo is not None else object()
        self._notion_sync = notion_sync if notion_sync is not None else object()

    @property
    def config(self):
        return self._config

    @property
    def sync_store(self):
        return self._sync_store

    @property
    def email_repo(self):
        return self._email_repo

    @property
    def notion_sync(self):
        return self._notion_sync

    @property
    def backend(self):
        return self._backend


class _FakeDavMailBackend:
    """站位 DavMailBackend —— 测试只需验证"身份透传", 不需实现完整 IMailBackend。"""


def _deps(tmp_path, *, mailagent_backend, backend=None):
    db_path = str(tmp_path / "sync.db")
    sync_store = SyncStore(db_path)
    config = SimpleNamespace(
        mailagent_backend=mailagent_backend,
        sync_store_db_path=db_path,
    )
    return _FakeDeps(sync_store=sync_store, config=config, backend=backend)


def test_backfill_body_davmail_mode_threads_deps_backend_as_arm(tmp_path):
    """davmail 模式: backfill_body 传给 _make_body_units 的 arm 就是
    deps.backend (factory 装好的 DavMailBackend), 不是另建的 AppleScriptArm。"""
    davmail_backend = _FakeDavMailBackend()
    deps = _deps(tmp_path, mailagent_backend="davmail", backend=davmail_backend)

    captured: dict = {}

    def _fake_make_body_units(records, **kwargs):
        captured.update(kwargs)
        return []

    with patch(
        "src.sync.backfill_builders._make_body_units",
        side_effect=_fake_make_body_units,
    ):
        results, summary = run_backfill_job(
            deps, "backfill_body",
            target_kind="range", target_key="*",
            params={}, on_unit_done=None, resume_from=None,
        )

    assert captured["arm"] is davmail_backend
    assert results == []
    assert summary.succeeded == 0
    assert summary.failed == 0


def test_backfill_metadata_source_applescript_rejected_in_davmail_mode(tmp_path):
    """davmail 模式 + source=applescript: 显式 raise ServiceInvalidArgError,
    不会静默构造用错 id 空间的 AppleScriptArm。"""
    deps = _deps(tmp_path, mailagent_backend="davmail")

    with pytest.raises(ServiceInvalidArgError) as exc_info:
        run_backfill_job(
            deps, "backfill_metadata",
            target_kind="range", target_key="*",
            params={"source": "applescript"},
            on_unit_done=None, resume_from=None,
        )

    assert exc_info.value.code == "E_INVALID_ARG"
    assert "davmail" in str(exc_info.value).lower()


def test_backfill_metadata_source_applescript_ok_in_applescript_mode(tmp_path):
    """applescript 模式 (非 davmail): source=applescript 不受影响, 正常走
    deps.backend 组单元 (无候选记录时返回空 units, 不报错)。"""
    deps = _deps(tmp_path, mailagent_backend="applescript")

    results, summary = run_backfill_job(
        deps, "backfill_metadata",
        target_kind="range", target_key="*",
        params={"source": "applescript"},
        on_unit_done=None, resume_from=None,
    )

    assert results == []
    assert summary.succeeded == 0
    assert summary.failed == 0
