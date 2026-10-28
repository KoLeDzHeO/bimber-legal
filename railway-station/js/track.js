/*
 * Путевой граф: узлы, отрезки, стрелки, рельсовые цепи, геометрия.
 * Направленный отрезок {seg, dir}: dir = +1 — движение от левого узла к правому.
 */
(function () {
  const RS = (window.RS = window.RS || {});
  const L = RS.LAYOUT;

  const T = {
    M: L.M,
    nodes: {},
    segs: {},
    switches: {}, // по узлу
    groups: {}, // органы управления (в т.ч. спаренные)
    sections: {},
    signals: {},
    signalAt: {}, // ключ `${node}|${seg}` → светофор для движения из seg через node
    boundary: {}, // ключ `${node}|${lineSeg}` → true
  };

  function build() {
    for (const [id, v] of Object.entries(L.nodes)) {
      T.nodes[id] = { id, x: v[0], y: v[1], end: v[2] || null, segs: [] };
    }
    for (const s of L.segs) {
      const [id, a, b, sec, via, lenM] = s;
      const na = T.nodes[a], nb = T.nodes[b];
      const pts = [[na.x, na.y], ...(via || []), [nb.x, nb.y]];
      for (let i = 1; i < pts.length; i++) {
        if (!(pts[i][0] > pts[i - 1][0])) throw new Error('Отрезок ' + id + ' должен идти слева направо');
      }
      const diag = pts.some((p, i) => i > 0 && p[1] !== pts[i - 1][1]);
      // mpu — метров в единице схемы: на станции M, на сжатых отрезках перегона больше
      const mpu = lenM ? lenM / (nb.x - na.x) : T.M;
      const seg = {
        id, a, b, sec, pts, xa: na.x, xb: nb.x, mpu,
        len: (nb.x - na.x) * mpu,
        diag,
        vmax: 120,
      };
      T.segs[id] = seg;
      na.segs.push(id);
      nb.segs.push(id);
      if (!T.sections[sec]) T.sections[sec] = { id: sec, segs: [], switches: [], occupied: false, lock: null, everOcc: false };
      T.sections[sec].segs.push(id);
    }
    // Скорости: переводные кривые — 40 км/ч, пути станции — по характеристике.
    for (const seg of Object.values(T.segs)) {
      const tr = L.tracks[seg.sec];
      if (seg.diag) seg.vmax = 40;
      else if (tr) seg.vmax = tr.vmax;
    }
    for (const [node, [toe, plus, minus]] of Object.entries(L.switches)) {
      const sw = { node, toe, plus, minus, group: null, sec: T.segs[toe].sec };
      T.switches[node] = sw;
      T.sections[sw.sec].switches.push(node);
    }
    for (const [gid, members] of Object.entries(L.groups)) {
      T.groups[gid] = {
        id: gid, members, pos: 'plus', target: null, t: 0,
        locks: new Map(), // routeId → требуемое положение
        damaged: false, repairT: 0,
      };
      for (const m of members) T.switches[m].group = gid;
    }
    for (const [name, node, seg, kind] of L.signals) {
      const sg = T.segs[seg];
      const dir = sg.b === node ? 1 : -1;
      const sig = {
        id: name, name, node, seg, kind, dir,
        shunt: kind === 'exit' || kind === 'shunt',
        train: kind === 'entry' || kind === 'exit',
        aspect: kind === 'shunt' ? 'B' : 'R',
        invite: 0, // остаток времени пригласительного сигнала, с
      };
      T.signals[name] = sig;
      T.signalAt[node + '|' + seg] = sig;
    }
    for (const [node, lineSeg] of L.boundaries) T.boundary[node + '|' + lineSeg] = true;
  }

  // --- геометрия -----------------------------------------------------------
  T.yAt = function (seg, x) {
    const p = seg.pts;
    if (x <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) {
      if (x <= p[i][0]) {
        const t = (x - p[i - 1][0]) / (p[i][0] - p[i - 1][0]);
        return p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t;
      }
    }
    return p[p.length - 1][1];
  };

  // x точки на направленном отрезке на расстоянии off (м) от его начала.
  T.xAt = function (seg, dir, off) {
    return dir > 0 ? seg.xa + off / seg.mpu : seg.xb - off / seg.mpu;
  };

  // Смещение (м) точки x от начала направленного отрезка.
  T.offAt = (seg, dir, x) => (dir > 0 ? x - seg.xa : seg.xb - x) * seg.mpu;

  // Путь в метрах по перечисленным отрезкам между координатами x1 < x2.
  T.alongX = function (segIds, x1, x2) {
    let d = 0;
    for (const id of segIds) {
      const s = T.segs[id];
      const a = Math.max(x1, s.xa), b = Math.min(x2, s.xb);
      if (b > a) d += (b - a) * s.mpu;
    }
    return d;
  };

  T.pointAt = function (seg, dir, off) {
    const x = T.xAt(seg, dir, off);
    return [x, T.yAt(seg, x)];
  };

  // Вершины ломаной между x1 и x2 (в порядке от x1 к x2).
  T.vertsBetween = function (seg, x1, x2) {
    const out = [[x1, T.yAt(seg, x1)]];
    const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
    const inner = seg.pts.filter((p) => p[0] > lo && p[0] < hi);
    if (x2 < x1) inner.reverse();
    for (const p of inner) out.push([p[0], p[1]]);
    out.push([x2, T.yAt(seg, x2)]);
    return out;
  };

  // --- топология -------------------------------------------------------------
  T.endNode = (seg, dir) => (dir > 0 ? T.segs[seg].b : T.segs[seg].a);
  T.startNode = (seg, dir) => (dir > 0 ? T.segs[seg].a : T.segs[seg].b);
  T.dirFrom = (seg, node) => (T.segs[seg].a === node ? 1 : -1);

  T.groupOf = (swNode) => T.groups[T.switches[swNode].group];

  // Куда попадёт подвижной состав, проехав узел node, придя по отрезку fromSeg.
  // Возвращает {seg, dir, sw, branch, trailing, wrong} | {end: 'buffer'|'portal'} | {blocked}.
  T.next = function (node, fromSeg) {
    const n = T.nodes[node];
    const sw = T.switches[node];
    if (sw) {
      const g = T.groups[sw.group];
      if (fromSeg === sw.toe) {
        if (g.target || g.damaged) return { blocked: g.damaged ? 'damaged' : 'moving', sw: node };
        const out = g.pos === 'plus' ? sw.plus : sw.minus;
        return { seg: out, dir: T.dirFrom(out, node), sw: node, branch: g.pos, trailing: false };
      }
      const branch = fromSeg === sw.plus ? 'plus' : 'minus';
      const wrong = g.damaged || !!g.target || g.pos !== branch;
      return { seg: sw.toe, dir: T.dirFrom(sw.toe, node), sw: node, branch, trailing: true, wrong };
    }
    if (n.segs.length === 1) return { end: n.end || 'buffer' };
    const out = n.segs[0] === fromSeg ? n.segs[1] : n.segs[0];
    return { seg: out, dir: T.dirFrom(out, node) };
  };

  // Все варианты выхода из узла (для поиска маршрутов): с учётом обоих направлений стрелки.
  T.branches = function (node, fromSeg) {
    const n = T.nodes[node];
    const sw = T.switches[node];
    if (sw) {
      if (fromSeg === sw.toe) {
        return [
          { seg: sw.plus, dir: T.dirFrom(sw.plus, node), sw: node, pos: 'plus' },
          { seg: sw.minus, dir: T.dirFrom(sw.minus, node), sw: node, pos: 'minus' },
        ];
      }
      const pos = fromSeg === sw.plus ? 'plus' : 'minus';
      return [{ seg: sw.toe, dir: T.dirFrom(sw.toe, node), sw: node, pos }];
    }
    if (n.segs.length === 1) return [];
    const out = n.segs[0] === fromSeg ? n.segs[1] : n.segs[0];
    return [{ seg: out, dir: T.dirFrom(out, node) }];
  };

  T.isBoundary = (node, toSeg) => !!T.boundary[node + '|' + toSeg];

  // Светофор, действующий для движения по fromSeg в узел node (если есть).
  T.signalFor = (node, fromSeg) => T.signalAt[node + '|' + fromSeg] || null;

  T.trackName = function (sec) {
    const tr = L.tracks[sec];
    return tr ? tr.name : sec;
  };

  build();
  RS.Track = T;
})();
