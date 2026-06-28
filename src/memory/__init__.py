"""M1 mem0 记忆引擎（auto-capture）。

懒加载封装：import 本包**既不**触发 mem0/fastembed/faiss（重依赖），**也不**触发 `src.config`
import —— `mem0_engine` 顶部 `from src.config import ...` 会在 import 时拉起 config，而裸 worktree /
CI 的 import self-check 下，顶层 re-export 会过早触发它（codex review LOW-2）。用 PEP 562
`__getattr__` 把符号解析推迟到首次真正访问时，对齐 `chat.py`「函数内才 import mem0_engine」的纪律。
"""
from typing import TYPE_CHECKING, Any

__all__ = ["Mem0Engine", "build_mem0_config", "get_mem0_engine"]

if TYPE_CHECKING:  # 仅类型检查期可见；运行时不 import（不触发 src.config / 重依赖）
    from src.memory.mem0_engine import (
        Mem0Engine,
        build_mem0_config,
        get_mem0_engine,
    )


def __getattr__(name: str) -> Any:
    """首次访问 `src.memory.<符号>` 时才 import mem0_engine（推迟 src.config 拉起）。"""
    if name in __all__:
        from src.memory import mem0_engine

        return getattr(mem0_engine, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
