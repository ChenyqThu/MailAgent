# Connector、Skill Creator 与 Agent Plugins

## 1. 三者边界

```text
Connector：外部系统原子工具
Skill：完成一类任务的方法、参考资料和可选脚本
Agent Plugin：把 Skill 与 MCP 配置放进一个可分发目录
```

Agent Plugins 不是 Harness，也不替换 AI SDK、Tool Registry 或权限系统。

## 2. Connector 继续使用现有体系

当前设计保持：

- Python MCP client；
- TS Gateway 只持工具 envelope；
- OAuth/Secret 不进 Gateway Prompt；
- 工具 manifest 白名单；
- per-tool `auto / ask / off`；
- CRUD ceiling；
- Headless `grant_connectors`；
- 服务端再次读取 Agent grant；
- 外部内容围栏；
- 调用超时和截断。

近期不引入新 Connector 抽象层。

## 3. Notion

Notion 通过 MCP Connector 使用：

- Search；
- Fetch；
- Database/Page 读取；
- 创建和更新；
- 复杂输出通过 Prompt 或 Skill 规定。

不为 Notion 建第二套项目、任务或页面模型。

## 4. Skill Creator

### 4.1 目标

用户可以说：

> 把我们刚才整理产品周报的方式做成一个 Skill。

Skill Creator：

```text
理解场景
→ 提炼触发描述
→ 生成 SKILL.md 草稿
→ 可选 references/assets/scripts
→ 生成测试案例
→ 静态校验
→ 用户预览
→ 发布
```

### 4.2 草稿区

Skill 不直接安装。先进入隔离草稿区：

- 显示文件树；
- 展示 SKILL.md；
- 展示引用与脚本；
- 展示声明权限；
- 展示测试；
- 用户确认后发布。

可复用现有 quarantine/hash 思路，但用户本地创建不需要下载授权卡。

### 4.3 默认内容

第一版优先生成：

- `SKILL.md`；
- `references/`；
- `assets/`；
- 测试 prompts。

脚本可由模型判断加入，但必须在草稿中解释：

- 为什么纯指令不足；
- 脚本解决什么确定性问题；
- 读取/写入路径；
- 网络需求；
- Secret；
- entrypoint；
- smoke test。

用户可删除脚本后再发布。

### 4.4 验证

第一版必须生成：

- 触发正例；
- 不应触发的负例；
- 预期输出检查；
- 脚本 smoke test。

暂不建设完整 benchmark 平台。

## 5. Skill 信任三级模型

### 5.1 Builtin Skill

- 随 MailAgent 发布；
- 代码签名/版本控制；
- 声明脚本可免每次审批；
- 仍受 manifest、hash、敏感路径、固定环境和输出围栏约束。

### 5.2 User-created Trusted Skill

- 由 Skill Creator 生成并发布；
- 首次运行展示完整权限摘要；
- 用户可“信任此版本”；
- 文件变化或 package hash 变化后信任失效。

### 5.3 Third-party Skill

- 继续隔离下载与二阶段安装；
- 默认不信任脚本；
- 首次运行审批；
- 用户主动信任指定版本后才允许窄范围免卡。

## 6. 信任不等于任意 Exec

“信任此 Skill 版本”编译成结构化规则：

```text
skill_name
package_hash
entrypoint
argv constraints
cwd scope
read paths
write paths
network capability
secret names
```

UI 可提供：

```text
仅本次允许
始终允许这个输入模式
信任此 Skill 版本声明的入口
```

底层仍然：

- 显式 argv；
- 无 Shell；
- 文件 hash；
- 绝对脚本路径；
- fixed env；
- Secret 声明交集；
- stdout/stderr 脱敏；
- 敏感路径地板。

## 7. Headless Skill Exec

Custom Agent 无人值守执行脚本必须同时满足：

1. Skill 版本已信任；
2. Agent 挂载该 Skill；
3. Agent 有 `grant_exec`；
4. 命中此 Skill 的结构化允许规则；
5. 文件 hash 与 package hash 未变化。

缺一项就不免审批或不注册。

## 8. Vercel Agent Plugins

### 8.1 采用方式

Agent Plugins 1.0 作为**外部导入/导出兼容格式**：

```text
外部 plugin package
→ MailAgent importer
→ 现有 Skill / Connector 生命周期
```

内部不改成 Agent Plugins 原生存储。

### 8.2 第一版范围

支持：

```text
plugin.json
skills/
SKILL.md
references/
assets/
scripts/
```

若发现 `mcp.json`：

- 展示包含哪些 MCP Server；
- 提示当前版本暂未导入；
- 不自动连接或授权。

Streamable HTTP MCP、stdio 与 MailAgent 专属 extension 均记录为未来事项，不属于 P9 第一版。

### 8.3 导入流程

```text
选择目录或 ZIP
→ 验证 plugin.json
→ 路径 containment / symlink 防逃逸
→ 每个 Skill 独立校验
→ 展示成功与失败组件
→ 进入 Skill 草稿/隔离区
→ 用户发布
```

一个 Skill 失败不应阻塞其他 Skill。

### 8.4 导出

Skill Creator 稳定后支持：

- 导出单 Skill；
- 导出 Agent Plugin；
- 不导出 Secret、Token、Session 和审批规则。

### 8.5 不替换的内容

Agent Plugins 不替换：

- `buildGatewayTools`；
- Skill Registry；
- Connector Store；
- ApprovalGuard；
- Tool Class；
- Context Mode；
- Exec Gate；
- Custom Agent；
- Trigger；
- Session。

## 9. 配置导入导出

Custom Agent JSON 包含：

- schema_version；
- title/description/prompt；
- 模型偏好；
- Skill；
- 能力；
- Connector 引用；
- Trigger；
- 预算；
- enabled 状态。

不包含：

- OAuth/API Token；
- Skill Secret；
- 本机绝对路径；
- Session 历史；
- 敏感审批规则。

导入时缺少依赖：显示未满足，不自动安装或授权。
