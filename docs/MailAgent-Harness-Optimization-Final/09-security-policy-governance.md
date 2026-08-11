# 安全、权限与治理

## 1. 安全基线

本方案不得削弱：

- Context Mode；
- Tool Class；
- 注册期过滤；
- Python 执行期二次授权；
- ApprovalGuard；
- 输入 hash 与 one-shot；
- 发送幂等；
- 外部内容围栏；
- Connector ceiling；
- Skill 供应链；
- Exec 无 Shell；
- Secret 隔离。

## 2. 权限三轴

```text
Capability：Agent 能看到哪些工具
Data Scope：可以读取或传输哪些数据
Autonomy：auto / ask / off
```

打开 Connector 不等于允许所有 Agent 使用；Agent 获得 Connector 不等于允许任意外传；工具为 auto 也不等于能绕过产品安全地板。

## 3. Custom Agent 创建与修改

- 仅 manual chat 注册；
- 属于 capability change；
- 完整 spec 固定在审批 hash 中；
- 模型不能创建审批白名单规则；
- 自动 Trigger 默认关闭；
- 权限升级在卡片中突出；
- 导入 JSON 不携带 Secret。

## 4. Custom Agent 委派

### 4.1 不能扩大能力

`custom_agent_call` 只能调用目标 Agent 已保存的配置。一次性 instruction 与上下文引用不能增加：

- Tool；
- Skill；
- Connector；
- Web；
- Exec；
- 审批模式。

### 4.2 调用审批

- 低风险只读 Agent：可直接调用；
- 高风险 Agent：主 Agent 主动委派时默认显示确认；
- 第一版接受 `manual_chat` 中模型自报的 `user_requested=true`，用于跳过外层调用卡；该值必须审计；
- `user_requested` 不属于权限声明，不能扩大目标 Agent 能力，也不能跳过子 Agent 具体工具审批；
- 父卡不能替代子工具审批。

### 4.3 递归

第一阶段：

```text
manual main agent → custom agent
```

禁止：

```text
custom agent → custom agent
```

## 5. Session 查询

- 当前 Agent ID 由服务端注入；
- 自己的历史默认可查；
- 全部历史需要 `Knowledge and sessions = on`；
- Agent Catalog 不暴露 Prompt、规则和 Secret；
- Session 内容继续作为潜在不可信历史围栏处理。

## 6. Compact 安全

Compact 是有损摘要，必须：

- 保留来源 ID；
- 保留已执行副作用；
- 保留用户拒绝；
- 保留未完成审批；
- 不把外部内容提升为系统指令；
- 摘要只作为历史压缩，不修改 Safety Floor；
- 失败时不切换有效边界；
- 完整历史保留。

Compact 模型不拥有工具。

## 7. Follow-up Queue 安全

- 队列消息仍是用户消息；
- 不代表审批；
- 不能在旧 Run 不存在时自动发送；
- 编辑和删除有审计时间；
- 发送后状态改为 delivered；
- 重复 dispatcher 不能重复发送。

## 8. Trigger 安全

### 8.1 多 Trigger

- Trigger ID 由系统生成；
- 保存时严格 schema 校验；
- 旧 v1 兼容读取；
- 未知 kind fail-closed；
- Trigger Payload 不能决定工具和权限。

### 8.2 Email

- 正文始终 untrusted；
- Thread ID 是匹配条件，不是可信指令；
- Regex 长度和输入截断继续有效；
- 同 email dedupe。

### 8.3 Calendar

- 只对业务字段变化触发；
- 同一 Event 只有开始/结束时间变化时不触发 `calendar_event_change`，但必须重排 `calendar_before_start`；
- 去重使用 Event ID + 不含纯时间变化的业务内容 hash，并在 60 秒窗口内合并重复同步；
- 日历正文/议程是外部内容；
- 重复同步不重复运行。

### 8.4 Webhook

近期不支持，因此不新增公网接收面。

## 9. Skill Creator

### 9.1 生成不等于执行

模型可以生成脚本草稿，但：

```text
生成草稿 ≠ 发布
发布 ≠ 信任脚本
信任脚本 ≠ 任意 Exec
```

### 9.2 版本信任

信任绑定：

- skill name；
- package hash；
- entrypoint；
- 参数约束；
- 路径范围；
- 网络和 Secret 声明。

文件变化后自动撤销。

### 9.3 Headless

必须同时命中：可信版本、挂载、grant_exec、结构化规则。

## 10. Agent Plugins

- 包内容不携带 Token；
- 路径不可逃逸根目录；
- 每个 Skill 独立失败；
- 导入后仍进入 MailAgent 草稿/隔离区；
- `mcp.json` 第一版只展示，不自动连接；
- 外部 metadata 是不可信内容；
- 许可证和归属保留。

## 11. 审批 TTL

- 普通写操作审批：24 小时；
- 高风险外发审批：2 小时；
- 过期后明确记录 `approval_expired`；
- 过期审批不能被恢复为自动执行。

## 12. 日志与隐私

日志可记录：

- ID；
- 状态；
- error code；
- tool name；
- hash；
- 耗时；
- token 和成本。

默认不记录：

- 完整邮件正文；
- 完整 Notion 页面；
- Secret；
- OAuth token；
- 脚本 Secret 值；
- 用户队列完整文本到普通系统日志。
