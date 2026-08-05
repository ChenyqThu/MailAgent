// W8 模型选择器 — 厂商 logo 组件出口。映射表与解析逻辑在 ./providerIconMap（.ts，零 JSX），
// 本文件只导出组件（react-refresh/only-export-components）。资产授权见 NOTICE.md。

import { Cpu } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'

import { resolveProviderIcon, type ProviderIconVariant } from './providerIconMap'

/** 厂商 logo。默认 **color**（owner dogfood-3：模型选择器要彩色厂商标）；`variant="mono"`
 *  给需要跟着文字色走的场地留着。未匹配 → lucide Cpu（吃 currentColor），尺寸与 logo 对齐。
 *
 *  🔴 渲染**某个模型**的厂商时必须把 `catalogProviderId`（= `option.catalogMeta?.
 *  catalogProviderId`）一起传进来 —— 中转 provider 下 providerId/protocol 的厂商信息不可靠
 *  （见 providerIconMap 文件头）。它是**可选** prop：漏传不会报错，只会静默退回那条不可靠的
 *  老链路，所以每个消费点都由 model_picker.test.tsx 逐个上闸（现有 5 个：两个触发器 ×
 *  组标题 × 菜单行 × hover 能力卡）。
 *
 *  渲染 provider **本身**（如组标题）时，只有在「组内每一行都指向同一家」时才传那一家 ——
 *  一致是事实，不是猜；混装组传 null 落回 providerId/protocol。判定见 ModelPicker
 *  的 `groupCatalogProviderId`。
 *
 *  🔴 `render(props)` 直接调用而非 `<Icon/>`：表里的值是无 hook 的纯 SVG 渲染函数，
 *  当组件用会触发 react-hooks/static-components（抄 ToolTraceCard.toolKindIconEl 先例）。 */
export function ProviderBrandIcon({
  catalogProviderId,
  providerId,
  protocol,
  className,
  variant = 'color'
}: {
  catalogProviderId?: string | null
  providerId: string | null | undefined
  protocol?: LlmProviderProtocol | null
  className?: string
  variant?: ProviderIconVariant
}): React.JSX.Element {
  const render = resolveProviderIcon({ catalogProviderId, providerId, protocol }, variant)
  if (render) return render({ className })
  return <Cpu strokeWidth={2} className={cn('size-4 shrink-0', className)} aria-hidden />
}
