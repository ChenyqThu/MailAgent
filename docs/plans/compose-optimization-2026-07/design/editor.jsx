// RichEditor — TipTap wrapper with 4 toolbar directions + bubble menu + slash menu + @mention.
// TipTap classes/extensions come from window.TT (built by the module loader in Compose.html).
const { useState: uES, useRef: uER, useEffect: uEF, useCallback: uCB, useLayoutEffect } = React;

const TEXT_COLORS = [
  { name: '默认', v: null },
  { name: '珊瑚', v: '#E5654B' }, { name: '琥珀', v: '#E59B4A' }, { name: '绿', v: '#3E9E6E' },
  { name: '蓝', v: '#4A78E5' }, { name: '靛', v: '#6E5AD6' }, { name: '灰', v: '#6B7280' },
];
const HL_COLORS = [
  { name: '无', v: null },
  { name: '黄', v: '#FCE7A2' }, { name: '绿', v: '#C6EBCB' }, { name: '蓝', v: '#C9E0FB' },
  { name: '粉', v: '#F7CFE0' }, { name: '橙', v: '#FBDCB6' },
];
const FONT_SIZES = ['12', '13', '14', '16', '18', '24', '30'];
const HEADINGS = [
  { label: '正文', level: 0 }, { label: '标题 1', level: 1 }, { label: '标题 2', level: 2 }, { label: '标题 3', level: 3 },
];

function TBBtn({ icon, active, onClick, title, children, wide }) {
  return (
    <button className="tb-btn" data-active={active ? '1' : undefined} data-wide={wide ? '1' : undefined}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick} title={title}>
      {icon ? <Icon name={icon} size={16} /> : children}
    </button>
  );
}
function TBSep() { return <span className="tb-sep" />; }

function Popover({ children, onClose, align = 'left' }) {
  const ref = uER(null);
  uEF(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    setTimeout(() => document.addEventListener('mousedown', h), 0);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  return <div ref={ref} className="tb-pop glass-pop" data-align={align} onMouseDown={(e) => e.preventDefault()}>{children}</div>;
}

// ── Toolbar (shared control cluster used by classic / bottom) ─────────
function Toolbar({ editor, tick, variant }) {
  const [pop, setPop] = uES(null); // 'heading'|'size'|'color'|'highlight'|'link'|'insert'
  const [linkUrl, setLinkUrl] = uES('');
  if (!editor) return null;
  const is = (n, a) => editor.isActive(n, a);
  const chain = () => editor.chain().focus();
  const curHeading = [1, 2, 3].find((l) => is('heading', { level: l }));
  const curSize = editor.getAttributes('textStyle').fontSize?.replace('px', '') || '';

  const applyLink = () => {
    let u = linkUrl.trim(); if (u && !/^https?:\/\//i.test(u) && !/^mailto:/i.test(u)) u = 'https://' + u;
    if (u) chain().extendMarkRange('link').setLink({ href: u }).run(); else chain().unsetLink().run();
    setPop(null); setLinkUrl('');
  };

  return (
    <div className={'rt-toolbar rt-toolbar-' + variant}>
      <div className="tb-group" style={{ position: 'relative' }}>
        <button className="tb-dd" onMouseDown={(e) => e.preventDefault()} onClick={() => setPop(pop === 'heading' ? null : 'heading')}>
          <Icon name="heading" size={14} /><span>{curHeading ? 'H' + curHeading : '正文'}</span><Icon name="chevronDown" size={12} />
        </button>
        {pop === 'heading' && (
          <Popover onClose={() => setPop(null)}>
            {HEADINGS.map((h) => (
              <button key={h.level} className="tb-menuitem" data-active={(h.level === 0 && !curHeading) || curHeading === h.level ? '1' : undefined}
                onClick={() => { h.level === 0 ? chain().setParagraph().run() : chain().toggleHeading({ level: h.level }).run(); setPop(null); }}>
                <span style={{ fontSize: h.level === 0 ? 14 : [0, 20, 17, 15][h.level], fontWeight: h.level ? 700 : 400 }}>{h.label}</span>
              </button>
            ))}
          </Popover>
        )}
      </div>
      <div className="tb-group" style={{ position: 'relative' }}>
        <button className="tb-dd" onMouseDown={(e) => e.preventDefault()} onClick={() => setPop(pop === 'size' ? null : 'size')}>
          <span>{curSize || '14'}</span><Icon name="chevronDown" size={12} />
        </button>
        {pop === 'size' && (
          <Popover onClose={() => setPop(null)}>
            {FONT_SIZES.map((s) => (
              <button key={s} className="tb-menuitem" data-active={curSize === s || (!curSize && s === '14') ? '1' : undefined}
                onClick={() => { s === '14' ? chain().unsetFontSize?.().run() : chain().setFontSize(s + 'px').run(); setPop(null); }}>{s}px</button>
            ))}
          </Popover>
        )}
      </div>
      <TBSep />
      <TBBtn icon="bold" active={is('bold')} onClick={() => chain().toggleBold().run()} title="加粗 ⌘B" />
      <TBBtn icon="italic" active={is('italic')} onClick={() => chain().toggleItalic().run()} title="斜体 ⌘I" />
      <TBBtn icon="underline" active={is('underline')} onClick={() => chain().toggleUnderline().run()} title="下划线 ⌘U" />
      <TBBtn icon="strike" active={is('strike')} onClick={() => chain().toggleStrike().run()} title="删除线" />
      <div style={{ position: 'relative' }}>
        <TBBtn icon="color" active={pop === 'color'} onClick={() => setPop(pop === 'color' ? null : 'color')} title="文字颜色" />
        {pop === 'color' && (
          <Popover onClose={() => setPop(null)}>
            <div className="tb-swatches">
              {TEXT_COLORS.map((c) => (
                <button key={c.name} className="tb-swatch" title={c.name} style={{ background: c.v || 'transparent', border: c.v ? '' : '1px solid rgb(var(--ink-fg-3))' }}
                  onClick={() => { c.v ? chain().setColor(c.v).run() : chain().unsetColor().run(); setPop(null); }}>
                  {!c.v && <Icon name="close" size={12} />}
                </button>
              ))}
            </div>
          </Popover>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <TBBtn icon="highlight" active={pop === 'highlight' || is('highlight')} onClick={() => setPop(pop === 'highlight' ? null : 'highlight')} title="高亮" />
        {pop === 'highlight' && (
          <Popover onClose={() => setPop(null)}>
            <div className="tb-swatches">
              {HL_COLORS.map((c) => (
                <button key={c.name} className="tb-swatch" title={c.name} style={{ background: c.v || 'transparent', border: c.v ? '' : '1px solid rgb(var(--ink-fg-3))' }}
                  onClick={() => { c.v ? chain().setHighlight({ color: c.v }).run() : chain().unsetHighlight().run(); setPop(null); }}>
                  {!c.v && <Icon name="close" size={12} />}
                </button>
              ))}
            </div>
          </Popover>
        )}
      </div>
      <TBSep />
      <TBBtn icon="listUl" active={is('bulletList')} onClick={() => chain().toggleBulletList().run()} title="无序列表" />
      <TBBtn icon="listOl" active={is('orderedList')} onClick={() => chain().toggleOrderedList().run()} title="有序列表" />
      <TBBtn icon="quote" active={is('blockquote')} onClick={() => chain().toggleBlockquote().run()} title="引用" />
      <TBBtn icon="codeBlock" active={is('codeBlock')} onClick={() => chain().toggleCodeBlock().run()} title="代码块" />
      <TBSep />
      <div style={{ position: 'relative' }}>
        <TBBtn icon="link" active={pop === 'link' || is('link')} onClick={() => { setLinkUrl(editor.getAttributes('link').href || ''); setPop(pop === 'link' ? null : 'link'); }} title="链接 ⌘K" />
        {pop === 'link' && (
          <Popover onClose={() => setPop(null)}>
            <div className="tb-linkbox">
              <input autoFocus value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://…"
                onKeyDown={(e) => { if (e.key === 'Enter') applyLink(); if (e.key === 'Escape') setPop(null); }} />
              <button className="tb-linkgo" onClick={applyLink}>{is('link') && !linkUrl ? '移除' : '应用'}</button>
            </div>
          </Popover>
        )}
      </div>
      <TBBtn icon="image" onClick={() => window.__composeInsertImage?.(editor)} title="插入图片" />
      <TBBtn icon="divider" onClick={() => chain().setHorizontalRule().run()} title="分割线" />
      <TBBtn icon="at" onClick={() => chain().insertContent('@').run()} title="提及某人 @" />
      <div style={{ flex: 1 }} />
      <TBBtn icon="undo" onClick={() => chain().undo().run()} title="撤销 ⌘Z" />
      <TBBtn icon="redo" onClick={() => chain().redo().run()} title="重做" />
    </div>
  );
}

// ── Bubble menu (Notion) ──────────────────────────────────────────────
function BubbleMenu({ editor, coords }) {
  const [pop, setPop] = uES(null);
  const [linkUrl, setLinkUrl] = uES('');
  if (!editor || !coords) return null;
  const is = (n) => editor.isActive(n);
  const chain = () => editor.chain().focus();
  return (
    <div className="rt-bubble glass-pop" style={{ top: coords.top, left: coords.left }} onMouseDown={(e) => e.preventDefault()}>
      <TBBtn icon="bold" active={is('bold')} onClick={() => chain().toggleBold().run()} />
      <TBBtn icon="italic" active={is('italic')} onClick={() => chain().toggleItalic().run()} />
      <TBBtn icon="underline" active={is('underline')} onClick={() => chain().toggleUnderline().run()} />
      <TBBtn icon="strike" active={is('strike')} onClick={() => chain().toggleStrike().run()} />
      <TBSep />
      <TBBtn icon="code" active={is('code')} onClick={() => chain().toggleCode().run()} />
      <div style={{ position: 'relative' }}>
        <TBBtn icon="highlight" active={pop === 'hl'} onClick={() => setPop(pop === 'hl' ? null : 'hl')} />
        {pop === 'hl' && <Popover onClose={() => setPop(null)} align="center"><div className="tb-swatches">
          {HL_COLORS.map((c) => <button key={c.name} className="tb-swatch" style={{ background: c.v || 'transparent', border: c.v ? '' : '1px solid rgb(var(--ink-fg-3))' }}
            onClick={() => { c.v ? chain().setHighlight({ color: c.v }).run() : chain().unsetHighlight().run(); setPop(null); }}>{!c.v && <Icon name="close" size={11} />}</button>)}
        </div></Popover>}
      </div>
      <div style={{ position: 'relative' }}>
        <TBBtn icon="link" active={is('link')} onClick={() => { setLinkUrl(editor.getAttributes('link').href || ''); setPop(pop === 'link' ? null : 'link'); }} />
        {pop === 'link' && <Popover onClose={() => setPop(null)} align="center"><div className="tb-linkbox">
          <input autoFocus value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://…"
            onKeyDown={(e) => { if (e.key === 'Enter') { let u = linkUrl.trim(); if (u && !/^https?:|^mailto:/i.test(u)) u = 'https://' + u; u ? chain().extendMarkRange('link').setLink({ href: u }).run() : chain().unsetLink().run(); setPop(null); } if (e.key === 'Escape') setPop(null); }} />
        </div></Popover>}
      </div>
    </div>
  );
}

// ── Slash + Mention dropdowns ─────────────────────────────────────────
function SuggestList({ state, kind }) {
  if (!state || !state.items.length) return null;
  const { rect, items, index } = state;
  const top = rect.bottom + 6, left = rect.left;
  return (
    <div className="rt-suggest glass-pop" style={{ top: Math.min(top, window.innerHeight - 260), left: Math.min(left, window.innerWidth - 260) }}>
      {kind === 'slash' && <div className="rt-suggest-head">基础块</div>}
      {items.map((it, i) => (
        <div key={it.id || it.email || it.title} className="rt-suggest-item" data-hl={i === index ? '1' : undefined}
          onMouseDown={(e) => { e.preventDefault(); state.select(i); }}>
          {kind === 'mention' ? <Avatar contact={it} size={28} /> : <span className="rt-suggest-icon"><Icon name={it.icon} size={16} /></span>}
          <div className="rt-suggest-main">
            <div className="rt-suggest-title">{kind === 'mention' ? (it.name || it.email) : it.title}</div>
            <div className="rt-suggest-sub">{kind === 'mention' ? it.email : it.subtitle}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RichEditor({ styleMode, initialContent, placeholder, onEditor }) {
  const elRef = uER(null);
  const edRef = uER(null);
  const [, force] = uES(0);
  const [bubble, setBubble] = uES(null);
  const [mention, setMention] = uES(null);
  const [slash, setSlash] = uES(null);
  const mentionRef = uER(null); mentionRef.current = mention;
  const slashRef = uER(null); slashRef.current = slash;
  const styleRef = uER(styleMode); styleRef.current = styleMode;

  uEF(() => {
    const TT = window.TT; if (!TT) return;
    const editor = new TT.Editor({
      element: elRef.current,
      extensions: TT.buildExtensions(placeholder || '写点什么…  输入 “/” 插入块，输入 “@” 提及某人'),
      content: initialContent || '',
      autofocus: false,
      editorProps: { attributes: { class: 'rt-content' } },
    });
    edRef.current = editor;
    onEditor?.(editor);
    window.__composeInsertImage = (ed) => {
      const url = window.prompt('图片地址 (URL)：', 'https://');
      if (url && url !== 'https://') ed.chain().focus().setImage({ src: url }).run();
    };

    // suggestion bridges
    window.__ttSuggest = {
      mention: {
        start: (p) => setMention({ items: p.items, command: p.command, rect: p.clientRect(), index: 0, select: (i) => p.command({ id: p.items[i].email, label: p.items[i].name || p.items[i].email }) }),
        update: (p) => setMention((m) => ({ ...m, items: p.items, command: p.command, rect: p.clientRect(), index: Math.min(m?.index || 0, Math.max(0, p.items.length - 1)), select: (i) => p.command({ id: p.items[i].email, label: p.items[i].name || p.items[i].email }) })),
        exit: () => setMention(null),
        keydown: (p) => {
          const st = mentionRef.current; if (!st || !st.items.length) return false;
          if (p.event.key === 'ArrowDown') { setMention((m) => ({ ...m, index: (m.index + 1) % m.items.length })); return true; }
          if (p.event.key === 'ArrowUp') { setMention((m) => ({ ...m, index: (m.index - 1 + m.items.length) % m.items.length })); return true; }
          if (p.event.key === 'Enter') { st.select(st.index); return true; }
          if (p.event.key === 'Escape') { setMention(null); return true; }
          return false;
        },
      },
      slash: {
        start: (p) => setSlash({ items: p.items, rect: p.clientRect(), index: 0, select: (i) => p.command(p.items[i]) }),
        update: (p) => setSlash((s) => ({ ...s, items: p.items, rect: p.clientRect(), index: Math.min(s?.index || 0, Math.max(0, p.items.length - 1)), select: (i) => p.command(p.items[i]) })),
        exit: () => setSlash(null),
        keydown: (p) => {
          const st = slashRef.current; if (!st || !st.items.length) return false;
          if (p.event.key === 'ArrowDown') { setSlash((s) => ({ ...s, index: (s.index + 1) % s.items.length })); return true; }
          if (p.event.key === 'ArrowUp') { setSlash((s) => ({ ...s, index: (s.index - 1 + s.items.length) % s.items.length })); return true; }
          if (p.event.key === 'Enter') { st.select(st.index); return true; }
          if (p.event.key === 'Escape') { setSlash(null); return true; }
          return false;
        },
      },
    };

    const updateBubble = () => {
      const md = styleRef.current;
      if (md !== 'bubble') { setBubble(null); return; }
      const { state } = editor; const { from, to, empty } = state.selection;
      if (empty || from === to || editor.isActive('codeBlock')) { setBubble(null); return; }
      try {
        const s = editor.view.coordsAtPos(from), e = editor.view.coordsAtPos(to);
        const rootRect = elRef.current.getBoundingClientRect();
        void rootRect;
        setBubble({ top: Math.min(s.top, e.top) - 46, left: (s.left + e.left) / 2 - 120 });
      } catch (_) { setBubble(null); }
    };
    editor.on('transaction', () => force((x) => x + 1));
    editor.on('selectionUpdate', updateBubble);
    editor.on('blur', () => setTimeout(() => { if (styleRef.current === 'bubble') setBubble(null); }, 100));
    return () => { editor.destroy(); };
  }, []);

  // update mention index attr for list highlight already handled by state
  return (
    <div className={'rt-root rt-' + styleMode}>
      {(styleMode === 'classic') && <Toolbar editor={edRef.current} tick={0} variant="top" />}
      {styleMode === 'minimal' && <MinimalToolbar editor={edRef.current} />}
      <div className="rt-scroll">
        <div ref={elRef} className="rt-host" />
      </div>
      {styleMode === 'bottom' && <Toolbar editor={edRef.current} tick={0} variant="bottom" />}
      {styleMode === 'bubble' && bubble && <BubbleMenu editor={edRef.current} coords={bubble} />}
      <SuggestList state={mention} kind="mention" />
      <SuggestList state={slash} kind="slash" />
    </div>
  );
}

// Superhuman-style: nothing persistent except a compact focus row of essentials
function MinimalToolbar({ editor }) {
  if (!editor) return null;
  const is = (n) => editor.isActive(n);
  const chain = () => editor.chain().focus();
  return (
    <div className="rt-toolbar rt-toolbar-minimal">
      <TBBtn icon="bold" active={is('bold')} onClick={() => chain().toggleBold().run()} title="⌘B" />
      <TBBtn icon="italic" active={is('italic')} onClick={() => chain().toggleItalic().run()} title="⌘I" />
      <TBBtn icon="link" active={is('link')} onClick={() => { const u = window.prompt('链接地址：', editor.getAttributes('link').href || 'https://'); if (u != null) { u ? chain().extendMarkRange('link').setLink({ href: /^https?:|^mailto:/i.test(u) ? u : 'https://' + u }).run() : chain().unsetLink().run(); } }} title="⌘K" />
      <TBBtn icon="listUl" active={is('bulletList')} onClick={() => chain().toggleBulletList().run()} title="列表" />
      <TBBtn icon="quote" active={is('blockquote')} onClick={() => chain().toggleBlockquote().run()} title="引用" />
      <span className="rt-minimal-hint">Markdown 可用 · <b>**粗**</b> · <b>#</b> 标题 · <b>&gt;</b> 引用 · <b>```</b> 代码</span>
    </div>
  );
}

Object.assign(window, { RichEditor });
