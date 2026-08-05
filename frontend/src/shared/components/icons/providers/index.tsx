// W8 模型选择器 — 厂商 logo 组件出口。映射表与解析逻辑在 ./providerIconMap（.ts，零 JSX），
// 本文件只导出组件（react-refresh/only-export-components）。资产授权见 NOTICE.md。

import { Cpu } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'

import { resolveProviderIcon, type ProviderIconVariant } from './providerIconMap'

/** 厂商 logo。默认 **color**（owner dogfood-3：模型选择器要彩色厂商标）；`variant="mono"`
 *  给需要跟着文字色走的场地留着。未匹配 → lucide Cpu（吃 currentColor），尺寸与 logo 对齐。
 *  🔴 `render(props)` 直接调用而非 `<Icon/>`：表里的值是无 hook 的纯 SVG 渲染函数，
 *  当组件用会触发 react-hooks/static-components（抄 ToolTraceCard.toolKindIconEl 先例）。 */
export function ProviderBrandIcon({
  providerId,
  protocol,
  className,
  variant = 'color'
}: {
  providerId: string | null | undefined
  protocol?: LlmProviderProtocol | null
  className?: string
  variant?: ProviderIconVariant
}): React.JSX.Element {
  const render = resolveProviderIcon(providerId, protocol, variant)
  if (render) return render({ className })
  return <Cpu strokeWidth={2} className={cn('size-4 shrink-0', className)} aria-hidden />
}
