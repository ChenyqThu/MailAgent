// @vitest-environment happy-dom
//
// task 09-02 — ImageGenCard: the four faces rendered standalone from mocked tool-part props
// (SimpleApprovalCard.test 先例). generating (placeholder + prompt + resolution badge, pulse gated
// on reduced-motion), complete (img from the gateway base + lightbox + download), error (localized
// line + detail; retry is a live-composer affordance and stays absent standalone), pending (approve
// / reject wired to respondToApproval — the ask-tier part must never be a buttonless spinner).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { ImageGenCard } from '@shared/assistant/tools/image/ImageGenCard'
import {
  absoluteImageUrl,
  buildRetryPrompt,
  placeholderAspect,
  readImageGenInput,
  readImageGenOutput
} from '@shared/assistant/tools/image/imageGenCard.lib'
import { componentRegistry } from '@shared/assistant/tools/ComponentRegistry'

await i18n.changeLanguage('zh-CN')

const ARGS = { prompt: '一只在海边的柴犬', size: '1024x1536', n: 1, source_images: [] }
const RESULT = {
  mode: 'generate',
  model: 'oai:gpt-image-1',
  images: [
    {
      file_id: '42-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png',
      mime: 'image/png',
      width: 1024,
      height: 1536,
      url: '/api/ai/generated/42-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png'
    }
  ]
}

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'generate_image',
    toolCallId: 'tc1',
    args: ARGS,
    argsText: JSON.stringify(ARGS),
    result: undefined,
    isError: undefined,
    status: { type: 'running' },
    approval: undefined,
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(),
    ...over
  } as unknown as ToolCallMessagePartProps
}

/** The renderer's gateway base comes from the sessionStorage stash (runtime/flags.ts). */
function stashGatewayPort(port: number): void {
  window.sessionStorage.setItem('mailagent:aiGatewayPort', String(port))
}

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('ImageGenCard — registry', () => {
  test('generate_image resolves to ImageGenCard (not the buttonless fallback)', () => {
    expect(componentRegistry.resolve('generate_image')).toBe(ImageGenCard)
  })
})

describe('ImageGenCard — generating', () => {
  test('placeholder with the requested aspect + resolution badge + prompt, no <img>', () => {
    render(<ImageGenCard {...mockProps({ status: { type: 'running' } })} />)
    expect(screen.getByText('生成图片')).toBeTruthy()
    const box = screen.getByTestId('imagegen-placeholder')
    expect(box.style.aspectRatio).toBe('1024 / 1536')
    expect(screen.getByText('1024×1536')).toBeTruthy()
    expect(screen.getByText('生成中…')).toBeTruthy()
    expect(screen.getByText('一只在海边的柴犬')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })

  test('reduced motion (tests/setup.ts forces reduce) → no pulse class', () => {
    render(<ImageGenCard {...mockProps({ status: { type: 'running' } })} />)
    expect(screen.getByTestId('imagegen-placeholder').className).not.toContain('animate-pulse')
  })

  test('motion allowed → pulse class present', () => {
    vi.stubGlobal('matchMedia', ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia)
    render(<ImageGenCard {...mockProps({ status: { type: 'running' } })} />)
    expect(screen.getByTestId('imagegen-placeholder').className).toContain('animate-pulse')
  })

  test('edit mode (source_images non-empty) → 编辑 title + 编辑中', () => {
    const args = { ...ARGS, source_images: ['attached:last'] }
    render(
      <ImageGenCard
        {...mockProps({ args, argsText: JSON.stringify(args), status: { type: 'running' } })}
      />
    )
    expect(screen.getByText('编辑图片')).toBeTruthy()
    expect(screen.getByText('编辑中…')).toBeTruthy()
  })
})

describe('ImageGenCard — complete', () => {
  test('renders the image from the gateway base + the actual resolution, download fetches it', async () => {
    stashGatewayPort(4567)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
    )

    render(<ImageGenCard {...mockProps({ result: RESULT, status: { type: 'complete' } })} />)
    const img = document.querySelector('img')!
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe(
      'http://127.0.0.1:4567/api/ai/generated/42-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png'
    )
    expect(screen.getByText('1024×1536')).toBeTruthy()
    expect(screen.queryByTestId('imagegen-placeholder')).toBeNull()

    fireEvent.click(screen.getByText('下载'))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://127.0.0.1:4567/api/ai/generated/42-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png'
    )
  })

  test('click on the image opens the lightbox (a second <img> with the same src)', () => {
    stashGatewayPort(4567)
    render(<ImageGenCard {...mockProps({ result: RESULT, status: { type: 'complete' } })} />)
    const img = document.querySelector('img')!
    fireEvent.click(img)
    const all = Array.from(document.querySelectorAll('img')).map((el) => el.getAttribute('src'))
    expect(all.filter((s) => s === img.getAttribute('src'))).toHaveLength(2)
  })
})

describe('ImageGenCard — error', () => {
  test('localized failure line + the tool error detail; no retry without a live composer', () => {
    render(
      <ImageGenCard
        {...mockProps({
          isError: true,
          result: {
            error:
              '[E_IMAGE_MODEL_NOT_CONFIGURED] No image model is configured. Ask the user to pick one under Settings.'
          },
          status: { type: 'incomplete', reason: 'error' }
        })}
      />
    )
    expect(screen.getByText('图片生成失败')).toBeTruthy()
    expect(screen.getByText(/E_IMAGE_MODEL_NOT_CONFIGURED/)).toBeTruthy()
    expect(screen.queryByText('重试')).toBeNull()
  })

  test('retry prompt carries the original prompt verbatim', () => {
    expect(buildRetryPrompt(i18n.t.bind(i18n), '一只柴犬')).toBe('请重新生成这张图：一只柴犬')
  })
})

describe('ImageGenCard — pending (owner tier = ask)', () => {
  test('shows the prompt for review + approve / reject wired to respondToApproval', () => {
    const respondToApproval = vi.fn()
    render(
      <ImageGenCard
        {...mockProps({
          status: { type: 'requires-action', reason: 'interrupt' },
          approval: { id: 'apr-1' },
          respondToApproval
        })}
      />
    )
    expect(screen.getByText('将把以下描述发给图像模型生成图片（需你批准）：')).toBeTruthy()
    expect(screen.getByText('一只在海边的柴犬')).toBeTruthy()
    fireEvent.click(screen.getByText('允许'))
    expect(respondToApproval).toHaveBeenCalledWith({ approved: true })
  })
})

describe('ImageGenCard — pure readers', () => {
  test('readImageGenInput degrades on partial / unparseable args', () => {
    expect(readImageGenInput(undefined, '{"prompt":"ha').prompt).toBe('')
    expect(
      readImageGenInput({ prompt: 'x', size: 'big', source_images: ['a', 'b'] }, undefined)
    ).toEqual({
      prompt: 'x',
      size: null,
      sourceCount: 2
    })
  })
  test('readImageGenOutput keeps only well-formed refs', () => {
    expect(
      readImageGenOutput({ images: [{ file_id: 'a', url: '/u' }, { url: '/no-id' }, 'junk'] })
    ).toEqual([{ fileId: 'a', url: '/u', width: null, height: null }])
    expect(readImageGenOutput({ error: 'x' })).toEqual([])
  })
  test('placeholderAspect / absoluteImageUrl', () => {
    expect(placeholderAspect('1536x1024')).toBe('1536 / 1024')
    expect(placeholderAspect(null)).toBe('1 / 1')
    expect(placeholderAspect('0x10')).toBe('1 / 1')
    expect(absoluteImageUrl('/api/ai/generated/x.png')).toBe('/api/ai/generated/x.png')
    stashGatewayPort(9)
    expect(absoluteImageUrl('/api/ai/generated/x.png')).toBe(
      'http://127.0.0.1:9/api/ai/generated/x.png'
    )
  })
})
