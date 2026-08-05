# Third-party notice — provider brand icons

`brandIcons.tsx` 里的 11 个厂商 logo path 数据逐字取自：

> **lobe-icons** — MIT © LobeHub — https://github.com/lobehub/lobe-icons
> npm 包 `@lobehub/icons-static-svg@1.72.0`，`icons/<name>.svg` 的 **mono** 变体。

拷入清单（组件名 ← 上游文件名）：

| 组件 | 上游 svg |
|---|---|
| `AnthropicIcon` | `anthropic.svg` |
| `OpenAiIcon` | `openai.svg` |
| `GeminiIcon` | `gemini.svg` |
| `DeepSeekIcon` | `deepseek.svg` |
| `OpenRouterIcon` | `openrouter.svg` |
| `QwenIcon` | `qwen.svg` |
| `ZhipuIcon` | `zhipu.svg` |
| `KimiIcon` | `kimi.svg` |
| `MiniMaxIcon` | `minimax.svg` |
| `DoubaoIcon` | `doubao.svg` |
| `SiliconCloudIcon` | `siliconcloud.svg` |

改动只做了 JSX 化（`fill-opacity`→`fillOpacity`、`clip-rule`→`clipRule`、宽高从 `1em`
交给 className）；path 数据一个字符没动。

**不引 npm 包**是刻意的：`@lobehub/icons` 的 peer 要求 React ^19（本仓 React 18），
且任意导入会经副作用赋值把 antd + `@lobehub/ui` 拉进运行时 bundle。
`@lobehub/icons-static-svg` 零依赖但只是一堆 `.svg`，为 11 个图形加条依赖不划算。
同 `icons/animated/*`（源 pqoqubbw/icons）的既有先例：拷进仓库 + 注明出处。

各家 logo 的**商标权**归各自公司所有；此处仅作服务标识用途。
