/* ═══════════════════════════════════════════════════════════════════════
   MailAgent · Landing — interactions
   nav scroll · theme / accent / lang switchers (persisted) · scroll reveal
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var root = document.documentElement;
  var LS = {
    theme: 'ma_theme', accent: 'ma_accent', lang: 'ma_lang'
  };

  /* ── restore persisted prefs ──────────────────────────────────────── */
  try {
    var t = localStorage.getItem(LS.theme); if (t) root.setAttribute('data-theme', t);
    var a = localStorage.getItem(LS.accent); if (a) root.setAttribute('data-accent', a);
    var l = localStorage.getItem(LS.lang); if (l) { root.setAttribute('data-lang', l); root.setAttribute('lang', l); }
  } catch (e) {}

  function sync() {
    var theme = root.getAttribute('data-theme');
    var accent = root.getAttribute('data-accent');
    var lang = root.getAttribute('data-lang');
    // theme switch
    document.querySelectorAll('#themeSwitch button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-theme') === theme);
    });
    // lang switch
    document.querySelectorAll('#langSwitch button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-lang') === lang);
    });
    // accent dots
    document.querySelectorAll('#accents .adot').forEach(function (b) {
      b.setAttribute('aria-checked', b.getAttribute('data-accent') === accent ? 'true' : 'false');
    });
  }
  sync();

  /* ── theme ────────────────────────────────────────────────────────── */
  document.querySelectorAll('#themeSwitch button').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-theme');
      root.setAttribute('data-theme', v);
      try { localStorage.setItem(LS.theme, v); } catch (e) {}
      sync();
    });
  });

  /* ── accent ───────────────────────────────────────────────────────── */
  document.querySelectorAll('#accents .adot').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-accent');
      root.setAttribute('data-accent', v);
      try { localStorage.setItem(LS.accent, v); } catch (e) {}
      sync();
    });
  });

  /* ── language ─────────────────────────────────────────────────────── */
  document.querySelectorAll('#langSwitch button').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-lang');
      root.setAttribute('data-lang', v);
      root.setAttribute('lang', v);
      try { localStorage.setItem(LS.lang, v); } catch (e) {}
      sync();
    });
  });

  /* ── nav scrolled state ───────────────────────────────────────────── */
  var nav = document.getElementById('nav');
  function onScroll() {
    if (window.scrollY > 24) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  }
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ── scroll reveal ────────────────────────────────────────────────── */
  var reveals = document.querySelectorAll('.reveal');
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function revealAll() { reveals.forEach(function (el) { el.classList.add('in'); }); }
  function revealInView() {
    var vh = window.innerHeight || document.documentElement.clientHeight;
    reveals.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < vh * 0.92 && r.bottom > 0) el.classList.add('in');
    });
  }

  if (!reduce && 'IntersectionObserver' in window) {
    // opt into the hidden-then-animate state ONLY now that JS is confirmed live
    root.classList.add('js-anim');
    // immediately reveal anything already on screen (don't wait on the observer)
    revealInView();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });
    reveals.forEach(function (el) { if (!el.classList.contains('in')) io.observe(el); });
    // ultimate safety net — never leave content hidden
    window.addEventListener('load', revealInView);
    setTimeout(revealAll, 2600);
  }
  // reduced-motion or no-IO: leave content visible (CSS default), nothing to do

  /* ── smooth anchor + close any open detail offset handled by CSS ──── */
})();
