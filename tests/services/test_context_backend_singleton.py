"""ServiceContext.backend 进程级单例 (task 08-20-perf-draft-delete)。

serve-api 每请求新建 ctx (NotionSync loop 隔离), 但 backend 须进程级复用 ——
免去每写请求的 create_backend + probe_readiness 慢链 (实测 1.3-3.6s, 占删草稿
端到端 43-65%)。key = (backend 名, db 路径): 同进程同配置恰一个实例; 测试各自
tmp db 天然隔离。
"""

from unittest.mock import MagicMock


def _cfg(db_path):
    cfg = MagicMock()
    cfg.mailagent_backend = "davmail"
    cfg.sync_store_db_path = str(db_path)
    return cfg


def test_backend_shared_across_ctx_same_key(tmp_path, monkeypatch):
    from src.mail.backend import factory as factory_mod
    from src.services.context import ServiceContext

    calls = []

    def _fake_create(cfg, sync_store=None):
        calls.append(cfg)
        return MagicMock(name=f"backend-{len(calls)}")

    monkeypatch.setattr(factory_mod, "create_backend", _fake_create)

    db_a = tmp_path / "a.db"
    ctx1 = ServiceContext(_cfg(db_a))
    ctx2 = ServiceContext(_cfg(db_a))  # 模拟第二个请求的 per-request ctx
    assert ctx1.backend is ctx2.backend  # 同 (backend, db) → 复用, 不重建不重 probe
    assert len(calls) == 1

    db_b = tmp_path / "b.db"
    ctx3 = ServiceContext(_cfg(db_b))
    assert ctx3.backend is not ctx1.backend  # 不同 db (测试隔离) → 各自独立
    assert len(calls) == 2


def test_backend_create_failure_not_cached(tmp_path, monkeypatch):
    """probe 失败 (create_backend raise) 不缓存 → 下个请求重试, 保住 per-request
    时代「DavMail 恢复后自愈」的行为。"""
    from src.mail.backend import factory as factory_mod
    from src.services.context import ServiceContext

    calls = []

    def _flaky_create(cfg, sync_store=None):
        calls.append(cfg)
        if len(calls) == 1:
            raise RuntimeError("probe failed (davmail down)")
        return MagicMock(name="backend-recovered")

    monkeypatch.setattr(factory_mod, "create_backend", _flaky_create)

    db = tmp_path / "c.db"
    ctx1 = ServiceContext(_cfg(db))
    try:
        ctx1.backend
        raise AssertionError("expected create failure to propagate")
    except RuntimeError:
        pass
    ctx2 = ServiceContext(_cfg(db))
    assert ctx2.backend is not None  # 重试成功
    assert len(calls) == 2
