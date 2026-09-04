// 排队追问信封（`<queued_followups>`）的读法 —— 纯函数，零 React。
//
// 写侧在 `ai-gateway/queuedInputDispatch.ts::buildQueuedFollowupsEnvelope`：run 期间入队的几条
// 追问，在 onFinish 时合并成**一条 user 消息**发出去，正文就是这个 XML 信封。它是给模型看的
// 格式，不是给人看的。
//
// 🔴 所以每一处画用户气泡的地方都必须认它，否则原样把 `<queued_followups><message>…` 打在气泡里。
// dogfood 0903 owner 就是这么撞上的：邮件面板那份气泡（assistant/components/message.tsx）认，
// 事项 / 团队 / 通用对话那份（components/agents/AgentMessage.tsx）不认 —— 同一条消息在两个界面
// 长得完全不一样。判据与解码放这里由两处共用，别再各写一份。

export const QUEUED_FOLLOWUPS_PREFIX = '<queued_followups>'

const MESSAGE_RE = /<message>([\s\S]*?)<\/message>/g

/** 信封里的几条追问原文；不是信封（或空信封）返 null，调用方据此走普通渲染。
 *  解码顺序与写侧的转义顺序相反：`&amp;` 必须**最后**还原，否则 `&amp;lt;` 会被二次解成 `<`。 */
export function parseQueuedFollowups(text: string): string[] | null {
  if (!text.startsWith(QUEUED_FOLLOWUPS_PREFIX)) return null
  const messages = [...text.matchAll(MESSAGE_RE)].map((match) =>
    match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  )
  return messages.length > 0 ? messages : null
}
