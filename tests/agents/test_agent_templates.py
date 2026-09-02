"""出厂模板闸（g3 狼人杀两个模板）—— ``src/agents/agent_templates.py``。

模板是**跨局复用**的产物：一局跑砸了改的应该是群设置或角色分配，不是往 prompt 里加一句
「如果玩家 X 不投票就……」。累积式规则补丁会让模板越长越贵、还把游戏规则搬进 agent 身份，
所以这里钉三件事：字段集同形（工厂纪律）、prompt 预算与必备串、**零角色词 / 零场景补丁词**。

角色只存在于 ``group_config_json.game.roles``（服务端事实，经 ``<game_secret>`` 注入）：
玩家模板里出现任何角色词都意味着有人开始在 prompt 里写游戏状态。
"""

from __future__ import annotations

import pytest

from src.agents import werewolf_lab
from src.agents.agent_templates import (
    AGENT_TEMPLATES,
    WEREWOLF_JUDGE_TITLE,
    WEREWOLF_PLAYER_TITLES,
)
from src.chat.group_limits import GAME_OVER_PREFIX
from src.reports.wire import BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES

_WEREWOLF_KEYS = ("werewolf_judge", "werewolf_player")
#: 累积式规则补丁的早期形态（「再补一句就好」）。命中 = 有人把一局的意外写进了模板。
_SCENE_PATCH_WORDS = ("如果玩家", "特殊情况", "注意：")


@pytest.mark.parametrize("key", _WEREWOLF_KEYS)
def test_werewolf_templates_present_and_factory_discipline(key: str) -> None:
    """两个模板在册，且与既有出厂预设逐字同形：trigger=None（草稿态）/ model=None（§10 M2）/
    零技能 / 头像取自 wire 词表。"""
    tpl = AGENT_TEMPLATES[key]
    assert tpl["trigger"] is None
    assert tpl["model"] is None
    assert tpl["tool_policy"] == {
        "v": 1,
        "skills": [],
        "grant_exec": False,
        "grant_web": "off",
    }
    assert tpl["avatar"]["type"] == "bot"
    assert tpl["avatar"]["shape"] in BOT_AVATAR_SHAPES
    assert tpl["avatar"]["color"] in BOT_AVATAR_COLORS
    assert tpl["title"].strip()
    assert tpl["description"].strip()


def test_judge_prompt_budget_and_sections() -> None:
    """法官 duty ≤ 500 字，且三个机制串在场：跨群工具名、身份注入标签、终局前缀。

    终局前缀是**机制判据**（调度器按 startsWith 判 game_over）：措辞与
    ``group_limits.GAME_OVER_PREFIX`` 不一致，法官宣布了也没人认。
    """
    prompt = AGENT_TEMPLATES["werewolf_judge"]["prompt"]
    assert len(prompt) <= 500
    for needle in ("group_post", "<game_secret>", "【游戏结束】"):
        assert needle in prompt
    assert GAME_OVER_PREFIX in prompt
    assert AGENT_TEMPLATES["werewolf_judge"]["title"] == WEREWOLF_JUDGE_TITLE


def test_player_prompt_budget_and_no_role_words() -> None:
    """玩家 duty ≤ 120 字且**零角色词** —— 六个玩家共用一份 prompt，身份只能来自服务端注入。"""
    prompt = AGENT_TEMPLATES["werewolf_player"]["prompt"]
    assert len(prompt) <= 120
    for word in ("wolf", "seer", "villager", "狼人", "预言家", "村民"):
        assert word not in prompt
    assert AGENT_TEMPLATES["werewolf_player"]["title"] == WEREWOLF_PLAYER_TITLES[0]


def test_player_titles_match_role_pool() -> None:
    """标题数 == 角色池大小 == 6，且池计数恰 2 狼 / 1 预言家 / 3 村民。"""
    pool = werewolf_lab._WEREWOLF_ROLE_POOL
    assert len(WEREWOLF_PLAYER_TITLES) == len(pool) == 6
    assert len(set(WEREWOLF_PLAYER_TITLES)) == 6
    assert pool.count("wolf") == 2
    assert pool.count("seer") == 1
    assert pool.count("villager") == 3
    assert set(pool) == set(werewolf_lab.WEREWOLF_ROLES)


@pytest.mark.parametrize("key", _WEREWOLF_KEYS)
def test_no_scene_patch_words_in_templates(key: str) -> None:
    prompt = AGENT_TEMPLATES[key]["prompt"]
    for word in _SCENE_PATCH_WORDS:
        assert word not in prompt, f"{key} prompt 出现场景补丁词 {word!r}（规则该进群设置，不进模板）"
