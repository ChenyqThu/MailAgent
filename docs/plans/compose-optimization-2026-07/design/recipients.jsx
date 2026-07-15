// RecipientField — chips + avatar autocomplete + keyboard nav + paste-split + detail popover.
const { useState, useRef, useEffect, useCallback } = React;

const EMAIL_RE = /[^\s,;<>]+@[^\s,;<>]+\.[^\s,;<>]+/g;

function ExternalDot() {
  return React.createElement('span', {
    title: '外部联系人', style: { width: 6, height: 6, borderRadius: 3, background: 'rgb(var(--c-warn))', flexShrink: 0, boxShadow: '0 0 0 2px rgb(var(--c-warn)/0.18)' },
  });
}

function Chip({ contact, selected, onClick, onRemove }) {
  const ext = contact.external;
  return (
    <span
      className="rcp-chip"
      data-selected={selected ? '1' : undefined}
      data-ext={ext ? '1' : undefined}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={contact.email}
    >
      <Avatar contact={contact} size={18} />
      <span className="rcp-chip-label">{contact.name || contact.email}</span>
      {ext && <ExternalDot />}
      <button className="rcp-chip-x" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }} aria-label="移除">
        <Icon name="close" size={11} strokeWidth={2.4} />
      </button>
    </span>
  );
}

function DetailPopover({ contact, rect, onClose, onRemove, onEdit }) {
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  const top = Math.min(rect.bottom + 6, window.innerHeight - 190);
  const left = Math.min(rect.left, window.innerWidth - 288);
  return (
    <div ref={ref} className="rcp-detail glass-pop" style={{ top, left }}>
      <div className="rcp-detail-head">
        <Avatar contact={contact} size={38} />
        <div style={{ minWidth: 0 }}>
          <div className="rcp-detail-name">{contact.name || contact.email}</div>
          <div className="rcp-detail-mail">{contact.email}</div>
        </div>
      </div>
      {(contact.title || contact.team) && (
        <div className="rcp-detail-meta">
          {contact.title && <div><Icon name="building" size={13} /><span>{contact.title}</span></div>}
          <div>
            <Icon name={contact.external ? 'globe' : 'check'} size={13} style={{ color: contact.external ? 'rgb(var(--c-warn))' : 'rgb(var(--c-ok))' }} />
            <span>{contact.external ? `外部 · ${contact.team || '未知组织'}` : `内部 · ${contact.team || '同事'}`}</span>
          </div>
        </div>
      )}
      <div className="rcp-detail-actions">
        <button onClick={() => { onEdit(); onClose(); }}><Icon name="draft" size={13} />编辑</button>
        <button onClick={() => { navigator.clipboard?.writeText(contact.email); onClose(); }}><Icon name="file" size={13} />复制</button>
        <button className="danger" onClick={() => { onRemove(); onClose(); }}><Icon name="trash" size={13} />移除</button>
      </div>
    </div>
  );
}

function Dropdown({ items, highlight, query, onPick, anchorRef }) {
  if (!items.length && !(query && EMAIL_RE.test(query))) return null;
  const validRaw = query && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.trim());
  return (
    <div className="rcp-drop glass-pop">
      {items.map((c, i) => (
        <div key={c.email} className="rcp-opt" data-hl={i === highlight ? '1' : undefined} onMouseDown={(e) => { e.preventDefault(); onPick(c); }}>
          <Avatar contact={c} size={30} />
          <div className="rcp-opt-main">
            <div className="rcp-opt-name">{c.name || c.email}{c.external && <ExternalDot />}</div>
            <div className="rcp-opt-mail">{c.email}</div>
          </div>
          {c.team && <span className="rcp-opt-team">{c.team}</span>}
        </div>
      ))}
      {validRaw && !items.some((c) => c.email.toLowerCase() === query.trim().toLowerCase()) && (
        <div className="rcp-opt rcp-opt-raw" data-hl={highlight === items.length ? '1' : undefined} onMouseDown={(e) => { e.preventDefault(); onPick(makeContact(query.trim())); }}>
          <span className="rcp-opt-rawicon"><Icon name="plus" size={14} /></span>
          <div className="rcp-opt-main"><div className="rcp-opt-name">添加 “{query.trim()}”</div><div className="rcp-opt-mail">使用这个邮箱地址</div></div>
        </div>
      )}
    </div>
  );
}

function RecipientField({ label, value, onChange, autoFocus, onNavPrevField, extraRight, excludeEmails }) {
  const [input, setInput] = useState('');
  const [chipSel, setChipSel] = useState(null); // index of keyboard-selected chip
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const [detail, setDetail] = useState(null); // {contact, index, rect}
  const [editingIdx, setEditingIdx] = useState(null);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  const exclude = new Set([...(excludeEmails || []), ...value.map((c) => c.email.toLowerCase())]);
  const q = input.trim().toLowerCase();
  const suggestions = q
    ? CONTACTS.filter((c) => !exclude.has(c.email.toLowerCase()) && (c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q) || (c.team || '').toLowerCase().includes(q))).slice(0, 6)
    : [];

  const addContacts = useCallback((arr) => {
    const seen = new Set(value.map((c) => c.email.toLowerCase()));
    const next = [...value];
    arr.forEach((c) => { if (!seen.has(c.email.toLowerCase())) { seen.add(c.email.toLowerCase()); next.push(c); } });
    onChange(next);
  }, [value, onChange]);

  const commitInput = useCallback(() => {
    const matches = input.match(EMAIL_RE);
    if (matches) { addContacts(matches.map(makeContact)); setInput(''); setOpen(false); return true; }
    return false;
  }, [input, addContacts]);

  const pick = (c) => { addContacts([c]); setInput(''); setOpen(false); setHl(0); inputRef.current?.focus(); };
  const removeAt = (i) => { const next = value.filter((_, x) => x !== i); onChange(next); };

  const onKeyDown = (e) => {
    const optCount = suggestions.length + (input.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim()) && !suggestions.some((c) => c.email.toLowerCase() === input.trim().toLowerCase()) ? 1 : 0);
    // chip selection mode (input empty)
    if (chipSel !== null) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); setChipSel(Math.max(0, chipSel - 1)); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); if (chipSel >= value.length - 1) { setChipSel(null); inputRef.current?.focus(); } else setChipSel(chipSel + 1); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); removeAt(chipSel); setChipSel(chipSel > 0 ? chipSel - 1 : (value.length > 1 ? 0 : null)); if (value.length <= 1) inputRef.current?.focus(); return; }
      if (e.key === 'Enter') { e.preventDefault(); const c = value[chipSel]; const rect = wrapRef.current.querySelectorAll('.rcp-chip')[chipSel]?.getBoundingClientRect(); if (rect) setDetail({ contact: c, index: chipSel, rect }); return; }
      if (e.key === 'Escape') { setChipSel(null); inputRef.current?.focus(); return; }
      // any char typed → exit selection, let it fall to input
      if (e.key.length === 1) { setChipSel(null); }
    }
    if (open && optCount) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHl((hl + 1) % optCount); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHl((hl - 1 + optCount) % optCount); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.key === 'Enter') e.preventDefault();
        if (hl < suggestions.length) { pick(suggestions[hl]); if (e.key === 'Tab') e.preventDefault(); }
        else { pick(makeContact(input.trim())); if (e.key === 'Tab') e.preventDefault(); }
        return;
      }
    }
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === ' ' && input.includes('@'))) && input.trim()) {
      if (commitInput()) e.preventDefault();
      return;
    }
    if (e.key === 'Backspace' && !input && value.length) { e.preventDefault(); setChipSel(value.length - 1); return; }
    if (e.key === 'ArrowLeft' && !input && value.length && e.target.selectionStart === 0) { e.preventDefault(); setChipSel(value.length - 1); return; }
    if (e.key === 'Escape') { setOpen(false); }
  };

  const onPaste = (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text && EMAIL_RE.test(text)) { e.preventDefault(); addContacts((text.match(EMAIL_RE) || []).map(makeContact)); setInput(''); }
  };

  useEffect(() => { setHl(0); }, [input]);

  return (
    <div className="rcp-row">
      <span className="rcp-label">{label}</span>
      <div className="rcp-wrap" ref={wrapRef} onClick={(e) => { if (e.target === wrapRef.current) { inputRef.current?.focus(); setChipSel(null); } }}>
        {value.map((c, i) => (
          editingIdx === i ? (
            <input key={c.email + i} className="rcp-editinput" autoFocus defaultValue={c.email}
              onBlur={(e) => { const v = e.target.value.trim(); const next = [...value]; if (v) next[i] = makeContact(v); else next.splice(i, 1); onChange(next); setEditingIdx(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setEditingIdx(null); } }} />
          ) : (
            <Chip key={c.email + i} contact={c} selected={chipSel === i}
              onClick={() => { const rect = wrapRef.current.querySelectorAll('.rcp-chip')[i]?.getBoundingClientRect(); setDetail({ contact: c, index: i, rect }); }}
              onRemove={() => removeAt(i)} />
          )
        ))}
        <input ref={inputRef} className="rcp-input" value={input}
          onChange={(e) => { setInput(e.target.value); setOpen(true); setChipSel(null); }}
          onKeyDown={onKeyDown} onPaste={onPaste} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
          placeholder={value.length ? '' : '姓名或邮箱…'} />
        {open && q && <Dropdown items={suggestions} highlight={hl} query={input} onPick={pick} anchorRef={wrapRef} />}
      </div>
      {extraRight && <div className="rcp-right">{extraRight}</div>}
      {detail && (
        <DetailPopover contact={detail.contact} rect={detail.rect} onClose={() => setDetail(null)}
          onRemove={() => removeAt(detail.index)} onEdit={() => setEditingIdx(detail.index)} />
      )}
    </div>
  );
}

Object.assign(window, { RecipientField });
