"""davmail.properties 单键同步测（``davmail.folderSizeLimit``）。

守住三件事：
  1. 只改命中的那一行 —— 文件里还有 OAuth token 路径 / cipher / 端口等要害配置，
     顺手重排就是把用户的桥配置搞坏。
  2. 注释行、前缀相似的别的 key 不能被误判成赋值行（Java .properties 不支持行内注释）。
  3. 文件不存在 / 写不进去时如实回报状态 —— UI 靠它诚实地说「这个设置当前不生效」，
     绝不能静默当成功。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from src.mail.davmail_properties import (
    PROPERTY_KEY,
    STATE_PREFIX,
    STATUS_DISABLED,
    STATUS_FILE_MISSING,
    STATUS_UNCHANGED,
    STATUS_UPDATED,
    apply_and_record,
    properties_path,
    read_current_value,
    sync_folder_size_limit,
)

SAMPLE = """# DavMail PoC config
davmail.mode=O365Manual
davmail.oauth.tokenFilePath=/tmp/token.dat

davmail.imapPort=1143
davmail.smtpPort=1025
"""


def _root(tmp_path: Path, content: str | None = SAMPLE) -> Path:
    root = tmp_path / "davmail-poc"
    (root / "config").mkdir(parents=True)
    if content is not None:
        properties_path(root).write_text(content, encoding="utf-8")
    return root


def test_appends_when_key_absent(tmp_path: Path):
    root = _root(tmp_path)
    result = sync_folder_size_limit(root, 500)

    assert result.status == STATUS_UPDATED
    assert result.file_value == "500"
    text = properties_path(root).read_text(encoding="utf-8")
    # 原有每一行原样保留，只在末尾追加
    assert text.startswith(SAMPLE)
    assert f"{PROPERTY_KEY}=500" in text
    assert read_current_value(properties_path(root)) == "500"


def test_replaces_existing_value_in_place(tmp_path: Path):
    root = _root(tmp_path, SAMPLE + f"{PROPERTY_KEY}=2000\ndavmail.ldapPort=0\n")
    result = sync_folder_size_limit(root, 500)

    assert result.status == STATUS_UPDATED
    lines = properties_path(root).read_text(encoding="utf-8").splitlines()
    assert f"{PROPERTY_KEY}=500" in lines
    assert f"{PROPERTY_KEY}=2000" not in lines
    # 其它行一行不动，行序不变
    assert lines[-1] == "davmail.ldapPort=0"
    assert lines[:6] == SAMPLE.splitlines()[:6]


def test_unchanged_when_already_desired(tmp_path: Path):
    root = _root(tmp_path, SAMPLE + f"{PROPERTY_KEY} = 500\n")
    before = properties_path(root).read_bytes()

    result = sync_folder_size_limit(root, 500)

    assert result.status == STATUS_UNCHANGED
    assert result.file_value == "500"
    assert properties_path(root).read_bytes() == before  # 一个字节都不该动


def test_comment_line_is_not_an_assignment(tmp_path: Path):
    """``# davmail.folderSizeLimit=100`` 是注释 —— 不能被当成当前值、也不能被改写。"""
    root = _root(tmp_path, SAMPLE + f"# {PROPERTY_KEY}=100\n! {PROPERTY_KEY}=200\n")

    assert read_current_value(properties_path(root)) is None

    result = sync_folder_size_limit(root, 500)
    text = properties_path(root).read_text(encoding="utf-8")
    assert result.status == STATUS_UPDATED
    assert f"# {PROPERTY_KEY}=100" in text  # 注释原样留着
    assert f"! {PROPERTY_KEY}=200" in text
    assert f"{PROPERTY_KEY}=500" in text.splitlines()


def test_prefix_similar_key_not_matched(tmp_path: Path):
    root = _root(tmp_path, SAMPLE + f"{PROPERTY_KEY}Extra=7\n")

    assert read_current_value(properties_path(root)) is None
    sync_folder_size_limit(root, 500)
    lines = properties_path(root).read_text(encoding="utf-8").splitlines()
    assert f"{PROPERTY_KEY}Extra=7" in lines
    assert f"{PROPERTY_KEY}=500" in lines


def test_colon_separator_and_duplicate_key_last_wins(tmp_path: Path):
    root = _root(tmp_path, SAMPLE + f"{PROPERTY_KEY}:100\n{PROPERTY_KEY}=300\n")

    assert read_current_value(properties_path(root)) == "300"  # Java: 后者生效

    sync_folder_size_limit(root, 500)
    lines = properties_path(root).read_text(encoding="utf-8").splitlines()
    assert f"{PROPERTY_KEY}:100" in lines  # 只改最后一处（生效的那处）
    assert f"{PROPERTY_KEY}=500" in lines
    assert f"{PROPERTY_KEY}=300" not in lines


def test_crlf_line_ending_preserved(tmp_path: Path):
    root = _root(tmp_path, f"davmail.imapPort=1143\r\n{PROPERTY_KEY}=100\r\n")

    sync_folder_size_limit(root, 500)

    raw = properties_path(root).read_bytes()
    assert raw == b"davmail.imapPort=1143\r\n" + f"{PROPERTY_KEY}=500\r\n".encode()


def test_missing_trailing_newline_before_append(tmp_path: Path):
    root = _root(tmp_path, "davmail.imapPort=1143")

    sync_folder_size_limit(root, 500)

    lines = properties_path(root).read_text(encoding="utf-8").splitlines()
    assert lines[0] == "davmail.imapPort=1143"  # 没被跟追加内容粘成一行
    assert f"{PROPERTY_KEY}=500" in lines


def test_non_utf8_file_roundtrips(tmp_path: Path):
    """latin-1 字节的配置文件不能在回写时被损坏（utf-8 解码失败 → latin-1 兜底）。"""
    root = _root(tmp_path, content=None)
    path = properties_path(root)
    path.write_bytes(b"# caf\xe9 comment\ndavmail.imapPort=1143\n")

    result = sync_folder_size_limit(root, 500)

    assert result.status == STATUS_UPDATED
    raw = path.read_bytes()
    assert raw.startswith(b"# caf\xe9 comment\n")  # 原字节不变
    # 追加块必须是 ASCII —— 中文注释在 latin-1 文件上 encode 会直接抛
    appended = raw.split(b"davmail.imapPort=1143\n", 1)[1]
    assert appended.decode("ascii")
    assert f"{PROPERTY_KEY}=500".encode() in appended


def test_file_missing_is_reported_not_created(tmp_path: Path):
    """找不到 davmail.properties = 这个设置不生效；绝不凭空造一个 DavMail 配置。"""
    root = tmp_path / "nowhere"

    result = sync_folder_size_limit(root, 500)

    assert result.status == STATUS_FILE_MISSING
    assert result.file_value is None
    assert not properties_path(root).exists()


@pytest.mark.parametrize("desired", [0, -1, None])
def test_zero_or_none_leaves_file_alone(tmp_path: Path, desired):
    root = _root(tmp_path, SAMPLE + f"{PROPERTY_KEY}=1234\n")
    before = properties_path(root).read_bytes()

    result = sync_folder_size_limit(root, desired)

    assert result.status == STATUS_DISABLED
    assert result.file_value == "1234"  # 仍读回来给 UI 显示
    assert properties_path(root).read_bytes() == before


class _FakeStore:
    def __init__(self) -> None:
        self.state: dict[str, str] = {}

    def set_state(self, key: str, value: str) -> bool:
        self.state[key] = value
        return True


def test_apply_and_record_writes_sync_state(tmp_path: Path):
    root = _root(tmp_path)
    store = _FakeStore()

    result = apply_and_record(store, root, 500)

    assert result.status == STATUS_UPDATED
    assert store.state[f"{STATE_PREFIX}status"] == STATUS_UPDATED
    assert store.state[f"{STATE_PREFIX}desired"] == "500"
    assert store.state[f"{STATE_PREFIX}file_value"] == "500"
    assert store.state[f"{STATE_PREFIX}path"] == str(properties_path(root))
    assert store.state[f"{STATE_PREFIX}synced_at"]


def test_apply_and_record_survives_sync_state_failure(tmp_path: Path):
    """sync_state 写不进去（DB 忙）时只丢状态展示，不能把启动流程拖崩。"""

    class _BrokenStore:
        def set_state(self, key: str, value: str) -> bool:
            raise RuntimeError("database is locked")

    result = apply_and_record(_BrokenStore(), _root(tmp_path), 500)

    assert result.status == STATUS_UPDATED
    assert read_current_value(properties_path(_root(tmp_path / "other"))) is None
