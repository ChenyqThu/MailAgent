"""EventPublisher 单测 (Sprint 15 Stage 2).

覆盖:
- redis_url 空 → noop / publish 返 False
- redis_url 设但 redis 不可达 → silent 不抛
- 正常 publish → fakeredis pubsub 收到 payload
- payload schema: {event_type, ts, internal_id, data, source}
- safe_publish 异常 silent
- get_publisher() 单例 + reset_publisher_for_tests
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch


from src.events.inprocess_bus import (
    InProcessEventBus,
    reset_inprocess_bus_for_tests,
)
from src.events.publisher import (
    DEFAULT_CHANNEL,
    EventPublisher,
    get_publisher,
    reset_publisher_for_tests,
    safe_publish,
)


# ============================================================
# noop / failure paths
# ============================================================

class TestNoopAndFailure:
    def test_empty_redis_url_returns_false(self):
        p = EventPublisher(redis_url="", redis_db=2)
        assert p.publish("email.new") is False

    def test_init_exception_silent(self):
        p = EventPublisher(redis_url="redis://invalid-host-noresolve:9999", redis_db=2)
        # 不抛异常，返 False
        assert p.publish("email.new") is False

    def test_publish_exception_silent(self):
        """client.publish 抛 → publish 返 False, 不传播."""
        p = EventPublisher(redis_url="redis://localhost:6379", redis_db=2)
        mock_client = MagicMock()
        mock_client.publish.side_effect = RuntimeError("network down")
        p._client = mock_client
        assert p.publish("email.new") is False


# ============================================================
# Happy paths with mocked client
# ============================================================

class TestPublishHappy:
    def test_publish_called_with_correct_args(self):
        p = EventPublisher(redis_url="redis://localhost:6379", redis_db=2)
        mock_client = MagicMock()
        mock_client.publish = MagicMock(return_value=1)
        p._client = mock_client

        ok = p.publish(
            "email.synced",
            internal_id=53675,
            data={"subject": "Hello"},
            source="new_watcher",
        )
        assert ok is True
        mock_client.publish.assert_called_once()
        channel_arg = mock_client.publish.call_args.args[0]
        payload_arg = mock_client.publish.call_args.args[1]
        assert channel_arg == DEFAULT_CHANNEL
        parsed = json.loads(payload_arg)
        assert parsed["event_type"] == "email.synced"
        assert parsed["internal_id"] == 53675
        assert parsed["data"] == {"subject": "Hello"}
        assert parsed["source"] == "new_watcher"
        assert isinstance(parsed["ts"], (int, float))
        assert parsed["ts"] > 0

    def test_default_source(self):
        p = EventPublisher(redis_url="redis://localhost:6379", redis_db=2)
        mock = MagicMock(return_value=1)
        p._client = MagicMock(publish=mock)
        p.publish("outbox.done")
        parsed = json.loads(mock.call_args.args[1])
        assert parsed["source"] == "mailagent"

    def test_custom_channel(self):
        p = EventPublisher(
            redis_url="redis://localhost:6379", redis_db=2,
            channel="mailagent:events:test",
        )
        mock = MagicMock(return_value=1)
        p._client = MagicMock(publish=mock)
        p.publish("email.new")
        assert mock.call_args.args[0] == "mailagent:events:test"

    def test_data_serializes_with_str_fallback(self):
        """payload data 含非 json native 类型 (例 datetime) 时不抛, 用 str 兜底."""
        from datetime import datetime
        p = EventPublisher(redis_url="redis://localhost:6379", redis_db=2)
        mock = MagicMock(return_value=1)
        p._client = MagicMock(publish=mock)
        ok = p.publish("email.new", data={"now": datetime(2026, 5, 19)})
        assert ok is True
        parsed = json.loads(mock.call_args.args[1])
        assert "2026" in parsed["data"]["now"]  # datetime → str fallback


# ============================================================
# safe_publish + singleton
# ============================================================

class TestSafePublishAndSingleton:
    def setup_method(self):
        reset_publisher_for_tests()
        reset_inprocess_bus_for_tests()

    def teardown_method(self):
        reset_publisher_for_tests()
        reset_inprocess_bus_for_tests()

    def test_get_publisher_singleton(self):
        a = get_publisher()
        b = get_publisher()
        assert a is b

    def test_reset_returns_new_instance(self):
        a = get_publisher()
        reset_publisher_for_tests()
        b = get_publisher()
        assert a is not b

    def test_safe_publish_swallows_exceptions(self, monkeypatch):
        """safe_publish 任何异常 silent (redis 分支 get_publisher 抛)."""
        from src.config import config
        monkeypatch.setattr(config, "redis_url", "redis://localhost:6379")
        with patch("src.events.publisher.get_publisher", side_effect=RuntimeError("boom")):
            safe_publish("email.new", internal_id=1)  # 不抛即通过

    def test_safe_publish_redis_set_routes_to_redis(self, monkeypatch):
        """redis_url 非空 → EventPublisher.publish, 不碰进程内总线 (回归 guard)."""
        from src.config import config
        monkeypatch.setattr(config, "redis_url", "redis://localhost:6379")
        with patch.object(EventPublisher, "publish", return_value=True) as mock_pub, \
             patch.object(InProcessEventBus, "publish") as mock_bus:
            get_publisher()  # 触发单例 init
            safe_publish("email.synced", internal_id=42, data={"x": 1}, source="cli")
            mock_pub.assert_called_once()
            kwargs = mock_pub.call_args.kwargs
            assert kwargs.get("internal_id") == 42
            assert kwargs.get("data") == {"x": 1}
            assert kwargs.get("source") == "cli"
            mock_bus.assert_not_called()

    def test_safe_publish_no_redis_routes_to_bus(self, monkeypatch):
        """redis_url 空 → 投进程内总线 (合法 JSON frame), 不调 EventPublisher.publish."""
        from src.config import config
        monkeypatch.setattr(config, "redis_url", "")
        with patch.object(EventPublisher, "publish", return_value=True) as mock_pub, \
             patch.object(InProcessEventBus, "publish") as mock_bus:
            safe_publish("email.synced", internal_id=42, data={"x": 1}, source="cli")
            mock_bus.assert_called_once()
            frame = mock_bus.call_args.args[0]
            parsed = json.loads(frame)
            assert parsed["event_type"] == "email.synced"
            assert parsed["internal_id"] == 42
            assert parsed["data"] == {"x": 1}
            assert parsed["source"] == "cli"
            assert isinstance(parsed["ts"], (int, float))
            mock_pub.assert_not_called()

    def test_payload_schema_parity(self, monkeypatch):
        """bus frame schema 与 EventPublisher 序列化一致 (单源 _build_payload)."""
        from src.config import config
        # Redis 分支序列化
        p = EventPublisher(redis_url="redis://x", redis_db=2)
        mock = MagicMock(return_value=1)
        p._client = MagicMock(publish=mock)
        p.publish("email.new", internal_id=7, data={"k": "v"}, source="s")
        redis_payload = json.loads(mock.call_args.args[1])
        # 进程内总线分支序列化
        monkeypatch.setattr(config, "redis_url", "")
        with patch.object(InProcessEventBus, "publish") as mock_bus:
            safe_publish("email.new", internal_id=7, data={"k": "v"}, source="s")
        bus_payload = json.loads(mock_bus.call_args.args[0])
        redis_payload.pop("ts")
        bus_payload.pop("ts")
        assert redis_payload == bus_payload


# ============================================================
# close()
# ============================================================

class TestClose:
    def test_close_clears_client(self):
        p = EventPublisher(redis_url="redis://localhost:6379", redis_db=2)
        mock = MagicMock()
        p._client = mock
        p.close()
        assert p._client is None
        mock.close.assert_called_once()

    def test_close_when_no_client(self):
        p = EventPublisher(redis_url="redis://localhost:6379", redis_db=2)
        p.close()  # 不抛
        assert p._client is None
