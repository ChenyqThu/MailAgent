"""M1a — Mem0Engine 封装单测（mock mem0，无网络/无模型下载/无 FAISS）。"""
import os
import sys
from types import SimpleNamespace
from unittest import mock

from src.memory import mem0_engine as me


def _fake_cfg(**over):
    base = dict(
        llm_api_base="https://crs.chenge.ink/api",
        llm_api_key="sk-test",
        llm_model="claude-sonnet-4-6",
        memory_capture_model="",
        llm_max_tokens=64000,
    )
    base.update(over)
    return SimpleNamespace(**base)


def test_build_config_shape(monkeypatch, tmp_path):
    monkeypatch.setattr(me, "_mem0_root", lambda: str(tmp_path / "mem0"))
    monkeypatch.setattr(me, "cfg", _fake_cfg())

    c = me.build_mem0_config()
    # LLM = anthropic provider 经 CRS anthropic 腿（anthropic_base_url 不含 /v1，SDK 自动加 /v1/messages）
    assert c["llm"]["provider"] == "anthropic"
    assert c["llm"]["config"]["anthropic_base_url"] == "https://crs.chenge.ink/api"
    assert c["llm"]["config"]["model"] == "claude-sonnet-4-6"
    assert c["llm"]["config"]["api_key"] == "sk-test"
    # 抽取用专门小 max_tokens（anthropic 非流式 10min 限制；非吝啬，见 mem0_engine 注释）
    assert c["llm"]["config"]["max_tokens"] == me.CAPTURE_MAX_TOKENS
    # embedder = fastembed bge-small 384
    assert c["embedder"]["provider"] == "fastembed"
    assert c["embedder"]["config"]["model"] == me.BGE_MODEL
    assert c["embedder"]["config"]["embedding_dims"] == 384
    # vector_store = faiss on-disk，path pin DATA_ROOT/mem0/faiss
    assert c["vector_store"]["provider"] == "faiss"
    assert c["vector_store"]["config"]["path"] == str(tmp_path / "mem0" / "faiss")
    assert c["vector_store"]["config"]["embedding_model_dims"] == 384
    # history pin + 抽取约束 + version
    assert c["history_db_path"] == str(tmp_path / "mem0" / "history.db")
    assert "DURABLE" in c["custom_instructions"]
    assert "NEVER capture" in c["custom_instructions"]
    assert c["version"] == "v1.1"


def test_capture_model_precedence(monkeypatch, tmp_path):
    monkeypatch.setattr(me, "_mem0_root", lambda: str(tmp_path))
    # MEMORY_CAPTURE_MODEL 赢 LLM_MODEL
    monkeypatch.setattr(me, "cfg", _fake_cfg(memory_capture_model="gpt-5.4"))
    assert me.build_mem0_config()["llm"]["config"]["model"] == "gpt-5.4"
    # 显式 model 赢一切
    assert me.build_mem0_config(model="codex-x")["llm"]["config"]["model"] == "codex-x"
    # 都不给 → 回退 LLM_MODEL
    monkeypatch.setattr(me, "cfg", _fake_cfg())
    assert me.build_mem0_config()["llm"]["config"]["model"] == "claude-sonnet-4-6"


def test_prepare_runtime_env_disables_telemetry(monkeypatch, tmp_path):
    monkeypatch.setattr(me, "_mem0_root", lambda: str(tmp_path / "mem0"))
    monkeypatch.setenv("MEM0_TELEMETRY", "True")  # 模拟误设 → 必被强制覆盖
    monkeypatch.delenv("FASTEMBED_CACHE_PATH", raising=False)
    me._prepare_runtime_env()
    assert os.environ["MEM0_TELEMETRY"] == "False"
    assert os.environ["FASTEMBED_CACHE_PATH"] == str(tmp_path / "mem0" / "fastembed_cache")
    assert os.path.isdir(os.environ["FASTEMBED_CACHE_PATH"])


def test_lazy_no_construct_until_used():
    # 构造引擎不应构造 Memory（懒加载红线：flag-off 不加载重依赖）
    eng = me.Mem0Engine()
    assert eng._mem is None


def test_add_search_delete_forward(monkeypatch, tmp_path):
    monkeypatch.setattr(me, "_mem0_root", lambda: str(tmp_path / "mem0"))
    monkeypatch.setattr(me, "cfg", _fake_cfg())

    fake_mem = mock.MagicMock()
    fake_mem.add.return_value = {"results": [{"id": "m1", "memory": "x", "event": "ADD"}]}
    fake_mem.search.return_value = {"results": []}
    fake_mem.get_all.return_value = {"results": []}
    fake_Memory = mock.MagicMock()
    fake_Memory.from_config.return_value = fake_mem
    monkeypatch.setitem(sys.modules, "mem0", SimpleNamespace(Memory=fake_Memory))

    eng = me.Mem0Engine()
    out = eng.add(
        [{"role": "user", "content": "hi"}],
        user_id="u1",
        metadata={"source": "auto_capture"},
    )
    assert out["results"][0]["id"] == "m1"
    _, kwargs = fake_mem.add.call_args
    assert kwargs["user_id"] == "u1"
    assert kwargs["metadata"] == {"source": "auto_capture"}

    eng.search("q", user_id="u1", limit=5)
    fake_mem.search.assert_called_once_with("q", filters={"user_id": "u1"}, top_k=5)
    eng.get_all(user_id="u1")
    fake_mem.get_all.assert_called_once_with(filters={"user_id": "u1"})
    eng.delete("m1")
    fake_mem.delete.assert_called_once_with("m1")

    # from_config 拿到我们组装的 config（faiss/fastembed/anthropic 三件套）
    cfg_arg = fake_Memory.from_config.call_args[0][0]
    assert cfg_arg["vector_store"]["provider"] == "faiss"
    assert cfg_arg["llm"]["provider"] == "anthropic"
    assert cfg_arg["llm"]["config"]["anthropic_base_url"] == "https://crs.chenge.ink/api"


def test_singleton(monkeypatch):
    monkeypatch.setattr(me, "_engine", None)
    a = me.get_mem0_engine()
    b = me.get_mem0_engine()
    assert a is b
