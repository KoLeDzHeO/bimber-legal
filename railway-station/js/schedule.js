/*
 * Расписание станции (нормативный график движения): плановые остановки и
 * проследование поездов, выпуск поездов на подходы по графику, учёт
 * фактического прибытия и отправления, отклонения от графика.
 */
(function () {
  const RS = window.RS;
  const C = RS.Consist;
  const LAY = RS.LAYOUT;

  const S = { entries: [], nextHour: null, nextId: 1, counters: {} };

  // Детерминированный генератор: график на каждый час получается всегда одинаковым.
  function prng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const VMAX = { pass: 120, subur: 120, freight: 80, local: 70, light: 100 };
  // За сколько секунд до времени по графику поезд появляется в начале перегона: время хода
  // по шести блок-участкам и по станции до остановки (около 1,1 км) или до выходного (1,3 км).
  const TYP_LEN = { pass: 400, subur: 220, freight: 650, local: 320, light: 35 };
  S.approachLen = (dir) => LAY.spawns[dir].segs.reduce((s, id) => s + RS.Track.segs[id].len, 0);
  // Средняя скорость хода (доля от максимальной) и поправка подобраны по прогону модели.
  S.lead = function (cat, kind, dir) {
    const run = S.approachLen(dir) - TYP_LEN[cat] - 30 + (kind === 'pass' ? 1315 : 1130);
    const passenger = cat === 'pass' || cat === 'subur';
    const [f, slack] = kind === 'pass' ? [1, 0] : passenger ? [0.85, -40] : [0.8, -20];
    return Math.round(run / ((f * VMAX[cat]) / 3.6) + slack);
  };

  // Диапазоны номеров: скорые 1–148, пассажирские 301–398, пригородные 6001–6998,
  // грузовые 2001–2998, сборные 3401–3498, локомотивы резервом 4001–4998.
  const NUM = {
    express: [1, 148, 31], pass: [301, 398, 341], subur: [6001, 6998, 6101],
    freight: [2001, 2998, 2101], local: [3401, 3498, 3411], light: [4001, 4998, 4101],
  };
  function nextNum(kind, odd) {
    const [lo, hi, start] = NUM[kind];
    const key = kind + (odd ? 'o' : 'e');
    let n = S.counters[key];
    if (n === undefined) n = odd ? start : start + 1;
    if (n > hi) n = odd ? lo : lo + 1;
    S.counters[key] = n + 2;
    return String(n);
  }

  // Нечётные поезда — по нечётным «ниткам» графика, чётные — со сдвигом на 6 мин.
  const SLOTS = { odd: [4, 16, 28, 40, 52], even: [10, 22, 34, 46, 58] };
  const TECH = ['смена локомотивной бригады', 'опробование автотормозов', 'техническая стоянка'];

  function add(o) {
    const e = Object.assign({ id: 'g' + S.nextId++, state: 'plan', factArr: null, factDep: null, factTrack: null }, o);
    if (e.kind === 'pass') e.dep = e.arr;
    e.from = e.dir === 'odd' ? LAY.neighbours.left : LAY.neighbours.right;
    e.to = e.dir === 'odd' ? LAY.neighbours.right : LAY.neighbours.left;
    e.spawnAt = e.arr - S.lead(e.cat, e.kind, e.dir);
    S.entries.push(e);
    return e;
  }

  // Час графика: чётные часы — с технической стоянкой грузового, нечётные — с обгоном
  // грузового скорым поездом и (через раз) сборным поездом с отцепкой вагонов.
  function planHour(h) {
    const rnd = prng(h * 7919 + 101);
    const even = h % 2 === 0;
    for (const dir of ['odd', 'even']) {
      const odd = dir === 'odd';
      const at = (i) => h * 3600 + SLOTS[dir][i] * 60;
      const main = odd ? 'IП' : 'IIП';
      add({ dir, cat: 'subur', kind: 'stop', arr: at(0), dep: at(0) + 60, minStop: 45, track: main, title: 'Пригородный', reason: 'посадка и высадка пассажиров', num: nextNum('subur', odd) });
      if (even) {
        add({ dir, cat: 'freight', kind: 'pass', arr: at(1), track: main, title: 'Грузовой', reason: 'проследование', num: nextNum('freight', odd) });
        const st = 2 + Math.floor(rnd() * 3);
        add({ dir, cat: 'pass', kind: 'stop', arr: at(2), dep: at(2) + st * 60, minStop: 90, track: main, title: 'Пассажирский', reason: 'посадка и высадка пассажиров', num: nextNum('pass', odd) });
        const tm = 12 + Math.floor(rnd() * 7);
        add({ dir, cat: 'freight', kind: 'stop', arr: at(3), dep: at(3) + tm * 60, minStop: 6 * 60, track: odd ? '5П' : '4П', title: 'Грузовой', reason: TECH[Math.floor(rnd() * TECH.length)], num: nextNum('freight', odd) });
        if (rnd() < 0.5) add({ dir, cat: 'light', kind: 'pass', arr: at(4), track: main, title: 'Локомотив резервом', reason: 'проследование', num: nextNum('light', odd) });
      } else {
        const ov = add({ dir, cat: 'freight', kind: 'stop', arr: at(1), dep: at(2) + 5 * 60, minStop: 120, track: odd ? '3П' : '4П', title: 'Грузовой', reason: '', num: nextNum('freight', odd) });
        const ex = add({ dir, cat: 'pass', kind: 'pass', arr: at(2), track: main, title: 'Скорый', reason: 'проследование без остановки', num: nextNum('express', odd) });
        ov.reason = 'обгон скорым поездом №' + ex.num;
        ov.after = ex.id;
        add({ dir, cat: 'freight', kind: 'pass', arr: at(3), track: main, title: 'Грузовой', reason: 'проследование', num: nextNum('freight', odd) });
        if (h % 4 === 1) {
          add({ dir, cat: 'local', kind: 'stop', arr: at(4), dep: at(4) + 40 * 60, minStop: 10 * 60, track: odd ? '5П' : '6П', title: 'Сборный', reason: 'отцепка вагонов на грузовой двор', num: nextNum('local', odd) });
        }
      }
    }
    S.entries.sort((a, b) => a.arr - b.arr);
  }

  S.ensure = function (now) {
    while (S.nextHour * 3600 < now + 3 * 3600) planHour(S.nextHour++);
  };

  S.init = function (now) {
    S.nextHour = Math.floor(now / 3600);
    S.ensure(now);
    // грузовой, стоящий на станции к началу смены
    const e = add({ dir: 'even', cat: 'freight', kind: 'stop', arr: now - 19 * 60, dep: now + 6 * 60, minStop: 0, track: '6П', title: 'Грузовой', reason: 'смена локомотивной бригады', num: '2418' });
    e.state = 'station';
    e.factArr = e.arr;
    e.factTrack = '6П';
    S.entries.sort((a, b) => a.arr - b.arr);
  };

  S.byNum = (num) => S.entries.find((e) => e.num === num) || null;

  // Состав, в котором находится поездной локомотив этого поезда (в т.ч. после маневров).
  S.consistOf = function (e) {
    return C.list.find((c) => c.vehicles.some((v) => v.owner && v.owner.info.plan === e)) ||
      C.list.find((c) => c.info && c.info.planId === e.id) || null;
  };

  S.update = function () {
    const now = RS.Sim.t;
    S.ensure(now);
    // к началу смены поезда, которые по графику уже вышли на перегон, ставятся на него
    if (!S.warmed) {
      S.warmed = true;
      for (const dir of ['odd', 'even']) {
        const e = S.entries.find((x) => x.dir === dir && x.state === 'plan' && x.spawnAt < now);
        if (!e) continue;
        const v = (0.85 * VMAX[e.cat]) / 3.6;
        const adv = Math.max(0, Math.min((now - e.spawnAt) * v, S.approachLen(dir) - 2500));
        const c = RS.Traffic.spawn(dir, e.cat, e, adv);
        if (c) {
          c.v = v;
          e.state = 'approach';
          e.spawnFact = e.spawnAt;
        }
      }
    }
    // выпуск поездов на подходы: по одному на направление, в порядке графика
    for (const dir of ['odd', 'even']) {
      const e = S.entries.find((x) => x.dir === dir && x.state === 'plan' && x.spawnAt <= now);
      if (!e || C.list.filter((c) => c.ctl === 'ai').length >= 9) continue;
      const c = RS.Traffic.spawn(dir, e.cat, e);
      if (c) {
        e.state = 'approach';
        e.spawnFact = now;
      }
    }
    for (const e of S.entries) {
      if (e.state !== 'approach' && e.state !== 'station') continue;
      if (e.factDep) { e.state = 'gone'; continue; }
      const c = S.consistOf(e);
      if (c && e.state === 'approach' && c.ai && c.ai.inStation) e.state = 'station';
    }
    S.entries = S.entries.filter((e) => e.arr > now - 4 * 3600 || (e.state !== 'gone' && e.state !== 'cancelled'));
  };

  // Поезда, которые должны были выйти на подход больше 10 мин назад, — отменяются
  // (при возврате в режим «по расписанию» после случайного движения).
  S.resume = function (now) {
    for (const e of S.entries) if (e.state === 'plan' && e.spawnAt < now - 600) e.state = 'cancelled';
  };

  // --- факт исполнения ---------------------------------------------------------------------
  S.hm = function (t) {
    const s = Math.floor(t) % 86400;
    return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  };
  const devText = (d) => (d > 0 ? 'опоздание ' + d + ' мин' : d < 0 ? 'раньше графика на ' + -d + ' мин' : 'по графику');
  S.devText = devText;
  const planNote = (plan, d) => (d === 0 ? ' (по графику)' : ' (по графику ' + S.hm(plan) + ', ' + devText(d) + ')');

  S.onArrive = function (c, e, track) {
    if (e.factArr) return;
    e.factArr = RS.Sim.t;
    e.factTrack = track;
    const d = Math.trunc((e.factArr - e.arr) / 60);
    RS.Log.add('Поезд №' + e.num + ' прибыл на путь ' + RS.Track.trackName(track) + ' в ' + S.hm(e.factArr) + planNote(e.arr, d) +
      (track !== e.track ? ' — путь не по плану (' + RS.Track.trackName(e.track) + ')' : ''), d > 3 ? 'late' : 'good');
  };

  S.onDepart = function (c, e) {
    if (e.factDep) return;
    e.factDep = RS.Sim.t;
    const d = Math.trunc((e.factDep - e.dep) / 60);
    const what = e.kind === 'pass' ? 'проследовал станцию' : 'отправился';
    RS.Log.add('Поезд №' + e.num + ' ' + what + ' в ' + S.hm(e.factDep) + planNote(e.dep, d), d > 3 ? 'late' : 'good');
    const passenger = e.cat === 'pass' || e.cat === 'subur';
    if (e.kind === 'stop' && passenger && e.factDep < e.dep - 30) {
      RS.Stats.incident('Пассажирский №' + e.num + ' отправлен раньше времени по графику');
    }
  };

  // Отклонение в минутах: по факту отправления, либо текущее опоздание.
  S.deviation = function (e, now) {
    if (e.factDep) return Math.trunc((e.factDep - e.dep) / 60);
    if (now > e.dep + 59) return Math.floor((now - e.dep) / 60);
    return 0;
  };

  S.status = function (e, now) {
    if (e.netStatus && RS.Net && RS.Net.isClient()) return e.netStatus;
    const late = S.deviation(e, now);
    const lateTxt = late > 0 ? ' · опаздывает +' + late + ' мин' : '';
    if (e.state === 'cancelled') return { text: 'отменён', cls: 'plan' };
    if (e.state === 'gone') {
      return { text: (e.kind === 'pass' ? 'проследовал ' : 'отправлен ') + S.hm(e.factDep) + ' · ' + devText(late), cls: late > 1 ? 'late' : 'ok' };
    }
    if (e.state === 'plan') {
      if (now > e.spawnAt + 30) return { text: 'задерживается на перегоне' + (late > 0 ? ' +' + late + ' мин' : ''), cls: 'late' };
      if (e.spawnAt - now < 300) return { text: 'выходит на подход через ' + Math.max(1, Math.ceil((e.spawnAt - now) / 60)) + ' мин', cls: 'plan' };
      return { text: 'по графику', cls: 'plan' };
    }
    const c = S.consistOf(e);
    if (!c) return { text: 'в маневровой работе', cls: 'wait' };
    if (e.state === 'approach') {
      let txt = 'на подходе';
      if (c.v < 0.05) {
        const m = /Закрыт светофор (\S+)/.exec(c.status || '');
        const sig = m && RS.Track.signals[m[1]];
        txt = !sig ? 'стоит на перегоне' : sig.kind === 'entry' ? 'стоит у входного' : 'стоит на перегоне у светофора ' + sig.name;
      }
      return { text: txt + lateTxt, cls: c.v < 0.05 || late > 0 ? 'late' : 'appr' };
    }
    const ai = c.ai || {};
    if (ai.phase === 'dwell') {
      const left = Math.max(0, Math.ceil(e.dep - now));
      return { text: 'стоянка' + (left > 0 ? ' · отправление через ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : ''), cls: 'wait' };
    }
    if (ai.phase === 'ready') {
      return { text: (now < e.dep ? 'готов, отправление в ' + S.hm(e.dep) : 'готов к отправлению') + lateTxt, cls: late > 1 ? 'late' : 'wait' };
    }
    if (c.ctl !== 'ai') return { text: 'на ручном управлении' + lateTxt, cls: 'wait' };
    return { text: (c.v < 0.05 ? 'стоит на станции' : e.kind === 'pass' ? 'проследует станцию' : 'прибывает') + lateTxt, cls: late > 0 ? 'late' : 'appr' };
  };

  S.summary = function () {
    const done = S.entries.filter((e) => e.state === 'gone');
    const devs = done.map((e) => Math.trunc((e.factDep - e.dep) / 60));
    return {
      done: done.length,
      onTime: devs.filter((d) => d <= 1).length,
      late: devs.reduce((s, d) => s + Math.max(0, d), 0),
    };
  };

  RS.Schedule = S;
})();
