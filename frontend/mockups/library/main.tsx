// 资料库 UI mockup —— task 09-02-library-knowledge-base（planning，不开工实现）。
//
// 一页应用：左边场景导航（A–G 分组），中间渲染该场景，场景自带状态条。
// 起法：`pnpm -C frontend exec vite --config mockups/library/vite.config.ts`
//       或 .claude/launch.json 的 `library-mockup`（端口 5202）。
//
// 复用 / 副本的清单、未 mock 项、设计缺漏都在 ./README.md。

import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'

import '../../src/electron/renderer/index.css'
import './mockup.css'
import i18n from '@shared/i18n'

import { SCENES, type Scene } from './scenes'

// mockup 固定 zh-CN（i18n 的 LanguageDetector 会读 navigator，这里压掉）。
void i18n.changeLanguage('zh-CN')

function App(): React.ReactElement {
  const [activeId, setActiveId] = useState(SCENES[0]!.id)
  const active = SCENES.find((s) => s.id === activeId) ?? SCENES[0]!

  const groups: Array<{ name: string; scenes: Scene[] }> = []
  for (const s of SCENES) {
    const last = groups[groups.length - 1]
    if (last && last.name === s.group) last.scenes.push(s)
    else groups.push({ name: s.group, scenes: [s] })
  }

  return (
    <div className="mk-shell">
      <nav className="mk-nav" aria-label="场景导航">
        <div className="border-b border-ink-border px-3.5 py-3">
          <div className="text-body font-medium text-ink-fg">资料库 mockup</div>
          <div className="mt-0.5 text-micro leading-relaxed text-ink-fg-3">
            task 09-02-library-knowledge-base
            <br />
            全部数据为假，写入只改本地 state
          </div>
        </div>
        {groups.map((g) => (
          <div key={g.name}>
            <div className="px-3.5 pb-1 pt-3.5 text-micro font-mono uppercase tracking-widest text-ink-fg-3">
              {g.name}
            </div>
            {g.scenes.map((s) => (
              <button
                key={s.id}
                type="button"
                className="mk-nav-item"
                data-active={s.id === activeId ? 'true' : 'false'}
                onClick={() => setActiveId(s.id)}
              >
                <span className="mk-nav-id">{s.id}</span>
                <span className="min-w-0 flex-1">{s.title}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="mk-stage" key={active.id}>
        <active.Component />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
