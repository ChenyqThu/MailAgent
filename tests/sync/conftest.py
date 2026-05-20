"""tests/sync conftest: 复用 tests/mail/conftest.py 的 async test hook.

通过 pytest_pyfunc_call hook 自动用 asyncio.run 包裹 async def 测试，
避免每个 fanout 测试手写 @pytest.mark.asyncio.
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
