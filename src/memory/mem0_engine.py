"""mem0 记忆引擎封装（M1 auto-capture）。

懒加载红线：顶层**不** import mem0/fastembed/faiss —— flag-off（`MAILAGENT_MEM0_CAPTURE`
关）时这些重依赖（onnxruntime/faiss/fastembed ~150MB+）绝不被加载。只有真正 add/search
被调用时才构造 `Memory`。

本地栈（守「邮件衍生数据不出第三方 SaaS」红线）：
- LLM（抽取）= anthropic provider 指向内部 CRS 网关的 **anthropic 腿**（`/v1/messages`），
  复用 `LLM_API_KEY`，不引新 provider。（openai 腿不可用：CRS 强制 stream + 把 claude 转译成
  mem0 解析不了的 list；anthropic 腿返回 claude 标准 text。）
- embedder = fastembed bge-small（ONNX，CPU，离线，无 key，384 维）。
- vector_store = FAISS（嵌入式 on-disk，无 server）。
- 存储 pin 到 `DATA_ROOT/mem0/`（faiss index + history.db + fastembed_cache），不污染 $HOME。
- 遥测：env `MEM0_TELEMETRY=False`（import mem0 前设）→ PostHog 从不实例化、capture 全 early-return
  （实测；env 是充分防线，无需 monkeypatch consumer binding）。

业务权威在 Python：抽取/检索/删除逻辑全在这里；Node 只 fire-and-forget 触发（M1c）。
mem0 是**同步**库 → 调用方（capture 端点）须用 `run_in_executor` 跑，勿阻塞 event loop。
"""
from __future__ import annotations

import os
import threading
from typing import Any, Dict, Optional

from src.config import DATA_ROOT
from src.config import config as cfg

# bge-small-en-v1.5：384 维，fastembed 默认量化 ONNX，离线、无 key。
BGE_MODEL = "BAAI/bge-small-en-v1.5"
BGE_DIMS = 384
# 抽取调用的 max output。刻意小（抽取出的 facts JSON 很短）：anthropic SDK 对「非流式 +
# 大 max_tokens（预期生成 >10min）」会硬 raise「Streaming is required」，而 mem0 的
# anthropic LLM 是非流式 messages.create，故**不能**用主调用的 64k。8192 远低于该阈值且
# 对抽取绰绰有余。（这是 SDK 物理限制下的合理偏离，非吝啬 context。）
CAPTURE_MAX_TOKENS = 8192

# mem0 抽取约束（注入 mem0 `custom_instructions`）：只抽持久偏好/事实，绝不抽一次性任务态。
# 与 RULES floor「绝不静默写一次性任务态」叠加（floor 在系统层，这里在抽取层，双重约束）。
CAPTURE_INSTRUCTIONS = """\
You extract DURABLE memory about the user from a single chat turn.

CAPTURE only lasting, reusable facts and preferences, e.g.: communication style
and tone preferences; recurring priorities and decision rules; names/roles of
people, teams and projects the user works with; stable workflow conventions and
standing context about who the user is.

NEVER capture one-off or transient task state, e.g.: "summarize this email",
"the user is currently viewing message 123", a request scoped only to this
conversation, or anything not useful in a future unrelated session. When in
doubt, capture nothing.
"""


def _mem0_root() -> str:
    """mem0 store 根 = DATA_ROOT/mem0/（feature-owned，不进 chat_db / DB_VERSION）。"""
    return os.path.join(DATA_ROOT, "mem0")


def build_mem0_config(model: Optional[str] = None) -> Dict[str, Any]:
    """组装 mem0 `Memory.from_config` 的 config dict（纯函数，不 import mem0）。

    抽取 model 优先级：显式 `model` > `MEMORY_CAPTURE_MODEL` > `LLM_MODEL`。
    """
    root = _mem0_root()
    extraction_model = model or cfg.memory_capture_model or cfg.llm_model
    base = (cfg.llm_api_base or "").rstrip("/")
    return {
        "version": "v1.1",
        "llm": {
            # anthropic provider 经 CRS 的 anthropic 腿（/v1/messages）：claude 返回标准 text，
            # 不像 OpenAI 腿（强制 stream + 把 claude 转译成非标准 list 让 mem0 解析失败）。
            # anthropic_base_url 不含 /v1（anthropic SDK 自动加 /v1/messages），复用 client.py 同款语义。
            "provider": "anthropic",
            "config": {
                "model": extraction_model,
                "api_key": cfg.llm_api_key,
                "anthropic_base_url": base,
                "max_tokens": CAPTURE_MAX_TOKENS,
                "temperature": 0.1,
            },
        },
        "embedder": {
            "provider": "fastembed",
            "config": {"model": BGE_MODEL, "embedding_dims": BGE_DIMS},
        },
        "vector_store": {
            "provider": "faiss",
            "config": {
                "collection_name": "mailagent_memory",
                "path": os.path.join(root, "faiss"),
                "embedding_model_dims": BGE_DIMS,
                "distance_strategy": "cosine",
            },
        },
        "history_db_path": os.path.join(root, "history.db"),
        "custom_instructions": CAPTURE_INSTRUCTIONS,
    }


def _prepare_runtime_env() -> None:
    """import mem0/fastembed 前钉死：遥测关 + fastembed 模型 cache pin 到 DATA_ROOT。"""
    # 主防线：env（mem0 telemetry 读它）。强制覆盖，不用 setdefault（防用户/外部误设 True）。
    os.environ["MEM0_TELEMETRY"] = "False"
    # fastembed 模型权重 cache：mem0 的 fastembed embedder 不透传 cache_dir，只能经 env 控制。
    # 硬 pin 到 DATA_ROOT（M1e pre-bake 权重落点 → 离线可用），不落 ~/.cache 也不让外部 env
    # 覆盖（M1e 的离线保证依赖这个无条件 pin）。
    cache = os.path.join(_mem0_root(), "fastembed_cache")
    os.makedirs(cache, exist_ok=True)
    os.environ["FASTEMBED_CACHE_PATH"] = cache


class Mem0Engine:
    """mem0 `Memory` 的薄封装（懒加载 + 线程安全单飞构造）。"""

    def __init__(self, model: Optional[str] = None) -> None:
        self._model = model
        self._mem: Any = None
        self._lock = threading.Lock()

    def _memory(self) -> Any:
        if self._mem is None:
            with self._lock:
                if self._mem is None:
                    _prepare_runtime_env()  # 遥测关 + cache pin，须在 import mem0 前
                    from mem0 import Memory  # 懒 import：flag-off 不触发重依赖

                    self._mem = Memory.from_config(build_mem0_config(self._model))
        return self._mem

    def add(
        self,
        messages: Any,
        user_id: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._memory().add(messages, user_id=user_id, metadata=metadata)

    def search(self, query: str, user_id: str, limit: int = 10) -> Dict[str, Any]:
        # mem0 2.x：user_id 走 filters、条数走 top_k（不是顶层 user_id=/limit=，会 ValueError）
        return self._memory().search(query, filters={"user_id": user_id}, top_k=limit)

    def get_all(self, user_id: str) -> Dict[str, Any]:
        return self._memory().get_all(filters={"user_id": user_id})

    def delete(self, memory_id: str) -> None:
        self._memory().delete(memory_id)


_engine: Optional[Mem0Engine] = None
_engine_lock = threading.Lock()


def get_mem0_engine() -> Mem0Engine:
    """进程内单例。"""
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                _engine = Mem0Engine()
    return _engine
