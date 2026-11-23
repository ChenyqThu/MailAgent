# MailAgent 4.0 架构瘦身独立质量复核

2026-11-22 · 对比基线 `c2a2c77e`（Wave 0 的父提交）与本地 main `1359863a`。共 11 个提交。实机对象为已安装的 arm64 Developer ID dogfood 包。结论为**架构方向认可，功能验收有条件通过**。日历 UID 回归需要修复后才能签收 Wave 1 的兼容性；另有一个保留接口丢失旧行为。其余抽测支持继续沿用当前拆分。

## 需要处理的差异

| 优先级 | 发现与影响 | 关闭条件 |
|---|---|---|
| 发布前修复 | **含斜杠的日历 UID 在桌面失效。** 旧 IPC 用 SQLite 参数或 CLI 参数传递整个 UID。新实现把 UID 编入单个 URL 路径段，ASGI 解码后，多出的斜杠让请求匹配不到 FastAPI 路由。在实际 app 的离线 ASGI transport 上，普通 UID 的详情、编辑、RSVP、来源邮件四个请求都抵达鉴权并返回 401，同样请求换成含斜杠的 UID 均在鉴权前返回 404。删除与 replay 的路由也使用这一形状。现有测试含相同样例，只核对 mock fetch 的出站 URL。 | 为任意合法 UID 定义可逆传输方式，保留现有调用方；在实际路由上用临时数据覆盖详情、来源邮件及各写操作，并断言领域层收到完整 UID。RSVP 用替身，避免发信。见 `frontend/src/shared/api/ElectronApi.ts:618`、`frontend/src/shared/api/HttpApi.ts:840`、`src/api/routers/calendar.py:279`、`frontend/tests/shared/api/http_api_config.test.ts:328`。 |
| 兼容债 | 桌面的 `notion.updateFlag` 从可执行的 IPC 改绑到恒定抛出未实现错误的 HTTP 方法。共享接口仍对调用方承诺此操作；当前 UI 使用 `email.flag`，未找到活跃 UI 消费者。 | 保留接口就提供兼容适配与用例；若决定退役，同步删除声明并记录变更。见 `frontend/src/shared/api/ElectronApi.ts:607`、`frontend/src/shared/api/HttpApi.ts:697`、`frontend/src/shared/api/types/settings.ts:100`。 |
| 架构说明 | **Electron 仍写 sync_store.db。** 桌面翻译的活跃 IPC 使用可写连接，对 `email_translation` 执行 upsert 和删除。即使邮件与附件热读通路确实只读，也不能据此认定全库唯一 Python 写者。三个历史日历 IPC 也仍存在，含 CLI 写操作。 | 在边界文档登记翻译缓存、日历镜像和原生草稿等例外；如果需要整库单写，另行规划这些写入。见 `frontend/src/electron/main/handlers/translate.ts:137`、同文件第 220、273、854、900 行，及 `handlers/calendar.ts:111`。 |
| 架构说明 | **ai_chat.db 的单写结论适用于消息和工具调用的新增及实时更新。** Python 仍可截断消息、删除会话并级联删除消息和调用，还负责会话及群组元数据。Wave 3B 实删 6 个写路由和 2 个 GET、5 个写方法和 1 个查询方法。基线代码能证明两端均具备写入口，无法据此断言生产中同一条消息被重复写入。 | 在方案和验收中按操作列明所有者。保留删除语义及回归覆盖。见 `src/chat/db.py:1030`、`src/chat/db.py:1147`、`src/api/routers/chat.py:1710`。 |
| 验收说明 | **启动正常，运行期出现过错误。** 02:04 的 CalDAV 全窗同步写入 73 条、errors=0；connector 日志记录 149 个工具。02:17 飞书出现 WebSocket 接收循环断开；09:34 上游 502 导致已完成流式输出后的 memory.md 自动捕获失败。当前资料不足以把这些错误归因于本次重构。 | “零报错”注明启动日志的时间窗口；运行期分别跟踪连接恢复和记忆补写。原始证据在用户数据目录的 `logs/backend-process.log:87`、`logs/api-process.log:67` 及 `~/Library/Logs/MailAgent/ai-gateway.log`。 |

## 原始问题、规划与交付

- **Wave 0**。基线确有 8,327 行的 SyncStore 和 6,402 行的样式入口。迁移拆出后主文件 3,467 行、迁移文件 3,589 行。8 份 CSS 按入口顺序拼回，去除注释和空白后只余 Tailwind 入口语法变化。Token 定义已到 `frontend/src/electron/renderer/styles/tokens.css:43`，工程指南中的旧位置需更新。图标库可以保留；`frontend/src/shared/components/icons/folderIcons.ts:12` 起实际引用 25 个动画组件，“0 KB”只能用于描述未引用模块的增量；本次未做 bundle 字节归因。
- **Wave 1**。IPC→CLI 及 IPC→HTTP 的重复入口在基线真实存在；改走同一个 HttpApi 消除了大批转发。GET 的网络错误可重试一次，写请求未自动重放。保留读 fast-path 的方向合理。规划记录区分了真实 9,311 行库与合成 60,000 封库，单行/线程读取收益明显；合成库深分页 P95 为 52.66 对 61.80 ms。比较对象为 direct SQL 与 HTTP，不能将单行的倍数外推至完整 UI 或全部列表操作。本次未重跑原性能实验。
- **Wave 2**。事项、联系人、邮件仓储和 watcher 的拆分保留了原函数入口；双语各 9 个域重组后，均与基线逐值相等，各 6,868 个叶词条，未发现顶层覆盖。分域减少跨域编辑争用，同域仍可能冲突。联系人 27 个操作均声明了类型化成功响应；实现直接返回 JSONResponse，绕过 FastAPI 自动 response_model 校验。对应契约测试对 10 个操作的真实响应显式校验。生成 SDK 前应扩大真实响应覆盖。见 `src/api/app.py:117`、`tests/contacts/test_contacts_api.py:1225`。
- **Wave 3**。原 server、chatRun、BlockRenderer 分别有 32、26、26 个顶层具名函数，语法树比对在拆分后均找到相同函数体。domainClient 原有的 126 个非构造方法函数体保留，但由跨域继承串接；自定义 Agent 表单的 49 处 useState 移入 837 行的 Hook。物理拆分有效，依赖和状态复杂度仍值得在后续改动时关注。见 `frontend/src/ai-gateway/python/clientCalendarLibrary.ts:7`、`frontend/src/shared/components/agents/custom-agent/useCustomAgentForm.ts:733`。
- **计划调整**。规划真源是 `docs/plans/architecture-slimming-4.0/README.md`，最早在 `04c6e5fe` 进入 Git。其 Wave 3 原文包括整库单写、schema 下沉各工具、抽取三条管线的公共流控、合并重复容器。最终采用按域 schema、复用已有 prepareChatRun、提取两个公共 Hook 及有限单写。这样收窄可以控制重构风险，宜补记范围调整。本地 Epic 的 PRD 已勾完，`task.json` 仍为 `in_progress` 且 `completedAt=null`。

## 规模指标复算

按两端 Git 树的物理换行计数，排除未跟踪生成物。文件数变化不能直接解释为新增同等数量的业务模块。

| 指标 | 复核结果 |
|---|---|
| 全提交区间 | 252 文件，+68,046 / −71,616，净减 3,570 行，含文档、测试与资源 |
| frontend/src 的 TS、TSX、CSS | 1,528 → 1,591 文件；300,942 → 298,500 行；≥1,500 行文件 16 → 5，减少 68.75%。这组数字有后缀筛选。当前本地生成的 cli.gen.ts 另计 |
| AI Gateway | ≥1,500 行文件 4 → 0；目录总量 36,718 → 36,852 行，收益主要在职责拆分 |
| Python src/ | ≥1,500 行文件 19 → 17；总量 184,011 → 184,630 行 |
| Electron handlers/ | 29 文件 / 10,487 行 → 17 文件 / 6,768 行；目录内 ipcMain.handle 和 safeIpcHandle 的具名字符串通道去重为 137 → 69；目录外仍注册通道。callCli 调用点 20 → 5 |
| Wave 1 净变化 | 单提交 +964 / −6,868，净减 5,904；仅 frontend/src、frontend/tests、src、tests 为 +838 / −6,868，净减 6,030。两个可复算口径均与原文的 6,040 不同 |

## 独立验证与边界

| 本次执行 | 结果 |
|---|---|
| pytest 的 agent_eval 与 config；matters、contacts、repository 与 mail；另跑聊天 API | 分别 409、2,464、125 项通过。工具 catalog 119/119。各批次可能与历史验收重叠 |
| 前端质量闸 | typecheck 通过；lint 返回成功，0 error、1,736 warnings。未逐项对比告警基线，不将其计作本轮新增 |
| 前端行为复测 | 传输相关 3 文件 / 55 项，业务组件及 i18n 18 文件 / 133 项，全过 |
| SQLite 行为与安装包 ABI | 使用 Electron 的 Node 模式跑 `vitest run tests/main/chat_db`，7 文件 / 146 项全过，补充了原 Wave 3A 验收明确排除的 SQLite 测试。安装包内 addon 在 Electron ABI 140 加载成功，宿主 Node ABI 147 按预期拒绝 |
| 已安装软件 | 4.0.0；主包 `codesign --verify --deep --strict` 通过，主包和嵌入式 Python 的 Developer ID 团队均为 J5MQMJJ4TF。Web 入口存在，缺少 app-update.yml 与 dogfood 说明一致。使用独立目录及测试配置，从包内 Python 成功导入报告指明的八个模块；四个代表性 Python 源文件与审阅树逐字节相同 |
| 实机运行 | 主进程、Renderer、serve、serve-api 的 PID 及监听端口吻合。8200/app/ 为 200；8300/health 为 ok。8200/health 是网关代理，独立 Python 存活端点为 8200/api/health，本次返回 ok、schema_version=1。网关在主进程内，Electron 还可能有辅助进程 |

以上是对已有安装及选定测试的复核。未重新构建、覆盖安装或公证，未逐项重演每个 Wave 的历史测试，未验证每项 TCC 授权、PM2 安装时序或正式更新轨道。签名身份连续性本身不能证明每一项系统权限有效。原工作树已有改动位于 `.gitignore` 与 `tests/calendar_sync/test_reminder.py`；源码统计使用提交对象。本次仅新增报告。

## Backlog 建议顺序

1. **先关闭兼容性回归**。修复日历 UID 并补实际路由测试，明确旧旗标接口的去留；同步修订两库写入边界、IPC 范围及验收记录。完成后再将 Epic 标记完成。
2. **保留按需治理原则**。admin 与 email_views 路由下沉 SQL、mail_write 与 store 拆分有依据，按实际变更频率、缺陷或测试难度触发。剩余热点也含 2,711 行的 davmail_backend、3,467 行的 SyncStore 及 3,589 行的历史迁移，文件长度本身不足以提升优先级。
3. **分开评估两个前端热点**。onboarding.ts 属于 Electron 主进程，近 90 天有 1 个触及提交。CommandPalette.tsx 同期有 8 个，最近仍有搜索相关改动；可随搜索需求梳理。表单 Hook 和跨域继承亦可随业务改动收窄依赖。
4. **OpenAPI 渐进扩面**。先让真实响应与 schema 的一致性可验证，再推进 SDK。保留 Python/Node 分工、邮件热读 fast-path 及未用图标摇树的安排，无需为行数目标继续拆分。
