// Compose shells (floating new-mail window + full-window reply pane) + shared body + App.
const { useState: uS, useRef: uR, useEffect: uE, useCallback: uC } = React;

const PRIORITIES = [
  { key: 'normal', label: '普通', color: 'var(--ink-fg-2)' },
  { key: 'high', label: '重要', color: 'var(--c-urg)' },
  { key: 'urgent', label: '紧急', color: 'var(--c-crit)' },
];

function useAttachmentDrop(onFiles) {
  const [over, setOver] = uS(false);
  const depth = uR(0);
  const handlers = {
    onDragEnter: (e) => { e.preventDefault(); depth.current++; if (e.dataTransfer?.types?.includes('Files')) setOver(true); },
    onDragOver: (e) => { e.preventDefault(); },
    onDragLeave: (e) => { e.preventDefault(); depth.current--; if (depth.current <= 0) { setOver(false); depth.current = 0; } },
    onDrop: (e) => { e.preventDefault(); depth.current = 0; setOver(false); if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files); },
  };
  return [over, handlers];
}

function ComposeFields({ to, setTo, cc, setCc, bcc, setBcc, showCc, showBcc, setShowCc, setShowBcc, subject, setSubject, priority, setPriority, mode }) {
  const [priOpen, setPriOpen] = uS(false);
  const pri = PRIORITIES.find((p) => p.key === priority) || PRIORITIES[0];
  const allEmails = (a) => a.map((c) => c.email.toLowerCase());
  return (
    <div className="cmp-fields">
      <RecipientField label="收件人" value={to} onChange={setTo} autoFocus={mode === 'floating'}
        excludeEmails={[...allEmails(cc), ...allEmails(bcc)]}
        extraRight={(!showCc || !showBcc) && (
          <div className="cmp-ccbcc">
            {!showCc && <button onClick={() => setShowCc(true)}>抄送</button>}
            {!showBcc && <button onClick={() => setShowBcc(true)}>密送</button>}
          </div>
        )} />
      {showCc && (
        <RecipientField label="抄送" value={cc} onChange={setCc} excludeEmails={[...allEmails(to), ...allEmails(bcc)]}
          extraRight={<button className="cmp-fieldx" onClick={() => { setCc([]); setShowCc(false); }} title="收起抄送"><Icon name="close" size={13} /></button>} />
      )}
      {showBcc && (
        <RecipientField label="密送" value={bcc} onChange={setBcc} excludeEmails={[...allEmails(to), ...allEmails(cc)]}
          extraRight={<button className="cmp-fieldx" onClick={() => { setBcc([]); setShowBcc(false); }} title="收起密送"><Icon name="close" size={13} /></button>} />
      )}
      <div className="cmp-subject-row">
        <span className="rcp-label">主题</span>
        <input className="cmp-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="添加主题" />
        <div className="cmp-pri" style={{ position: 'relative' }}>
          <button className="cmp-pri-btn" onClick={() => setPriOpen(!priOpen)} style={{ color: `rgb(${pri.color})` }}>
            <Icon name="flag" size={13} /><span>{pri.label}</span><Icon name="chevronDown" size={11} />
          </button>
          {priOpen && (
            <Popover onClose={() => setPriOpen(false)} align="right">
              {PRIORITIES.map((p) => (
                <button key={p.key} className="tb-menuitem" data-active={p.key === priority ? '1' : undefined} onClick={() => { setPriority(p.key); setPriOpen(false); }}>
                  <Icon name="flag" size={13} style={{ color: `rgb(${p.color})` }} /><span>{p.label}</span>
                </button>
              ))}
            </Popover>
          )}
        </div>
      </div>
    </div>
  );
}

function ComposeCore({ mode, editorStyle, onClose }) {
  const reply = mode === 'fullwindow';
  const [to, setTo] = uS(reply ? REPLY_META.to.map(makeContact) : []);
  const [cc, setCc] = uS(reply ? REPLY_META.cc.map(makeContact) : []);
  const [bcc, setBcc] = uS([]);
  const [showCc, setShowCc] = uS(reply && REPLY_META.cc.length > 0);
  const [showBcc, setShowBcc] = uS(false);
  const [subject, setSubject] = uS(reply ? REPLY_META.subject : '');
  const [priority, setPriority] = uS('normal');
  const [attachments, setAttachments] = uS(reply ? SEED_ATTACHMENTS : []);
  const [quotedOpen, setQuotedOpen] = uS(false);
  const [sent, setSent] = uS(false);
  const editorRef = uR(null);
  const fileRef = uR(null);

  const addFiles = uC((fl) => setAttachments((a) => [...a, ...filesToItems(fl)]), []);
  const [dragOver, dropHandlers] = useAttachmentDrop(addFiles);

  const send = () => { setSent(true); setTimeout(() => { setSent(false); onClose?.(); }, 1500); };

  const fieldsProps = { to, setTo, cc, setCc, bcc, setBcc, showCc, showBcc, setShowCc, setShowBcc, subject, setSubject, priority, setPriority, mode };
  const toolbarLabel = { classic: '经典精炼', bubble: 'Notion 浮出', minimal: 'Superhuman 极简', bottom: 'Gmail 底栏' }[editorStyle];

  const actions = (
    <>
      <button className="acc-cta cmp-send" onClick={send}><Icon name="send" size={15} />发送<kbd className="cmp-kbd">⌘↩</kbd></button>
      <button className="cmp-ghost" onClick={onClose ? onClose : send}><Icon name="draft" size={15} />存草稿</button>
      <button className="cmp-ghost" title="丢弃" onClick={onClose}><Icon name="trash" size={15} /></button>
      <span className="cmp-abar-sep" />
      <button className="cmp-ghost" onClick={() => fileRef.current?.click()} title="附件"><Icon name="paperclip" size={15} /></button>
      <button className="cmp-ghost" title="签名"><Icon name="sign" size={15} /></button>
      <button className="cmp-ghost" title="定时发送"><Icon name="clock" size={15} /></button>
      <div style={{ flex: 1 }} />
      <button className="cmp-ai" title="AI 润色"><Icon name="sparkle" size={14} />AI 润色</button>
    </>
  );

  return (
    <div className="cmp-core" {...dropHandlers}>
      <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }} />
      {reply ? (
        <div className="cmp-topbar">
          <div className="cmp-topbar-actions">{actions}</div>
          <div className="cmp-topbar-subj">{subject}</div>
        </div>
      ) : null}

      <div className="cmp-scroll scrollbar-thin">
        <ComposeFields {...fieldsProps} />
        <div className="cmp-editor-region">
          <RichEditor styleMode={editorStyle} onEditor={(ed) => (editorRef.current = ed)}
            initialContent={reply ? REPLY_SEED : ''} placeholder={reply ? '写下你的回复…' : '写点什么…  “/” 插入块，“@” 提及'} />
        </div>

        {attachments.length > 0 && <AttachmentTray items={attachments} onRemove={(id) => setAttachments((a) => a.filter((x) => x.id !== id))} onAdd={() => fileRef.current?.click()} />}
        {attachments.length === 0 && (
          <button className="cmp-dropzone" onClick={() => fileRef.current?.click()}>
            <Icon name="paperclip" size={16} /><span>拖拽文件到此，或<b>点击添加附件</b></span>
          </button>
        )}

        {reply && (
          <div className="cmp-quoted">
            <button className="cmp-quoted-toggle" onClick={() => setQuotedOpen(!quotedOpen)}>
              <Icon name={quotedOpen ? 'chevronDown' : 'chevronRight'} size={14} />引用原文
            </button>
            {quotedOpen && (
              <div className="cmp-quoted-body">
                <p>在 2026年7月8日，曾东彪 &lt;zengdongbiao@tp-link.com.hk&gt; 写道：</p>
                <blockquote>嗯嗯。另外，之前免费云是亚太需求最强的一块，Reyee Cloud 的功能覆盖上我们确实还有差距……</blockquote>
              </div>
            )}
          </div>
        )}
      </div>

      {!reply && <div className="cmp-abar">{actions}</div>}

      {dragOver && (
        <div className="cmp-dropoverlay"><div className="cmp-dropoverlay-inner"><Icon name="download" size={30} /><div>松手添加为附件</div></div></div>
      )}
      {sent && (
        <div className="cmp-sent"><div className="cmp-sent-inner"><span className="cmp-sent-check"><Icon name="check" size={26} strokeWidth={3} /></span>已发送</div></div>
      )}

      <div className="cmp-editorbadge">编辑器：{toolbarLabel}</div>
    </div>
  );
}

function FloatingShell({ editorStyle, onClose }) {
  const [max, setMax] = uS(false);
  const [pos, setPos] = uS({ x: 0, y: 0 });
  const drag = uR(null);
  const onHeaderDown = (e) => {
    if (max) return;
    drag.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y };
    const move = (ev) => setPos({ x: drag.current.px + (ev.clientX - drag.current.sx), y: drag.current.py + (ev.clientY - drag.current.sy) });
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  return (
    <div className="cmp-float-layer">
      <div className="cmp-float-scrim" onClick={onClose} />
      <div className={'cmp-float glass-pop' + (max ? ' cmp-float-max' : '')} style={max ? {} : { transform: `translate(${pos.x}px, ${pos.y}px)` }}>
        <div className="cmp-float-header" onMouseDown={onHeaderDown} onDoubleClick={() => setMax(!max)}>
          <Icon name="draft" size={15} /><span className="cmp-float-title">新邮件</span>
          <div className="cmp-float-winbtns">
            <button onClick={() => setMax(!max)} title={max ? '还原' : '最大化'}><Icon name={max ? 'minimize' : 'expand'} size={13} /></button>
            <button onClick={onClose} title="关闭"><Icon name="close" size={14} /></button>
          </div>
        </div>
        <ComposeCore mode="floating" editorStyle={editorStyle} onClose={onClose} />
      </div>
    </div>
  );
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [floatOpen, setFloatOpen] = uS(true);

  uE(() => {
    const r = document.documentElement;
    r.setAttribute('data-theme', t.theme);
    if (t.accent && t.accent !== 'coral') r.setAttribute('data-accent', t.accent); else r.removeAttribute('data-accent');
    if (t.surface === 'solid') r.setAttribute('data-surface', 'solid'); else r.removeAttribute('data-surface');
  }, [t.theme, t.accent, t.surface]);

  const [ready, setReady] = uS(!!window.__ttReady);
  uE(() => { if (window.__ttReady) { setReady(true); return; } const h = () => setReady(true); window.addEventListener('tt-ready', h); return () => window.removeEventListener('tt-ready', h); }, []);
  uE(() => { if (t.mode === 'floating') setFloatOpen(true); }, [t.mode]);

  if (!ready) return <div className="cmp-loading">正在加载富文本引擎 (TipTap)…</div>;

  return (
    <div className="cmp-stage">
      {t.mode === 'fullwindow' ? (
        <FauxApp><ComposeCore mode="fullwindow" editorStyle={t.editorStyle} /></FauxApp>
      ) : (
        <FauxApp dim><FauxRead /></FauxApp>
      )}
      {t.mode === 'floating' && (floatOpen
        ? <FloatingShell editorStyle={t.editorStyle} onClose={() => setFloatOpen(false)} />
        : <button className="cmp-reopen acc-cta" onClick={() => setFloatOpen(true)}><Icon name="draft" size={16} />写新邮件</button>)}

      <DemoDock t={t} setTweak={setTweak} />

      <TweaksPanel>
        <TweakSection label="呈现形态" />
        <TweakRadio label="模式" value={t.mode} options={[{ value: 'floating', label: '新邮件浮窗' }, { value: 'fullwindow', label: '回复全窗' }]} onChange={(v) => setTweak('mode', v)} />
        <TweakSection label="富文本编辑器方向" />
        <TweakSelect label="工具风格" value={t.editorStyle}
          options={[{ value: 'classic', label: '经典精炼工具栏' }, { value: 'bubble', label: 'Notion · 浮出气泡 + /命令' }, { value: 'minimal', label: 'Superhuman · 极简 Markdown' }, { value: 'bottom', label: 'Gmail · 底部工具条' }]}
          onChange={(v) => setTweak('editorStyle', v)} />
        <TweakSection label="主题 / 材质" />
        <TweakRadio label="明暗" value={t.theme} options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} onChange={(v) => setTweak('theme', v)} />
        <TweakSelect label="配色" value={t.accent} options={[{ value: 'cobalt', label: '钴蓝 Cobalt' }, { value: 'coral', label: '珊瑚 Coral' }, { value: 'teal', label: '青 Teal' }, { value: 'rose', label: '玫 Rose' }, { value: 'slate', label: '石板 Slate' }, { value: 'olive', label: '橄榄 Olive' }]} onChange={(v) => setTweak('accent', v)} />
        <TweakRadio label="材质" value={t.surface} options={[{ value: 'frosted', label: '磨砂' }, { value: 'solid', label: '实色' }]} onChange={(v) => setTweak('surface', v)} />
      </TweaksPanel>
    </div>
  );
}

Object.assign(window, { App });

// ─── Always-visible demo control dock (so styles/themes are switchable without host edit-mode) ───
function Seg({ label, value, options, onChange }) {
  return (
    <div className="dock-group">
      <span className="dock-label">{label}</span>
      <div className="dock-seg">
        {options.map((o) => (
          <button key={o.value} data-on={o.value === value ? '1' : undefined} onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}
function DemoDock({ t, setTweak }) {
  const [open, setOpen] = uS(true);
  const ACCENTS = [
    { v: 'cobalt', c: '#345FB2' }, { v: 'coral', c: '#A43C33' }, { v: 'teal', c: '#00755F' },
    { v: 'rose', c: '#9E3A64' }, { v: 'slate', c: '#52657A' }, { v: 'olive', c: '#596C17' },
  ];
  const darkAccent = { cobalt: '#7EADFF', coral: '#F88A7D', teal: '#37C7AE', rose: '#F188AF', slate: '#9EB0C4', olive: '#A3B96C' };
  return (
    <div className={'dock glass-pop' + (open ? '' : ' dock-collapsed')}>
      <button className="dock-toggle" onClick={() => setOpen(!open)} title={open ? '收起' : '展开控制台'}>
        <Icon name={open ? 'chevronDown' : 'sparkle'} size={15} />
      </button>
      {open && (
        <div className="dock-body">
          <Seg label="模式" value={t.mode} options={[{ value: 'floating', label: '新邮件浮窗' }, { value: 'fullwindow', label: '回复全窗' }]} onChange={(v) => setTweak('mode', v)} />
          <span className="dock-div" />
          <Seg label="编辑器方向" value={t.editorStyle} options={[{ value: 'classic', label: '经典' }, { value: 'bubble', label: 'Notion' }, { value: 'minimal', label: '极简' }, { value: 'bottom', label: 'Gmail' }]} onChange={(v) => setTweak('editorStyle', v)} />
          <span className="dock-div" />
          <Seg label="主题" value={t.theme} options={[{ value: 'light', label: '浅' }, { value: 'dark', label: '深' }]} onChange={(v) => setTweak('theme', v)} />
          <div className="dock-group">
            <span className="dock-label">配色</span>
            <div className="dock-swatches">
              {ACCENTS.map((a) => (
                <button key={a.v} className="dock-swatch" data-on={t.accent === a.v ? '1' : undefined} style={{ background: t.theme === 'dark' ? darkAccent[a.v] : a.c }} onClick={() => setTweak('accent', a.v)} title={a.v} />
              ))}
            </div>
          </div>
          <span className="dock-div" />
          <Seg label="材质" value={t.surface} options={[{ value: 'frosted', label: '磨砂' }, { value: 'solid', label: '实色' }]} onChange={(v) => setTweak('surface', v)} />
        </div>
      )}
    </div>
  );
}
Object.assign(window, { DemoDock });
