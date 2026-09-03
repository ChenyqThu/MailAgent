// 添加挂载文件夹（design §8.2；mockup D1 ①②③）：系统目录对话框 → 确认面板 → `POST /library/mounts`。
//
// 两处入口共用它：二级栏树底部的「添加文件夹」与设置页挂载区的同名按钮，各自经
// `useAddMountFlow` 拿到这个面板。
//
// 🔴 **拒挂规则一律由服务端强制**（`/`、`~`、`~/Library`、DATA_ROOT、与已有挂载嵌套、超 2 万文件、
// label 重名），前端不复制一份判断 —— 复制的那份迟早与服务端漂开，而漂开的方向恒是「前端放行、
// 服务端拒」或反过来「前端拦住了合法目录」。失败时原样显示服务端给的 message + hint。
//
// 🔴 这里显示的绝对路径是用户**刚刚在系统对话框里亲手选中**的那一个，不是从库里读回来的；
// 库里存的绝对路径只在设置页的挂载列表出现（design §8.2）。

import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Input } from '@shared/components/ui/input'
import { SegmentedControl } from '@shared/components/ui/segmented'
import type { LibraryMountMode } from '@shared/libraryConstants'

import { mountErrorText, mountLabelFromPath, useMountMutations } from './mountHooks'
import { Notice } from './parts'

interface Props {
  /** 用户刚在系统对话框里选中的目录。 */
  absPath: string
  onClose(): void
  onAdded(): void
}

export function AddMountDialog({ absPath, onClose, onAdded }: Props): ReactElement {
  const { t } = useTranslation()
  const mounts = useMountMutations()
  const [label, setLabel] = useState(() => mountLabelFromPath(absPath))
  const [mode, setMode] = useState<LibraryMountMode>('rw')
  const [refused, setRefused] = useState<string | null>(null)

  const trimmed = label.trim()

  async function submit(): Promise<void> {
    setRefused(null)
    try {
      await mounts.add(absPath, trimmed, mode)
      onAdded()
    } catch (err) {
      setRefused(mountErrorText(err))
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="w-[560px]">
        <DialogHeader>
          <DialogTitle>{t('library.mount.add')}</DialogTitle>
          <DialogDescription>{t('library.mount.pickHint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div
            data-testid="library-mount-picked-path"
            className="break-all rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-3 py-2 font-mono text-meta text-ink-fg-1"
          >
            {absPath}
          </div>

          <label className="block">
            <span className="mb-1 block text-aux text-ink-fg-1">{t('library.mount.label')}</span>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            <span className="mt-1 block font-mono text-meta text-ink-fg-3">
              @{trimmed === '' ? mountLabelFromPath(absPath) : trimmed}
            </span>
          </label>

          <div>
            <span className="mb-1 block text-aux text-ink-fg-1">{t('library.mount.mode')}</span>
            <SegmentedControl<LibraryMountMode>
              value={mode}
              onChange={setMode}
              ariaLabel={t('library.mount.mode')}
              options={[
                { value: 'ro', label: t('library.mount.ro') },
                { value: 'rw', label: t('library.mount.rw') }
              ]}
            />
            <p className="mt-1 text-meta leading-relaxed text-ink-fg-3">
              {t(mode === 'ro' ? 'library.mount.roHint' : 'library.mount.rwHint')}
            </p>
          </div>

          <p className="text-meta text-ink-fg-3">{t('library.mount.skipHint')}</p>

          {refused !== null ? (
            <Notice tone="fail">
              <span className="font-medium">{t('library.mount.refusedTitle')}</span>
              <span className="ml-1.5 break-all">{refused}</span>
            </Notice>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('library.actions.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={mounts.busy || trimmed === ''}
            onClick={() => void submit()}
          >
            {t('library.mount.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
