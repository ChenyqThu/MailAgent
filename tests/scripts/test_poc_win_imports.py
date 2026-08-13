"""P0 PoC harness (scripts/poc_win/) 的 macOS 冒烟测试.

真机验证只能在 Windows 做 (README go/no-go 表); 本文件守住 mac 侧纪律:

1. 三个 poc 脚本 + poc_common 在 macOS 上可 import —— 即不 top-level import
   pywin32/pythoncom (任务硬约束; top-level import 在 mac 会直接 ImportError,
   所以「import 成功」本身就是断言);
2. 非 win32 平台跑 main() 干净退出, 退出码 = EXIT_NOT_APPLICABLE (2),
   不触达任何 COM / 注册表;
3. LoguruCounter 的日志文案键与正式模块真实日志保持一致 (防正式模块改文案
   后 PoC 计数静默归零)。
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
POC_DIR = REPO_ROOT / "scripts" / "poc_win"

SCRIPTS = ["poc_common", "poc_1_mime_fidelity", "poc_2_sta_executor", "poc_3_environment"]


def _load(name: str):
    """按文件路径 import (scripts/poc_win 非包); poc_common 相互引用靠 sys.path."""
    if str(POC_DIR) not in sys.path:
        sys.path.insert(0, str(POC_DIR))
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, POC_DIR / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("name", SCRIPTS)
def test_poc_script_importable_without_pywin32(name):
    _load(name)
    # import 后 pywin32 家族不得出现在 sys.modules (懒 import 纪律)
    for forbidden in ("win32com", "pythoncom", "win32com.client"):
        assert forbidden not in sys.modules, (
            f"{name} 顶层触达了 {forbidden} —— PoC 纪律: COM import 必须在 win32 平台闸后"
        )


@pytest.mark.parametrize(
    "name", ["poc_1_mime_fidelity", "poc_2_sta_executor", "poc_3_environment"]
)
@pytest.mark.skipif(sys.platform == "win32", reason="非 win32 退出语义仅在 mac/linux 可测")
def test_poc_main_exits_not_applicable_on_non_win32(name, capsys):
    module = _load(name)
    common = _load("poc_common")
    with pytest.raises(SystemExit) as exc_info:
        module.main([])
    assert exc_info.value.code == common.EXIT_NOT_APPLICABLE
    out = capsys.readouterr().out
    assert "win32" in out  # 干净退出时必须打印平台说明


def test_poc_loguru_counter_patterns_match_real_log_messages():
    """LoguruCounter 关键词必须能在正式模块源码里找到 —— 文案改了这里要红."""
    common = _load("poc_common")
    sources = "".join(
        (REPO_ROOT / "src" / "mail" / "backend" / f).read_text(encoding="utf-8")
        for f in ("outlook_mime.py", "outlook_com_backend.py")
    )
    for needle in common.LoguruCounter.PATTERNS:
        assert needle in sources, (
            f"LoguruCounter 关键词 {needle!r} 在 outlook_mime/outlook_com_backend "
            "源码中找不到 —— 正式模块日志文案变了, PoC 计数会静默归零, 同步更新 PATTERNS"
        )


def test_poc_common_report_write(tmp_path, monkeypatch):
    common = _load("poc_common")
    monkeypatch.setattr(common, "REPORTS_DIR", tmp_path)
    path = common.write_report("unit", {"ok": True, "中文": "保真"})
    assert path.exists()
    assert "中文" in path.read_text(encoding="utf-8")  # ensure_ascii=False
