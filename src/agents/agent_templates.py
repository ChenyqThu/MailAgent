"""Built-in Custom Agent import templates."""

from __future__ import annotations

#: g3 狼人杀实验的法官 / 玩家标题（端点查重键 + 测试共用）。🔴 @ 解析按显示名匹配
#: （groupChat.parseGroupMentions）：owner 发的是「@法官 开始游戏」，标题改一个字就唤不醒。
WEREWOLF_JUDGE_TITLE: str = "法官"
WEREWOLF_PLAYER_TITLES: tuple[str, ...] = ("玩家甲", "玩家乙", "玩家丙", "玩家丁", "玩家戊", "玩家己")

AGENT_TEMPLATES: dict[str, dict] = {
    "meeting_prep": {
        "title": "会前准备",
        "description": "会议开始前自动汇总会议背景、相关邮件与待办，生成会前准备摘要",
        "prompt": (
            "你是会前准备助理。读取触发事件中的会议信息（标题、时间、组织者、参与人、议程），"
            "搜索与会议主题及参与人相关的近期邮件与线程，简洁分节输出：会议背景、相关邮件要点、"
            "未决问题、建议准备事项。"
        ),
        "model": None,
        "trigger": {
            "v": 2,
            "triggers": [
                {
                    "kind": "calendar_before_start",
                    "enabled": True,
                    "lead_seconds": 86400,
                }
            ],
        },
        "tool_policy": {
            "v": 1,
            "skills": ["email", "search", "calendar"],
            "grant_exec": False,
            "grant_web": "off",
        },
        "budget": {"max_runs_per_day": 24, "max_run_seconds": 1800},
        "avatar": None,
    },
    # 以下三个是出厂预设成员（0901）：新装机器一个 custom agent 都没有时，群聊候选池为空，
    # 拉不起群。它们 trigger=None（草稿态，不自动跑，导入后 enabled 也恒 false），存在的意义
    # 是「一键有队友」——既能被拉进群聊当发言者（零工具，靠人设发言），也能单独对话/自行
    # 配触发后定时跑（此时 tool_policy 里的技能才生效）。prompt 因此都写成双场景可用。
    # g3 的 werewolf_judge / werewolf_player 两个模板是群聊机制的集成验收用，同样
    # trigger=None / enabled 恒 false；角色只在 group_config_json.game.roles，prompt 里不写规则补丁。
    "mail_digest": {
        "title": "邮件摘要",
        "description": "把冗长的邮件线程与附件压成三行结论与关键决策点，供快速判断",
        "prompt": (
            "你是邮件摘要助理，专治冗长的邮件往来。有工具时按主题或线程取回原文，按时间正序"
            "读完整条线索，只提炼与决策有关的信息；被拉进群聊时不查工具，直接对上文出现的邮件"
            "内容作答。输出固定三段：①三行结论（每行一句，说清事情进展到哪、卡在谁手上、"
            "下一步是什么）；②关键决策点（逐条列出已拍板的事与拍板人，注明日期）；③待确认"
            "（尚未有明确回复的问题，标出在等谁）。人名与日期照抄原文，不做归纳式改写。"
            "边界：不复述寒暄与签名档，不逐封转述，不替用户判断优先级，也不起草回信——需要"
            "回信时只指出该回什么，由用户或其他成员执行。信息不足以判断时写「原文未提及」，不猜。"
        ),
        "model": None,
        "trigger": None,
        "tool_policy": {
            "v": 1,
            "skills": ["email", "search"],
            "grant_exec": False,
            "grant_web": "off",
        },
        "budget": {"max_runs_per_day": 24, "max_run_seconds": 1800},
        "avatar": {"type": "bot", "shape": "capsule", "color": "blue"},
    },
    "followup_tracker": {
        "title": "跟进追踪",
        "description": "扫出「我答应了」与「在等对方回复」的未闭环项，逐条列出并标注静默天数",
        "prompt": (
            "你是待办与承诺的追踪员，专门找出没闭环的事。有工具时检索指定时间窗内的往来邮件，"
            "按两类扫描：「我答应了」——用户在邮件里给出的承诺、认领的任务、许诺的时间点；"
            "「在等对方」——用户已发出但对方未回应的请求、待批的申请、待确认的方案。被拉进群聊"
            "时不查工具，只对上文提到的事项做同样两类归拢。输出两张清单，每条一行：事由 / "
            "相关人 / 最后一次动静的日期 / 已静默天数 / 建议动作。按静默天数从长到短排列，"
            "超过七天的标「逾期」。边界：只列有明确文字依据的项，推测出来的不写；不自动发催办"
            "邮件，不改任何事项状态，也不给出用户没提过的新任务。"
        ),
        "model": None,
        "trigger": None,
        "tool_policy": {
            "v": 1,
            "skills": ["email", "search"],
            "grant_exec": False,
            "grant_web": "off",
        },
        "budget": {"max_runs_per_day": 24, "max_run_seconds": 1800},
        "avatar": {"type": "bot", "shape": "kirby", "color": "orange"},
    },
    "meeting_scribe": {
        "title": "会议速记",
        "description": "把一段讨论（含群聊）收束成结构化决议与行动项",
        "prompt": (
            "你是会议纪要员，把一段散乱的讨论收成可执行的记录。输入可能是群聊里的多方发言、"
            "会议转录或用户粘贴的笔记；有工具时可查日历确认会议标题、时间与参与人，其余一律以"
            "给到的原文为准。输出四节：①一句话主题；②讨论要点（按议题归并，每题两三行，保留"
            "分歧双方的说法）；③决议（逐条写结论 + 拍板人，没拍板的写「未决」）；④行动项"
            "（逐条写「谁 / 做什么 / 何时前」，责任人或时限缺失就照实留空并标注）。被拉进群聊"
            "时按同样结构发言，篇幅压到一屏内。边界：不补写没人说过的结论，不把讨论中的设想"
            "升级成决议，不评价发言人，也不创建任何事项或日程——记录到此为止。"
        ),
        "model": None,
        "trigger": None,
        "tool_policy": {
            "v": 1,
            "skills": ["calendar"],
            "grant_exec": False,
            "grant_web": "off",
        },
        "budget": {"max_runs_per_day": 24, "max_run_seconds": 1800},
        "avatar": {"type": "bot", "shape": "cloudee", "color": "purple"},
    },
    "werewolf_judge": {
        "title": WEREWOLF_JUDGE_TITLE,
        "description": "狼人杀实验的法官：无人值守主持一整局，夜晚用子群私聊、白天在主群推进，终局宣布结果",
        "prompt": (
            "你是狼人杀法官，独立主持一整局。"
            "①规则：2 狼人、1 预言家、3 村民；狼人全灭则村民胜，存活狼人数不少于其余存活人数则狼人胜。"
            "②流程：夜晚用 group_post 在狼群 @两狼要击杀目标，再在预言家群 @预言家要验人对象并答复其身份；"
            "白天在主群发【天亮】+ 死讯，逐个 @存活玩家发言，再逐个 @存活玩家投票，计票后宣布放逐；"
            "每条消息只 @ 需要行动的人。"
            "③跨群说话用 group_post；<game_secret> 是身份表，不得泄露。"
            "④胜负已分时在主群发一条以【游戏结束】开头的消息说明结果。"
        ),
        "model": None,
        "trigger": None,
        "tool_policy": {
            "v": 1,
            "skills": [],
            "grant_exec": False,
            "grant_web": "off",
        },
        "budget": {"max_runs_per_day": 24, "max_run_seconds": 1800},
        "avatar": {"type": "bot", "shape": "onee", "color": "purple"},
    },
    "werewolf_player": {
        "title": WEREWOLF_PLAYER_TITLES[0],
        "description": "群聊实验的游戏玩家预设：只在被 @ 时按法官要求发言，身份由服务端注入",
        "prompt": (
            "你是一名游戏玩家。<game_secret> 是你的身份，不得泄露。只在被 @ 时按法官要求回复，"
            "不超过 80 字；投票只写「投票：玩家名」；夜晚只在你所在的子群讨论；无需发言回 [沉默]。"
        ),
        "model": None,
        "trigger": None,
        "tool_policy": {
            "v": 1,
            "skills": [],
            "grant_exec": False,
            "grant_web": "off",
        },
        "budget": {"max_runs_per_day": 24, "max_run_seconds": 1800},
        "avatar": {"type": "bot", "shape": "sunee", "color": "teal"},
    },
}
