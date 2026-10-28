/*
 * Электрическая централизация: перевод стрелок, поиск, установка, замыкание
 * и размыкание маршрутов, показания светофоров по ИСИ.
 */
(function () {
  const RS = window.RS;
  const T = RS.Track;

  const SWITCH_TIME = 3; // с, перевод стрелки
  const OPEN_DELAY = 1.2; // с, проверка условий перед открытием светофора
  const RELEASE_TIME = { train: 180, shunt: 60 }; // искусственное размыкание
  const INVITE_TIME = 90; // пригласительный сигнал горит не дольше
  const REPAIR_TIME = 120; // восстановление взрезанной стрелки
  const DEPART_LINE = new Set(['ЧУ1', 'НУ1']);

  const IL = { routes: [], nextId: 1, time: 0 };
  const log = (m, t) => RS.Log && RS.Log.add(m, t);

  // --- стрелки ---------------------------------------------------------------
  function groupBusy(g) {
    return g.members.some((m) => T.sections[T.switches[m].sec].occupied);
  }

  IL.canThrow = function (gid) {
    const g = T.groups[gid];
    if (g.damaged) return { ok: false, why: 'Стрелка ' + gid + ' взрезана — требуется восстановление' };
    if (g.locks.size) return { ok: false, why: 'Стрелка ' + gid + ' замкнута в маршруте' };
    if (groupBusy(g)) return { ok: false, why: 'Стрелочная секция стрелки ' + gid + ' занята' };
    return { ok: true };
  };

  function throwTo(g, pos) {
    if (g.target === pos || (!g.target && g.pos === pos)) return;
    g.target = pos;
    g.t = SWITCH_TIME;
  }

  IL.toggleSwitch = function (gid) {
    const c = IL.canThrow(gid);
    if (!c.ok) return c;
    const g = T.groups[gid];
    const cur = g.target || g.pos;
    throwTo(g, cur === 'plus' ? 'minus' : 'plus');
    return { ok: true };
  };

  IL.repair = function (gid) {
    const g = T.groups[gid];
    if (!g.damaged || g.repairT > 0) return;
    g.repairT = REPAIR_TIME;
    log('Вызван монтёр СЦБ: восстановление стрелки ' + gid, 'warn');
  };

  // Взрез: состав прошёл стрелку с пошёрстного направления при неправильном положении.
  IL.cutSwitch = function (swNode, branch) {
    const g = T.groupOf(swNode);
    if (g.damaged) return;
    g.damaged = true;
    g.pos = branch;
    g.target = null;
    log('ВЗРЕЗ стрелки ' + g.id + '! Стрелка потеряла контроль положения.', 'bad');
    RS.Stats && RS.Stats.incident('Взрез стрелки ' + g.id);
  };

  // --- поиск маршрутов ---------------------------------------------------------
  IL.findRoutes = function (sigId, kind) {
    const start = T.signals[sigId];
    if (!start) return [];
    if (kind === 'train' && !start.train) return [];
    if (kind === 'shunt' && !start.shunt) return [];
    const found = [];

    function push(path, req, minus, end) {
      const sections = [];
      for (const p of path) {
        const s = T.segs[p.seg].sec;
        if (sections[sections.length - 1] !== s) sections.push(s);
      }
      found.push({
        kind, start: sigId, path, req, minus, end, sections,
        dest: sections[sections.length - 1],
        dev: Object.values(req).includes('minus'),
      });
    }

    function walk(seg, dir, path, req, minus) {
      if (path.length > 40) return;
      path = path.concat([{ seg, dir }]);
      const node = T.endNode(seg, dir);
      const s = T.signalFor(node, seg);
      if (s) {
        if (kind === 'train') {
          if (start.kind === 'entry' && s.kind === 'exit') return push(path, req, minus, { type: 'signal', sig: s.id });
          if (start.kind === 'exit' && s.kind === 'block') return push(path, req, minus, { type: 'line', sig: s.id });
          if (s.kind !== 'shunt') return;
        } else {
          if (s.shunt) return push(path, req, minus, { type: 'signal', sig: s.id });
          return;
        }
      }
      const n = T.nodes[node];
      if (n.end === 'buffer') {
        if (kind === 'shunt') push(path, req, minus, { type: 'dead', node });
        return;
      }
      if (n.end) return;
      for (const br of T.branches(node, seg)) {
        if (T.isBoundary(node, br.seg)) {
          const lineSec = T.segs[br.seg].sec;
          if (!(kind === 'train' && start.kind === 'exit' && DEPART_LINE.has(lineSec))) continue;
        }
        let r = req;
        if (br.sw) {
          const gid = T.switches[br.sw].group;
          if (req[gid] && req[gid] !== br.pos) continue;
          r = Object.assign({}, req, { [gid]: br.pos });
        }
        walk(br.seg, br.dir, path, r, minus + (br.pos === 'minus' ? 1 : 0));
      }
    }

    for (const br of T.branches(start.node, start.seg)) {
      let r = {};
      if (br.sw) r[T.switches[br.sw].group] = br.pos;
      walk(br.seg, br.dir, [], r, br.pos === 'minus' ? 1 : 0);
    }
    // по одному (основному — с наименьшим числом отклонений) варианту на каждую конечную точку
    const best = {};
    for (const c of found) {
      const key = c.end.sig || c.end.node;
      if (!best[key] || c.minus < best[key].minus) best[key] = c;
    }
    return Object.values(best);
  };

  // Участок приближения светофора: для входного — два ближних блок-участка перед ним.
  function approachSecs(sig) {
    if (sig.kind === 'entry') {
      const sp = Object.values(RS.LAYOUT.spawns).find((x) => x.entry === sig.id);
      if (sp) return sp.approach.slice(-2);
    }
    return [T.segs[sig.seg].sec];
  }
  IL.approachBusy = (sig) => approachSecs(sig).some((s) => T.sections[s].occupied);

  // --- проверка условий --------------------------------------------------------
  IL.routeFrom = (sigId) => IL.routes.find((r) => r.start === sigId && !r.cancelling) || null;
  IL.byId = (id) => IL.routes.find((r) => r.id === id) || null;

  IL.check = function (c, opts) {
    opts = opts || {};
    if (IL.routeFrom(c.start)) return { ok: false, why: 'От светофора ' + c.start + ' уже задан маршрут' };
    const last = c.sections.length - 1;
    let destBusy = false;
    for (let i = 0; i <= last; i++) {
      const sec = T.sections[c.sections[i]];
      if (sec.lock) {
        const r = IL.byId(sec.lock);
        return { ok: false, why: 'Враждебный маршрут: ' + T.trackName(sec.id) + ' замкнута в маршруте ' + (r ? r.title : '') };
      }
      if (sec.occupied) {
        const isDest = i === last && c.end.type !== 'line';
        if (isDest && c.kind === 'shunt') continue;
        if (isDest && c.kind === 'train') { destBusy = true; continue; }
        return { ok: false, why: 'Занята рельсовая цепь ' + sec.id };
      }
    }
    for (const [gid, pos] of Object.entries(c.req)) {
      const g = T.groups[gid];
      if (g.damaged) return { ok: false, why: 'Стрелка ' + gid + ' взрезана' };
      const inPlace = g.pos === pos && !g.target;
      for (const [rid, p] of g.locks) {
        if (p !== pos) return { ok: false, why: 'Стрелка ' + gid + ' замкнута в другом положении (маршрут ' + (IL.byId(rid) || {}).title + ')' };
      }
      if (!inPlace && groupBusy(g)) return { ok: false, why: 'Стрелку ' + gid + ' нельзя перевести: секция занята' };
    }
    if (destBusy && !opts.invite) {
      return { ok: false, inviteOk: true, why: 'Путь ' + T.trackName(c.dest) + ' занят. Приём возможен только по пригласительному сигналу.' };
    }
    return { ok: true, destBusy };
  };

  IL.title = function (c) {
    const tr = (s) => T.trackName(s);
    if (c.end.type === 'line') return c.start + ' → перегон';
    if (c.end.type === 'dead') return c.start + ' → путь ' + tr(c.dest) + ' (тупик)';
    return c.start + ' → путь ' + tr(c.dest);
  };

  IL.set = function (c, opts) {
    opts = opts || {};
    const chk = IL.check(c, opts);
    if (!chk.ok) return chk;
    const r = Object.assign({}, c, {
      id: IL.nextId++,
      title: IL.title(c),
      invite: !!opts.invite,
      seen: c.sections.map(() => false),
      released: c.sections.map(() => false),
      used: false, closed: false, open: false, readyT: 0, cancelT: 0, cancelling: false,
      wasOpen: false,
    });
    for (const s of r.sections) T.sections[s].lock = r.id;
    for (const [gid, pos] of Object.entries(r.req)) {
      const g = T.groups[gid];
      g.locks.set(r.id, pos);
      throwTo(g, pos);
    }
    IL.routes.push(r);
    if (r.invite) T.signals[r.start].invite = INVITE_TIME;
    log((r.kind === 'train' ? 'Поездной' : 'Маневровый') + ' маршрут ' + r.title + (r.invite ? ' (пригласительный)' : ''), r.kind === 'train' ? 'route' : 'shunt');
    return { ok: true, route: r };
  };

  function release(r) {
    r.sections.forEach((s, i) => {
      if (T.sections[s].lock === r.id) T.sections[s].lock = null;
      r.released[i] = true;
    });
    for (const gid of Object.keys(r.req)) T.groups[gid].locks.delete(r.id);
    T.signals[r.start].invite = 0;
    IL.routes = IL.routes.filter((x) => x !== r);
  }

  IL.cancel = function (rid) {
    const r = IL.byId(rid);
    if (!r) return { ok: false };
    if (r.cancelT > 0) return { ok: false, why: 'Уже выполняется искусственное размыкание' };
    r.closed = true;
    T.signals[r.start].invite = 0;
    if (r.used) {
      r.cancelling = true;
      log('Отмена маршрута ' + r.title + ': размыкание свободных секций', 'info');
      return { ok: true };
    }
    if (r.wasOpen && IL.approachBusy(T.signals[r.start])) {
      r.cancelT = RELEASE_TIME[r.kind];
      log('Искусственное размыкание маршрута ' + r.title + ' (' + r.cancelT / 60 + ' мин): участок приближения занят', 'warn');
      return { ok: true, delayed: true };
    }
    release(r);
    log('Маршрут ' + r.title + ' отменён', 'info');
    return { ok: true };
  };

  IL.reopen = function (rid) {
    const r = IL.byId(rid);
    if (!r || r.used || r.cancelT > 0 || r.cancelling) return { ok: false, why: 'Повторное открытие невозможно' };
    r.closed = false;
    r.readyT = 0;
    if (r.invite) T.signals[r.start].invite = INVITE_TIME;
    return { ok: true };
  };

  IL.inviteAgain = function (sigId) {
    const r = IL.routeFrom(sigId);
    if (!r || !r.invite || r.used) return { ok: false, why: 'Нет маршрута для пригласительного сигнала' };
    T.signals[sigId].invite = INVITE_TIME;
    return { ok: true };
  };

  // --- такт ----------------------------------------------------------------------
  function conditionsOk(r) {
    const last = r.sections.length - 1;
    for (let i = 0; i <= last; i++) {
      if (!T.sections[r.sections[i]].occupied) continue;
      const isDest = i === last && r.end.type !== 'line';
      if (isDest && (r.kind === 'shunt' || r.invite)) continue;
      return false;
    }
    return true;
  }

  function switchesReady(r) {
    return Object.entries(r.req).every(([gid, pos]) => {
      const g = T.groups[gid];
      return !g.damaged && !g.target && g.pos === pos;
    });
  }

  function sectionalRelease(r) {
    const last = r.sections.length - 1;
    r.sections.forEach((s, i) => {
      if (T.sections[s].occupied) r.seen[i] = true;
    });
    for (let i = 0; i <= last; i++) {
      if (r.released[i]) continue;
      const sec = T.sections[r.sections[i]];
      const prevDone = r.released.slice(0, i).every(Boolean);
      const destTrack = i === last && r.end.type !== 'line';
      let free;
      if (r.cancelling) free = !sec.occupied || (destTrack && prevDone);
      else free = prevDone && r.seen[i] && (!sec.occupied || destTrack);
      if (free) {
        r.released[i] = true;
        if (sec.lock === r.id) sec.lock = null;
      }
    }
    // снять замыкание стрелок, секции которых в маршруте разомкнуты
    for (const gid of Object.keys(r.req)) {
      const g = T.groups[gid];
      const idx = g.members.map((m) => r.sections.indexOf(T.switches[m].sec)).filter((i) => i >= 0);
      if (idx.every((i) => r.released[i])) g.locks.delete(r.id);
    }
    if (r.released.every(Boolean)) release(r);
  }

  IL.update = function (dt) {
    IL.time += dt;
    for (const g of Object.values(T.groups)) {
      if (g.target) {
        g.t -= dt;
        if (g.t <= 0) { g.pos = g.target; g.target = null; }
      }
      if (g.repairT > 0) {
        g.repairT -= dt;
        if (g.repairT <= 0) { g.damaged = false; log('Стрелка ' + g.id + ' восстановлена, контроль положения есть', 'good'); }
      }
    }
    // пригласительный горит, пока к светофору не подошёл поезд, и затем не дольше INVITE_TIME
    for (const s of Object.values(T.signals)) if (s.invite > 0 && T.sections[T.segs[s.seg].sec].occupied) s.invite = Math.max(0, s.invite - dt);

    for (const r of IL.routes.slice()) {
      if (r.cancelT > 0) {
        r.cancelT -= dt;
        r.open = false;
        if (r.cancelT <= 0) { release(r); log('Маршрут ' + r.title + ' разомкнут', 'info'); }
        continue;
      }
      const firstOcc = T.sections[r.sections[0]].occupied;
      if (firstOcc && !r.used) {
        r.used = true;
        T.signals[r.start].invite = 0;
        if (!r.wasOpen && !r.invite) {
          log('Проезд закрытого светофора ' + r.start + '!', 'bad');
          RS.Stats && RS.Stats.incident('Проезд закрытого светофора ' + r.start);
        }
      }
      const ready = switchesReady(r);
      const cond = conditionsOk(r);
      if (r.open && !cond && !r.used) {
        r.closed = true;
        log('Светофор ' + r.start + ' перекрыт: нарушены условия маршрута', 'warn');
      }
      if (ready && cond && !r.closed && !r.used && !r.invite) r.readyT += dt;
      else r.readyT = 0;
      r.open = !r.used && !r.closed && !r.invite && ready && cond && r.readyT >= OPEN_DELAY;
      if (r.open) r.wasOpen = true;
      if (r.invite && ready && T.signals[r.start].invite > 0 && !r.used) r.wasOpen = true;
      sectionalRelease(r);
    }
    computeAspects();
  };

  // --- показания светофоров (ИСИ, автоблокировка) ----------------------------------
  const CLOSED = new Set(['R', 'RW', 'W']);
  const REDUCED = new Set(['YY', 'YFY']);

  // Проходные светофоры (трёхзначная АБ): красный — блок-участок за светофором занят,
  // жёлтый — следующий светофор закрыт, зелёный — открыт. Предвходной при двух жёлтых
  // на входном горит жёлтым мигающим. Порядок расчёта: сначала следующий по ходу светофор.
  const BL = RS.LAYOUT.blockLogic;
  function chain(id) {
    let x = id, depth = 0;
    while (BL[x].next && BL[BL[x].next]) { x = BL[x].next; depth++; }
    return { depth, end: BL[x].next };
  }
  const byDepth = (a, b) => chain(a).depth - chain(b).depth;
  const DEPART_BLOCKS = Object.keys(BL).filter((id) => !chain(id).end).sort(byDepth);
  const APPROACH_BLOCKS = Object.keys(BL).filter((id) => chain(id).end).sort(byDepth);

  function blockAspect(id) {
    const bl = BL[id];
    if (T.sections[bl.protects].occupied) return 'R';
    if (!bl.next) return 'G';
    const nxt = T.signals[bl.next];
    if (nxt.aspect === 'R' || nxt.aspect === 'RW') return 'Y';
    if (nxt.kind === 'entry' && REDUCED.has(nxt.aspect)) return 'YF';
    return 'G';
  }

  function computeAspects() {
    const S = T.signals;
    const routeOf = {};
    for (const r of IL.routes) if (!r.cancelling) routeOf[r.start] = r;

    for (const id of DEPART_BLOCKS) S[id].aspect = blockAspect(id);

    const inviteOn = (sig, r) => r && r.invite && !r.used && sig.invite > 0 && switchesReady(r);

    for (const sig of Object.values(S)) {
      if (sig.kind !== 'exit') continue;
      const r = routeOf[sig.id];
      if (r && r.open) {
        if (r.kind === 'shunt') sig.aspect = 'W';
        else {
          const nextClosed = S[r.end.sig].aspect === 'R';
          sig.aspect = r.dev ? (nextClosed ? 'YY' : 'YFY') : nextClosed ? 'Y' : 'G';
        }
      } else sig.aspect = inviteOn(sig, r) ? 'RW' : 'R';
    }
    for (const sig of Object.values(S)) {
      if (sig.kind !== 'entry') continue;
      const r = routeOf[sig.id];
      if (r && r.open) {
        const a2 = S[r.end.sig].aspect;
        const closed = CLOSED.has(a2);
        if (r.dev) sig.aspect = closed ? 'YY' : 'YFY';
        else sig.aspect = closed ? 'Y' : REDUCED.has(a2) ? 'YF' : 'G';
      } else sig.aspect = inviteOn(sig, r) ? 'RW' : 'R';
    }
    for (const id of APPROACH_BLOCKS) S[id].aspect = blockAspect(id);
    for (const sig of Object.values(S)) {
      if (sig.kind !== 'shunt') continue;
      const r = routeOf[sig.id];
      sig.aspect = r && r.open ? 'W' : 'B';
    }
  }

  // Значения показаний — для справки и подсказок.
  IL.ASPECTS = {
    G: 'Один зелёный — разрешается движение с установленной скоростью; следующий светофор открыт',
    YF: 'Один жёлтый мигающий — разрешается движение с установленной скоростью; следующий светофор открыт и требует проследования с уменьшенной скоростью',
    Y: 'Один жёлтый — разрешается движение с готовностью остановиться; следующий светофор закрыт',
    YFY: 'Два жёлтых, верхний мигающий — проследование с уменьшенной скоростью; следующий светофор открыт; поезд отклоняется по стрелочному переводу',
    YY: 'Два жёлтых — проследование с уменьшенной скоростью и готовностью остановиться у следующего светофора; поезд отклоняется по стрелочному переводу',
    R: 'Красный — стой! Запрещается проезжать светофор',
    RW: 'Красный и лунно-белый мигающий (пригласительный) — разрешается проследовать со скоростью не более 20 км/ч с особой бдительностью',
    W: 'Лунно-белый — разрешается производить маневры',
    B: 'Синий — запрещается производить маневры',
  };

  IL.computeAspects = computeAspects;
  RS.IL = IL;
})();
