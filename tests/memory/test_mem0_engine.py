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


def test_store_lock_serializes_all_access():
    # HIGH-1（codex）：search/get_all 与 add/delete 必须共用 store 锁 —— 打包的 mem0 FAISS store
    # 无内部锁，capture 后台 add 与 M2 search 并发进同一 index = C++/dict 并发读写损坏。验证任意
    # 时刻最多 1 个调用进入底层 Memory（锁有效）；若 search 不锁会观察到 max >1。
    import threading
    import time

    eng = me.Mem0Engine()
    state = {"in_flight": 0, "max": 0}
    guard = threading.Lock()
    # Barrier：所有线程到齐再同时冲入 → 确定性制造并发竞争（不靠 sleep 赌重叠，消除 timing
    # false-pass：极端调度下线程若从不真正重叠，无锁 bug 会被漏过）。
    n_calls = 9
    barrier = threading.Barrier(n_calls)

    def track(*_a, **_k):
        with guard:
            state["in_flight"] += 1
            state["max"] = max(state["max"], state["in_flight"])
        time.sleep(0.02)  # 拉长窗口：若 search 不锁，必与 add 重叠
        with guard:
            state["in_flight"] -= 1
        return {"results": []}

    fake = mock.MagicMock()
    fake.add.side_effect = track
    fake.search.side_effect = track
    fake.get_all.side_effect = track
    eng._mem = fake  # 跳过真实构造，直接注入 mock store

    def call(fn):
        barrier.wait()  # 等齐 9 线程再冲，确定性并发尝试 store 访问
        fn()

    threads = []
    for _ in range(3):
        threads.append(threading.Thread(target=call, args=(lambda: eng.add([], "owner"),)))
        threads.append(threading.Thread(target=call, args=(lambda: eng.search("q", "owner"),)))
        threads.append(threading.Thread(target=call, args=(lambda: eng.get_all("owner"),)))
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert state["max"] == 1  # store 锁序列化所有访问，无并发进 FAISS


def test_capture_instructions_untrusted_framing(monkeypatch, tmp_path):
    # HIGH-2（codex）：抽取约束须把消息内容当不可信数据，防 capture 投毒（恶意邮件/assistant
    # 幻觉/「好的记住了」→ 长期事实，或内容里的 remember/override 指令被当命令）。
    monkeypatch.setattr(me, "_mem0_root", lambda: str(tmp_path / "mem0"))
    monkeypatch.setattr(me, "cfg", _fake_cfg())
    low = me.build_mem0_config()["custom_instructions"].lower()
    assert "untrusted" in low  # 消息内容是不可信数据
    assert "assistant" in low and "not a source of truth" in low  # assistant 输出非事实来源
    assert "ignore any instruction" in low  # 忽略内容里的指令注入
    assert "auto-approve" in low or "approval" in low  # 不存审批/安全相关「偏好」


def test_package_lazy_export():
    # LOW-2（codex）：from src.memory import <符号> 经 __getattr__ 懒解析仍可用（import 包本身
    # 不拉 src.config / 重依赖）；未知属性照常 AttributeError。
    import pytest

    import src.memory as pkg

    assert pkg.get_mem0_engine is me.get_mem0_engine
    assert pkg.Mem0Engine is me.Mem0Engine
    with pytest.raises(AttributeError):
        _ = pkg.nonexistent_symbol
