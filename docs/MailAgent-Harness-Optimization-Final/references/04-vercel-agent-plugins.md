# Vercel Agent Plugins 研究

## 1. 它是什么

Agent Plugins 是一种开放插件目录格式，用于把以下组件放在一个包中：

- Agent Skills；
- MCP Server 配置；
- 插件 metadata；
- 客户端专属 extension 目录。

它不是：

- Agent Runtime；
- AI SDK Tool Loop；
- 权限系统；
- Connector Client；
- 自动化或 Trigger 系统。

## 2. 与 Vercel AI SDK 的关系

二者正交：

```text
Agent Plugins = 包和发现
AI SDK        = 模型、流和工具调用
```

MailAgent 可以支持 Agent Plugins，但需要自己实现 importer，并把组件映射到现有 Skill/Connector 系统。

## 3. 典型目录

```text
my-plugin/
├── plugin.json
├── skills/
│   └── meeting-brief/
│       ├── SKILL.md
│       ├── scripts/
│       ├── references/
│       └── assets/
└── mcp.json
```

## 4. 对 MailAgent 有价值的设计

### 4.1 统一分发

一个办公扩展可以同时声明 Skill 和 MCP 依赖。

### 4.2 组件独立失败

坏 Skill 不应阻止其他 Skill；坏 MCP 不应阻止 Skills。

### 4.3 Client-owned Credentials

插件包不能替代 MailAgent OAuth、Keychain、Tool Sync 和权限配置。

### 4.4 路径边界

插件引用必须在根目录内，防止 `../` 和 symlink 逃逸。

## 5. MailAgent 映射

| Plugin Component | MailAgent |
|---|---|
| plugin.json | 外部包 metadata |
| skills/ | Skill Draft/Install |
| scripts/ | 现有 hash/trust/exec |
| references/assets | Skill 渐进资源 |
| mcp.json | 后续 Connector Draft |
| client extensions | 可选 MailAgent 私有扩展，近期不做 |

## 6. 最终采用范围

P9 第一版：

- 导入 plugin.json；
- 导入 Skills；
- mcp.json 只展示；
- 导出 Skill/Plugin；
- 不改内部存储。

后续：

- Streamable HTTP MCP 导入为 disabled Connector Draft；
- 用户在 Connectors Console 授权；
- stdio 暂缓。

## 7. 不应发生

- 安装 Plugin 自动连接 MCP；
- 自动导入 Secret；
- 绕过 quarantine；
- 绕过 Skill trust；
- 把 plugin metadata 放进可信系统 Prompt；
- 替换 `buildGatewayTools`。
