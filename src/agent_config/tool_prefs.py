"""Built-in gateway 写工具的 per-tool 审批档 —— canonical 注册表 + 纯折算（08-05 WP-11）。

owner 08-05 拍板（master-plan WP-11 + D1/D2）：把 07-16 的 acceptEdits 硬编码集合从
「代码常量」变成「数据」——每个 built-in 写工具有一个出厂默认档（本文件 canonical），
owner 可在设置里 per-tool 覆盖（覆盖行落 ``agent_config.db`` 的 ``tool_approval_pref``
表，见 store.py）。**只作用于 manual_chat**：headless 走 per-agent grants、im_chat 走
结构性矩阵，两者一个字节不动。

🔴 **零依赖叶子模块**（跨语言手抄纪律）：TS 侧**不手抄**这张表——gateway 消费的是
serve-api ``GET /api/agent/tool-prefs`` 折算后的 effective 档位（wire 数据）；唯一的
镜像是 ``tests/agent_eval/tool_catalog.json`` 的 ``default_approval`` 字段（R5 评分
需要），由 ``tests/config/test_tool_prefs_catalog_parity.py`` 抽取对账（抽取失败必红）。

档位语义（manual_chat）：
  - ``auto`` —— 免卡执行（audit ``auto_tool_pref``，与人工 approved 可辨）。
  - ``ask``  —— 弹审批卡（07-16 之前的默认行为）。owner **显式** ask 还压过
    policy_rules 白名单与 auto-reversible（F §4.3 梯子 ④ > ⑤/⑥）。
  - ``deny`` —— manual_chat 的 ToolSet 里不注册（模型看不见；镜像 connector 'off'）。
    只能来自显式覆盖，没有出厂默认 deny。
  - bypass（owner 全局模式）**压过 per-tool ask/auto**（D1=a：bypass = 字面「无例外」；
    deny 作用在注册面，bypass 复活不了一个不存在的工具——与 connector 'off' 同构）。

出厂默认（08-05 拍板依据 = 活库频次数据 + F 研究稿分组）：
  - 第一刀 default **auto**（53 张卡里 ~45 张、两个月 0 拒绝、全部可逆/只读）：
    email 四写 + draft 三写 + web_fetch/web_search。
  - A 组直接放宽 default **auto**：skill_uninstall（收窄能力的 fail-safe 方向、
    「rides with its family」无独立论证）+ custom_agent_run_now（run 的工具面已被
    grants/matrix 钉死，卡防的只是烧预算）。
  - B 组 default **ask** 可配 auto：日历 reschedule/rsvp、set_skill_enabled、
    update_system_md、agent_memory_update、agent_profile_restore、file_read/file_write。
  - C 组 default **ask**（D2=a，两个月零触发 = 零体验税）：
    * ``email_prepare_send`` —— **不给裸 auto**（configurable=False）；唯一免卡形状是
      「收件人白名单内免卡」（owner_settings ``send_recipient_whitelist``，空 = 恒 ask）。
    * ``calendar_event_delete`` / ``notion_agent_chat`` —— 可配 auto 但 ``danger_auto``
      （设置面设 auto 时红警告 + 一次性确认，模式抄 WP-10 destructive confirm）。
      notion_agent_chat 的 ``BYPASS_STILL_ASK`` carve-out 同批退役（D1=a）——原「代码
      地板」降级为这里的「出厂默认 ask」。
  - 保持恒 ask（configurable=False，F §3 C 组「保持现状」）：skill_install /
    skill_install_confirm（供应链两卡，低频税≈0）、custom_agent_create/update/delete
    （「zero-card exfil backdoor」论证，全仓最扎实一条）、run_command（它的可配面
    **就是** policy_rules 结构化白名单，比布尔档更细——勿给 raw auto）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

#: per-tool 覆盖档的值域（写侧校验单源）。出厂默认只会是 ask|auto；deny 只作显式覆盖。
TOOL_APPROVAL_TIERS: tuple[str, ...] = ("ask", "auto", "deny")

#: 出厂默认档的值域（registry 校验用——默认永远不 deny）。
_DEFAULT_TIERS: tuple[str, ...] = ("ask", "auto")

#: 设置面的分组展示顺序（wire 的 group 字段值域；前端按此顺序渲染分组）。
TOOL_PREF_GROUPS: tuple[str, ...] = (
    "email_write",
    "draft",
    "web",
    "calendar",
    "matters",
    "contacts",
    "capability",
    "supply",
    "agents",
    "exec",
    "outbound",
)


@dataclass(frozen=True)
class BuiltinToolPolicy:
    """一个 built-in 写工具的审批档出厂事实。

    ``configurable=False`` = 档位恒 ask、owner UI 不可改（PUT 该工具 → 400）；它们的
    免卡通道各有专属形状（send=收件人白名单 / run_command=policy_rules / 供应链与
    custom-agent CRUD=仅 bypass），不走 per-tool 档。
    ``danger_auto=True`` = 设置面把它设 auto 时需要红警告 + 一次性确认（前端消费位）。
    """

    tool_name: str
    group: str
    default_tier: str  # 'ask' | 'auto'
    configurable: bool = True
    danger_auto: bool = False


#: canonical 注册表 —— 覆盖 tool_catalog.json 全部 write:true 且 tier != silent 的
#: built-in 工具（数量以本元组为准，别在注释里写死一个会过期的数字；connector 动态工具
#: **不在**此表——那是 WP-10 自己的三档体系）。
#: 完整性由 tests/config/test_tool_prefs_catalog_parity.py 双向钉死。
BUILTIN_TOOL_POLICIES: tuple[BuiltinToolPolicy, ...] = (
    # ── 第一刀：email 四写（preview / 可逆 / 频次最高）──────────────────────────
    BuiltinToolPolicy("email_flag", "email_write", "auto"),
    BuiltinToolPolicy("email_archive", "email_write", "auto"),
    BuiltinToolPolicy("email_pin", "email_write", "auto"),
    BuiltinToolPolicy("email_resync", "email_write", "auto"),
    # ── 第一刀：draft 三写（只写本机 Drafts，发送另有 send 卡兜底）────────────────
    BuiltinToolPolicy("email_draft_reply", "draft", "auto"),
    BuiltinToolPolicy("email_draft_compose", "draft", "auto"),
    BuiltinToolPolicy("email_draft_update", "draft", "auto"),
    # ── 第一刀：联网读（URL query 是出境面，owner 已在 07-16 AE 语义里接受过一次）──
    BuiltinToolPolicy("web_fetch", "web", "auto"),
    BuiltinToolPolicy("web_search", "web", "auto"),
    # ── B 组：日历（D4 一刀切拆开定档；delete 是 C 组 danger_auto）────────────────
    BuiltinToolPolicy("calendar_event_reschedule", "calendar", "ask"),
    BuiltinToolPolicy("calendar_event_rsvp", "calendar", "ask"),
    BuiltinToolPolicy("calendar_event_delete", "calendar", "ask", danger_auto=True),
    # ── B 组：Matter 域（P3 七写 + P4 评审两件）──────────────────────────────────
    BuiltinToolPolicy("matter_create", "matters", "auto"),
    BuiltinToolPolicy("matter_update", "matters", "auto"),
    BuiltinToolPolicy("matter_item_mutate", "matters", "auto"),
    # task 08-25：curated 进展条目。与同族七写同档 auto —— 本地、留审计事件、软删可 restore；
    # 而且它要被日常维护（owner 的原话是「让 agents 来维护」），每记一条弹一张卡就没人用了。
    BuiltinToolPolicy("matter_progress_mutate", "matters", "auto"),
    BuiltinToolPolicy("matter_resource_mutate", "matters", "auto"),
    BuiltinToolPolicy("matter_stakeholder_mutate", "matters", "auto"),
    BuiltinToolPolicy("matter_relation_mutate", "matters", "auto"),
    BuiltinToolPolicy("matter_add_note", "matters", "auto"),
    # P4 D8：run 控制本地可逆（取消不回滚已观察到的事实，但也没落任何状态），出厂 auto 可配。
    BuiltinToolPolicy("matter_run_control", "matters", "auto"),
    # P4 D8：评审决定**不走 per-tool 档** —— 它的免卡形状是 gateway 侧的动态 policyEvaluate
    # （非 manual 恒卡 / manual 拒绝免卡 / manual 接受且选中含 field change 才弹卡）。故
    # configurable=False（owner 不能把它调成无条件 auto，那会绕过 field-accept 那张卡），
    # default_tier 保持 'ask'（run_command / custom_agent_call 先例：固定形状行恒 ask，
    # 免卡走各自的专属通道）。
    BuiltinToolPolicy("matter_review_update", "matters", "ask", configurable=False),
    # 0813 轮 3 批 R：关注信号处置 / 资料建议整批处置。两件都只动**本地派生态**——signal 的
    # state（判据翻转仍会自己重开）与 link 的 confirmed 位（restore 可回），与上面七写同档
    # auto 可配；owner 想让它们弹卡就在设置里调。
    BuiltinToolPolicy("matter_attention_triage", "matters", "auto"),
    BuiltinToolPolicy("matter_suggestion_resolve", "matters", "auto"),
    # ── B 组：通讯录直写（Contact Directory WP7）──────────────────────────────────
    # 五件都只动 owner 自己那本通讯录、且都可逆（分类改得回来、曾用标记同一端点撤销、
    # 画像刷新只是重算派生文档、身份字段可再改、上级可重设/解除）。出厂 ask 而不是跟 matter
    # 家族的 auto：这本通讯录的身份字段是 owner 自己的话（治理 Agent 结构上只能「建议」），
    # 直写面留一张卡才对得上这条纪律。五件都 configurable —— owner dogfood 后想调 auto 就调。
    # 🔴 建议面（contact_propose_* 三件）**不进本表**：它们是 write:false 的 artifact 工具
    # （tool_catalog.json 同源），写的是待 owner 采纳的 pending 行，不进审批链。
    BuiltinToolPolicy("contact_set_kind", "contacts", "ask"),
    BuiltinToolPolicy("contact_mark_former_email", "contacts", "ask"),
    BuiltinToolPolicy("contact_refresh_profile", "contacts", "ask"),
    # 身份字段 PATCH + 上级设置（owner 拍板「chat 里直接改字段方便多了」）。走的就是通讯录 UI
    # 手动编辑那两个端点，语义逐字一致（保存即落锁 / 环检测由服务端管）——所以出厂同为 ask：
    # 界面上那一下点击 = 这里的这张卡。
    BuiltinToolPolicy("contact_update_fields", "contacts", "ask"),
    BuiltinToolPolicy("contact_set_manager", "contacts", "ask"),
    # ── B 组：能力/身份面（全部有 history/rollback 补偿）─────────────────────────
    BuiltinToolPolicy("set_skill_enabled", "capability", "ask"),
    BuiltinToolPolicy("update_system_md", "capability", "ask"),
    BuiltinToolPolicy("agent_profile_restore", "capability", "ask"),
    BuiltinToolPolicy("agent_memory_update", "capability", "ask"),
    # ── 供应链：install 两卡保持现状；uninstall = A 组放宽（fail-safe 方向）────────
    BuiltinToolPolicy("skill_install", "supply", "ask", configurable=False),
    BuiltinToolPolicy("skill_install_confirm", "supply", "ask", configurable=False),
    BuiltinToolPolicy("skill_uninstall", "supply", "auto"),
    BuiltinToolPolicy("skill_draft_create", "supply", "auto"),
    BuiltinToolPolicy("skill_draft_write_file", "supply", "auto"),
    BuiltinToolPolicy("skill_draft_publish", "supply", "ask", configurable=False),
    BuiltinToolPolicy("skill_draft_discard", "supply", "auto"),
    # ── custom agent CRUD：create/update/delete 保持现状；run_now = A 组放宽 ──────
    BuiltinToolPolicy("custom_agent_create", "agents", "ask", configurable=False),
    BuiltinToolPolicy("custom_agent_update", "agents", "ask", configurable=False),
    BuiltinToolPolicy("custom_agent_delete", "agents", "ask", configurable=False),
    BuiltinToolPolicy("custom_agent_run_now", "agents", "auto"),
    BuiltinToolPolicy("custom_agent_call", "agents", "ask", configurable=False),
    # L4 群聊 g2：主 agent 往群里投递 / 建群。group 归 "agents"；class 仍是 capability_change。
    # group_post 是本组唯一可配行（拍板 Q3：owner 可把投递调 auto = 对已展示档位的确认）；
    # 法官 run 不经 owner 档位（工厂只喂 deny 条目，免卡走 auto_judge_scope），别为组内一致改成 False。
    BuiltinToolPolicy("group_post", "agents", "ask"),
    # 建群与 custom_agent_call 同形状：恒 ask 不可配，免卡只走服务端核验型 user_requested。
    BuiltinToolPolicy("group_create", "agents", "ask", configurable=False),
    # ── 内建 agent（task 08-14）：改的是日报 / 搜索 / 预处理 / 周报同步这些**已经在跑**的
    #    agent 的排程·模型·prompt，与 custom_agent_update 同待遇 —— 恒 ask 且不可配 auto。
    #    设 auto 意味着邮件正文里的一句注入就能改掉每日报告的 prompt 或排程。
    BuiltinToolPolicy("internal_agent_update", "agents", "ask", configurable=False),
    # 同一条理由：事项跟进的触发条件同样是「无人值守 + 有网络出口」的 run 的开关面。
    # 🔴 group 归 "matters" 而不是 "agents"：group 只管设置页怎么分组（owner 找它时是在
    # 「事项」那一栏找跟进配置），与 tool_class 是两个维度 —— class 仍是 capability_change。
    BuiltinToolPolicy("matter_followup_mutate", "matters", "ask", configurable=False),
    # ── exec：file 两写可配；run_command 的可配面 = policy_rules（不给 raw auto）───
    BuiltinToolPolicy("file_read", "exec", "ask"),
    BuiltinToolPolicy("file_write", "exec", "ask"),
    BuiltinToolPolicy("run_command", "exec", "ask", configurable=False),
    # ── C 组：真不可逆（D2=a，默认 ask 的体验税恰好为零）─────────────────────────
    BuiltinToolPolicy("email_prepare_send", "outbound", "ask", configurable=False),
    BuiltinToolPolicy("notion_agent_chat", "outbound", "ask", danger_auto=True),
    # task 08-27 P4a：主 Agent 代发一条产品反馈（正文 + 可选邮箱 + 可选诊断包离开本机）。
    # 🔴 configurable=False 而不是 notion_agent_chat 那样的 danger_auto：owner 明确拍板
    # 「不给『以后都自动』——对外发送属于安全地板那一档」（与 run_command / skill 安装同级）。
    # gateway 侧还有三道同向的地板（class outbound 的场地闸 / edit tier / 工厂不接
    # policyEvaluate 且不转发 per-tool 档），本行是第四道，四道都指向「每次都问」。
    BuiltinToolPolicy("submit_feedback", "outbound", "ask", configurable=False),
)

#: name → policy 的查表投影（读侧单源）。
BUILTIN_TOOL_POLICY_BY_NAME: dict[str, BuiltinToolPolicy] = {
    p.tool_name: p for p in BUILTIN_TOOL_POLICIES
}

# registry 自洽性（import 时即炸，防手滑）：默认档值域 / 分组值域 / 无重名。
assert len(BUILTIN_TOOL_POLICY_BY_NAME) == len(BUILTIN_TOOL_POLICIES)
for _p in BUILTIN_TOOL_POLICIES:
    assert _p.default_tier in _DEFAULT_TIERS, _p
    assert _p.group in TOOL_PREF_GROUPS, _p

#: 「编辑放行」一键预设 = 07-16 ``ACCEPT_EDITS_AUTO_APPROVE_TOOLS`` 的成员表原样搬进
#: 数据层（TS 常量已随 WP-11 删除，这里是唯一 canonical）。两个用途：① 设置面的预设
#: 按钮（POST /api/agent/tool-prefs/preset 批量设显式 auto）；② store 迁移——存量
#: ``chat_approval_mode='acceptEdits'`` 行为保持（那 15 个工具在 AE 下本就免卡）。
ACCEPT_EDITS_PRESET: tuple[str, ...] = (
    "email_flag",
    "email_archive",
    "email_pin",
    "email_resync",
    "email_draft_reply",
    "email_draft_compose",
    "email_draft_update",
    "update_system_md",
    "set_skill_enabled",
    "agent_profile_restore",
    "agent_memory_update",
    "web_fetch",
    "web_search",
    "file_read",
    "file_write",
)

# 预设成员必须都是可配置的注册表工具（预设写的是显式覆盖行，不可配置的工具拒写）。
for _n in ACCEPT_EDITS_PRESET:
    assert BUILTIN_TOOL_POLICY_BY_NAME[_n].configurable, _n


def effective_tool_tier(tool_name: str, override: Optional[str]) -> str:
    """一个工具的有效档位（纯函数）：显式覆盖优先；无覆盖 → 出厂默认。

    值域外野值（只可能来自手改 DB——写侧入库即拒）**fail-closed 折算成 ``ask``**：
    审批面看不懂的档位绝不能被当成「免卡」（方向镜像 connector 的 off-fold，但审批
    档的安全方向是「弹卡」而不是「消失」）。不在注册表的工具名 → ``ask``（同理）。
    """
    policy = BUILTIN_TOOL_POLICY_BY_NAME.get(tool_name)
    if policy is None:
        return "ask"
    if override is None:
        return policy.default_tier
    if override in TOOL_APPROVAL_TIERS:
        return override  # type: ignore[return-value]
    # 值域外野值 → 'ask'，绝不回落 default_tier：11 个出厂 auto 工具上「看不懂的覆盖」
    # 折成默认就是折成免卡，方向反了。TS 侧（lifecycle resolver）对同一行的处置是整行
    # 丢弃 = 同样落回弹卡——两侧方向一致（check 2026-08-05 修正，原实现与本 docstring 矛盾）。
    return "ask"


def validate_send_whitelist(entries: object) -> list[str]:
    """校验 + 规范化 send 收件人白名单（owner UI 写入前）。

    合法条目二选一：完整邮箱（含 ``@`` 且不以 ``@`` 开头）或域名条目（``@corp.test``
    形状——匹配该域的任意收件人）。全部小写归一 + 去重保序；非法条目抛 ValueError
    （整批拒绝——白名单是安全数据，不做静默丢弃）。
    """
    if not isinstance(entries, list):
        raise ValueError("send whitelist must be a list of strings")
    out: list[str] = []
    seen: set[str] = set()
    for raw in entries:
        if not isinstance(raw, str):
            raise ValueError(f"send whitelist entry must be a string: {raw!r}")
        entry = raw.strip().lower()
        if not entry:
            raise ValueError("send whitelist entry must not be empty")
        if entry.startswith("@"):
            # 域名条目：@ 后必须还有一个点分域名（拒 '@' / '@x' 这类手滑）。
            domain = entry[1:]
            if not domain or "." not in domain or "@" in domain or " " in domain:
                raise ValueError(f"invalid domain whitelist entry: {raw!r}")
        else:
            # 完整邮箱：一个 @、两侧非空、域侧带点。
            if entry.count("@") != 1 or " " in entry:
                raise ValueError(f"invalid email whitelist entry: {raw!r}")
            local, _, domain = entry.partition("@")
            if not local or not domain or "." not in domain:
                raise ValueError(f"invalid email whitelist entry: {raw!r}")
        if entry not in seen:
            seen.add(entry)
            out.append(entry)
    return out
