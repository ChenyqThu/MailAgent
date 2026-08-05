# 飞书对话（IM agent 场地 · harness 扩展 epic 阶段 2）

> 系统「现在如何」让 owner 在**飞书私聊**里与 MailAgent 的通用 AI 助手完成多轮对话——含工具
> 调用与飞书内 HITL 审批。来源 = task `08-01-messenger-im-agent-chat`（PR1-PR4）；决策真源见
> 该 task 的 `prd.md` 与 epic 的 `grill.md`（Q10 / Q11 / Q12 / Q13 / Q18 / Q19 / Q20 / Q21 +
> 工程判断 C6 / C9）。
>
> 对照阅读：gateway 工具注册与审批的总体架构见
> [`ai-sdk-gateway-architecture.md`](./ai-sdk-gateway-architecture.md)；connector 工具面见
> [`mcp-connectors.md`](./mcp-connectors.md)（飞书里它们**全部开放**，见 §3）。

`status: living` · `last-verified: 2026-08-04`（PR1-PR4 + `/model` 指令；owner dogfood 通过后
flag 已 cutover 默认 `true`，见 §7）

---

## 1. 定位与边界

- **是什么**：飞书是 agent 的**第四个场地**（前三个 = 桌面 manual chat / headless custom agent /
  untrusted trigger）。它不是通知通道，是完整的多轮会话。
- **不是什么**：**IM 是主界面的旁路补充，不是取代**（PRODUCT.md 反面参考第 4 条：不做
  "Chat-first interfaces that obscure the underlying mail, report, or operational workflow"）。
  做的是「人不在电脑前时也能指挥」，不是「以后都在飞书里干活」——所以邮件 / 报告 / 运维工作流
  **不迁进聊天**。
- 🔴 **与通知 bot 完全隔离**（grill Q21=B）。现有 `src/notify/feishu.py` 的重要邮件推送 +
  Openclaw 按钮链**一个字节不动**：对话是**另一个新建的自建应用**、另一份凭证、另一条长连接。
  owner 特意选了隔离而非合流，代价是通知卡片里不能直接接着聊，换来的是现有通知链零风险。
- **只做私聊**（Q12=A）：群聊消息静默丢弃，不回应也不入会话。未绑定用户一律拒。
- **绑定的是助手，不是会话**（Q11=A）：飞书用的就是桌面那个通用 AI 助手（同一份记忆、同一个
  人设）；但**每个飞书话题是独立会话**（Q18=A），不接管桌面正开着的对话，避免两边同时输入 /
  未读状态混乱。飞书会话会出现在桌面会话列表里并标注「来自飞书」。

---

## 2. 架构

### 2.1 进程落位：长连接挂 `serve`，不挂 serve-api

`src/im/worker.py` 由 `src/service.py::EmailNotionSyncApp.start()` 经 `_spawn_supervised(...,
"im_feishu")` 拉起（形态照 CalendarSyncWorker）。判据是「哪个进程恒常驻且只有一份」：

- `serve` 是**唯一恒 spawn** 的 service（serve-api 由 `MAILAGENT_REMOTE_ACCESS_ENABLED` 门控，
  显式 false 就没有）；
- 它已有 supervise 退避重启 + 告警 + `worker.im_feishu.*` 落盘的现成 worker 宿主，而 serve-api
  的 FastAPI lifespan 至今零后台任务（加一个就是开新先例）；
- 它持有 `sync_store` / `alerter` / `AlertEpisodeTracker`，episode 告警零接线成本。

代价：**长连接与邮件同步同生共死**（serve 崩 → 断连；serve 因大迁移慢启动 → 晚上线）。

底座 = 飞书官方 Python SDK `lark-oapi` 的长连接客户端（C9）。官方原文：「只需保证运行环境具备
访问公网的能力即可，**无需提供公网 IP 或域名、无需内网穿透**」，且正式生产可用。

🔴 **`src/im/` 的模块顶层没有任何 lark import**（见 `src/im/connection.py` 的红字）：一旦在主
线程 import 了 lark，`lark_oapi.ws.client` 的模块级全局 loop 就被钉在那个线程上。测试也守同
一条纪律（`tests/im/test_import_discipline.py`）。

### 2.2 三条飞书硬约束（全部是设计输入）

| 约束 | 我们的应对 |
|---|---|
| **3 秒内必须处理完且不抛异常**，否则飞书判超时并**重推** | 消息：立即 ACK → executor 线程跑 LLM → 跑完**主动发**消息（主动发不受 3s 限制）。卡片点击：先回 toast → 线程里 POST `/decide` → 再 `PATCH` 更新卡片（更新 token 30 分钟有效）。`on_card_action` 跑在 lark WS 线程上，**只做纯内存解析 + 去重 + submit**，连 `get_bound_open_id`（sqlite 读）都推迟到 executor 任务里 |
| **集群不广播**：同一应用多个客户端只有**随机一个**收到消息 | 建连前复用 `src/services/guards.py::check_pm2_conflict` 检测 pm2 `mail-sync`，命中即**不建连** + episode 告警 + `im.feishu.conflict` 落盘（设置页如实显示）。**不做**跨进程强锁 |
| 每应用最多 50 个连接 / 仅企业自建应用可用长连接 / 保存订阅配置时本地程序必须正在运行 | 我们正好是自建应用、单连接；订阅配置那条是**运维步骤**，见 §6 |

### 2.3 `im_chat` —— 第四态 context mode

阶段 0b 已一次性付清「结构成本」（`AGENT_CONTEXT_MODES` 四值 + 三张镜像表 + 一致性闸
`tests/api/test_context_mode_consistency.py`）。阶段 2 PR-1 补上**唯一缺口**：一个断言
`im_chat` 的入口。

`POST /api/ai/im-chat`（gateway，loopback，仅 `MAILAGENT_IM_FEISHU` on 时注册）在**可信代码里**
硬编码 `'im_chat'`，其余复用 `prepareChatRun`。🔴 **context mode 永远不从 body 读**
（`chatRun.ts::prepareChatRun` 的 `trustedContextMode` 注释）——客户端不能自称 `manual_chat`。

飞书 handler（Python，在 `serve` 进程里）**直连 loopback gateway:8300**，不经 serve-api 反代
（那条路是给远程浏览器造的，挂 `verify_cf_access`；本地走它只是白绕一跳还要自造鉴权头）。
端口解析与 `AgentRunWorker` 同源。

### 2.4 会话映射与桌面可见（Q18=A）

- `ai_chat_sessions.origin` 加第三个值 `'im'`（自由文本列，无 CHECK）。默认列表过滤是
  `COALESCE(origin,'interactive') <> 'agent'` ⇒ `'im'` **自动出现在桌面交互会话列表里**——
  Q18=A 的「桌面可见」几乎零成本。行上渲染「来自飞书」角标（`AgentThreadList.tsx`，i18n key
  `agentView.fromFeishu`）。
- session 由 gateway 侧 `createImSession` 建（`chat_db/sessions.ts`，照 `createAgentSession` 抄）——
  Python 侧的 `create_new_session` 不写 origin 列。
- **飞书私聊 ↔ 当前活跃 session** 的映射落 `sync_state`（`im.feishu.active_session.<chat_id>`），
  跨重启存活 → 多轮连续。`/new` 清掉它 = 下一条消息开新会话。

### 2.4b 文本命令（分发单源 = `src/im/bridge.py::handle_owner_message`）

| 命令 | 语义 |
|---|---|
| `/new` | 清活跃 session ⇒ 下一条消息开新会话。**不动**模型偏好 |
| `/stop` | `POST /api/ai/run/stop`，中断在跑的 run |
| `/model` | 列出可用模型（按 provider 分组，标注「当前」「默认」）+ 用法提示。🔴 IM 侧没有 `/help`，这段输出就是用户**唯一**的命令发现入口 |
| `/model <ref>` | 切换本飞书会话后续消息用的模型。三种写法都认：`provider:model` / `provider/model`（只归一**第一个** `/`，model id 自身的 `/` 保留）/ 裸 `model`（= default provider）。落库存 canonical 形态（default provider → 裸 id） |
| `/model reset` | 清偏好，回默认模型（默认值 = `LLM_MODEL`，与 gateway `cfg.model` 同源） |

- `/new` `/stop` 走**全等**比较；`/model` 走 `split(None, 1)` 后**第一段全等** ——
  不能用裸 `startswith`，否则 `/modelx 是什么` 会被吞成命令而不是提问；也不能用
  `startswith("/model ")`，那样中文输入法打出的全角空格 `/model　claude-x`（U+3000）
  会整条掉进 agent run 当提问（两条都有测试钉）。
- 模型偏好落 `sync_state` 的 `im.feishu.model.<chat_id>`（与 active_session 同形态的动态键、
  同样**不 bump `DB_VERSION`**），跨重启存活；**与会话有意分开** —— 换话题 ≠ 换模型。
- 🔴 **绝不把未校验的 model ref 传给 gateway**：provider 不存在时 `createProviderRegistry`
  抛裸 Error，而 `server.ts` 是 `void handleImChat(...)`（无 `.catch`）⇒ HTTP 响应**永不写出**
  ⇒ Python 侧干等到 `CHAT_READ_TIMEOUT_SEC`（30 分钟）。所以：切换时先校验、不过就报错**不落库**；
  每轮开跑前把已存偏好**再校验一次**（owner 可能事后禁用了那个模型），失效则本轮回退默认 +
  在回复末尾如实说明，**不自动清键**（清掉等于替用户做决定，且他下次就再也看不到这条提示）。
- 「在册模型全集」的判据单源 = `src/agent_config/enabled_models.py`（`build_enabled_model_catalog`
  / `EnabledModelCatalog.find`），与 `/chat/config.enabledModels` **同一份聚合**（该文件是从
  `chat.py` 抽出来的，chat 侧改为调用它，行为逐字节不变）。成员测试按 `parse_provider_ref`
  归一到 `(provider_id, model_id)` ⇒ `default:claude-x` 与裸 `claude-x` 等价。
  🔴 该模块**不许 import FastAPI** —— 飞书 worker 跑在 `src/service.py` 的同步进程里，而
  `src/api/app.py` 顶层挂载全部 router，从那里 import router 模块会把整个 API 面拖进来。

### 2.5 审批闭环（Q13=B，通用按钮卡）

```
gateway 暂停 → stash（进程内存，TTL 30min）
  ↓ 飞书 handler drain 完流后 GET /api/ai/approval/pending?sessionId=N
  ↓ 组一张统一卡片（摘要 + [批准][拒绝]，schema 2.0 + config.update_multi:true）
飞书里点按钮 → card.action.trigger（长连接）→ 3s 内回 toast
  ↓ executor 线程 POST /api/ai/approval/decide {approvalId, decision}
  ↓ gateway 经 peekByApprovalId 自反查 resumeToken 并驱动**真 resume**
  ↓ PATCH 卡片成终态 + 投递模型的后续回复
```

要点：

- `resumeToken` **永不出 gateway**（in-record 形状只传 `approvalId`）。
- `decision` 是 fail-closed 白名单，只认 `'approve'`/`'reject'`，其余 400 且**不动 stash**。
- 🔴 **`repaused` 是非终态**（照抄 `src/api/routers/island.py:224-230` 的教训）：resume 后又停在
  下一个审批门时，本卡标「已批准 · 还有后续操作待确认」并**补发下一张卡**，绝不宣布完成。
  该跳的 `summary`（gateway `clipSummary` 截到 180 字符）作为**中间进展**投递并**显式标明是
  摘要**——不标就是把截断文本冒充成完整回复。
- 终态回复取法有两条路线，**写死在 `src/im/bridge.py` 的 docstring 里防止被"顺手统一"**：
  消息路径 = 解析 SSE text-delta 拼装（wire 契约，零竞态）；审批 decide 路径 = 读 CHAT_DB 镜像
  （`/decide` 响应里只有 180 字符 summary）。🔴 后者的新鲜度判据是
  `max(created_at, updated_at)` **不是 created_at**——暂停轮的 assistant 行在**暂停时**就 eager
  落库了，resume 的 persistTurn 是**就地 UPDATE 同一行**，`created_at` 停在暂停时刻；只看
  created_at 的话，owner 隔 5 秒以上才点卡片（= 绝大多数真实点击）就恒退回摘要。
- **destructive 红警告随卡**：MCP 服务方的 `destructive_hint` 在 gateway 暂停时冻进 stash
  （`StashInput.destructive`，取自 `tools/policy.ts` 的运行时 destructive 注册表，由
  `createConnectorTools` 在 build 时写入），经 `/pending` 透出 → `src/im/cards.py` 渲染红色警告
  块。🔴 **绝不从模型参数推断**（模型不能把自己的警告说没）——与桌面 `McpApprovalCard`
  同一条纪律，措辞也同一句。
- 重复点击 / stash 过期 / gateway 重启 → `/pending` 404 → 卡片 PATCH 成「⚪ 已失效」，**不产生
  二次执行**。
- 🔴 `E_TIMEOUT` / `E_HTTP`（请求**已经送到**）与 `E_CONNECT`（根本没送到）**严格分开**：前者
  说「这次操作可能已经执行，去桌面 App 确认，别再点」，后者才说「没有生效，再点一次」。说反
  了就是谎报未执行 + 诱导重复操作。

---

## 3. 工具矩阵（grill Q10=A + 08-04 拍板补充）

**飞书账号被盗 ≠ 你的电脑被盗**——这是整张表的理由。真要远程干重活走远程网页版（有独立登录保护）。

| tool_class | manual_chat | **im_chat** | untrusted_trigger |
|---|---|---|---|
| `read` | ✅ | ✅ 免审批 | ✅ |
| `domain_write` | ✅ 可 auto-approve | ✅ **恒 HITL** | 恒 HITL |
| `connector_write` | ✅ 恒 HITL | ✅ **恒 HITL** | 恒 HITL |
| `web` | ✅ 恒 HITL | 🔒 `MAILAGENT_IM_WEB_ENABLED` 门控，**默认关**；开了也恒 HITL | ❌ 不注册 |
| `exec` | ✅ 恒 HITL | ❌ **不注册** | ❌ 不注册 |
| `capability_change` | ✅ 恒 HITL | ❌ **不注册** | ❌ 不注册 |
| `outbound` | ✅ 恒 HITL | ❌ **不注册** | ❌ 不注册 |

判定单源 = `frontend/src/ai-gateway/tools/policy.ts::isToolClassAllowedInMode`（`im_chat` 那行是
fail-closed 的一行 return），`mayAutoApprove` 仍要求 `manual_chat` ⇒ im_chat 的写类**结构上**
进不了任何免批白名单。

**connector 对 im_chat 全开放**（08-04 owner 拍板，推翻阶段 0 的「六处恒拒」保守留白）：读类
免批、写类恒 HITL 经飞书审批卡。安全地板不因 IM 放宽。

🔴 **`web` 的 opt-in 是「venue 开关」不是 grant** —— `policy.ts::ImVenueSwitches` 的注释与
`policy.test.ts` 的 4×8 全矩阵双重锁死该方向：grant 是 per-agent 授权，而这是「飞书这个场地
整体允不允许」。所以它是 `isToolClassAllowedInMode` 的 `venue` 参数，不是 `AgentModeGrants.web`。

设置页把这五行**当陈述渲染，不当配置**——它们由矩阵钉死，画成可点的控件就是撒谎。唯一真开关
是上网那一个。

---

## 4. 身份、凭证与绑定

### 4.1 凭证：`external_credential` 的 `im:feishu`

阶段 0a 的通用保管层（`src/agent_config/credentials.py`，Fernet 密文 + master key 在 Keychain）
docstring 里点名的示例正是 `im:feishu`。

- namespace `im:feishu`，key `app_id` / `app_secret`。
- **seed 语义**（镜像 LLM provider registry）：表里没有该行且 env `FEISHU_IM_APP_ID` /
  `FEISHU_IM_APP_SECRET` 两键都在 → 写进去（一次性）；表里有行 → **行权威**，env 之后怎么改都不
  影响运行时；两者都没有 → 没有可用凭证，worker 不起（不是错误，是「没配」）。
- **写入路径只有两条，都落这同一对行**：进程启动时的 env seed（`seed_from_env`）与设置页表单
  （`save_credentials` ← `POST /api/im/credential`，WP-07）。🔴 `FEISHU_IM_APP_ID` /
  `FEISHU_IM_APP_SECRET` **有意不进两侧 `MANAGED_ENV_KEYS`** —— 凭证的权威是
  `external_credential` 行，把 env 键做成 UI 可写只会造出第二个事实来源；env 只剩「表里没行时
  的首次默认值」这一个语义。
- 🔴 **表单写完必须重启后端**，两种情形都成立（别把理由说成「worker 只读一次凭证」——
  `run()` 每轮循环其实会重读）：
  - **worker 没起**（此前没配 / 凭证读不出）：`feishu_im_ready` 是 **spawn 前**的一次性 gate，
    拦下之后 `service.py` 再也不重跑它 —— 写进去多少凭证都没有进程会读，重启是唯一出路。
    这正是这个表单最主要的使用场景。
  - **worker 在跑**：新凭证只在当前长连接断掉之后（+`RECONNECT_RETRY_SEC`=60s）的下一轮才被
    读到，**不热切换**，生效时刻取决于连接什么时候断、不可预期。
  故响应恒 `restart_required=true`（「唯一确定生效的做法是重启」），设置页据此拉起重启横幅；
  横幅的 key 写凭证行的 namespace `im:feishu` 而**不是** env 键 —— 写 env 键会把人引去 .env 里
  改一个不再有任何效果的东西。
- 🔴 **换成另一个自建应用时顺手解绑**（`app_changed=true` → 清 `bound_open_id` + 清 live bot
  展示位）：飞书的 `open_id` 是**按应用**签发的，旧绑定在新应用下永远匹配不上，留着只会让设置页
  的「已绑定」骗人。同 app 只轮换 secret 则绑定与 bot 身份原样不动。
- `metadata_json` 是**明文**展示位，只放 bot 身份：`app_id` + `app_name` + bot `open_id`。
  表单写入时 `app_id` 恒写（用户刚亲手填的），`app_name` / `bot_open_id` 只在 app 没换时保留
  ——换了应用它们就是**别的 bot** 的身份，摆出来正是下面那个同名陷阱要防的误导。
- 设置页读 `peek_credential`（**不解密不读密文列**）——master key 不可用时依然能如实回答
  「存了没、什么时候更新的」。🔴 **响应绝不回显 secret 的任何片段**（连末四位都不给）：设置页
  需要知道的只有「存了没、什么时候更新的、存的是哪个 app_id」。

🔴 **同名陷阱**（C6 实证）：owner 环境里对话 app 与通知 app 在飞书后台**都叫「MailAgent」**，
光看名字分不出在跟哪个 bot 说话。所以设置页永远把 `app_id` / `open_id` 摆出来，文案也明说
「认 app_id / open_id，别认名字」。

### 4.2 绑定：一次性绑定码

```
mailagent im pair            # 或 设置-AI「飞书对话」区 →「生成绑定码」
  → 6 位数字，TTL 10 分钟，落 sync_state
  → owner 在飞书私聊里把这串码单独发给 bot
  → bot 校验 → 把发送者 open_id 写进 im.feishu.bound_open_id（跨重启存活）
  → 之后只有这个 open_id 的私聊会进指令通道
```

设计取舍（都写在 `src/im/pairing.py` 里，免得下一个人重问）：

- **码存明文**：6 位数字 + 10 分钟 TTL 的本地配对码，存哈希只是把「能读到本机 SQLite 的人」挡在
  门外一秒（10⁶ 的空间，读得到库就爆得出）；而明文换来 CLI 崩掉后还能 `sqlite3` 查回来。能读你
  `sync_store.db` 的人已经拿到全部邮件了。比对仍用 `hmac.compare_digest`（成本为零）。
- **码是一次性的**：绑成功即清；过期或绑定后残留的码也会被清（`verify` 内自愈）。
- **已绑定后先拒后判**：绑定判定的唯一入口 `ImEventRouter._dispatch` 在已绑定时**先拒**非
  owner，根本走不到验码分支——避免「陌生人拿到码就能顶掉 owner」。重新绑定要
  `mailagent im pair --rebind` / 设置页「重新绑定」显式解绑（否则换手机会永久锁死）。
- 🔴 **状态面绝不回显码**（`mailagent im status` 与 `GET /api/im/status` 同纪律，两侧都有测试
  钉）：回显 = 任何能跑 CLI / 打开设置页的人都能顶号。`POST /api/im/pair` **可以**回码——它是
  owner 主动索取的一次性动作，与「被动状态面不泄露」并不矛盾。

---

## 5. 信任可见（PRODUCT.md 原则 1）

> *"Make trust observable: expose provenance, permissions, run state, approvals, costs, and
> failure causes at the point of action"*

IM 入口引入了两样此前不存在的东西——新的 **provenance**（消息来自飞书的哪个人）与新的**权限面**
（飞书这个场合能用哪些工具）。它们**不能只在代码里正确**。落地面：

| 面 | 位置 |
|---|---|
| 设置-AI「飞书对话」区（连接状态 / **应用凭证表单** / 绑定了谁 / 工具集陈述 / 上网开关 / 审批记录） | `frontend/src/shared/components/settings/custom-ai/ImFeishuSection.tsx`，挂 `CustomAiSection`，锚点 id 在 `aiTabAnchors.ts`（🔴 **三处一处不能漏**：ids / items / wrapper —— 漏了不报错，只安静少一行导航） |
| 桌面会话列表的「来自飞书」角标 | `AgentThreadList.tsx`（数据来自 `ChatSessionListItem.origin`） |
| CLI | `mailagent im status`（读，无 auth）/ `mailagent im pair`（写，需 token） |
| HTTP | `GET /api/im/status` · `GET /api/im/approvals` · `POST /api/im/pair` · `POST /api/im/credential`（`src/api/routers/im.py`） |

三条与别的设置区不同的取舍：

1. 🔴 **flag off 时不隐身，如实显示「未启用」**。`ConnectorsSection` 在 flag off 时整区
   `return null`；这里不。理由：`MAILAGENT_IM_FEISHU` 是**没有 UI 开关**的 env 总闸（双载体、
   翻它要同时重启 serve 与 app），整区隐身 = 用户既不知道有这个功能、也不知道它为什么不工作。
   对应地 `/status` 与 `/approvals` **有意不挂 flag 门**（整区 409 只会让设置页显示「加载失败」）；
   `/pair` 挂门 409（没有 bot 在收消息时出码 = 出一个永远兑不掉的码），`/credential` 同档挂门
   （flag off 时写进去也没有任何进程会去用它）。写类两个端点都挂 `verify_local_token`——绑定与
   换凭证都是「动本机执行通道」的动作，远程 web 恒 403、UI 那侧同样禁用并说明原因。
2. 🔴 **flag off 时 `connection_status` 是「上次记录」**（serve 被 `kill -9` 时它可能还停在
   `connected`）。CLI 与设置页都把它显示成「未启用」档，直接当当前状态显示就是撒谎。
3. 🔴 **审批记录的语义是「`origin='im'` 会话里的审批决定」，不是「点击发生在飞书」**——gateway
   对桌面卡与飞书卡写的是同一个 `approval_status`，DB 层分不出点击来自哪一侧。文案照此写。
   投影只取真人决定的三个值 `approved` / `edited` / `rejected`；四个 `auto_*` 是**免卡执行**的
   审计位，混进来就是谎报有人批过。账本读不到时 `available=false`，**不是**「零条」。

---

## 6. 运维速查

### 飞书开发者后台（一次性配置）

1. 新建**企业自建应用**（🔴 与通知 app 分开，别复用），开启**机器人**能力。
2. 权限：收私聊消息 `im:message.p2p_msg`（**需企业管理员审批**）、发消息 / 更新消息 `im:message`。
3. 🔴 **「事件订阅」与「回调订阅」是并列的两个 tab**（C6 真机头号坑）：**各自**都要选长连接、
   **各自**逐条添加订阅项——
   - 事件订阅 → `im.message.receive_v1`
   - 回调订阅 → `card.action.trigger`（新版卡片回调；官方只声明「消息卡片回传交互（**旧**）」
     不支持长连接）
4. 🔴 **保存订阅配置时本地程序必须正在运行且已连接**（飞书会当场探活）。
5. 把 app id / secret 填进 **设置 → AI →「飞书对话」→「应用凭证」**（首选，写的就是
   `external_credential` 行，保存后重启后端生效）；或写进 `.env` 的 `FEISHU_IM_APP_ID` /
   `FEISHU_IM_APP_SECRET` 由首次启动 seed（🔴 表里已有行时 env 不再有任何效果）。

### 排查顺序

```bash
# ① 连接与绑定状态（sync_state 的 im.feishu.*）
mailagent im status

# ② worker 有没有起来 / 崩过（supervise 落盘）
sqlite3 data/sync_store.db "SELECT key, value FROM sync_state WHERE key LIKE 'worker.im_feishu.%'"

# ③ 连接细节
sqlite3 data/sync_store.db "SELECT key, value FROM sync_state WHERE key LIKE 'im.feishu.%'"

# ④ 告警 episode（进入异常态告一次 → 中间静默 → 恢复发 recovery）
sqlite3 data/sync_store.db "SELECT key, value FROM sync_state WHERE key LIKE 'alert.im_feishu%'"

# ⑤ 飞书会话有没有落进 CHAT_DB
sqlite3 ~/Library/Application\ Support/mailagent-frontend/data/ai_chat.db \
  "SELECT id, title, origin FROM ai_chat_sessions WHERE origin='im' ORDER BY id DESC LIMIT 10"
```

日志一律带 `[im-feishu]` 前缀。**投递成败有显式生产可见日志**——不靠「日志里没报错」推断成功。
🔴 **错误日志摘要化**（`src/im/logfmt.py::describe_error` 只摘类型 / message / status / code）：
平台 SDK 的错误对象常挟带 `requestBody` 完整消息内容，直接 `logger.error(err)` = 把用户消息正文
写进日志。

### 常见症状 → 判据

| 症状 | 先看 |
|---|---|
| bot 收不到消息 / 时灵时不灵 | `im.feishu.conflict` 是不是 1（pm2 `mail-sync` 与打包 App 同跑 → 消息被随机进程抢走）。**用 App 时 pm2 必停** |
| 「连不上 AI 引擎」 | 桌面 App 没在运行（gateway 在 Electron main 进程里），或 `MAILAGENT_IM_FEISHU` 只翻了 Python 一侧 |
| 「上一条消息还在处理中」 | 同 session 并发第二条消息吃 409 —— 这是 feature（审批互斥），发 `/stop` 可中断 |
| 卡片点了没反应 | 「回调订阅」tab 漏配 `card.action.trigger`（只配了「事件订阅」是最常见的一半） |
| 在跟哪个 bot 说话？ | `mailagent im status` 的 `bot_app_name` / `bot_open_id`，或设置页那一行。**认 app_id 不认名字** |
| 出包后 bot 起不来 | 改过 Python 依赖必先 `bash frontend/scripts/build-python-venv.sh` 重 provision（`lark-oapi` 才进包），且改依赖必须重新生成 `requirements.lock.txt` |

---

## 7. 开关与回退

| 开关 | 载体 | 默认 | off 的语义 |
|---|---|---|---|
| `MAILAGENT_IM_FEISHU` | **双载体**：pydantic `im_feishu_enabled`（serve，翻需重启后端）+ Node `envBool`（`ai_gateway_lifecycle.ts`，main-env-only **不加 vite define**，翻需重启 app） | `true`（cutover 2026-08-04） | 不建立任何连接；gateway 不注册 `/api/ai/im-chat` 与 `createImSession`，工具集字节级回退。`/api/im/pair` 409；`/status` 与 `/approvals` **仍 200**（见 §5 取舍 1） |
| `MAILAGENT_IM_WEB_ENABLED` | **Node 单载体**（同上，main-env-only） | `false` | `web` 类工具在飞书会话里不注册。已入两侧 `MANAGED_ENV_KEYS`（设置页可改；漏加 = 开关渲染正常但一点就 `E_INVALID_KEY`） |

🔴 **双载体两侧默认必须同为 true、应急回退也一起翻**，否则会出现「gateway 注册了工具但 Python
侧没有 worker」或反过来。闸 = `tests/config/test_flag_cross_language.py`（已登记期望默认值）。

灰度节奏沿用 island 的 **ship-off → dogfood → cutover**；**cutover 已于 2026-08-04 完成**
（owner dogfood 通过），两侧默认翻 true，env 显式 false 为应急回退。
🔴 默认 on ≠ 一定会连：没配 `FEISHU_IM_APP_ID/SECRET`（且 `agent_config.db` 里也没有
`im:feishu` 凭证行）时 `feishu_im_ready` 在 spawn 前就拦下，零 worker 零连接 —— 这是升级
用户的默认状态。

---

## 8. 已知限界（有意留，别再调研一遍）

- **群聊不做**（Q12=A）。套路已备（LobeHub `BotMessageRouter` 的 `isDM || isMention ||
  watchKeyword || 单人群降级` 判据 + `passGatesOrNotify` 三级门，owner 恒放行），留给 epic 阶段 4。
- **微信不做**：iLink / ClawBot 官方通道存在但**平台未开放**（无公开 API 文档、无开发者控制台、
  无注册入口），且**不能主动发起对话**——正好撞死「重要邮件主动推送」。企业微信 owner 明确不接。
- **Slack 明确不做**（Q20，owner 明示，非「以后再说」）。
- **多 bot / `@` 切换多 agent 不做**（Q11=A 固定绑通用助手）。
- **多 owner / 多租户不做**。语音 / 文件上传等富媒体输入不做。
- **多实例只做检测不做强锁**：pm2 与 `.app` 双跑今天在代码层没有真闸（孤儿清扫刻意放过 pm2），
  我们在建连前检测 + 如实告知，不引入跨进程锁。
- **审批推送靠轮询不靠 announce 多播**：run drain 后查一次 `/approval/pending`，decide 后按
  `repaused` 语义补卡。没有给 gateway 的 announce 通道加第二个消费者。
- **stash 是进程内存**：gateway 重启即清空 → 老卡片点了会诚实变「已失效」。这是 fail-closed，
  不是 bug。
