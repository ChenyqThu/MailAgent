"""多文件夹同步配置: SYNC_FOLDERS / FOLDER_SYNC_PAST_DAYS / FOLDER_SYNC_MAX_MESSAGES
+ DavMailBackend._parse_custom_folders 白名单解析。"""
from __future__ import annotations

from types import SimpleNamespace

from src.config import Config
from src.mail.backend.davmail_backend import DavMailBackend


def test_config_field_defaults():
    """字段默认值: sync_folders 空 (零激活), past_days=90, max_messages=2000。"""
    f = Config.model_fields
    assert f["sync_folders"].default == ""
    assert f["folder_sync_past_days"].default == 90
    assert f["folder_sync_max_messages"].default == 2000


def test_config_fields_declared():
    """三字段都已声明 (env 映射由 pydantic-settings 处理; 实际读取在 CLI 测试覆盖)。"""
    f = Config.model_fields
    assert {"sync_folders", "folder_sync_past_days", "folder_sync_max_messages"} <= set(f)


def test_parse_custom_folders_empty():
    """空 = 零激活基线。"""
    assert DavMailBackend._parse_custom_folders(SimpleNamespace(sync_folders="")) == []
    assert DavMailBackend._parse_custom_folders(SimpleNamespace(sync_folders="  ,  ,")) == []


def test_parse_custom_folders_csv_legacy():
    """旧 CSV 格式（简单 ASCII 名）仍兼容。"""
    cfg = SimpleNamespace(sync_folders="Notion, Jira ,DMS&VvpO9lPRXgM-")
    assert DavMailBackend._parse_custom_folders(cfg) == ["Notion", "Jira", "DMS&VvpO9lPRXgM-"]


def test_parse_custom_folders_json_array():
    """JSON 数组格式（新默认）。"""
    cfg = SimpleNamespace(sync_folders='["Notion", "Jira", "DMS&VvpO9lPRXgM-"]')
    assert DavMailBackend._parse_custom_folders(cfg) == ["Notion", "Jira", "DMS&VvpO9lPRXgM-"]


def test_parse_custom_folders_json_comma_in_name():
    """🔴 关键: modified-UTF7 名含逗号 (对话历史记录=&W,mL3VOGU,KLsF9V-) JSON 不拆坏。"""
    cfg = SimpleNamespace(sync_folders='["Notion", "&W,mL3VOGU,KLsF9V-"]')
    assert DavMailBackend._parse_custom_folders(cfg) == ["Notion", "&W,mL3VOGU,KLsF9V-"]


def test_parse_custom_folders_csv_comma_name_would_break():
    """对照: 同样的含逗号名走 CSV 会被拆坏 (证明为何必须 JSON)。"""
    cfg = SimpleNamespace(sync_folders="&W,mL3VOGU,KLsF9V-")   # 旧 CSV
    out = DavMailBackend._parse_custom_folders(cfg)
    assert out != ["&W,mL3VOGU,KLsF9V-"]   # 被拆成 3 段坏名 → 正是 JSON 要解决的问题


def test_parse_custom_folders_malformed_json_falls_back_csv():
    """非法 JSON → 退回 CSV (不崩)。"""
    cfg = SimpleNamespace(sync_folders='["Notion", "Jira"')   # 缺右括号
    out = DavMailBackend._parse_custom_folders(cfg)
    assert isinstance(out, list)   # 不抛异常


def test_parse_custom_folders_dedup_preserve_order():
    cfg = SimpleNamespace(sync_folders="Notion,Jira,Notion,Jira")
    assert DavMailBackend._parse_custom_folders(cfg) == ["Notion", "Jira"]


def test_parse_custom_folders_excludes_inbox():
    """INBOX 主路径单独管, 必排除 (避免双拉)。大小写不敏感。"""
    cfg = SimpleNamespace(sync_folders="INBOX,Notion,inbox")
    assert DavMailBackend._parse_custom_folders(cfg) == ["Notion"]


def test_parse_custom_folders_missing_attr():
    """无 sync_folders 属性 (老配置) → 空, 不崩。"""
    assert DavMailBackend._parse_custom_folders(SimpleNamespace()) == []
