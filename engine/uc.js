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
    prodFail: 'Bazı ürün görselleri siteden alınamadı.', siteLoading: 'Sitenin görüntüsü alınıyor…', siteFail: 'Sitenin görüntüsü alınamadı (site otomatik ziyaretleri engelliyor olabilir).',
  } : {
    copy: 'Copy for the Gem', copied: 'Copied ✓', close: 'Close', err: 'Error: ', play: 'Play / pause', sec: 's', dec: '.', download: 'Download',
    noTimeline: 'UC.timeline() never ran; the timeline script is missing or fails at the start.', badImgs: ' image(s) failed to load (shown grey/empty).',
    making: 'in progress…', preparing: 'Preparing', keepOpen: 'Keep this tab open. Long animations can take 1–3 minutes.', cancel: 'Cancel',
    ready: 'ready', hint: 'If the download did not start, press <b>Download</b>. If that fails too, right-click the preview and choose “Save as”.',
    missing: 'image(s) could not be embedded (the site\'s server refused). You can ask the Gem to swap them for other products.', failed: 'could not be created',
    images: 'Preparing images', frame: 'Frame', drawing: 'Drawing frame',
    prodFail: 'Some product photos could not be taken from the site.', siteLoading: 'Capturing the website…', siteFail: 'Could not capture the website (it may block automated visits).',
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
    fitSnaps(); mountSites();
    mountUI(); fit(); addEventListener('resize', fit);
  }
  // ---------- live site backdrop, brand logo and product photos (all from the real site) ----------
  //   <div class="uc-site" data-site="https://brand.com/page/"></div>      real page screenshot
  //   <img data-uc-logo="brand.com">                                       real brand logo
  //   <img data-uc-product="0"> + <span data-uc-pname="0">fallback</span>  real product photo + name
  // Captured by Microlink (WordPress mShots as backdrop fallback). Answers are cached in the viewer's
  // browser for 20 h so re-renders don't spend the service's daily quota.
  const ML = window.UC_SITE_API || 'https://api.microlink.io/?';
  const CLEAN = "(()=>{const H=innerHeight;document.querySelectorAll('body *').forEach(e=>{const s=getComputedStyle(e);if(s.position!=='fixed'&&s.position!=='sticky')return;const r=e.getBoundingClientRect();if(r.top>H*0.18||r.height>H*0.5)e.remove()})})()";
  const pendingAssets = [];
  const cacheGet = (k) => { try { const v = JSON.parse(localStorage.getItem('uc1:' + k)); if (v && Date.now() - v.t < 72e6) return v.d; } catch (e) {} return null; };
  const cacheSet = (k, d) => { try { localStorage.setItem('uc1:' + k, JSON.stringify({ t: Date.now(), d })); } catch (e) {} };
  const inflight = new Map();   // same request from several elements = one call (protects the daily quota)
  function mlJSON(params) {
    const hit = cacheGet(params); if (hit) return Promise.resolve(hit);
    if (inflight.has(params)) return inflight.get(params);
    const p = (async () => {
      const r = await fetch(ML + params); const j = await r.json();
      if (j.status !== 'success') throw new Error(j.code || 'microlink');
      cacheSet(params, j.data); return j.data;
    })();
    inflight.set(params, p); p.catch(() => inflight.delete(params)); return p;
  }
  const absUrl = (u) => new URL(/^https?:/.test(u) ? u : 'https://' + u).href;
  const loadImg = (img, src) => new Promise((res, rej) => { img.onload = () => res(img); img.onerror = rej; img.src = src; });
  function shotParams(url, mobile, clean) {
    const dev = mobile ? '&device=iPhone%2013' : '&viewport.width=1280&viewport.height=720&viewport.deviceScaleFactor=2';
    return `url=${encodeURIComponent(url)}&screenshot=true&meta=false${dev}` + (clean ? '&adblock=true&waitForTimeout=1500&scripts=' + encodeURIComponent(CLEAN) : '');
  }
  async function mountSite(el) {
    const img = document.createElement('img'); img.alt = '';
    const msg = document.createElement('div'); msg.className = 'uc-site-msg'; msg.textContent = T_.siteLoading;
    el.append(img, msg);
    const url = absUrl(el.dataset.site), mobile = SURF.name === 'mobile';
    const tries = [
      async () => (await mlJSON(shotParams(url, mobile, true))).screenshot.url,
      async () => (await mlJSON(shotParams(url, mobile, false))).screenshot.url,
      async () => ML + shotParams(url, mobile, true) + '&embed=screenshot.url',   // if JSON is blocked, let <img> load it
    ];
    for (const t of tries) { try { await loadImg(img, await t()); msg.remove(); return; } catch (e) {} }
    if (!mobile) {   // last resort: WordPress mShots (polls until the capture is ready)
      const m = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=1280&h=720`;
      for (let i = 0; i < 8; i++) { try { await loadImg(img, m + '&r=' + i); if (img.naturalWidth >= 600) { msg.remove(); return; } } catch (e) { break; } await new Promise((r) => setTimeout(r, 3000)); }
    }
    img.style.display = 'none'; msg.textContent = T_.siteFail;
    note('warn', T_.siteFail, 'The screenshot service could not capture ' + url + '. Suggest another page of the same site (e.g. a category page); if that also fails, ask me for a screenshot.');
  }
  async function mountLogo(img, host) {
    try { const d = await mlJSON(`url=${encodeURIComponent(new URL(host).origin + '/')}&meta=true`); if (d.logo && d.logo.url) { await loadImg(img, d.logo.url); return; } } catch (e) {}
    try { await loadImg(img, `https://www.google.com/s2/favicons?domain=${new URL(host).hostname}&sz=256`); } catch (e) { img.style.visibility = 'hidden'; }
  }
  // Product photos: every <img> with a real src + alt on the page, then keep the ones that look like
  // product shots (not icons, logos, payment badges or wide banners), paired with their alt text as name.
  const productLists = new Map();
  function productsOf(url) {
    if (productLists.has(url)) return productLists.get(url);
    const sel = encodeURIComponent('img[src^="http"][alt]:not([alt=""])');
    const p = (async () => {
      const d = await mlJSON(`url=${encodeURIComponent(url)}&meta=false&data.src.selectorAll=${sel}&data.src.attr=src&data.alt.selectorAll=${sel}&data.alt.attr=alt`);
      const src = d.src || [], alt = d.alt || [], seen = new Set(), cands = [];
      const aligned = src.length === alt.length;   // if the service dropped values, names would be shifted: use photos only
      const BAD = /\.svg|logo|icon|sprite|payment|visa|master|etbis|qr|ssl|secure|trust|badge|flag|avatar|placeholder|loading|blank|pixel|app-?store|google-?play|footer|[_-](size)?\d{1,2}x\d{1,2}(?=[_.\-/?]|$)|[?&](w|width)=\d{1,2}(?!\d)/i;
      src.forEach((s, i) => {
        const name = aligned ? String(alt[i] || '').replace(/\s+/g, ' ').trim() : '';
        if (!s || BAD.test(s) || seen.has(s) || (aligned && (!name || /sepete ekle|add to (cart|bag)|^logo|club|cart|basket|sepet|etbis|kayıtlı|qr|güvenli|secure|ssl|app ?store|google play|apple|visa|mastercard/i.test(name)))) return;
        seen.add(s); cands.push({ src: s, name });
      });
      const checked = await Promise.all(cands.slice(0, 36).map((c) => new Promise((res) => {
        const im = new Image(); im.onload = () => { const r = im.naturalHeight / im.naturalWidth; res(im.naturalWidth >= 200 && r >= 0.55 && r <= 1.9 ? c : null); };
        im.onerror = () => res(null); im.src = c.src;
      })));
      const names = new Set();
      let ok = checked.filter((c) => c && (!c.name || (!names.has(c.name) && names.add(c.name))));
      // Product photos on a page share one image folder (e.g. cdn.brand.com/products/…). Keep the biggest
      // such group so footer badges, QR codes and campaign banners from other folders drop out.
      const key = (u) => { try { const x = new URL(u); return x.host + '/' + x.pathname.split('/').filter(Boolean).slice(0, 1).join('/'); } catch (e) { return u; } };
      const groups = {}; ok.forEach((c) => { (groups[key(c.src)] = groups[key(c.src)] || []).push(c); });
      const top = Object.values(groups).sort((a, b) => b.length - a.length)[0];
      if (top && top.length >= 3) ok = top;
      return ok;
    })();
    productLists.set(url, p); return p;
  }
  function mountSites() {
    const site = document.querySelector('.uc-site[data-site]');
    document.querySelectorAll('.uc-site[data-site]').forEach((el) => {
      if (el.dataset.ucMounted) return; el.dataset.ucMounted = '1'; pendingAssets.push(mountSite(el));
    });
    document.querySelectorAll('img[data-uc-logo]').forEach((img) => {
      if (img.dataset.ucMounted) return; img.dataset.ucMounted = '1';
      let host; try { host = absUrl(img.dataset.ucLogo || (site && site.dataset.site) || ''); } catch (e) { return; }
      pendingAssets.push(mountLogo(img, host));
    });
    const pimgs = [...document.querySelectorAll('img[data-uc-product]')].filter((img) => !img.dataset.ucMounted && (img.dataset.ucMounted = '1'));
    if (pimgs.length) pendingAssets.push((async () => {
      const groups = new Map();
      pimgs.forEach((img) => { const from = (img.closest('[data-uc-products]') || {}).dataset?.ucProducts || (site && site.dataset.site); if (from) { const u = absUrl(from); if (!groups.has(u)) groups.set(u, []); groups.get(u).push(img); } });
      let missing = 0;
      for (const [u, list] of groups) {
        let prods = []; try { prods = await productsOf(u); } catch (e) {}
        await Promise.all(list.map(async (img) => {
          const p = prods[+img.dataset.ucProduct || 0]; if (!p) { missing++; img.classList.add('uc-noimg'); return; }
          try { await loadImg(img, p.src); } catch (e) { missing++; img.classList.add('uc-noimg'); }
          if (p.name) document.querySelectorAll(`[data-uc-pname="${img.dataset.ucProduct}"]`).forEach((n) => { n.textContent = p.name; });
        }));
      }
      if (missing) note('warn', T_.prodFail, 'Some product photos could not be taken from the page. Point the product cards at a category page of the site with data-uc-products="https://…", or ask me for a screenshot.');
    })());
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
    mountSites();   // pick up logo / product slots that page scripts cloned after start
    if (!current) report(T_.noTimeline);
    const bad = [...document.querySelectorAll('#uc-stage img')].filter((i) => !i.closest('.uc-site') && !i.hasAttribute('data-uc-logo') && i.getAttribute('src') && i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src'));
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
      prog(0.02, T_.images); await Promise.allSettled(pendingAssets);
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

/* ================= SCENES: ready-made, tested use cases =================
 * The Gem only fills in a small config; layout, motion and timing are fixed here, so every run of the
 * same use case looks the same and nothing overlaps.
 *
 *   UC.scene({ type: 'whatsapp', site: 'https://brand.com/category/', brand: { name: 'Brand', color: '#111' },
 *              lang: 'tr', customer: 'Ayşe', coupon: 'BRAND10', discount: '%10', ...texts });
 *
 * Types: whatsapp · popup · wheel · push · agent. Every text has a default (Turkish for lang 'tr',
 * English otherwise); pass texts in the site's language for any other language.
 */
(function () {
  const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const STATUS = '<div class="uc-status"><span>9:41</span><span class="icons"><span class="bars"><i></i><i></i><i></i><i></i></span><span class="batt"><b></b></span></span></div>';

  const TXT = {
    tr: {
      now: 'şimdi', today: 'Bugün', business: 'İşletme hesabı', meta: 'Bu işletme, bu sohbeti yönetmek için Meta\'nın güvenli bir hizmetini kullanıyor.',
      wa: { notify: (c) => `${c}, sepetindeki ürün seni bekliyor 🛍️`, greeting: (c, b) => `Merhaba ${c}! 👋 ${b}'dan sana özel bir hatırlatma var.`,
        productTitle: 'Sepetindeki ürün tükenmeden 🛍️', productText: (d, k) => `Siparişini şimdi tamamla, ${d} indirim kodun hazır: *${k}*`,
        cta: '🛒 Sepete Git', cta2: 'Soru sor', sheetTitle: 'İndirimin sepette! 🎉', sheetText: (d, k) => `${k} koduyla ${d} indirim sepetine uygulandı.`, sheetCta: 'Siparişi Tamamla' },
      popup: { kicker: 'GİTMEDEN ÖNCE', title: (d) => `${d} indirim seni bekliyor`, text: 'Sepetindeki ürünler için bugüne özel indirim kodun hazır.',
        cta: 'Kodu Göster', copy: 'Kopyala', done: 'Kopyalandı ✓', toast: (k) => `${k} kodun sepette otomatik uygulanacak`, close: 'Hayır, teşekkürler' },
      wheel: { kicker: 'SADECE BUGÜN', title: 'Çarkı çevir, indirimini kap!', text: 'Sana özel sürprizler seni bekliyor.', spin: 'Çarkı Çevir',
        segments: ['%10', 'KARGO', '%15', 'HEDİYE', '%20', 'TEKRAR', '%5', '%25'], win: 2, resultKicker: 'TEBRİKLER! 🎉', resultTitle: 'Sepette ekstra',
        resultText: 'indirim kazandın! 24 saat geçerli.', copy: 'Kopyala', done: 'Kopyalandı ✓', cta: 'Alışverişe Başla', sticky: 'indirimin sepette otomatik uygulanacak' },
      push: { title: (c) => `${c}, beğendiğin ürün seni bekliyor`, text: 'Stoklar tükenmeden göz at.', cta: 'Hemen Gör', cta2: 'Kapat', site: 'şimdi',
        landTitle: 'Beğendiğin ürün', landText: 'Tekrar baktığın için teşekkürler, sepete eklemeye hazır.', landCta: 'Sepete Ekle', landDone: '✓ Sepete eklendi' },
      agent: { title: 'Alışveriş Asistanı', sub: 'Genellikle anında yanıt verir', nudge: 'Merhaba 👋 Aradığını bulmana yardım edeyim mi?',
        greeting: (b) => `Merhaba! Ben ${b} asistanıyım. Size nasıl yardımcı olabilirim?`, quick: ['Ürün önerisi', 'Kombin fikri', 'Sipariş takibi'],
        question: 'Bu sezon için şık ve rahat bir şeyler arıyorum', answer: 'Harika seçim! Bu sezon en çok beğenilenlerden birkaçını seçtim 👇',
        cardCta: 'Sepete Ekle', added: '✓ Eklendi', confirm: 'Sepetinize eklendi! 🎉 Ödemeye geçmek ister misiniz?', final: ['Ödemeye Geç', 'Alışverişe Devam'],
        placeholder: 'Mesajınızı yazın...' },
    },
    en: {
      now: 'now', today: 'Today', business: 'Business account', meta: 'This business uses a secure service from Meta to manage this chat.',
      wa: { notify: (c) => `${c}, the item in your cart is waiting 🛍️`, greeting: (c, b) => `Hi ${c}! 👋 A quick reminder from ${b}.`,
        productTitle: 'Your pick is almost gone 🛍️', productText: (d, k) => `Complete your order now, your ${d} code is ready: *${k}*`,
        cta: '🛒 Go to cart', cta2: 'Ask a question', sheetTitle: 'Your discount is in the cart! 🎉', sheetText: (d, k) => `${k} applied: ${d} off your order.`, sheetCta: 'Complete order' },
      popup: { kicker: 'BEFORE YOU GO', title: (d) => `${d} off is waiting for you`, text: 'Your code for the items in your cart is ready, today only.',
        cta: 'Show my code', copy: 'Copy', done: 'Copied ✓', toast: (k) => `${k} will be applied at checkout`, close: 'No, thanks' },
      wheel: { kicker: 'TODAY ONLY', title: 'Spin the wheel, win a discount!', text: 'A surprise is waiting for you.', spin: 'Spin',
        segments: ['10%', 'FREE SHIP', '15%', 'GIFT', '20%', 'TRY AGAIN', '5%', '25%'], win: 2, resultKicker: 'CONGRATS! 🎉', resultTitle: 'You won an extra',
        resultText: 'discount, valid for 24 hours.', copy: 'Copy', done: 'Copied ✓', cta: 'Start shopping', sticky: 'will be applied at checkout' },
      push: { title: (c) => `${c}, your favourite is waiting`, text: 'Take a look before it sells out.', cta: 'View now', cta2: 'Close', site: 'now',
        landTitle: 'Your favourite', landText: 'Welcome back, it is ready to add to your cart.', landCta: 'Add to cart', landDone: '✓ Added to cart' },
      agent: { title: 'Shopping Assistant', sub: 'Usually replies instantly', nudge: 'Hi 👋 Can I help you find something?',
        greeting: (b) => `Hi! I'm the ${b} assistant. How can I help?`, quick: ['Recommendations', 'Outfit ideas', 'Order status'],
        question: 'I\'m looking for something stylish and comfortable', answer: 'Great choice! Here are a few of this season\'s favourites 👇',
        cardCta: 'Add to cart', added: '✓ Added', confirm: 'Added to your cart! 🎉 Ready to check out?', final: ['Checkout', 'Keep shopping'], placeholder: 'Type a message...' },
    },
  };

  function setup(cfg, forceSurface) {
    const root = document.documentElement;
    const surface = forceSurface || (cfg.surface === 'mobile' ? 'mobile' : cfg.surface === 'web' ? 'web' : (root.dataset.surface === 'mobile' ? 'mobile' : 'web'));
    root.dataset.surface = surface;
    if (cfg.lang) root.lang = cfg.lang;
    const site = cfg.site || '';
    let domain = (cfg.brand && cfg.brand.domain) || '';
    try { domain = domain || new URL(site).hostname.replace(/^www\./, ''); } catch (e) {}
    const name = (cfg.brand && cfg.brand.name) || (domain.split('.')[0] || 'Brand').replace(/^./, (c) => c.toUpperCase());
    root.dataset.name = root.dataset.name || `${domain.split('.')[0]}-${cfg.type}-${surface}`;
    root.dataset.format = root.dataset.format || 'gif';
    const color = (cfg.brand && cfg.brand.color) || '#111111', ink = (cfg.brand && cfg.brand.ink) || '#ffffff';
    root.style.setProperty('--brand', color); root.style.setProperty('--brand-ink', ink); root.style.setProperty('--accent', (cfg.brand && cfg.brand.accent) || color);
    root.style.setProperty('--chat', color); root.style.setProperty('--chat-ink', ink);
    let scr = document.querySelector('.uc-screen');
    if (!scr) { scr = document.createElement('div'); scr.className = 'uc-screen'; document.body.prepend(scr); }
    scr.innerHTML = '';
    if (cfg.products) scr.dataset.ucProducts = cfg.products;
    if (surface === 'mobile') scr.append(h(STATUS));
    scr.append(h(`<div class="uc-site" data-site="${esc(site)}"></div>`));
    const L = /^tr/i.test(cfg.lang || root.lang || '') ? TXT.tr : TXT.en;
    const pick = (key, sub, ...args) => { const v = cfg[key]; if (v != null && v !== '') return v; const d = L[sub][key]; return typeof d === 'function' ? d(...args) : d; };
    return { scr, surface, mobile: surface === 'mobile', domain, name, L, pick, customer: cfg.customer || (L === TXT.tr ? 'Ayşe' : 'Emma'),
      coupon: cfg.coupon || (name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) + '10'), discount: cfg.discount || (L === TXT.tr ? '%10' : '10%') };
  }
  const logo = (domain, cls = '') => `<img data-uc-logo="${esc(domain)}" alt="" class="${cls}">`;
  const bold = (t) => esc(t).replace(/\*([^*]+)\*/g, '<b>$1</b>');

  // ---------------- WhatsApp (always mobile) ----------------
  function whatsapp(cfg) {
    const S = setup(cfg, 'mobile'), P = (k, ...a) => S.pick(k, 'wa', ...a);
    const q = cfg.question, a = cfg.answer;
    S.scr.append(h(`<div class="ucn-ios sc-ban" id="sc-ban" data-uc-hidden style="top:52px">
      <div class="ic light">${logo('whatsapp.com')}</div>
      <div class="main"><div class="l1">${esc(S.name)}<span>${esc(S.L.now)}</span></div><div class="b">${esc(P('notify', S.customer))}</div></div>
      <img class="thumb" data-uc-product="0" alt=""></div>`));
    S.scr.append(h(`<div class="ucw sc-wa" id="sc-wa" data-uc-hidden style="top:47px">
      <div class="ucw-head"><span class="ucw-back">‹</span><div class="ucw-av uc-wlogo">${logo(S.domain)}</div>
        <div><div class="ucw-name">${esc(S.name)} <span class="ucw-verified">✓</span></div><div class="ucw-sub">${esc(S.L.business)}</div></div><div class="ucw-actions">📹 📞</div></div>
      <div class="ucw-body"><div class="ucw-list">
        <div class="ucw-day">${esc(S.L.today)}</div>
        <div class="ucw-note">${esc(S.L.meta)}</div>
        <div class="ucw-msg in" id="sc-m1" data-uc-hidden>${bold(P('greeting', S.customer, S.name))}<span class="time">14:02</span></div>
        <div class="ucw-msg in sc-pmsg" id="sc-m2" data-uc-hidden><img class="media" data-uc-product="0" alt=""><span class="ttl" data-uc-pname="0">${esc(P('productTitle'))}</span><br>${bold(P('productText', S.discount, S.coupon))}<span class="time">14:02</span><div class="foot">${esc(S.name)}</div></div>
        <div class="ucw-btns" id="sc-btns" data-uc-hidden><button id="sc-cta">${esc(P('cta'))}</button><button>${esc(P('cta2'))}</button></div>
        ${q ? `<div class="ucw-msg out" id="sc-q" data-uc-hidden>${esc(q)}<span class="time">14:05 <span class="ticks">✓✓</span></span></div>
        <div class="ucw-typing" id="sc-dots" data-uc-hidden><i></i><i></i><i></i></div>
        <div class="ucw-msg in" id="sc-a" data-uc-hidden>${bold(a || '')}<span class="time">14:05</span></div>` : ''}
      </div></div>
      <div class="ucw-foot"><span style="font-size:26px">+</span><div class="ucw-input"><input id="sc-in" placeholder=""></div><span>📷</span><span>🎤</span></div></div>`));
    S.scr.append(h(`<div class="uc-dim" id="sc-dim" data-uc-hidden></div>`));
    S.scr.append(h(`<div class="ucp-sheet sc-sheet" id="sc-sheet" data-uc-hidden><div class="grab"></div>
      <div class="sc-srow"><img data-uc-product="0" alt=""><div><div class="sc-st">${esc(P('sheetTitle'))}</div><div class="sc-sx">${bold(P('sheetText', S.discount, S.coupon))}</div></div></div>
      <div class="sc-code">${esc(S.coupon)}</div><button class="sc-btn" id="sc-go">${esc(P('sheetCta'))}</button></div>`));

    const T = UC.timeline({ duration: 30, cursor: 'tap' }), B = '#sc-wa .ucw-body';
    let t = 1.2;
    T.show('#sc-ban', t, { anim: 'down', dur: 0.45 });
    t += 1.8; T.tap('#sc-ban', t);
    t += 0.3; T.hide('#sc-ban', t, { dur: 0.2 }).show('#sc-wa', t, { anim: 'sheet', dur: 0.45 });
    t += 0.8; T.show('#sc-m1', t, { anim: 'up', dur: 0.3 });
    t += 1.3; T.show('#sc-m2', t, { anim: 'up', dur: 0.35 }).chatScroll(B, t);
    t += 0.6; T.show('#sc-btns', t, { anim: 'up', dur: 0.3 }).chatScroll(B, t);
    if (q) {
      t += 2.2; T.tap('#sc-in', t); T.type('#sc-in', q, t + 0.2, { cps: 24 });
      t += 0.4 + q.length / 24; T.tap('.ucw-foot span:last-child', t, { travel: 0.3 }).clear('#sc-in', t + 0.1);
      t += 0.15; T.show('#sc-q', t, { anim: 'up', dur: 0.3 }).chatScroll(B, t);
      t += 0.4; T.show('#sc-dots', t, { anim: 'fade', dur: 0.2 }).chatScroll(B, t);
      t += 1.1; T.hide('#sc-dots', t, { dur: 0.01 }).show('#sc-a', t, { anim: 'up', dur: 0.3 }).chatScroll(B, t);
      t += Math.min(3.5, 1.2 + String(a || '').length / 45);
    } else t += 2.4;
    T.tap('#sc-cta', t);
    t += 0.4; T.hide('#sc-wa', t, { anim: 'fade', dur: 0.3 });
    t += 0.5; T.show('#sc-dim', t, { anim: 'fade', dur: 0.3 }).show('#sc-sheet', t, { anim: 'sheet', dur: 0.45 });
    t += 2.4; T.tap('#sc-go', t);
    T.duration = t + 1.8; window.__UC_DURATION = T.duration;
    return T;
  }

  // ---------------- Exit-intent / coupon popup ----------------
  function popup(cfg) {
    const S = setup(cfg), P = (k, ...a) => S.pick(k, 'popup', ...a), showImg = cfg.product !== false;
    const inner = `${logo(S.domain, 'sc-plogo')}
      <div class="sc-kick">${esc(P('kicker'))}</div><h2>${esc(P('title', S.discount))}</h2><p>${bold(P('text'))}</p>
      <button class="cta" id="sc-cta">${esc(P('cta'))}</button>
      <div class="ucp-coupon" id="sc-coupon" data-uc-hidden><div class="code">${esc(S.coupon)}</div><button id="sc-copy">${esc(P('copy'))}</button></div>
      <div class="sc-no">${esc(P('close'))}</div>`;
    S.scr.append(h(`<div class="uc-dim" id="sc-dim" data-uc-hidden></div>`));
    if (S.mobile) {
      S.scr.append(h(`<div class="ucp-sheet sc-sheet sc-psheet" id="sc-pop" data-uc-hidden><div class="grab"></div>${showImg ? '<img class="sc-hero" data-uc-product="0" alt="">' : ''}${inner}</div>`));
    } else {
      S.scr.append(h(`<div class="uc-layer" id="sc-lay" data-uc-hidden><div class="ucp sc-pop${showImg ? ' two' : ''}" id="sc-pop">
        ${showImg ? '<img class="sc-side" data-uc-product="0" alt="">' : ''}<div class="ucp-pad">${inner}</div><div class="ucp-close">×</div></div></div>`));
    }
    S.scr.append(h(`<div class="ucb-toast sc-toast" id="sc-toast" data-uc-hidden><img data-uc-product="0" alt=""><div><b>${esc(S.coupon)}</b><br>${esc(P('toast', S.coupon))}</div></div>`));
    const T = UC.timeline({ duration: 20, cursorStart: S.mobile ? null : [760, 470] });
    let t = 1.0;
    if (!S.mobile && cfg.trigger !== 'time') { T.move([700, 6], t + 0.9, 0.9); t += 1.1; }   // exit intent: pointer leaves the page
    t += 0.3; T.show('#sc-dim', t, { anim: 'fade', dur: 0.3 });
    if (S.mobile) T.show('#sc-pop', t, { anim: 'sheet', dur: 0.45 }); else T.show('#sc-lay', t, { anim: 'pop', dur: 0.45 });
    t += 2.6; T.tap('#sc-cta', t);
    t += 0.3; T.hide('#sc-cta', t, { dur: 0.15 }).show('#sc-coupon', t + 0.1, { anim: 'pop', dur: 0.35 });
    t += 1.6; T.tap('#sc-copy', t).text('#sc-copy', esc(P('done')), t + 0.15).cls('#sc-copy', 'ok', t + 0.15);
    t += 1.3; T.hide(S.mobile ? '#sc-pop' : '#sc-lay', t, { anim: S.mobile ? 'fade' : 'pop', dur: 0.3 }).hide('#sc-dim', t, { dur: 0.3 });
    t += 0.5; T.show('#sc-toast', t, { anim: 'up', dur: 0.4 });
    T.duration = t + 2.4; window.__UC_DURATION = T.duration;
    return T;
  }

  // ---------------- Spin to win ----------------
  function wheel(cfg) {
    const S = setup(cfg), P = (k, ...a) => S.pick(k, 'wheel', ...a);
    const segs = (Array.isArray(cfg.segments) && cfg.segments.length >= 4 ? cfg.segments : P('segments')).slice(0, 10);
    const n = segs.length, step = 360 / n, win = Math.max(0, Math.min(n - 1, cfg.win != null ? +cfg.win : (n > 2 ? 2 : 0)));
    const color = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#111';
    const alt = cfg.wheelAlt || '#ffffff';
    const grad = segs.map((_, i) => `${i % 2 ? alt : color} ${i * step}deg ${(i + 1) * step}deg`).join(',');
    const size = S.mobile ? 260 : 300;
    const segHtml = segs.map((lab, i) => `<div class="seg ${i % 2 ? 'd' : 'l'}" style="--a:${(i + 0.5) * step - 90}deg">${esc(lab)}</div>`).join('');
    const prize = cfg.prize || segs[win];
    S.scr.append(h(`<div class="uc-dim" id="sc-dim" data-uc-hidden></div>`));
    S.scr.append(h(`<div class="uc-layer" id="sc-lay" data-uc-hidden><div class="ucp sc-wheelpop${S.mobile ? ' m' : ''}" id="sc-pop">
      <div class="ucp-close">×</div>
      <div class="ucp-pad" id="sc-game"><div class="sc-kick">${esc(P('kicker'))}</div><h2>${esc(P('title'))}</h2><p>${esc(P('text'))}</p>
        <div class="ucp-wheel-wrap" style="--ws:${size}px"><div class="ucp-pointer"></div>
          <div class="ucp-wheel" id="sc-wheel" style="background:conic-gradient(${grad});--wheel-rim:${color}">${segHtml}<div class="hub">${logo(S.domain)}</div></div></div>
        <button class="cta" id="sc-spin">${esc(P('spin'))}</button></div>
      <div class="ucp-pad" id="sc-res" data-uc-hidden><div class="sc-kick">${esc(P('resultKicker'))}</div><h2>${esc(P('resultTitle'))}</h2>
        <div class="ucp-big">${esc(prize)}</div><p>${esc(P('resultText'))}</p>
        <div class="ucp-coupon"><div class="code">${esc(S.coupon)}</div><button id="sc-copy">${esc(P('copy'))}</button></div>
        <button class="cta" id="sc-go">${esc(P('cta'))}</button></div>
      <div class="ucp-confetti" id="sc-conf"></div></div></div>`));
    S.scr.append(h(`<div class="sc-sticky" id="sc-sticky" data-uc-hidden><span class="tag">${esc(S.coupon)}</span><span>${esc(prize)} ${esc(P('sticky'))}</span><span class="cd" id="sc-cd">23:59:59</span></div>`));
    const conf = S.scr.querySelector('#sc-conf'), cols = [color, '#f5b700', '#2e9e5b', '#e03a3a', '#7fb3e6'];
    for (let i = 0; i < 36; i++) { const c = document.createElement('i'); c.style.left = (3 + (i * 37) % 94) + '%'; c.style.background = cols[i % 5]; conf.appendChild(c); }
    const T = UC.timeline({ duration: 20, cursorStart: S.mobile ? null : [900, 560] });
    let t = 1.2;
    T.show('#sc-dim', t, { anim: 'fade', dur: 0.3 }).show('#sc-lay', t, { anim: 'pop', dur: 0.5 });
    t += 1.8; T.tap('#sc-spin', t);
    t += 0.2; T.spin('#sc-wheel', 1800 - (win + 0.5) * step, t, 3.6).cls('#sc-spin', 'uc-pressed', t, { until: t + 3.6 });
    t += 4.0; T.hide('#sc-game', t, { dur: 0.2 }).show('#sc-res', t + 0.2, { anim: 'pop', dur: 0.45 }).show('#sc-conf', t + 0.2, { anim: 'none', dur: 0 });
    [...conf.children].forEach((c, i) => { const x0 = (i % 7 - 3) * 14, rot = (i * 47) % 360, d = (i % 6) * 0.05;
      T.tween(c, 'transform', 0, 1, t + 0.2 + d, 2.2, { ease: 'linear', fmt: (p) => `translate(${x0 * p}px, ${p * 560}px) rotate(${rot + p * 540}deg)` }); });
    t += 2.2; T.tap('#sc-copy', t).text('#sc-copy', esc(P('done')), t + 0.15).cls('#sc-copy', 'ok', t + 0.15);
    t += 1.4; T.tap('#sc-go', t);
    t += 0.3; T.hide('#sc-lay', t, { anim: 'pop', dur: 0.3 }).hide('#sc-dim', t, { dur: 0.3 });
    t += 0.4; T.show('#sc-sticky', t, { anim: 'up', dur: 0.45 }).countdown('#sc-cd', 86399, { at: t });
    T.duration = t + 2.2; window.__UC_DURATION = T.duration;
    return T;
  }

  // ---------------- Web push / app push ----------------
  function push(cfg) {
    const S = setup(cfg), P = (k, ...a) => S.pick(k, 'push', ...a);
    const land = (id) => `<img class="sc-hero" data-uc-product="0" alt=""><div class="sc-st" data-uc-pname="0">${esc(P('landTitle'))}</div><div class="sc-sx">${bold(P('landText'))}</div><button class="sc-btn" id="${id}">${esc(P('landCta'))}</button>`;
    S.scr.append(h(`<div class="uc-dim" id="sc-dim" data-uc-hidden></div>`));
    if (S.mobile) {
      S.scr.append(h(`<div class="ucp-sheet sc-sheet sc-land" id="sc-land" data-uc-hidden><div class="grab"></div>${land('sc-buy')}</div>`));
      S.scr.append(h(`<div class="ucn-lock" id="sc-lock"><div class="clock">9:41</div><div class="date">${esc(cfg.date || '')}</div>
        <div class="ucn-ios" id="sc-n" data-uc-hidden><div class="ic light">${logo(S.domain)}</div><div class="main"><div class="l1">${esc(S.name)}<span>${esc(S.L.now)}</span></div>
        <div class="b"><b>${esc(P('title', S.customer))}</b> ${bold(P('text'))}</div></div><img class="thumb" data-uc-product="0" alt=""></div></div>`));
      const T = UC.timeline({ duration: 14, cursor: 'tap' });
      let t = 1.0; T.show('#sc-n', t, { anim: 'up', dur: 0.45 });
      t += 2.6; T.tap('#sc-n', t);
      t += 0.3; T.hide('#sc-lock', t, { anim: 'fade', dur: 0.35 });
      t += 0.8; T.show('#sc-dim', t, { anim: 'fade', dur: 0.3 }).show('#sc-land', t, { anim: 'sheet', dur: 0.45 });
      t += 2.2; T.tap('#sc-buy', t).text('#sc-buy', esc(P('landDone')), t + 0.15).cls('#sc-buy', 'ok', t + 0.15);
      T.duration = t + 1.8; window.__UC_DURATION = T.duration; return T;
    }
    S.scr.append(h(`<div class="ucn-web" id="sc-n" data-uc-hidden><div class="top"><span class="chrome"></span>Google Chrome · ${esc(S.domain)}<span style="margin-left:auto">${esc(S.L.now)}</span></div>
      <div class="row"><div class="ic light">${logo(S.domain)}</div><div><div class="t">${esc(P('title', S.customer))}</div><div class="b">${bold(P('text'))}</div><div class="via">${esc(S.domain)}</div></div></div>
      <img class="hero" data-uc-product="0" alt=""><div class="acts"><button id="sc-cta">${esc(P('cta'))}</button><button>${esc(P('cta2'))}</button></div></div>`));
    S.scr.append(h(`<div class="uc-layer" id="sc-lay" data-uc-hidden><div class="ucp sc-pop two sc-qv"><img class="sc-side" data-uc-product="0" alt=""><div class="ucp-pad">${logo(S.domain, 'sc-plogo')}${land('sc-buy')}</div><div class="ucp-close">×</div></div></div>`));
    const T = UC.timeline({ duration: 14, cursorStart: [700, 520] });
    let t = 1.2; T.show('#sc-n', t, { anim: 'left', dur: 0.45 });
    t += 3.0; T.tap('#sc-cta', t, { travel: 0.9 });
    t += 0.4; T.hide('#sc-n', t, { anim: 'fade', dur: 0.3 });
    t += 0.5; T.show('#sc-dim', t, { anim: 'fade', dur: 0.3 }).show('#sc-lay', t, { anim: 'pop', dur: 0.45 });
    t += 2.4; T.tap('#sc-buy', t, { travel: 0.8 }).text('#sc-buy', esc(P('landDone')), t + 0.15).cls('#sc-buy', 'ok', t + 0.15);
    T.duration = t + 1.8; window.__UC_DURATION = T.duration; return T;
  }

  // ---------------- Agent One ----------------
  function agent(cfg) {
    const S = setup(cfg), P = (k, ...a) => S.pick(k, 'agent', ...a);
    const cards = cfg.cards !== false, n = Math.max(2, Math.min(3, +cfg.count || 3));
    const quick = (Array.isArray(cfg.quick) ? cfg.quick : P('quick')).slice(0, 3), fin = (Array.isArray(cfg.final) ? cfg.final : P('final')).slice(0, 2);
    const av = `<div class="ucc-av uc-wlogo">${logo(S.domain)}</div>`;
    const prices = Array.isArray(cfg.prices) ? cfg.prices : [];
    const cardHtml = Array.from({ length: n }, (_, i) => `<div class="ucc-card"><div class="img"><img data-uc-product="${i}" alt=""></div><div class="t" data-uc-pname="${i}">${esc((cfg.labels && cfg.labels[i]) || '')}</div>${prices[i] ? `<div class="p">${esc(prices[i])}</div>` : ''}<button id="sc-add${i}">${esc(P('cardCta'))}</button></div>`).join('');
    S.scr.append(h(`<div class="ucc-launcher brand" id="sc-launch">${logo(S.domain)}</div>`));
    S.scr.append(h(`<div class="ucc-nudge" id="sc-nudge" data-uc-hidden>${esc(P('nudge'))}</div>`));
    if (!S.mobile) S.scr.append(h(`<div class="uc-dim light" id="sc-dim" data-uc-hidden></div>`));
    S.scr.append(h(`<div class="ucc ${S.mobile ? 'mobile' : 'web wide'}" id="sc-chat" data-uc-hidden>
      <div class="ucc-head"><div class="logo uc-wlogo sc-hlogo">${logo(S.domain)}</div><div><div class="title">${esc(P('title'))}</div><div class="sub">${esc(P('sub'))}</div></div><div class="ctl"><span>–</span><span>×</span></div></div>
      <div class="ucc-body" id="sc-body"><div class="ucc-list">
        <div class="ucc-row bot" id="sc-m1" data-uc-hidden>${av}<div class="ucc-msg">${bold(P('greeting', S.name))}</div></div>
        <div class="ucc-qr" id="sc-q1" data-uc-hidden>${quick.map((x) => `<button>${esc(x)}</button>`).join('')}</div>
        <div class="ucc-row me" id="sc-u1" data-uc-hidden><div class="ucc-msg">${esc(P('question'))}</div></div>
        <div class="ucc-row bot" id="sc-d1" data-uc-hidden>${av}<div class="ucc-typing"><i></i><i></i><i></i></div></div>
        <div class="ucc-row bot" id="sc-m2" data-uc-hidden>${av}<div class="ucc-msg">${bold(P('answer'))}</div></div>
        ${cards ? `<div class="ucc-cards sc-cards" id="sc-cards" data-uc-hidden>${cardHtml}</div>
        <div class="ucc-row bot" id="sc-d2" data-uc-hidden>${av}<div class="ucc-typing"><i></i><i></i><i></i></div></div>
        <div class="ucc-row bot" id="sc-m3" data-uc-hidden>${av}<div class="ucc-msg">${bold(P('confirm'))}</div></div>` : ''}
        <div class="ucc-qr" id="sc-q2" data-uc-hidden>${fin.map((x, i) => `<button class="${i ? '' : 'sel'}">${esc(x)}</button>`).join('')}</div>
      </div></div>
      <div class="ucc-foot"><input id="sc-in" placeholder="${esc(P('placeholder'))}"><div class="send"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 20l18-8L3 4v6l12 2-12 2z"/></svg></div></div></div>`));
    const T = UC.timeline({ duration: 30, cursorStart: S.mobile ? null : [880, 500] }), B = '#sc-body', Q = P('question');
    let t = 0.8;
    T.show('#sc-nudge', t, { anim: 'left', dur: 0.4 });
    t += 1.6; T.tap('#sc-launch', t, { travel: 0.9 });
    t += 0.15; T.hide('#sc-nudge', t, { dur: 0.15 });
    if (!S.mobile) T.show('#sc-dim', t, { anim: 'fade', dur: 0.3 });
    T.show('#sc-chat', t, { anim: S.mobile ? 'sheet' : 'up', dur: 0.45 });
    t += 0.6; T.show('#sc-m1', t, { anim: 'up', dur: 0.3 });
    t += 0.5; T.show('#sc-q1', t, { anim: 'fade', dur: 0.3 });
    t += 1.0; T.tap('#sc-in', t, { travel: 0.6 }); T.type('#sc-in', Q, t + 0.2, { cps: 24 });
    t += 0.4 + Q.length / 24; T.tap('#sc-chat .ucc-foot .send', t, { travel: 0.3 }).clear('#sc-in', t + 0.1);
    t += 0.15; T.hide('#sc-q1', t, { dur: 0.01 }).show('#sc-u1', t, { anim: 'up', dur: 0.3 }).chatScroll(B, t);
    t += 0.3; T.show('#sc-d1', t, { anim: 'fade', dur: 0.2 }).chatScroll(B, t);
    t += 1.0; T.hide('#sc-d1', t, { dur: 0.01 }).show('#sc-m2', t, { anim: 'up', dur: 0.3 }).chatScroll(B, t);
    if (cards) {
      t += 0.6; T.show('#sc-cards', t, { anim: 'left', dur: 0.5 }).chatScroll(B, t, 0.5);
      t += 2.0; T.tap('#sc-add0', t, { travel: 0.8 }).text('#sc-add0', esc(P('added')), t + 0.15).cls('#sc-add0', 'done', t + 0.15);
      t += 0.6; T.show('#sc-d2', t, { anim: 'fade', dur: 0.2 }).chatScroll(B, t);
      t += 0.9; T.hide('#sc-d2', t, { dur: 0.01 }).show('#sc-m3', t, { anim: 'up', dur: 0.3 }).chatScroll(B, t);
    }
    t += 0.5; T.show('#sc-q2', t, { anim: 'fade', dur: 0.3 }).chatScroll(B, t);
    t += 1.4; T.tap('#sc-q2 button', t, { travel: 0.7 });
    T.duration = t + 1.6; window.__UC_DURATION = T.duration;
    return T;
  }

  const SCENES = { whatsapp, popup, wheel, push, agent };
  window.UC.scene = function (cfg) {
    cfg = cfg || {};
    const f = SCENES[String(cfg.type || '').toLowerCase()];
    if (!f) throw new Error('UC.scene: unknown type "' + cfg.type + '" (use whatsapp, popup, wheel, push or agent)');
    if (!cfg.site) throw new Error('UC.scene: "site" (the brand page URL) is required');
    return f(cfg);
  };
})();
