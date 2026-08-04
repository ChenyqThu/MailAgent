"""建连前的多实例互斥检测（src/im/preflight.py）—— 全用注入的 pm2 runner，不跑真 pm2。"""

from __future__ import annotations

import json
import os
import subprocess
from types import SimpleNamespace

from src.im.preflight import detect_pm2_conflict
from src.services.guards import TARGET_PROC


def _runner(procs, *, returncode=0):
    def _run(*_a, **_k):
        return SimpleNamespace(returncode=returncode, stdout=json.dumps(procs))

    return _run


def _proc(name=TARGET_PROC, status="online", pid=999999):
    return {"name": name, "pid": pid, "pm2_env": {"status": status}}


class TestConflictDetected:
    def test_other_online_mail_sync_is_a_conflict(self):
        reason = detect_pm2_conflict(runner=_runner([_proc(pid=os.getpid() + 1)]))
        assert reason is not None
        assert TARGET_PROC in reason
        # 理由要能直接照着做，不是「有冲突」三个字
        assert "pm2 stop" in reason

    def test_conflict_reported_when_pid_is_missing(self):
        """pm2 没报 pid（老版本 / 异常行）→ 判不出是不是自己 → 保守判冲突。"""
        proc = _proc()
        proc.pop("pid")
        assert detect_pm2_conflict(runner=_runner([proc])) is not None


class TestNoConflict:
    def test_self_is_not_a_conflict(self):
        """🔴 serve 本身常常*就是*那个 pm2 mail-sync —— 不能自己把自己判成冲突。"""
        assert detect_pm2_conflict(runner=_runner([_proc(pid=os.getpid())])) is None

    def test_stopped_mail_sync_is_not_a_conflict(self):
        assert detect_pm2_conflict(runner=_runner([_proc(status="stopped")])) is None

    def test_other_process_names_are_ignored(self):
        assert (
            detect_pm2_conflict(runner=_runner([_proc(name="mailagent-api")])) is None
        )

    def test_empty_list(self):
        assert detect_pm2_conflict(runner=_runner([])) is None


class TestGracefulSkip:
    """检测本身不该变成新的单点故障 —— 判不了就放行。"""

    def test_pm2_not_installed(self):
        def _run(*_a, **_k):
            raise FileNotFoundError("pm2")

        assert detect_pm2_conflict(runner=_run) is None

    def test_pm2_timeout(self):
        def _run(*_a, **_k):
            raise subprocess.TimeoutExpired(cmd="pm2", timeout=5)

        assert detect_pm2_conflict(runner=_run) is None

    def test_non_zero_exit(self):
        assert detect_pm2_conflict(runner=_runner([_proc()], returncode=1)) is None

    def test_non_json_output(self):
        def _run(*_a, **_k):
            return SimpleNamespace(returncode=0, stdout="not json at all")

        assert detect_pm2_conflict(runner=_run) is None

    def test_unexpected_exception(self):
        def _run(*_a, **_k):
            raise OSError("weird")

        assert detect_pm2_conflict(runner=_run) is None

    def test_garbage_rows_are_skipped(self):
        def _run(*_a, **_k):
            return SimpleNamespace(returncode=0, stdout=json.dumps(["x", 3, None]))

        assert detect_pm2_conflict(runner=_run) is None
