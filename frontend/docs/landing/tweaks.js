/* ═══════════════════════════════════════════════════════════════════════
   MailAgent · Landing — Tweaks panel (vanilla host-protocol integration)
   tone · hero layout · theme · accent.  Hidden until host toggles Tweaks.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var root = document.documentElement;
  var panel = document.getElementById('tweaks');
  var defaults = window.TWEAK_DEFAULTS || { tone: 'restrained', hero: 'center', theme: 'dark', accent: 'coral' };

  /* ── hero copy per tone (zh + en) ─────────────────────────────────── */
  var TONE = {
    restrained: {
      zh: { title: '你的收件箱，<br><em>有人盯着了</em>。',
            sub: 'MailAgent 在邮件落地的那一刻就替你读完它——自动分类、定优先级、写摘要、起草回复。重要的浮上来，杂讯沉下去，全程可点回原文。' },
      en: { title: 'Your inbox,<br><em>finally handled</em>.',
            sub: 'MailAgent reads every email the moment it lands — classifying, prioritizing, summarizing and drafting replies. What matters rises; noise settles. Every claim links back to the source.' }
    },
    engineer: {
      zh: { title: '9,311 封邮件，<br><em>本地处理 · 可溯源</em>。',
            sub: '入库即处理：分类、定级、一句话摘要、动作建议，结构化写进每封邮件。统计与链接由代码确定性回填，LLM 只写文案——爆炸半径限定在措辞，不在数字。' },
      en: { title: '9,311 emails,<br><em>processed locally</em>.',
            sub: 'Processed on arrival: category, priority, a one-line summary and a suggested action, written structurally into every email. Counts and links are code-filled; the LLM only writes prose — the blast radius stays in wording, never numbers.' }
    },
    jarvis: {
      zh: { title: '认识 Jarvis，<br><em>你的邮件管家</em>。',
            sub: '他替你读完每一封邮件，挑出该你亲自关注的，把杂讯静默归档，紧急的送上灵动岛，每天早上递来一份读得完的日报。' },
      en: { title: 'Meet Jarvis,<br><em>your inbox butler</em>.',
            sub: 'He reads every email for you, surfaces what truly needs you, quietly archives the noise, pushes the urgent to your Dynamic Island, and hands you a briefing you can actually finish each morning.' }
    }
  };

  var heroTitle = document.getElementById('heroTitle');
  var heroSub = document.getElementById('heroSub');

  function applyTone(tone) {
    var t = TONE[tone] || TONE.restrained;
    if (heroTitle) {
      heroTitle.querySelector('.zh').innerHTML = t.zh.title;
      heroTitle.querySelector('.en').innerHTML = t.en.title;
    }
    if (heroSub) {
      heroSub.querySelector('.zh').innerHTML = t.zh.sub;
      heroSub.querySelector('.en').innerHTML = t.en.sub;
    }
  }

  /* ── apply + persist ──────────────────────────────────────────────── */
  function persist(edits) {
    try { window.parent.postMessage({ type: '__edit_mode_set_keys', edits: edits }, '*'); } catch (e) {}
  }
  function segSync(container, attr, val) {
    container.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute(attr) === val);
    });
  }
  function accentSync(container, val) {
    container.querySelectorAll('.adot').forEach(function (b) {
      b.setAttribute('aria-checked', b.getAttribute('data-accent') === val ? 'true' : 'false');
    });
  }

  var state = {
    tone: defaults.tone, hero: defaults.hero, theme: defaults.theme, accent: defaults.accent
  };

  function applyAll() {
    applyTone(state.tone);
    root.setAttribute('data-hero', state.hero);
    root.setAttribute('data-theme', state.theme);
    root.setAttribute('data-accent', state.accent);
    segSync(document.getElementById('twTone'), 'data-tone', state.tone);
    segSync(document.getElementById('twHero'), 'data-hero', state.hero);
    segSync(document.getElementById('twTheme'), 'data-theme', state.theme);
    accentSync(document.getElementById('twAccent'), state.accent);
    // keep the nav switchers in sync too
    document.querySelectorAll('#themeSwitch button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-theme') === state.theme); });
    document.querySelectorAll('#accents .adot').forEach(function (b) { b.setAttribute('aria-checked', b.getAttribute('data-accent') === state.accent ? 'true' : 'false'); });
  }

  // honour anything the user already set via the nav (persisted in localStorage)
  try {
    var lt = localStorage.getItem('ma_theme'); if (lt) state.theme = lt;
    var la = localStorage.getItem('ma_accent'); if (la) state.accent = la;
  } catch (e) {}
  applyAll();

  /* ── wire controls ────────────────────────────────────────────────── */
  document.getElementById('twTone').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.tone = b.getAttribute('data-tone'); applyAll(); persist({ tone: state.tone });
  });
  document.getElementById('twHero').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.hero = b.getAttribute('data-hero'); applyAll(); persist({ hero: state.hero });
  });
  document.getElementById('twTheme').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.theme = b.getAttribute('data-theme'); applyAll();
    try { localStorage.setItem('ma_theme', state.theme); } catch (e2) {}
    persist({ theme: state.theme });
  });
  document.getElementById('twAccent').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.accent = b.getAttribute('data-accent'); applyAll();
    try { localStorage.setItem('ma_accent', state.accent); } catch (e2) {}
    persist({ accent: state.accent });
  });

  // mirror nav switchers → tweak state (so both stay consistent)
  document.querySelectorAll('#themeSwitch button').forEach(function (b) {
    b.addEventListener('click', function () { state.theme = b.getAttribute('data-theme'); applyAll(); persist({ theme: state.theme }); });
  });
  document.querySelectorAll('#accents .adot').forEach(function (b) {
    b.addEventListener('click', function () { state.accent = b.getAttribute('data-accent'); applyAll(); persist({ accent: state.accent }); });
  });

  /* ── host protocol — register listener BEFORE announcing ──────────── */
  function show() { panel.classList.add('show'); }
  function hide() { panel.classList.remove('show'); }

  window.addEventListener('message', function (ev) {
    var d = ev.data || {};
    if (d.type === '__activate_edit_mode') show();
    else if (d.type === '__deactivate_edit_mode') hide();
  });

  document.getElementById('tweaksClose').addEventListener('click', function () {
    hide();
    try { window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*'); } catch (e) {}
  });

  try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch (e) {}
})();
