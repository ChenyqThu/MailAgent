# Research Sources — 官方资料与架构依据

> status: planning
> last-verified: 2026-06-22
> purpose: 记录本专项评估 Vercel AI SDK、assistant-ui、AG-UI 时使用的官方资料入口。

## 1. Vercel AI SDK

| 主题 | 官方资料 | 本专项使用方式 |
|---|---|---|
| AI SDK 定位 | https://ai-sdk.dev/docs/introduction | 判断 AI SDK 适合接管 LLM provider 标准化、Core / UI runtime，而不是替代 MailAgent Python domain services |
| 生成与流式文本 | https://ai-sdk.dev/docs/ai-sdk-core/generating-text | 设计 AI SDK Gateway `streamText` 基础 streaming endpoint |
| Tool Calling | https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling | 设计 Gateway tool registry、zod / JSON schema、tool execute、multi-step loop |
| Chatbot Tool Usage | https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage | 设计 UIMessage tool parts、approval-requested、approval response UI |
| UI / Generative UI | https://ai-sdk.dev/docs/ai-sdk-ui/overview | 设计 assistant-ui 与 AI SDK UIMessage stream 接入 |

## 2. assistant-ui

| 主题 | 官方资料 | 本专项使用方式 |
|---|---|---|
| Runtime 选择 | https://www.assistant-ui.com/docs/runtimes/pick-a-runtime | 判断 AI SDK Runtime 是目标主路径，ExternalStoreRuntime 是 legacy adapter，AG-UI 是后续 interop |
| Tool UI / Generative UI | https://www.assistant-ui.com/docs/guides/ToolUI | 设计 A2UI ComponentRegistry 与原生 React tool cards |
| AG-UI quickstart | https://www.assistant-ui.com/docs/runtimes/ag-ui/quickstart | 设计 Phase 05 AG-UI mirror / interop endpoint |

## 3. 项目内调研依据

| 文件 | 结论 |
|---|---|
| `frontend/package.json` | 当前项目无 `ai` / `@ai-sdk/*` / assistant-ui 依赖，现状不是 Vercel AI SDK 架构 |
| `frontend/src/shared/chat/runtime.ts` | 当前 chat orchestration 是自研 `createChatRuntime` + dispatcher + harness |
| `frontend/src/shared/chat/harness.ts` | 当前已有 multi-step tool loop 与 `pending_confirmation` 机制 |
| `frontend/src/shared/chat/types.ts` | 当前 `ChatStreamEvent` 已覆盖 chunk、thinking、tool_use、tool_result、pending_confirmation、usage、done、error |
| `src/api/routers/chat.py` | 当前 serve-api 提供 `/api/chat/llm-proxy`、`/api/chat/notion-agent`、chat persistence endpoints |
| `frontend/src/shared/components/chat/AIChatPanel.tsx` | 当前视图层仍是 MailAgent 自研 MessageList / Composer / ConfirmToolDialog |

## 4. 关键事实摘要

- AI SDK 是 TypeScript toolkit，适合做模型调用、流式文本、工具调用、agent orchestration 与 UI hooks。
- AI SDK Core 的 `generateText` / `streamText` 支持生成和流式文本，tool calling 构建在文本生成之上。
- AI SDK tools 使用 `description`、`inputSchema`、`execute`，并支持 `generateText` / `streamText` 的 `tools` 参数。
- `stopWhen` 可让 `generateText` / `streamText` 在工具调用后自动继续多步调用，直到无更多工具或达到停止条件。
- AI SDK UI 的 tool approval 适合敏感操作：server-side tool 只有用户确认后才执行；client 侧通过 approval response approve / deny。
- assistant-ui 的 runtime 选择建议与后端协议绑定：Vercel AI SDK 项目走 AI SDK Runtime；已有自定义 store 可走 ExternalStoreRuntime；AG-UI 后端走 AG-UI Runtime。
- assistant-ui Tool UI 支持把 tool calls 渲染成交互式 UI，这是 MailAgent A2UI ComponentRegistry 的基础。
