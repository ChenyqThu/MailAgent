"""M1 mem0 记忆引擎（auto-capture）。

懒加载封装：import 本包不触发 mem0/fastembed/faiss（重依赖）。详见 mem0_engine。
"""
from src.memory.mem0_engine import (
    Mem0Engine,
    build_mem0_config,
    get_mem0_engine,
)

__all__ = ["Mem0Engine", "build_mem0_config", "get_mem0_engine"]
