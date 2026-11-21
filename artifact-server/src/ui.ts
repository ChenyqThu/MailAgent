import type {
  ArtifactLinks,
  ArtifactListItem,
  ArtifactRow,
  CommentRow,
  VersionRow
} from './types'

function escapeHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

const BASE_CSS = `
:root {
  --bg: #f8f7f4;
  --surface: #ffffff;
  --surface-muted: #f1efe9;
  --border: rgba(22, 24, 29, 0.10);
  --border-strong: rgba(22, 24, 29, 0.18);
  --ink: #16181d;
  --ink-2: #4b515d;
  --ink-3: #6e7582;
  --accent: #0f766e;
  --accent-hover: #0d5e57;
  --accent-soft: rgba(15, 118, 110, 0.10);
  --warn: #b45309;
  --warn-soft: rgba(180, 83, 9, 0.10);
  --danger: #b91c1c;
  --danger-soft: rgba(185, 28, 28, 0.10);
  --sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 14px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
button, input, select, textarea { font-family: inherit; font-size: 14px; }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--ink); font-weight: 500; cursor: pointer; transition: background 120ms, border-color 120ms; }
.btn:hover { background: var(--surface-muted); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #ffffff; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-danger { color: var(--danger); border-color: rgba(185, 28, 28, 0.25); }
.btn-danger:hover { background: var(--danger-soft); }
.pill { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; background: var(--surface-muted); color: var(--ink-2); border: 1px solid var(--border); }
.pill-accent { background: var(--accent-soft); color: var(--accent); border-color: rgba(15, 118, 110, 0.22); }
.pill-warn { background: var(--warn-soft); color: var(--warn); border-color: rgba(180, 83, 9, 0.22); }
`

export function renderLoginPage(serverName: string, nextPath: string, errorMsg?: string): string {
  const safeNext = /^\/(?!\/)/.test(nextPath) ? nextPath : '/'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign In · ${escapeHtml(serverName)}</title>
  <style>
    ${BASE_CSS}
    body { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .card { width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 28px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
    .logo { width: 32px; height: 32px; border-radius: 8px; background: var(--accent); color: #fff; display: grid; place-items: center; font-weight: 700; }
    h1 { margin: 0; font-size: 18px; font-weight: 600; }
    p { margin: 6px 0 18px; color: var(--ink-2); font-size: 14px; }
    label { display: block; margin-bottom: 6px; font-weight: 500; color: var(--ink-2); }
    input[type="password"] { width: 100%; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--ink); outline: none; }
    input[type="password"]:focus { border-color: var(--accent); background: var(--surface); }
    .submit { width: 100%; margin-top: 14px; justify-content: center; padding: 9px 14px; }
    .err { margin-top: 12px; padding: 8px 10px; border-radius: 7px; background: var(--danger-soft); color: var(--danger); font-size: 13px; display: ${errorMsg ? 'block' : 'none'}; }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <div class="logo">C</div>
      <div>
        <h1>${escapeHtml(serverName)}</h1>
      </div>
    </div>
    <p>Sign in with the workspace admin password or agent token to browse and manage artifacts.</p>
    <form id="login-form">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus placeholder="Enter admin password" />
      <button type="submit" class="btn btn-primary submit">Sign In</button>
      <div id="err" class="err">${escapeHtml(errorMsg ?? '')}</div>
    </form>
  </main>
  <script>
    const nextPath = ${safeJsonForScript(safeNext)};
    const form = document.getElementById('login-form');
    const errEl = document.getElementById('err');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.style.display = 'none';
      const password = document.getElementById('password').value;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          errEl.textContent = data.error || 'Authentication failed';
          errEl.style.display = 'block';
          return;
        }
        window.location.assign(nextPath);
      } catch {
        errEl.textContent = 'Network error while signing in';
        errEl.style.display = 'block';
      }
    });
  </script>
</body>
</html>`
}

export function renderGalleryPage(
  serverName: string,
  baseUrl: string,
  items: ArtifactListItem[]
): string {
  const initialData = items.map((item) => {
    const shareUrl =
      item.visibility === 'public'
        ? `${baseUrl}/a/${encodeURIComponent(item.slug)}/v/${Math.max(1, item.latest_version)}`
        : `${baseUrl}/s/${encodeURIComponent(item.share_token)}?v=${Math.max(1, item.latest_version)}`
    const reviewUrl = `${baseUrl}/a/${encodeURIComponent(item.slug)}`
    return {
      slug: item.slug,
      title: item.title,
      artifact_type: item.artifact_type,
      project: item.project,
      visibility: item.visibility,
      latest_version: item.latest_version,
      open_comment_count: Number(item.open_comment_count ?? 0),
      updated_at: item.updated_at,
      review_url: reviewUrl,
      share_url: shareUrl
    }
  })

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(serverName)}</title>
  <style>
    ${BASE_CSS}
    header { position: sticky; top: 0; z-index: 10; background: rgba(248, 247, 244, 0.92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
    .topbar { max-width: 1180px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 16px; }
    .logo { width: 28px; height: 28px; border-radius: 7px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 14px; font-weight: 700; }
    .wrap { max-width: 1180px; margin: 0 auto; padding: 24px; }
    .controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
    .search { min-width: 240px; flex: 1; max-width: 380px; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--surface); }
    .tabs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .tab { padding: 5px 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--ink-2); cursor: pointer; font-size: 13px; }
    .tab.active { background: var(--ink); color: #fff; border-color: var(--ink); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 16px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 12px; transition: border-color 120ms; }
    .card:hover { border-color: var(--border-strong); }
    .card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .card-title { font-weight: 600; font-size: 15px; color: var(--ink); word-break: break-word; }
    .card-slug { font-size: 12px; color: var(--ink-3); margin-top: 2px; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 10px; border-top: 1px solid var(--border); margin-top: auto; }
    .empty { text-align: center; padding: 64px 20px; background: var(--surface); border: 1px dashed var(--border-strong); border-radius: 12px; color: var(--ink-2); }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <div class="brand">
        <span class="logo">C</span>
        <span>${escapeHtml(serverName)}</span>
        <span class="pill mono" id="total-pill">${items.length}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <button id="logout-btn" type="button" class="btn">Sign Out</button>
      </div>
    </div>
  </header>
  <main class="wrap">
    <div class="controls">
      <input id="search-input" class="search" type="search" placeholder="Filter by title, slug, or project..." />
      <div class="tabs" id="type-tabs">
        <button type="button" class="tab active" data-type="all">All</button>
        <button type="button" class="tab" data-type="dashboard">Dashboard</button>
        <button type="button" class="tab" data-type="slides">Slides</button>
        <button type="button" class="tab" data-type="report">Report</button>
        <button type="button" class="tab" data-type="diagram">Diagram</button>
        <button type="button" class="tab" data-type="app">App</button>
      </div>
    </div>
    <div id="grid" class="grid"></div>
    <div id="empty" class="empty" style="display:none;">
      <div style="font-weight:600;font-size:15px;margin-bottom:6px;">No matching artifacts yet</div>
      <div>Publish an HTML5 dashboard, deck, or prototype from MailAgent via MCP <code class="mono">artifact_publish</code>.</div>
    </div>
  </main>
  <script>
    const ITEMS = ${safeJsonForScript(initialData)};
    let activeType = 'all';
    const grid = document.getElementById('grid');
    const empty = document.getElementById('empty');
    const searchInput = document.getElementById('search-input');

    function fmtDate(sec) {
      if (!sec) return '';
      return new Date(sec * 1000).toLocaleString();
    }

    function render() {
      const q = (searchInput.value || '').trim().toLowerCase();
      const filtered = ITEMS.filter((item) => {
        if (activeType !== 'all' && item.artifact_type !== activeType) return false;
        if (!q) return true;
        return item.title.toLowerCase().includes(q) || item.slug.toLowerCase().includes(q) || item.project.toLowerCase().includes(q);
      });
      grid.replaceChildren();
      empty.style.display = filtered.length === 0 ? 'block' : 'none';
      for (const item of filtered) {
        const card = document.createElement('article');
        card.className = 'card';

        const top = document.createElement('div');
        top.className = 'card-top';
        const titleBox = document.createElement('div');
        const link = document.createElement('a');
        link.href = item.review_url;
        link.className = 'card-title';
        link.textContent = item.title;
        const slugEl = document.createElement('div');
        slugEl.className = 'card-slug mono';
        slugEl.textContent = item.slug + ' · ' + item.project;
        titleBox.append(link, slugEl);

        const verPill = document.createElement('span');
        verPill.className = 'pill pill-accent mono';
        verPill.textContent = 'v' + item.latest_version;
        top.append(titleBox, verPill);

        const meta = document.createElement('div');
        meta.className = 'meta';
        const typePill = document.createElement('span');
        typePill.className = 'pill';
        typePill.textContent = item.artifact_type;
        const visPill = document.createElement('span');
        visPill.className = 'pill';
        visPill.textContent = item.visibility;
        meta.append(typePill, visPill);
        if (item.open_comment_count > 0) {
          const cmtPill = document.createElement('span');
          cmtPill.className = 'pill pill-warn mono';
          cmtPill.textContent = item.open_comment_count + ' open';
          meta.append(cmtPill);
        }

        const timeEl = document.createElement('div');
        timeEl.style.cssText = 'font-size:12px;color:var(--ink-3);';
        timeEl.textContent = 'Updated ' + fmtDate(item.updated_at);

        const actions = document.createElement('div');
        actions.className = 'actions';
        const openBtn = document.createElement('a');
        openBtn.href = item.review_url;
        openBtn.className = 'btn btn-primary';
        openBtn.textContent = 'Review';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn';
        copyBtn.textContent = 'Copy Share Link';
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(item.share_url);
            copyBtn.textContent = 'Copied';
            setTimeout(() => { copyBtn.textContent = 'Copy Share Link'; }, 1600);
          } catch {}
        });
        actions.append(openBtn, copyBtn);
        card.append(top, meta, timeEl, actions);
        grid.append(card);
      }
    }

    document.getElementById('type-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-type]');
      if (!btn) return;
      activeType = btn.dataset.type || 'all';
      for (const el of document.querySelectorAll('#type-tabs .tab')) {
        el.classList.toggle('active', el === btn);
      }
      render();
    });
    searchInput.addEventListener('input', render);
    document.getElementById('logout-btn').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.assign('/login');
    });
    render();
  </script>
</body>
</html>`
}

export function renderReviewPage(opts: {
  serverName: string
  artifact: ArtifactRow
  versions: VersionRow[]
  activeVersion: VersionRow
  comments: CommentRow[]
  links: ArtifactLinks
  isOwner: boolean
  shareToken: string | null
  defaultAuthor: string
}): string {
  const { serverName, artifact, versions, activeVersion, comments, links, isOwner, shareToken, defaultAuthor } =
    opts

  const bootState = {
    slug: artifact.slug,
    activeVersion: activeVersion.version,
    visibility: artifact.visibility,
    isOwner,
    shareToken,
    shareUrl: links.share_url,
    rawUrl: links.raw_url,
    defaultAuthor,
    comments,
    versions: versions.map((v) => ({
      version: v.version,
      change_note: v.change_note,
      url: shareToken
        ? `/s/${encodeURIComponent(shareToken)}?v=${v.version}`
        : `/a/${encodeURIComponent(artifact.slug)}/v/${v.version}`
    }))
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(artifact.title)} · v${activeVersion.version} · ${escapeHtml(serverName)}</title>
  <style>
    ${BASE_CSS}
    html, body { height: 100%; overflow: hidden; }
    .shell { display: flex; flex-direction: column; height: 100vh; }
    .studio-bar { height: 52px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 16px; background: var(--surface); border-bottom: 1px solid var(--border); overflow-x: auto; }
    .bar-left, .bar-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; }
    .select { padding: 5px 8px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--ink); }
    .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 7px; padding: 2px; background: var(--surface-muted); }
    .seg button { border: 0; background: transparent; padding: 3px 9px; border-radius: 5px; cursor: pointer; font-size: 13px; color: var(--ink-2); }
    .seg button.active { background: var(--surface); color: var(--ink); font-weight: 500; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
    .workspace { flex: 1; min-height: 0; display: flex; }
    .stage { flex: 1; min-width: 0; background: var(--surface-muted); display: flex; align-items: stretch; justify-content: center; padding: 0; overflow: hidden; }
    .stage.mobile { padding: 20px; }
    iframe { width: 100%; height: 100%; border: 0; background: #ffffff; }
    .stage.mobile iframe { width: 390px; max-width: 100%; border-radius: 14px; border: 1px solid var(--border-strong); box-shadow: 0 8px 24px rgba(0,0,0,0.08); }
    .drawer { width: 350px; flex-shrink: 0; background: var(--surface); border-left: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
    .drawer.hidden { display: none; }
    .drawer-head { padding: 12px 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 600; }
    .cmt-list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .cmt { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); }
    .cmt.resolved { opacity: 0.65; }
    .cmt-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px; font-size: 12px; color: var(--ink-2); }
    .cmt-body { font-size: 14px; white-space: pre-wrap; word-break: break-word; }
    .cmt-form { padding: 12px 14px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; background: var(--surface); }
    .cmt-form input, .cmt-form textarea { width: 100%; padding: 7px 10px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--bg); }
    .cmt-form textarea { min-height: 70px; resize: vertical; }
    @media (max-width: 860px) { .drawer { position: fixed; right: 0; top: 52px; bottom: 0; z-index: 20; width: min(360px, 100vw); } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="studio-bar">
      <div class="bar-left">
        ${isOwner ? '<a href="/" class="btn">← Gallery</a>' : ''}
        <span class="title" title="${escapeHtml(artifact.title)}">${escapeHtml(artifact.title)}</span>
        <span class="pill">${escapeHtml(artifact.artifact_type)}</span>
        <select id="version-select" class="select mono" aria-label="Select version"></select>
      </div>
      <div class="bar-right">
        <div class="seg" role="group" aria-label="Viewport">
          <button type="button" id="vp-desktop" class="active">Desktop</button>
          <button type="button" id="vp-mobile">390px</button>
        </div>
        ${
          isOwner
            ? `<select id="vis-select" class="select" aria-label="Visibility">
                <option value="unlisted">Unlisted link</option>
                <option value="public">Public</option>
                <option value="private">Private</option>
              </select>`
            : ''
        }
        <button type="button" id="copy-share-btn" class="btn">Copy Share Link</button>
        <a id="raw-link" href="${escapeHtml(links.raw_url)}" target="_blank" rel="noopener" class="btn">Open Raw</a>
        <button type="button" id="toggle-comments-btn" class="btn btn-primary">Comments (<span id="open-count" class="mono">0</span>)</button>
        ${isOwner ? '<button type="button" id="delete-btn" class="btn btn-danger">Delete</button>' : ''}
      </div>
    </header>
    <div class="workspace">
      <main id="stage" class="stage">
        <iframe id="preview-frame" title="${escapeHtml(artifact.title)}" src="${escapeHtml(links.raw_url)}" sandbox="allow-scripts allow-popups allow-forms allow-modals"></iframe>
      </main>
      <aside id="comments-drawer" class="drawer">
        <div class="drawer-head">
          <span>Review Comments</span>
          <label style="display:inline-flex;align-items:center;gap:5px;font-weight:400;font-size:13px;color:var(--ink-2);">
            <input type="checkbox" id="filter-current-ver" />
            <span>v${activeVersion.version} only</span>
          </label>
        </div>
        <div id="cmt-list" class="cmt-list"></div>
        <form id="cmt-form" class="cmt-form">
          <div style="display:flex;gap:8px;">
            <input id="cmt-author" type="text" placeholder="Your name" maxlength="80" />
            <input id="cmt-anchor" type="text" placeholder="Section (optional)" maxlength="120" />
          </div>
          <textarea id="cmt-body" placeholder="Leave feedback on v${activeVersion.version}..." required maxlength="4000"></textarea>
          <button type="submit" class="btn btn-primary" style="justify-content:center;">Post Comment on v${activeVersion.version}</button>
        </form>
      </aside>
    </div>
  </div>
  <script>
    const STATE = ${safeJsonForScript(bootState)};
    let comments = STATE.comments || [];
    const tokenQs = STATE.shareToken ? '?t=' + encodeURIComponent(STATE.shareToken) : '';

    const verSelect = document.getElementById('version-select');
    for (const v of STATE.versions) {
      const opt = document.createElement('option');
      opt.value = v.url;
      opt.textContent = 'v' + v.version + (v.change_note ? ' · ' + v.change_note.slice(0, 28) : '');
      if (v.version === STATE.activeVersion) opt.selected = true;
      verSelect.append(opt);
    }
    verSelect.addEventListener('change', () => {
      if (verSelect.value) window.location.assign(verSelect.value);
    });

    const stage = document.getElementById('stage');
    const vpDesktop = document.getElementById('vp-desktop');
    const vpMobile = document.getElementById('vp-mobile');
    vpDesktop.addEventListener('click', () => {
      stage.classList.remove('mobile');
      vpDesktop.classList.add('active');
      vpMobile.classList.remove('active');
    });
    vpMobile.addEventListener('click', () => {
      stage.classList.add('mobile');
      vpMobile.classList.add('active');
      vpDesktop.classList.remove('active');
    });

    const copyBtn = document.getElementById('copy-share-btn');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(STATE.shareUrl);
        copyBtn.textContent = 'Copied Link';
        setTimeout(() => { copyBtn.textContent = 'Copy Share Link'; }, 1600);
      } catch {}
    });

    const drawer = document.getElementById('comments-drawer');
    document.getElementById('toggle-comments-btn').addEventListener('click', () => {
      drawer.classList.toggle('hidden');
    });

    const authorInput = document.getElementById('cmt-author');
    authorInput.value = STATE.defaultAuthor || 'Reviewer';

    const cmtList = document.getElementById('cmt-list');
    const filterCurrent = document.getElementById('filter-current-ver');
    const openCountEl = document.getElementById('open-count');

    function renderComments() {
      const openCount = comments.filter((c) => c.status === 'open').length;
      openCountEl.textContent = String(openCount);
      const visible = filterCurrent.checked
        ? comments.filter((c) => c.version === STATE.activeVersion)
        : comments;
      cmtList.replaceChildren();
      if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:var(--ink-3);padding:16px 4px;';
        empty.textContent = 'No comments yet for this view.';
        cmtList.append(empty);
        return;
      }
      for (const c of visible) {
        const card = document.createElement('div');
        card.className = 'cmt' + (c.status === 'resolved' ? ' resolved' : '');

        const top = document.createElement('div');
        top.className = 'cmt-top';
        const left = document.createElement('span');
        left.textContent = c.author + ' · v' + c.version + (c.anchor ? ' · ' + c.anchor : '');

        const right = document.createElement('span');
        right.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
        const badge = document.createElement('span');
        badge.className = 'pill ' + (c.status === 'resolved' ? '' : 'pill-warn');
        badge.textContent = c.status;

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'btn';
        toggleBtn.style.cssText = 'padding:2px 7px;font-size:12px;';
        toggleBtn.textContent = c.status === 'resolved' ? 'Reopen' : 'Resolve';
        toggleBtn.addEventListener('click', async () => {
          const nextStatus = c.status === 'resolved' ? 'open' : 'resolved';
          const res = await fetch('/api/artifacts/' + encodeURIComponent(STATE.slug) + '/comments/' + encodeURIComponent(c.id) + tokenQs, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: nextStatus })
          });
          if (res.ok) {
            const payload = await res.json();
            comments = comments.map((row) => (row.id === c.id ? payload.comment : row));
            renderComments();
          }
        });
        right.append(badge, toggleBtn);
        top.append(left, right);

        const body = document.createElement('div');
        body.className = 'cmt-body';
        body.textContent = c.body;
        card.append(top, body);
        cmtList.append(card);
      }
    }

    filterCurrent.addEventListener('change', renderComments);
    document.getElementById('cmt-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const bodyInput = document.getElementById('cmt-body');
      const anchorInput = document.getElementById('cmt-anchor');
      const res = await fetch('/api/artifacts/' + encodeURIComponent(STATE.slug) + '/comments' + tokenQs, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: STATE.activeVersion,
          author: authorInput.value.trim() || 'Reviewer',
          anchor: anchorInput.value.trim() || undefined,
          body: bodyInput.value.trim()
        })
      });
      if (res.ok) {
        const payload = await res.json();
        comments = [...comments, payload.comment];
        bodyInput.value = '';
        anchorInput.value = '';
        renderComments();
      }
    });

    const visSelect = document.getElementById('vis-select');
    if (visSelect) {
      visSelect.value = STATE.visibility;
      visSelect.addEventListener('change', async () => {
        const res = await fetch('/api/artifacts/' + encodeURIComponent(STATE.slug) + '/visibility', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visibility: visSelect.value })
        });
        if (res.ok) {
          const payload = await res.json();
          if (payload.links && payload.links.share_url) {
            STATE.shareUrl = payload.links.share_url;
          }
        }
      });
    }

    const delBtn = document.getElementById('delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!window.confirm('Delete "' + STATE.slug + '" and all versions permanently?')) return;
        const res = await fetch('/api/artifacts/' + encodeURIComponent(STATE.slug), { method: 'DELETE' });
        if (res.ok) window.location.assign('/');
      });
    }

    renderComments();
  </script>
</body>
</html>`
}
