// dogfood 0903 —— 排队追问信封的读法。
//
// 现象：owner 在事项跟进的对话里看到气泡上原样打着
// `<queued_followups><message>在发件箱啊，我刚刚发了封邮件的。</message></queued_followups>`。
// 根因不是文案，是**同一条消息在两处气泡走两套渲染**：邮件面板那份认这个信封，
// agent 视图那份（`components/agents/AgentMessage.tsx`）直接画原文。判据与解码收敛到
// `shared/assistant/queuedFollowups.ts`，两处气泡共用，这里钉住它。

import { describe, expect, test } from 'vitest'

import { buildQueuedFollowupsEnvelope } from '../../src/ai-gateway/queuedInputDispatch'
import { parseQueuedFollowups } from '../../src/shared/assistant/queuedFollowups'

describe('排队追问信封', () => {
  test('信封拆成原文；不是信封的照旧返 null', () => {
    expect(parseQueuedFollowups(buildQueuedFollowupsEnvelope(['在发件箱啊，我刚刚发了封邮件的。']))).toEqual([
      '在发件箱啊，我刚刚发了封邮件的。'
    ])
    expect(parseQueuedFollowups(buildQueuedFollowupsEnvelope(['你能干什么', '再说细一点']))).toEqual([
      '你能干什么',
      '再说细一点'
    ])
    expect(parseQueuedFollowups('普通的一句话')).toBeNull()
    // 🔴 判据是「以前缀开头」，不是「含前缀」：用户自己在句子里打出这一串（哪怕连
    // `<message>` 一起打全）也只是普通文本，不该被当成信封拆开。
    expect(
      parseQueuedFollowups('我想问 <queued_followups><message>x</message> 是什么意思')
    ).toBeNull()
  })

  test('🔴 转义能原样绕回来，包括用户自己打出 XML 的情况', () => {
    // 写侧的顺序是 `&`→`&amp;` 在先，所以解码必须 `&amp;` **在后**：反过来
    // `&amp;lt;` 会被二次解成 `<`，用户打的字就被改写了。
    const raw = ['<message>不是标签</message> & 5 > 3', 'a &lt; b']
    expect(parseQueuedFollowups(buildQueuedFollowupsEnvelope(raw))).toEqual(raw)
  })

  test('空信封返 null —— 没内容就别画一个空的「排队补充」块', () => {
    expect(parseQueuedFollowups('<queued_followups>\n</queued_followups>')).toBeNull()
  })
})
