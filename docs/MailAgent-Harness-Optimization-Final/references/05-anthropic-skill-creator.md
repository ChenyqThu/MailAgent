# Anthropic Skill Creator 研究

## 1. 定位

Anthropic `skills/skill-creator` 提供创建和迭代 Agent Skill 的方法，强调：

- 理解目标；
- 编写 SKILL.md；
- 设计触发描述；
- 生成测试；
- 比较效果；
- 用户评审；
- 打包。

其独立 Skill 许可为 Apache 2.0；复用或修改时应保留许可证与修改声明。

## 2. 对 MailAgent 的价值

MailAgent 当前能安装 Skill，但缺少从真实办公对话中生产 Skill 的流程。

适合的用户入口：

> 把我们刚才处理周报/标案/会议 Brief 的方法做成一个 Skill。

## 3. 建议工作流

```text
理解任务与触发场景
→ 判断纯指令还是需要脚本
→ 生成 SKILL.md
→ 生成 references/assets/scripts
→ 生成正例和负例测试
→ 静态校验
→ 用户预览
→ 发布
→ 可选启用
```

## 4. MailAgent 需要加强的部分

Anthropic 流程更偏通用内容生产。MailAgent 必须额外处理：

- 脚本权限；
- 读取/写入路径；
- 网络；
- Secret；
- entrypoint；
- quarantine；
- package hash；
- 版本信任；
- Headless 授权；
- Exec 输出围栏。

## 5. 文件映射

```text
Skill Draft
├── SKILL.md
├── references/
├── assets/
├── scripts/
├── tests/
└── manifest.json
```

`manifest.json` 由 MailAgent 管理：

- name/version；
- entrypoints；
- secret declarations；
- file hashes；
- permission summary；
- source metadata。

## 6. 脚本生成原则

模型可以判断需要脚本，但必须说明：

- 为什么；
- 做什么；
- 输入输出；
- 路径；
- 网络；
- Secret；
- 测试。

脚本只进入草稿，不立即执行。

## 7. 测试最小集

- 应触发；
- 不应触发；
- 正确输出；
- 缺依赖；
- 恶意输入；
- 脚本 smoke test。

第一版不要求完整 benchmark 对比。
