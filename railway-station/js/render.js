/*
 * Отрисовка табло (SVG): пути, рельсовые цепи, стрелки, светофоры, составы.
 */
(function () {
  const RS = window.RS;
  const T = RS.Track;
  const C = RS.Consist;
  const IL = RS.IL;
  const LAY = RS.LAYOUT;
  const NS = 'http://www.w3.org/2000/svg';

  const R = { segEls: {}, secState: {}, swEls: {}, sigEls: {}, trainEls: {}, view: Object.assign({}, LAY.view) };

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }
  const pathD = (pts) => 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
  const text = (parent, x, y, s, cls, anchor) => {
    const t = el('text', { x, y, class: cls || '', 'text-anchor': anchor || 'middle' }, parent);
    t.textContent = s;
    return t;
  };

  // Лампы светофоров (снаружи — к мачте), как сверху вниз на реальной голове.
  const LAMPS = {
    entry: ['Y1', 'G', 'R', 'Y2', 'W'],
    exit: ['Y1', 'G', 'R', 'Y2', 'W'],
    pre: ['Y1', 'G', 'R'],
    block: ['Y1', 'G', 'R'],
    shunt: ['B', 'W'],
  };
  const LIT = {
    R: { R: 1 }, G: { G: 1 }, Y: { Y1: 1 }, YF: { Y1: 2 }, YY: { Y1: 1, Y2: 1 },
    YFY: { Y1: 2, Y2: 1 }, RW: { R: 1, W: 2 }, W: { W: 1 }, B: { B: 1 },
  };
  const LAMP_CLASS = { R: 'l-red', G: 'l-grn', Y1: 'l-yel', Y2: 'l-yel', W: 'l-wht', B: 'l-blu' };

  R.init = function (svg) {
    R.svg = svg;
    svg.innerHTML = '';
    const defs = el('defs', null, svg);
    defs.innerHTML =
      '<filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="1.6" result="b"/>' +
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<rect width="6" height="6" class="plat-bg"/><line x1="0" y1="0" x2="0" y2="6" class="plat-hatch"/></pattern>';
    const world = el('g', { id: 'world' }, svg);
    R.gDecor = el('g', { class: 'decor' }, world);
    R.gHl = el('g', { class: 'hl' }, world);
    R.gHit = el('g', { class: 'hits' }, world);
    R.gTrk = el('g', { class: 'tracks' }, world);
    R.gJoint = el('g', { class: 'joints' }, world);
    R.gSw = el('g', { class: 'switches' }, world);
    R.gLbl = el('g', { class: 'labels' }, world);
    R.gTrain = el('g', { class: 'trains' }, world);
    R.gSig = el('g', { class: 'signals' }, world);
    R.gSel = el('g', { class: 'sel' }, world);
    drawDecor();
    drawTracks();
    drawSwitches();
    drawSignals();
    R.fit();
  };

  function drawDecor() {
    const g = R.gDecor;
    for (const p of LAY.platforms) {
      el('rect', { x: p.x1, y: p.y1, width: p.x2 - p.x1, height: p.y2 - p.y1, rx: 2, class: 'platform' }, g);
      text(g, (p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2 + 3.5, p.name, 'plat-label');
    }
    const Y = LAY.Y;
    const yI = Y(196), yII = Y(160), y7 = Y(316), y8 = Y(40);
    // пешеходный мост к платформам и пассажирское здание
    el('rect', { x: 703, y: Y(121), width: 10, height: y7 + 24 - Y(121), class: 'bridge' }, g);
    el('rect', { x: 590, y: y7 + 22, width: 240, height: 28, rx: 2, class: 'building' }, g);
    text(g, 710, y7 + 40, 'Пассажирское здание · пост ЭЦ', 'bld-label');
    el('rect', { x: 630, y: y8 - 36, width: 280, height: 22, rx: 2, class: 'building' }, g);
    text(g, 770, y8 - 21, 'Грузовой двор · крытый склад', 'bld-label');
    text(g, 4, yI + 54, '← ст. ' + LAY.neighbours.left, 'dir-label', 'start');
    text(g, 4, yI + 68, 'нечётные поезда прибывают →', 'dir-sub', 'start');
    text(g, 1416, yII - 62, 'ст. ' + LAY.neighbours.right + ' →', 'dir-label', 'end');
    text(g, 1416, yII - 48, '← чётные поезда прибывают', 'dir-sub', 'end');
    // граница станции (по входным светофорам)
    for (const x of [150, 1270]) el('line', { x1: x, y1: yII - 30, x2: x, y2: yI + 26, class: 'boundary' }, g);
    text(g, 150, yII - 34, 'граница ст.', 'tiny');
    text(g, 1270, yI + 36, 'граница ст.', 'tiny');
  }

  function drawTracks() {
    for (const seg of Object.values(T.segs)) {
      const d = pathD(seg.pts);
      el('path', { d, class: 'hit', 'data-seg': seg.id }, R.gHit);
      const p = el('path', { d, class: 'seg', 'data-seg': seg.id }, R.gTrk);
      (R.segEls[seg.sec] = R.segEls[seg.sec] || []).push(p);
    }
    // изолирующие стыки — на границах рельсовых цепей
    for (const n of Object.values(T.nodes)) {
      if (n.segs.length !== 2) continue;
      const [a, b] = n.segs.map((s) => T.segs[s].sec);
      if (a === b) continue;
      el('line', { x1: n.x, y1: n.y - 5.5, x2: n.x, y2: n.y + 5.5, class: 'joint' }, R.gJoint);
    }
    for (const n of Object.values(T.nodes)) {
      if (n.end !== 'buffer') continue;
      const s = T.segs[n.segs[0]];
      const dx = s.a === n.id ? -1 : 1;
      el('path', { d: `M${n.x - dx * 0} ${n.y - 6}L${n.x} ${n.y + 6}M${n.x} ${n.y - 6}L${n.x + dx * 4} ${n.y - 6}M${n.x} ${n.y + 6}L${n.x + dx * 4} ${n.y + 6}`, class: 'buffer' }, R.gJoint);
    }
    // номера путей
    for (const [sec, tr] of Object.entries(LAY.tracks)) {
      const seg = T.segs[T.sections[sec].segs[0]];
      const xs = sec === '8П' ? [600, 896] : sec === '10П' ? [-100] : sec === '9П' ? [1500] : [524, 896];
      for (const x of xs) {
        const y = T.yAt(seg, x) - 7;
        el('rect', { x: x - 13, y: y - 12, width: 26, height: 14, rx: 2, class: 'trk-tag' }, R.gLbl);
        text(R.gLbl, x, y - 1.5, tr.name, 'trk-num');
      }
    }
    // названия участков на перегонах
    for (const sec of ['НП1', 'НП2', 'ЧУ1', 'ЧУ2', 'НУ1', 'НУ2', 'ЧП1', 'ЧП2']) {
      const seg = T.segs[T.sections[sec].segs[0]];
      const x1 = Math.max(seg.xa, -60), x2 = Math.min(seg.xb, 1480);
      const up = seg.pts[0][1] === LAY.Y(160);
      text(R.gLbl, (x1 + x2) / 2, seg.pts[0][1] + (up ? -8 : 17), sec, 'sec-label');
    }
  }

  function stub(segId, node, len) {
    const s = T.segs[segId];
    const n = T.nodes[node];
    const l = s.diag ? len * 0.75 : len;
    const x1 = s.a === node ? n.x + 2 : n.x - 2;
    const x2 = s.a === node ? Math.min(s.xb, n.x + l) : Math.max(s.xa, n.x - l);
    return pathD(T.vertsBetween(s, x1, x2));
  }

  function drawSwitches() {
    for (const sw of Object.values(T.switches)) {
      const n = T.nodes[sw.node];
      const gp = el('path', { d: stub(sw.plus, sw.node, 9), class: 'swstub' }, R.gSw);
      const gm = el('path', { d: stub(sw.minus, sw.node, 9), class: 'swstub' }, R.gSw);
      const mseg = T.segs[sw.minus];
      const other = mseg.a === sw.node ? T.nodes[mseg.b] : T.nodes[mseg.a];
      const up = other.y < n.y || (mseg.pts.some((p) => p[1] < n.y));
      const label = sw.node.slice(1);
      const ly = up ? n.y + 16 : n.y - 8;
      const hit = el('circle', { cx: n.x, cy: up ? n.y + 6 : n.y - 5, r: 11, class: 'swhit', 'data-sw': sw.group }, R.gSw);
      const t = text(R.gSw, n.x, ly, label, 'swnum');
      t.setAttribute('data-sw', sw.group);
      R.swEls[sw.node] = { gp, gm, t, hit, state: '' };
    }
  }

  function drawSignals() {
    for (const sig of Object.values(T.signals)) {
      const n = T.nodes[sig.node];
      const dir = sig.dir;
      const side = dir > 0 ? 1 : -1; // справа по ходу: для движения вправо — ниже пути
      const y0 = n.y + side * 4.5, y1 = n.y + side * 13;
      const g = el('g', { class: 'signal k-' + sig.kind, 'data-sig': sig.id }, R.gSig);
      const lamps = LAMPS[sig.kind];
      const step = 7.8, r = 3.1;
      const headLen = lamps.length * step + 2;
      const hx0 = n.x - dir * 3, hx1 = hx0 - dir * headLen;
      el('line', { x1: n.x, y1: y0, x2: n.x, y2: y1 + side * 1.5, class: 'mast' }, g);
      el('line', { x1: n.x, y1: y1, x2: hx0, y2: y1, class: 'mast' }, g);
      el('rect', { x: Math.min(hx0, hx1), y: y1 - 4.8, width: headLen, height: 9.6, rx: 4.8, class: 'head' }, g);
      const lampEls = {};
      lamps.forEach((name, i) => {
        // внутренняя (у мачты) — последняя в списке
        const k = lamps.length - 1 - i;
        const cx = hx0 - dir * (1 + step / 2 + k * step);
        lampEls[name] = el('circle', { cx, cy: y1, r, class: 'lamp' }, g);
      });
      const lx = (hx0 + hx1) / 2;
      const t = text(g, lx, y1 + side * 12 + (side > 0 ? 3 : 0), sig.name, 'sig-label');
      el('rect', { x: Math.min(n.x, hx1) - 2, y: Math.min(y0, y1 + side * 17) - 4, width: headLen + 7, height: 27, class: 'sighit' }, g);
      R.sigEls[sig.id] = { g, lamps: lampEls, label: t, aspect: null, x: lx, y: y1 };
    }
  }

  // --- обновление ---------------------------------------------------------------------
  function sectionState(sec) {
    const s = T.sections[sec];
    if (s.occupied) return 'occ';
    if (s.lock) {
      const r = IL.byId(s.lock);
      if (!r) return 'free';
      const ready = Object.entries(r.req).every(([g, p]) => T.groups[g].pos === p && !T.groups[g].target);
      return 'lk-' + r.kind + (r.cancelT > 0 ? ' cancel' : !ready ? ' setting' : '');
    }
    return 'free';
  }

  function updateTracks() {
    for (const sec of Object.keys(T.sections)) {
      const st = sectionState(sec);
      if (R.secState[sec] === st) continue;
      R.secState[sec] = st;
      for (const p of R.segEls[sec]) p.setAttribute('class', 'seg ' + st);
    }
  }

  function updateSwitches() {
    for (const sw of Object.values(T.switches)) {
      const g = T.groups[sw.group];
      const e = R.swEls[sw.node];
      const st = (g.damaged ? 'dmg' : g.target ? 'mov' : g.pos) + (g.locks.size ? ' lck' : '');
      if (e.state === st) continue;
      e.state = st;
      const mv = g.target ? ' moving' : '';
      e.gp.setAttribute('class', 'swstub' + (g.pos === 'minus' || g.target ? ' gap' : '') + mv);
      e.gm.setAttribute('class', 'swstub' + (g.pos === 'plus' || g.target ? ' gap' : '') + mv);
      e.t.setAttribute('class', 'swnum' + (g.damaged ? ' dmg' : g.target ? ' mov' : g.locks.size ? ' lck' : '') + (g.pos === 'minus' ? ' minus' : ''));
    }
  }

  function updateSignals() {
    for (const sig of Object.values(T.signals)) {
      const e = R.sigEls[sig.id];
      if (e.aspect === sig.aspect) continue;
      e.aspect = sig.aspect;
      const lit = LIT[sig.aspect] || {};
      for (const [name, c] of Object.entries(e.lamps)) {
        const on = lit[name];
        c.setAttribute('class', 'lamp' + (on ? ' on ' + LAMP_CLASS[name] : '') + (on === 2 ? ' blink' : ''));
      }
    }
  }

  const VEH_CLASS = (v) => 'veh v-' + v.kind + (v.dest === LAY.station ? ' dest' : '');

  function updateTrains() {
    const seen = new Set();
    const sel = RS.UI && RS.UI.selected;
    for (const c of C.list) {
      seen.add(c.id);
      let te = R.trainEls[c.id];
      if (!te) {
        const g = el('g', { class: 'consist', 'data-c': c.id }, R.gTrain);
        te = R.trainEls[c.id] = { g, outl: [], body: [], label: null, sig: '' };
        te.label = text(g, 0, 0, '', 'train-label');
      }
      const sig = c.vehicles.map((v) => v.id).join(',');
      if (te.sig !== sig) {
        for (const e of te.outl.concat(te.body)) e.remove();
        te.outl = c.vehicles.map((v) => el('path', { class: 'veh-out' + (v.dest === LAY.station ? ' dest' : '') }, te.g));
        te.body = c.vehicles.map((v) => el('path', { class: VEH_CLASS(v) }, te.g));
        te.sig = sig;
        c.dirty = true;
      }
      te.g.setAttribute('class', 'consist' + (sel === c.id ? ' selected' : '') + (c.ctl === 'ai' ? ' ai' : ''));
      if (!c.dirty) continue;
      c.dirty = false;
      let d = 0;
      for (let i = c.vehicles.length - 1; i >= 0; i--) {
        const v = c.vehicles[i];
        const gap = v.loco && v.kind !== 'emu' ? 0.9 : 1.2;
        const pts = C.polyBetween(c, d + gap, d + v.len - gap);
        const dd = pts.length > 1 ? pathD(pts) : '';
        te.outl[i].setAttribute('d', dd);
        te.body[i].setAttribute('d', dd);
        d += v.len;
      }
      const info = c.info || {};
      let lbl = '';
      if (info.cat === 'shunt' || info.cat === 'light') lbl = info.num;
      else if (info.cat !== 'cut') lbl = '№' + info.num;
      else lbl = C.carCount(c) + ' ваг.';
      const sd = C.screenDir(c);
      const fp = C.frontPoint(c), rp = C.rearPoint(c);
      const tdir = info.dir === 'odd' ? 1 : info.dir === 'even' ? -1 : sd;
      const p = tdir === sd ? fp : rp;
      te.label.textContent = lbl;
      te.label.setAttribute('x', p[0].toFixed(1));
      te.label.setAttribute('y', (p[1] - 9).toFixed(1));
      te.label.setAttribute('text-anchor', tdir > 0 ? 'end' : 'start');
    }
    for (const id of Object.keys(R.trainEls)) {
      if (!seen.has(id)) {
        R.trainEls[id].g.remove();
        delete R.trainEls[id];
      }
    }
  }

  R.update = function () {
    updateTracks();
    updateSwitches();
    updateSignals();
    updateTrains();
  };

  // --- подсветка при наборе маршрута -------------------------------------------------
  R.highlight = function (startSig, cands) {
    R.gHl.innerHTML = '';
    R.gSel.innerHTML = '';
    if (!startSig) return;
    const e = R.sigEls[startSig];
    el('circle', { cx: e.x, cy: e.y, r: 14, class: 'sel-ring' }, R.gSel);
    for (const c of cands || []) {
      for (const segId of T.sections[c.dest].segs) {
        el('path', { d: pathD(T.segs[segId].pts), class: 'cand' + (c.kind === 'shunt' ? ' shunt' : '') }, R.gHl);
      }
      if (c.end.sig && R.sigEls[c.end.sig]) {
        const t = R.sigEls[c.end.sig];
        el('circle', { cx: t.x, cy: t.y, r: 12, class: 'cand-ring' + (c.kind === 'shunt' ? ' shunt' : '') }, R.gSel);
      }
    }
  };

  // --- вид: панорама и масштаб ---------------------------------------------------------
  R.applyView = function () {
    const v = R.view;
    R.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  };

  // Вся станция с подходами; на узком (портретном) табло — только горловины и пути.
  R.fit = function () {
    const v = Object.assign({}, LAY.view);
    const b = R.svg.getBoundingClientRect();
    if (b.width && b.width / b.height < 1.25) {
      v.x = 108;
      v.w = 1204;
    }
    R.view = v;
    R.applyView();
  };

  R.toWorld = function (cx, cy) {
    const pt = R.svg.createSVGPoint();
    pt.x = cx;
    pt.y = cy;
    const m = R.svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  R.zoomAt = function (cx, cy, k) {
    const v = R.view;
    const w = Math.min(4200, Math.max(160, v.w * k));
    const kk = w / v.w;
    const p = R.toWorld(cx, cy);
    v.x = p.x - (p.x - v.x) * kk;
    v.y = p.y - (p.y - v.y) * kk;
    v.w = w;
    v.h = v.h * kk;
    R.applyView();
  };

  R.panBy = function (dxPx, dyPx) {
    const m = R.svg.getScreenCTM();
    if (!m) return;
    R.view.x -= dxPx / m.a;
    R.view.y -= dyPx / m.d;
    R.applyView();
  };

  R.centerOn = function (x, y) {
    R.view.x = x - R.view.w / 2;
    R.view.y = y - R.view.h / 2;
    R.applyView();
  };

  R.LAMPS = LAMPS;
  R.LIT = LIT;
  RS.Render = R;
})();
