/*
 * Грузовая и маневровая работа станции: задания (подать вагоны на фронт, убрать,
 * прицепить к поезду), операции на фронтах (выгрузка, слив, погрузка), баллы смены
 * и отказы устройств СЦБ. Вагоны станции проходят круг: ждут подачи → под операцией
 * → готовы к отправке → уходят с вывозным или сборным поездом.
 * Состояние вагона v.st: wait — ждёт подачи, task — по нему есть задание,
 * op — под операцией, ready — готов к отправке.
 */
(function () {
  const RS = window.RS;
  const T = RS.Track;
  const C = RS.Consist;
  const LAY = RS.LAYOUT;

  const K = {
    list: [], nextId: 1, ops: [], faults: [],
    points: 0, done: 0, failed: 0,
    on: true, faultsOn: false,
    nextGen: 60, nextFault: 1800,
    departed: new Set(), // вагоны станции, увезённые поездами
    dirty: true,
  };
  const STORE = '7П'; // путь накопления вагонов к отправлению
  // Формы для «подать 1 / 2 / 5 …» (винительный падеж и родительный после числительных).
  const TYPE_NAME = {
    К: ['крытый вагон', 'крытых вагона', 'крытых вагонов'], Х: ['хоппер', 'хоппера', 'хопперов'],
    ПВ: ['полувагон', 'полувагона', 'полувагонов'], Ц: ['цистерну', 'цистерны', 'цистерн'],
    ПЛ: ['платформу', 'платформы', 'платформ'], '': ['вагон', 'вагона', 'вагонов'],
  };
  const plural = (n, f) => {
    const a = n % 100, b = n % 10;
    return f[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2];
  };
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const now = () => RS.Sim.t;
  const hm = (t) => RS.Schedule.hm(t);
  const trackName = (sec) => T.trackName(sec);
  const log = (text, type) => RS.Log.add(text, type);

  // --- где вагоны ---------------------------------------------------------------------------
  function findVeh(id) {
    for (const c of C.list) {
      const v = c.vehicles.find((x) => x.id === id);
      if (v) return { c, v };
    }
    return null;
  }
  const located = (ids) => ids.map(findVeh).filter(Boolean);

  // Середина вагона на схеме: по ней видно, сдвигали ли вагоны под операцией.
  function vehPoint(id) {
    const f = findVeh(id);
    if (!f) return null;
    let d = 0;
    for (let i = f.c.vehicles.length - 1; i >= 0; i--) {
      const v = f.c.vehicles[i];
      if (v.id === id) return C.pointAtBack(f.c, d + v.len / 2);
      d += v.len;
    }
    return null;
  }

  // Вагон стоит на пути target отцепленным: в составе без локомотива, на месте, целиком на пути.
  function onFront(c, target) {
    const secs = C.sectionsOf(c);
    return !C.hasLoco(c) && c.v < 0.05 && secs.length === 1 && secs[0] === target;
  }

  function progressOf(t) {
    const w = located(t.wagons);
    const total = t.wagons.length;
    if (t.kind === 'attach') {
      const n = w.filter(({ c }) => c.vehicles.some((v) => v.owner && v.owner.info.num === t.train)).length;
      return { n, ok: n === total, lost: w.length < total };
    }
    // вагоны, которые убирали с фронта, могли уйти сразу с вывозным поездом — это тоже выполнено
    const gone = t.kind === 'remove' ? t.wagons.filter((id) => K.departed.has(id)).length : 0;
    const n = w.filter(({ c }) => onFront(c, t.target)).length + gone;
    return { n, ok: n === total, lost: w.length + gone < total };
  }

  // --- задания -------------------------------------------------------------------------------
  function add(t) {
    const task = Object.assign({ id: 'z' + K.nextId++, state: 'active', created: now() }, t);
    K.list.push(task);
    for (const { v } of located(task.wagons)) if (task.kind === 'deliver') v.st = 'task';
    log('Маневровое задание: ' + task.title + ' (срок ' + hm(task.due) + ')', 'shunt');
    if (RS.UI) RS.UI.toast('Новое маневровое задание: ' + task.title, 'info');
    K.dirty = true;
    return task;
  }

  function finish(t, ok, why) {
    t.state = ok ? 'done' : 'failed';
    t.ended = now();
    if (ok) {
      K.done++;
      K.points += t.reward;
      log('Задание выполнено: ' + t.title + (why ? ' — ' + why : '') + ' (+' + t.reward + ' баллов)', 'good');
      if (RS.UI) RS.UI.toast('Задание выполнено: +' + t.reward + ' баллов', 'info');
    } else {
      K.failed++;
      K.points -= 10;
      log('Задание не выполнено: ' + t.title + (why ? ' — ' + why : '') + ' (−10 баллов)', 'late');
      if (t.kind === 'deliver') for (const { v } of located(t.wagons)) if (v.st === 'task') v.st = 'wait';
    }
    K.dirty = true;
  }

  const groupName = (wagons) => {
    const types = [...new Set(wagons.map((v) => v.type))];
    const f = (types.length === 1 && TYPE_NAME[types[0]]) || TYPE_NAME[''];
    return wagons.length + ' ' + plural(wagons.length, f);
  };

  // Подать вагоны на грузовой фронт.
  function deliverTask(wagons, target, from, due, extra) {
    const f = LAY.fronts[target];
    const src = findVeh(wagons[0].id);
    const fromTxt = from ? ' от поезда №' + from : ' с пути ' + trackName(C.sectionsOf(src.c)[0]);
    return add(Object.assign({
      kind: 'deliver', target, due, reward: 30,
      wagons: wagons.map((v) => v.id),
      title: 'Подать ' + groupName(wagons) + ' на путь ' + trackName(target) + ' (' + f.name + ')',
      text: (from ? 'Отцепить' + fromTxt + ' и подать' : 'Подать' + fromTxt) + ' ' + f.to + '. Вагоны оставить отцепленными на пути ' +
        trackName(target) + '.',
    }, extra || {}));
  }

  // В тупик вагоны подаются вагонами вперёд: локомотив толкает их со стороны горловины.
  const FRONT_HINT = {
    '8П': 'Путь 8 — тупик у чётной горловины. Вагоны подавайте вагонами вперёд: локомотив с восточной (правой) стороны группы толкает её, например с вытяжного пути 9 от светофора М2.',
    '11П': 'Нефтебаза — тупик за стрелкой 24 у вытяжного пути 9. Вагоны подавайте вагонами вперёд: локомотив с западной (левой) стороны толкает их маневровым маршрутом на путь 11 от выходного светофора чётной горловины (Н…).',
    '12П': 'Лесопильный завод — тупик за стрелкой 21 у вытяжного пути 10. Вагоны подавайте вагонами вперёд: локомотив с восточной (правой) стороны толкает их маневровым маршрутом на путь 12 от выходного светофора нечётной горловины (Ч…).',
  };

  K.HINT = FRONT_HINT;

  // --- операции на фронтах -------------------------------------------------------------------
  function startOp(ids, target, minutes) {
    const f = LAY.fronts[target];
    const dur = (minutes || rnd(f.min[0], f.min[1])) * 60;
    const op = { ids, target, until: now() + dur, what: f.what, at: ids.map(vehPoint) };
    for (const { v } of located(ids)) {
      v.st = 'op';
      v.dest = undefined;
      v.opUntil = op.until;
    }
    K.ops.push(op);
    K.dirty = true;
    return op;
  }

  function updateOps() {
    for (const op of K.ops.slice()) {
      const w = located(op.ids);
      // сцепить локомотив с вагонами под операцией можно, сдвигать их — нет
      const intact = w.length === op.ids.length && op.ids.every((id, i) => {
        const p = vehPoint(id), q = op.at[i];
        return p && q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.5;
      });
      if (!intact) {
        K.ops = K.ops.filter((x) => x !== op);
        for (const { v } of w) { v.st = 'wait'; v.opUntil = undefined; }
        if (K.on) {
          // нарушение: −15 баллов идёт через счёт нарушений
          log('Вагоны сдвинуты с пути ' + trackName(op.target) + ' до окончания операции «' + op.what + '» — операция сорвана (−15 баллов)', 'bad');
          RS.Stats.incident('Сорвана операция на пути ' + trackName(op.target));
        }
        K.dirty = true;
        continue;
      }
      if (now() < op.until) continue;
      K.ops = K.ops.filter((x) => x !== op);
      for (const { v } of w) { v.st = 'ready'; v.opUntil = undefined; v.load = LAY.fronts[op.target].op === 'load' ? 'loaded' : 'empty'; }
      log('Окончена грузовая операция «' + op.what + '» на пути ' + trackName(op.target) + ': ' + op.ids.length + ' ваг. готовы к отправке', 'good');
      K.dirty = true;
      if (K.on) add({
        kind: 'remove', target: STORE, due: now() + 40 * 60, reward: 20, wagons: op.ids,
        title: 'Убрать ' + groupName(w.map((x) => x.v)) + ' с пути ' + trackName(op.target) + ' на путь 7',
        text: 'Освободить фронт: вагоны после операции «' + op.what + '» переставить на путь 7 (накопление к отправлению) и оставить отцепленными.',
      });
    }
  }

  // --- генерация заданий ---------------------------------------------------------------------
  const busyTarget = (target) =>
    K.list.some((t) => t.state === 'active' && t.kind === 'deliver' && t.target === target) ||
    K.ops.some((o) => o.target === target) ||
    C.list.some((c) => C.sectionsOf(c).includes(target));

  // Вагоны станции, которые ждут подачи (в отцепах, не в поездах).
  function waiting(types) {
    const out = [];
    for (const c of C.list) {
      if (C.hasLoco(c)) continue;
      for (const v of c.vehicles) if (v.st === 'wait' && types.includes(v.type)) out.push(v);
    }
    return out;
  }

  function generate() {
    const active = K.list.filter((t) => t.state === 'active' && t.kind !== 'attach').length;
    if (active >= 2) return;
    for (const target of Object.keys(LAY.fronts)) {
      if (busyTarget(target)) continue;
      const vs = waiting(LAY.fronts[target].types);
      if (!vs.length) continue;
      // одной группой из одного отцепа
      const c0 = findVeh(vs[0].id).c;
      const group = vs.filter((v) => findVeh(v.id).c === c0).slice(0, 6);
      deliverTask(group, target, null, now() + 50 * 60);
      return;
    }
  }

  // Поезд прибыл на станцию: сборный оставляет вагоны, вывозной и сборный забирают готовые.
  K.onArrive = function (c, track) {
    if (!K.on || !c.info || !['local', 'pickup'].includes(c.info.cat)) return;
    const num = c.info.num;
    const due = c.info.plan ? c.info.plan.dep : now() + 40 * 60;
    const mine = c.vehicles.filter((v) => v.dest === LAY.station);
    for (const v of mine) v.st = 'wait';
    const byFront = {};
    for (const v of mine) {
      const target = Object.keys(LAY.fronts).find((k) => LAY.fronts[k].types.includes(v.type)) || '8П';
      (byFront[target] = byFront[target] || []).push(v);
    }
    for (const [target, vs] of Object.entries(byFront)) deliverTask(vs, target, num, due + 20 * 60);
    const promised = new Set();
    for (const t of K.list) if (t.state === 'active' && t.kind === 'attach') for (const id of t.wagons) promised.add(id);
    const ready = [];
    for (const x of C.list) {
      if (C.hasLoco(x)) continue;
      for (const v of x.vehicles) if (v.st === 'ready' && !promised.has(v.id)) ready.push(v);
    }
    if (ready.length) {
      const take = ready.slice(0, 15);
      add({
        kind: 'attach', train: num, due, reward: 40, wagons: take.map((v) => v.id),
        title: 'Прицепить ' + groupName(take) + ' к поезду №' + num + ' (путь ' + trackName(track) + ')',
        text: 'Готовые к отправке вагоны (зелёная обводка) прицепить к составу поезда №' + num + ' до его отправления в ' + hm(due) +
          '. Можно подать их маневровым локомотивом или съездить за ними поездным, взяв управление.',
      });
    }
  };

  // Поезд ушёл со станции: задания на прицепку к нему закрываются (частично — пропорционально).
  K.onDepart = function (c) {
    if (!c.ai || c.ai.tasksOut) return;
    c.ai.tasksOut = true;
    const num = c.info && c.info.num;
    for (const t of K.list) {
      if (t.state !== 'active' || t.kind !== 'attach' || t.train !== num) continue;
      const p = progressOf(t);
      if (p.ok) finish(t, true);
      else if (p.n > 0) {
        t.reward = Math.round((t.reward * p.n) / t.wagons.length);
        finish(t, true, 'частично: ' + p.n + ' из ' + t.wagons.length + ' ваг.');
      } else finish(t, false, 'поезд ушёл без вагонов');
    }
    // увезённые вагоны больше не числятся за станцией
    for (const v of c.vehicles) {
      if (v.st === 'ready') K.departed.add(v.id);
      if (v.st) v.st = undefined;
    }
    K.dirty = true;
  };

  // Сборный или вывозной встал на пути станции целиком — задания на отцепку и прицепку
  // (и в автоведении, и когда машиниста ведёт игрок).
  function checkArrivals() {
    for (const c of C.list) {
      const info = c.info;
      if (!info || !['local', 'pickup'].includes(info.cat) || info.tasked || !c.ai || !c.ai.inStation || c.v > 0.05) continue;
      const secs = C.sectionsOf(c);
      if (secs.length !== 1 || !LAY.tracks[secs[0]]) continue;
      info.tasked = true;
      K.onArrive(c, secs[0]);
    }
  }

  // --- отказы устройств --------------------------------------------------------------------------
  function makeFault() {
    const t = now();
    const until = t + rnd(4, 9) * 60;
    if (Math.random() < 0.6) {
      const cands = Object.values(T.sections).filter((s) => /СП$/.test(s.id) && !s.lock && !s.occupied && !s.fault);
      if (!cands.length) return;
      const s = cands[rnd(0, cands.length - 1)];
      s.fault = true;
      K.faults.push({ kind: 'occ', sec: s.id, until });
      log('Отказ: ложная занятость рельсовой цепи ' + s.id + '. Электромеханик вызван, восстановление около ' + hm(until) +
        '. Через неё — только по пригласительному сигналу, убедившись, что путь свободен.', 'warn');
    } else {
      const cands = Object.values(T.groups).filter((g) => !g.target && RS.IL.canThrow(g.id).ok);
      if (!cands.length) return;
      const g = cands[rnd(0, cands.length - 1)];
      g.noCtl = true;
      K.faults.push({ kind: 'sw', gid: g.id, until });
      log('Отказ: стрелка ' + g.id + ' потеряла контроль положения. Электромеханик вызван, восстановление около ' + hm(until) +
        '. Стрелку не перевести, светофоры через неё не откроются: ищите обход или пропускайте поезда по пригласительному сигналу.', 'warn');
    }
    K.dirty = true;
  }

  function updateFaults(dt) {
    for (const f of K.faults.slice()) {
      if (now() < f.until) continue;
      K.faults = K.faults.filter((x) => x !== f);
      if (f.kind === 'occ') T.sections[f.sec].fault = false;
      else T.groups[f.gid].noCtl = false;
      log('Устранено: ' + (f.kind === 'occ' ? 'рельсовая цепь ' + f.sec + ' исправна' : 'контроль стрелки ' + f.gid + ' восстановлен'), 'good');
      K.dirty = true;
    }
    if (!K.faultsOn) return;
    K.nextFault -= dt;
    if (K.nextFault <= 0) {
      K.nextFault = rnd(18, 35) * 60;
      makeFault();
    }
  }

  // --- баллы ---------------------------------------------------------------------------------------
  // Оценка смены: баллы за задания, +5 за поезд по графику, −1 за минуту опоздания, −15 за нарушение.
  K.score = function () {
    const s = RS.Schedule.summary();
    const parts = { tasks: K.points, onTime: s.onTime * 5, late: -s.late, inc: -RS.Stats.incidents.length * 15 };
    return Object.assign(parts, { total: parts.tasks + parts.onTime + parts.late + parts.inc });
  };
  K.total = () => K.score().total;

  // --- включение и выключение ----------------------------------------------------------------------
  K.setOn = function (on) {
    if (K.on === !!on) return;
    K.on = !!on;
    if (!K.on) {
      // активные задания снимаются без штрафа, вагоны остаются, где стоят
      for (const t of K.list) {
        if (t.state !== 'active') continue;
        t.state = 'cancelled';
        t.ended = now();
        for (const { v } of located(t.wagons)) if (v.st === 'task') v.st = 'wait';
      }
    } else K.nextGen = 5;
    log('Маневровые задания ' + (K.on ? 'включены' : 'выключены'), 'info');
    K.dirty = true;
  };

  K.setFaults = function (on) {
    if (K.faultsOn === !!on) return;
    K.faultsOn = !!on;
    if (K.faultsOn) K.nextFault = rnd(3, 8) * 60;
    log('Отказы устройств СЦБ ' + (K.faultsOn ? 'включены: первый — в ближайшие минуты' : 'выключены'), 'info');
    K.dirty = true;
  };

  // --- сводка для панели «Задания» (она же уходит игрокам совместной игры) ---------------------
  function frontState(target) {
    const op = K.ops.find((o) => o.target === target);
    if (op) return { st: 'op', until: op.until, what: op.what, n: op.ids.length };
    const vs = [];
    for (const c of C.list) if (C.sectionsOf(c).includes(target)) vs.push(...c.vehicles.filter((v) => !v.loco));
    if (!vs.length) return { st: 'free', n: 0 };
    return { st: vs.some((v) => v.st === 'ready') ? 'ready' : 'busy', n: vs.length };
  }

  K.view = function () {
    const consistsOf = (ids) => [...new Set(located(ids).map(({ c }) => c.id))];
    return {
      on: K.on, faultsOn: K.faultsOn, done: K.done, failed: K.failed, score: K.score(),
      list: K.list.filter((t) => t.state !== 'cancelled').map((t) => ({
        id: t.id, kind: t.kind, state: t.state, title: t.title, text: t.text, target: t.target || null, due: t.due, reward: t.reward,
        n: t.n || 0, total: t.wagons.length, ready: !!t.ready, train: t.train || null, ended: t.ended || null,
        cs: t.state === 'active' ? consistsOf(t.wagons) : [],
      })),
      fronts: Object.keys(LAY.fronts).map((k) => Object.assign({ track: k, name: LAY.fronts[k].name }, frontState(k))),
      faults: K.faults.map((f) => ({ kind: f.kind, id: f.sec || f.gid, until: f.until })),
    };
  };

  // --- такт ----------------------------------------------------------------------------------------
  let acc = 0;
  K.update = function (dt) {
    updateFaults(dt);
    acc += dt;
    if (acc < 1) return;
    acc = 0;
    updateOps();
    if (K.on) checkArrivals();
    for (const t of K.list) {
      if (t.state !== 'active') continue;
      const p = progressOf(t);
      t.n = p.n;
      if (t.kind !== 'attach' && p.ok) {
        finish(t, true);
        if (t.kind === 'deliver') startOp(t.wagons, t.target);
        continue;
      }
      if (t.kind === 'attach') {
        // итог прицепки подводится при отправлении поезда; без отправления — через час после срока
        t.ready = p.ok;
        if (p.ok) continue;
      }
      if (p.lost) finish(t, false, 'вагоны ушли со станции');
      else if (now() > t.due + (t.kind === 'attach' ? 3600 : 0)) finish(t, false, 'истёк срок');
    }
    K.list = K.list.filter((t) => t.state === 'active' || now() - t.ended < 30 * 60);
    if (!K.on) return;
    K.nextGen -= 1;
    if (K.nextGen <= 0) {
      K.nextGen = 90;
      generate();
    }
  };

  // Начальная обстановка: вагоны под выгрузкой на грузовом дворе и вагоны станции на пути 7.
  K.init = function () {
    for (const c of C.list) {
      if (C.hasLoco(c)) continue;
      const sec = C.sectionsOf(c)[0];
      if (sec === '8П') {
        for (const v of c.vehicles) v.st = 'op';
        startOp(c.vehicles.map((v) => v.id), '8П', 18);
      } else for (const v of c.vehicles) v.st = 'wait';
    }
  };

  RS.Tasks = K;
})();
