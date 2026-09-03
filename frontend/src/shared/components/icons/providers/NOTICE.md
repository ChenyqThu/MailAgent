# Third-party notice — provider brand icons

`brandIcons.tsx` 里的厂商 logo path 数据逐字取自：

> **lobe-icons** — MIT © LobeHub — https://github.com/lobehub/lobe-icons
> npm 包 `@lobehub/icons-static-svg`，`icons/<name>.svg`（mono，首批取自 **1.72.0**，
> 下表末尾七家取自 **1.94.0**）与 `icons/<name>-color.svg`（color，取自 **1.94.0**）。

拷入清单（组件名 ← 上游文件名）：

| mono 组件 | 上游 svg | color 组件 | 上游 svg |
|---|---|---|---|
| `AnthropicIcon` | `anthropic.svg` | `AnthropicColorIcon` | `claude-color.svg` ¹ |
| `OpenAiIcon` | `openai.svg` | — | 上游无 `openai-color`（品牌本身单色） |
| `GeminiIcon` | `gemini.svg` | `GeminiColorIcon` | `gemini-color.svg` |
| `DeepSeekIcon` | `deepseek.svg` | `DeepSeekColorIcon` | `deepseek-color.svg` |
| `OpenRouterIcon` | `openrouter.svg` | — | 有 `openrouter-color`，**有意不用** ² |
| `QwenIcon` | `qwen.svg` | `QwenColorIcon` | `qwen-color.svg` |
| `ZhipuIcon` | `zhipu.svg` | `ZhipuColorIcon` | `zhipu-color.svg` |
| `KimiIcon` | `kimi.svg` | — | 有 `kimi-color`，**有意不用** ³ |
| `MiniMaxIcon` | `minimax.svg` | `MiniMaxColorIcon` | `minimax-color.svg` |
| `DoubaoIcon` | `doubao.svg` | `DoubaoColorIcon` | `doubao-color.svg` |
| `SiliconCloudIcon` | `siliconcloud.svg` | `SiliconCloudColorIcon` | `siliconcloud-color.svg` |
| `XaiIcon` | `xai.svg` ⁴ | — | 只补 mono ⁵ |
| `MistralIcon` | `mistral.svg` | — | 只补 mono ⁵ |
| `GroqIcon` | `groq.svg` | — | 只补 mono ⁵ |
| `PerplexityIcon` | `perplexity.svg` | — | 只补 mono ⁵ |
| `CohereIcon` | `cohere.svg` | — | 只补 mono ⁵ |
| `TogetherAiIcon` | `together.svg` | — | 只补 mono ⁵ |
| `FireworksIcon` | `fireworks.svg` | — | 只补 mono ⁵ |

¹ 上游没有 `anthropic-color`；`claude-color`（`#D97757` 珊瑚色放射标）就是各家产品里代表
Anthropic 的那枚。
² `openrouter-color` 是纯 `#C8FF00` 柠檬黄单色 path，白底对比度过低（无深色底衬时不可读）。
³ `kimi-color` 的主字形是 `#fff` 挖白（为深色品牌底衬设计），亮色主题下整个字形会消失。
上游数据没错，是**用法**不匹配我们的无底衬场景 —— 故这两家在彩色语境下逐级回退 mono。
⁴ 上游文件名是 `xai`，`<title>` 写的是 Grok —— 同一枚标。
⁵ 这七家是 2026-09-02 补的（此前登记在 `providerIcons.test.ts` 的「有意无资产」名单里，
模型目录快照有它们的条目但解析不到 logo，只能掉 lucide `Cpu`）。本轮只拷 mono：彩色语境
下按既有的逐级回退用 mono，与 openai 一致；等真有需要再补 `-color`。

改动只做了 JSX 化（`fill-opacity`→`fillOpacity`、`clip-rule`→`clipRule`、`stop-color`→
`stopColor`、渐变 `id` 重命名为 `ma-icon-*` 防与页面内其它 svg 撞、宽高从 `1em` 交给
className）；path 数据与颜色值一个字符没动。

**不引 npm 包**是刻意的：`@lobehub/icons` 的 peer 会经副作用赋值把 `antd ^6.1.1` +
`@lobehub/ui ^5` 拉进运行时 bundle（tree-shake 不掉），为十来个图形加这两坨依赖不划算。
`@lobehub/icons-static-svg` 零依赖但只是一堆 `.svg` 文件，同样不值得进 package.json。
同 `icons/animated/*`（源 pqoqubbw/icons）的既有先例：拷进仓库 + 注明出处。

> 📝 勘误（2026-08-05）：本文档旧版写着「`@lobehub/icons` 的 peer 要求 React ^19（本仓
> React 18）」—— **本仓 `node_modules/react` 实测 19.2.6**，这条理由早已不成立。结论（继续
> 手拷）不变，但依据只剩上面那条 antd / @lobehub/ui peer。

各家 logo 的**商标权**归各自公司所有；此处仅作服务标识用途。
