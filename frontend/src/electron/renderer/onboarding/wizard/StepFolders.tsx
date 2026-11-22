// Onboarding step 3.5 (davmail-only): Custom folder selection.

import { useEffect, useRef, useState } from 'react'

import type { FolderInfo, FolderTreeNode } from '@shared/api/types'

import { Banner, Icon, WizFooter } from '../components'
import * as ipc from '../ipc'
import { collectSystemImapNames } from './types'

/* ─── Step 3.5 · 选择要同步的文件夹 (多文件夹同步 P4, davmail-only) ──────────────
   邮箱配置 (StepConfig commitConfig 已起后端) 之后插一步。临摹 wiz-body 版式 +
   FolderPicker 的树渲染 (缩进 + 展开/收起)。系统文件夹默认选中并锁定; 自定义默认全
   不选; 大文件夹轻量提示。底部 [跳过](弱) + [继续](coral), 强调可跳过 —— 整步可跳过
   (拉取失败 / 非 davmail / 用户不想选), 不阻塞 onboarding。此步不放管理操作 (保持简洁)。

   注: onboarding 是 Chinese-only 移植原型 (全部 7 步硬编码中文, 无 i18n), 本步保持同一
   约定以维持隔离一致性; FolderPicker (设置页) 才走双语 t()。 */

const ONBOARDING_LARGE_FOLDER_THRESHOLD = 1000

interface OnboardingFolderRowProps {
  node: FolderTreeNode
  depth: number
  selected: ReadonlySet<string>
  expanded: ReadonlySet<string>
  onToggle: (imapName: string) => void
  onToggleExpand: (imapName: string) => void
}

/** onboarding 文件夹树单行 — 临摹 FolderPicker.FolderRow, 但不含管理 ⋯ 菜单 (引导简洁)。 */
function OnboardingFolderRow({
  node,
  depth,
  selected,
  expanded,
  onToggle,
  onToggleExpand
}: OnboardingFolderRowProps): React.JSX.Element {
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.imap_name)
  const isChecked = selected.has(node.imap_name)
  const isLarge = (node.message_count ?? 0) > ONBOARDING_LARGE_FOLDER_THRESHOLD
  const indentPx = depth * 22

  return (
    <>
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ paddingLeft: `${12 + indentPx}px`, opacity: node.is_system ? 0.75 : 1 }}
      >
        {node.is_system ? (
          <span
            className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-[4px] bg-ink-3 border border-ink-border-soft text-ink-fg-3"
            title="系统文件夹 · 默认同步"
          >
            <Icon name="lock" size={9} />
          </span>
        ) : (
          <button
            type="button"
            role="checkbox"
            aria-checked={isChecked}
            aria-label={node.display_name}
            onClick={() => onToggle(node.imap_name)}
            className={`shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-[4px] border transition-colors ${
              isChecked
                ? 'border-transparent text-ink-fg'
                : 'bg-transparent border-ink-border hover:border-ink-fg-2'
            }`}
            style={
              isChecked
                ? { background: 'rgb(var(--c-accent))', color: 'rgb(var(--c-accent-fg))' }
                : undefined
            }
          >
            {isChecked ? <Icon name="check" size={11} sw={3} /> : null}
          </button>
        )}

        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.imap_name)}
            aria-label={isOpen ? '收起' : '展开'}
            aria-expanded={isOpen}
            className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded text-ink-fg-2 hover:text-ink-fg"
          >
            <Icon
              name="chevron"
              size={12}
              style={{
                transition: 'transform var(--dur-fast, 120ms)',
                transform: isOpen ? 'rotate(90deg)' : undefined
              }}
            />
          </button>
        ) : (
          <span className="shrink-0 w-4 h-4" aria-hidden="true" />
        )}

        <span className="text-ink-fg-2 shrink-0">
          <Icon
            name={
              node.is_system
                ? node.special_use === '\\sent'
                  ? 'send'
                  : node.imap_name.toUpperCase() === 'INBOX'
                    ? 'inbox'
                    : 'folder'
                : 'folder'
            }
            size={14}
          />
        </span>
        <span className="flex-1 min-w-0 truncate text-[13px] text-ink-fg">{node.display_name}</span>

        {typeof node.message_count === 'number' ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-fg-2">
            {node.message_count.toLocaleString('en-US')}
          </span>
        ) : null}

        {isLarge && !node.is_system ? (
          <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] font-mono bg-warn/15 text-warn">
            <Icon name="clock" size={10} /> 首次同步较慢
          </span>
        ) : null}

        {node.is_system ? (
          <span className="shrink-0 text-[11px] text-ink-fg-3">默认 · 已锁定</span>
        ) : null}
      </div>

      {hasChildren && isOpen
        ? node.children.map((child) => (
            <OnboardingFolderRow
              key={child.imap_name}
              node={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onToggle={onToggle}
              onToggleExpand={onToggleExpand}
            />
          ))
        : null}
    </>
  )
}

export interface StepFoldersProps {
  /** 仅 davmail 渲染本步 (OnboardingRoot 在 applescript 时跳过)。 */
  onNext: () => void
  onBack: () => void
  /** 强调可跳过: 跳过 = 仅同步收件箱/发件箱, 不写白名单。 */
  onSkip: () => void
}

export function StepFolders({ onNext, onBack, onSkip }: StepFoldersProps): React.JSX.Element {
  // null = 加载中; [] 视情况为空态; 'gated'/'error' 走可跳过降级。
  const [tree, setTree] = useState<FolderTreeNode[] | null>(null)
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'gated' | 'error'>('loading')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const alive = useRef(true)
  // ~8s hang 兜底 (twin of StepFDA/StepConfig): discover 走 IMAP LIST 可能 hang →
  // 降级到 error 态 (仍可跳过), 不把用户钉死在 spinner。
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    alive.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!alive.current) return
      setPhase((p) => (p === 'loading' ? 'error' : p))
    }, 8000)
    const clearTimer = (): void => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
    // counts:false (issue #45) — 大邮箱逐文件夹 STATUS 分钟级, 带计数必超上面 8s
    // 兜底把本步钉死在 error 态; 树选择不依赖计数, count 缺失渲染已 null-safe。
    void ipc
      .discoverFolders(false)
      .then((res) => {
        if (!alive.current) return
        setFolders(res.folders)
        setTree(res.tree)
        // 系统文件夹默认选中并锁定; 自定义默认全不选 (whitelist 在 onboarding 不预选)。
        setSelected(collectSystemImapNames(res.folders))
        setPhase('ready')
      })
      .catch((e: unknown) => {
        if (!alive.current) return
        const code = (e as { code?: string } | null)?.code
        // 非 davmail 后端 (E_INVALID_ARG) → 门控态 (理论上 applescript 不渲染本步, 兜底)。
        setPhase(code === 'E_INVALID_ARG' ? 'gated' : 'error')
      })
      .finally(clearTimer)
    return () => {
      alive.current = false
      clearTimer()
    }
  }, [])

  const toggle = (imapName: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(imapName)) next.delete(imapName)
      else next.add(imapName)
      return next
    })

  const toggleExpand = (imapName: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(imapName)) next.delete(imapName)
      else next.add(imapName)
      return next
    })

  // 「继续」: 把已选的自定义文件夹 (排除系统) 存白名单, 然后进 StepSync。
  // 系统文件夹由后端 SYNC_MAILBOXES 处理, 不进 SYNC_FOLDERS 白名单。
  const proceed = (): void => {
    const systemSet = collectSystemImapNames(folders)
    const custom = Array.from(selected).filter((n) => !systemSet.has(n))
    // 没有自定义勾选 = 等价跳过, 但仍显式写空白名单以收敛状态。
    setSaving(true)
    void ipc
      .setFolderWhitelist(custom)
      .catch(() => undefined) // 写失败不阻塞 onboarding (用户稍后可在设置里改)
      .finally(() => {
        if (!alive.current) return
        setSaving(false)
        onNext()
      })
  }

  const customCount = tree
    ? folders.filter((f) => !f.is_system && selected.has(f.imap_name)).length
    : 0

  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step · 文件夹</div>
        <h1 className="wiz-h1">选择要同步的文件夹</h1>
        <p className="wiz-lede">
          勾选要同步进 MailAgent 的文件夹，邮件将享受 AI 分类、Notion 同步等完整能力。
          可稍后在「设置 → 同步」修改。
        </p>

        {phase === 'loading' && (
          <div className="ds-card ds-card-pad mt-6 flex items-center justify-center gap-2 text-ink-fg-2">
            <Icon name="refresh" size={15} cls="spin" /> 正在拉取文件夹…
          </div>
        )}

        {phase === 'gated' && (
          <div className="mt-6">
            <Banner kind="info" icon="folder">
              多文件夹同步仅在 DavMail 后端可用。当前后端无需选择文件夹，点「继续」即可。
            </Banner>
          </div>
        )}

        {phase === 'error' && (
          <div className="mt-6">
            <Banner kind="warn" icon="alert">
              暂时无法拉取文件夹列表（可能是 DavMail 桥尚未就绪）。可先「跳过」，稍后在「设置 →
              同步」里随时勾选要同步的文件夹。
            </Banner>
          </div>
        )}

        {phase === 'ready' && tree && tree.length === 0 && (
          <div className="mt-6">
            <Banner kind="info" icon="folder">
              你的邮箱里暂未发现收件箱 / 发件箱以外的文件夹。可直接「继续」，稍后在设置里随时调整。
            </Banner>
          </div>
        )}

        {phase === 'ready' && tree && tree.length > 0 && (
          <>
            <div className="ds-card mt-6 overflow-hidden">
              <div className="max-h-72 overflow-y-auto scrollbar-thin divide-y divide-ink-border-soft/60">
                {tree.map((node) => (
                  <OnboardingFolderRow
                    key={node.imap_name}
                    node={node}
                    depth={0}
                    selected={selected}
                    expanded={expanded}
                    onToggle={toggle}
                    onToggleExpand={toggleExpand}
                  />
                ))}
              </div>
            </div>
            <p className="text-[12px] text-ink-fg-2 mt-3 font-mono">
              已选 {customCount} 个自定义文件夹（收件箱 / 发件箱始终同步）。
            </p>
          </>
        )}
      </div>
      <WizFooter
        onBack={saving ? null : onBack}
        secondary={
          <button
            className="btn-link"
            onClick={() => {
              onSkip()
              onNext()
            }}
            disabled={saving}
          >
            跳过（仅同步收件箱 / 发件箱）
          </button>
        }
        onNext={proceed}
        nextLabel={saving ? '保存中…' : '继续'}
        busy={saving}
      />
    </>
  )
}
