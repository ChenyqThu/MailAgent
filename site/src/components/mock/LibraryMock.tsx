/**
 * LibraryMock — the Library domain (资料库). Recreates the product's multi-root
 * tree + library search + file preview (frontend/src/shared/components/library/)
 * at landing-page scale: six roots (mail / chat attachments, Agent docs, My
 * docs, a read-only mounted folder, Trash) → a search with keyword and
 * semantic hits marked per result → the Markdown file an agent wrote, with
 * its author, version and linked matter.
 *
 * Layout follows the mock's own width (container queries), not the viewport:
 *   ≥ 520px  tree on the left, search + preview on the right
 *   < 520    tree hidden, single column
 *
 * Presentational only — pure props → JSX, fictional data, no network.
 */
import type { CSSProperties, ReactNode } from 'react'
import './LibraryMock.css'
import {
  libraryMock,
  type LibDocBlock,
  type LibResult,
  type LibRootId,
  type LibRun,
  type LibTreeRow,
} from './fixtures/LibraryMock'

export interface LibraryMockProps {
  locale?: 'zh-CN' | 'en'
}

type IconName =
  | 'paperclip'
  | 'message'
  | 'bot'
  | 'folder'
  | 'drive'
  | 'trash'
  | 'file'
  | 'sheet'
  | 'chevron'
  | 'plus'
  | 'search'
  | 'history'
  | 'matter'

const PATHS: Record<IconName, ReactNode> = {
  paperclip: (
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  ),
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  bot: (
    <>
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </>
  ),
  folder: (
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  ),
  drive: (
    <>
      <path d="M22 12H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      <path d="M6 16h.01M10 16h.01" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </>
  ),
  file: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M16 13H8M16 17H8M10 9H8" />
    </>
  ),
  sheet: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M8 13h8M8 17h8M12 13v4" />
    </>
  ),
  chevron: <path d="m9 18 6-6-6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </>
  ),
  matter: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
}

function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

const ROOT_ICON: Record<LibRootId, IconName> = {
  'mail-attachments': 'paperclip',
  'chat-attachments': 'message',
  'agent-docs': 'bot',
  'my-docs': 'folder',
  mounts: 'drive',
  trash: 'trash',
}

function nodeIcon(row: LibTreeRow): IconName {
  if (row.kind === 'root' && row.root) return ROOT_ICON[row.root]
  if (row.kind === 'mount') return 'drive'
  if (row.kind === 'file') return 'file'
  return 'folder'
}

const RESULT_ICON: Record<LibResult['kind'], IconName> = { sheet: 'sheet', md: 'file', pdf: 'file' }

function Snippet({ runs }: { runs: LibRun[] }) {
  return (
    <>
      {runs.map((run, i) => (typeof run === 'string' ? <span key={i}>{run}</span> : <mark key={i}>{run.mark}</mark>))}
    </>
  )
}

function DocBlock({ block }: { block: LibDocBlock }) {
  switch (block.t) {
    case 'h1':
      return <h1>{block.text}</h1>
    case 'meta':
      return <p className="lm-md-meta">{block.text}</p>
    case 'h2':
      return <h2>{block.text}</h2>
    case 'ul':
      return (
        <ul>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      )
  }
}

export default function LibraryMock({ locale = 'zh-CN' }: LibraryMockProps) {
  const d = libraryMock[locale]
  const c = d.chrome

  return (
    <div className="lm" data-mock="LibraryMock">
      {/* ── multi-root tree (hidden < 520px) ─────────────────────────── */}
      <aside className="lm-tree" aria-label={c.title}>
        <div className="lm-tree-head">
          <span className="lm-tree-title">{c.title}</span>
          <span className="lm-iconbtn" title={c.addFolder}>
            <Icon name="plus" />
          </span>
        </div>
        <div className="lm-nodes">
          {d.tree.map((row) => {
            const expandable = row.kind === 'root' || row.kind === 'folder'
            return (
              <div
                key={row.label}
                className={`lm-node lm-node--${row.kind}${row.selected ? ' sel' : ''}`}
                style={{ '--depth': row.depth } as CSSProperties}
              >
                <span className={`lm-chev${row.open ? ' open' : ''}`}>
                  {expandable && row.root !== 'trash' ? <Icon name="chevron" /> : null}
                </span>
                <Icon name={nodeIcon(row)} className="lm-node-ic" />
                <span className="lm-node-label">{row.label}</span>
                {row.badge ? <span className="lm-pip">{row.badge}</span> : null}
                {row.count != null ? <span className="lm-count">{row.count}</span> : null}
              </div>
            )
          })}
        </div>
      </aside>

      {/* ── search + preview ─────────────────────────────────────────── */}
      <div className="lm-main">
        <div className="lm-search">
          <Icon name="search" className="lm-search-ic" />
          <span className="lm-query">{c.query}</span>
          <span className="lm-caret" aria-hidden="true" />
          <span className="lm-rescount">{c.resultCount}</span>
        </div>

        <ul className="lm-results">
          {d.results.map((r) => (
            <li key={r.name} className={`lm-res${r.selected ? ' sel' : ''}`}>
              <Icon name={RESULT_ICON[r.kind]} className={`lm-res-ic lm-kind--${r.kind}`} />
              <span className="lm-res-text">
                <span className="lm-res-name">{r.name}</span>
                <span className="lm-res-snip">
                  <Snippet runs={r.snippet} />
                </span>
              </span>
              <span className="lm-res-match">
                {r.match.map((m) => (
                  <span key={m} className={`lm-hit lm-hit--${m}`}>
                    {c.match[m]}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>

        <article className="lm-doc">
          <header className="lm-doc-head">
            <Icon name="file" className="lm-doc-ic" />
            <span className="lm-doc-name">{d.doc.name}</span>
          </header>
          <div className="lm-doc-meta">
            <span className="lm-pip">{c.kind}</span>
            <span className="lm-meta-item lm-meta-agent">
              <Icon name="bot" />
              {c.writtenBy}
            </span>
            <span className="lm-meta-item">
              <Icon name="history" />
              {c.version}
            </span>
            <span className="lm-meta-when">{c.updated}</span>
          </div>
          <div className="lm-md">
            {d.doc.blocks.map((block, i) => (
              <DocBlock key={i} block={block} />
            ))}
          </div>
          <footer className="lm-doc-foot">
            <span className="lm-foot-lab">{c.relatedLabel}</span>
            <span className="lm-matter">
              <Icon name="matter" />
              {c.related}
            </span>
          </footer>
        </article>
      </div>
    </div>
  )
}
