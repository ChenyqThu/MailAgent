"""scripts/keep_alive.py:get_idle_seconds 回归测试.

ioreg subprocess 必须带 timeout —— 无 timeout 时 ioreg 偶发卡死会永久阻塞
daemon 单线程主循环（实测: 进程活着但 jiggle 停摆 17 小时、无任何日志）。
"""
import importlib.util
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

pytestmark = pytest.mark.skipif(
    sys.platform != "darwin",
    reason="keep_alive.py 在 import 时加载 CoreGraphics（仅 macOS）",
)

_KEEP_ALIVE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "keep_alive.py"


def _import_keep_alive():
    # 按文件路径加载: scripts/ 不是 package, 且 module 顶层 LoadLibrary
    # CoreGraphics, 非 darwin 收集阶段不能 import
    spec = importlib.util.spec_from_file_location("_keep_alive_under_test", _KEEP_ALIVE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_get_idle_seconds_parses_hid_idle_time():
    keep_alive = _import_keep_alive()
    fake = MagicMock()
    fake.stdout = '    "HIDIdleTime" = 2500000000\n'
    with patch.object(keep_alive.subprocess, "run", return_value=fake) as run:
        assert keep_alive.get_idle_seconds() == pytest.approx(2.5)
    # 回归点: 必须带 timeout, 否则 ioreg 卡死 → 单线程主循环永久阻塞
    assert run.call_args.kwargs.get("timeout") == 5


def test_get_idle_seconds_returns_minus_one_on_timeout():
    keep_alive = _import_keep_alive()
    with patch.object(
        keep_alive.subprocess,
        "run",
        side_effect=subprocess.TimeoutExpired(cmd="ioreg", timeout=5),
    ):
        assert keep_alive.get_idle_seconds() == -1
