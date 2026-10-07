/* Use Case Studio — deterministic timeline runtime (Gemini Canvas build).
 * Adds: a stage that scales the page to fit any preview, an autoplay player, an error banner,
 * and in-browser GIF / MP4 / PNG export (loads uc-export.js from the same folder on demand).
 * Every visual state is a pure function of time t, so the renderer can
 * seek to any frame and screenshot it. No CSS animations / setTimeout.
 *
 *   const T = UC.timeline({ duration: 12 });
 *   T.show('#popup', 1.2, { anim: 'pop' });
 *   T.tap('#popup .spin-btn', 2.4);
 *   ...
 *   UC.seek(3.1)  // renderer calls this
 */
(function () {
  const ease = {
    linear: (p) => p,
    out: (p) => 1 - Math.pow(1 - p, 3),
    inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    back: (p) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
  };
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const prog = (t, at, dur, e = 'out') => (dur <= 0 ? (t >= at ? 1 : 0) : ease[e](clamp((t - at) / dur)));
  const lerp = (a, b, p) => a + (b - a) * p;
  const $ = (s) => (typeof s === 'string' ? document.querySelector(s) : s);
  const $$ = (s) => (typeof s === 'string' ? [...document.querySelectorAll(s)] : [s]);

  const snapshots = new Map(); // el -> {style, className, text?, html?}
  function snap(el, withText) {
    if (!el) throw new Error('UC: element not found');
    let s = snapshots.get(el);
    if (!s) { s = { style: el.getAttribute('style') || '', cls: el.className, hidden: el.hasAttribute('data-uc-hidden') }; snapshots.set(el, s); }
    if (withText && s.html === undefined) s.html = el.innerHTML;
    if (withText === 'value' && s.value === undefined) s.value = el.value ?? '';
    return el;
  }
  function restore() {
    for (const [el, s] of snapshots) {
      el.setAttribute('style', s.style); el.className = s.cls;
      if (s.hidden) el.setAttribute('data-uc-hidden', ''); else el.removeAttribute('data-uc-hidden');
      if (s.html !== undefined) el.innerHTML = s.html;
      if (s.value !== undefined) el.value = s.value;
    }
  }

  const ANIMS = {
    fade: (p) => ({ opacity: p }),
    up: (p) => ({ opacity: p, transform: `translateY(${(1 - p) * 24}px)` }),
    down: (p) => ({ opacity: p, transform: `translateY(${-(1 - p) * 24}px)` }),
    left: (p) => ({ opacity: p, transform: `translateX(${(1 - p) * 40}px)` }),
    right: (p) => ({ opacity: p, transform: `translateX(${-(1 - p) * 40}px)` }),
    pop: (p) => ({ opacity: clamp(p * 1.6), transform: `scale(${0.86 + 0.14 * p})` }),
    sheet: (p) => ({ transform: `translateY(${(1 - p) * 100}%)` }),
    slideR: (p) => ({ transform: `translateX(${(1 - p) * 110}%)` }),
    slideL: (p) => ({ transform: `translateX(${-(1 - p) * 110}%)` }),
    none: () => ({}),
  };
  function applyStyle(el, o) { for (const k in o) el.style[k] = o[k]; }

  class Timeline {
    constructor(opts = {}) {
      this.duration = opts.duration || 10;
      this.actions = [];
      this.cursorMode = opts.cursor || (document.documentElement.dataset.surface === 'mobile' ? 'tap' : 'arrow');
      this.cursorStart = opts.cursorStart || null; // [x,y]
      this.moves = []; this.taps = [];
    }
    _add(at, fn) { this.actions.push({ at, fn, i: this.actions.length }); return this; }

    /** Reveal an element that has data-uc-hidden. */
    show(sel, at, o = {}) {
      const anim = ANIMS[o.anim || 'up'], dur = o.dur ?? 0.45, e = o.ease || (o.anim === 'pop' ? 'back' : 'out');
      $$(sel).forEach((el, k) => { snap(el); const st = at + (o.stagger || 0) * k;
        this._add(st, (t) => { el.removeAttribute('data-uc-hidden'); applyStyle(el, anim(prog(t, st, dur, e))); }); });
      return this;
    }
    hide(sel, at, o = {}) {
      const anim = ANIMS[o.anim || 'fade'], dur = o.dur ?? 0.35;
      $$(sel).forEach((el) => { snap(el);
        this._add(at, (t) => { const p = prog(t, at, dur); if (p >= 1) { el.setAttribute('data-uc-hidden', ''); return; } applyStyle(el, anim(1 - p)); }); });
      return this;
    }
    /** Add/remove a class at time at (e.g. pressed state, selected tab). */
    cls(sel, name, at, o = {}) {
      $$(sel).forEach((el) => { snap(el); this._add(at, (t) => { if (o.until !== undefined && t >= o.until) return; el.classList.add(name); }); });
      return this;
    }
    /** Replace innerHTML at time at. */
    text(sel, html, at) { $$(sel).forEach((el) => { snap(el, true); this._add(at, () => { el.innerHTML = html; }); }); return this; }
    /** Typewriter into an input/textarea (value) or any element (text). */
    type(sel, str, at, o = {}) {
      const el = $(sel), cps = o.cps || 16, isInput = 'value' in el && el.tagName !== 'BUTTON';
      snap(el, isInput ? 'value' : true);
      this._add(at, (t) => { const n = Math.min(str.length, Math.floor((t - at) * cps)); if (isInput) el.value = str.slice(0, n); else el.textContent = str.slice(0, n); if (o.caret && n < str.length && isInput === false) el.textContent += '|'; });
      return this;
    }
    /** Clear an input at time at (e.g. after "send"). */
    clear(sel, at) { const el = $(sel); snap(el, 'value'); this._add(at, () => { el.value = ''; }); return this; }
    /** Vertical scroll of a container's content: translates the first child (or o.inner). */
    scroll(sel, toY, at, dur = 0.9, o = {}) {
      const box = $(sel), inner = o.inner ? $(o.inner) : box.firstElementChild; snap(inner);
      const key = '__ucScroll';
      this._add(at, (t) => { const from = inner[key] || 0; const y = lerp(from, toY, prog(t, at, dur, 'inOut')); inner.style.transform = `translateY(${-y}px)`; inner.__ucScrollTmp = y; });
      this._add(at + dur + 1e-4, () => { inner[key] = toY; });
      this._scrollInners = this._scrollInners || new Set(); this._scrollInners.add(inner);
      return this;
    }
    /** Horizontal scroll of a track (carousel). */
    scrollX(sel, toX, at, dur = 0.7) {
      const el = $(sel); snap(el); const key = '__ucScrollX';
      this._add(at, (t) => { const from = el[key] || 0; el.style.transform = `translateX(${-lerp(from, toX, prog(t, at, dur, 'inOut'))}px)`; });
      this._add(at + dur + 1e-4, () => { el[key] = toX; });
      this._scrollXs = this._scrollXs || new Set(); this._scrollXs.add(el);
      return this;
    }
    /** Animate a numeric CSS property: width %, rotation etc. */
    tween(sel, prop, from, to, at, dur, o = {}) {
      const unit = o.unit ?? '', fmt = o.fmt;
      $$(sel).forEach((el) => { snap(el); this._add(at, (t) => { const v = lerp(from, to, prog(t, at, dur, o.ease || 'inOut')); el.style[prop] = fmt ? fmt(v) : v + unit; }); });
      return this;
    }
    /** Rotate (wheel spin). Ends at `deg`. */
    spin(sel, deg, at, dur = 3.2) { return this.tween(sel, 'transform', 0, deg, at, dur, { fmt: (v) => `rotate(${v}deg)`, ease: 'out' }); }
    /** Fill a progress bar width. */
    progress(sel, from, to, at, dur = 1) { return this.tween(sel, 'width', from, to, at, dur, { unit: '%' }); }
    /** Countdown digits. Element children [data-cd=d|h|m|s] (or single text). Ticks 1/s from `seconds` starting at 0. */
    countdown(sel, seconds, o = {}) {
      const el = $(sel); snap(el, true); const startAt = o.at || 0;
      this._add(0, (t) => { let r = Math.max(0, Math.floor(seconds - Math.max(0, t - startAt)));
        const d = Math.floor(r / 86400), h = Math.floor((r % 86400) / 3600), m = Math.floor((r % 3600) / 60), s = r % 60;
        const map = { d, h, m, s }; const slots = el.querySelectorAll('[data-cd]');
        if (slots.length) slots.forEach((x) => { x.textContent = String(map[x.dataset.cd]).padStart(2, '0'); });
        else el.textContent = [h, m, s].map((v) => String(v).padStart(2, '0')).join(':'); });
      return this;
    }
    /** Chat helper: typing dots then message. `msg` must be data-uc-hidden; `dots` optional typing indicator element. */
    reply(msgSel, at, o = {}) {
      const think = o.think ?? 0.9;
      if (o.dots) { this.show(o.dots, at, { anim: 'fade', dur: 0.2 }); this.hide(o.dots, at + think, { dur: 0.01 }); }
      this.show(msgSel, at + (o.dots ? think : 0), { anim: o.anim || 'up', dur: 0.35 });
      if (o.autoscroll) this.chatScroll(o.autoscroll, at + (o.dots ? think : 0));
      return this;
    }
    /** Keep a chat body pinned to bottom: at time `at`, scroll so content bottom is visible. Computed live. */
    chatScroll(bodySel, at, dur = 0.35) {
      const box = $(bodySel), inner = box.firstElementChild; snap(inner);
      this._add(at, (t) => { const over = Math.max(0, inner.scrollHeight - box.clientHeight); const from = inner.__ucChat || 0;
        const y = lerp(from, over, prog(t, at, dur, 'out')); inner.style.transform = `translateY(${-y}px)`; inner.__ucChatNow = y; });
      this._add(at + dur + 1e-4, () => { inner.__ucChat = inner.__ucChatNow; });
      this._chatInners = this._chatInners || new Set(); this._chatInners.add(inner);
      return this;
    }
    /** Pointer: move to element center (or [x,y]) arriving at `at`, travelling `dur` s. */
    move(target, at, dur = 0.6) { this.moves.push({ target, at, dur }); return this; }
    /** Tap / click at element center (or [x,y]). Adds a pressed class to the element briefly. */
    tap(target, at, o = {}) {
      if (o.move !== false) this.move(target, at, o.travel ?? 0.6);
      this.taps.push({ target, at });
      if (typeof target === 'string' && o.press !== false) this.cls(target, 'uc-pressed', at, { until: at + 0.22 });
      return this;
    }
    /** Pointer rest position when idle. */
    cursorAt(xy) { this.cursorStart = xy; return this; }

    _pt(target) {
      if (Array.isArray(target)) return { x: target[0], y: target[1] };
      const el = $(target); if (!el) throw new Error('UC: tap target not found ' + target);
      const r = el.getBoundingClientRect(), st = stageBox();
      return { x: (r.left - st.left) / st.s + r.width / st.s / 2, y: (r.top - st.top) / st.s + r.height / st.s / 2 };
    }
    seek(t) {
      restore();
      (this._scrollInners || []).forEach((i) => { i.__ucScroll = 0; });
      (this._scrollXs || []).forEach((i) => { i.__ucScrollX = 0; });
      (this._chatInners || []).forEach((i) => { i.__ucChat = 0; });
      const acts = this.actions.filter((a) => a.at <= t + 1e-9).sort((a, b) => a.at - b.at || a.i - b.i);
      for (const a of acts) a.fn(t);
      this._pointer(t);
    }
    _pointer(t) {
      const cur = document.getElementById('uc-cursor'), ring = document.getElementById('uc-tap');
      if (!cur) return;
      const W = SURF.w, H = SURF.h;
      let pos = this.cursorStart ? { x: this.cursorStart[0], y: this.cursorStart[1] } : { x: W * 0.72, y: H * 0.78 };
      const moves = [...this.moves].sort((a, b) => a.at - b.at);
      let active = false;
      for (const m of moves) {
        const start = m.at - m.dur;
        if (t < start) break;
        const to = this._pt(m.target);
        const p = prog(t, start, m.dur, 'inOut');
        pos = { x: lerp(pos.x, to.x, p), y: lerp(pos.y, to.y, p) };
        active = true;
      }
      if (this.cursorMode === 'arrow') {
        cur.style.display = 'block';
        cur.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
        const tp = this.taps.find((k) => t >= k.at && t < k.at + 0.35);
        ring.style.display = tp ? 'block' : 'none';
        if (tp) { const p = (t - tp.at) / 0.35; ring.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%,-50%) scale(${0.4 + p})`; ring.style.opacity = 1 - p; }
      } else {
        // mobile: translucent finger dot, visible ~0.5s around each tap + during moves toward a tap
        const tp = this.taps.find((k) => t >= k.at - 0.45 && t < k.at + 0.35);
        cur.style.display = tp ? 'block' : 'none';
        if (tp) { const press = t >= tp.at && t < tp.at + 0.2; const fadeIn = clamp((t - (tp.at - 0.45)) / 0.15), fadeOut = 1 - clamp((t - (tp.at + 0.2)) / 0.15);
          cur.style.opacity = Math.min(fadeIn, fadeOut); cur.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%,-50%) scale(${press ? 0.82 : 1})`; }
        ring.style.display = 'none';
      }
    }
  }

  function mountPointer() {
    if (document.getElementById('uc-cursor')) return;
    const mobile = document.documentElement.dataset.surface === 'mobile';
    const cur = document.createElement('div'); cur.id = 'uc-cursor'; cur.className = mobile ? 'uc-finger' : 'uc-arrow';
    if (!mobile) cur.innerHTML = '<svg width="22" height="30" viewBox="0 0 22 30"><path d="M1.5 1.5v23.2l6-5.6 4 9.2 4.1-1.8-4-9h8.3z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const ring = document.createElement('div'); ring.id = 'uc-tap'; ring.className = 'uc-click-ring';
    (document.getElementById('uc-stage') || document.body).append(cur, ring);
  }

  // ================= stage, player, error banner, export (Gemini Canvas build) =================
  // UI language follows the viewer's browser: Turkish for tr-*, English otherwise.
  const T_ = /^tr/i.test(navigator.language || '') ? {
    copy: 'Gem için kopyala', copied: 'Kopyalandı ✓', close: 'Kapat', err: 'Hata: ', play: 'Oynat / durdur', sec: 'sn', dec: ',', download: 'İndir',
    noTimeline: 'UC.timeline() hiç çalışmadı; timeline script\'i eksik ya da başında hata var.', badImgs: ' görsel yüklenemedi (gri/boş görünür).',
    making: 'hazırlanıyor…', preparing: 'Hazırlanıyor', keepOpen: 'Bu sekme açık kalsın. Uzun animasyonlarda 1–3 dakika sürebilir.', cancel: 'Vazgeç',
    ready: 'hazır', hint: 'İndirme başlamadıysa <b>İndir</b>\'e bas. O da çalışmazsa önizlemeye sağ tıklayıp “Farklı kaydet” de.',
    missing: 'görsel dosyaya eklenemedi (sitenin sunucusu izin vermedi). Gem\'e “bu görselleri başka ürünlerle değiştir” diyebilirsin.', failed: 'oluşturulamadı',
    images: 'Görseller hazırlanıyor', frame: 'Kare', drawing: 'Kare çiziliyor',
  } : {
    copy: 'Copy for the Gem', copied: 'Copied ✓', close: 'Close', err: 'Error: ', play: 'Play / pause', sec: 's', dec: '.', download: 'Download',
    noTimeline: 'UC.timeline() never ran; the timeline script is missing or fails at the start.', badImgs: ' image(s) failed to load (shown grey/empty).',
    making: 'in progress…', preparing: 'Preparing', keepOpen: 'Keep this tab open. Long animations can take 1–3 minutes.', cancel: 'Cancel',
    ready: 'ready', hint: 'If the download did not start, press <b>Download</b>. If that fails too, right-click the preview and choose “Save as”.',
    missing: 'image(s) could not be embedded (the site\'s server refused). You can ask the Gem to swap them for other products.', failed: 'could not be created',
    images: 'Preparing images', frame: 'Frame', drawing: 'Drawing frame',
  };
  window.UC_I18N = T_;
  const SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';
  const BASE = SCRIPT_SRC.replace(/[^/]*(\?.*)?$/, '');
  const RAW = /[?&]raw\b/.test(location.search); // ?raw = plain page (old render.py pipeline), no player
  const SIZES = { web: [1280, 720], mobile: [390, 844] };
  const SURF = { name: 'web', w: 1280, h: 720 };
  function readSurface() {
    const d = document.documentElement.dataset, name = d.surface === 'mobile' ? 'mobile' : 'web';
    SURF.name = name; SURF.w = +d.w || SIZES[name][0]; SURF.h = +d.h || SIZES[name][1];
  }
  readSurface();
  // Insider component fonts (Poppins) + default body font (Inter). Brand fonts are linked by the page itself.
  if (!RAW && !document.querySelector('link[data-uc-fonts]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.crossOrigin = 'anonymous'; l.setAttribute('data-uc-fonts', '');
    l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Poppins:wght@400;500;600;700;800&display=swap';
    document.head.appendChild(l);
  }

  let current = null, stage = null, ui = null;
  function stageBox() {
    if (!stage) return { left: 0, top: 0, s: 1 };
    const r = stage.getBoundingClientRect();
    return { left: r.left, top: r.top, s: r.width / SURF.w || 1 };
  }

  // ---------- messages (errors / warnings) ----------
  const pending = [], seenMsg = new Set();
  function copyText(txt) {
    const fallback = () => { const ta = document.createElement('textarea'); ta.value = txt; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove(); };
    try { navigator.clipboard.writeText(txt).catch(fallback); } catch (e) { fallback(); }
  }
  function note(kind, msg, copy) {
    if (seenMsg.has(kind + msg)) return; seenMsg.add(kind + msg);
    if (!ui) { pending.push([kind, msg, copy]); return; }
    const n = document.createElement('div'); n.className = 'note ' + kind;
    const p = document.createElement('p'); p.textContent = msg; p.title = msg;
    const b = document.createElement('button'); b.textContent = T_.copy;
    b.onclick = () => { copyText(copy || msg); b.textContent = T_.copied; setTimeout(() => (b.textContent = T_.copy), 1800); };
    const x = document.createElement('button'); x.textContent = '✕'; x.title = T_.close; x.onclick = () => { n.remove(); fit(); };
    n.append(p, b, x); ui.querySelector('.notes').appendChild(n); fit();
  }
  const report = (m) => note('err', T_.err + m, 'The Canvas preview shows this error. Fix it and rewrite the whole page: ' + m);
  addEventListener('error', (e) => { if (e.message) report(e.message + (e.lineno ? ' (line ' + e.lineno + ')' : '')); });
  addEventListener('unhandledrejection', (e) => report(String((e.reason && e.reason.message) || e.reason)));

  // ---------- stage ----------
  function mountStage() {
    if (stage || RAW) return; readSurface();
    stage = document.createElement('div'); stage.id = 'uc-stage';
    stage.style.width = SURF.w + 'px'; stage.style.height = SURF.h + 'px';
    [...document.body.childNodes].forEach((n) => {
      if (n.nodeType === 1 && (n.tagName === 'SCRIPT' || n.id === 'uc-ui' || n.id === 'uc-modal')) return;
      stage.appendChild(n);
    });
    document.body.prepend(stage);
    document.documentElement.classList.add('uc-player');
    fitSnaps();
    mountUI(); fit(); addEventListener('resize', fit);
  }
  // A bookmark snapshot captured at another window width is scaled to the surface width.
  function fitSnaps() {
    document.querySelectorAll('.snap[data-w]').forEach((el) => {
      const w = +el.dataset.w, k = SURF.w / w; if (!w || Math.abs(k - 1) < 0.005 || el.dataset.ucFit) return;
      el.dataset.ucFit = '1'; el.style.scale = k; el.style.transformOrigin = '0 0';
      const h = el.offsetHeight; el.style.marginBottom = (h * k - h) + 'px'; el.style.marginRight = (w * k - w) + 'px';
    });
  }
  function fit() {
    if (!stage) return;
    const barH = ui ? ui.offsetHeight : 52, pad = 14;
    const aw = innerWidth - pad * 2, ah = innerHeight - barH - pad * 2;
    const s = Math.max(0.05, Math.min(aw / SURF.w, ah / SURF.h, 2));
    const x = (innerWidth - SURF.w * s) / 2, y = pad + Math.max(0, (ah - SURF.h * s) / 2);
    stage.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  }

  // ---------- player ----------
  const HOLD = 0.8; // pause on the last frame before looping
  let playing = true, t0 = performance.now(), tNow = 0, scrubbing = false, busy = false, seekFailed = false;
  function safeSeek(t) {
    try { current.seek(t); } catch (e) { if (!seekFailed) { seekFailed = true; report(e.message || String(e)); } }
  }
  function fmt(t) { return t.toFixed(1).replace('.', T_.dec); }
  function syncUI() {
    if (!ui || !current) return; const D = current.duration;
    ui.querySelector('.time').textContent = fmt(Math.min(tNow, D)) + ' / ' + fmt(D) + ' ' + T_.sec;
    if (!scrubbing) ui.querySelector('input').value = Math.round((Math.min(tNow, D) / D) * 1000);
    ui.querySelector('.play').textContent = playing ? '❚❚' : '▶';
  }
  function loop(now) {
    if (current && playing && !busy && !scrubbing) {
      const D = current.duration; tNow = ((now - t0) / 1000) % (D + HOLD); safeSeek(Math.min(tNow, D)); syncUI();
    }
    requestAnimationFrame(loop);
  }
  function setPlaying(p) { playing = p; if (p) t0 = performance.now() - tNow * 1000; syncUI(); }

  function mountUI() {
    if (ui) return;
    const rec = (document.documentElement.dataset.format || 'gif').toLowerCase();
    ui = document.createElement('div'); ui.id = 'uc-ui';
    ui.innerHTML = '<div class="notes"></div><div class="bar">' +
      '<button class="play" title="' + T_.play + '">❚❚</button>' +
      '<input type="range" min="0" max="1000" value="0" aria-label="Time">' +
      '<span class="time"></span>' +
      '<div class="exp"><span>' + T_.download + '</span>' +
      ['gif', 'mp4', 'png'].map((k) => `<button data-k="${k}" class="${k === rec ? 'main' : ''}">${k.toUpperCase()}</button>`).join('') +
      '</div></div>';
    document.body.appendChild(ui);
    ui.querySelector('.play').onclick = () => setPlaying(!playing);
    const r = ui.querySelector('input');
    r.oninput = () => { if (!current) return; scrubbing = true; playing = false; tNow = (r.value / 1000) * current.duration; safeSeek(tNow); syncUI(); };
    r.onchange = () => { scrubbing = false; };
    ui.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => doExport(b.dataset.k)));
    pending.splice(0).forEach((a) => note(...a));
    requestAnimationFrame(loop);
  }

  // ---------- checks after load ----------
  addEventListener('load', () => setTimeout(() => {
    if (RAW) return;
    if (!stage) mountStage();
    if (!current) report(T_.noTimeline);
    const bad = [...document.querySelectorAll('#uc-stage img')].filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src'));
    if (bad.length) note('warn', bad.length + T_.badImgs,
      'These image URLs do not load. Replace them with other real image URLs from the brand data (never invent URLs): ' + bad.join(' , '));
  }, 1200));

  // ---------- export ----------
  function loadExporter() {
    if (window.UCExport) return Promise.resolve(window.UCExport);
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = BASE + 'uc-export.js';
      s.onload = () => (window.UCExport ? res(window.UCExport) : rej(new Error('uc-export.js is empty')));
      s.onerror = () => rej(new Error('uc-export.js could not be loaded (' + s.src + ')'));
      document.head.appendChild(s);
    });
  }
  function slug() {
    const d = document.documentElement.dataset.name || document.title || 'use-case';
    return d.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'use-case';
  }
  function modal(html) {
    let m = document.getElementById('uc-modal'); if (m) m.remove();
    m = document.createElement('div'); m.id = 'uc-modal'; m.innerHTML = '<div class="box">' + html + '</div>'; document.body.appendChild(m); return m;
  }
  async function doExport(kind) {
    if (busy || !current) return;
    busy = true; const wasPlaying = playing; let cancelled = false;
    const label = kind.toUpperCase();
    const m = modal(`<h3>${label} ${T_.making}</h3><p class="st">${T_.preparing}</p><div class="track"><b></b></div>` +
      `<p>${T_.keepOpen}</p><div class="row"><button class="cancel">${T_.cancel}</button></div>`);
    m.querySelector('.cancel').onclick = () => { cancelled = true; };
    const prog = (p, txt) => { m.querySelector('.track b').style.width = Math.round(p * 100) + '%'; if (txt) m.querySelector('.st').textContent = txt; };
    try {
      const X = await loadExporter();
      const d = document.documentElement.dataset;
      const res = await X.run(kind, {
        stage, W: SURF.w, H: SURF.h, surface: SURF.name, duration: current.duration,
        seek: (t) => current.seek(t), keyTime: d.key !== undefined ? +d.key : Math.max(0, current.duration - 0.3),
        onProgress: prog, cancelled: () => cancelled,
      });
      if (!res) { m.remove(); return; }
      const url = URL.createObjectURL(res.blob), name = slug() + '.' + res.ext, mb = (res.blob.size / 1048576).toFixed(1).replace('.', T_.dec);
      const media = kind === 'mp4' ? `<video src="${url}" controls autoplay loop muted playsinline></video>` : `<img src="${url}" alt="">`;
      const miss = res.missing && res.missing.length ? `<p style="color:#8a5a00;margin-top:8px">${res.missing.length} ${T_.missing}</p>` : '';
      const r = modal(`<h3>${label} ${T_.ready} · ${mb} MB</h3><p>${T_.hint}</p>${miss}` +
        `<div class="prev">${media}</div><div class="row"><button class="close">${T_.close}</button><a class="dl" href="${url}" download="${name}">${T_.download}</a></div>`);
      r.querySelector('.close').onclick = () => r.remove();
      try { r.querySelector('a.dl').click(); } catch (e) {}
    } catch (e) {
      const r = modal(`<h3>${label} ${T_.failed}</h3><p>${String(e && e.message || e)}</p><div class="row"><button class="close">${T_.close}</button></div>`);
      r.querySelector('.close').onclick = () => r.remove();
    } finally {
      busy = false; setPlaying(wasPlaying);
    }
  }

  window.UC = {
    timeline(opts) { mountStage(); mountPointer(); current = new Timeline(opts); window.__UC_DURATION = current.duration; return current; },
    seek(t) { if (current) current.seek(t); },
    get duration() { return current ? current.duration : 0; },
    play() { setPlaying(true); }, pause() { setPlaying(false); },
    export: (kind) => doExport(kind || 'gif'),
    ease, clamp, lerp,
  };
})();
