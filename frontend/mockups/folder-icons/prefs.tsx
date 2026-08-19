// 每行两个 per-folder 开关（通知 / AI 分类）+ 列头 + 内建邮箱行。
//
// 控件形态 owner 已拍：**只用主仓 `@shared/components/ui/switch` 的 Switch**
// （32×18 原尺寸，不改造）。早先并列试的「图标钮」形态与那个二选一开关都已删掉。
//
// 🔴 极性不是我编的，是从后端读出来的（源码位置写在页面底部的「语义」卡里）：
//   · FOLDER_NOTIFY_ENABLED 是**白名单**：自定义文件夹默认**不**通知，进名单才通知。
//     → 「通知」开关缺省 = 关。
//   · FOLDER_LLM_DISABLED 是**黑名单**：自定义文件夹默认**跑** LLM，进名单才跳过。
//     → 「AI 分类」开关缺省 = 开，落库列 llm_disabled 与它**反向**。
//   · 两个 gate 都先判 is_custom_folder_mailbox()，标准邮箱直接 return False
//     → 内建 5 行**不受这两个开关约束**，所以那 5 行的开关位画的是「—」不是关。
//     🔴 但「存档」**不算**标准邮箱（STANDARD_MAILBOXES 有意不含它），所以它在
//     「已同步文件夹」那段、拿真开关，不在内建段。

import { Lock } from 'lucide-react'

import { Switch } from '@shared/components/ui/switch'

import { Tip } from './tip'

/* ── 列宽 —— 列头、拖拽行、内建行共用这一份，保证三者竖着对齐 ───────── */

/** DragReorderList 壳的左侧占位：pl-2 (8) + grip w-9 (36) + gap-2.5 (10)。 */
export const GRIP_GUTTER = 54
/** Switch 原尺寸 32px + 两侧各 4px 余量。 */
export const COL_TOGGLE = 'w-[40px]'
export const COL_COUNT = 'w-[56px]'
export const COL_INDEX = 'w-4'
/** 图标列（内建段是静态图标，自定义段是可点的图标按钮）。 */
export const COL_ICON = 'w-7'

/* ── 单个开关 ───────────────────────────────────────────────────── */

interface ToggleSpec {
  /** 列头短标签。 */
  head: string
  onLabel: string
  offLabel: string
  /** 缺省态的说明（写进 tip，避免 owner 把「关」误读成「我关的」）。 */
  fallback: string
}

export const TOGGLE_SPEC: Record<'notify' | 'ai', ToggleSpec> = {
  notify: {
    head: '通知',
    onLabel: '新邮件推飞书',
    offLabel: '不推飞书',
    fallback: '自定义文件夹缺省就是「不推」（FOLDER_NOTIFY_ENABLED 白名单）'
  },
  ai: {
    head: 'AI',
    onLabel: '跑 LLM 分类',
    offLabel: '跳过 LLM（省成本去噪）',
    fallback: '自定义文件夹缺省就是「跑」（FOLDER_LLM_DISABLED 黑名单）'
  }
}

export function PrefToggle({
  kind,
  on,
  folderName,
  globalOff,
  onChange
}: {
  kind: 'notify' | 'ai'
  on: boolean
  folderName: string
  /** 对应总闸（FEISHU_NOTIFY_ENABLED / LLM_AGENT_ENABLED）关着 —— 这一列当前不生效。 */
  globalOff: boolean
  onChange: (next: boolean) => void
}): React.ReactElement {
  const spec = TOGGLE_SPEC[kind]

  const tip = globalOff
    ? `${on ? spec.onLabel : spec.offLabel} —— 但${kind === 'notify' ? '飞书通知' : 'AI 分类'}总闸关着，这列当前不生效`
    : `${folderName}：${on ? spec.onLabel : spec.offLabel}`

  return (
    <Tip label={tip} className={`${COL_TOGGLE} shrink-0 justify-center`}>
      {/* 行上 pointerdown 会起拖；开关自己吃掉，点开关不会误拖。 */}
      <span
        onPointerDown={(e) => e.stopPropagation()}
        className={globalOff ? 'opacity-45' : undefined}
      >
        <Switch
          checked={on}
          onCheckedChange={onChange}
          aria-label={`${folderName} ${spec.head}`}
        />
      </span>
    </Tip>
  )
}

/** 内建行的开关位 —— 不是「关」，是「这两个 gate 根本不看它」。 */
export function PrefNotApplicable({ kind }: { kind: 'notify' | 'ai' }): React.ReactElement {
  const what = kind === 'notify' ? '通知走全局规则（重要度 + 动作类型）' : 'AI 分类恒开'
  return (
    <Tip
      label={`内建邮箱不受 per-folder 开关约束：${what}`}
      className={`${COL_TOGGLE} shrink-0 justify-center`}
    >
      <span
        className="grid h-[26px] w-[32px] place-items-center text-meta text-ink-fg-3"
        aria-label="不适用"
      >
        —
      </span>
    </Tip>
  )
}

/* ── 列头 —— 结构与行逐字同构，靠同一套列宽对齐 ─────────────────── */

export function PrefColumnHeader({
  globalNotify,
  globalAi
}: {
  globalNotify: boolean
  globalAi: boolean
}): React.ReactElement {
  const head = (kind: 'notify' | 'ai', globalOn: boolean): React.ReactElement => {
    const spec = TOGGLE_SPEC[kind]
    return (
      <Tip
        label={
          globalOn
            ? `${spec.head}：${spec.fallback}`
            : `${kind === 'notify' ? '飞书通知' : 'AI 分类'}总闸关着 —— 这一列当前不生效`
        }
        className={`${COL_TOGGLE} shrink-0 justify-center`}
      >
        <span
          className={[
            'text-meta',
            globalOn ? 'text-ink-fg-2' : 'text-ink-fg-3 line-through decoration-ink-fg-3/60'
          ].join(' ')}
        >
          {spec.head}
        </span>
      </Tip>
    )
  }

  return (
    <div
      className="flex items-center gap-2.5 pb-1 pr-3 text-meta text-ink-fg-3"
      style={{ paddingLeft: GRIP_GUTTER }}
      aria-hidden="true"
    >
      <span className="min-w-0 flex-1">图标 · 名称</span>
      {head('notify', globalNotify)}
      {head('ai', globalAi)}
      <span className={`${COL_COUNT} shrink-0 text-right`}>邮件</span>
      <span className={`${COL_INDEX} shrink-0`} />
    </div>
  )
}

/* ── 内建邮箱行 —— 不可拖、不可移除、图标不可换 ─────────────────── */

export function BuiltinLockSlot(): React.ReactElement {
  return (
    <Tip label="内建邮箱：位置固定，不能重排也不能移除；图标写死在 Sidebar.tsx" className="shrink-0">
      <span className="grid h-7 w-9 place-items-center text-ink-fg-3">
        <Lock size={13} strokeWidth={1.75} aria-hidden="true" />
      </span>
    </Tip>
  )
}
