"""tests/events conftest: async test hook 与 tests/sync 一致.

通过 pytest_pyfunc_call hook 自动用 asyncio.run 包裹 async def 测试，
便于 handler 测试不写 @pytest.mark.asyncio.

现有 test_fetch_mail_content.py / test_search_email_bodies.py 用 inline
asyncio.run 模式（同步 def + 内部 await），不受 hook 影响。
"""
from __future__ import annotations

import asyncio
import inspect

import pytest


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem):
    func = pyfuncitem.obj
    if not inspect.iscoroutinefunction(func):
        return None
    arg_names = pyfuncitem._fixtureinfo.argnames
    kwargs = {name: pyfuncitem.funcargs[name] for name in arg_names}
    asyncio.run(func(**kwargs))
    return True
