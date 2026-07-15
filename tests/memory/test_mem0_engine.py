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


def _provider_route(**over):
    from src.llm_agent.provider_routing import ProviderRoute

    base = dict(
        provider_id="dashscope", protocol="openai-compatible",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key="sk-qwen", model_id="qwen-max", model_ref="dashscope:qwen-max",
    )
    base.update(over)
    return ProviderRoute(**base)


def test_capture_llm_config_openai_family_route(monkeypatch, tmp_path):
    # task 07-12 P2：flag on + openai 系 provider → mem0 openai provider + 归一 base（含 /vN）。
    from src.llm_agent import provider_routing as pr

    monkeypatch.setattr(me, "_mem0_root", lambda: str(tmp_path / "mem0"))
    monkeypatch.setattr(me, "cfg", _fake_cfg(memory_capture_model="dashscope:qwen-max"))
    monkeypatch.setattr(pr, "resolve_route", lambda ref: _provider_route())

    llm = me.build_mem0_config()["llm"]
    assert llm["provider"] == "openai"
    assert llm["config"]["model"] == "qwen-max"  # wire id（冒号后段）
    assert llm["config"]["api_key"] == "sk-qwen"
    assert llm["config"]["openai_base_url"] == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    assert llm["config"]["max_tokens"] == me.CAPTURE_MAX_TOKENS  # 8192 非流式 clamp 保持
    # 终审 LOW-①（钉死有意行为）：openai 分支刻意不传 temperature=None——mem0 OpenAILLM 走
    # base _get_common_params，temperature 键无条件进请求参数（AnthropicLLM 的 override 才会
    # 在 None 时省略字段），显式 None 会被 openai SDK 序列化成 wire 上的 "temperature": null
    # （官方接受、严格 openai-compatible 上游可能 400）。省略键 = mem0 默认 0.1。
    assert "temperature" not in llm["config"]

    # per-model max_output 更小 → 再收紧
    monkeypatch.setattr(pr, "resolve_route", lambda ref: _provider_route(max_output=4000))
    assert me.build_mem0_config()["llm"]["config"]["max_tokens"] == 4000


def test_capture_llm_config_anthropic_route(monkeypatch, tmp_path):
    # flag on + anthropic 协议 provider（Kimi anthropic-compat 类）→ 行 base 原样、8192 保持。
    from src.llm_agent import provider_routing as pr

    monkeypatch.setattr(me, "_mem0_root", lambda: str(tmp_path / "mem0"))
    monkeypatch.setattr(me, "cfg", _fake_cfg(memory_capture_model="kimi:kimi-k2"))
    route = _provider_route(
        provider_id="kimi", protocol="anthropic",
        base_url="https://api.moonshot.cn/anthropic/", api_key="sk-kimi",
        model_id="kimi-k2", model_ref="kimi:kimi-k2",
    )
    monkeypatch.setattr(pr, "resolve_route", lambda ref: route)

    llm = me.build_mem0_config()["llm"]
    assert llm["provider"] == "anthropic"
    assert llm["config"]["model"] == "kimi-k2"
    assert llm["config"]["api_key"] == "sk-kimi"
    assert llm["config"]["anthropic_base_url"] == "https://api.moonshot.cn/anthropic"
    assert llm["config"]["max_tokens"] == me.CAPTURE_MAX_TOKENS
    assert llm["config"]["temperature"] is None  # 同 legacy 语义

    # 行 base 空 = 官方默认 → 省略 anthropic_base_url（SDK 默认 api.anthropic.com）
    empty_base = _provider_route(provider_id="anthro", protocol="anthropic",
                                 base_url="", model_id="claude-x", model_ref="anthro:claude-x")
    monkeypatch.setattr(pr, "resolve_route", lambda ref: empty_base)
    assert "anthropic_base_url" not in me.build_mem0_config()["llm"]["config"]

    # HIGH-2：行 base 含 /v1 尾段（用户抄厂商文档）→ canonical_root 剥掉（SDK 自补 /v1/messages）
    v1_base = _provider_route(provider_id="glm", protocol="anthropic",
                              base_url="https://open.bigmodel.cn/api/anthropic/v1",
                              model_id="glm-4.6", model_ref="glm:glm-4.6")
    monkeypatch.setattr(pr, "resolve_route", lambda ref: v1_base)
    assert (
        me.build_mem0_config()["llm"]["config"]["anthropic_base_url"]
        == "https://open.bigmodel.cn/api/anthropic"
    )


def test_capture_llm_config_route_error_skips_capture(monkeypatch, tmp_path):
    # 终审 LOW-②：显式 providerRef 路由失败（provider 缺失/禁用）→ 跳过本轮 capture
    # （Mem0CaptureSkip），而非回退 legacy 网关发 'missing:m' 这类注定 404 的 bogus-model 请求。
    import pytest

    from src.llm_agent import provider_routing as pr

    monkeypatch.setattr(me, "_mem0_root", lambda: str(tmp_path / "mem0"))
    monkeypatch.setattr(me, "cfg", _fake_cfg(memory_capture_model="missing:m"))

    def _raise(ref):
        raise pr.ProviderRouteError(
            "provider 'missing' referenced by model 'missing:m' is not available"
        )

    monkeypatch.setattr(pr, "resolve_route", _raise)
    with pytest.raises(me.Mem0CaptureSkip, match="missing"):
        me.build_mem0_config()


def test_capture_llm_config_keyless_openai_provider_skips_capture(monkeypatch, tmp_path):
    # 终审 LOW-③：keyless openai 系 provider（本地 Ollama 等）作 capture 模型 → 跳过 + warning
    # ——mem0 OpenAILLM 空 key 会回退 env OPENAI_API_KEY 构造客户端（凭证错配/外泄）。
    import pytest

    from src.llm_agent import provider_routing as pr

    monkeypatch.setattr(me, "_mem0_root", lambda: str(tmp_path / "mem0"))
    monkeypatch.setattr(me, "cfg", _fake_cfg(memory_capture_model="ollama:qwen3"))
    route = _provider_route(
        provider_id="ollama", protocol="openai-compatible",
        base_url="http://127.0.0.1:11434/v1", api_key="",
        model_id="qwen3", model_ref="ollama:qwen3",
    )
    monkeypatch.setattr(pr, "resolve_route", lambda ref: route)
    with pytest.raises(me.Mem0CaptureSkip, match="ollama"):
        me.build_mem0_config()


def test_capture_llm_config_google_falls_back_to_legacy(monkeypatch, tmp_path):
    # google 协议不支持 → warning + 回退全局 anthropic 网关（legacy 形状）。
    from src.llm_agent import provider_routing as pr

    monkeypatch.setattr(me, "_mem0_root", lambda: str(tmp_path / "mem0"))
    monkeypatch.setattr(me, "cfg", _fake_cfg(memory_capture_model="gem:gemini-3"))
    route = _provider_route(provider_id="gem", protocol="google",
                            model_id="gemini-3", model_ref="gem:gemini-3")
    monkeypatch.setattr(pr, "resolve_route", lambda ref: route)

    llm = me.build_mem0_config()["llm"]
    assert llm["provider"] == "anthropic"
    assert llm["config"]["model"] == "gem:gemini-3"  # legacy：整串 + 全局网关
    assert llm["config"]["anthropic_base_url"] == "https://crs.chenge.ink/api"
    assert llm["config"]["api_key"] == "sk-test"


def test_package_lazy_export():
    # LOW-2（codex）：from src.memory import <符号> 经 __getattr__ 懒解析仍可用（import 包本身
    # 不拉 src.config / 重依赖）；未知属性照常 AttributeError。
    import pytest

    import src.memory as pkg

    assert pkg.get_mem0_engine is me.get_mem0_engine
    assert pkg.Mem0Engine is me.Mem0Engine
    with pytest.raises(AttributeError):
        _ = pkg.nonexistent_symbol
