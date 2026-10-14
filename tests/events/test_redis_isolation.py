"""根 conftest 的 Redis 隔离自检。

开发机 .env 里的 REDIS_URL 指向生产 Redis；测试必须既读不到它，也连不出去。
两条都要钉住：只清 REDIS_URL 挡不住显式 from_url 的代码，只靠连接闸又会让
safe_publish 在每个测试里撞闸（且闸被吞掉后只在 teardown 才报）。
"""

from __future__ import annotations

import asyncio

import pytest
import redis
import redis.asyncio

from src.config import config
from src.events.publisher import (
    get_publisher,
    reset_publisher_for_tests,
    safe_publish,
)

# TEST-NET-3 (RFC 5737)，保证不是任何真实主机
_REMOTE = "203.0.113.1"


def test_config_redis_url_is_empty_under_pytest():
    assert config.redis_url == ""


def test_publisher_singleton_has_no_redis_client():
    reset_publisher_for_tests()
    try:
        assert get_publisher()._client_or_none() is None
    finally:
        reset_publisher_for_tests()


def test_safe_publish_does_not_touch_redis(forbid_remote_redis):
    safe_publish("email.synced", internal_id=1, source="test")
    assert forbid_remote_redis == []


def test_safe_publish_does_not_post_to_local_serve(monkeypatch):
    """REDIS_URL 为空时 safe_publish 落 loopback；测试里它必须是 no-op，不碰本机 9200。"""
    import src.events.loopback as lb

    submitted = []
    monkeypatch.setattr(lb, "_get_executor", lambda: submitted.append(1))
    safe_publish("matter.changed", data={"public_id": "MAT-1"}, source="test")
    assert submitted == []


def test_guard_blocks_sync_remote_redis(forbid_remote_redis):
    client = redis.Redis(host=_REMOTE, port=6379, socket_connect_timeout=0.2)
    with pytest.raises(RuntimeError, match="非本机 Redis"):
        client.ping()
    assert forbid_remote_redis == [f"{_REMOTE}:6379"]
    forbid_remote_redis.clear()  # 违规是本用例故意制造的，别让 teardown 判失败


def test_guard_blocks_async_remote_redis(forbid_remote_redis):
    async def _ping():
        client = redis.asyncio.from_url(f"redis://{_REMOTE}:6379/2", socket_connect_timeout=0.2)
        try:
            await client.ping()
        finally:
            await client.aclose()

    with pytest.raises(RuntimeError, match="非本机 Redis"):
        asyncio.run(_ping())
    assert forbid_remote_redis == [f"{_REMOTE}:6379"]
    forbid_remote_redis.clear()


def test_guard_records_violation_swallowed_by_publisher(forbid_remote_redis, monkeypatch):
    """publisher 吞掉一切异常，所以闸必须靠记录而不是靠抛错让测试失败。"""
    monkeypatch.setattr(config, "redis_url", f"redis://{_REMOTE}:6379")
    reset_publisher_for_tests()
    try:
        safe_publish("email.synced", internal_id=1, source="test")  # 不抛
    finally:
        reset_publisher_for_tests()
    assert forbid_remote_redis == [f"{_REMOTE}:6379"]
    forbid_remote_redis.clear()
