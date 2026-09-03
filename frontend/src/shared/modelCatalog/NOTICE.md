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

**产物入库**（与 `requirements.lock.txt` 同一条纪律：生成物入库，保打包再现性）。
`.github/workflows/sync-model-catalog.yml` 每周一自动跑同一个脚本，有 diff 就往固定分支
`chore/sync-model-catalog` 开（覆盖）一个 PR —— 出网只发生在 CI runner 上。**不自动合**：
价格 / context 的漂移值得人扫一眼。手动跑仍然随时可以（发版前顺手跑一次最省事）。

🔴 **不要**运行时联网拉：桌面 App 可能离线、远程 web 在 CF Access 后面，运行时拉取会把
「模型名显示不出来」变成一个网络故障面。快照过期的后果只是**降级**（新模型查不到 → 只显示
裸 id，和引入目录之前一模一样），不是崩。

这条 2026-09-02 有一次**边界澄清**（不是放宽）：用户在设置-AI 点「拉取模型列表」时，后端
`POST /api/llm/providers/{id}/models/refresh` 会解析**该 provider 自己 `/models` 响应里带的**
元数据（anthropic 的 `display_name`；openrouter 的 `context_length` / `supported_parameters`
/ `top_provider.max_completion_tokens`），只填 `llm_model` 的 NULL 列。那是用户手动触发的、
打向用户自己配的上游的一次请求，**不是**拉 models.dev —— 本快照仍然是运行时零出网的离线件。

🔴 **不要**手改 `catalog.json`：它是生成物，下次 sync 会被整份覆写。要补上游没有的模型
（已知缺口：豆包 / 火山）请写 `lookup.ts` 的 `LOCAL_CATALOG_OVERRIDES`。

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
