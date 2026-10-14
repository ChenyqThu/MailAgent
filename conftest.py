"""pytest root conftest: 把项目根加进 sys.path 以便 `from src.* import ...` 能解析."""
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 测试默认不连任何 Redis。src.config 用 pydantic 直接读仓库根 .env（不经 load_dotenv），
# 开发机 .env 里的 REDIS_URL 指向生产 Redis，safe_publish 会把测试事件真发过去。
# 必须在任何测试模块 import src.config 之前设好：环境变量优先于 env_file，
# 空串让 config.redis_url == ""；测试里起的子进程也继承这一项。
# 需要 Redis 行为的测试自己 monkeypatch config.redis_url 并配 fake / 本地假服务端。
os.environ["REDIS_URL"] = ""

_LOCAL_REDIS_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "real_event_loopback: 不替换 src.events.loopback.publish_loopback（只给测 loopback 本身的用例用）",
    )


@pytest.fixture(autouse=True)
def _no_event_loopback(request, monkeypatch):
    """REDIS_URL 为空时 safe_publish 会把事件 POST 给本机 9200 的 serve。

    开发机上那往往是正在运行的 MailAgent：测试事件会打进活进程；对端不响应时
    每条要等 1s 超时，后台单线程排队还会拖住 pytest 退出。默认换成 no-op。
    """
    if request.node.get_closest_marker("real_event_loopback") is None:
        import src.events.loopback as loopback

        monkeypatch.setattr(loopback, "publish_loopback", lambda payload: None)


class RemoteRedisBlocked(RuntimeError):
    """测试期间有代码尝试连接非本机 Redis。

    不继承 redis 的 ConnectionError：那会触发 redis-py 的重试与退避。
    """


@pytest.fixture(autouse=True)
def forbid_remote_redis(monkeypatch):
    """拦截同步 / 异步 redis-py 连向非本机地址的连接，并让该测试失败。

    只抛异常不够：safe_publish / EventPublisher 会吞掉一切异常，所以违规先记下来，
    在 teardown 统一判失败。返回记录列表，供自检测试读取和清空。
    """
    import redis.asyncio.connection as async_conn
    import redis.connection as sync_conn

    violations = []

    def _check(conn):
        host = getattr(conn, "host", None)
        # host 为 None = unix socket 连接，天然是本机
        if host is not None and host not in _LOCAL_REDIS_HOSTS:
            target = f"{host}:{getattr(conn, 'port', '?')}"
            violations.append(target)
            raise RemoteRedisBlocked(f"测试期间禁止连接非本机 Redis: {target}")

    orig_sync = sync_conn.AbstractConnection.connect
    orig_async = async_conn.AbstractConnection.connect

    def sync_connect(self):
        _check(self)
        return orig_sync(self)

    async def async_connect(self):
        _check(self)
        return await orig_async(self)

    monkeypatch.setattr(sync_conn.AbstractConnection, "connect", sync_connect)
    monkeypatch.setattr(async_conn.AbstractConnection, "connect", async_connect)

    yield violations

    if violations:
        pytest.fail(f"测试期间尝试连接非本机 Redis: {sorted(set(violations))}", pytrace=False)
