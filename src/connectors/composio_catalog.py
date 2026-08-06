"""Composio 预置目录（08-05 WP-12）—— 代码内 curated 数据，**不是**从 Composio 拉的全量表。

三件事只在这里定义（加一家服务 = 加一条数据，不改任何逻辑）：

  1. **哪些服务上目录**：`COMPOSIO_CATALOG` 的键 = 我们的 `connector_id`（也是凭证 namespace
     段与 gateway 工具名前缀 `mcp__<id>__` 的那一段），值 = 一条 `ComposioCatalogEntry`。
  2. **每家用哪些 toolkit**：Atlassian 在 Composio 是 `JIRA` + `CONFLUENCE` 两个 toolkit，
     我们用**一个 connector 一个 session 挂双 toolkit** 对齐既有的一行 Atlassian。
  3. 🔴 **curated `enable` 白名单**（必选项不是优化项）：实测工具量级 GitHub 947 / Outlook 314
     / Slack 178 / Gmail·Notion 各 65 —— 不裁剪 = 工具面爆炸 + per-tool 设置页不可用。
     白名单同时充当 `preload.tools`（DIRECT_TOOLS 的 REST 对应物），官方建议 ≤~20/session，
     故每家恒 ≤ `MAX_PRELOAD_TOOLS`（`validate_catalog()` 有断言，加错了直接炸在 import 期）。

**logo 取舍（实现者决策，记录在此）**：不用 `logos.composio.dev/api/<slug>` 外链，也不内嵌
17 份品牌 SVG，而是**代码内的品牌色 + 字母牌**（`logo_text` / `logo_color`）。理由：
  - 打包 `.app` 常在离线/受限网络下运行，外链 logo 会裂图（且设置页在 owner 还没配 key 时
    就向 Composio CDN 发请求 = 一次不必要的出站，与本模块「数据出机要明示」的调性相反）；
  - 内嵌品牌 SVG 是商标资产复制，收益只是好看一点；字母牌零风险、零请求、离线恒成立。
如果将来要真 logo，加字段即可（`ComposioCatalogEntry` 是纯数据），不影响任何逻辑。

**Outlook 白名单的特例**（E §7.6 ⚠️）：Exchange 邮件读写是本机 davmail 主链路 ——
白名单**剔除全部 send / draft / message 写类**，只补日历与联系人缺口，不给模型第二条写邮件
通道。这是 catalog 数据层的硬约束，`validate_catalog()` 用一条断言钉住。

🔴 **meta 工具**（`COMPOSIO_SEARCH_TOOLS` / `COMPOSIO_MULTI_EXECUTE_TOOL` /
`COMPOSIO_GET_TOOL_SCHEMAS`）：spike 实测**删不掉** —— 即使配了 `preload` + per-toolkit
白名单 + `manage_connections.enable=false`，`tools/list` 里仍然带它们。它们的「搜索 → 执行」
发生在 Composio 的语义里，会**绕开**我们的 per-tool 档位、审批卡与围栏，所以 manifest 同步
层按前缀恒过滤（`is_meta_tool`，`client.list_tools_manifest` 消费）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Optional

#: 一个 session 的 `preload.tools` 上限（Composio 官方建议 ~20；超了工具面与 context 都会炸）。
MAX_PRELOAD_TOOLS = 20

#: Composio meta 工具的 slug 前缀（删不掉 ⇒ 同步层过滤，见模块 docstring）。
COMPOSIO_META_TOOL_PREFIX = "COMPOSIO_"


def is_meta_tool(tool_name: str) -> bool:
    """该 slug 是否是 Composio 的 meta 工具（恒不入库、恒不注册给模型）。"""
    return isinstance(tool_name, str) and tool_name.startswith(COMPOSIO_META_TOOL_PREFIX)


@dataclass(frozen=True)
class ComposioCatalogEntry:
    """预置目录一条（= 一个 connector 行的出厂定义）。"""

    connector_id: str
    display_name: str
    #: Composio toolkit slug（大写）。多个 = 一个 session 挂多 toolkit（Atlassian = JIRA+CONFLUENCE）。
    toolkits: tuple[str, ...]
    #: `{toolkit: (tool_slug, ...)}` —— curated 白名单，同时是 `preload.tools` 的内容。
    tools: Mapping[str, tuple[str, ...]]
    #: 一句话描述的 i18n key（zh/en 两份 locale 都有；后端不发译文）。
    description_key: str
    #: 分类（设置页分组/排序用的弱信息，不参与任何判定）。
    category: str
    #: 字母牌（1-2 字符）+ 品牌色（十六进制）——见模块 docstring 的 logo 取舍。
    logo_text: str
    logo_color: str

    @property
    def all_tools(self) -> tuple[str, ...]:
        out: list[str] = []
        for tk in self.toolkits:
            out.extend(self.tools.get(tk, ()))
        return tuple(out)


def _entry(
    connector_id: str,
    display_name: str,
    tools: Mapping[str, tuple[str, ...]],
    *,
    category: str,
    logo_text: str,
    logo_color: str,
) -> ComposioCatalogEntry:
    return ComposioCatalogEntry(
        connector_id=connector_id,
        display_name=display_name,
        toolkits=tuple(tools.keys()),
        tools=dict(tools),
        description_key=f"settings.connectors.catalog.desc.{connector_id}",
        category=category,
        logo_text=logo_text,
        logo_color=logo_color,
    )


COMPOSIO_CATALOG: dict[str, ComposioCatalogEntry] = {
    "gmail": _entry(
        "gmail",
        "Gmail",
        {
            "GMAIL": (
                "GMAIL_FETCH_EMAILS",
                "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
                "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
                "GMAIL_LIST_THREADS",
                "GMAIL_LIST_DRAFTS",
                "GMAIL_GET_DRAFT",
                "GMAIL_LIST_LABELS",
                "GMAIL_GET_PROFILE",
                "GMAIL_GET_ATTACHMENT",
                "GMAIL_GET_CONTACTS",
                "GMAIL_SEARCH_PEOPLE",
                # 写类只给「起草」——发信留给 owner 在 Gmail 里点发送（首发偏读类，E §7.6）。
                "GMAIL_CREATE_EMAIL_DRAFT",
                "GMAIL_UPDATE_DRAFT",
                "GMAIL_ADD_LABEL_TO_EMAIL",
                "GMAIL_REMOVE_LABEL",
            )
        },
        category="email",
        logo_text="G",
        logo_color="#EA4335",
    ),
    "googlecalendar": _entry(
        "googlecalendar",
        "Google Calendar",
        {
            "GOOGLECALENDAR": (
                "GOOGLECALENDAR_EVENTS_LIST",
                "GOOGLECALENDAR_EVENTS_GET",
                "GOOGLECALENDAR_EVENTS_INSTANCES",
                "GOOGLECALENDAR_FIND_EVENT",
                "GOOGLECALENDAR_FIND_FREE_SLOTS",
                "GOOGLECALENDAR_FREE_BUSY_QUERY",
                "GOOGLECALENDAR_LIST_CALENDARS",
                "GOOGLECALENDAR_GET_CALENDAR",
                "GOOGLECALENDAR_GET_CURRENT_DATE_TIME",
                "GOOGLECALENDAR_CREATE_EVENT",
                "GOOGLECALENDAR_UPDATE_EVENT",
                "GOOGLECALENDAR_PATCH_EVENT",
                "GOOGLECALENDAR_DELETE_EVENT",
                "GOOGLECALENDAR_QUICK_ADD",
            )
        },
        category="calendar",
        logo_text="GC",
        logo_color="#4285F4",
    ),
    "googledrive": _entry(
        "googledrive",
        "Google Drive",
        {
            "GOOGLEDRIVE": (
                "GOOGLEDRIVE_LIST_FILES",
                "GOOGLEDRIVE_FIND_FILE",
                "GOOGLEDRIVE_FIND_FOLDER",
                "GOOGLEDRIVE_GET_FILE_METADATA",
                "GOOGLEDRIVE_GET_FILE_V2",
                "GOOGLEDRIVE_LIST_CHILDREN_V2",
                "GOOGLEDRIVE_LIST_SHARED_DRIVES",
                "GOOGLEDRIVE_LIST_COMMENTS",
                "GOOGLEDRIVE_GET_COMMENT",
                "GOOGLEDRIVE_LIST_REVISIONS",
                "GOOGLEDRIVE_CREATE_FOLDER",
                "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT",
                "GOOGLEDRIVE_CREATE_COMMENT",
                "GOOGLEDRIVE_UPDATE_FILE_METADATA_PATCH",
            )
        },
        category="files",
        logo_text="GD",
        logo_color="#0F9D58",
    ),
    "slack": _entry(
        "slack",
        "Slack",
        {
            "SLACK": (
                "SLACK_LIST_ALL_CHANNELS",
                "SLACK_FIND_CHANNELS",
                "SLACK_LIST_CONVERSATIONS",
                "SLACK_FETCH_CONVERSATION_HISTORY",
                "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION",
                "SLACK_SEARCH_MESSAGES",
                "SLACK_LIST_ALL_USERS",
                "SLACK_FIND_USER_BY_EMAIL_ADDRESS",
                "SLACK_RETRIEVE_USER_PROFILE_INFORMATION",
                "SLACK_RETRIEVE_CONVERSATION_INFORMATION",
                "SLACK_LIST_UNREAD_CHANNEL_MESSAGES",
                "SLACK_RETRIEVE_MESSAGE_PERMALINK_URL",
                "SLACK_SEND_MESSAGE",
                "SLACK_UPDATES_A_SLACK_MESSAGE",
                "SLACK_ADD_REACTION_TO_AN_ITEM",
            )
        },
        category="chat",
        logo_text="S",
        logo_color="#4A154B",
    ),
    "twitter": _entry(
        "twitter",
        "X (Twitter)",
        {
            "TWITTER": (
                "TWITTER_RECENT_SEARCH",
                "TWITTER_POST_LOOKUP_BY_POST_ID",
                "TWITTER_USER_LOOKUP_BY_USERNAME",
                "TWITTER_USER_LOOKUP_ME",
                "TWITTER_USER_HOME_TIMELINE_BY_USER_ID",
                "TWITTER_FOLLOWERS_BY_USER_ID",
                "TWITTER_FOLLOWING_BY_USER_ID",
                "TWITTER_BOOKMARKS_BY_USER",
                "TWITTER_GET_POST_ANALYTICS",
                "TWITTER_CREATION_OF_A_POST",
                "TWITTER_ADD_POST_TO_BOOKMARKS",
                "TWITTER_USER_LIKE_POST",
            )
        },
        category="social",
        logo_text="X",
        logo_color="#111111",
    ),
    "github": _entry(
        "github",
        "GitHub",
        {
            # 947 个 slug 的极端裁剪：只留「读代码 / 读 issue·PR / 提 issue」这一圈。
            "GITHUB": (
                "GITHUB_FIND_REPOSITORIES",
                "GITHUB_GET_A_REPOSITORY",
                "GITHUB_GET_A_REPOSITORY_README",
                "GITHUB_GET_REPOSITORY_CONTENT",
                "GITHUB_GET_RAW_REPOSITORY_CONTENT",
                "GITHUB_LIST_BRANCHES",
                "GITHUB_LIST_COMMITS",
                "GITHUB_GET_A_COMMIT",
                "GITHUB_LIST_REPOSITORY_ISSUES",
                "GITHUB_GET_AN_ISSUE",
                "GITHUB_LIST_ISSUE_COMMENTS",
                "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
                "GITHUB_LIST_PULL_REQUESTS",
                "GITHUB_GET_A_PULL_REQUEST",
                "GITHUB_LIST_PULL_REQUESTS_FILES",
                "GITHUB_LIST_RELEASES",
                "GITHUB_GET_A_USER",
                "GITHUB_CREATE_AN_ISSUE",
                "GITHUB_CREATE_AN_ISSUE_COMMENT",
                "GITHUB_UPDATE_AN_ISSUE",
            )
        },
        category="dev",
        logo_text="GH",
        logo_color="#24292F",
    ),
    "notion": _entry(
        "notion",
        "Notion",
        {
            "NOTION": (
                "NOTION_FETCH_DATA",
                "NOTION_SEARCH_NOTION_PAGE",
                "NOTION_RETRIEVE_PAGE",
                "NOTION_GET_PAGE_MARKDOWN",
                "NOTION_FETCH_ALL_BLOCK_CONTENTS",
                "NOTION_FETCH_BLOCK_CONTENTS",
                "NOTION_QUERY_DATABASE",
                "NOTION_FETCH_DATABASE",
                "NOTION_FETCH_ROW",
                "NOTION_LIST_USERS",
                "NOTION_GET_ABOUT_ME",
                "NOTION_FETCH_COMMENTS",
                "NOTION_CREATE_NOTION_PAGE",
                "NOTION_UPDATE_PAGE",
                "NOTION_ADD_PAGE_CONTENT",
                "NOTION_APPEND_TEXT_BLOCKS",
                "NOTION_INSERT_ROW_DATABASE",
                "NOTION_UPDATE_ROW_DATABASE",
                "NOTION_CREATE_COMMENT",
            )
        },
        category="notes",
        logo_text="N",
        logo_color="#111111",
    ),
    "atlassian": _entry(
        "atlassian",
        "Atlassian (Jira / Confluence)",
        {
            "JIRA": (
                "JIRA_SEARCH_ISSUES",
                "JIRA_GET_ISSUE",
                "JIRA_LIST_ISSUE_COMMENTS",
                "JIRA_GET_ALL_PROJECTS",
                "JIRA_GET_CURRENT_USER",
                "JIRA_GET_TRANSITIONS",
                "JIRA_CREATE_ISSUE",
                "JIRA_EDIT_ISSUE",
                "JIRA_ADD_COMMENT",
                "JIRA_TRANSITION_ISSUE",
            ),
            "CONFLUENCE": (
                "CONFLUENCE_SEARCH_PAGES",
                "CONFLUENCE_CQL_SEARCH",
                "CONFLUENCE_GET_PAGE_BY_ID",
                "CONFLUENCE_GET_PAGES",
                "CONFLUENCE_GET_CHILD_PAGES",
                "CONFLUENCE_GET_SPACES",
                "CONFLUENCE_CREATE_PAGE",
                "CONFLUENCE_UPDATE_PAGE",
            ),
        },
        category="work",
        logo_text="A",
        logo_color="#0052CC",
    ),
    "linear": _entry(
        "linear",
        "Linear",
        {
            "LINEAR": (
                "LINEAR_LIST_LINEAR_ISSUES",
                "LINEAR_GET_LINEAR_ISSUE",
                "LINEAR_SEARCH_ISSUES",
                "LINEAR_LIST_LINEAR_PROJECTS",
                "LINEAR_GET_LINEAR_PROJECT",
                "LINEAR_LIST_LINEAR_TEAMS",
                "LINEAR_LIST_LINEAR_STATES",
                "LINEAR_LIST_LINEAR_USERS",
                "LINEAR_GET_CURRENT_USER",
                "LINEAR_LIST_COMMENTS",
                "LINEAR_CREATE_LINEAR_ISSUE",
                "LINEAR_UPDATE_ISSUE",
                "LINEAR_CREATE_LINEAR_COMMENT",
            )
        },
        category="work",
        logo_text="L",
        logo_color="#5E6AD2",
    ),
    "outlook": _entry(
        "outlook",
        "Outlook",
        {
            # 🔴 白名单**剔除 send / draft / message 写类**：Exchange 邮件读写是本机 davmail
            # 主链路，不给模型第二条写邮件通道（E §7.6 ⚠️；`validate_catalog` 有断言）。
            # 只补日历 + 联系人缺口。
            "OUTLOOK": (
                "OUTLOOK_LIST_EVENTS",
                "OUTLOOK_GET_EVENT",
                "OUTLOOK_SEARCH_EVENTS",
                "OUTLOOK_GET_CALENDAR_VIEW",
                "OUTLOOK_LIST_CALENDARS",
                "OUTLOOK_GET_ME_CALENDAR",
                "OUTLOOK_FIND_MEETING_TIMES",
                "OUTLOOK_GET_SCHEDULE",
                "OUTLOOK_GET_SUPPORTED_TIME_ZONES",
                "OUTLOOK_GET_ME_CONTACTS",
                "OUTLOOK_GET_USER_BY_EMAIL",
                "OUTLOOK_GET_PROFILE",
                "OUTLOOK_CALENDAR_CREATE_EVENT",
            )
        },
        category="calendar",
        logo_text="O",
        logo_color="#0078D4",
    ),
    "figma": _entry(
        "figma",
        "Figma",
        {
            "FIGMA": (
                "FIGMA_GET_FILE_METADATA",
                "FIGMA_GET_FILE_NODES",
                "FIGMA_GET_FILE_JSON",
                "FIGMA_GET_COMMENTS_IN_A_FILE",
                "FIGMA_GET_FILE_COMPONENTS",
                "FIGMA_GET_FILE_STYLES",
                "FIGMA_GET_PROJECTS_IN_A_TEAM",
                "FIGMA_GET_FILES_IN_A_PROJECT",
                "FIGMA_RENDER_IMAGES_OF_FILE_NODES",
                "FIGMA_GET_LOCAL_VARIABLES",
                "FIGMA_EXTRACT_DESIGN_TOKENS",
                "FIGMA_GET_CURRENT_USER",
                "FIGMA_ADD_A_COMMENT_TO_A_FILE",
            )
        },
        category="design",
        logo_text="F",
        logo_color="#F24E1E",
    ),
    "stripe": _entry(
        "stripe",
        "Stripe",
        {
            # 钱相关：白名单**全读**（写类要经过一次独立决策才配上目录）。
            "STRIPE": (
                "STRIPE_GET_ACCOUNT",
                "STRIPE_LIST_CUSTOMERS",
                "STRIPE_LIST_CHARGES",
                "STRIPE_LIST_INVOICES",
                "STRIPE_LIST_SUBSCRIPTIONS",
                "STRIPE_LIST_PAYMENT_INTENTS",
                "STRIPE_LIST_BALANCE_TRANSACTIONS",
                "STRIPE_LIST_DISPUTES",
                "STRIPE_LIST_PRODUCTS",
                "STRIPE_LIST_CHECKOUT_SESSIONS",
                "STRIPE_LIST_CREDIT_NOTES",
                "STRIPE_LIST_COUPONS",
            )
        },
        category="finance",
        logo_text="St",
        logo_color="#635BFF",
    ),
    "asana": _entry(
        "asana",
        "Asana",
        {
            "ASANA": (
                "ASANA_SEARCH_TASKS_IN_WORKSPACE",
                "ASANA_GET_A_TASK",
                "ASANA_GET_MULTIPLE_TASKS",
                "ASANA_GET_TASKS_FROM_A_PROJECT",
                "ASANA_GET_A_PROJECT",
                "ASANA_GET_MULTIPLE_PROJECTS",
                "ASANA_GET_MULTIPLE_WORKSPACES",
                "ASANA_GET_CURRENT_USER",
                "ASANA_GET_GOALS",
                "ASANA_CREATE_A_TASK",
                "ASANA_UPDATE_A_TASK",
                "ASANA_CREATE_TASK_COMMENT",
            )
        },
        category="work",
        logo_text="As",
        logo_color="#F06A6A",
    ),
    "intercom": _entry(
        "intercom",
        "Intercom",
        {
            "INTERCOM": (
                "INTERCOM_LIST_CONVERSATIONS",
                "INTERCOM_SEARCH_CONVERSATIONS",
                "INTERCOM_GET_CONVERSATION",
                "INTERCOM_LIST_CONTACTS",
                "INTERCOM_SEARCH_CONTACTS",
                "INTERCOM_GET_A_CONTACT",
                "INTERCOM_LIST_ALL_ADMINS",
                "INTERCOM_SEARCH_TICKETS",
                "INTERCOM_GET_TICKET",
                "INTERCOM_LIST_TAGS",
                "INTERCOM_LIST_ALL_ARTICLES",
                "INTERCOM_LIST_ALL_COMPANIES",
            )
        },
        category="support",
        logo_text="I",
        logo_color="#1F8DED",
    ),
    "sentry": _entry(
        "sentry",
        "Sentry",
        {
            "SENTRY": (
                "SENTRY_LIST_AN_ORGANIZATIONS_ISSUES",
                "SENTRY_GET_ORGANIZATION_ISSUE_DETAILS",
                "SENTRY_RETRIEVE_ISSUE_EVENTS_BY_ID",
                "SENTRY_FETCH_ISSUE_EVENT_BY_ID",
                "SENTRY_GET_OLDEST_EVENT",
                "SENTRY_GET_PROJECT_LIST",
                "SENTRY_GET_PROJECT_EVENTS",
                "SENTRY_GET_ORGANIZATION_DETAILS",
                "SENTRY_GET_ORGANIZATION_ENVIRONMENTS",
                "SENTRY_FETCH_ALERTS",
                "SENTRY_GET_ORGANIZATION_STATS_SUMMARY",
            )
        },
        category="dev",
        logo_text="Se",
        logo_color="#362D59",
    ),
    "paypal": _entry(
        "paypal",
        "PayPal",
        {
            # 同 Stripe：全读白名单。
            "PAYPAL": (
                "PAYPAL_LIST_INVOICES",
                "PAYPAL_SEARCH_INVOICES",
                "PAYPAL_GET_INVOICE",
                "PAYPAL_LIST_PAYMENTS",
                "PAYPAL_GET_PAYMENT",
                "PAYPAL_GET_ORDER",
                "PAYPAL_LIST_DISPUTES",
                "PAYPAL_LIST_PRODUCTS",
                "PAYPAL_GET_PRODUCT",
                "PAYPAL_LIST_PLANS",
                "PAYPAL_GET_SUBSCRIPTION",
                "PAYPAL_GET_USERINFO",
            )
        },
        category="finance",
        logo_text="P",
        logo_color="#003087",
    ),
}


def get_catalog_entry(connector_id: str) -> Optional[ComposioCatalogEntry]:
    """目录里有这一家吗（没有 → None，不抛——调用方多半要走 DB 行那条路）。"""
    return COMPOSIO_CATALOG.get(connector_id)


#: Outlook 白名单里**绝不允许**出现的 slug 片段（本机 davmail 是唯一写邮件通道）。
_OUTLOOK_FORBIDDEN_FRAGMENTS = ("DRAFT", "SEND", "REPLY", "FORWARD", "MESSAGE")


def validate_catalog() -> None:
    """目录自检（import 期跑一次）——加错数据当场炸，不等到用户点连接才发现。

    钉四件事：id/toolkit 形状、白名单非空且 ≤ `MAX_PRELOAD_TOOLS`、slug 属于自己的 toolkit
    前缀（拼错家的 slug 会被 Composio 静默忽略，工具面凭空少一个很难查）、Outlook 无写邮件类。
    """
    for cid, entry in COMPOSIO_CATALOG.items():
        if cid != entry.connector_id:
            raise ValueError(f"catalog key {cid!r} != entry.connector_id {entry.connector_id!r}")
        if not entry.toolkits:
            raise ValueError(f"catalog entry {cid!r} has no toolkit")
        tools = entry.all_tools
        if not tools:
            raise ValueError(f"catalog entry {cid!r} has an empty curated whitelist")
        if len(tools) > MAX_PRELOAD_TOOLS:
            raise ValueError(
                f"catalog entry {cid!r} whitelist has {len(tools)} tools > "
                f"MAX_PRELOAD_TOOLS={MAX_PRELOAD_TOOLS}"
            )
        if len(set(tools)) != len(tools):
            raise ValueError(f"catalog entry {cid!r} whitelist has duplicates")
        for toolkit in entry.toolkits:
            for slug in entry.tools.get(toolkit, ()):
                if not slug.startswith(f"{toolkit}_"):
                    raise ValueError(
                        f"catalog entry {cid!r}: tool {slug!r} does not belong to toolkit "
                        f"{toolkit!r}"
                    )
                if is_meta_tool(slug):
                    raise ValueError(
                        f"catalog entry {cid!r}: {slug!r} is a Composio meta tool — those are "
                        "filtered out of the manifest and must never be whitelisted"
                    )
    outlook = COMPOSIO_CATALOG.get("outlook")
    if outlook is not None:
        for slug in outlook.all_tools:
            tail = slug[len("OUTLOOK_") :]
            if any(frag in tail for frag in _OUTLOOK_FORBIDDEN_FRAGMENTS):
                raise ValueError(
                    f"Outlook whitelist must not contain mail write/draft tools: {slug!r} "
                    "(Exchange mail is the local davmail chain — no second write path)"
                )


validate_catalog()
