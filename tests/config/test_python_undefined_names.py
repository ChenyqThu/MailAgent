"""F821 未定义名闸：`ruff check --select F821 src/` 必须零命中。

为什么值得建闸（2026-08-22 装机事故）：M1 在 `service.py:177` 写下
``NotifyCenter(...)`` 时漏了 import，pytest 全绿——因为没有任何测试真正构造
``EmailNotionSyncApp``（告警测试全用 stub 对象直调方法）——潜伏到 2.18.0 dogfood
装机首启才 NameError 炸死主服务进程。本仓 PostToolUse autoflake hook 还会主动
删「暂时未用」的 import，让这类错更容易被制造出来。运行时构造成本太高，静态
扫描是唯一便宜的拦截面。

只选 F821（未定义名）不开全量 lint：全量是另一场治理，这里只拦「引用了不存在
的名字」这一类会在运行时变成 NameError 的错。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def test_src_has_no_undefined_names() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "ruff", "check", "--select", "F821", "src/"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    # ruff 不在环境里时必须红而不是 skip——skip 等于闸静默失效（ruff 已入
    # pyproject 的 dev extras，装了 .[dev] 就有）。
    assert result.returncode == 0, (
        "F821 未定义名（漏 import / autoflake 误删 / 手滑改名）——修复引用而不是"
        f"放宽本闸：\n{result.stdout}\n{result.stderr}"
    )
