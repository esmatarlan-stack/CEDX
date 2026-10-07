/* Use Case Studio — Architect journey builder.
 * Lays out an Insider Architect journey from a small tree spec, draws nodes + connectors
 * (absolute positions, SVG edges) and gives timeline helpers to build it step by step,
 * tick nodes, move personas through it and link nodes to mockups.
 *
 *   const J = UCJ.build('#journey', SPEC, { x: 560, y: 40, maxW: 640, maxH: 660 });
 *   UCJ.animateBuild(T, J, 3.0, 0.35);            // nodes appear top→down, edges draw
 *   UCJ.check(T, J, 'email', 12);                 // green tick on node
 *   const P = UCJ.persona(J, { name: 'Ali', initial: 'A', color: '#e8462b' });
 *   UCJ.walk(T, J, P, [['start', 9], ['wait1', 10], ['email', 12]]);
 *   UCJ.link(T, J, 'email', 'left', [300, 470], 30);   // curve from node to a mockup point
 *
 * SPEC node: { id, kind, icon, label, sub?, chip?, next?: NODE, branches?: [{ label, tone: 'ok'|'bad', next: NODE }] }
 * kind: starter | wait | channel | check | ab | nbc | agent | action   (sets the top-border colour)
 * icon: see ICONS below (falls back to a dot).
 */
(function () {
  const NW = 172, NH = 52, GAP = 44, CHIP_GAP = 14, CHIP_H = 24, SPLIT = 20, LABEL_H = 30, COL_GAP = 46;
  const S = (d, extra = '') => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const ICONS = {
    event: S('<path d="M12 7v13M8 20l4-13 4 13M9.5 15h5"/><path d="M8.5 4.5a5 5 0 0 1 7 0"/>'),
    attribute: S('<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20v-4h-4"/>'),
    website: S('<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>'),
    past: S('<path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.3 3.3 0 0 0 7 18z"/>'),
    date: S('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>'),
    pricedrop: S('<path d="M5 5l5 5-5 5"/><path d="M14 8l5 8M14 16h0M19 8h0"/><circle cx="14" cy="8" r="1.4"/><circle cx="19" cy="16" r="1.4"/>'),
    backinstock: S('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 7v7M9 11l3 3 3-3M4 16h5l1 2h4l1-2h5"/>'),
    lowstock: S('<path d="M4 6h6l2 2h8v11H4z"/><path d="M8 13l3 3 3-3 3 3"/>'),
    business: S('<path d="M13 3L6 13h5l-1 8 7-10h-5z"/>'),
    clock: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    slot: S('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4M8 14h3"/>'),
    dyntime: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12h4"/><path d="M3 12h2"/>'),
    webpush: S('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h10M7 14h6"/>'),
    apppush: S('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 17.5h2"/>'),
    email: S('<rect x="3" y="5.5" width="18" height="13" rx="1.5"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>'),
    sms: S('<path d="M4 5h16v11H9l-5 4z"/><path d="M8.5 10.5h0M12 10.5h0M15.5 10.5h0" stroke-width="2.4"/>'),
    whatsapp: S('<path d="M4.5 19.5l1.2-3.6A8 8 0 1 1 8.4 18.6z"/><path d="M9.5 9c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8c-1-.4-1.8-1.2-2.3-2.3l.8-1-1-2z" stroke-width="1.3"/>'),
    inapp: S('<rect x="7" y="3" width="10" height="18" rx="2"/><rect x="9.5" y="8" width="5" height="6" rx="1"/>'),
    onsite: S('<rect x="3" y="4" width="13" height="10" rx="1.5"/><rect x="10" y="10" width="11" height="9" rx="1.5" fill="#fff"/>'),
    googleads: S('<path d="M9 5l-5 13M9 5l7 13M15 5l5 13"/>'),
    facebook: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#1877f2"/><path d="M13.2 19v-6h2l.3-2.4h-2.3V9.2c0-.7.2-1.2 1.2-1.2h1.2V5.9c-.2 0-1-.1-1.8-.1-1.8 0-3 1.1-3 3.1v1.7h-2V13h2v6z" fill="#fff"/></svg>',
    instagram: S('<rect x="4" y="4" width="16" height="16" rx="4.5"/><circle cx="12" cy="12" r="3.6"/><path d="M16.8 7.2h0" stroke-width="2.4"/>'),
    api: S('<circle cx="12" cy="12" r="8.5"/><path d="M10 9l-3 3 3 3M14 9l3 3-3 3"/>'),
    openai: S('<path d="M12 4.5a3.5 3.5 0 0 1 6 2.5 3.5 3.5 0 0 1 1.5 6 3.5 3.5 0 0 1-4 4.5 3.5 3.5 0 0 1-6.5 1A3.5 3.5 0 0 1 4.5 13 3.5 3.5 0 0 1 6 6.5a3.5 3.5 0 0 1 6-2z"/><path d="M9 9.5l3-1.7 3 1.7v3.5l-3 1.7-3-1.7z"/>'),
    interaction: S('<path d="M12 7v13M8 20l4-13 4 13M9.5 15h5"/><path d="M8.5 4.5a5 5 0 0 1 7 0"/>'),
    reach: S('<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M6 6a8.5 8.5 0 0 0 0 12M18 6a8.5 8.5 0 0 1 0 12"/>'),
    conditions: S('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-4 3.8-6 7-6s6 2 7 6"/>'),
    split: S('<path d="M4 4l6 6M4 4h5M4 4v5"/><path d="M20 4l-6 6M20 4h-5M20 4v5"/><path d="M10 10v10M14 10v10"/>'),
    nbc: S('<rect x="9" y="3" width="6" height="5" rx="1"/><path d="M12 8v3M6 14v-3h12v3"/><rect x="3.5" y="14" width="5" height="5" rx="1"/><path d="M17.5 14.5l.8 1.6 1.7.3-1.2 1.2.3 1.7-1.6-.8-1.6.8.3-1.7-1.2-1.2 1.7-.3z"/>'),
    agent: S('<circle cx="12" cy="7" r="2.5"/><circle cx="5.5" cy="10" r="2"/><circle cx="18.5" cy="10" r="2"/><path d="M8 20v-3a4 4 0 0 1 8 0v3M2.5 19v-1.5a3 3 0 0 1 4.5-2.6M21.5 19v-1.5a3 3 0 0 0-4.5-2.6"/>'),
    decision: S('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
    tag: S('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.3"/>'),
    segment: S('<path d="M6 3h9l4 4v6"/><path d="M6 3v18h6"/><circle cx="17" cy="17" r="4"/><circle cx="17" cy="17" r="1.5"/>'),
    check: S('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'stroke-width="3"'),
  };

  function nodeHTML(n) {
    return `<div class="uca-node k-${n.kind}" data-id="${n.id}"><span class="ic">${ICONS[n.icon] || ICONS.event}</span>` +
      `<span class="tx"><b>${n.label}</b>${n.sub ? `<small>${n.sub}</small>` : ''}</span><span class="uca-tick">${ICONS.check}</span></div>` +
      (n.chip ? `<div class="uca-chip" data-chip="${n.id}">${n.chip}<i>▾</i></div>` : '');
  }

  function measure(n) {
    if (!n) return 0;
    if (n.branches) { n._w = n.branches.reduce((s, b) => s + Math.max(NW, measure(b.next)), 0) + COL_GAP * (n.branches.length - 1); }
    else n._w = Math.max(NW, measure(n.next));
    return n._w;
  }

  function place(n, cx, y, out) {
    n._x = cx; n._y = y; out.nodes.push(n);
    let yb = y + NH;
    if (n.chip) { n._chipY = yb + CHIP_GAP; yb = n._chipY + CHIP_H; }
    n._bottom = yb;
    if (n.next) {
      const cy = yb + GAP + (n.chip ? 6 : 0);
      out.edges.push({ from: n, to: n.next, d: `M${cx},${yb} V${cy}`, plus: [cx, (yb + cy) / 2] });
      place(n.next, cx, cy, out);
    } else if (n.branches) {
      const splitY = yb + SPLIT, total = n._w;
      let left = cx - total / 2;
      n.branches.forEach((b) => {
        const w = Math.max(NW, b.next ? b.next._w : NW), bx = left + w / 2;
        const labelY = splitY + 12, childY = labelY + LABEL_H + GAP;
        out.labels.push({ x: bx, y: labelY, text: b.label, tone: b.tone || 'ok', parent: n });
        out.edges.push({ from: n, to: b.next, d: `M${cx},${yb} V${splitY} H${bx} V${labelY}`, branch: true });
        if (b.next) { out.edges.push({ from: n, to: b.next, d: `M${bx},${labelY + LABEL_H} V${childY}`, plus: [bx, labelY + LABEL_H + GAP / 2], afterLabel: true }); place(b.next, bx, childY, out); }
        left += w + COL_GAP;
      });
    }
  }

  function build(host, spec, o = {}) {
    host = typeof host === 'string' ? document.querySelector(host) : host;
    const out = { nodes: [], edges: [], labels: [] };
    measure(spec); place(spec, spec._w / 2, 0, out);
    const W = spec._w, H = Math.max(...out.nodes.map((n) => n._bottom)) + 4;
    const scale = o.scale || Math.min(1, (o.maxW || W) / W, (o.maxH || H) / H);
    const canvas = document.createElement('div'); canvas.className = 'uca-canvas';
    canvas.style.cssText = `position:absolute;left:${o.x || 0}px;top:${o.y || 0}px;width:${W}px;height:${H}px;transform:scale(${scale});transform-origin:0 0;`;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('class', 'uca-edges');
    canvas.appendChild(svg);
    const J = { host, canvas, scale, x: o.x || 0, y: o.y || 0, nodes: {}, edges: [], labels: [], spec, order: [] };
    out.edges.forEach((e) => { const p = document.createElementNS(svgNS, 'path'); p.setAttribute('d', e.d); svg.appendChild(p); e.el = p;
      if (e.plus) { const pl = document.createElement('div'); pl.className = 'uca-plus'; pl.textContent = '+'; pl.style.left = e.plus[0] + 'px'; pl.style.top = e.plus[1] + 'px'; canvas.appendChild(pl); e.plusEl = pl; }
      J.edges.push(e); });
    out.labels.forEach((l) => { const d = document.createElement('div'); d.className = 'uca-blabel ' + l.tone; d.textContent = l.text; d.style.left = l.x + 'px'; d.style.top = l.y + 'px'; canvas.appendChild(d); l.el = d; J.labels.push(l); });
    out.nodes.forEach((n) => { const wrap = document.createElement('div'); wrap.innerHTML = nodeHTML(n);
      const el = wrap.firstElementChild; el.style.left = (n._x - NW / 2) + 'px'; el.style.top = n._y + 'px'; el.style.width = NW + 'px'; el.style.height = NH + 'px'; canvas.appendChild(el);
      const chip = wrap.querySelector('.uca-chip'); if (chip) { chip.style.left = n._x + 'px'; chip.style.top = n._chipY + 'px'; canvas.appendChild(chip); }
      J.nodes[n.id] = { n, el, chip }; J.order.push(n.id); });
    host.appendChild(canvas);
    // prepare edges for draw-on animation
    J.edges.forEach((e) => { const L = e.el.getTotalLength(); e.len = L; e.el.style.strokeDasharray = L; e.el.style.strokeDashoffset = 0; });
    return J;
  }

  /** stage coordinates of a node anchor: side = top|bottom|left|right|center */
  function anchor(J, id, side = 'center') {
    const n = J.nodes[id].n, s = J.scale;
    const pts = { top: [n._x, n._y], bottom: [n._x, n._y + NH], left: [n._x - NW / 2, n._y + NH / 2], right: [n._x + NW / 2, n._y + NH / 2], center: [n._x, n._y + NH / 2] };
    const p = pts[side];
    return [J.x + p[0] * s, J.y + p[1] * s];
  }

  /** Reveal the whole journey in build order (depth-first by row). Items start hidden. */
  function animateBuild(T, J, start, step = 0.32) {
    // sort nodes by y then x for a natural top→down reveal
    const ids = [...J.order].sort((a, b) => J.nodes[a].n._y - J.nodes[b].n._y || J.nodes[a].n._x - J.nodes[b].n._x);
    const when = {};
    let t = start, lastY = null;
    ids.forEach((id) => { const y = J.nodes[id].n._y; if (lastY !== null && y !== lastY) t += step; when[id] = t; lastY = y; });
    ids.forEach((id) => { const { el, chip } = J.nodes[id]; el.setAttribute('data-uc-hidden', ''); T.show(el, when[id], { anim: 'pop', dur: 0.35 });
      if (chip) { chip.setAttribute('data-uc-hidden', ''); T.show(chip, when[id] + 0.15, { anim: 'fade', dur: 0.25 }); } });
    J.edges.forEach((e) => { const to = e.to ? when[e.to.id] : when[e.from.id] + step; const st = when[e.from.id] + 0.2;
      e.el.style.strokeDashoffset = e.len; T.tween(e.el, 'strokeDashoffset', e.len, 0, st, Math.max(0.15, (to - st) * 0.8), { ease: 'linear' });
      if (e.plusEl) { e.plusEl.setAttribute('data-uc-hidden', ''); T.show(e.plusEl, to - 0.05, { anim: 'fade', dur: 0.2 }); } });
    J.labels.forEach((l) => { l.el.setAttribute('data-uc-hidden', ''); T.show(l.el, when[l.parent.id] + step * 0.7, { anim: 'pop', dur: 0.3 }); });
    J.builtAt = Math.max(...Object.values(when)) + 0.4;
    return J.builtAt;
  }

  function check(T, J, id, at) { T.cls(J.nodes[id].el, 'done', at); return T; }
  function active(T, J, id, at, until) { T.cls(J.nodes[id].el, 'active', at, { until }); return T; }

  /** Persona marker (avatar + name pill) that sits left of nodes. */
  function persona(J, o) {
    const el = document.createElement('div'); el.className = 'uca-persona';
    el.innerHTML = `<span class="nm">${o.name}</span><span class="av" style="background:${o.color || '#e8462b'}">${o.initial || o.name[0]}</span>`;
    el.setAttribute('data-uc-hidden', ''); J.host.appendChild(el); return { el, o };
  }
  /** steps: [[nodeId, time], ...] — appears at first, glides to each next node. */
  function walk(T, J, P, steps, o = {}) {
    const pos = (id) => { const [x, y] = anchor(J, id, 'left'); return [x - 8, y]; };
    const [x0, y0] = pos(steps[0][0]);
    P.el.style.left = x0 + 'px'; P.el.style.top = y0 + 'px';
    T.show(P.el, steps[0][1], { anim: 'pop', dur: 0.35 });
    for (let i = 1; i < steps.length; i++) {
      const [a, b] = [pos(steps[i - 1][0]), pos(steps[i][0])], at = steps[i][1] - (o.travel || 0.7);
      T.tween(P.el, 'left', a[0], b[0], at, o.travel || 0.7, { unit: 'px' });
      T.tween(P.el, 'top', a[1], b[1], at, o.travel || 0.7, { unit: 'px' });
    }
    return T;
  }
  /** Small pill attached to a node: outcome ('ok' green, 'bad' red, 'time' yellow). */
  function pill(T, J, id, text, at, o = {}) {
    const el = document.createElement('div'); el.className = 'uca-pill ' + (o.tone || 'ok'); el.innerHTML = text; el.setAttribute('data-uc-hidden', '');
    const side = o.side || 'below'; let [x, y] = anchor(J, id, side === 'below' ? 'bottom' : 'right');
    if (side === 'below') { y += 8 * J.scale + 4; el.style.translate = '-50% 0'; } else { x += 10; y -= 12; }
    el.style.left = x + 'px'; el.style.top = y + 'px'; J.host.appendChild(el);
    T.show(el, at, { anim: 'pop', dur: 0.3 }); if (o.until) T.hide(el, o.until);
    return el;
  }
  /** Curved connector from a node side to a stage point (e.g. a mockup edge). Draws on. */
  function link(T, J, id, side, to, at, o = {}) {
    const [x1, y1] = anchor(J, id, side), [x2, y2] = to;
    const svgNS = 'http://www.w3.org/2000/svg';
    let svg = J.host.querySelector(':scope > svg.uca-links');
    if (!svg) { svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('class', 'uca-links'); J.host.appendChild(svg); }
    const p = document.createElementNS(svgNS, 'path'), dx = (x2 - x1) * 0.5;
    p.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`); svg.appendChild(p);
    const L = p.getTotalLength(); p.style.strokeDasharray = L; p.style.strokeDashoffset = L;
    T.tween(p, 'strokeDashoffset', L, 0, at, o.dur || 0.6, { ease: 'out' });
    return p;
  }

  window.UCJ = { build, anchor, animateBuild, check, active, persona, walk, pill, link, ICONS, NW, NH };
})();
