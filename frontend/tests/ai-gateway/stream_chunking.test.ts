// 流式分块粒度闸（0805 check）——STREAM_CHUNKING_REGEX 是「改错了会静默退化观感、但没有
// 任何别的测试会因此变红」的那类常量：前端流式动效已整层删除，owner 感知到的打字节奏
// **完全**由它 + STREAM_CHUNKING_DELAY_MS 决定。故这里用**实测**切分形状把它钉住。
//
// 🔴 fixture 不是手推的：全部由真实 `smoothStream`（ai@7）跑出来后逐条核对写死。所以本
// 文件也顺带是 ai 升级的一道闸 —— 上游改了 detectChunk 语义（chunk = buffer.slice(0,
// match.index) + match[0]）这里会红。
//
// 有意**不**断言实测时长（跑得快慢受机器负载影响，钉了必 flake）；钉的是切分形状 + 拍子
// 常量值本身（后者是绊线，见文末那条）。

import { describe, expect, test } from 'vitest'
import { smoothStream } from 'ai'

import { STREAM_CHUNKING_DELAY_MS, STREAM_CHUNKING_REGEX } from '../../src/ai-gateway/chatRun'

/** 把一段文本喂进真实 smoothStream，收集它实际吐出的 text chunk。 */
async function chunk(text: string, type: 'text' | 'reasoning' = 'text'): Promise<string[]> {
  const transform = smoothStream({
    chunking: STREAM_CHUNKING_REGEX,
    delayInMs: 0,
    _internal: { delay: async () => {} }
  })()
  const out: string[] = []
  const pipe = transform.readable.pipeTo(
    new WritableStream({
      write(c: { type: string; text?: string }) {
        if (c.type === `${type}-delta` && typeof c.text === 'string') out.push(c.text)
      }
    })
  )
  const w = transform.writable.getWriter()
  await w.write({ type: `${type}-start`, id: '1' })
  await w.write({ type: `${type}-delta`, id: '1', text })
  await w.write({ type: `${type}-end`, id: '1' }) // 触发 flushBuffer
  await w.close()
  await pipe
  return out
}

describe('流式分块 — 中文逐字', () => {
  test('汉字逐个成块；中文标点不在 [一-鿿] 内，跟着下一个汉字一起出', async () => {
    // 🔴 这条是最容易被"优化"掉的直觉陷阱：看起来像标点单独成块，实测是 `。我` 合并。
    expect(await chunk('今天很好。我们走，好吗？')).toEqual([
      '今',
      '天',
      '很',
      '好',
      '。我',
      '们',
      '走',
      '，好',
      '吗',
      '？'
    ])
  })

  test('句末标点落在整段末尾时由 flushBuffer 吐出，不吞字', async () => {
    const text = '结束。'
    const chunks = await chunk(text)
    expect(chunks.at(-1)).toBe('。')
    expect(chunks.join('')).toBe(text)
  })
})

describe('流式分块 — 英文逐词', () => {
  test('按整词出（含尾随空白）', async () => {
    expect(await chunk('the quick brown fox')).toEqual(['the ', 'quick ', 'brown ', 'fox'])
  })

  test('末尾无空格的词不会卡在 buffer 里 —— flushBuffer 兜底', async () => {
    const chunks = await chunk('trailing word')
    expect(chunks.at(-1)).toBe('word')
  })
})

describe('流式分块 — markdown 记号不被拦腰切开', () => {
  // 旧句级正则要靠 lookahead 才躲得开这几个；逐词粒度下是天然性质。回归到任何
  // 「按标点切」的方案都会让这三条红。
  test('小数不被切成 `1.` + `5`', async () => {
    expect(await chunk('版本 1.5 好')).toEqual(['版', '本', ' 1.5 ', '好'])
  })

  test('图片语法整块出（不会闪 `!` + `[alt](url)`）', async () => {
    expect(await chunk('看 ![alt](https://x.test/a.png) 完')).toEqual([
      '看',
      ' ![alt](https://x.test/a.png) ',
      '完'
    ])
  })

  test('无空格链接整块出', async () => {
    expect(await chunk('见 [文档](https://a.test/b) 说')).toEqual([
      '见',
      ' [文档](https://a.test/b) ',
      '说'
    ])
  })

  test('无内部空格的强调整块出 —— `**重点**` 不产生悬挂 `**`', async () => {
    expect(await chunk('这是 **重点** 内容')).toEqual(['这', '是', ' **重点** ', '内', '容'])
  })
})

describe('流式分块 — 不变量', () => {
  test('任何输入都无损（拼回去 === 原文）', async () => {
    const cases = [
      '中英 mixed 混排，with punctuation。',
      '```python\nprint("hi")\n```\n',
      '| a | b |\n| - | - |\n| 1 | 2 |\n',
      '- 一\n- 二\n- third\n',
      '完成 🎉 了', // 代理对不可被拆
      '> 引用\n\n段落',
      ''
    ]
    for (const text of cases) expect((await chunk(text)).join('')).toBe(text)
  })

  test('reasoning-delta 与 text-delta 走同一套节流（改 delay 会同时影响思考流）', async () => {
    // 这条钉的是一个容易被遗忘的事实，不是期望的行为偏好：smoothStream 对两类 delta
    // 一视同仁，所以开思考时长中文推理会按同速率排队并推后正文。
    expect(await chunk('很好。', 'reasoning')).toEqual(['很', '好', '。'])
  })

  test('拍子 = 7（对齐 beUI ≈110 字/秒）；改档必须先读权衡', () => {
    // 这条是**绊线**不是契约：拍子可以调，但它有硬代价（显示耗时下界 = chunk 数 × 单拍，
    // smoothStream 无追赶；且 reasoning-delta 共用同一节流）。故意让改档的人红一条，
    // 逼他去读 STREAM_CHUNKING_DELAY_MS 的头注释再决定。顺带钉住「是常量不是 env」——
    // 0804 的 MAILAGENT_STREAM_CHUNKING 三档已收敛掉。
    expect(STREAM_CHUNKING_DELAY_MS).toBe(7)
  })

  test('CJK 区间边界 U+4E00 / U+9FFF 都逐字成块（钉行为而非正则拼写）', async () => {
    expect(await chunk('一鿿')).toEqual(['一', '鿿'])
  })
})
