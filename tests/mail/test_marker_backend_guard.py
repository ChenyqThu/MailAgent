"""issue #34: 跨 backend marker id-space guard —— reconcile_marker_backend 契约。

真根因：last_max_row_id 在 applescript 是 Mail.app ROWID、在 davmail 是 IMAP UID，
跨 backend 切换复用 marker → get_new_emails 发 ``UID {外来marker+1}:*`` → silent-loss
（跳过整段未取区间 = 丢数据）或 deadlock（超时重刷巨量 = 卡死）。这里用真·临时 SQLite
覆盖 4 条动作路径（零 LLM / 零网络），把根因钉进回归网。

现场数据（reporter ZaneCai）：切 davmail 后 marker 从 applescript ROWID 127743 越过
davmail UID 空窗、卡在 391688；回切 applescript 后 marker 正常爬升 127793。
"""

from pathlib import Path

import pytest

from src.mail.sync_store import SyncStore


@pytest.fixture
def store(tmp_path: Path) -> SyncStore:
    return SyncStore(str(tmp_path / "sync.db"))


def test_first_run_no_marker(store: SyncStore):
    # 尚无 marker（真·首次运行）→ 'first'，不写 marker_backend（上层 baseline 分支负责盖）
    assert store.reconcile_marker_backend("davmail") == "first"
    assert store.get_last_max_row_id() == 0
    assert store.get_state("marker_backend") is None


def test_adopt_existing_marker_without_reset(store: SyncStore):
    # 本 guard 首次部署遇到既有 marker（无归属）→ 认领、不重置 → 存量稳态用户零扰动
    store.set_last_max_row_id(127743)
    assert store.reconcile_marker_backend("applescript") == "adopt"
    assert store.get_last_max_row_id() == 127743
    assert store.get_state("marker_backend") == "applescript"


def test_noop_same_backend(store: SyncStore):
    store.set_last_max_row_id(127743)
    store.set_state("marker_backend", "applescript")
    assert store.reconcile_marker_backend("applescript") == "noop"
    assert store.get_last_max_row_id() == 127743
    assert store.get_state("marker_backend") == "applescript"


def test_reset_on_cross_backend_switch(store: SyncStore):
    # #34 核心场景：marker 属 applescript ROWID (127743)，切 davmail → 必须清零重定基线，
    # 否则 get_new_emails 发 `UID 127744:*` 越过 84565–391673 整段 UID 空窗。
    store.set_last_max_row_id(127743)
    store.set_state("marker_backend", "applescript")
    assert store.reconcile_marker_backend("davmail") == "reset"
    assert store.get_last_max_row_id() == 0  # 清零 → 上层落 first-run baseline
    assert store.get_state("marker_backend") == "davmail"


def test_reset_reverse_direction(store: SyncStore):
    # 反向亦然：marker 属 davmail UID (卡住的 391688)，回切 applescript → 同样重置。
    store.set_last_max_row_id(391688)
    store.set_state("marker_backend", "davmail")
    assert store.reconcile_marker_backend("applescript") == "reset"
    assert store.get_last_max_row_id() == 0
    assert store.get_state("marker_backend") == "applescript"


def test_idempotent_after_adopt(store: SyncStore):
    # adopt 后立即再 reconcile 同 backend → noop（幂等，不反复写库/不误重置）
    store.set_last_max_row_id(127743)
    assert store.reconcile_marker_backend("applescript") == "adopt"
    assert store.reconcile_marker_backend("applescript") == "noop"
    assert store.get_last_max_row_id() == 127743
