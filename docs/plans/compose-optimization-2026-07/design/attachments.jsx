// Attachments — drag-drop tray + thumbnail cards (type icon + size).
const { useState: useStateA } = React;

const KIND_META = {
  pdf: { icon: 'filePdf', color: '#E5654B', ext: 'PDF' },
  sheet: { icon: 'fileSheet', color: '#5DBA8C', ext: 'XLS' },
  doc: { icon: 'fileText', color: '#4A78E5', ext: 'DOC' },
  zip: { icon: 'fileZip', color: '#E59B4A', ext: 'ZIP' },
  image: { icon: 'image', color: '#9C7AE0', ext: 'IMG' },
  text: { icon: 'fileText', color: '#7A8090', ext: 'TXT' },
  file: { icon: 'file', color: '#7A8090', ext: 'FILE' },
};

function kindFromName(name) {
  const e = (name.split('.').pop() || '').toLowerCase();
  if (['pdf'].includes(e)) return 'pdf';
  if (['xls', 'xlsx', 'csv', 'numbers'].includes(e)) return 'sheet';
  if (['doc', 'docx', 'pages', 'ppt', 'pptx', 'key'].includes(e)) return 'doc';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return 'zip';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'bmp'].includes(e)) return 'image';
  if (['txt', 'md', 'log', 'json', 'csv'].includes(e)) return 'text';
  return 'file';
}
function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}
function extLabel(name) { return (name.split('.').pop() || '').toUpperCase().slice(0, 4); }

function AttachCard({ item, onRemove }) {
  const meta = KIND_META[item.kind] || KIND_META.file;
  return (
    <div className="att-card" title={item.name}>
      <div className="att-thumb" style={item.kind === 'image' && item.url ? { padding: 0 } : {}}>
        {item.kind === 'image' && item.url ? (
          <img src={item.url} alt="" />
        ) : (
          <span className="att-thumb-icon" style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 14%, transparent)` }}>
            <Icon name={meta.icon} size={22} strokeWidth={1.8} />
            <span className="att-ext" style={{ color: meta.color }}>{extLabel(item.name)}</span>
          </span>
        )}
        <button className="att-remove" onClick={() => onRemove(item.id)} aria-label="移除附件"><Icon name="close" size={12} strokeWidth={2.6} /></button>
        {item.uploading != null && item.uploading < 100 && (
          <div className="att-progress"><span style={{ width: item.uploading + '%' }} /></div>
        )}
      </div>
      <div className="att-name">{item.name}</div>
      <div className="att-size">{fmtSize(item.size)}{item.uploading != null && item.uploading < 100 ? ' · 上传中' : ''}</div>
    </div>
  );
}

function AttachmentTray({ items, onRemove, onAdd, compact }) {
  const totalSize = items.reduce((s, i) => s + (i.size || 0), 0);
  return (
    <div className="att-tray">
      <div className="att-tray-head">
        <span className="att-tray-title"><Icon name="paperclip" size={13} />{items.length} 个附件 · {fmtSize(totalSize)}</span>
        <button className="att-addbtn" onClick={onAdd}><Icon name="plus" size={13} />添加</button>
      </div>
      <div className="att-grid">
        {items.map((it) => <AttachCard key={it.id} item={it} onRemove={onRemove} />)}
      </div>
    </div>
  );
}

// Build attachment records from a FileList
function filesToItems(fileList) {
  return Array.from(fileList).map((f) => {
    const kind = kindFromName(f.name);
    const rec = { id: 'f' + Math.random().toString(36).slice(2), name: f.name, size: f.size, kind };
    if (kind === 'image') rec.url = URL.createObjectURL(f);
    return rec;
  });
}

Object.assign(window, { AttachmentTray, filesToItems, fmtSize });
