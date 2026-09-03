// @vitest-environment happy-dom
// dogfood 0903 —— 助手正文里的生成图片必须能加载。
//
// 报的现象：同一次 `generate_image`，工具卡里的图是好的，正文里模型自己写的 `![](…)`
// 显示成斜体的「图片不可用」。根因是工具结果里的 `url` 是**根相对**的
// `/api/ai/generated/<file_id>`：卡片走 `absoluteImageUrl` 补了 gateway 的 origin，
// 而 markdown 渲染器没补 —— 打包态 renderer 跑在 `file://` 上，那条地址解析成
// `file:///api/ai/generated/…`，必然加载失败，Streamdown 于是画它的 imageNotAvailable。

import { beforeEach, describe, expect, test } from 'vitest'
import { defaultUrlTransform } from 'streamdown'

import { assistantMarkdownUrlTransform } from '@shared/assistant/tools/image/imageGenCard.lib'
import { GENERATED_IMAGE_ROUTE_PREFIX } from '@shared/generatedImages'

const NODE = { type: 'element', tagName: 'img', properties: {}, children: [] } as never

beforeEach(() => {
  // resolveAiGatewayBaseUrl 先读 ?aiGatewayPort，再读 sessionStorage 里存的那份。
  window.sessionStorage.clear()
  window.history.replaceState(null, '', '/?aiGatewayPort=41234')
})

describe('助手正文的地址改写', () => {
  test('生成图片的根相对地址补成 gateway 绝对地址', () => {
    const url = `${GENERATED_IMAGE_ROUTE_PREFIX}7-2f1c9a10-0b3d-4e77-9f2a-11aa22bb33cc.png`
    expect(assistantMarkdownUrlTransform(url, 'src', NODE)).toBe(`http://127.0.0.1:41234${url}`)
  })

  test('普通 http 链接原样通过', () => {
    expect(assistantMarkdownUrlTransform('https://example.com/a.png', 'src', NODE)).toBe(
      'https://example.com/a.png'
    )
  })

  test('非生成图片的地址一律交回 Streamdown 自己那份，我们不自作主张', () => {
    // 🔴 传了自定义 urlTransform 就接管了 Streamdown 的整条改写通道，所以剩下的必须原样
    // 委回 `defaultUrlTransform`。实测 streamdown@2.5 的这一份是**恒等**的（与
    // react-markdown 不同，它不做协议过滤 —— 正文净化在 rehype-harden 那一层）。这里
    // 逐条钉住委托关系：哪天上游给它加了过滤，我们自动继承而不是绕过。
    for (const url of ['https://example.com/a.png', 'javascript:alert(1)', '#frag', 'mailto:a@b.c']) {
      expect(assistantMarkdownUrlTransform(url, 'href', NODE)).toBe(
        defaultUrlTransform(url, 'href', NODE)
      )
    }
  })
})
