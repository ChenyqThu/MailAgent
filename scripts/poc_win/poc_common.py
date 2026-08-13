"""P0 PoC harness 共享工具 (task 08-12 Phase 0).

三个 poc_*.py 共用的 bootstrap / 平台闸 / 报告落盘。

🔴 纪律 (与 src/mail/backend/ 平台纪律一致):
- 本模块与三个 poc 脚本都**不 top-level import pywin32** —— macOS 上可 import
  可跑冒烟测试 (tests/scripts/test_poc_win_imports.py), COM 触达全部发生在
  win32 平台闸之后、且经正式模块 (com_client 的 STA executor) 进行。
- PoC 直接调用 worktree 正式模块 (src.mail.backend.outlook_mime / com_client /
  outlook_com_backend), 不做独立拷贝 —— PoC 验的就是要上线的代码。
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# 退出码契约 (README 有表; go/no-go 自动化按此判读)
# ---------------------------------------------------------------------------
EXIT_GO = 0  # 判定 GO (或脚本全部检查通过)
EXIT_NO_GO = 1  # 判定 NO-GO / 关键检查失败
EXIT_NOT_APPLICABLE = 2  # 非 win32 平台 / 环境不适用, 未执行任何检查

_HERE = Path(__file__).resolve().parent
REPO_ROOT = _HERE.parents[1]
REPORTS_DIR = _HERE / "reports"


def ensure_env() -> None:
    """src.config 是 pydantic 必填 USER_EMAIL —— PoC 机器可能还没有 .env。

    setdefault 不覆盖真实配置; poc 值只为让 `import src.*` 不炸
    (PoC 全程只读 Outlook, 不触达 Notion/飞书/SQLite 写路径)。
    """
    os.environ.setdefault("USER_EMAIL", "poc@mailagent.local")


def bootstrap_sys_path() -> None:
    """repo 根进 sys.path (让 `import src.*` 可解析) — 幂等."""
    root = str(REPO_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)


def exit_if_not_win32(script_purpose: str) -> None:
    """非 win32 打印说明并以 EXIT_NOT_APPLICABLE 退出 (任务硬约束)."""
    if sys.platform == "win32":
        return
    print(
        f"[poc-win] 本脚本只在 Windows (win32) 上运行: {script_purpose}\n"
        f"[poc-win] 当前平台 = {sys.platform!r} — 未执行任何检查, 干净退出。\n"
        f"[poc-win] 真机运行方法见 scripts/poc_win/README.md。"
    )
    raise SystemExit(EXIT_NOT_APPLICABLE)


def write_report(prefix: str, payload: dict[str, Any]) -> Path:
    """JSON 报告落盘 scripts/poc_win/reports/<prefix>-<ts>.json, 返回路径."""
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    path = REPORTS_DIR / f"{prefix}-{ts}.json"
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    return path


def print_header(title: str) -> None:
    bar = "=" * 72
    print(f"\n{bar}\n{title}\n{bar}")


def print_verdict(go: bool, reasons: list[str]) -> None:
    verdict = "GO ✅" if go else "NO-GO ❌"
    print_header(f"判定: {verdict}")
    for r in reasons:
        print(f"  - {r}")


class LoguruCounter:
    """loguru sink: 按关键词计数 (poc_1 用来观测重组链的兜底分支触发率).

    重组链 (outlook_mime) 的 compat32 fallback / 坏头跳过 / 合成 Message-ID
    没有返回值可观测 —— 只在日志里留痕, PoC 靠捕获日志计数。
    """

    #: 关键词 → 计数键 (匹配 message 子串, 全部来自 outlook_mime/outlook_com_backend 真实日志文案)
    PATTERNS = {
        "retrying compat32": "compat32_fallback",
        "missing Message-ID, synthesized": "synthetic_message_id",
        "transport headers unparseable": "headers_unparseable",
        "skip bad header": "bad_header_skipped",
        "inline attach failed": "inline_attach_fallback",
        "extract failed": "attachment_extract_failed",
        "cannot set": "required_header_set_failed",
    }

    def __init__(self) -> None:
        self.counts: dict[str, int] = {v: 0 for v in self.PATTERNS.values()}
        self._sink_id: int | None = None

    def __call__(self, message: Any) -> None:
        text = str(message)
        for needle, key in self.PATTERNS.items():
            if needle in text:
                self.counts[key] += 1

    def attach(self) -> None:
        from loguru import logger

        self._sink_id = logger.add(self, level="DEBUG")

    def detach(self) -> None:
        if self._sink_id is not None:
            from loguru import logger

            logger.remove(self._sink_id)
            self._sink_id = None
