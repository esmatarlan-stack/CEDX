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
  // Logos. Square icons (avatars, notification icons, launcher) come from the site's own app/fav icon via
  // Google's favicon service: it is the brand's real mark and never a footer badge. Wide logos (popup header)
  // use the logo the screenshot service finds on the page, unless it looks like a payment / trust badge.
  const APP_ICONS = {
    'whatsapp.com': ['https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg', 'https://static.whatsapp.net/rsrc.php/v4/yz/r/ujTY9i_Jhs1.png'],
    'instagram.com': ['https://upload.wikimedia.org/wikipedia/commons/e/e7/Instagram_logo_2016.svg'],
    'gmail.com': ['https://upload.wikimedia.org/wikipedia/commons/7/7e/Gmail_icon_%282020%29.svg'],
    'messenger.com': ['https://upload.wikimedia.org/wikipedia/commons/b/be/Facebook_Messenger_logo_2020.svg'],
    'telegram.org': ['https://upload.wikimedia.org/wikipedia/commons/8/82/Telegram_logo.svg'],
  };
  const NOT_LOGO = /master|visa|troy|amex|paypal|iyzico|pay|etbis|ssl|secure|trust|cookie|badge|app-?store|google-?play|qr/i;
  const favicon = (host, sz) => `https://www.google.com/s2/favicons?domain=${new URL(host).hostname}&sz=${sz}`;
  async function tryImg(img, src, minW) { await loadImg(img, src); if (img.naturalWidth < (minW || 1)) throw new Error('too small'); }
  async function mountLogo(img, host) {
    const wide = img.classList.contains('sc-plogo') || img.hasAttribute('data-uc-logo-wide');
    const fromPage = async () => {
      const d = await mlJSON(`url=${encodeURIComponent(new URL(host).origin + '/')}&meta=true`);
      const u = d.logo && d.logo.url; if (!u || NOT_LOGO.test(u)) throw new Error('no logo');
      await tryImg(img, u, 16);
    };
    const hostname = new URL(host).hostname.replace(/^www\./, '');
    const ddg = () => tryImg(img, `https://icons.duckduckgo.com/ip3/${hostname}.ico`, 16);
    // Messaging / social apps: their official app icon (their websites only show a white logo, invisible on
    // a notification). Never the page logo for these.
    const app = APP_ICONS[hostname];
    const steps = app ? [...app.map((u) => () => tryImg(img, u, 16)), () => tryImg(img, favicon(host, 128), 32), ddg]
      : wide ? [fromPage, () => tryImg(img, favicon(host, 256), 64), ddg]
      : [() => tryImg(img, favicon(host, 256), 64), () => tryImg(img, favicon(host, 128), 48), ddg, fromPage, () => tryImg(img, favicon(host, 64), 16)];
    for (const step of steps) { try { await step(); return; } catch (e) {} }
    img.style.visibility = 'hidden';
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
    version: '7',
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
    root.dataset.format = cfg.format || (cfg.type === 'journey' || cfg.type === 'architect' ? 'mp4' : (root.dataset.format || 'gif'));
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

  // Email shown as it really arrives: a phone mail app with the opened message (brand header, hero product,
  // headline, CTA, product picks, footer).
  function emailPhone(S, val, J0, id, extra = '') {
    return `<div class="sc-phone sm ${extra}" id="${id}" data-uc-hidden><div class="scr sc-mail">
      <div class="mbar"><span>‹ Inbox</span><span>⋯</span></div>
      <div class="msub">${esc(val('emailSubject', S.customer))}</div>
      <div class="mfrom"><div class="sc-av uc-wlogo">${logo(S.domain)}</div><div><b>${esc(S.name)}</b><small>to me · 09:41</small></div></div>
      <div class="mbody">
        <div class="mhead">${logo(S.domain, 'sc-plogo')}</div>
        <img class="mhero" data-uc-product="0" alt="">
        <h3>${esc(val('emailTitle'))}</h3>
        <p>${bold(val('emailText', S.customer, S.coupon, S.discount))}</p>
        <div class="mbtn">${esc(val('emailCta'))}</div>
        <div class="mgrid">${[1, 2].map((k) => `<div><img data-uc-product="${k}" alt=""><span data-uc-pname="${k}"></span></div>`).join('')}</div>
        <div class="mfoot">${esc(S.domain)} · Unsubscribe</div>
      </div></div></div>`;
  }
  // ---------------- Journey: multi-step personalization story (web) ----------------
  // ad (social ad on a phone) → browse (category page + "learning" panel) → home (personalized recommendations)
  // → signup (account creation) → channels (email / SMS / push / WhatsApp side by side). Steps are optional.
  const JTXT = {
    tr: { labels: { ad: 'Sosyal medya reklamı', browse: 'Sitede geziniyor', home: 'Ana sayfa kişiselleşiyor', signup: 'Hesap oluşturuyor', channels: 'Tüm kanallarda tanınıyor' },
      adText: 'Yeni sezon burada. Keşfet 👇', adCta: 'Hemen Alışveriş Yap', sponsored: 'Sponsorlu', learning: 'Insider ilgi alanlarını öğreniyor',
      tags: ['Kategori ilgisi', 'Marka tercihi', 'Fiyat aralığı'], homeTitle: 'Senin için seçtiklerimiz', homeBadge: 'Kişiselleştirildi',
      complement: 'Tamamlayıcı ürünler', signupTitle: (d) => `Hesap oluştur, ${d} indirim kazan`, signupText: 'Favorilerini kaydet, sana özel fırsatları kaçırma.',
      email: 'E-posta adresin', signupCta: 'Hesap Oluştur', welcome: (c) => `Hoş geldin, ${c}! 🎉`,
      emailSubject: (c) => `${c}, senin için seçtiklerimiz`, emailTitle: 'Beğeneceğini düşündüklerimiz', emailCta: 'Hemen Keşfet', emailText: (c, k, d) => `Merhaba ${c}, sepetindeki ürünler seni bekliyor. *${k}* koduyla ${d} indirim senin.`,
      smsText: (b, c, k) => `${b}: ${c}, favorilerin seni bekliyor! ${k} koduyla indirim senin.`, pushTitle: (c) => `${c}, yeni gelenler tam senlik`,
      pushText: 'Sana özel önerileri keşfet.', whatsappText: (c) => `Merhaba ${c} 👋 İlgini çeken ürünlerde yeni seçenekler var.`, now: 'şimdi', today: 'Bugün' },
    en: { labels: { ad: 'Social ad', browse: 'Browses the site', home: 'Homepage gets personalized', signup: 'Creates an account', channels: 'Recognized on every channel' },
      adText: 'New season is here. Discover 👇', adCta: 'Shop Now', sponsored: 'Sponsored', learning: 'Insider is learning their interests',
      tags: ['Category interest', 'Brand affinity', 'Price range'], homeTitle: 'Picked for you', homeBadge: 'Personalized',
      complement: 'Complete the look', signupTitle: (d) => `Create an account, get ${d} off`, signupText: 'Save your favourites and get offers made for you.',
      email: 'Your email', signupCta: 'Create Account', welcome: (c) => `Welcome, ${c}! 🎉`,
      emailSubject: (c) => `${c}, picked just for you`, emailTitle: "We think you'll love these", emailCta: 'Shop Now', emailText: (c, k, d) => `Hi ${c}, your picks are still waiting. Use *${k}* for ${d} off.`,
      smsText: (b, c, k) => `${b}: ${c}, your favourites are waiting! Use ${k} for your discount.`, pushTitle: (c) => `${c}, new arrivals you'll love`,
      pushText: 'Discover picks made for you.', whatsappText: (c) => `Hi ${c} 👋 New picks just landed for the things you love.`, now: 'now', today: 'Today' },
  };
  function journey(cfg) {
    const S = setup(cfg, 'web'), J = S.L === TXT.tr ? JTXT.tr : JTXT.en;
    const val = (k, ...a) => { const v = cfg[k]; if (v != null && v !== '') return v; const d = J[k]; return typeof d === 'function' ? d(...a) : d; };
    const ALL = ['ad', 'browse', 'home', 'signup', 'channels'];
    let steps = (Array.isArray(cfg.steps) && cfg.steps.length ? cfg.steps : ALL).map((x) => String(x).toLowerCase().trim()).filter((x) => ALL.includes(x));
    if (!steps.length) steps = ALL;
    const chans = (Array.isArray(cfg.channels) && cfg.channels.length ? cfg.channels : ['email', 'sms', 'push']).map((x) => String(x).toLowerCase().trim()).filter((x) => ['email', 'sms', 'push', 'whatsapp'].includes(x)).slice(0, 3);
    const labels = Object.assign({}, J.labels, cfg.labels && typeof cfg.labels === 'object' && !Array.isArray(cfg.labels) ? cfg.labels : {});
    if (Array.isArray(cfg.labels)) steps.forEach((s, i) => { if (cfg.labels[i]) labels[s] = cfg.labels[i]; });
    const tags = (Array.isArray(cfg.tags) && cfg.tags.length ? cfg.tags : J.tags).slice(0, 4);
    const browseUrl = cfg.browse || cfg.products || cfg.site;
    const L = (dom, cls = '') => logo(dom, cls);
    const scr = S.scr;
    // captions
    scr.append(h(`<div class="sc-jcap" id="sc-cap"></div>`));
    steps.forEach((s, i) => scr.querySelector('#sc-cap').append(h(`<div class="sc-jchip" id="sc-c-${s}" data-uc-hidden><b>${i + 1}</b>${esc(labels[s])}</div>`)));
    // browse page capture (category) on top of the home capture
    if (steps.includes('browse')) scr.append(h(`<div class="uc-site sc-jbrowse" id="sc-browse" data-site="${esc(browseUrl)}" data-uc-hidden></div>`));
    scr.append(h(`<div class="uc-dim" id="sc-dim" data-uc-hidden></div>`));
    // 1. social ad on a phone
    scr.append(h(`<div class="sc-phone" id="sc-ad" data-uc-hidden><div class="scr">
      <div class="sc-ighead"><img data-uc-logo="instagram.com" alt="" class="sc-appic"><span>Instagram</span></div>
      <div class="sc-igpost"><div class="sc-igtop"><div class="sc-av uc-wlogo">${L(S.domain)}</div><div><b>${esc(S.name)}</b><small>${esc(J.sponsored)}</small></div><span class="dots">•••</span></div>
      <img class="sc-igimg" data-uc-product="0" alt=""><div class="sc-igcta" id="sc-adcta">${esc(val('adCta'))}<span>›</span></div>
      <div class="sc-igact">♡ &nbsp;💬 &nbsp;↗</div><div class="sc-igcap"><b>${esc(S.name)}</b> ${bold(val('adText'))}</div></div></div></div>`));
    // 2. learning panel
    scr.append(h(`<div class="sc-learn" id="sc-learn" data-uc-hidden><div class="t">✦ ${esc(val('learning'))}</div>${tags.map((x, i) => `<div class="tag" id="sc-tag${i}" data-uc-hidden>${esc(x)}</div>`).join('')}</div>`));
    // 3. personalized recommendations strip
    scr.append(h(`<div class="sc-recs" id="sc-recs" data-uc-hidden><div class="hd"><b>${esc(val('homeTitle'))}</b><span class="badge">✦ ${esc(val('homeBadge'))}</span></div>
      <div class="row">${[0, 1, 2, 3].map((i) => `<div class="card" id="sc-rc${i}"><img data-uc-product="${i}" alt=""><span data-uc-pname="${i}"></span>${i === 3 ? `<em>${esc(val('complement'))}</em>` : ''}</div>`).join('')}</div></div>`));
    // 4. sign-up modal
    scr.append(h(`<div class="uc-layer" id="sc-sign" data-uc-hidden><div class="ucp sc-signup"><div class="ucp-pad">${L(S.domain, 'sc-plogo')}
      <h2>${esc(val('signupTitle', S.discount))}</h2><p>${esc(val('signupText'))}</p>
      <div class="sc-field"><input id="sc-mail" placeholder="${esc(val('email'))}"></div><button class="cta" id="sc-sbtn">${esc(val('signupCta'))}</button>
      <div class="sc-ok" id="sc-ok" data-uc-hidden>${esc(val('welcome', S.customer))}</div></div></div></div>`));
    // 5. channels
    const mail = `${S.customer.toLowerCase().replace(/[^a-z]/g, '') || 'name'}@mail.com`;
    const panels = {
      email: emailPhone(S, val, J, 'sc-ch-email'),
      sms: `<div class="sc-phone sm" id="sc-ch-sms" data-uc-hidden><div class="scr sc-smsscr"><div class="who"><div class="sc-av uc-wlogo">${L(S.domain)}</div><b>${esc(S.name)}</b></div>
        <div class="day">${esc(J.today)}</div><div class="bub">${bold(val('smsText', S.name, S.customer, S.coupon))}</div></div></div>`,
      push: `<div class="sc-phone sm" id="sc-ch-push" data-uc-hidden><div class="scr sc-lock"><div class="clock">9:41</div>
        <div class="ucn-ios"><div class="ic light">${L(S.domain)}</div><div class="main"><div class="l1">${esc(S.name)}<span>${esc(J.now)}</span></div><div class="b"><b>${esc(val('pushTitle', S.customer))}</b> ${bold(val('pushText'))}</div></div><img class="thumb" data-uc-product="1" alt=""></div></div></div>`,
      whatsapp: `<div class="sc-phone sm" id="sc-ch-whatsapp" data-uc-hidden><div class="scr sc-lock"><div class="clock">9:41</div>
        <div class="ucn-ios"><div class="ic light"><img data-uc-logo="whatsapp.com" alt=""></div><div class="main"><div class="l1">${esc(S.name)}<span>${esc(J.now)}</span></div><div class="b">${bold(val('whatsappText', S.customer))}</div></div><img class="thumb" data-uc-product="2" alt=""></div></div></div>`,
    };
    const chWrap = h(`<div class="sc-chans" id="sc-chans" data-uc-hidden></div>`); chans.forEach((c) => chWrap.append(h(panels[c]))); scr.append(chWrap);

    if (!cfg.format) document.documentElement.dataset.format = 'mp4';
    const T = UC.timeline({ duration: 30, cursorStart: [900, 560] });
    let t = 0.3, prev = null;
    const cap = (s) => { if (prev) T.hide('#sc-c-' + prev, t, { dur: 0.2 }); T.show('#sc-c-' + s, t + 0.1, { anim: 'down', dur: 0.35 }); prev = s; };
    steps.forEach((s) => {
      cap(s);
      if (s === 'ad') {
        T.show('#sc-dim', t, { anim: 'fade', dur: 0.3 }).show('#sc-ad', t + 0.2, { anim: 'up', dur: 0.5 });
        t += 3.0; T.tap('#sc-adcta', t, { travel: 0.8 });
        t += 0.4; T.hide('#sc-ad', t, { anim: 'fade', dur: 0.3 }).hide('#sc-dim', t, { dur: 0.3 }); t += 0.4;
      } else if (s === 'browse') {
        T.show('#sc-browse', t, { anim: 'fade', dur: 0.3 }).show('#sc-learn', t + 0.6, { anim: 'left', dur: 0.4 });
        T.move([300, 360], t + 1.0, 0.7).move([560, 420], t + 2.0, 0.7).move([820, 380], t + 3.1, 0.7);
        tags.forEach((_, i) => T.show('#sc-tag' + i, t + 1.2 + i * 0.8, { anim: 'pop', dur: 0.3 }));
        t += Math.max(4.0, 1.6 + tags.length * 0.8);
        T.hide('#sc-browse', t, { anim: 'fade', dur: 0.35 }).hide('#sc-learn', t, { anim: 'fade', dur: 0.3 }); t += 0.4;
      } else if (s === 'home') {
        T.show('#sc-recs', t + 0.2, { anim: 'up', dur: 0.5 });
        T.move([470, 560], t + 1.8, 0.8).cls('#sc-rc1', 'hov', t + 1.8, { until: t + 2.8 }).move([980, 560], t + 3.0, 0.8).cls('#sc-rc3', 'hov', t + 3.0);
        t += 4.2; T.hide('#sc-recs', t, { anim: 'fade', dur: 0.3 }); t += 0.3;
      } else if (s === 'signup') {
        T.show('#sc-dim', t, { anim: 'fade', dur: 0.3 }).show('#sc-sign', t + 0.1, { anim: 'pop', dur: 0.45 });
        t += 1.2; T.tap('#sc-mail', t, { travel: 0.6 }); T.type('#sc-mail', mail, t + 0.2, { cps: 20 });
        t += 0.6 + mail.length / 20; T.tap('#sc-sbtn', t, { travel: 0.5 });
        t += 0.25; T.hide('#sc-sbtn', t, { dur: 0.15 }).show('#sc-ok', t + 0.1, { anim: 'pop', dur: 0.35 });
        t += 1.5; T.hide('#sc-sign', t, { anim: 'pop', dur: 0.3 }).hide('#sc-dim', t, { dur: 0.3 }); t += 0.3;
      } else if (s === 'channels') {
        T.show('#sc-dim', t, { anim: 'fade', dur: 0.3 }).show('#sc-chans', t, { anim: 'none', dur: 0 });
        chans.forEach((c, i) => T.show('#sc-ch-' + c, t + 0.3 + i * 0.8, { anim: 'up', dur: 0.45 }));
        t += 0.6 + chans.length * 0.8 + 2.4;
      }
    });
    T.duration = t + 0.6; window.__UC_DURATION = T.duration;
    return T;
  }

  // ---------------- Architect: the journey flow itself (web) ----------------
  // flow = "trigger:Cart abandoned|wait:1 hour|whatsapp|check:Purchased?|email|wait:1 day|push"
  // A "check:…" node splits: Yes → exit (converted), No → the rest of the flow continues.
  function architect(cfg) {
    const S = setup(cfg, 'web'), J0 = S.L === TXT.tr ? JTXT.tr : JTXT.en, TR = S.L === TXT.tr;
    if (!window.UCJ) throw new Error('UC.scene architect needs journey.js');
    const val = (k, ...a) => { const v = cfg[k]; if (v != null && v !== '') return v; const d = J0[k]; return typeof d === 'function' ? d(...a) : d; };
    // Insider Architect module catalogue (exact names, colours by kind, icons from journey.js)
    const MOD = {
      'on event': ['starter', 'event'], 'on website event': ['starter', 'website'], 'on website visit': ['starter', 'website'], 'user website action': ['starter', 'website'],
      'on past behavior': ['starter', 'past'], 'on attribute change': ['starter', 'attribute'], 'on back in stock': ['starter', 'backinstock'],
      'on price drop': ['starter', 'pricedrop'], 'on dynamic date': ['starter', 'date'],
      'wait for some time': ['wait', 'clock'], 'wait for event': ['wait', 'interaction'], 'wait for attribute': ['wait', 'attribute'],
      'wait until a time slot': ['wait', 'slot'], 'wait until dynamic time': ['wait', 'dyntime'],
      'on-site': ['channel', 'onsite', 'onsite'], 'email': ['channel', 'email', 'email'], 'sms': ['channel', 'sms', 'sms'], 'whatsapp': ['channel', 'whatsapp', 'whatsapp'],
      'app push': ['channel', 'apppush', 'push'], 'inapp': ['channel', 'inapp', 'onsite'], 'web push': ['channel', 'webpush', 'webpush'], 'call an api': ['channel', 'api', null],
      'facebook': ['channel', 'facebook', 'ad'], 'instagram': ['channel', 'instagram', 'ad'], 'google ads': ['channel', 'googleads', 'ad'],
      'youtube ads': ['channel', 'googleads', 'ad'], 'tiktok ads': ['channel', 'googleads', 'ad'],
      'check conditions': ['check', 'conditions'], 'check attribute': ['check', 'conditions'], 'check reachability': ['check', 'reach'],
      'check interaction': ['check', 'interaction'], 'check api response': ['check', 'api'],
      'a/b split': ['ab', 'split'], 'next best channel': ['nbc', 'nbc'],
      'update contact list': ['action', 'segment'], 'update user attribute': ['action', 'tag'], 'update static segment': ['action', 'segment'],
    };
    const ALIAS = { trigger: 'on event', start: 'on event', wait: 'wait for some time', check: 'check conditions', if: 'check conditions', split: 'a/b split',
      onsite: 'on-site', 'on site': 'on-site', push: 'app push', apppush: 'app push', webpush: 'web push', 'in-app': 'inapp', 'in app': 'inapp', api: 'call an api',
      ab: 'a/b split', 'a/b': 'a/b split', nbc: 'next best channel', reachability: 'check reachability', interaction: 'check interaction' };
    const NICE = (k) => Object.keys(MOD).includes(k) ? k.replace(/(^|[\s\-/])(\w)/g, (m, a, c) => a + c.toUpperCase()).replace('Sms', 'SMS').replace('Inapp', 'InApp').replace('Whatsapp', 'WhatsApp').replace('Api', 'API').replace('A/B Split', 'A/B Split').replace('Youtube', 'Youtube').replace('Tiktok', 'TikTok') : k;
    let raw = Array.isArray(cfg.flow) ? cfg.flow : String(cfg.flow || '').split('|');
    raw = raw.map((x) => String(x).trim()).filter(Boolean);
    if (!raw.length) raw = ['On Event:' + (TR ? 'Sepeti terk etti' : 'Cart Abandoned'), 'Wait for Some Time:' + (TR ? '1 Saat' : '1 Hour'), 'WhatsApp', 'Check Conditions:' + (TR ? 'Satın aldı mı?' : 'Purchased?'), 'Email', 'Wait for Some Time:' + (TR ? '1 Gün' : '1 Day'), 'App Push'];
    const EX = { conv: TR ? 'Dönüştü ✓' : 'Converted ✓', unreach: TR ? 'Ulaşılamadı' : 'Not Reachable', ctrl: TR ? 'Kontrol grubu' : 'Control group', out: TR ? 'Journey\'den çıkar' : 'Exits the journey' };
    let n = 0; const mk = (o) => Object.assign({ id: 'n' + (n++) }, o);
    const exitNode = (label) => mk({ kind: 'action', icon: 'check', label, sub: EX.out, t: 'exit' });
    const node = (tok) => {
      const i = tok.indexOf(':'); let k = (i < 0 ? tok : tok.slice(0, i)).trim().toLowerCase().replace(/\s+/g, ' '); const sub = i < 0 ? '' : tok.slice(i + 1).trim();
      k = ALIAS[k] || k; const m = MOD[k];
      if (!m) return mk({ kind: 'action', icon: 'business', label: tok.slice(0, i < 0 ? undefined : i).trim(), sub, t: 'action' });
      const o = mk({ kind: m[0], icon: m[1], label: NICE(k), sub, t: m[0], key: k, mockType: m[2] || null });
      if (o.t === 'channel' && m[2] && m[2] !== 'ad') o.chip = 'On Send';
      return o;
    };
    // build the tree; branching modules choose which branch the flow (and the customer) continues on
    let root = null, tail = null, attach = null; const main = [];
    const link = (it) => { if (!root) root = it; else attach(it); };
    raw.forEach((tok) => {
      const it = node(tok); link(it); main.push(it);
      if (it.t === 'check') {
        let cont, other;
        if (it.key === 'check reachability') { cont = { label: 'Reachable', tone: 'ok' }; other = { label: 'Not Reachable', tone: 'bad', next: exitNode(EX.unreach) }; it.branches = [cont, other]; }
        else if (it.key === 'check interaction') { other = { label: 'On Click', tone: 'ok', next: exitNode(EX.conv) }; cont = { label: 'Not Matching', tone: 'bad' }; it.branches = [other, cont]; }
        else if (it.key === 'check api response') { cont = { label: 'Condition 1', tone: 'ok' }; other = { label: 'Not Matching', tone: 'bad', next: exitNode(EX.out) }; it.branches = [cont, other]; }
        else { other = { label: 'Condition 1', tone: 'ok', next: exitNode(EX.conv) }; cont = { label: 'Not Matching', tone: 'bad' }; it.branches = [other, cont]; }
        it.contLabel = cont.label; attach = (x) => { cont.next = x; };
      } else if (it.t === 'ab') {
        const A = { label: 'A 50%', tone: 'a' }, Bb = { label: 'B 50%', tone: 'b', next: exitNode(EX.ctrl) }; it.branches = [A, Bb]; it.contLabel = 'A 50%'; attach = (x) => { A.next = x; };
      } else if (it.t === 'nbc') {
        const chs = (it.sub || 'Email - SMS - WhatsApp').split(/\s*[-,/]\s*/).filter(Boolean).slice(0, 3);
        const tones = ['a', 'b', 'c'], leaves = chs.map((c) => node(c));
        it.branches = leaves.map((lf, j) => ({ label: 'Channel ' + 'ABC'[j], tone: tones[j], next: lf }));
        it.contLabel = 'Channel A'; main.push(leaves[0]); const first = leaves[0]; attach = (x) => { first.next = x; };
      } else attach = (x) => { it.next = x; };
      tail = it;
    });
    if (tail && tail.branches) tail.branches.forEach((b) => { if (b.next === undefined) b.next = null; });

    const scr = S.scr;
    scr.append(h(`<div class="sc-arch" id="sc-arch"><div class="sc-archhd"><span class="dot"></span><b>Architect</b><span class="nm">${esc(cfg.title || (TR ? 'Müşteri yolculuğu' : 'Customer journey'))}</span></div></div>`));
    const host = scr.querySelector('#sc-arch');
    const Jb = UCJ.build(host, root, { x: 24, y: 72, maxW: 590, maxH: 630 });
    { const w = Jb.spec._w * Jb.scale; Jb.x = Math.max(24, Math.round((640 - w) / 2)); Jb.canvas.style.left = Jb.x + 'px'; }   // centre the flow in the panel
    // channel mockups on the right, over the real site
    const panel = (it, i) => {
      const id = 'sc-m' + i;
      if (it.ch === 'email') return emailPhone(S, val, J0, id, 'sc-amock');
      if (it.ch === 'sms') return `<div class="sc-phone sm sc-amock" id="${id}" data-uc-hidden><div class="scr sc-smsscr"><div class="who"><div class="sc-av uc-wlogo">${logo(S.domain)}</div><b>${esc(S.name)}</b></div><div class="day">${esc(J0.today)}</div><div class="bub">${bold(val('smsText', S.name, S.customer, S.coupon))}</div></div></div>`;
      if (it.ch === 'whatsapp') return `<div class="sc-phone sm sc-amock" id="${id}" data-uc-hidden><div class="scr sc-lock"><div class="clock">9:41</div><div class="ucn-ios"><div class="ic light"><img data-uc-logo="whatsapp.com" alt=""></div><div class="main"><div class="l1">${esc(S.name)}<span>${esc(J0.now)}</span></div><div class="b">${bold(val('whatsappText', S.customer))}</div></div><img class="thumb" data-uc-product="0" alt=""></div></div></div>`;
      if (it.ch === 'webpush') return `<div class="ucn-web sc-amock sc-awp" id="${id}" data-uc-hidden><div class="top"><span class="chrome"></span>Google Chrome · ${esc(S.domain)}</div><div class="row"><div class="ic light">${logo(S.domain)}</div><div><div class="t">${esc(val('pushTitle', S.customer))}</div><div class="b">${bold(val('pushText'))}</div></div></div><img class="hero" data-uc-product="1" alt=""></div>`;
      if (it.ch === 'ad') { const plat = { facebook: 'facebook.com', instagram: 'instagram.com', 'google ads': 'google.com', 'youtube ads': 'youtube.com', 'tiktok ads': 'tiktok.com' }[it.key] || 'instagram.com';
        return `<div class="sc-phone sm sc-amock" id="${id}" data-uc-hidden><div class="scr"><div class="sc-ighead"><img data-uc-logo="${plat}" alt="" class="sc-appic"><span>${esc(it.label)}</span></div><div class="sc-igpost"><div class="sc-igtop"><div class="sc-av uc-wlogo">${logo(S.domain)}</div><div><b>${esc(S.name)}</b><small>${esc(J0.sponsored)}</small></div></div><img class="sc-igimg" data-uc-product="0" alt=""><div class="sc-igcta">${esc(val('adCta'))}<span>›</span></div><div class="sc-igcap"><b>${esc(S.name)}</b> ${bold(val('adText'))}</div></div></div></div>`; }
      if (it.ch === 'onsite' || it.ch === 'inapp') return `<div class="ucp sc-amock sc-aon" id="${id}" data-uc-hidden><div class="ucp-pad">${logo(S.domain, 'sc-plogo')}<h2>${esc(cfg.onsiteTitle || val('signupTitle', S.discount))}</h2><div class="sc-code">${esc(S.coupon)}</div></div></div>`;
      return `<div class="sc-phone sm sc-amock" id="${id}" data-uc-hidden><div class="scr sc-lock"><div class="clock">9:41</div><div class="ucn-ios"><div class="ic light">${logo(S.domain)}</div><div class="main"><div class="l1">${esc(S.name)}<span>${esc(J0.now)}</span></div><div class="b"><b>${esc(val('pushTitle', S.customer))}</b> ${bold(val('pushText'))}</div></div><img class="thumb" data-uc-product="1" alt=""></div></div></div>`;
    };
    scr.append(h(`<div class="uc-dim sc-adim" id="sc-dim" data-uc-hidden></div>`));
    const chans = main.filter((it) => it.t === 'channel' && it.mockType);
    chans.forEach((it, i) => { it.ch = it.mockType; it.mock = 'sc-m' + i; scr.append(h(panel(it, i))); });
    if (cfg.kpi) scr.append(h(`<div class="sc-kpi" id="sc-kpi" data-uc-hidden>🎯 ${esc(cfg.kpi)}</div>`));

    const T = UC.timeline({ duration: 60, cursorStart: [1180, 680] });
    if (!cfg.format) document.documentElement.dataset.format = 'mp4';
    let t = UCJ.animateBuild(T, Jb, 0, 0.2) + 0.4;
    const P = UCJ.persona(Jb, { name: S.customer, initial: S.customer[0], color: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#e8462b' });
    const walk = [[main[0].id, t]]; T.show('#sc-dim', t, { anim: 'fade', dur: 0.4 });
    UCJ.check(T, Jb, main[0].id, t + 0.3);
    let prevMock = null;
    main.slice(1).forEach((it) => {
      t += it.mock ? 1.2 : 1.0; walk.push([it.id, t]);
      UCJ.active(T, Jb, it.id, t - 0.1, t + (it.mock ? 2.6 : 0.8));
      if (it.mock) {
        if (prevMock) T.hide('#' + prevMock, t - 0.2, { anim: 'fade', dur: 0.25 });
        const box = { x: 980, y: 380 };
        T.show('#' + it.mock, t, { anim: 'up', dur: 0.45 });
        UCJ.link(T, Jb, it.id, 'right', [box.x - 160, box.y], t + 0.1, { dur: 0.6 });
        prevMock = it.mock; t += 2.4;
      }
      if (it.contLabel) UCJ.pill(T, Jb, it.id, it.contLabel + ' →', t + 0.3, { tone: /Not|B 50/.test(it.contLabel) ? 'bad' : 'ok', side: 'right', until: t + 1.2 });
      UCJ.check(T, Jb, it.id, t + 0.4);
    });
    UCJ.walk(T, Jb, P, walk);
    t += 0.8;
    if (cfg.kpi) T.show('#sc-kpi', t, { anim: 'pop', dur: 0.4 });
    T.duration = t + 2.2; window.__UC_DURATION = T.duration;
    return T;
  }

  const SCENES = { whatsapp, popup, wheel, push, agent, journey, architect };
  window.UC.scene = function (cfg) {
    cfg = cfg || {};
    const f = SCENES[String(cfg.type || '').toLowerCase()];
    if (!f) throw new Error('UC.scene: unknown type "' + cfg.type + '" (use whatsapp, popup, wheel, push, agent, journey or architect)');
    if (!cfg.site) throw new Error('UC.scene: "site" (the brand page URL) is required');
    return f(cfg);
  };
})();
