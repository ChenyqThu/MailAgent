// S2 W4b — Skill 安装（skill pack supply chain）subsection
//
// Two-phase install UI over the W2 Python endpoints: fetch → server-rendered
// preview (quarantine facts) → owner confirm (echoes packageHash + files; the
// backend re-hashes and 409s on TOCTOU). Per-pack management: write-only
// secrets (W3) + plaintext config.json + full-cleanup uninstall. Self-gates on
// /chat/config.skillInstallEnabled (MAILAGENT_OPENNESS_SKILL_INSTALL, default
// OFF) — flag-off renders nothing and the builtin SkillsSection is unchanged.

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, KeyRound, Loader2, Package, Settings2, Trash2 } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { SkillPackPreview, SkillSecretMeta, SkillSummary } from '@shared/api/types'
import { Button } from '@shared/components/ui/button'
import { Input } from '@shared/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'

import { Section } from '../parts/Section'
import { fetchSkillInstallEnabled } from './shared'

/** Supply-chain confirm only ever writes these source types (URL/zip → 'skill_pack',
 *  local dir import → 'local_folder'); builtin / document / mcp rows are NOT packs. */
const PACK_SOURCE_TYPES = new Set(['skill_pack', 'local_folder'])

const PACK_SOURCE_LABELS: Record<string, string> = {
  skill_pack: 'skill 包',
  local_folder: '本地目录'
}

/** Structured ApiError → user-facing one-liner（code + message + hint）。 */
function apiErrText(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown; hint?: unknown }
  const code = typeof e?.code === 'string' ? e.code : null
  const msg = typeof e?.message === 'string' ? e.message : String(err)
  const base = code ? `${code}: ${msg}` : msg
  return typeof e?.hint === 'string' && e.hint ? `${base}（${e.hint}）` : base
}

/** confirm 的 TOCTOU 拒绝（quarantine 内容在预览后被改动）→ 专用明示文案而非裸 toast。 */
function isHashMismatch(err: unknown): boolean {
  const e = err as { code?: unknown; httpStatus?: unknown }
  return e?.code === 'E_PACK_HASH_MISMATCH' || e?.httpStatus === 409
}

function formatIsoShort(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/** 安装对话框：输入步（URL / 本地路径二选一）→ 预览步（服务端事实渲染）→ 确认安装。 */
function SkillInstallDialog({
  open,
  onOpenChange,
  onInstalled
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInstalled: () => void
}): React.ReactElement {
  const api = useMailApi()

  const [source, setSource] = React.useState<'url' | 'local'>('url')
  const [inputValue, setInputValue] = React.useState('')
  const [fetching, setFetching] = React.useState(false)
  const [preview, setPreview] = React.useState<SkillPackPreview | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const [staleError, setStaleError] = React.useState(false)

  function reset(): void {
    setSource('url')
    setInputValue('')
    setFetching(false)
    setPreview(null)
    setConfirming(false)
    setStaleError(false)
  }

  function handleOpenChange(next: boolean): void {
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleFetch(): Promise<void> {
    const value = inputValue.trim()
    if (!value) return
    setFetching(true)
    setStaleError(false)
    try {
      const p = await api.chat.fetchSkillPack(
        source === 'url' ? { sourceUrl: value } : { localPath: value }
      )
      setPreview(p)
    } catch (err) {
      toastError('获取预览失败', apiErrText(err))
    } finally {
      setFetching(false)
    }
  }

  async function handleConfirm(): Promise<void> {
    if (!preview) return
    setConfirming(true)
    try {
      // 透传 preview 的 packageHash + files（owner 批准的事实）；后端重算 hash 比对，
      // 预览后被改动 → 409 E_PACK_HASH_MISMATCH（下面明示并要求重新 fetch）。
      const result = await api.chat.confirmSkillPack({
        quarantineId: preview.quarantineId,
        expectedPackageHash: preview.packageHash,
        expectedFiles: preview.files
      })
      toastSuccess(
        `已安装 ${result.name}`,
        preview.secretNames.length > 0
          ? `该 skill 声明了 ${preview.secretNames.length} 个密钥（${preview.secretNames.join('、')}），请在其「配置」里设置。`
          : undefined
      )
      onInstalled()
      handleOpenChange(false)
    } catch (err) {
      if (isHashMismatch(err)) {
        // TOCTOU：quarantine 在预览→确认之间被改动。丢弃旧预览，要求重新 fetch。
        setStaleError(true)
        setPreview(null)
      } else {
        toastError('安装失败', apiErrText(err))
      }
    } finally {
      setConfirming(false)
    }
  }

  const fileEntries = preview ? Object.entries(preview.files) : []

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>安装 Skill</DialogTitle>
          <DialogDescription>
            两段式安装：先获取包预览，人工审阅文件清单、密钥声明与 SKILL.md
            节选，确认无误后再安装。第三方内容未经验签，请谨慎审阅。
          </DialogDescription>
        </DialogHeader>

        {staleError && (
          <div className="rounded-md border border-fail/30 bg-fail/10 px-2.5 py-1.5 text-aux text-fail">
            包内容在预览后被改动，已拒绝安装。请重新获取预览并再次审阅。
          </div>
        )}

        {!preview ? (
          <div className="space-y-3">
            <div className="flex items-center gap-1 rounded-md border border-ink-border-soft p-0.5 w-fit">
              {(
                [
                  ['url', 'URL'],
                  ['local', '本地路径']
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSource(key)}
                  className={[
                    'px-2.5 py-1 rounded text-aux transition-colors duration-fast',
                    source === key
                      ? 'bg-ink-3 text-ink-fg font-medium'
                      : 'text-ink-fg-2 hover:text-ink-fg'
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={
                source === 'url'
                  ? 'https://example.com/skill.zip'
                  : '/path/to/skill.zip 或 skill 目录'
              }
              spellCheck={false}
            />
            <DialogFooter>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleFetch()}
                disabled={fetching || inputValue.trim() === ''}
              >
                {fetching ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {fetching ? '获取中…' : '获取预览'}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-ink-border-soft divide-y divide-ink-border-soft text-aux">
              <div className="px-3 py-2 flex items-center gap-2">
                <Package className="size-3.5 shrink-0 text-ink-fg-2" />
                <span className="font-medium text-ink-fg">
                  {preview.manifest.title ?? preview.manifest.name ?? '（未命名）'}
                </span>
                <span className="font-mono text-micro text-ink-fg-3">
                  {preview.manifest.name}
                  {preview.manifest.version ? ` · v${preview.manifest.version}` : ''}
                  {preview.manifest.type ? ` · ${preview.manifest.type}` : ''}
                </span>
              </div>
              {preview.manifest.description ? (
                <div className="px-3 py-2 text-ink-fg-2">{preview.manifest.description}</div>
              ) : null}
              <div className="px-3 py-2 space-y-1 text-aux">
                <div className="text-ink-fg-3">
                  来源：
                  <span className="font-mono break-all text-ink-fg-2">
                    {preview.sourceUri ?? '—'}
                  </span>
                </div>
                <div className="text-ink-fg-3">
                  包 hash：
                  <span className="font-mono break-all text-ink-fg-2" title={preview.packageHash}>
                    {preview.packageHash}
                  </span>
                </div>
                {preview.manifest.entryHint ? (
                  <div className="text-ink-fg-3">
                    入口提示：
                    <span className="font-mono text-ink-fg-2">{preview.manifest.entryHint}</span>
                  </div>
                ) : null}
              </div>
              <div className="px-3 py-2">
                <div className="text-aux text-ink-fg-3 mb-1">文件（{fileEntries.length} 个）</div>
                <div className="max-h-28 overflow-auto rounded bg-ink-bg-2 p-1.5 font-mono text-micro text-ink-fg-2 space-y-0.5">
                  {fileEntries.map(([path, sha]) => (
                    <div key={path} className="flex justify-between gap-3">
                      <span className="break-all">{path}</span>
                      <span className="text-ink-fg-3 shrink-0" title={sha}>
                        {sha.slice(0, 12)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="px-3 py-2">
                <div className="text-aux text-ink-fg-3 mb-1">声明密钥</div>
                {preview.secretNames.length === 0 ? (
                  <span className="text-aux text-ink-fg-3 italic">无</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {preview.secretNames.map((n) => (
                      <span
                        key={n}
                        className="inline-flex items-center gap-1 rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 font-mono text-micro text-ink-fg-2"
                      >
                        <KeyRound className="size-2.5" />
                        {n}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="px-3 py-2">
                <div className="text-aux text-ink-fg-3 mb-1">SKILL.md 节选（原文，未渲染）</div>
                {/* 第三方 untrusted 文本：纯文本 <pre> 展示，绝不渲染 markdown/HTML。
                    节选可能含 CJK → text-aux（no-cjk-in-mono-size 铁律）。 */}
                <pre className="max-h-40 overflow-auto rounded bg-ink-bg-2 p-2 font-mono text-aux text-ink-fg-2 whitespace-pre-wrap break-all leading-snug">
                  {preview.skillMdExcerpt.trim() !== '' ? (
                    preview.skillMdExcerpt
                  ) : (
                    <span className="italic text-ink-fg-3">（空）</span>
                  )}
                </pre>
              </div>
            </div>
            <DialogFooter>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPreview(null)}
                disabled={confirming}
              >
                返回
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleConfirm()}
                disabled={confirming}
              >
                {confirming ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {confirming ? '安装中…' : '确认安装'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** config.json 简单 JSON 文本编辑器（挂载时以 initial 一次性初始化，免同步 effect）。 */
function SkillConfigEditor({
  name,
  initial,
  onSaved
}: {
  name: string
  initial: string
  onSaved: () => void
}): React.ReactElement {
  const api = useMailApi()
  const [draft, setDraft] = React.useState(initial)
  const [jsonError, setJsonError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  async function handleSave(): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch (err) {
      setJsonError(`JSON 解析失败：${(err as Error).message}`)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setJsonError('必须是 JSON 对象（{ … }）')
      return
    }
    setJsonError(null)
    setSaving(true)
    try {
      await api.chat.putSkillConfig(name, parsed as Record<string, unknown>)
      toastSuccess('已保存配置')
      onSaved()
    } catch (err) {
      toastError('保存配置失败', apiErrText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
        spellCheck={false}
        className={[
          'w-full resize-y rounded-md border bg-ink-2 px-3 py-2',
          'font-mono text-aux text-ink-fg placeholder:text-ink-fg-3',
          'transition-colors duration-fast',
          'focus:outline-none focus:ring-2 focus:ring-coral/70 focus:border-coral/60',
          jsonError ? 'border-fail/50' : 'border-ink-border'
        ].join(' ')}
      />
      {jsonError && <div className="text-aux text-fail">{jsonError}</div>}
      <Button size="sm" variant="outline" onClick={() => void handleSave()} disabled={saving}>
        {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
        {saving ? '保存中…' : '保存配置'}
      </Button>
    </div>
  )
}

/** 单条已存密钥行：名 + 更新时间 + write-only 替换输入（PUT 后清空，永不回显值）+ 删除。 */
function SkillSecretRow({
  skillName,
  secret,
  onChanged
}: {
  skillName: string
  secret: SkillSecretMeta
  onChanged: () => void
}): React.ReactElement {
  const api = useMailApi()
  const [value, setValue] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  async function handleReplace(): Promise<void> {
    if (value === '') return
    setBusy(true)
    try {
      await api.chat.putSkillSecret(skillName, secret.name, value)
      setValue('') // write-only：保存即清空输入，永不回显
      toastSuccess(`已更新密钥 ${secret.name}`)
      onChanged()
    } catch (err) {
      toastError('更新密钥失败', apiErrText(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(): Promise<void> {
    setBusy(true)
    try {
      await api.chat.deleteSkillSecret(skillName, secret.name)
      toastSuccess(`已删除密钥 ${secret.name}`)
      onChanged()
    } catch (err) {
      toastError('删除密钥失败', apiErrText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-micro text-ink-fg break-all">{secret.name}</div>
        <div className="text-aux text-ink-fg-3">已设置 {formatIsoShort(secret.updatedAt)}</div>
      </div>
      <Input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="输入新值以替换"
        autoComplete="new-password"
        spellCheck={false}
        className="h-7 w-40 text-aux"
      />
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void handleReplace()}
        disabled={busy || value === ''}
      >
        保存
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void handleDelete()}
        disabled={busy}
        aria-label={`删除密钥 ${secret.name}`}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}

/** 一个已安装 pack 行：标题 + 来源 badge + 「配置」抽屉（密钥 write-only + config.json）+ 卸载确认。 */
function PackRow({
  skill,
  onChanged
}: {
  skill: SkillSummary
  onChanged: () => void
}): React.ReactElement {
  const api = useMailApi()
  const qc = useQueryClient()

  const [panel, setPanel] = React.useState<'none' | 'config' | 'uninstall'>('none')
  const [newName, setNewName] = React.useState('')
  const [newValue, setNewValue] = React.useState('')
  const [addingSecret, setAddingSecret] = React.useState(false)
  const [uninstalling, setUninstalling] = React.useState(false)

  // 配置抽屉与卸载确认共用：已存密钥 meta（只名 + 时间，永无值）。
  const { data: secrets } = useQuery<SkillSecretMeta[]>({
    queryKey: ['skillSecrets', skill.name],
    queryFn: () => api.chat.listSkillSecretMeta(skill.name),
    enabled: panel !== 'none'
  })

  const { data: config, isLoading: configLoading } = useQuery<Record<string, unknown>>({
    queryKey: ['skillConfig', skill.name],
    queryFn: () => api.chat.getSkillConfig(skill.name),
    enabled: panel === 'config',
    retry: false
  })

  const refetchSecrets = (): void => {
    void qc.invalidateQueries({ queryKey: ['skillSecrets', skill.name] })
  }

  async function handleAddSecret(): Promise<void> {
    const name = newName.trim()
    if (name === '' || newValue === '') return
    setAddingSecret(true)
    try {
      // secret 名合法性（env-regex + reserved deny）由后端校验；非法名 → E_INVALID_ARG toast。
      await api.chat.putSkillSecret(skill.name, name, newValue)
      setNewName('')
      setNewValue('') // write-only：保存即清空
      toastSuccess(`已设置密钥 ${name}`)
      refetchSecrets()
    } catch (err) {
      toastError('设置密钥失败', apiErrText(err))
    } finally {
      setAddingSecret(false)
    }
  }

  async function handleUninstall(): Promise<void> {
    setUninstalling(true)
    try {
      // 全清端点（行 + 目录 + 密钥），绝不走旧 DELETE /agent/skills/{name}。
      await api.chat.uninstallSkillPack(skill.name)
      toastSuccess(`已卸载 ${skill.name}`)
      onChanged()
    } catch (err) {
      toastError('卸载失败', apiErrText(err))
    } finally {
      setUninstalling(false)
    }
  }

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <Package className="size-3.5 shrink-0 text-ink-fg-2" />
        <div className="min-w-0 flex-1">
          <span className="text-aux font-medium text-ink-fg">{skill.title}</span>
          <span className="ml-2 font-mono text-micro text-ink-fg-3">{skill.name}</span>
        </div>
        <span className="inline-flex items-center rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro text-ink-fg-2 shrink-0">
          {PACK_SOURCE_LABELS[skill.sourceType] ?? skill.sourceType}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPanel(panel === 'config' ? 'none' : 'config')}
          aria-label={`配置 ${skill.name}`}
        >
          <Settings2 className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPanel(panel === 'uninstall' ? 'none' : 'uninstall')}
          aria-label={`卸载 ${skill.name}`}
        >
          <Trash2 className="size-3.5 text-fail" />
        </Button>
      </div>

      {panel === 'uninstall' && (
        <div className="rounded-md border border-fail/30 bg-fail/10 px-3 py-2 space-y-2">
          <div className="text-aux text-fail">
            将删除该 skill 的落盘目录、注册行，并清除其全部已存密钥。此操作不可撤销。
          </div>
          <div className="text-aux text-ink-fg-2">
            {secrets == null ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin" />
                正在载入密钥清单…
              </span>
            ) : secrets.length === 0 ? (
              '（无已存密钥）'
            ) : (
              <span className="flex flex-wrap items-center gap-1.5">
                将删除密钥：
                {secrets.map((s) => (
                  <span
                    key={s.name}
                    className="inline-flex items-center gap-1 rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 font-mono text-micro text-ink-fg-2"
                  >
                    <KeyRound className="size-2.5" />
                    {s.name}
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="border-fail/50 text-fail hover:bg-fail/10"
              onClick={() => void handleUninstall()}
              disabled={uninstalling}
            >
              {uninstalling ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {uninstalling ? '卸载中…' : '确认卸载'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPanel('none')}
              disabled={uninstalling}
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {panel === 'config' && (
        <div className="rounded-md border border-ink-border-soft px-3 py-2 space-y-3">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-aux text-ink-fg">
              <KeyRound className="size-3.5 text-ink-fg-2" />
              密钥
            </div>
            <div className="text-aux text-ink-fg-3">
              密钥只写不读：保存后不回显值，仅显示名称与更新时间。值加密存储，脚本执行时注入环境变量。
            </div>
            {secrets == null ? (
              <div className="flex items-center gap-2 text-aux text-ink-fg-2">
                <Loader2 className="size-3 animate-spin" />
                加载中…
              </div>
            ) : secrets.length === 0 ? (
              <div className="text-aux text-ink-fg-3 italic">尚无已存密钥。</div>
            ) : (
              <div className="space-y-2">
                {secrets.map((s) => (
                  <SkillSecretRow
                    key={s.name}
                    skillName={skill.name}
                    secret={s}
                    onChanged={refetchSecrets}
                  />
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="密钥名（如 MY_API_KEY）"
                spellCheck={false}
                className="h-7 w-44 font-mono text-aux"
              />
              <Input
                type="password"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="值"
                autoComplete="new-password"
                spellCheck={false}
                className="h-7 flex-1 text-aux"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void handleAddSecret()}
                disabled={addingSecret || newName.trim() === '' || newValue === ''}
              >
                {addingSecret ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                添加
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="text-aux text-ink-fg">config.json（非敏感配置，明文，与脚本共读）</div>
            {configLoading || config == null ? (
              <div className="flex items-center gap-2 text-aux text-ink-fg-2">
                <Loader2 className="size-3 animate-spin" />
                加载中…
              </div>
            ) : (
              <SkillConfigEditor
                name={skill.name}
                initial={JSON.stringify(config, null, 2)}
                onSaved={() => void qc.invalidateQueries({ queryKey: ['skillConfig', skill.name] })}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Skill 安装（supply chain）管理区。self-gates on skillInstallEnabled（default OFF → null，
 *  字节级不渲染；builtin SkillsSection 在 flag off 时行为零变化）。 */
export function SkillPacksSection(): React.ReactElement | null {
  const api = useMailApi()
  const qc = useQueryClient()

  const { data: enabled } = useQuery<boolean>({
    queryKey: ['chat', 'config', 'skillInstallEnabled'],
    queryFn: fetchSkillInstallEnabled,
    staleTime: 30_000,
    retry: false
  })

  // 与 SkillsSection 共享 ['skills'] 缓存（同一 resolved 列表），此处只筛 pack 安装行。
  const { data: skills } = useQuery<SkillSummary[]>({
    queryKey: ['skills'],
    queryFn: () => api.chat.listSkills(),
    enabled: enabled === true
  })

  const [installOpen, setInstallOpen] = React.useState(false)

  // flag-off (false / undefined) → byte-level no-render (DOM has no section).
  if (!enabled) return null

  const packs = (skills ?? []).filter((s) => PACK_SOURCE_TYPES.has(s.sourceType))

  const onChanged = (): void => {
    void qc.invalidateQueries({ queryKey: ['skills'] })
  }

  return (
    <Section
      title="Skill 安装"
      helper="从 URL 或本地路径安装第三方 skill 包。两段式：先获取预览、人工审阅包内容与声明，再确认安装。已安装的 skill 会出现在上方技能列表（启用/停用），密钥与配置在下方逐项管理。"
    >
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-aux text-ink-fg-2">
          {packs.length === 0 ? '还没有安装的 skill 包。' : `已安装 ${packs.length} 个 skill 包。`}
        </span>
        <Button size="sm" variant="outline" onClick={() => setInstallOpen(true)}>
          <Download className="mr-1.5 size-3.5" />
          安装 skill
        </Button>
      </div>
      {packs.map((skill) => (
        <PackRow key={skill.name} skill={skill} onChanged={onChanged} />
      ))}
      <SkillInstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onInstalled={onChanged}
      />
    </Section>
  )
}
