// C 内容区：文件预览面（design §2.3 §2.4 §4 §1.5 §9.2 §9.4）

import * as React from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'

import { Button } from '@shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Checkbox } from '@shared/components/ui/checkbox'

import { FILES, fileById, type LibFile } from '../fixtures'
import { S } from '../strings'
import { Demo, Notice, Pill, SceneHead, StateBar, StateSwitch, SystemDialogCard, Toast } from '../parts/kit'
import { AppWindow, ContentHeader, DockPlaceholder } from '../parts/shell'
import { LibraryTree } from '../parts/tree'
import { openWithApp } from '../parts/fileMeta'
import {
  ActIcon,
  FileHeader,
  FileStatusBanner,
  FolderPicker,
  HistoryDrawer,
  HtmlPane,
  ImagePane,
  Lightbox,
  MarkdownPane,
  OfficePane,
  OtherPane,
  PdfPane,
  RelatedBlock,
  type HeaderAction,
  type MdMode
} from '../parts/preview'

/** 预览面的通用外壳：树 + 内容区（文件头 + 正文 + 关联区）。 */
function PreviewWindow({
  file,
  actions,
  children,
  banner,
  related = true,
  onChat
}: {
  file: LibFile
  actions: readonly HeaderAction[]
  children: React.ReactNode
  banner?: React.ReactNode
  related?: boolean
  onChat?(): void
}): React.ReactElement {
  return (
    <AppWindow
      dock={<DockPlaceholder onChat={onChat} />}
      second={
        <LibraryTree
          selected={file.parent_path}
          onSelect={() => undefined}
          expanded={
            new Set([
              'mail-attachments',
              'chat-attachments',
              'agent-docs',
              'my-docs',
              'my-docs/产品',
              '__mounts__',
              '@工作区',
              '@Design 素材'
            ])
          }
          onToggle={() => undefined}
        />
      }
    >
      <div className="flex h-full flex-col">
        <ContentHeader crumbs={[S.domain, ...file.rel_path.split('/')]} />
        <FileHeader file={file} actions={actions} onChat={onChat} />
        {banner}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-thin">{children}</div>
        {related ? <RelatedBlock file={file} /> : null}
      </div>
    </AppWindow>
  )
}

const noop = (): void => undefined

/* ── C1 文件头与动作 ────────────────────────────────────────────── */

const HEADER_CASES = [
  { value: '403', label: 'md（我的文档）' },
  { value: '101', label: 'office（投影区）' },
  { value: '302', label: 'md（Agents 文档）' },
  { value: '502', label: 'md（@工作区，rw）' },
  { value: '505', label: 'pdf（@Design 素材，ro）' }
]

export function C1(): React.ReactElement {
  const [id, setId] = React.useState('403')
  const [history, setHistory] = React.useState(false)
  const [log, setLog] = React.useState<string | null>(null)
  const file = fileById(Number(id))!
  const projection = file.rel_path.startsWith('mail-attachments')
  const roMount = file.rel_path.startsWith('@Design 素材')
  const app = openWithApp(file)

  const actions: HeaderAction[] = []
  if (file.kind === 'markdown' && !projection && !roMount) {
    actions.push({ id: 'edit', label: S.act.edit, icon: ActIcon.edit, onClick: noop, primary: true })
  }
  if (app) {
    actions.push({ id: 'open', label: S.act.openWith(app), icon: ActIcon.open, onClick: noop })
  }
  if (!projection) {
    actions.push({ id: 'reveal', label: S.act.reveal, icon: ActIcon.reveal, onClick: noop })
  }
  if (projection) {
    actions.push({
      id: 'keep',
      label: S.act.keepToLibrary,
      icon: ActIcon.keep,
      onClick: () => setLog('打开「另存到资料库」对话框 → 见场景 C11'),
      primary: true
    })
  }
  if (file.kind !== 'markdown' && file.text_status === 'extracted') {
    actions.push({ id: 'savemd', label: S.act.saveParsedMd, icon: ActIcon.keep, onClick: noop })
  }
  if (!projection && !roMount) {
    actions.push({ id: 'move', label: S.act.moveTo, icon: ActIcon.move, onClick: noop })
    actions.push({ id: 'del', label: S.act.delete, icon: ActIcon.del, onClick: noop, danger: true })
  }
  actions.push({ id: 'hist', label: S.act.history, icon: ActIcon.history, onClick: () => setHistory(true) })

  return (
    <>
      <StateBar>
        <StateSwitch label="文件" value={id} options={HEADER_CASES} onChange={setId} />
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="C1"
          title="文件头：元信息 + 右上动作"
          design="§2.3"
          note="动作按「文件在哪个根 / 是什么类型 / 解析好没有」变：投影区没有编辑 / 移动 / 删除，多一个「另存到资料库」；只读挂载根同理；非文本类多一个「另存解析版为 markdown」。「对话」按钮 = startChatWithPrompt + 预置一条 @ 提及（L16：不加第五档 ConversationContextSource）。"
        />
        <PreviewWindow
          file={file}
          actions={actions}
          onChat={() => setLog(`新开一轮对话，composer 预置 @${file.filename}`)}
        >
          {file.kind === 'markdown' ? (
            <MarkdownPane file={file} mode="read" onModeChange={noop} />
          ) : file.kind === 'pdf' ? (
            <PdfPane file={file} originalAvailable={false} />
          ) : (
            <OfficePane file={file} />
          )}
        </PreviewWindow>
        <HistoryDrawer open={history} onOpenChange={setHistory} file={file} />
        {log ? <Toast text={log} onClose={() => setLog(null)} /> : null}
      </div>
    </>
  )
}

/* ── C2 markdown 三态 ──────────────────────────────────────────── */

export function C2(): React.ReactElement {
  const [mode, setMode] = React.useState<MdMode>('read')
  const file = fileById(302)!
  return (
    <>
      <StateBar>
        <StateSwitch
          label="状态"
          value={mode}
          options={[
            { value: 'read', label: '只读' },
            { value: 'edit', label: '编辑' },
            { value: 'conflict', label: '保存冲突（409）' }
          ]}
          onChange={(v) => setMode(v as MdMode)}
        />
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="C2"
          title="markdown：只读 → 编辑 → 保存冲突"
          design="§2.4 §4"
          note="只读走 TranslatedBody（Streamdown，与 chat 同一渲染器）；编辑抄 StandingDocsSection 的 textarea + 保存 / 取消，多一个「变更说明」写进 library_history。保存带 expected_hash；不符 → 409，提示已被改动、并排显示当前版本、保留我的文本，两个出口（用我的覆盖 / 放弃）。"
        />
        <PreviewWindow
          file={file}
          actions={[
            {
              id: 'edit',
              label: mode === 'read' ? S.act.edit : '正在编辑',
              icon: ActIcon.edit,
              primary: mode === 'read',
              disabled: mode !== 'read',
              onClick: () => setMode('edit')
            },
            { id: 'hist', label: S.act.history, icon: ActIcon.history, onClick: noop }
          ]}
        >
          <MarkdownPane file={file} mode={mode} onModeChange={setMode} />
        </PreviewWindow>
        {mode === 'edit' ? (
          <div className="mt-3">
            <Notice tone="info">
              点「保存」= <code className="font-mono">PUT /library/file/&#123;id&#125;</code> 带
              <code className="mx-1 font-mono">&#123;content, expected_hash, change_note&#125;</code>。
              hash 相同则 no-op 不记历史。想看冲突态，把状态切到「保存冲突」。
            </Notice>
          </div>
        ) : null}
      </div>
    </>
  )
}

/* ── C3 html ───────────────────────────────────────────────────── */

export function C3(): React.ReactElement {
  const file = fileById(404)!
  return (
    <div className="mk-stage-body">
      <SceneHead
        id="C3"
        title="html：无脚本沙箱预览"
        design="§2.4（L7）"
        note="iframe srcdoc + sandbox=「allow-same-origin」（**无** allow-scripts）+ DOMPurify，所有来源一视同仁 —— 给 agent-docs 开脚本就是按来源分档，那是另一套安全边界。要看完整效果走「用系统浏览器打开」（经新 IPC library:openPath）。"
      />
      <PreviewWindow
        file={file}
        actions={[
          { id: 'open', label: S.act.openWith('浏览器'), icon: ActIcon.open, onClick: noop },
          { id: 'reveal', label: S.act.reveal, icon: ActIcon.reveal, onClick: noop },
          { id: 'move', label: S.act.moveTo, icon: ActIcon.move, onClick: noop },
          { id: 'hist', label: S.act.history, icon: ActIcon.history, onClick: noop }
        ]}
      >
        <HtmlPane file={file} />
      </PreviewWindow>
    </div>
  )
}

/* ── C4 图片 ───────────────────────────────────────────────────── */

export function C4(): React.ReactElement {
  const [withOcr, setWithOcr] = React.useState(true)
  const [lightbox, setLightbox] = React.useState(false)
  const base = fileById(103)!
  const file: LibFile = withOcr ? base : { ...base, text_status: null, body: undefined }

  return (
    <>
      <StateBar>
        <StateSwitch
          label="OCR"
          value={withOcr ? 'yes' : 'no'}
          options={[
            { value: 'yes', label: '有 OCR 文本' },
            { value: 'no', label: '无 OCR' }
          ]}
          onChange={(v) => setWithOcr(v === 'yes')}
        />
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="C4"
          title="图片：预览 + lightbox +「文字」视图"
          design="§2.4"
          note="readDataUrl + ImageLightbox（上限沿用 canPreviewImage 的 25 MB / 必须有已知大小）。有 OCR 文本时旁边多一个「文字」视图 —— 那份文本同时也是 FTS 与 library_read 的来源。点图开 lightbox。"
        />
        <PreviewWindow
          file={file}
          actions={[
            { id: 'keep', label: S.act.keepToLibrary, icon: ActIcon.keep, primary: true, onClick: noop },
            { id: 'open', label: S.act.openSystem, icon: ActIcon.open, onClick: noop }
          ]}
        >
          <ImagePane file={file} onLightbox={() => setLightbox(true)} />
        </PreviewWindow>
        {lightbox ? <Lightbox onClose={() => setLightbox(false)} /> : null}
      </div>
    </>
  )
}

/* ── C5 PDF ────────────────────────────────────────────────────── */

export function C5(): React.ReactElement {
  const [poc, setPoc] = React.useState<'ok' | 'fail'>('ok')
  const file = fileById(402)!
  return (
    <>
      <StateBar>
        <StateSwitch
          label="原件内嵌 PoC"
          value={poc}
          options={[
            { value: 'ok', label: '通了（有「原件」页签）' },
            { value: 'fail', label: '没通（只剩解析视图）' }
          ]}
          onChange={setPoc}
        />
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="C5"
          title="PDF：解析视图 ⇄ 原件"
          design="§2.4（L10）"
          note="解析视图 = pypdf 逐页文本（扫描件级联 Vision OCR），带页分隔的纯文本而不是 markdown —— anydoc 的 pdf lane 默认不开（实测 3 份回归）。原件内嵌在 P1 内做 PoC；不通则 v1 只有解析视图 + 用系统阅读器打开。"
        />
        <PreviewWindow
          file={file}
          actions={[
            { id: 'savemd', label: S.act.saveParsedMd, icon: ActIcon.keep, onClick: noop },
            { id: 'open', label: S.act.openWith('预览'), icon: ActIcon.open, onClick: noop },
            { id: 'move', label: S.act.moveTo, icon: ActIcon.move, onClick: noop },
            { id: 'del', label: S.act.delete, icon: ActIcon.del, danger: true, onClick: noop }
          ]}
        >
          <PdfPane file={file} originalAvailable={poc === 'ok'} />
        </PreviewWindow>
      </div>
    </>
  )
}

/* ── C6 office / csv ───────────────────────────────────────────── */

const OFFICE_CASES = [
  { value: 'docx', label: 'docx（已解析）' },
  { value: 'csv', label: 'csv（已解析）' },
  { value: 'pending', label: 'xlsx（抽取中）' },
  { value: 'failed', label: 'doc（失败）' },
  { value: 'unsupported', label: 'numbers（不支持）' }
]

export function C6(): React.ReactElement {
  const [which, setWhich] = React.useState('docx')
  const file =
    which === 'docx'
      ? fileById(101)!
      : which === 'csv'
        ? fileById(405)!
        : which === 'pending'
          ? fileById(203)!
          : which === 'failed'
            ? fileById(106)!
            : fileById(105)!
  const app = openWithApp(file) ?? '系统应用'

  return (
    <>
      <StateBar>
        <StateSwitch label="文件" value={which} options={OFFICE_CASES} onChange={setWhich} />
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="C6"
          title="office / csv：解析视图 + 原件外部打开"
          design="§2.4（L18）"
          note="默认是「解析视图」——library_text 里的 markdown 经 Streamdown 渲染（表格直接看得懂）。原件按扩展名交给 Word / Excel / PowerPoint。text_status 三态各有形态：pending 给「正在解析」+ 仍能打开原件；failed 给红条 + 重试；unsupported 只给外部打开。🔴 解析版不落 sidecar（不生成 x.docx.md），只活在 library_text。"
        />
        <PreviewWindow
          file={file}
          actions={[
            {
              id: 'savemd',
              label: S.act.saveParsedMd,
              icon: ActIcon.keep,
              disabled: file.text_status !== 'extracted',
              onClick: noop
            },
            { id: 'open', label: S.act.openWith(app), icon: ActIcon.open, onClick: noop },
            { id: 'keep', label: S.act.keepToLibrary, icon: ActIcon.keep, onClick: noop }
          ]}
        >
          <OfficePane file={file} onRetry={noop} />
        </PreviewWindow>
      </div>
    </>
  )
}

/* ── C7 video / 大文件 / other ─────────────────────────────────── */

export function C7(): React.ReactElement {
  const [which, setWhich] = React.useState('104')
  const file = fileById(Number(which))!
  return (
    <>
      <StateBar>
        <StateSwitch
          label="文件"
          value={which}
          options={[
            { value: '104', label: 'mp4 录屏 394 MB' },
            { value: '105', label: '.numbers（无解析路径）' },
            { value: '506', label: 'iCloud 占位文件' }
          ]}
          onChange={setWhich}
        />
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="C7"
          title="video / 大文件 / 其他：只给元信息 + 打开"
          design="§2.4"
          note="不内联。iCloud 未下载的占位文件（.icloud）标 kind='placeholder'，不抽取、不进 FTS，打开会触发系统下载。"
        />
        <PreviewWindow
          file={file}
          actions={[
            { id: 'open', label: S.act.openSystem, icon: ActIcon.open, onClick: noop },
            { id: 'reveal', label: S.act.reveal, icon: ActIcon.reveal, onClick: noop }
          ]}
          related={false}
        >
          <OtherPane file={file} />
          {file.kind === 'placeholder' ? (
            <div className="px-4 pb-4">
              <Notice tone="info">
                iCloud 占位：磁盘上只有一个 <code className="font-mono">.icloud</code> 存根。
                索引里有行、有 id，但没有正文；不抽取也不嵌入。
              </Notice>
            </div>
          ) : null}
        </PreviewWindow>
      </div>
    </>
  )
}

/* ── C8 文件状态 ───────────────────────────────────────────────── */

export function C8(): React.ReactElement {
  const [which, setWhich] = React.useState<'missing' | 'trashed' | 'mount'>('missing')
  const file =
    which === 'missing' ? fileById(406)! : which === 'trashed' ? fileById(601)! : fileById(505)!
  return (
    <>
      <StateBar>
        <StateSwitch
          label="状态"
          value={which}
          options={[
            { value: 'missing', label: 'missing（磁盘上没了）' },
            { value: 'trashed', label: 'trashed（在废纸篓）' },
            { value: 'mount', label: '所属挂载 unavailable' }
          ]}
          onChange={setWhich}
        />
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="C8"
          title="三种不可用状态"
          design="§1.2 §8.2 §9.0"
          note="共同点：行不删、id 不回收 —— 事项 / 会话 / 消息里的 library:{id} 引用不悬空，只在展示处灰显。missing 的解析文本还在索引里，所以仍能读；trashed 可恢复；挂载不可用是整棵子树。"
        />
        <PreviewWindow
          file={file}
          actions={
            which === 'trashed'
              ? [{ id: 'restore', label: S.act.restore, icon: <RotateCcw size={13} aria-hidden />, primary: true, onClick: noop }]
              : [{ id: 'reveal', label: S.act.reveal, icon: ActIcon.reveal, disabled: true, onClick: noop }]
          }
          banner={
            <FileStatusBanner file={file} mountUnavailable={which === 'mount'} onRestore={noop} />
          }
          related={which !== 'mount'}
        >
          {which === 'mount' ? (
            <div className="grid flex-1 place-items-center px-6 py-10 text-center text-meta text-ink-fg-3">
              挂载不可用时不读盘；预览留空，只保留元信息与历史。
            </div>
          ) : file.kind === 'markdown' ? (
            <MarkdownPane file={file} mode="read" onModeChange={noop} />
          ) : (
            <OfficePane file={file} />
          )}
        </PreviewWindow>
      </div>
    </>
  )
}

/* ── C9 历史 ───────────────────────────────────────────────────── */

export function C9(): React.ReactElement {
  const [open, setOpen] = React.useState(true)
  const file = fileById(302)!
  return (
    <>
      <StateBar>
        <StateSwitch
          label="抽屉"
          value={open ? 'open' : 'closed'}
          options={[
            { value: 'open', label: '打开' },
            { value: 'closed', label: '关闭' }
          ]}
          onChange={(v) => setOpen(v === 'open')}
        />
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="C9"
          title="历史面板（抽屉）：版本 / 快照 / 回滚"
          design="§4"
          note="每次经工具或 UI 的写入记一条全快照 + change_note。changed_by 三类：user / agent_id / external（外部编辑经 mtime→hash 对账补记，没有变更说明）。回滚 = 用快照做一次普通写，享受同一道 CAS 校验，会再记一条历史。点「查看快照」展开、点「回滚到这一版」出确认条。"
        />
        <PreviewWindow
          file={file}
          actions={[
            { id: 'edit', label: S.act.edit, icon: ActIcon.edit, onClick: noop },
            { id: 'hist', label: S.act.history, icon: ActIcon.history, primary: true, onClick: () => setOpen(true) }
          ]}
        >
          <MarkdownPane file={file} mode="read" onModeChange={noop} />
        </PreviewWindow>
        <HistoryDrawer open={open} onOpenChange={setOpen} file={file} />
      </div>
    </>
  )
}

/* ── C10 关联事项 + 来源跳转 ───────────────────────────────────── */

export function C10(): React.ReactElement {
  const [which, setWhich] = React.useState('302')
  const file = fileById(Number(which))!
  return (
    <>
      <StateBar>
        <StateSwitch
          label="文件"
          value={which}
          options={[
            { value: '302', label: '两个事项（agent 写的）' },
            { value: '101', label: '一个事项 + 来源邮件' },
            { value: '201', label: '一个事项 + 来源会话' },
            { value: '304', label: '零关联' }
          ]}
          onChange={setWhich}
        />
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="C10"
          title="「关联的事项」小区块与「来源」跳转"
          design="§9.2 §9.4"
          note="反查 resource → matter_resource，design 里标 P2 可选（v1 只做正向）。来源跳转按 source 分：mail → 打开来源邮件，chat → 打开来源会话（source_ref 是 '{sessionId}:{uiMessageId}'）。零关联时整块不渲染。"
        />
        <PreviewWindow
          file={file}
          actions={[{ id: 'hist', label: S.act.history, icon: ActIcon.history, onClick: noop }]}
        >
          {file.kind === 'markdown' ? (
            <MarkdownPane file={file} mode="read" onModeChange={noop} />
          ) : (
            <OfficePane file={file} />
          )}
        </PreviewWindow>
      </div>
    </>
  )
}

/* ── C11 另存到资料库 ──────────────────────────────────────────── */

export function C11(): React.ReactElement {
  const [entry, setEntry] = React.useState<'preview' | 'mailrow'>('preview')
  const [open, setOpen] = React.useState(true)
  const [target, setTarget] = React.useState('my-docs/产品')
  const [keepText, setKeepText] = React.useState(true)
  const [toast, setToast] = React.useState<string | null>(null)
  const file = fileById(101)!

  return (
    <>
      <StateBar>
        <StateSwitch
          label="入口"
          value={entry}
          options={[
            { value: 'preview', label: '投影区文件预览的右上动作' },
            { value: 'mailrow', label: '邮件详情附件行菜单' }
          ]}
          onChange={setEntry}
        />
        <StateSwitch
          label="对话框"
          value={open ? 'open' : 'closed'}
          options={[
            { value: 'open', label: '打开' },
            { value: 'closed', label: '关闭' }
          ]}
          onChange={(v) => setOpen(v === 'open')}
        />
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="C11"
          title="「另存到资料库」目标文件夹选择"
          design="§1.1 §9.4"
          note="两个入口同一个对话框：投影区文件的预览动作、邮件详情附件行菜单。落库 = POST /library/keep-attachment {attachment_id, target_path}，真复制一份（source='mail'，source_ref=attachment_id），此后与邮件解耦。解析文本一起复制进 library_text（投影区零成本：邮件附件的文本早就抽好了）。"
        />

        <Demo title={entry === 'preview' ? '触发点：预览右上「另存到资料库」' : '触发点：邮件附件行的「…」菜单'}>
          {entry === 'preview' ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              {ActIcon.keep}
              {S.act.keepToLibrary}
            </Button>
          ) : (
            <div className="max-w-md">
              <div className="flex items-center gap-3 rounded-md border border-ink-border bg-ink-2 px-3 py-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-md border border-impt/25 bg-impt/10 text-impt">
                  📄
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-aux font-medium text-ink-fg">{file.filename}</div>
                  <div className="font-mono text-meta text-ink-fg-2">2.3 MB</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
                  {S.act.keepToLibrary}
                </Button>
              </div>
            </div>
          )}
        </Demo>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="w-[520px]">
            <DialogHeader>
              <DialogTitle>{S.act.keepToLibrary}</DialogTitle>
              <DialogDescription>
                把「{file.filename}」复制一份到资料库。原邮件删除后这一份仍在。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2.5">
              <FolderPicker
                value={target}
                onChange={setTarget}
                disabledPrefixes={['@Design 素材']}
              />
              <label className="flex cursor-pointer items-start gap-2 text-aux text-ink-fg-2">
                <Checkbox checked={keepText} onCheckedChange={(v) => setKeepText(v === true)} className="mt-0.5" />
                <span>
                  连同已抽取的文本一起复制
                  <span className="ml-1 text-meta text-ink-fg-3">
                    （不复制的话新文件会重新排队抽取）
                  </span>
                </span>
              </label>
              <div className="rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2.5 py-1.5 font-mono text-micro text-ink-fg-3">
                {target}/{file.filename}
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                {S.act.cancel}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setOpen(false)
                  setToast(`已另存到 ${target}/${file.filename}`)
                }}
              >
                {S.act.confirm}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
      </div>
    </>
  )
}

/* ── C12 移到… ─────────────────────────────────────────────────── */

export function C12(): React.ReactElement {
  const [open, setOpen] = React.useState(true)
  const [target, setTarget] = React.useState('agent-docs/notes')
  const [toast, setToast] = React.useState<string | null>(null)
  const file = fileById(403)!

  return (
    <>
      <StateBar>
        <StateSwitch
          label="对话框"
          value={open ? 'open' : 'closed'}
          options={[
            { value: 'open', label: '打开' },
            { value: 'closed', label: '关闭' }
          ]}
          onChange={(v) => setOpen(v === 'open')}
        />
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="C12"
          title="「移到…」文件夹选择"
          design="§2.3"
          note="树内拖拽移动本 epic 不做（D-U1 之外的取舍），移动一律走这个对话框。只读区（投影根 / ro 挂载）在列表里禁用。移动会改 rel_path —— 别人的 library:{id} 引用**不断**（id 才是键），但 agent 手里的路径字符串会失效，所以 library_move 出厂 ask。"
        />
        <Demo title="触发点">
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            {ActIcon.move}
            {S.act.moveTo}
          </Button>
        </Demo>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="w-[520px]">
            <DialogHeader>
              <DialogTitle>{S.act.moveTo}</DialogTitle>
              <DialogDescription>
                把「{file.filename}」移到别的文件夹。id 不变，已有的关联不会断。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2.5">
              <FolderPicker
                value={target}
                onChange={setTarget}
                disabledPrefixes={['@Design 素材', 'mail-attachments']}
              />
              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2.5 py-1.5 font-mono text-micro">
                <span className="text-ink-fg-3">从</span>
                <span className="text-ink-fg-2">{file.rel_path}</span>
                <span className="text-ink-fg-3">到</span>
                <span className="text-ink-fg">
                  {target}/{file.filename}
                </span>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                {S.act.cancel}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setOpen(false)
                  setToast(`已移到 ${target}`)
                }}
              >
                {S.act.confirm}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
      </div>
    </>
  )
}

/* ── C13 删除确认 + 废纸篓 ─────────────────────────────────────── */

export function C13(): React.ReactElement {
  const [view, setView] = React.useState<'confirm' | 'trash' | 'mount'>('confirm')
  const [open, setOpen] = React.useState(true)
  const [toast, setToast] = React.useState<string | null>(null)
  const trashed = FILES.filter((f) => f.status === 'trashed')


  return (
    <>
      <StateBar>
        <StateSwitch
          label="面"
          value={view}
          options={[
            { value: 'confirm', label: '删除确认（库内）' },
            { value: 'mount', label: '删除确认（挂载区）' },
            { value: 'trash', label: '废纸篓视图' }
          ]}
          onChange={(v) => {
            setView(v as typeof view)
            setOpen(true)
          }}
        />
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="C13"
          title="删除确认与废纸篓"
          design="§1.5 §8.2（L6）"
          note="库内删除 = 软删进 .trash，30 天后 sweep（抄 compose_staging.sweep_stale）。挂载区删除**不进**库内 .trash —— 走系统废纸篓（Electron shell.trashItem），文案要说清去哪了。library_delete 出厂 ask + danger_auto（软删可恢复，所以不是 configurable=false）。"
        />

        {view === 'trash' ? (
          <AppWindow
            dock={<DockPlaceholder />}
            second={
              <LibraryTree
                selected=".trash"
                onSelect={() => undefined}
                expanded={new Set(['__mounts__'])}
                onToggle={() => undefined}
              />
            }
          >
            <div className="flex h-full flex-col">
              <ContentHeader
                crumbs={[S.domain, S.roots.trash]}
                right={
                  <Button size="sm" variant="ghost" className="text-fail hover:bg-fail/10 hover:text-fail">
                    <Trash2 size={13} aria-hidden />
                    {S.menu.emptyTrash}
                  </Button>
                }
              />
              <div className="border-b border-ink-border-soft px-4 py-1.5 text-meta text-ink-fg-2">
                {S.trashNotice}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                {trashed.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center gap-3 border-b border-ink-border-soft px-4 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-aux text-ink-fg">{f.filename}</div>
                      <div className="truncate font-mono text-micro text-ink-fg-3">
                        原位置 {f.rel_path.replace('.trash/', '')}
                      </div>
                    </div>
                    <Pill tone={(f.trashDaysLeft ?? 30) <= 5 ? 'warn' : 'ink'}>
                      {S.fileStatus.trashedHint(f.trashDaysLeft ?? 30)}
                    </Pill>
                    <Button size="sm" variant="secondary" onClick={() => setToast('已恢复到原位置')}>
                      <RotateCcw size={13} aria-hidden />
                      {S.act.restore}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </AppWindow>
        ) : (
          <>
            <Demo title="触发点">
              <Button
                size="sm"
                variant="ghost"
                className="text-fail hover:bg-fail/10 hover:text-fail"
                onClick={() => setOpen(true)}
              >
                {ActIcon.del}
                {S.act.delete}
              </Button>
            </Demo>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent className="w-[480px]">
                <DialogHeader>
                  <DialogTitle>
                    {view === 'mount' ? '移到系统废纸篓？' : '移到资料库废纸篓？'}
                  </DialogTitle>
                  <DialogDescription>
                    {view === 'mount' ? (
                      <>
                        「渠道数据.xlsx」在挂载的文件夹 <span className="font-mono">@工作区</span> 里，
                        删除会把**磁盘上的真文件**移到系统废纸篓（访达里能找回），不进资料库自己的
                        .trash。
                      </>
                    ) : (
                      <>
                        「SaaS pricing draft v3.md」会移到废纸篓，{' '}
                        <span className="text-ink-fg">30 天内可以恢复</span>，之后自动清理。
                        指向它的事项 / 会话引用不会悬空，只显示为「在废纸篓里」。
                      </>
                    )}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                    {S.act.cancel}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setOpen(false)
                      setToast(view === 'mount' ? '已移到系统废纸篓' : '已移到废纸篓（30 天内可恢复）')
                    }}
                  >
                    {S.act.delete}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            {view === 'mount' ? (
              <div className="mt-3">
                <SystemDialogCard
                  action="shell.trashItem(absPath)"
                  detail="挂载区的删除交给系统，我们不接管；之后在访达的废纸篓里恢复。"
                />
              </div>
            ) : null}
          </>
        )}

        {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
      </div>
    </>
  )
}

