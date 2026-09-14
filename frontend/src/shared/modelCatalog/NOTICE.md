# Third-party notice — model metadata catalog

`catalog.json` 是从下列开放数据集裁剪出的**快照**：

> **models.dev** — MIT © models.dev — https://github.com/anomalyco/models.dev
> 数据端点 `https://models.dev/api.json`（上游 180 provider / 6057 模型行）。
> 快照生成日期见 `catalog.json` 的 `generatedAt` 字段。

裁剪规则（全部落在 `frontend/scripts/sync-model-catalog.mjs` 里，那份注释是正本）：

- **provider 白名单**：**路由型聚合器一家不留**（openrouter / nano-gpt / vercel / opencode …）。
  它们把别家的端点摆在**同一套 id 命名空间**下，同一个 `gpt-5.6-sol` 在两家能差 3.9 倍
  `limit.context` —— 收进来等于给自己开一个「显示一个可能错几倍的数字」的口子。
  🔴 但白名单**不等于「只有模型作者」**：groq / togetherai / fireworks-ai / siliconflow 这类
  **开放权重模型的自营推理商**是收的（它们是自己那套 SKU 的第一方）。代价要写明白：同一个
  开放权重 id 在两家之间价格仍可能差几倍（实测 `deepseek-ai/DeepSeek-R1` 在 siliconflow
  \$0.50 / togetherai \$3.00）。挡住这一条的不是白名单，是另外两件事 —— ① 它们的 id 自带
  `vendor/` 命名空间，不会与厂商官方 id 相撞；② lookup 的有序链让命中**确定**（不是随机挑
  一家），且能力卡上如实印着「元数据来自 models.dev · <哪一家>」。
- **字段白名单**：`name / description / limit.{context,output} / cost / tool_call / reasoning /
  modalities.input∋image / attachment / release_date / knowledge / status==='deprecated'`。
  其余（`settings` / `reasoning_options` / `experimental` / `open_weights` …）全丢。

规模：18 provider / 479 模型 / 133KB raw（gzip ~18KB）。
`src/shared/` 会同时进桌面 renderer 与远程 web 两个 bundle，所以宁可窄不要宽。

## 怎么更新

```bash
cd frontend && node scripts/sync-model-catalog.mjs
```

**内置快照仍入库**，用于首次启动、离线和更新失败时兜底。2026-09-14 起，
模型元数据同时支持独立于 App 发版的云端更新，替代此前“运行时零联网”的策略。

### 发布与客户端更新

- `.github/workflows/sync-model-catalog.yml` 每天 04:17 UTC 运行，也支持手动触发及相关代码推送。
  从 models.dev 生成快照，通过目录测试和同一份运行时 schema 校验后，原子发布到
  `codex/model-catalog` 数据分支。失败不改现有云端版本，不需要人工合并每日数据 PR。
- 公开地址：`https://raw.githubusercontent.com/ChenyqThu/MailAgent/codex/model-catalog/catalog.json`。
  仅包含公开模型元数据，不上传用户信息，不携带服务商凭据。
- 桌面 renderer 与远程 web 在 App 挂载后读取本地缓存，后台启动检查；成功检查间隔为
  6 小时，失败每小时重试，浏览器恢复联网时额外检查。不等待网络完成再显示界面。
- Electron main 同时加载同一更新器（缓存为 userData 的 `model-catalog-cache-v1.json`，
  原子替换），供内嵌 gateway 的上下文及价格计算使用；renderer/web 使用 localStorage。
- HTTP 超时 10 秒，响应流上限 2 MiB。schemaVersion 必须为 1；字段类型、能力、非负价格
  及正整数上下文经过校验。不安装早于内置快照或当前缓存发布时间的数据。
- 优先级：用户/上游 DB 行 > 本地人工覆盖 > 云端目录 > 内置目录 > 裸 ID。
  更新清查表缓存并通知 React 订阅者，已打开的模型选择器与设置面板即时刷新。
  云端缺失的旧模型保留内置兜底，不自动增删用户配置或启用模型。
- 模型所属厂商随目录更新，复用 App 内置的厂商图标；这条通道只交付数据，不交付代码或 SDK。
  新协议或尚未内置的图标资源仍需 App 支持。
- 用户点“拉取模型列表”仍向自己配置的 provider 请求 `/models`，与此元数据通道分工不变。

### 回退与验证

发布错误数据时，使用当前时间重新发布已知正确内容；不要倒退 publishedAt。
客户端拒绝坏数据或过旧数据，继续使用上次有效缓存。暂停 workflow 可停止后续发布。
安装首次支持此通道的 App 版本后，后续模型介绍/价格/能力更新不再需要发版。

```bash
cd frontend
pnpm exec vitest run tests/shared/modelCatalog tests/shared/providerIcons.test.ts
pnpm exec tsx scripts/prepare-model-catalog.ts
```

`catalog.json` 是生成物，不能手改。补上游没有的模型应写 `lookup.ts` 的
`LOCAL_CATALOG_OVERRIDES`；需要云端覆盖的新条目则应在生成流程中添加有出处的数据源。

## 为什么不是 lobehub 的 `model-bank`

参考产品 lobe-chat 用的是自家 `packages/model-bank`。**有意不用它**，两条理由：

1. **许可证**：`model-bank` 在 `lobehub/lobehub` monorepo 内，`package.json` 是 `private: true`
   且无独立 license 字段，继承仓库的 **LobeHub Community License**（Apache 2.0 + 附加条款），
   其 1(b) 明写「基于 LobeChat 开发并分发衍生作品需购买商业许可」。MailAgent 是公开分发的
   桌面 App（GitHub Releases + 官网），落不落进这条的边界模糊，而 models.dev 是 MIT，没有
   这个问题。
   （我们手拷 lobe 的 **icon** 是另一回事 —— icon 来自 `lobehub/lobe-icons` 仓库，**MIT**。）
2. **数据质量**：实测 models.dev 严格更好 —— `limit.output` 覆盖率 97.1% vs 47.3%、
   `tool_call` 100% vs 56.2%、`release_date` 100% vs 40.6%；且 model-bank 把 Kimi K3 的定价
   记错了 6.7 倍（记 $20/$100，Moonshot 官方 $3/$15，models.dev 逐项吻合）。

各模型名称 / 厂商名的**商标权**归各自公司所有；此处仅作服务标识用途。
