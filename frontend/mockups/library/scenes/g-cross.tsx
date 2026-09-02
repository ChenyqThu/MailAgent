// G 跨模块（design §9.2 §9.4 §9.5，L15）

import * as React from 'react'
import { Check, FileDown, Link2, Paperclip, Search, Sparkles, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { Button } from '@shared/components/ui/button'
import { Checkbox } from '@shared/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'

import { fileById, HITS, MATTERS, RECENT_FILE_IDS } from '../fixtures'
import { S } from '../strings'
import { Demo, Notice, Pill, SceneHead, StateBar, StateSwitch, Toast } from '../parts/kit'
import { AppWindow, ContentHeader, DockPlaceholder } from '../parts/shell'
import { LibraryTree } from '../parts/tree'
import { FolderPicker } from '../parts/preview'
import { displayName, toneOf } from '../parts/fileMeta'
import { HitRow } from './e-search'

/* ── 共享：LibraryPickerDialog（design §9.5 的新组件） ──────────── */

function LibraryPicker({
  open,
  onOpenChange,
  title,
  confirmLabel,
  onConfirm
}: {
  open: boolean
  onOpenChange(v: boolean): void
  title: string
  confirmLabel: string
  onConfirm(ids: number[]): void
}): React.ReactElement {
  const [tab, setTab] = React.useState<'tree' | 'search'>('tree')
  const [folder, setFolder] = React.useState('agent-docs/notes')
  const [picked, setPicked] = React.useState<number[]>([])
  const [q, setQ] = React.useState('客单价')

  const inFolder = RECENT_FILE_IDS.map((id) => fileById(id)!).filter(
    (f) => f && f.parent_path === folder
  )
  const rows = tab === 'tree' ? inFolder : HITS.map((h) => fileById(h.fileId)!).filter(Boolean)

  const toggle = (id: number): void =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-rows-[auto_auto_1fr_auto] max-h-[84vh] w-[660px] max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            外壳与多选 / 底部条抄 MatterLinkResourceModal（仓里唯一的多选资源选择器），
            内容区换成「树 + 搜索」两 tab。🔴 不抄它的 expectedVersion / undo-toast 乐观并发协议 ——
            那是 matters 域的，资料库有自己的 expected_hash CAS。
          </DialogDescription>
        </DialogHeader>

        <SegmentedControl
          value={tab}
          onChange={setTab}
          ariaLabel="选择方式"
          options={[
            { value: 'tree', label: S.picker.tabTree },
            { value: 'search', label: S.picker.tabSearch }
          ]}
        />

        <div className="min-h-0 overflow-y-auto pr-1 scrollbar-thin">
          {tab === 'tree' ? (
            <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-3">
              <FolderPicker value={folder} onChange={setFolder} />
              <div className="space-y-1">
                {rows.length === 0 ? (
                  <div className="px-2 py-6 text-center text-meta text-ink-fg-3">
                    这个文件夹里没有最近用过的文件。
                  </div>
                ) : (
                  rows.map((f) => (
                    <PickRow key={f.id} id={f.id} picked={picked} onToggle={toggle} />
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="flex h-8 items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5">
                <Search size={13} strokeWidth={2} aria-hidden className="shrink-0 text-ink-fg-3" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={S.search.placeholder}
                  className="min-w-0 flex-1 bg-transparent text-aux text-ink-fg outline-none placeholder:text-ink-fg-3"
                />
              </label>
              <div className="space-y-1">
                {rows.map((f) => (
                  <PickRow key={f.id} id={f.id} picked={picked} onToggle={toggle} />
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="items-center justify-start gap-3">
          <span className="text-aux text-ink-fg-3">{S.picker.selectedCount(picked.length)}</span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="ml-auto rounded-[var(--r-ctl)] px-3 py-2 text-aux hover:bg-ink-3"
          >
            {S.act.cancel}
          </button>
          <button
            type="button"
            disabled={picked.length === 0}
            onClick={() => {
              onConfirm(picked)
              onOpenChange(false)
              setPicked([])
            }}
            className="inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] bg-coral/100 px-4 py-2 text-aux font-medium text-accent-fg disabled:opacity-50"
          >
            <Link2 size={13} aria-hidden />
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PickRow({
  id,
  picked,
  onToggle
}: {
  id: number
  picked: number[]
  onToggle(id: number): void
}): React.ReactElement {
  const f = fileById(id)!
  const tone = toneOf(f)
  const I = tone.Icon
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--r-card)] border border-ink-border bg-ink-2/60 px-3 py-2">
      <Checkbox
        checked={picked.includes(id)}
        onCheckedChange={() => onToggle(id)}
        className="mt-0.5"
      />
      <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded', tone.bg)}>
        <I size={11} strokeWidth={2} className={tone.text} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-aux text-ink-fg">{displayName(f)}</span>
        <span className="mt-0.5 block truncate font-mono text-micro text-ink-fg-3">
          {f.rel_path}
        </span>
      </span>
    </label>
  )
}

/* ── G1 事项 ───────────────────────────────────────────────────── */

export function G1(): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [toast, setToast] = React.useState<string | null>(null)
  const [proposalState, setProposalState] = React.useState<'pending' | 'accepted' | 'ignored'>(
    'pending'
  )

  const linked = [fileById(302)!, fileById(101)!]

  return (
    <>
      <StateBar>
        <StateSwitch
          label="agent 提案"
          value={proposalState}
          options={[
            { value: 'pending', label: '未确认' },
            { value: 'accepted', label: '已确认' },
            { value: 'ignored', label: '已忽略' }
          ]}
          onChange={(v) => setProposalState(v as typeof proposalState)}
        />
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="G1"
          title="事项：第四 tab「资料库」+ 资料区 + agent 提案"
          design="§9.2 §9.5"
          note="关联键 resource(provider='mailagent', kind='file', external_key='library:{id}')，与邮件附件 attachment:{id} 同一命名空间靠前缀区分。三条入口安全姿态各异：人手动关联 / 事项对话里 matter_resource_mutate（零改动）/ 跟进 run 提案（进「未确认的 agent 建议」由人确认）。🔴 uq_resource_provider_key 是 (provider, external_key) 不含 kind。"
        />

        <div className="grid max-w-[900px] grid-cols-2 gap-4">
          <Demo title="事项详情的「资料」区" hint="库文件与邮件附件用不同图标">
            <div className="space-y-1.5">
              {linked.map((f) => {
                const tone = toneOf(f)
                const I = tone.Icon
                return (
                  <div
                    key={f.id}
                    className="flex items-start gap-2.5 rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-3 py-2"
                  >
                    <span
                      className={cn(
                        'mt-0.5 grid size-6 shrink-0 place-items-center rounded border',
                        tone.bg,
                        tone.border
                      )}
                    >
                      <I size={12} strokeWidth={2} className={tone.text} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 truncate text-aux text-ink-fg">
                          {displayName(f)}
                        </span>
                        <Pill tone="accent">资料库</Pill>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-micro text-ink-fg-3">
                        library:{f.id} · {f.rel_path}
                      </div>
                      <div className="mt-1 line-clamp-2 text-meta leading-5 text-ink-fg-2">
                        {(f.body ?? '')
                          .replace(/[#>\-*`|]/g, '')
                          .trim()
                          .slice(0, 90)}
                        …
                      </div>
                    </div>
                  </div>
                )
              })}

              <div className="flex items-start gap-2.5 rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-3 py-2">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded border border-ink-border bg-ink-4 text-ink-fg-2">
                  <Paperclip size={12} strokeWidth={2} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-aux text-ink-fg">合同扫描件.pdf</span>
                    <Pill tone="ink">邮件附件</Pill>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-micro text-ink-fg-3">
                    attachment:9182
                  </div>
                </div>
              </div>

              <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
                <Link2 size={13} aria-hidden />
                关联资料
              </Button>
            </div>
            <div className="mt-2 text-meta leading-relaxed text-ink-fg-3">
              挂库文件时 <code className="font-mono">sum</code> 默认取 frontmatter.summary，
              缺省取抽取文本首 300 字；<code className="font-mono">metadata.cached_excerpt</code>{' '}
              填前 2000 字 —— 于是已关联的库文件自然进 context_snapshot 的资料投影，零新增注入路径。
            </div>
          </Demo>

          <Demo title="「未确认的 agent 建议」里的库文件提案" hint="跟进 run 提议挂资料，人确认">
            <div
              className={cn(
                'rounded-[var(--r-card)] border px-3 py-2.5',
                proposalState === 'pending'
                  ? 'border-ai/30 bg-ai/[0.06]'
                  : 'border-ink-border bg-ink-2 opacity-70'
              )}
            >
              <div className="flex items-center gap-1.5">
                <Sparkles size={12} strokeWidth={2} aria-hidden className="text-ai" />
                <span className="text-aux font-medium text-ink-fg">跟进 Agent 建议关联</span>
                {proposalState === 'accepted' ? <Pill tone="ok">已确认</Pill> : null}
                {proposalState === 'ignored' ? <Pill tone="ink">已忽略</Pill> : null}
              </div>
              <div className="mt-1.5 truncate text-aux text-ink-fg">
                {displayName(fileById(403)!)}
              </div>
              <div className="mt-0.5 truncate font-mono text-micro text-ink-fg-3">
                library:403 · my-docs/产品/定价/SaaS pricing draft v3.md
              </div>
              <div className="mt-1 text-meta leading-relaxed text-ink-fg-2">
                理由：这份草案里的「按工作区计价」与本事项的定价口径直接相关。
              </div>
              {proposalState === 'pending' ? (
                <div className="mt-2 flex items-center gap-1.5">
                  <Button size="sm" onClick={() => setProposalState('accepted')}>
                    <Check size={13} aria-hidden />
                    {S.matter.accept}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setProposalState('ignored')}>
                    <X size={13} aria-hidden />
                    {S.matter.ignore}
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="mt-2">
              <Notice tone="info">
                提案要过存在性校验：<code className="mx-1 font-mono">resource_available</code> 加{' '}
                <code className="mx-1 font-mono">library:</code> 分支，经**注入的 resolver 回调**查
                library.db（matters 不直接 import library 存储层），挡模型编造的 id。
              </Notice>
            </div>
          </Demo>
        </div>

        <div className="mt-4 max-w-[900px]">
          <Notice tone="warn">
            检索接法是 (a′)「不预检索，给工具」——library_search / read / list 是 class read +
            CORE_UNGATED，matter belt 按 class 自动放行，跟进 run / 行动项 run / 通讯录治理 run 零
            spec 改动就有。**不做**起跑时按事项关键词预检索注入：08-12 与 08-25 两次前科都是
            关键词召回，库文件没有 thread / stakeholder 那样的硬锚，准入线无从设起。
          </Notice>
        </div>

        <LibraryPicker
          open={open}
          onOpenChange={setOpen}
          title={`${S.picker.title} · 关联到「${MATTERS[0]!.title}」`}
          confirmLabel={S.picker.confirmLink}
          onConfirm={(ids) =>
            setToast(`已关联 ${ids.length} 个文件（逐条串行，带上一条返回的 version）`)
          }
        />
        {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
      </div>
    </>
  )
}

/* ── G2 compose ────────────────────────────────────────────────── */

export function G2(): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [attached, setAttached] = React.useState<number[]>([403])
  const [toast, setToast] = React.useState<string | null>(null)

  return (
    <div className="mk-stage-body">
      <SceneHead
        id="G2"
        title="写信：「从资料库选附件」"
        design="§9.4 §9.5"
        note="ComposeAttachmentRef 的三形态 union 加第四形态 {library_file_id}：email.py 的 ref 归一加分支 + mail_write.py::_resolve_attachment_refs 加一个 elif（读 library_file 行 + 读盘 + guess_mime，与 attachment_id 分支同款）。约 60 行。显式列表解析失败恒 ServiceInvalidArgError 不静默跳过 —— 这条纪律对新形态同样成立。"
      />

      <div className="max-w-[720px] overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1">
        <div className="flex h-[41px] items-center gap-2 border-b border-ink-border px-4">
          <span className="text-body font-medium text-ink-fg">写邮件</span>
        </div>
        <div className="space-y-2 p-4">
          <FieldRow label="收件人" value="lei.wang@partner.example.com" />
          <FieldRow label="主题" value="Q3 渠道数据与定价草案" />
          <div className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body leading-relaxed text-ink-fg">
            王磊，附上两份材料，麻烦周五前回一下客单价口径的问题。
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {attached.map((id) => {
              const f = fileById(id)!
              const tone = toneOf(f)
              const I = tone.Icon
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-ink-border bg-ink-2 px-2 py-1 text-micro text-ink-fg-1"
                >
                  <I size={11} strokeWidth={2} className={tone.text} />
                  <span className="max-w-[200px] truncate">{f.filename}</span>
                  <Pill tone="accent">资料库</Pill>
                  <button
                    type="button"
                    aria-label={`移除 ${f.filename}`}
                    onClick={() => setAttached((a) => a.filter((x) => x !== id))}
                    className="text-ink-fg-3 hover:text-ink-fg"
                  >
                    <X size={11} aria-hidden />
                  </button>
                </span>
              )
            })}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-border bg-ink-2 px-2 py-1 text-micro text-ink-fg-1">
              <Paperclip size={11} strokeWidth={2} aria-hidden className="text-ink-fg-3" />
              <span>本地上传.png</span>
              <Pill tone="ink">本机</Pill>
            </span>
          </div>

          <div className="flex items-center gap-1.5 pt-1">
            <Button size="sm" variant="secondary">
              <Paperclip size={13} aria-hidden />
              添加附件
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              <FileDown size={13} aria-hidden />
              {S.compose.pickFromLibrary}
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-3 max-w-[720px]">
        <Notice tone="info">
          附件 chip 带来源标记（资料库 / 本机 / 转发自邮件），因为三者的失效方式不一样：
          库文件可能被移动或删除、暂存文件会过期、转发的附件依赖原邮件还在。
        </Notice>
      </div>

      <LibraryPicker
        open={open}
        onOpenChange={setOpen}
        title={S.picker.title}
        confirmLabel={S.picker.confirmAttach}
        onConfirm={(ids) => {
          setAttached((a) => [...new Set([...a, ...ids])])
          setToast(`已添加 ${ids.length} 个资料库文件为附件`)
        }}
      />
      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  )
}

function FieldRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 border-b border-ink-border-soft pb-1.5">
      <span className="w-14 shrink-0 text-meta text-ink-fg-3">{label}</span>
      <span className="min-w-0 flex-1 truncate text-aux text-ink-fg">{value}</span>
    </div>
  )
}

/* ── G3 邮件附件行菜单 ─────────────────────────────────────────── */

export function G3(): React.ReactElement {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [toast, setToast] = React.useState<string | null>(null)
  const trigger = React.useRef<HTMLButtonElement | null>(null)
  const atts = [fileById(101)!, fileById(102)!, fileById(103)!]

  const items: readonly PopmenuItem[] = [
    { kind: 'action', id: 'preview', label: '预览', onSelect: () => undefined },
    { kind: 'action', id: 'download', label: '下载到 Downloads', onSelect: () => undefined },
    { kind: 'separator', id: 's1' },
    {
      kind: 'action',
      id: 'keep',
      label: S.act.keepToLibrary,
      hint: '真复制一份',
      onSelect: () => setToast('打开目标文件夹选择（同场景 C11）')
    }
  ]

  return (
    <div className="mk-stage-body">
      <SceneHead
        id="G3"
        title="邮件详情附件行的「另存到资料库」"
        design="§9.4"
        note="P1 就排：POST /library/keep-attachment {attachment_id, target_path}。这是投影区之外唯一把邮件附件变成库文件的路径 —— 复制之后 source='mail'、source_ref=attachment_id，与邮件解耦，原邮件删了这一份还在。"
      />
      <div className="max-w-[560px] rounded-[var(--r-card)] border border-ink-border bg-ink-1 p-3">
        <div className="mb-2 text-micro font-mono uppercase tracking-widest text-ink-fg-3">
          附件 · 3
        </div>
        <div className="grid grid-cols-2 gap-2">
          {atts.map((a, i) => {
            const tone = toneOf(a)
            const I = tone.Icon
            return (
              <div
                key={a.id}
                className="group/tile relative flex items-start gap-3 rounded-md border border-ink-border bg-ink-2 px-3 py-2.5"
              >
                <span
                  className={cn(
                    'grid size-9 shrink-0 place-items-center rounded-md border',
                    tone.bg,
                    tone.border
                  )}
                >
                  <I size={16} strokeWidth={2} className={tone.text} />
                </span>
                <div className="min-w-0 flex-1 self-center">
                  <div className="truncate text-aux font-medium text-ink-fg">{a.filename}</div>
                  <div className="font-mono text-meta tabular-nums text-ink-fg-2">
                    {a.size_bytes != null ? `${Math.round(a.size_bytes / 1024)} KB` : '—'}
                  </div>
                </div>
                {i === 0 ? (
                  <>
                    <button
                      ref={trigger}
                      type="button"
                      aria-label="更多"
                      onClick={() => setMenuOpen((v) => !v)}
                      className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded text-ink-fg-3 hover:bg-ink-4 hover:text-ink-fg"
                    >
                      ⋯
                    </button>
                    <Popmenu
                      open={menuOpen}
                      onClose={() => setMenuOpen(false)}
                      ariaLabel="附件操作"
                      title={a.filename}
                      triggerRef={trigger}
                      align="end"
                      width={248}
                      items={items}
                    />
                  </>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  )
}

/* ── G4 深链落地 ───────────────────────────────────────────────── */

export function G4(): React.ReactElement {
  const [target, setTarget] = React.useState<'ok' | 'missing' | 'trashed'>('ok')
  const [toast, setToast] = React.useState<string | null>(null)
  const file =
    target === 'ok' ? fileById(302)! : target === 'missing' ? fileById(406)! : fileById(601)!

  React.useEffect(() => {
    if (target === 'missing') setToast(S.deeplink.missingToast)
    else if (target === 'trashed') setToast(S.deeplink.trashedToast)
    else setToast(null)
  }, [target])

  const selected = target === 'trashed' ? '.trash' : file.parent_path

  return (
    <>
      <StateBar>
        <StateSwitch
          label="深链目标"
          value={target}
          options={[
            { value: 'ok', label: '文件正常' },
            { value: 'missing', label: 'missing' },
            { value: 'trashed', label: 'trashed' }
          ]}
          onChange={(v) => setTarget(v as typeof target)}
        />
        <span className="font-mono text-micro text-ink-fg-3">/library?file={file.id}</span>
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="G4"
          title="深链落地：进域 + 展开所在文件夹 + 选中文件"
          design="§9.5"
          note="三处共用同一个形状：ResourceDrawer 的打开分支、通知深链、资料库页的「对话」按钮回跳。文件 missing / trashed 时进域并 toast，不做「什么都不发生」——用户点了就得有回音。"
        />
        <AppWindow
          dock={<DockPlaceholder />}
          second={
            <LibraryTree
              selected={selected}
              onSelect={() => undefined}
              expanded={new Set(['agent-docs', 'my-docs', 'my-docs/产品', '__mounts__'])}
              onToggle={() => undefined}
            />
          }
        >
          <div className="flex h-full flex-col">
            <ContentHeader
              crumbs={[
                S.domain,
                ...(target === 'trashed' ? [S.roots.trash] : file.rel_path.split('/'))
              ]}
            />
            <div className="flex-1 p-4">
              {target === 'ok' ? (
                <div className="rounded-[var(--r-card)] border border-coral/40 bg-coral/[0.06] px-3 py-2.5">
                  <div className="text-aux font-medium text-ink-fg">{displayName(file)}</div>
                  <div className="mt-0.5 font-mono text-micro text-ink-fg-3">{file.rel_path}</div>
                  <div className="mt-1 text-meta text-ink-fg-2">
                    已选中 —— 树里所在文件夹自动展开，右侧直接是预览面。
                  </div>
                </div>
              ) : (
                <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-3 py-2.5 text-meta text-ink-fg-2">
                  {target === 'missing'
                    ? '进了域但没有可选中的文件 —— 引用还在（id 不回收），文件不在。'
                    : '文件在废纸篓里，落地时改为打开废纸篓视图并高亮它。'}
                </div>
              )}
            </div>
          </div>
        </AppWindow>
        {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
      </div>
    </>
  )
}

/* ── G5 报告导出 ───────────────────────────────────────────────── */

export function G5(): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [target, setTarget] = React.useState('agent-docs/reports')
  const [toast, setToast] = React.useState<string | null>(null)

  return (
    <div className="mk-stage-body">
      <SceneHead
        id="G5"
        title="报告页「导出到资料库」"
        design="L15（P3 可选）"
        note="🔴 不自动落盘 —— 自动落 = 同一份报告两个真源（report.blocks_json vs 文件）。只做一个人触发的按钮，且需要新写一个 ReportDoc → markdown 渲染器（19 种块的 canonical vocabulary 在 Python 侧，TS 有跨语言闸）。"
      />
      <div className="max-w-[680px] overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1">
        <div className="flex h-[41px] items-center gap-2 border-b border-ink-border px-4">
          <span className="flex-1 text-body font-medium text-ink-fg">第 35 周周报</span>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <FileDown size={13} aria-hidden />
            {S.report.exportToLibrary}
          </Button>
        </div>
        <div className="p-4 text-aux leading-relaxed text-ink-fg-1">
          <p className="font-medium text-ink-fg">本周</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-fg-2">
            <li>通知中心 M3 上线，徽标口径收编完成。</li>
            <li>群聊实验批装机，等 owner dogfood。</li>
          </ul>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[520px]">
          <DialogHeader>
            <DialogTitle>{S.report.exportToLibrary}</DialogTitle>
            <DialogDescription>
              把这份报告渲染成 markdown 存进资料库。存进去之后它就是一个独立文件，
              报告本身之后再更新**不会**同步过去。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5">
            <FolderPicker
              value={target}
              onChange={setTarget}
              disabledPrefixes={['mail-attachments']}
            />
            <div className="rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2.5 py-1.5 font-mono text-micro text-ink-fg-3">
              {target}/第35周周报-2026-08-30.md
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {S.act.cancel}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setOpen(false)
                setToast(`已导出到 ${target}`)
              }}
            >
              {S.act.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  )
}
