"""出厂模板闸（群聊三个预设成员）—— ``src/agents/agent_templates.py``。

新装机器一个 custom agent 都没有时群聊候选池为空、拉不起群，这三个预设就是「一键有队友」。
它们是**草稿态**产物：导入后 enabled 恒 false、trigger=None（不自行开跑）、model=None（跟随
全局默认）。这里钉两件事：字段集同形（工厂纪律）、prompt 里没有累积式场景补丁。

场景补丁指「这次跑砸了就再补一句」的写法：那类规则该进 agent 配置或群设置，进了模板就会
让它越长越贵，而且每个装机用户都要为一次性的意外买单。
"""

from __future__ import annotations

import pytest

from src.agents.agent_templates import AGENT_TEMPLATES
from src.reports.wire import BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES

_GROUP_PRESET_KEYS = ("mail_digest", "followup_tracker", "meeting_scribe")
#: 累积式规则补丁的早期形态（「再补一句就好」）。命中 = 有人把一次意外写进了模板。
_SCENE_PATCH_WORDS = ("如果玩家", "特殊情况", "注意：")


@pytest.mark.parametrize("key", _GROUP_PRESET_KEYS)
def test_group_presets_present_and_factory_discipline(key: str) -> None:
    """三个预设在册且逐字同形：trigger=None（草稿态）/ model=None（§10 M2）/ 零越权授予 /
    头像取自 wire 词表。"""
    tpl = AGENT_TEMPLATES[key]
    assert tpl["trigger"] is None
    assert tpl["model"] is None
    assert tpl["tool_policy"]["grant_exec"] is False
    assert tpl["tool_policy"]["grant_web"] == "off"
    assert tpl["avatar"]["type"] == "bot"
    assert tpl["avatar"]["shape"] in BOT_AVATAR_SHAPES
    assert tpl["avatar"]["color"] in BOT_AVATAR_COLORS
    assert tpl["title"].strip()
    assert tpl["description"].strip()


@pytest.mark.parametrize("key", _GROUP_PRESET_KEYS)
def test_no_scene_patch_words_in_templates(key: str) -> None:
    prompt = AGENT_TEMPLATES[key]["prompt"]
    for word in _SCENE_PATCH_WORDS:
        assert word not in prompt, f"{key} prompt 出现场景补丁词 {word!r}（规则该进配置，不进模板）"
