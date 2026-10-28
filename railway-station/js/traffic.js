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

  function travelDir(c) {
    return c.info.dir === 'odd' ? 1 : -1;
  }

  function onTrack(c) {
    const secs = C.sectionsOf(c);
    return secs.length === 1 && LAY.tracks[secs[0]] ? secs[0] : null;
  }

  // Путь станции, на котором находится голова поезда (по направлению следования).
  function headTrack(c) {
    const ch = c.chain;
    const el = travelDir(c) === C.screenDir(c) ? ch[ch.length - 1] : ch[0];
    const sec = T.segs[el.seg].sec;
    return LAY.tracks[sec] ? sec : null;
  }

  // Есть ли у поезда плановая остановка на станции (по расписанию или по категории).
  function plannedStop(c) {
    const p = c.info.plan;
    return p ? p.kind === 'stop' : !!c.info.stopAtPlatform;
  }
  AI.plannedStop = plannedStop;

  function startDwell(c, track, where) {
    const ai = c.ai;
    const info = c.info;
    ai.phase = 'dwell';
    ai.t = info.plan ? info.plan.minStop : info.dwell || 60;
    if (info.plan) RS.Schedule.onArrive(c, info.plan, track);
    else RS.Log.add('Поезд №' + info.num + ' прибыл на ' + where + ', стоянка ' + Math.round((ai.t / 60) * 10) / 10 + ' мин', 'good');
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
      res.why = info.stopAtPlatform ? 'Посадка и высадка пассажиров' : 'Плановая стоянка' + (info.plan ? ': ' + info.plan.reason : '');
      return res;
    }
    if (plannedStop(c) && !ai.dwelled) {
      if (info.stopAtPlatform) {
        for (const p of LAY.platforms) {
          const x = travelDir(c) > 0 ? p.x2 - 4 : p.x1 + 4;
          const d = C.distTo(scan, p.seg, x);
          if (d !== null && d > -8) {
            res.stop = Math.max(0, d);
            res.why = 'Остановка у платформы';
            ai.platform = p.name;
            if (d < 1.5 && c.v < 0.05) {
              const sec = T.segs[p.seg].sec;
              startDwell(c, sec, 'путь ' + T.trackName(sec) + ' (' + p.name + ')');
            }
            break;
          }
        }
      } else if (ai.inStation) {
        // плановая стоянка грузового: в конце пути приёма, даже если выходной уже открыт
        const tr = headTrack(c);
        const ex = scan.signals.find((s) => s.sig.kind === 'exit');
        if (ex) {
          const d = ex.d - 12;
          if (res.stop === undefined || d < res.stop) {
            res.stop = Math.max(0, d);
            res.why = 'Плановая остановка';
          }
          if (d < 1.5 && c.v < 0.05 && tr) startDwell(c, tr, 'путь ' + T.trackName(tr));
        } else if (c.v < 0.05 && tr) startDwell(c, tr, 'путь ' + T.trackName(tr));
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
      if (info.stopAtPlatform && !LAY.tracks[tr].platform) {
        RS.Log.add('Пассажирский поезд №' + info.num + ' принят на путь ' + T.trackName(tr) + ' без платформы — посадка невозможна', 'warn');
        RS.Stats.incident('Пассажирский №' + info.num + ' принят на путь без платформы');
        if (info.plan) RS.Schedule.onArrive(c, info.plan, tr);
        ai.dwelled = true;
        ai.phase = 'ready';
      } else if (!plannedStop(c)) {
        RS.Log.add('Поезд №' + info.num + ' остановлен на пути ' + T.trackName(tr) + (info.plan ? ' — по графику проследование без остановки' : ''), 'info');
      }
      if (info.note) RS.Log.add('№' + info.num + ': ' + info.note, 'info');
    }
    return res;
  };

  AI.update = function (c, dt) {
    const ai = c.ai;
    const p = c.info.plan;
    if (ai.phase === 'dwell') {
      ai.t -= dt;
      // пассажирские поезда раньше времени по графику не отправляются
      const strict = p && (c.info.cat === 'pass' || c.info.cat === 'subur');
      if (ai.t <= 0 && (!strict || RS.Sim.t >= p.dep)) {
        ai.phase = 'ready';
        ai.dwelled = true;
        RS.Log.add('Поезд №' + c.info.num + ' готов к отправлению' + (p ? ', по графику в ' + RS.Schedule.hm(p.dep) : ''), 'info');
      }
    }
    // учёт простоя у закрытых светофоров на подходе к станции
    if (c.v < 0.05 && !ai.arrived && !ai.inStation && c.status && c.status.startsWith('Закрыт светофор')) {
      ai.wait = (ai.wait || 0) + dt;
      RS.Stats.waitMin += dt / 60;
    }
  };

  // Вход на станцию и отправление (проследование) отмечаются по проходу светофоров
  // головой поезда — и в автоведении, и при ручном управлении.
  AI.track = function (c) {
    const ai = c.ai;
    const ls = c.lastSig;
    if (!ls) return;
    if (ls.kind === 'entry') ai.inStation = true;
    const p = c.info.plan;
    if (p && !p.factDep && ai.inStation && (ls.kind === 'exit' || ls.kind === 'block')) RS.Schedule.onDepart(c, p);
  };

  AI.onExit = function (c) {
    if (!c.info || ['cut', 'shunt'].includes(c.info.cat)) {
      RS.Log.add('Состав ' + C.label(c) + ' ушёл за пределы станции', 'warn');
      return;
    }
    RS.Stats.passed++;
    if (c.info.plan && !c.info.plan.factDep) RS.Schedule.onDepart(c, c.info.plan);
    const toward = C.screenDir(c) * (c.move || 1) > 0 ? LAY.neighbours.right : LAY.neighbours.left;
    const left = c.vehicles.filter((v) => v.dest === LAY.station).length;
    if (!c.info.plan) {
      RS.Log.add('Поезд №' + c.info.num + ' отправлен на перегон в сторону ст. ' + toward +
        (c.ai && c.ai.wait > 30 ? ' (простой у сигналов ' + Math.round(c.ai.wait / 60) + ' мин)' : ''), 'good');
    }
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
    // mode: schedule — по расписанию, random — случайные поезда, off — только вызванные вручную
    settings: { mode: 'schedule', autoRoute: false, minGap: 3, maxGap: 8, weights: { pass: 3, subur: 3, freight: 4, local: 2, light: 1 } },
    next: { odd: 25, even: 100 },
    TYPES,
  };

  // entry — нитка расписания (если поезд идёт по графику).
  Traffic.spawn = function (dirKey, cat, entry) {
    const sp = LAY.spawns[dirKey];
    const odd = dirKey === 'odd';
    if (T.sections[sp.approach[0]].occupied) return null;
    if (!cat) {
      const w = Traffic.settings.weights;
      const tot = Object.values(w).reduce((a, b) => a + b, 0);
      let r = Math.random() * tot;
      for (const [k, v] of Object.entries(w)) { r -= v; if (r <= 0) { cat = k; break; } }
      cat = cat || 'freight';
    }
    const ty = TYPES[cat];
    const m = ty.make(odd);
    if (entry) {
      m.num = entry.num;
      m.stopAtPlatform = entry.kind === 'stop' && (cat === 'pass' || cat === 'subur');
      m.dwell = entry.minStop;
    }
    // vehicles: от хвоста к голове; голова поезда — по направлению движения
    const vehicles = m.vehicles.slice().reverse();
    const seg = T.segs[sp.seg];
    const frontOff = sp.dir > 0 ? (sp.frontX - seg.xa) * T.M : (seg.xb - sp.frontX) * T.M;
    const info = {
      num: m.num, cat, dir: dirKey, title: (entry && entry.title) || ty.title, stopAtPlatform: !!m.stopAtPlatform, dwell: m.dwell,
      setOff: m.setOff || 0, note: m.note || '', plan: entry || null,
      from: odd ? LAY.neighbours.left : LAY.neighbours.right,
      to: odd ? LAY.neighbours.right : LAY.neighbours.left,
    };
    const c = C.create({ vehicles, seg: sp.seg, dir: sp.dir, frontOff, info, ctl: 'ai', v: kmh(m.v0 || 60), ai: { phase: 'run' } });
    c.move = 1;
    const H = RS.Schedule && RS.Schedule.hm;
    const planTxt = !entry ? '' : entry.kind === 'pass'
      ? '. По графику проследование в ' + H(entry.arr) + ' по пути ' + T.trackName(entry.track)
      : '. По графику прибытие ' + H(entry.arr) + ', отправление ' + H(entry.dep) + ', путь ' + T.trackName(entry.track);
    RS.Log.add('Поезд №' + info.num + ' (' + info.title.toLowerCase() + ', ' + c.vehicles.length + ' ед., ' +
      Math.round(c.length) + ' м) вступил на участок приближения ' + sp.approach[0] + ' со стороны ст. ' + info.from + planTxt, 'route');
    return c;
  };

  // Автодействие: приём на путь по графику (или на главный) и отправление без участия ДСП.
  // Поезд с плановой стоянкой отправляется не раньше чем за минуту до времени по графику.
  function autoRoute() {
    const IL = RS.IL;
    const now = RS.Sim.t;
    for (const c of C.list) {
      // сборные поезда принимает ДСП: с ними нужна маневровая работа
      if (c.ctl !== 'ai' || !c.ai || !c.info.dir || c.info.cat === 'local') continue;
      const k = c.info.dir;
      const sp = LAY.spawns[k];
      const plan = c.info.plan;
      const main = k === 'odd' ? 'IП' : 'IIП';
      const secs = C.sectionsOf(c);
      const onApproach = secs.some((s) => sp.approach.includes(s));
      if (onApproach && !IL.routeFrom(sp.entry)) {
        const cands = IL.findRoutes(sp.entry, 'train');
        for (const t of [plan && plan.track, main]) {
          const cand = t && cands.find((x) => x.dest === t);
          if (cand && IL.check(cand).ok) { IL.set(cand); break; }
        }
      }
      const r = IL.routeFrom(sp.entry);
      const track = (onApproach && r && r.dest) || secs.find((s) => LAY.tracks[s]);
      if (!track || !LAY.tracks[track]) continue;
      const exitSig = (k === 'odd' ? 'Н' : 'Ч') + LAY.tracks[track].name;
      const mayGo = !plannedStop(c) || (c.ai.phase === 'ready' && (!plan || now >= plan.dep - 60));
      if (mayGo && T.signals[exitSig] && !IL.routeFrom(exitSig)) {
        const d = IL.findRoutes(exitSig, 'train')[0];
        if (d && IL.check(d).ok) IL.set(d);
      }
    }
  }

  Traffic.update = function (dt) {
    for (const c of C.list) {
      if (!c.ai || !c.info || !c.info.dir) continue;
      if (c.ctl === 'ai') AI.update(c, dt);
      AI.track(c);
    }
    if (Traffic.settings.autoRoute) autoRoute();
    const mode = Traffic.settings.mode;
    if (mode === 'schedule') {
      RS.Schedule.update(dt);
      return;
    }
    if (mode !== 'random') return;
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

  Traffic.setMode = function (mode) {
    if (mode === Traffic.settings.mode) return;
    Traffic.settings.mode = mode;
    if (mode === 'schedule') RS.Schedule.resume(RS.Sim.t);
    if (mode === 'random') Traffic.next = { odd: 20, even: 70 };
    const names = { schedule: 'по расписанию', random: 'случайные поезда', off: 'только вызванные вручную поезда' };
    RS.Log.add('Режим движения: ' + names[mode], 'info');
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
    // отцеп на пути 7
    place('t7', 1, 520, Array.from({ length: 12 }, () => C.vehicle(pick(['ПВ', 'Ц', 'ПЛ']))),
      { num: '', cat: 'cut', title: 'Отцеп' });
    // чётный грузовой на пути 6 ожидает отправления
    const cars = Array.from({ length: 38 }, () => C.vehicle(pick(['ПВ', 'ПВ', 'Х', 'Ц'])));
    const veh = cars.concat([C.vehicle('2ЭС5К')]); // голова — слева
    const plan = RS.Schedule ? RS.Schedule.byNum('2418') : null;
    const tr = place('t6', -1, T.segs.t6.len - 22, veh,
      { num: '2418', cat: 'freight', dir: 'even', title: 'Грузовой', from: LAY.neighbours.right, to: LAY.neighbours.left, plan },
      { ctl: 'ai', ai: { phase: 'ready', dwelled: true, arrived: true, inStation: true } });
    tr.move = 0;
    RS.Log.add('Смена ДСП ст. ' + LAY.station + ' приняла дежурство. На пути 6 — чётный грузовой №2418 после смены бригады' +
      (plan ? ', отправление по графику в ' + RS.Schedule.hm(plan.dep) : ', ожидает отправления') + '.', 'info');
  };

  RS.Traffic = Traffic;
})();
