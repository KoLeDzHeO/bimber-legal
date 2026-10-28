/*
 * Движение поездов: журнал, статистика, случайная генерация поездов,
 * «машинист» для поездов в автоведении и начальная поездная обстановка.
 */
(function () {
  const RS = window.RS;
  const T = RS.Track;
  const C = RS.Consist;
  const LAY = RS.LAYOUT;
  const kmh = (v) => v / 3.6;
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  RS.fmtTime = function (t) {
    const s = Math.floor(t) % 86400;
    const p = (n) => String(n).padStart(2, '0');
    return p(Math.floor(s / 3600)) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
  };

  // --- журнал и статистика ----------------------------------------------------------
  RS.Log = {
    items: [],
    add(text, type) {
      this.items.unshift({ t: RS.Sim ? RS.Sim.t : 0, text, type: type || 'info' });
      if (this.items.length > 200) this.items.pop();
      this.dirty = true;
      if (RS.UI && (type === 'bad' || type === 'warn')) RS.UI.toast(text, type);
    },
  };

  RS.Stats = {
    passed: 0, arrived: 0, incidents: [], waitMin: 0, wagonsSetOff: 0,
    incident(text) { this.incidents.push({ t: RS.Sim ? RS.Sim.t : 0, text }); },
  };

  // --- типы поездов ---------------------------------------------------------------------
  const FREIGHT_MIX = ['К', 'К', 'ПВ', 'ПВ', 'ПВ', 'Ц', 'Ц', 'ПЛ', 'Х'];

  function numFor(lo, hi, odd) {
    let n = rnd(lo, hi);
    if ((n % 2 === 1) !== odd) n += n < hi ? 1 : -1;
    return String(n);
  }

  const TYPES = {
    pass: {
      title: 'Пассажирский', w: 3, vmax: 120,
      make(odd) {
        const loco = pick(['ЭП1М', 'ЧС7', 'ЭП2К']);
        const n = rnd(12, 16);
        const cars = Array.from({ length: n }, () => C.vehicle('пасс'));
        return {
          vehicles: [C.vehicle(loco)].concat(cars), num: numFor(1, 298, odd),
          stopAtPlatform: true, dwell: rnd(120, 240), v0: 80,
        };
      },
    },
    subur: {
      title: 'Пригородный', w: 3, vmax: 120,
      make(odd) {
        const n = pick([6, 8, 10]);
        const unit = 'u' + rnd(1e5, 1e6);
        const num = 'ЭД4М-' + rnd(100, 499);
        const cars = Array.from({ length: n }, (_, i) =>
          C.vehicle('ЭД4М', { unit, num: num + '/' + (i + 1), loco: i === 0 || i === n - 1 || i % 2 === 1 }));
        return { vehicles: cars, num: numFor(6001, 6998, odd), stopAtPlatform: true, dwell: rnd(40, 80), v0: 80 };
      },
    },
    freight: {
      title: 'Грузовой', w: 4, vmax: 80,
      make(odd) {
        const loco = pick(['2ЭС5К', '3ЭС5К', 'ВЛ80С', '2ЭС6']);
        const n = rnd(34, 50);
        const base = pick(FREIGHT_MIX);
        const cars = Array.from({ length: n }, () => C.vehicle(Math.random() < 0.6 ? base : pick(FREIGHT_MIX)));
        return { vehicles: [C.vehicle(loco)].concat(cars), num: numFor(2001, 2998, odd), v0: 60 };
      },
    },
    local: {
      title: 'Сборный', w: 2, vmax: 70,
      make(odd) {
        const loco = pick(['ВЛ80С', '2ЭС5К']);
        const n = rnd(14, 24);
        const k = rnd(3, 7);
        const cars = Array.from({ length: n }, (_, i) =>
          C.vehicle(pick(FREIGHT_MIX), i >= n - k ? { dest: LAY.station } : {}));
        return {
          vehicles: [C.vehicle(loco)].concat(cars), num: numFor(3401, 3498, odd), setOff: k, v0: 55,
          note: 'Отцепить ' + k + ' хвост. ваг. назначением на ст. ' + LAY.station + ' (жёлтая обводка) и подать на путь 8 — грузовой двор. Путь 8 примыкает к чётной горловине: подача с вытяжного пути 9 от светофора М2.',
        };
      },
    },
    light: {
      title: 'Локомотив резервом', w: 1, vmax: 100,
      make(odd) {
        return { vehicles: [C.vehicle(pick(['2ЭС5К', 'ВЛ80С', 'ЭП1М']))], num: numFor(4001, 4998, odd), v0: 70 };
      },
    },
  };

  // --- «машинист» ---------------------------------------------------------------------------
  const AI = {};
  const platformBySeg = {};
  for (const p of LAY.platforms) platformBySeg[p.seg] = p;

  function travelDir(c) {
    return c.info.dir === 'odd' ? 1 : -1;
  }

  function onTrack(c) {
    const secs = C.sectionsOf(c);
    return secs.length === 1 && LAY.tracks[secs[0]] ? secs[0] : null;
  }

  AI.want = function (c) {
    const ai = c.ai;
    const info = c.info;
    const move = travelDir(c) * C.screenDir(c);
    const vmax = kmh((TYPES[info.cat] && TYPES[info.cat].vmax) || 80);
    const b = 0.5;
    const scan = C.scan(c, move, Math.min(3000, Math.max(500, (c.v * c.v) / (2 * b) + 400)), true);
    const res = { move, vmax, couple: false, scan };

    if (ai.phase === 'dwell') {
      res.stop = 0;
      res.why = 'Посадка/высадка пассажиров';
      return res;
    }
    if (info.stopAtPlatform && !ai.dwelled) {
      for (const p of LAY.platforms) {
        const x = travelDir(c) > 0 ? p.x2 - 4 : p.x1 + 4;
        const d = C.distTo(scan, p.seg, x);
        if (d !== null && d > -8) {
          res.stop = Math.max(0, d);
          res.why = 'Остановка у платформы';
          ai.platform = p.name;
          if (d < 1.5 && c.v < 0.05) {
            ai.phase = 'dwell';
            ai.t = info.dwell || 60;
            RS.Log.add('Поезд №' + info.num + ' прибыл на путь ' + T.trackName(T.segs[p.seg].sec) + ' (' + p.name + '), стоянка ' + Math.round(ai.t / 60 * 10) / 10 + ' мин', 'good');
          }
          break;
        }
      }
    }
    if (ai.dwelled && ai.phase === 'ready') {
      const s0 = scan.signals[0];
      if (s0 && (s0.sig.aspect === 'R' || s0.sig.aspect === 'B') && s0.d > 30) {
        res.stop = 0;
        res.why = 'Готов к отправлению, ожидает открытия ' + s0.sig.name;
      }
    }
    const tr = onTrack(c);
    if (tr && !ai.arrived && c.v < 0.05) {
      ai.arrived = true;
      RS.Stats.arrived++;
      if (!info.stopAtPlatform) RS.Log.add('Поезд №' + info.num + ' прибыл на путь ' + T.trackName(tr), 'good');
      else if (!LAY.tracks[tr].platform) {
        RS.Log.add('Пассажирский поезд №' + info.num + ' принят на путь ' + T.trackName(tr) + ' без платформы — посадка невозможна', 'warn');
        RS.Stats.incident('Пассажирский №' + info.num + ' принят на путь без платформы');
        ai.dwelled = true;
        ai.phase = 'ready';
      }
      if (info.note) RS.Log.add('№' + info.num + ': ' + info.note, 'info');
    }
    return res;
  };

  AI.update = function (c, dt) {
    const ai = c.ai;
    if (ai.phase === 'dwell') {
      ai.t -= dt;
      if (ai.t <= 0) {
        ai.phase = 'ready';
        ai.dwelled = true;
        RS.Log.add('Поезд №' + c.info.num + ' готов к отправлению', 'info');
      }
    }
    // учёт простоя у закрытых светофоров
    if (c.v < 0.05 && !ai.arrived && c.status && c.status.startsWith('Закрыт светофор')) {
      ai.wait = (ai.wait || 0) + dt;
      RS.Stats.waitMin += dt / 60;
    }
  };

  AI.onExit = function (c) {
    if (!c.info || ['cut', 'shunt'].includes(c.info.cat)) {
      RS.Log.add('Состав ' + C.label(c) + ' ушёл за пределы станции', 'warn');
      return;
    }
    RS.Stats.passed++;
    const toward = C.screenDir(c) * (c.move || 1) > 0 ? LAY.neighbours.right : LAY.neighbours.left;
    const left = c.vehicles.filter((v) => v.dest === LAY.station).length;
    RS.Log.add('Поезд №' + c.info.num + ' отправлен на перегон в сторону ст. ' + toward +
      (c.ai && c.ai.wait > 30 ? ' (простой у сигналов ' + Math.round(c.ai.wait / 60) + ' мин)' : ''), 'good');
    if (left) {
      RS.Log.add('Поезд №' + c.info.num + ' увёз ' + left + ' ваг. назначением на ст. ' + LAY.station + '!', 'warn');
      RS.Stats.incident('Неотцепленные вагоны в поезде №' + c.info.num);
    }
  };

  AI.onCoupled = function (c) {
    if (c.ai) c.ai.phase = c.ai.dwelled ? 'ready' : 'run';
  };

  RS.AI = AI;

  // --- генератор --------------------------------------------------------------------------
  const Traffic = {
    settings: { auto: true, autoRoute: false, minGap: 3, maxGap: 8, weights: { pass: 3, subur: 3, freight: 4, local: 2, light: 1 } },
    next: { odd: 25, even: 100 },
    TYPES,
  };

  Traffic.spawn = function (dirKey, cat) {
    const sp = LAY.spawns[dirKey];
    const odd = dirKey === 'odd';
    if (sp.approach.some((s) => T.sections[s].occupied && s === sp.approach[0])) return null;
    if (!cat) {
      const w = Traffic.settings.weights;
      const tot = Object.values(w).reduce((a, b) => a + b, 0);
      let r = Math.random() * tot;
      for (const [k, v] of Object.entries(w)) { r -= v; if (r <= 0) { cat = k; break; } }
      cat = cat || 'freight';
    }
    const ty = TYPES[cat];
    const m = ty.make(odd);
    // vehicles: от хвоста к голове; голова поезда — по направлению движения
    const vehicles = m.vehicles.slice().reverse();
    const seg = T.segs[sp.seg];
    const frontOff = sp.dir > 0 ? (sp.frontX - seg.xa) * T.M : (seg.xb - sp.frontX) * T.M;
    const info = {
      num: m.num, cat, dir: dirKey, title: ty.title, stopAtPlatform: !!m.stopAtPlatform, dwell: m.dwell,
      setOff: m.setOff || 0, note: m.note || '',
      from: odd ? LAY.neighbours.left : LAY.neighbours.right,
      to: odd ? LAY.neighbours.right : LAY.neighbours.left,
    };
    const c = C.create({ vehicles, seg: sp.seg, dir: sp.dir, frontOff, info, ctl: 'ai', v: kmh(m.v0 || 60), ai: { phase: 'run' } });
    c.move = 1;
    RS.Log.add('Поезд №' + info.num + ' (' + ty.title.toLowerCase() + ', ' + c.vehicles.length + ' ед., ' +
      Math.round(c.length) + ' м) вступил на участок приближения ' + sp.approach[0] + ' со стороны ст. ' + info.from, 'route');
    return c;
  };

  // Автодействие по главным путям: приём на I/II и отправление без участия ДСП.
  function autoRoute() {
    const IL = RS.IL;
    for (const c of C.list) {
      // сборные поезда принимает ДСП: с ними нужна маневровая работа
      if (c.ctl !== 'ai' || !c.ai || !c.info.dir || c.info.cat === 'local') continue;
      const k = c.info.dir;
      const sp = LAY.spawns[k];
      const main = k === 'odd' ? 'IП' : 'IIП';
      const exitSig = k === 'odd' ? 'НI' : 'ЧII';
      const secs = C.sectionsOf(c);
      const onApproach = secs.some((s) => sp.approach.includes(s));
      if (onApproach && !IL.routeFrom(sp.entry)) {
        const cand = IL.findRoutes(sp.entry, 'train').find((x) => x.dest === main);
        if (cand && IL.check(cand).ok) IL.set(cand);
      }
      const r = IL.routeFrom(sp.entry);
      const toMain = (onApproach && r && r.dest === main) || secs.includes(main);
      const mayGo = !c.info.stopAtPlatform || c.ai.phase === 'ready';
      if (toMain && mayGo && !IL.routeFrom(exitSig)) {
        const d = IL.findRoutes(exitSig, 'train')[0];
        if (d && IL.check(d).ok) IL.set(d);
      }
    }
  }

  Traffic.update = function (dt) {
    for (const c of C.list) if (c.ctl === 'ai' && c.ai) AI.update(c, dt);
    if (Traffic.settings.autoRoute) autoRoute();
    if (!Traffic.settings.auto) return;
    for (const k of ['odd', 'even']) {
      Traffic.next[k] -= dt;
      if (Traffic.next[k] <= 0) {
        const busy = C.list.filter((c) => c.ctl === 'ai').length >= 7;
        const ok = !busy && Traffic.spawn(k);
        const s = Traffic.settings;
        Traffic.next[k] = ok ? 60 * (s.minGap + Math.random() * (s.maxGap - s.minGap)) : 20;
      }
    }
  };

  // --- начальная обстановка -------------------------------------------------------------
  function place(seg, dir, frontOff, vehicles, info, extra) {
    const c = C.create(Object.assign({ vehicles, seg, dir, frontOff, info }, extra || {}));
    return c;
  }

  Traffic.initial = function () {
    // маневровый тепловоз на вытяжном пути 10
    const t10 = T.segs.t10;
    place('t10', 1, t10.len - 18, [C.vehicle('ЧМЭ3', { num: 'ЧМЭ3-5123' })],
      { num: 'ЧМЭ3-5123', cat: 'shunt', title: 'Маневровый локомотив' });
    // второй маневровый — на вытяжном пути 9
    place('t9', -1, T.segs.t9.len - 20, [C.vehicle('ТЭМ2', { num: 'ТЭМ2-0877' })],
      { num: 'ТЭМ2-0877', cat: 'shunt', title: 'Маневровый локомотив' });
    // вагоны под выгрузкой на грузовом дворе (путь 8)
    place('t8', 1, 8 + 6 * 14.7, Array.from({ length: 6 }, () => C.vehicle('К')),
      { num: '', cat: 'cut', title: 'Отцеп' });
    // отцеп на пути 3
    place('t3', 1, 520, Array.from({ length: 12 }, () => C.vehicle(pick(['ПВ', 'Ц', 'ПЛ']))),
      { num: '', cat: 'cut', title: 'Отцеп' });
    // чётный грузовой на пути 6 ожидает отправления
    const cars = Array.from({ length: 38 }, () => C.vehicle(pick(['ПВ', 'ПВ', 'Х', 'Ц'])));
    const veh = cars.concat([C.vehicle('2ЭС5К')]); // голова — слева
    const tr = place('t6', -1, T.segs.t6.len - 22, veh,
      { num: '2418', cat: 'freight', dir: 'even', title: 'Грузовой', from: LAY.neighbours.right, to: LAY.neighbours.left },
      { ctl: 'ai', ai: { phase: 'run', arrived: true } });
    tr.move = 0;
    RS.Log.add('Смена ДСП ст. ' + LAY.station + ' приняла дежурство. На пути 6 — чётный грузовой №2418, ожидает отправления.', 'info');
  };

  RS.Traffic = Traffic;
})();
