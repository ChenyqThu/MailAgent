"""src/kos/doctor.py 分步连接检查（issue #54）。

stub client 注入（镜像 test_kos_save 模式），覆盖：全绿 / 凭据缺失即停 / health 挂即停 /
token 挂即停 / list_pages 挂（前三步保持 ok）/ 开关未开显因 / 非 KOSError 异常转 fail。
"""

from __future__ import annotations

from typing import Any, List, Optional

from src.kos.client import KOSError
from src.kos.doctor import KOS_CRED_KEYS, run_kos_doctor


class _StubKos:
    def __init__(
        self,
        *,
        health_error: Optional[Exception] = None,
        token_error: Optional[Exception] = None,
        list_error: Optional[Exception] = None,
        list_result: Any = None,
    ):
        self._health_error = health_error
        self._token_error = token_error
        self._list_error = list_error
        self._list_result = [] if list_result is None else list_result
        self.calls: List[str] = []

    def health(self):
        self.calls.append("health")
        if self._health_error is not None:
            raise self._health_error
        return {"status": "ok", "version": "0.38.2.0", "engine": "postgres"}

    def _refresh_token(self):
        self.calls.append("token")
        if self._token_error is not None:
            raise self._token_error
        return "tok"

    def list_pages(self, *, limit: int):
        self.calls.append(f"list_pages:{limit}")
        if self._list_error is not None:
            raise self._list_error
        return self._list_result


def _statuses(checks):
    return [(c["check"], c["status"]) for c in checks]


def test_all_green():
    client = _StubKos(list_result=[{"slug": "a"}])
    checks = run_kos_doctor(client, missing_keys=[], consumer_enabled=True)
    assert [c["status"] for c in checks] == ["ok", "ok", "ok", "ok"]
    assert client.calls == ["health", "token", "list_pages:1"]
    assert "version=0.38.2.0" in checks[1]["detail"]
    assert "返回 1 条" in checks[3]["detail"]


def test_missing_creds_stops_early():
    client = _StubKos()
    checks = run_kos_doctor(
        client, missing_keys=["KOS_MCP_BASE", "KOS_OAUTH_CLIENT_SECRET"], consumer_enabled=True
    )
    assert len(checks) == 1
    assert checks[0]["status"] == "fail"
    assert "KOS_MCP_BASE" in checks[0]["detail"]
    assert client.calls == []  # 一次网络调用都不发


def test_consumer_off_flagged_in_detail():
    """凭据齐全但开关关：步骤仍全跑（连通性照测），detail 显式说明 gate 不激活。"""
    client = _StubKos()
    checks = run_kos_doctor(client, missing_keys=[], consumer_enabled=False)
    assert checks[0]["status"] == "ok"
    assert "MAILAGENT_KOS_CONSUMER_ENABLED" in checks[0]["detail"]
    assert len(checks) == 4


def test_health_fail_stops():
    client = _StubKos(health_error=KOSError("connect refused", code="E_KOS_HEALTH"))
    checks = run_kos_doctor(client, missing_keys=[], consumer_enabled=True)
    assert _statuses(checks)[-1] == ("服务可达 (GET /health)", "fail")
    assert len(checks) == 2
    assert "E_KOS_HEALTH" in checks[1]["detail"]
    assert client.calls == ["health"]  # token / list_pages 不再跑


def test_token_fail_stops():
    client = _StubKos(token_error=KOSError("HTTP 401", code="E_KOS_TOKEN_HTTP", status=401))
    checks = run_kos_doctor(client, missing_keys=[], consumer_enabled=True)
    assert len(checks) == 3
    assert checks[2]["status"] == "fail"
    assert "E_KOS_TOKEN_HTTP" in checks[2]["detail"]


def test_list_pages_fail_keeps_prior_ok():
    client = _StubKos(list_error=KOSError("429", code="E_KOS_RATE_LIMIT", status=429))
    checks = run_kos_doctor(client, missing_keys=[], consumer_enabled=True)
    assert [c["status"] for c in checks] == ["ok", "ok", "ok", "fail"]
    assert "E_KOS_RATE_LIMIT" in checks[3]["detail"]


def test_unexpected_exception_becomes_fail_row():
    """doctor 面不许把非 KOSError 异常抛给 endpoint（会变 500）——转 fail 行。"""
    client = _StubKos(health_error=ValueError("boom"))
    checks = run_kos_doctor(client, missing_keys=[], consumer_enabled=True)
    assert checks[1]["status"] == "fail"
    assert "unexpected" in checks[1]["detail"]


def test_cred_keys_constant():
    """端点侧靠这个常量热读凭据——别静默改名。"""
    assert KOS_CRED_KEYS == ("KOS_MCP_BASE", "KOS_OAUTH_CLIENT_ID", "KOS_OAUTH_CLIENT_SECRET")
