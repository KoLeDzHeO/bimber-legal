/*
 * Подвижной состав: вагоны и локомотивы, положение составов на путевом графе,
 * движение, автоматическая защита (аналог КЛУБ-У), сцепление и расцепление.
 * Состав занимает цепочку направленных отрезков chain (от хвоста к голове);
 * голова находится на последнем отрезке на расстоянии frontOff от его начала.
 */
(function () {
  const RS = window.RS;
  const T = RS.Track;

  const VEH = {
    '2ЭС5К': { len: 35.0, loco: true, kind: 'eloco', power: 1.0 },
    '3ЭС5К': { len: 52.5, loco: true, kind: 'eloco', power: 1.4 },
    'ВЛ80С': { len: 32.8, loco: true, kind: 'eloco', power: 0.9 },
    '2ЭС6': { len: 34.0, loco: true, kind: 'eloco', power: 1.0 },
    'ЭП1М': { len: 22.9, loco: true, kind: 'ploco', power: 0.9 },
    'ЧС7': { len: 33.0, loco: true, kind: 'ploco', power: 1.0 },
    'ЭП2К': { len: 22.0, loco: true, kind: 'ploco', power: 0.9 },
    'ЧМЭ3': { len: 17.2, loco: true, kind: 'dloco', power: 0.6 },
    'ТЭМ2': { len: 17.0, loco: true, kind: 'dloco', power: 0.55 },
    'ЭД4М': { len: 21.6, loco: true, kind: 'emu', power: 0.7 },
    'пасс': { len: 24.5, kind: 'pcar', title: 'пассажирский вагон' },
    'К': { len: 14.7, kind: 'box', title: 'крытый вагон' },
    'ПВ': { len: 13.9, kind: 'gondola', title: 'полувагон' },
    'Ц': { len: 12.0, kind: 'tank', title: 'цистерна' },
    'ПЛ': { len: 14.6, kind: 'flat', title: 'платформа' },
    'Х': { len: 14.7, kind: 'hopper', title: 'хоппер' },
  };
  const FIRST_DIGIT = { box: '2', flat: '4', gondola: '6', tank: '7', hopper: '9', pcar: '0' };

  const C = { list: [], nextId: 1, segOcc: {}, VEH };
  const kmh = (v) => v / 3.6;
  const L = (seg) => T.segs[seg].len;
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

  C.vehicle = function (type, extra) {
    const d = VEH[type];
    const v = Object.assign({ id: 'v' + C.nextId++, type, kind: d.kind, len: d.len, loco: !!d.loco }, extra || {});
    if (!v.num) {
      if (v.loco) v.num = type + '-' + rnd(10, 999).toString().padStart(3, '0');
      else v.num = (FIRST_DIGIT[d.kind] || '5') + String(rnd(1000000, 9999999));
    }
    return v;
  };

  C.length = (c) => c.vehicles.reduce((s, v) => s + v.len, 0);
  C.hasLoco = (c) => c.vehicles.some((v) => v.loco);
  C.carCount = (c) => c.vehicles.filter((v) => !v.loco).length;

  // --- положение ---------------------------------------------------------------
  function prependRear(c) {
    const c0 = c.chain[0];
    const node = T.startNode(c0.seg, c0.dir);
    const nx = T.next(node, c0.seg);
    if (!nx.seg) return false;
    c.chain.unshift({ seg: nx.seg, dir: -nx.dir });
    return true;
  }

  function fixRear(c) {
    const len = c.length;
    const ch = c.chain;
    let dist = c.frontOff;
    for (let i = 0; i < ch.length - 1; i++) dist += L(ch[i].seg);
    while (ch.length > 1 && dist - L(ch[0].seg) >= len) {
      dist -= L(ch[0].seg);
      ch.shift();
    }
    while (dist < len) {
      if (!prependRear(c)) break;
      dist += L(ch[0].seg);
    }
    c.rearOff = Math.max(0, dist - len);
  }

  C.create = function (o) {
    const c = {
      id: 'c' + C.nextId++,
      vehicles: o.vehicles,
      chain: [{ seg: o.seg, dir: o.dir }],
      frontOff: o.frontOff,
      rearOff: 0,
      v: o.v || 0,
      move: 0,
      ctl: o.ctl || 'manual',
      setDir: 0,
      setV: 25,
      info: o.info,
      ai: o.ai || null,
      lastSig: null,
      status: '',
      waitT: 0,
    };
    if (o.info && o.info.cat !== 'cut') {
      const owner = { info: o.info, ai: c.ai };
      for (const v of c.vehicles) {
        if (v.loco && !v.owner) v.owner = owner;
        if (!v.loco && o.info.num && !['shunt', 'light'].includes(o.info.cat)) v.ofTrain = o.info.num;
      }
    }
    c.length = C.length(c);
    fixRear(c);
    C.list.push(c);
    return c;
  };

  // Кем является состав: определяется локомотивами в нём. Маневровый локомотив
  // «ведёт» состав, к которому прицеплен; поездной локомотив несёт номер поезда.
  C.identify = function (c) {
    const owners = c.vehicles.filter((v) => v.owner).map((v) => v.owner);
    const shunt = owners.find((o) => o.info.cat === 'shunt');
    const train = owners.find((o) => o.info.cat !== 'shunt');
    if (shunt) { c.info = shunt.info; c.ai = null; return; }
    if (train) { c.info = train.info; c.ai = train.ai; return; }
    const loco = c.vehicles.find((v) => v.loco);
    if (loco) {
      loco.owner = { info: { num: loco.num, cat: 'light', title: 'Локомотив' }, ai: null };
      c.info = loco.owner.info;
      c.ai = null;
      return;
    }
    const tally = {};
    for (const v of c.vehicles) if (v.ofTrain) tally[v.ofTrain] = (tally[v.ofTrain] || 0) + 1;
    const of = Object.keys(tally).sort((x, y) => tally[y] - tally[x])[0] || null;
    c.info = { num: '', cat: 'cut', title: 'Отцеп', ofTrain: of };
    c.ai = null;
  };

  C.remove = function (c) {
    C.list = C.list.filter((x) => x !== c);
    if (RS.UI && RS.UI.selected === c.id) RS.UI.selected = null;
  };

  function passNode(c, node, fromSeg, nx) {
    const sig = T.signalFor(node, fromSeg);
    if (sig) c.lastSig = { id: sig.id, aspect: sig.aspect, kind: sig.kind };
    if (nx.trailing && nx.wrong) RS.IL.cutSwitch(nx.sw, nx.branch);
  }

  // Перемещение на x метров: x > 0 — в сторону головы цепочки, x < 0 — в сторону хвоста.
  C.moveBy = function (c, x) {
    const ch = c.chain;
    const res = {};
    if (x > 0) {
      c.frontOff += x;
      while (c.frontOff > L(ch[ch.length - 1].seg)) {
        const last = ch[ch.length - 1];
        const node = T.endNode(last.seg, last.dir);
        const nx = T.next(node, last.seg);
        if (!nx.seg) {
          c.frontOff = L(last.seg);
          res.hit = nx.end || nx.blocked;
          break;
        }
        passNode(c, node, last.seg, nx);
        c.frontOff -= L(last.seg);
        ch.push({ seg: nx.seg, dir: nx.dir });
      }
    } else if (x < 0) {
      let d = -x;
      let rear = c.rearOff - d;
      while (rear < 0) {
        const c0 = ch[0];
        const node = T.startNode(c0.seg, c0.dir);
        const nx = T.next(node, c0.seg);
        if (!nx.seg) {
          d += rear; // упёрлись хвостом — сдвигаемся только до конца пути
          res.hit = nx.end || nx.blocked;
          break;
        }
        // хвост проходит узел против направления цепочки — светофоры ему навстречу
        const sig = T.signalFor(node, c0.seg);
        if (sig) c.lastSig = { id: sig.id, aspect: sig.aspect, kind: sig.kind };
        if (nx.trailing && nx.wrong) RS.IL.cutSwitch(nx.sw, nx.branch);
        ch.unshift({ seg: nx.seg, dir: -nx.dir });
        rear += L(nx.seg);
      }
      c.frontOff -= d;
      while (c.frontOff < 0 && ch.length > 1) {
        ch.pop();
        c.frontOff += L(ch[ch.length - 1].seg);
      }
      if (c.frontOff < 0) c.frontOff = 0;
    }
    fixRear(c);
    c.dirty = true;
    return res;
  };

  // --- занятость рельсовых цепей ---------------------------------------------------
  C.computeOcc = function () {
    for (const s of Object.values(T.sections)) s.occupied = false;
    const occ = {};
    for (const c of C.list) {
      const n = c.chain.length;
      c.chain.forEach((el, i) => {
        const len = L(el.seg);
        const s0 = i === 0 ? c.rearOff : 0;
        const s1 = i === n - 1 ? c.frontOff : len;
        if (s1 - s0 < 0.01) return;
        const lo = el.dir > 0 ? s0 : len - s1;
        const hi = el.dir > 0 ? s1 : len - s0;
        (occ[el.seg] = occ[el.seg] || []).push({ c, lo, hi });
        T.sections[T.segs[el.seg].sec].occupied = true;
      });
    }
    C.segOcc = occ;
  };

  C.sectionsOf = function (c) {
    const out = [];
    for (const el of c.chain) {
      const s = T.segs[el.seg].sec;
      if (!out.includes(s)) out.push(s);
    }
    return out;
  };

  // --- геометрия для отрисовки -------------------------------------------------------
  C.pointAtBack = function (c, dist) {
    const ch = c.chain;
    let i = ch.length - 1;
    let t = c.frontOff;
    while (dist > t && i > 0) {
      dist -= t;
      i--;
      t = L(ch[i].seg);
    }
    return T.pointAt(T.segs[ch[i].seg], ch[i].dir, Math.max(0, t - dist));
  };

  // Ломаная между расстояниями d1 < d2, отсчитанными от головы.
  C.polyBetween = function (c, d1, d2) {
    const ch = c.chain;
    const n = ch.length;
    const out = [];
    let acc = 0;
    for (let i = n - 1; i >= 0 && acc < d2; i--) {
      const el = ch[i];
      const seg = T.segs[el.seg];
      const tLo = i === 0 ? c.rearOff : 0;
      const tHi = i === n - 1 ? c.frontOff : seg.len;
      const cov = tHi - tLo;
      const a = Math.max(d1, acc), b = Math.min(d2, acc + cov);
      if (b > a) {
        const x1 = T.xAt(seg, el.dir, tHi - (a - acc));
        const x2 = T.xAt(seg, el.dir, tHi - (b - acc));
        const pts = T.vertsBetween(seg, x1, x2);
        if (out.length) pts.shift();
        out.push(...pts);
      }
      acc += cov;
    }
    return out;
  };

  C.frontPoint = (c) => C.pointAtBack(c, 0);
  C.rearPoint = (c) => C.pointAtBack(c, c.length);
  C.screenDir = (c) => (C.frontPoint(c)[0] >= C.rearPoint(c)[0] ? 1 : -1);

  // --- переворот, расцепка, сцепление -----------------------------------------------
  C.reverse = function (c) {
    const ch = c.chain;
    const newFront = L(ch[0].seg) - c.rearOff;
    c.chain = ch.slice().reverse().map((e) => ({ seg: e.seg, dir: -e.dir }));
    c.frontOff = newFront;
    c.vehicles.reverse();
    c.move = -c.move;
    fixRear(c);
  };

  C.canSplit = function (c, k) {
    if (k <= 0 || k >= c.vehicles.length) return false;
    const a = c.vehicles[k - 1], b = c.vehicles[k];
    return !(a.unit && a.unit === b.unit);
  };

  // Расцепить между vehicles[k-1] и vehicles[k] (нумерация от хвоста цепочки).
  C.split = function (c, k) {
    if (!C.canSplit(c, k) || c.v > 0.05) return null;
    const front = c.vehicles.slice(k), rear = c.vehicles.slice(0, k);
    const lenF = front.reduce((s, v) => s + v.len, 0);
    const ch = c.chain;
    let i = ch.length - 1, off = c.frontOff, d = lenF;
    while (d > off && i > 0) {
      d -= off;
      i--;
      off = L(ch[i].seg);
    }
    const r = {
      id: 'c' + C.nextId++, vehicles: rear, chain: ch.slice(0, i + 1).map((e) => ({ seg: e.seg, dir: e.dir })),
      frontOff: Math.max(0, off - d), rearOff: 0, v: 0, move: 0, ctl: 'manual', setDir: 0, setV: c.setV,
      info: null, ai: null, lastSig: null, status: '', waitT: 0,
    };
    c.vehicles = front;
    c.length = lenF;
    r.length = C.length(r);
    fixRear(c);
    fixRear(r);
    C.identify(c);
    C.identify(r);
    c.ctl = 'manual';
    c.setDir = 0;
    C.list.push(r);
    c.dirty = r.dirty = true;
    return r;
  };

  // a — движущийся состав, b — состав, к которому подъехали.
  C.couple = function (a, b) {
    if (a.move < 0) C.reverse(a);
    const fp = C.frontPoint(a);
    const rp = C.rearPoint(b), fpb = C.frontPoint(b);
    const dist = (p) => Math.hypot(p[0] - fp[0], p[1] - fp[1]);
    if (dist(fpb) < dist(rp)) C.reverse(b);
    const ch = a.chain.slice();
    for (const el of b.chain) {
      if (ch[ch.length - 1].seg === el.seg) continue;
      ch.push({ seg: el.seg, dir: el.dir });
    }
    const wasAi = a.ctl === 'ai';
    a.chain = ch;
    a.frontOff = b.frontOff;
    a.vehicles = a.vehicles.concat(b.vehicles);
    a.length = C.length(a);
    C.identify(a);
    a.ctl = wasAi && a.ai ? 'ai' : 'manual';
    if (a.ai && RS.AI) RS.AI.onCoupled(a);
    fixRear(a);
    a.move = 0;
    a.v = 0;
    a.setDir = 0;
    C.list = C.list.filter((x) => x !== b);
    if (RS.UI && RS.UI.selected === b.id) RS.UI.selected = a.id;
    RS.Log && RS.Log.add('Сцепление: ' + C.label(a) + ' (' + a.vehicles.length + ' ед.)', 'shunt');
    a.dirty = true;
    return a;
  };

  C.label = function (c) {
    const i = c.info || {};
    if (i.cat === 'cut') return 'отцеп ' + C.carCount(c) + ' ваг.';
    if (i.cat === 'shunt') return 'маневровый ' + (i.num || '');
    if (i.cat === 'light') return 'локомотив ' + (i.num || '');
    return '№' + i.num;
  };

  // --- автоматическая защита: просмотр пути впереди ---------------------------------
  // Поезд следует только по поездным показаниям; маневровый лунно-белый для него — стоп.
  function permits(sig, trainOnly) {
    if (trainOnly && sig.aspect === 'W') return false;
    return sig.aspect !== 'R' && sig.aspect !== 'B';
  }

  function lockedByRoute(seg) {
    return !!T.sections[T.segs[seg].sec].lock;
  }

  C.scan = function (c, move, maxDist, trainOnly) {
    const ch = c.chain;
    let cur, off;
    if (move > 0) {
      cur = ch[ch.length - 1];
      off = c.frontOff;
    } else {
      cur = { seg: ch[0].seg, dir: -ch[0].dir };
      off = L(ch[0].seg) - c.rearOff;
    }
    const out = { stop: Infinity, why: '', obst: null, limits: [], signals: [], path: [] };
    let d = L(cur.seg) - off; // расстояние до конца текущего отрезка
    out.path.push({ seg: cur.seg, dir: cur.dir, d0: -off });

    const findObst = (el, fromOff, base) => {
      const list = C.segOcc[el.seg];
      if (!list) return null;
      const len = L(el.seg);
      let best = null;
      for (const o of list) {
        if (o.c === c) continue;
        const t0 = el.dir > 0 ? o.lo : len - o.hi;
        const t1 = el.dir > 0 ? o.hi : len - o.lo;
        if (t1 <= fromOff + 0.001) continue;
        const dd = base + Math.max(0, t0 - fromOff);
        if (!best || dd < best.d) best = { d: dd, other: o.c };
      }
      return best;
    };

    let ob = findObst(cur, off, 0);
    if (ob) { out.obst = ob; return out; }
    for (let guard = 0; guard < 60; guard++) {
      const node = T.endNode(cur.seg, cur.dir);
      const sig = T.signalFor(node, cur.seg);
      if (sig) {
        out.signals.push({ d, sig });
        if (!permits(sig, trainOnly)) {
          out.stop = d - 5;
          out.why = 'Закрыт светофор ' + sig.name;
          break;
        }
        if (sig.aspect === 'RW') out.limits.push({ d, v: kmh(20) });
      }
      const nx = T.next(node, cur.seg);
      if (!nx.seg) {
        if (nx.end === 'portal') break;
        out.stop = d - (nx.end === 'buffer' ? 4 : 10);
        out.why = nx.end === 'buffer' ? 'Тупиковый упор' : 'Стрелка ' + T.groupOf(nx.sw).id + ' без контроля положения';
        break;
      }
      if (nx.trailing && nx.wrong) {
        out.stop = d - 10;
        out.why = 'Стрелка ' + T.groupOf(nx.sw).id + ' не по направлению движения';
        break;
      }
      if (T.isBoundary(node, nx.seg) && !lockedByRoute(nx.seg)) {
        out.stop = d - 5;
        out.why = 'Граница станции';
        break;
      }
      const sg = T.segs[nx.seg];
      out.limits.push({ d, v: kmh(sg.vmax) });
      out.path.push({ seg: nx.seg, dir: nx.dir, d0: d });
      ob = findObst(nx, 0, d);
      if (ob) { out.obst = ob; break; }
      d += sg.len;
      if (d > maxDist) break;
      cur = nx;
    }
    return out;
  };

  // Расстояние от ведущего конца до точки (seg, x) по найденному пути, либо null.
  C.distTo = function (scan, seg, x) {
    for (const p of scan.path) {
      if (p.seg !== seg) continue;
      const s = T.segs[seg];
      const off = p.dir > 0 ? (x - s.xa) * T.M : (s.xb - x) * T.M;
      return p.d0 + off;
    }
    return null;
  };

  // --- динамика ---------------------------------------------------------------------------
  const CAT_VMAX = { pass: 120, subur: 120, freight: 80, local: 70, light: 100, shunt: 40, cut: 0 };

  function dynamics(c) {
    const cars = C.carCount(c);
    const locos = c.vehicles.filter((v) => v.loco);
    const emu = locos.length && locos.every((v) => v.kind === 'emu');
    const power = locos.reduce((s, v) => s + (VEH[v.type].power || 0.6), 0);
    const a = emu ? 0.6 : Math.min(0.9, power / (1 + 0.15 * cars));
    const b = emu ? 0.7 : 0.8 / (1 + 0.02 * cars);
    return { a: Math.max(0.06, a), b };
  }

  function leadIsLoco(c, move) {
    const v = move > 0 ? c.vehicles[c.vehicles.length - 1] : c.vehicles[0];
    return v && v.loco;
  }

  C.step = function (c, dt) {
    if (!C.hasLoco(c)) {
      c.v = 0;
      c.move = 0;
      c.status = 'Закреплён тормозными башмаками';
      return;
    }
    let want; // {move, vmax (м/с), stop, why, couple}
    if (c.ctl === 'ai' && RS.AI) want = RS.AI.want(c);
    else {
      const sd = C.screenDir(c);
      want = { move: c.setDir * sd, vmax: kmh(c.setV), couple: true, manual: true };
    }
    // смена направления — только после остановки
    if (c.move !== want.move) {
      if (c.v > 0.05) want = Object.assign({}, want, { move: c.move, vmax: 0 });
      else c.move = want.move;
    }
    if (!c.move) {
      c.v = 0;
      c.status = want.why || 'Стоит';
      c.limitV = 0;
      return;
    }
    const dyn = dynamics(c);
    const maxDist = Math.min(3000, Math.max(400, (c.v * c.v) / (2 * dyn.b) + 300));
    const sc = c.ctl === 'ai' && want.scan ? want.scan : C.scan(c, c.move, maxDist);
    c.lastScan = sc;

    // ограничения скорости
    const cat = (c.info && c.info.cat) || 'light';
    const shunting = cat === 'shunt' || c.ctl !== 'ai' || (c.lastSig && c.lastSig.aspect === 'W');
    let cap = kmh(CAT_VMAX[cat] || 60);
    if (shunting) cap = Math.min(cap, kmh(leadIsLoco(c, c.move) ? 40 : 25));
    for (const el of c.chain) cap = Math.min(cap, kmh(T.segs[el.seg].vmax));
    if (c.lastSig && c.lastSig.aspect === 'RW') cap = Math.min(cap, kmh(20));
    let vA = Math.min(cap, want.vmax);
    for (const lim of sc.limits) vA = Math.min(vA, Math.sqrt(lim.v * lim.v + 2 * dyn.b * Math.max(0, lim.d)));

    let stop = sc.stop, why = sc.why;
    if (want.stop !== undefined && want.stop < stop) { stop = want.stop; why = want.why; }
    let contact = Infinity;
    if (sc.obst) {
      if (want.couple) {
        contact = sc.obst.d;
        vA = Math.min(vA, Math.sqrt(kmh(3) ** 2 + 2 * dyn.b * Math.max(0, contact - 2)));
        if (contact < 40) vA = Math.min(vA, kmh(shunting ? 5 : 3));
      } else if (sc.obst.d - 15 < stop) {
        stop = sc.obst.d - 15;
        why = 'Впереди подвижной состав';
      }
    }
    vA = Math.min(vA, Math.sqrt(2 * dyn.b * Math.max(0, stop)));
    if (stop < 0.3) vA = 0;

    if (c.v > vA) c.v = Math.max(vA, c.v - (c.v > vA + 1.5 ? 1.6 : 1) * dyn.b * dt);
    else c.v = Math.min(vA, c.v + dyn.a * dt);
    if (c.v < 0.02 && vA < 0.05) c.v = 0;

    let dist = c.v * dt;
    if (dist > Math.max(0, stop)) { dist = Math.max(0, stop); c.v = Math.min(c.v, 0.3); }
    let coupleNow = false;
    if (dist >= contact - 0.02) {
      dist = Math.max(0, contact);
      coupleNow = true;
    }
    c.limitV = vA;
    c.status = c.v < 0.05 ? why || (sc.obst && want.couple ? 'Подъезд к составу' : 'Стоит') : 'Движение';
    if (dist > 0) {
      const res = C.moveBy(c, dist * c.move);
      if (res.hit === 'portal') {
        RS.AI && RS.AI.onExit(c);
        C.remove(c);
        return;
      }
      if (res.hit) c.v = 0;
    }
    if (coupleNow && sc.obst) {
      if (c.v > kmh(10)) {
        RS.Log && RS.Log.add('Соударение вагонов на скорости ' + Math.round(c.v * 3.6) + ' км/ч!', 'bad');
        RS.Stats && RS.Stats.incident('Соударение при сцеплении');
      }
      C.couple(c, sc.obst.other);
    }
  };

  RS.Consist = C;
})();
