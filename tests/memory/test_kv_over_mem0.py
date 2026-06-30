"""M5a-1 — kv-over-mem0 适配层单测（含 codex M5a-1 review 5 fix 覆盖）。

不依赖真实 mem0/FAISS/模型下载：用 spike（research/mem0-metadata-spike.md §1）+ mem0 2.0.10 源码
实测的契约写一个内存版 fake store，注入进 Mem0Engine（`eng._mem = fake`，绕过懒构造）。fake
**忠实**复刻源码验证过的行为，故适配层的复合逻辑（upsert 模拟去重、update 保 created_at、
get_all 任意字段过滤、kind 隔离、priority COALESCE）被真实测到，而非测 fake 本身：

- `add(messages, *, user_id, metadata, infer=False)` 追加新行（UUID），content→memory、
  metadata→扁平 payload，**不 dedup**（spike Q-dup），**只跳 content is None 不跳空串**
  （main.py:790 str-wrap + :834-840，codex LOW-1 依据）。
- `get_all(*, filters, top_k=20)` 按**任意 payload key** 等值过滤（spike Q2 / faiss `_apply_filters`），
  自定义 key 收进 `row["metadata"]`、value 在 `row["memory"]`、时间在顶层；默认 top_k=20 会截断
  （main.py:1206，codex MEDIUM-1 依据）。
- `update(memory_id, *, data, metadata)` 保 created_at + **merge** metadata（`new_metadata =
  deepcopy(existing); new_metadata.update(metadata)`，main.py:1972-1974 → 省略 priority 即保留旧值，
  codex HIGH-2 依据）+ 刷新 updated_at。
- `delete(memory_id)` by id。
"""
import importlib
import inspect
import sys

import pytest

from src.memory import kv_over_mem0 as kv
from src.memory import mem0_engine as me

USER = me.DEFAULT_USER_ID  # "owner"
KIND = me.KV_KIND  # "agent_memory_kv"

# mem0 promote 到顶层的 key（spike §1 Q2）；其余自定义 key（scope/key/priority/kind）收进 row["metadata"]。
_PROMOTED = {"user_id", "agent_id", "run_id", "actor_id", "role", "hash"}
_INTERNAL = {"data", "created_at", "updated_at"}


class FakeMemStore:
    """spike + mem0 2.0.10 源码 accurate 的内存 mem0 模型（见模块 docstring）。"""

    def __init__(self) -> None:
        self._rows: dict = {}  # id -> 扁平 payload
        self._seq = 0

    def add(self, messages, *, user_id=None, metadata=None, infer=True, **_):
        # mirror mem0 main.py:790 str/dict-wrap + :834-843 infer=False skip（**只跳 role/content
        # is None + system role，不跳空串** —— codex M5a-1 LOW-1 的源码依据）。
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]
        elif isinstance(messages, dict):
            messages = [messages]
        results = []
        for m in messages:
            if not isinstance(m, dict) or m.get("role") is None or m.get("content") is None:
                continue
            if m["role"] == "system":
                continue
            content = m["content"]
            self._seq += 1
            mid = f"m{self._seq}"
            # created_at 用递增微秒序号（避免 59 秒溢出，支持 >20 行 dupe 测试）、updated_at 初始
            # 等于它（update 后才分叉）
            ts = f"2026-06-30T00:00:00.{self._seq:06d}+00:00"
            payload = dict(metadata or {})
            payload.update(
                {"user_id": user_id, "data": content, "created_at": ts,
                 "updated_at": ts, "role": m["role"]}
            )
            self._rows[mid] = payload
            results.append({"id": mid, "memory": content, "event": "ADD"})
        return {"results": results}

    def get_all(self, *, filters=None, top_k=20, **_):
        f = dict(filters or {})
        out = [
            self._project(mid, p)
            for mid, p in self._rows.items()
            if all(k in p and p[k] == v for k, v in f.items())
        ]
        return {"results": out[:top_k]}  # mem0 默认 top_k=20 截断（MEDIUM-1）

    def update(self, memory_id, *, data=None, metadata=None, **_):
        p = self._rows[memory_id]
        if data is not None:
            p["data"] = data
        if metadata is not None:
            p.update(metadata)  # merge（保留 created_at / priority 等未传 key，main.py:1972-1974）
        p["updated_at"] = "2026-06-30T23:59:59+00:00"  # 刷新（与 created_at 分叉）
        return {"message": "Memory updated successfully!"}

    def delete(self, memory_id):
        self._rows.pop(memory_id, None)

    def _project(self, mid, p):
        meta = {k: v for k, v in p.items() if k not in _PROMOTED and k not in _INTERNAL}
        return {
            "id": mid,
            "memory": p["data"],
            "metadata": meta,
            "created_at": p["created_at"],
            "updated_at": p["updated_at"],
            "user_id": p.get("user_id"),
            "role": p.get("role"),
        }


@pytest.fixture
def fake_engine(monkeypatch):
    """注入 fake-backed 单例，让 kv_over_mem0 的 get_mem0_engine() 命中它。"""
    eng = me.Mem0Engine()
    eng._mem = FakeMemStore()  # 绕过懒构造（不触发 _prepare_runtime_env / 真 import）
    monkeypatch.setattr(me, "_engine", eng)
    return eng


# ── 适配层行为（经 shell 公共 API，M5a-2 端点将调这些）────────────────────────


def test_upsert_then_get_roundtrips(fake_engine):
    kv.kv_upsert("user", "communication_style", '"concise zh"', priority=3)
    row = kv.kv_get("user", "communication_style")
    assert row is not None
    assert row["scope"] == "user"
    assert row["key"] == "communication_style"
    assert row["value_json"] == '"concise zh"'
    assert row["priority"] == 3


def test_upsert_twice_no_dupe(fake_engine):
    # 核心 M5a 行为：mem0 add 不 dedup → upsert_kv 必须模拟 (scope,key) 唯一。
    kv.kv_upsert("user", "theme", '"dark"')
    kv.kv_upsert("user", "theme", '"light"')
    rows = kv.kv_list("user")
    assert len(rows) == 1
    assert rows[0]["value_json"] == '"light"'  # 第二次覆盖，非追加


def test_upsert_update_preserves_created_at(fake_engine):
    kv.kv_upsert("user", "tone", '"warm"', priority=0)
    first = kv.kv_get("user", "tone")
    created = first["created_at"]  # 现已是 epoch ms int（MEDIUM-2）
    assert isinstance(created, int)
    kv.kv_upsert("user", "tone", '"formal"', priority=7)  # 改值 + 改 priority
    after = kv.kv_get("user", "tone")
    assert after["created_at"] == created          # created_at 保留（spike Q3）
    assert after["updated_at"] != created          # updated_at 刷新
    assert after["value_json"] == '"formal"'
    assert after["priority"] == 7


def test_get_missing_returns_none(fake_engine):
    assert kv.kv_get("user", "never_set") is None


def test_list_scope_filter_precise(fake_engine):
    # 服务端 metadata 过滤精确（spike Q2）：scope 过滤只回该 scope；无 scope 回全量。
    kv.kv_upsert("user", "a", '"1"')
    kv.kv_upsert("user", "b", '"2"')
    kv.kv_upsert("project:falcon", "ship", '"2026-Q3"')
    user_rows = kv.kv_list("user")
    assert {r["key"] for r in user_rows} == {"a", "b"}
    proj_rows = kv.kv_list("project:falcon")
    assert {r["key"] for r in proj_rows} == {"ship"}
    assert len(kv.kv_list()) == 3  # scope=None → 全量


def test_delete_idempotent(fake_engine):
    kv.kv_upsert("user", "gone", '"x"')
    assert kv.kv_delete("user", "gone") == 1
    assert kv.kv_get("user", "gone") is None
    assert kv.kv_delete("user", "gone") == 0  # 幂等：不存在返 0


# ── codex M5a-1 review 5 fix 专项覆盖 ─────────────────────────────────────────


def test_capture_facts_excluded_from_kv_api(fake_engine):
    # 🔴 HIGH-1：kv 适配层与 M1/M2 capture 共享 store + user_id="owner"，但 capture 行 metadata 是
    # {source:auto_capture, session_id?}（**无** scope/key/kind）。kind=KV_KIND filter 必须把它们挡在
    # KV API 外，绝不当畸形 KV 行（scope/key=None）捞出 + 在 top_k 下挤掉真 KV 行。
    fake_engine._mem.add(
        [{"role": "user", "content": "user prefers dark mode"}],
        user_id=USER,
        metadata={"source": "auto_capture", "session_id": 7},  # 无 scope/key/kind
        infer=False,
    )
    kv.kv_upsert("user", "real", '"v"')  # 一条真 kv 行
    rows = kv.kv_list()
    assert len(rows) == 1  # capture 行被排除
    assert rows[0]["key"] == "real"
    assert all(r["scope"] is not None and r["key"] is not None for r in rows)
    # 按 scope 列、单条 get 同样绝不漏 capture 行（capture 无 scope，也无从用 (scope,key) 命中）
    assert len(kv.kv_list("user")) == 1
    assert kv.kv_get("user", "real") is not None


def test_upsert_omit_priority_preserves_pinned(fake_engine):
    # 🔴 HIGH-2：value-only 覆写（priority 省略=None）绝不把 pinned 记忆降回 0 —— 忠实复现 SQLite
    # COALESCE(?, existing)（db.py:651）。mem0 update 的 metadata 是 merge，省略 priority 即保留旧值。
    kv.kv_upsert("user", "pin", '"v1"', priority=5)
    assert kv.kv_get("user", "pin")["priority"] == 5
    kv.kv_upsert("user", "pin", '"v2"')  # priority 省略（None）→ 必须保留 5
    after = kv.kv_get("user", "pin")
    assert after["priority"] == 5          # 不被降回 0（HIGH-2 修复核心断言）
    assert after["value_json"] == '"v2"'   # value 更新


def test_insert_omit_priority_defaults_zero(fake_engine):
    # 🔴 HIGH-2 insert 路径：全新行 priority 省略 → 默认 0（COALESCE(?, 0)，db.py:645）。
    kv.kv_upsert("user", "np", '"v"')
    assert kv.kv_get("user", "np")["priority"] == 0


def test_upsert_cleans_dupes_beyond_top_k(fake_engine):
    # 🔴 MEDIUM-1：mem0 get_all 默认 top_k=20 会截断 → 漏掉 >20 行的 dupe 清理。find/upsert/delete
    # 用 KV_FETCH_CAP 显式高 cap → 看到全部 25 行，收敛到 1。
    md = {"scope": "user", "key": "big", "kind": KIND, "priority": 0}
    for i in range(25):
        fake_engine._mem.add(f'"d{i}"', user_id=USER, metadata=md, infer=False)
    filt = {"user_id": USER, "kind": KIND, "scope": "user", "key": "big"}
    assert len(fake_engine.find(filt)) == 25  # find 用高 cap 看到全部 25（非默认 20 截断）
    kv.kv_upsert("user", "big", '"final"', priority=1)
    remaining = fake_engine.find(filt)
    assert len(remaining) == 1  # 25 → 1（>20 全清，证明未被 top_k=20 截断）
    assert remaining[0]["memory"] == '"final"'


def test_row_to_kv_full_wire_shape(fake_engine):
    # 🔴 MEDIUM-2：_row_to_kv 必返完整 AgentMemoryEntry（model.ts:116-131）—— 4 个 source_* + numeric
    # epoch-ms 时间戳，M5a-2 端点替换 ChatDb 后前端零改。
    kv.kv_upsert("user", "w", '"v"', priority=2)
    row = kv.kv_get("user", "w")
    assert set(row) == {
        "scope", "key", "value_json", "source_wiki_path", "source_session_id",
        "source_message_id", "source_tool_use_id", "priority", "created_at", "updated_at",
    }
    assert row["source_wiki_path"] is None
    assert row["source_session_id"] is None
    assert row["source_message_id"] is None
    assert row["source_tool_use_id"] is None
    assert isinstance(row["created_at"], int)  # ISO → epoch ms
    assert isinstance(row["updated_at"], int)
    assert row["priority"] == 2


def test_empty_value_preserved(fake_engine):
    # 🔴 LOW-1：mem0 infer=False **只跳 content is None 不跳空串**（main.py:834-840）→ "" 直接存，
    # 适配层不再改写成单空格（去 lossy fallback）。
    kv.kv_upsert("user", "blank", "")
    row = kv.kv_get("user", "blank")
    assert row is not None
    assert row["value_json"] == ""  # 原样保留，非 " "


def test_list_sorted_by_updated_at_desc(fake_engine):
    # MEDIUM-1 续：kv_list 按 updated_at 倒序（镜像 ChatDb ORDER BY updated_at DESC）。后写的（updated_at
    # 更新）排前。
    kv.kv_upsert("user", "first", '"1"')
    kv.kv_upsert("user", "second", '"2"')
    kv.kv_upsert("user", "first", '"1b"')  # 重写 first → updated_at 刷新到最新
    keys = [r["key"] for r in kv.kv_list("user")]
    assert keys[0] == "first"  # 最近 updated 的排最前


# ── engine 原语（直接验证复合/过滤底座）───────────────────────────────────────


def test_find_server_side_metadata_filter(fake_engine):
    fake_engine.upsert_kv("user", "k1", '"v1"')
    fake_engine.upsert_kv("user", "k2", '"v2"')
    exact = fake_engine.find({"user_id": USER, "scope": "user", "key": "k1"})
    assert len(exact) == 1
    assert exact[0]["memory"] == '"v1"'
    assert fake_engine.find({"user_id": USER, "scope": "user", "key": "nope"}) == []


def test_upsert_cleans_stale_dupes(fake_engine):
    # 历史累积的同 (scope,key) 重复行（raw add 两次模拟，带 kind = 真 kv 行）→ upsert_kv 收敛到 1 行。
    md = {"scope": "user", "key": "dup", "kind": KIND, "priority": 0}
    fake_engine._mem.add('"old1"', user_id=USER, metadata=md, infer=False)
    fake_engine._mem.add('"old2"', user_id=USER, metadata=md, infer=False)
    assert len(fake_engine.find({"user_id": USER, "kind": KIND, "scope": "user", "key": "dup"})) == 2
    fake_engine.upsert_kv("user", "dup", '"new"', priority=2)
    remaining = fake_engine.find({"user_id": USER, "kind": KIND, "scope": "user", "key": "dup"})
    assert len(remaining) == 1
    assert remaining[0]["memory"] == '"new"'


def test_update_primitive_preserves_created_at(fake_engine):
    out = fake_engine._mem.add(
        '"v"', user_id=USER, metadata={"scope": "user", "key": "u", "priority": 0},
        infer=False,
    )
    mid = out["results"][0]["id"]
    created = fake_engine.find({"user_id": USER, "key": "u"})[0]["created_at"]
    fake_engine.update(mid, data='"v2"', metadata={"priority": 5})
    row = fake_engine.find({"user_id": USER, "key": "u"})[0]
    assert row["created_at"] == created
    assert row["memory"] == '"v2"'
    assert row["metadata"]["priority"] == 5


def test_update_omit_priority_merge_preserves(fake_engine):
    # 🔴 HIGH-2 引擎层证据：mem0 update 的 metadata 是 **merge**（非 replace）—— 省略 priority 时旧值
    # 保留。本测同时锁住 fake 忠实复刻该源码行为（main.py:1972-1974）。
    out = fake_engine._mem.add(
        '"v"', user_id=USER, metadata={"scope": "user", "key": "m", "kind": KIND, "priority": 9},
        infer=False,
    )
    mid = out["results"][0]["id"]
    # update 仅传 scope/key/kind（不传 priority）→ merge 后 priority 仍 9
    fake_engine.update(mid, data='"v2"', metadata={"scope": "user", "key": "m", "kind": KIND})
    row = fake_engine.find({"user_id": USER, "kind": KIND, "key": "m"})[0]
    assert row["memory"] == '"v2"'
    assert row["metadata"]["priority"] == 9  # merge 保留，未被抹除


# ── flag-off 不变量 ──────────────────────────────────────────────────────────


def test_existing_engine_signatures_unchanged():
    # flag-off 字节级：M5a-1 只新增方法，现有 4 个签名绝不动（capture/search/compile/undo 稳定）。
    assert list(inspect.signature(me.Mem0Engine.add).parameters) == [
        "self", "messages", "user_id", "metadata",
    ]
    assert list(inspect.signature(me.Mem0Engine.search).parameters) == [
        "self", "query", "user_id", "limit",
    ]
    assert list(inspect.signature(me.Mem0Engine.get_all).parameters) == ["self", "user_id"]
    assert list(inspect.signature(me.Mem0Engine.delete).parameters) == ["self", "memory_id"]


def test_import_adapter_does_not_load_mem0(monkeypatch):
    # 懒加载红线：import 适配层不触发 mem0/fastembed/faiss 重依赖（flag-off 零加载）。
    monkeypatch.delitem(sys.modules, "mem0", raising=False)
    mod = importlib.import_module("src.memory.kv_over_mem0")
    importlib.reload(mod)  # 强制重跑 top-level，确认无 mem0 顶层 import
    assert "mem0" not in sys.modules
