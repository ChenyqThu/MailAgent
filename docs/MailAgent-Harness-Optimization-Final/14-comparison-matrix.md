# 外部项目横向对比与最终借鉴结论

## 1. 总表

| 维度 | MailAgent 当前 | Pi Mono | Craft Agents OSS | LobeHub | 最终选择 |
|---|---|---|---|---|---|
| 核心场景 | 邮件与办公 | 终端 Coding Harness | 多 Backend 桌面 Agent | 综合 Agent 平台 | 保持邮件/办公定位 |
| Runtime | Vercel AI SDK | 自有轻量 Loop | Claude/Pi 等 Backend | General/Graph Runtime | 继续 AI SDK 单 Runtime |
| Session | SQLite UIMessage | JSONL Tree | Workspace Session | Server Thread/Operation | 强化现有 SQLite Session |
| Steering | 当前只能 Stop | Steering/Follow-up | Redirect/Abort | 运行控制 | 先做 Follow-up Queue |
| Compact | 仅占用可视化 | 成熟 Compaction | Backend 相关 | Runtime Compression | 借鉴摘要边界，不换 Loop |
| Agent 定制 | Custom Agent | Extension/Skill | Sources/Automation | Agent Builder | 强化 Custom Agent |
| Connector | MCP + 服务端双闸 | Extensions/MCP | Source Manager | Connector Engine | 保持现有 Connector |
| Skill | Registry/安装/Exec | Agent Skills | Skill storage | Builtin/Market | 引入 Skill Creator |
|审批 | 强领域审批 | Extension 自定义 | Permission modes | Human intervention | 保留 MailAgent 体系 |
|项目/团队 | Notion 为真源 | cwd/project | Workspace/Project | Workspace/Group | 不在 MailAgent 重建 |

## 2. 从 Pi Mono 借鉴

采纳：

- Context Compaction 的 full history / model context 分离；
- Steering 与 Follow-up 两种语义；
- 运行中可排队输入；
- 轻量 Plan/Session UI 思想；
- Skill/Extension 可扩展性。

不采纳：

- 替换 AI SDK Loop；
- 默认 bash/file 工具；
- 完整系统权限的 Extension；
- Session Tree/Fork 近期实现；
- Pi Runtime。

## 3. 从 Craft Agents 借鉴

采纳：

- Source 状态可见；
- 组件级失败隔离；
- 自动化 Trigger 的简单模型；
- 权限和输入转换的集中思维；
- Session 状态与未读体验；
- 同一产品可包装多个底层能力，但不要求底层统一。

不采纳：

- AgentBackend 抽象；
- Workspace/Project 产品模型；
- Pi subprocess RPC；
- 通用 Automation Engine；
- 文件系统为核心工作空间。

## 4. 从 LobeHub 借鉴

采纳：

- 人工审批状态清晰；
- 父子 Agent 运行引用；
- 等待审批不等于完成；
- Agent Builder 产品交互；
- 运行状态、成本和错误可观察；
- Graph 的 typed output 思想可用于 Prompt/Skill，而非近期 Runtime。

不采纳：

- 服务端 Operation 平台；
- GraphAgent；
- Agent Group；
- Workspace/Project/Task；
- 复制 Community License 代码。

## 5. 从 Anthropic Skill Creator 借鉴

采纳：

- 从用户任务反推 Skill；
- SKILL.md + references/assets/scripts；
- 测试正例与负例；
- 先草稿、后评审和发布；
- 优化触发描述；
- 打包与分享。

MailAgent 加强：

- 脚本权限摘要；
- 现有 quarantine/hash；
- 可信版本；
- Headless 多重授权；
- Secret 声明与脱敏。

## 6. 从 Vercel Agent Plugins 借鉴

采纳：

- 统一外部包目录；
- Skill + MCP component；
- 组件级失败隔离；
- 客户端负责权限和凭证；
- 插件根路径 containment。

不采纳：

- 把它当 Runtime；
- 替换 MailAgent 内部插件系统；
- 安装后自动授权 Connector；
- 第一版实现 stdio MCP。

## 7. 最终组合

```text
MailAgent AI SDK Harness
+ Pi 风格 Compact / Follow-up UX
+ Craft 风格 Source 状态与组件隔离
+ LobeHub 风格父子运行可观察性
+ Anthropic 风格 Skill Creator
+ Vercel Agent Plugins 外部包兼容
```

所有借鉴都落在现有架构内，不引入第二套运行时和控制面。
