"""🔴 闸：``src/im`` 的模块顶层**绝不**（哪怕间接）import ``lark_oapi``。

为什么这值得一道机器闸（不是洁癖）：``lark_oapi/ws/client.py`` 在 **import 期**执行

    try:    loop = asyncio.get_event_loop()
    except RuntimeError:
            loop = asyncio.new_event_loop(); asyncio.set_event_loop(loop)

并把它存成**模块级全局**，之后 ``ws.Client.start()`` 走 ``loop.run_until_complete``。
我们挂在 ``serve`` 进程里 —— 那里有一个**正在跑**的 asyncio 主循环。一旦 lark 的第一次
import 发生在主循环线程上（比如某人图方便把 ``import lark_oapi`` 提到某个 ``src/im``
模块顶层，而 ``src/service.py`` 在协程里 ``from src.im import ...``），那个全局 loop 就
是**服务主 loop**，``start()`` 当场 ``RuntimeError: This event loop is already running``
—— 整个 IM 功能钉死，而且症状（"启动就报事件循环已在运行"）离根因很远。

这道闸把「lark import 必须发生在 ``FeishuConnection`` 自己的线程里」变成可证伪的事实。
用子进程跑，避免被别的测试先污染 ``sys.modules``。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

_PROBE = """
import sys
import src.im            # 包顶层（会拉 worker → connection / lark_api / handler …）
import src.im.connection
import src.im.lark_api
import src.im.worker
leaked = sorted(m for m in sys.modules if m.startswith("lark"))
print("LEAKED:" + ",".join(leaked))
"""


def test_src_im_does_not_import_lark_at_module_level():
    result = subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, f"probe failed:\n{result.stdout}\n{result.stderr}"
    line = next(
        (ln for ln in result.stdout.splitlines() if ln.startswith("LEAKED:")), None
    )
    assert line is not None, f"probe printed nothing usable:\n{result.stdout}"
    leaked = [m for m in line[len("LEAKED:"):].split(",") if m]
    assert not leaked, (
        "以下 lark 模块在 `import src.im` 时就被拉进来了：\n  "
        + "\n  ".join(leaked)
        + "\n→ 把那个 import 挪进函数体。理由见本文件 docstring 与 "
        "src/im/connection.py 的模块注释（lark 在 import 期抓全局 event loop）。"
    )
