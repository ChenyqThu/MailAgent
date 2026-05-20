// Sprint 11 V1.4 — DESIGN.md §2.11 — Account dropdown anchored under the
// nav-shell header row. V1 surfaces a single derived account + an
// `+ 添加账户...` ghost row that routes to /settings. The JSX skeleton is
// shaped so that when the backend grows a `mail_accounts` IPC, only the
// row-rendering loop needs to change — the popover frame, dismiss
// behaviour, and animation stay the same.

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import type { DerivedAccount } from '@shared/lib/account'

interface AccountSwitcherPopoverProps {
  account: DerivedAccount
  onClose: () => void
  onAddAccount: () => void
  /** Optional anchor ref — clicks inside the anchor don't dismiss the
   *  popover (the trigger toggles open/closed on its own). */
  anchorRef?: React.RefObject<HTMLElement | null>
}

export function AccountSwitcherPopover({
  account,
  onClose,
  onAddAccount,
  anchorRef
}: AccountSwitcherPopoverProps): React.ReactElement {
  const { t } = useTranslation()
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target)) return
      if (anchorRef?.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, anchorRef])

  return (
    <div
      ref={popoverRef}
      role="menu"
      aria-label={t('nav.account.tooltip', { email: account.localPart })}
      className={cn(
        'app-nav-account-popover glass-pop absolute z-50 left-2 right-2 top-[44px]',
        'rounded-lg border border-ink-border py-1'
      )}
    >
      <div
        data-active="true"
        role="menuitem"
        className={cn(
          'row row-selected flex items-center gap-1.5 px-2 py-1.5 rounded-md',
          'text-body bg-ink-4 text-ink-fg'
        )}
      >
        {account.badge && (
          <span
            className={cn(
              'text-micro font-mono px-1 py-[1px] rounded shrink-0',
              'bg-coral/15 border border-coral/30 text-ink-fg'
            )}
          >
            {account.badge}
          </span>
        )}
        <span className="flex-1 truncate">{account.localPart}</span>
      </div>
      <button
        type="button"
        onClick={onAddAccount}
        role="menuitem"
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md',
          'text-body text-ink-fg-2 italic',
          'hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast'
        )}
      >
        <Plus size={13} strokeWidth={2} className="shrink-0" />
        <span>{t('nav.account.add')}</span>
      </button>
    </div>
  )
}
