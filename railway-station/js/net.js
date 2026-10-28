/*
 * Совместная игра через возможность `room` страницы, опубликованной в claude.ai.
 * Ведущий — тот, кто открыл страницу раньше всех: у него идёт модель станции,
 * он рассылает снимки состояния, а остальные показывают их и отправляют ему
 * команды (маршруты, стрелки, управление составами). В локальном файле — одиночная игра.
 */
(function () {
  const RS = window.RS;
  const T = RS.Track;
  const C = RS.Consist;
  const IL = RS.IL;
  const LAY = RS.LAYOUT;

  const Net = {
    mode: 'solo', // solo — своя модель; host — своя модель для всех; client — чужая модель
    room: null,
    user: null,
    since: Date.now(),
    role: 'all', // all | dsp | driver
    hostPeer: null,
    myPeer: null,
    peers: [],
    names: {},
    canSend: true,
    secStates: null,
    routes: [],
    tasks: null, // сводка грузовой работы от ведущего
    next: { odd: '—', even: '—' },
  };
  const SOLO_KEY = 'rs-solo';

  // Порядок объектов одинаков у всех игроков: он задаётся схемой.
  const SEGS = Object.keys(T.segs).sort();
  const SEGI = Object.fromEntries(SEGS.map((s, i) => [s, i + 1]));
  const SIGS = Object.keys(T.signals).sort();
  const SECS = Object.keys(T.sections).sort();
  const GRPS = Object.keys(T.groups).sort();
  const ASP = { R: 'r', G: 'g', Y: 'y', YF: 'f', YY: 'd', YFY: 'e', RW: 'i', W: 'w', B: 'b' };
  const ASP_BACK = Object.fromEntries(Object.entries(ASP).map(([k, v]) => [v, k]));
  const SEC = { free: '.', occ: 'o', 'lk-train': 't', 'lk-train setting': 'T', 'lk-train cancel': 'k',
    'lk-shunt': 's', 'lk-shunt setting': 'S', 'lk-shunt cancel': 'q', 'occ fault': 'x' };
  const SEC_BACK = Object.fromEntries(Object.entries(SEC).map(([k, v]) => [v, k]));
  const PALETTE = ['#4fb3ff', '#ff8a5c', '#7ee081', '#d58bff', '#ffd84d', '#5ce0d0'];
  const enc = new TextEncoder();
  const bytes = (o) => enc.encode(JSON.stringify(o)).length;

  Net.isClient = () => Net.mode === 'client';
  Net.others = () => Net.peers.filter((p) => !(p.isMe && p.sameTab));

  // --- роли ---------------------------------------------------------------------------------
  const ROLE_TITLE = { all: 'ДСП и машинист', dsp: 'ДСП', driver: 'Машинист' };
  Net.roleTitle = (r) => ROLE_TITLE[r] || ROLE_TITLE.all;
  // what: routes — маршруты и стрелки; trains — управление составами; flow — движение и время
  Net.allowed = function (what) {
    if (Net.role === 'all') return true;
    if (Net.role === 'dsp') return what !== 'trains';
    return what === 'trains';
  };
  Net.denyText = (what) => (what === 'trains'
    ? 'Ваша роль — ДСП: составами управляет машинист'
    : 'Ваша роль — машинист: маршруты, стрелки и движение задаёт ДСП');

  // --- кодирование ---------------------------------------------------------------------------
  const chainEnc = (c) => c.chain.map((e) => SEGI[e.seg] * e.dir);
  const chainDec = (a) => a.map((n) => ({ seg: SEGS[Math.abs(n) - 1], dir: Math.sign(n) }));

  // Состояние вагона в грузовой работе: = ждёт подачи, ~ есть задание, ^ под операцией, + готов.
  const ST_MARK = { wait: '=', task: '~', op: '^', ready: '+' };
  const ST_BACK = Object.fromEntries(Object.entries(ST_MARK).map(([k, v]) => [v, k]));

  function vehEnc(list) {
    const out = [];
    let prev = null, n = 0;
    const flush = () => { if (prev) out.push(prev + (n > 1 ? '*' + n : '')); };
    for (const v of list) {
      const tok = v.type + (v.dest === LAY.station ? '!' : '') + (ST_MARK[v.st] || '');
      if (tok === prev) n++;
      else { flush(); prev = tok; n = 1; }
    }
    flush();
    return out.join(',');
  }

  function vehDec(str, cid) {
    const out = [];
    for (const tok of String(str || '').split(',')) {
      const m = /^(.+?)(!?)([=~^+]?)(?:\*(\d+))?$/.exec(tok);
      if (!m || !C.VEH[m[1]]) continue;
      const d = C.VEH[m[1]];
      for (let i = 0, n = Math.min(200, Number(m[4] || 1)); i < n; i++) {
        out.push({ id: cid + ':' + out.length + ':' + m[1], type: m[1], kind: d.kind, len: d.len, loco: !!d.loco, num: '',
          dest: m[2] ? LAY.station : undefined, unit: d.kind === 'emu' ? cid + 'u' : undefined, st: ST_BACK[m[3]] });
      }
    }
    return out;
  }

  function infoOut(c) {
    const i = c.info || {};
    return { num: i.num, cat: i.cat, title: i.title, dir: i.dir, from: i.from, to: i.to, note: i.note || '',
      ofTrain: i.ofTrain || null, planId: i.plan ? i.plan.id : null };
  }

  // --- ведущий: рассылка ------------------------------------------------------------------------
  function emit(topic, data) {
    if (!Net.room || !Net.canSend) return;
    Net.room.emit(topic, data).catch((e) => {
      if (e && e.code === 'not_permitted') {
        Net.canSend = false;
        if (Net.mode !== 'client') Net.room.presence({ host: false }).catch(() => {});
        RS.UI && RS.UI.toast('Нет прав на управление совместной игрой: владелец страницы может дать доступ «Участник» в меню «Поделиться»', 'warn');
      }
    });
  }

  const csSig = {};
  function sendConsist(c) {
    const data = { id: c.id, info: infoOut(c), veh: vehEnc(c.vehicles) };
    if (bytes(data) > 3900) data.info.note = '';
    emit('cs', data);
    csSig[c.id] = vehEnc(c.vehicles) + '|' + JSON.stringify(data.info);
  }

  function stateMsg() {
    const R = RS.Render;
    const sw = GRPS.map((id) => {
      const g = T.groups[id];
      return (g.pos === 'plus' ? 'p' : 'm') + (g.target ? (g.target === 'plus' ? 'p' : 'm') : '-') + ((g.locks.size ? 1 : 0) + (g.damaged ? 2 : 0) + (g.noCtl ? 4 : 0));
    }).join('');
    const msg = {
      t: Math.round(RS.Sim.t * 10) / 10,
      sc: RS.Sim.scale,
      a: SIGS.map((id) => ASP[T.signals[id].aspect] || 'r').join(''),
      s: SECS.map((id) => SEC[R.sectionState(id)] || '.').join(''),
      w: sw,
      c: C.list.map((c) => [c.id, chainEnc(c), Math.round(c.frontOff * 10), Math.round(c.v * 100), c.move || 0,
        c.ctl === 'ai' ? 'a' : 'm', c.setDir || 0, c.setV || 0, c.status || '', Math.round((c.limitV || 0) * 100)]),
    };
    if (bytes(msg) > 3900) for (const row of msg.c) row[8] = '';
    return msg;
  }

  function routesMsg() {
    return IL.routes.map((r) => {
      const [st, cls] = RS.UI.routeState(r);
      return { id: r.id, start: r.start, title: r.title, kind: r.kind, st, cls, closed: r.closed, used: r.used, invite: r.invite,
        busy: r.cancelT > 0 || r.cancelling, sw: Object.entries(r.req).map(([g, p]) => g + (p === 'plus' ? '+' : '−')).join(' ') };
    });
  }

  const SCH_STATIC = ['id', 'num', 'cat', 'dir', 'kind', 'arr', 'dep', 'track', 'reason', 'title', 'from', 'to', 'minStop', 'spawnAt'];
  function sendSchedule(all) {
    const list = RS.Schedule.entries.filter((e) => all || !e.netSent);
    for (let i = 0; i < list.length; i += 10) {
      emit('sch', list.slice(i, i + 10).map((e) => SCH_STATIC.map((k) => e[k])));
    }
    for (const e of list) e.netSent = true;
  }

  const schdSig = {};
  function sendScheduleState(all) {
    const now = RS.Sim.t;
    const rows = [];
    for (const e of RS.Schedule.entries) {
      if (e.arr > now + 2.6 * 3600) continue;
      const st = RS.Schedule.status(e, now);
      const row = [e.id, e.state, e.factArr, e.factDep, e.factTrack, st.text, st.cls];
      const sig = row.join('|');
      if (!all && schdSig[e.id] === sig) continue;
      schdSig[e.id] = sig;
      rows.push(row);
    }
    for (let i = 0; i < rows.length; i += 12) emit('schd', rows.slice(i, i + 12));
  }

  function statMsg() {
    const s = RS.Stats, st = RS.Traffic.settings;
    const next = {};
    for (const k of ['odd', 'even']) {
      const el = document.getElementById(k === 'odd' ? 'nextOdd' : 'nextEven');
      next[k] = el ? el.textContent : '—';
    }
    return { passed: s.passed, arrived: s.arrived, wait: Math.round(s.waitMin * 10) / 10,
      inc: s.incidents.slice(-6), incN: s.incidents.length,
      mode: st.mode, autoRoute: st.autoRoute, minGap: st.minGap, next };
  }

  // Сводка грузовой работы: последние завершённые задания — без пояснений, чтобы уложиться в сообщение.
  function tasksMsg() {
    const v = RS.Tasks.view();
    const ended = v.list.filter((t) => t.state !== 'active').sort((a, b) => b.ended - a.ended).slice(0, 5);
    for (const t of ended) t.text = '';
    v.list = v.list.filter((t) => t.state === 'active').concat(ended);
    if (bytes(v) > 3900) for (const t of v.list) t.text = '';
    return v;
  }

  // Полная картина для подключившегося: составы, маршруты, расписание, задания, журнал.
  function sendFullSync() {
    for (const c of C.list) sendConsist(c);
    emit('rt', routesMsg());
    lastTk = JSON.stringify(tasksMsg());
    emit('tk', JSON.parse(lastTk));
    sendSchedule(true);
    sendScheduleState(true);
    emit('stat', statMsg());
    const logs = RS.Log.items.slice(0, 40).reverse();
    for (let i = 0; i < logs.length; i += 10) emit('lg', { items: logs.slice(i, i + 10) });
  }

  // Журнал ведущего уходит всем.
  Net.onLog = function (item) {
    if (Net.mode === 'host') emit('lg', { items: [item] });
  };

  let tSt = 0, tRt = 0, tSch = 0, tStat = 0, tFull = 0, tTk = 0, lastRt = '', lastTk = '';
  function hostTick(dt) {
    if (!Net.others().length) return;
    tSt += dt; tRt += dt; tSch += dt; tStat += dt; tFull += dt; tTk += dt;
    for (const c of C.list) {
      const sig = vehEnc(c.vehicles) + '|' + JSON.stringify(infoOut(c));
      if (csSig[c.id] !== sig) sendConsist(c);
    }
    if (tSt >= 0.2) { tSt = 0; emit('st', stateMsg()); }
    if (tRt >= 0.5) {
      tRt = 0;
      const r = routesMsg();
      const key = JSON.stringify(r);
      if (key !== lastRt) { lastRt = key; emit('rt', r); }
    }
    if (tSch >= 1) { tSch = 0; sendSchedule(false); sendScheduleState(tFull >= 15); if (tFull >= 15) tFull = 0; }
    if (tStat >= 2) { tStat = 0; emit('stat', statMsg()); }
    if (tTk >= 1) {
      tTk = 0;
      const m = tasksMsg();
      const key = JSON.stringify(m);
      if (key !== lastTk) { lastTk = key; emit('tk', m); }
    }
  }

  // --- ведущий: команды игроков ---------------------------------------------------------------
  function reply(to, cid, res) {
    emit('res', { to, cid, ok: !!res.ok, why: res.why || '', inviteOk: !!res.inviteOk, title: res.title || '' });
  }

  function doCommand(msg) {
    const d = msg.data || {};
    const consist = () => C.list.find((c) => c.id === d.id);
    switch (d.op) {
      case 'route': {
        const c = IL.findRoutes(String(d.start), d.kind === 'shunt' ? 'shunt' : 'train').find((x) => (x.end.sig || x.end.node) === d.key);
        if (!c) return { ok: false, why: 'Такой маршрут задать нельзя' };
        return IL.set(c, { invite: !!d.invite });
      }
      case 'cancelSig': { const r = IL.routeFrom(String(d.sig)); return r ? IL.cancel(r.id) : { ok: false, why: 'От светофора ' + d.sig + ' маршрут не задан' }; }
      case 'cancelSec': { const s = T.sections[d.sec]; return s && s.lock ? IL.cancel(s.lock) : { ok: true }; }
      case 'cancel': return IL.cancel(Number(d.rid));
      case 'reopen': return IL.reopen(Number(d.rid));
      case 'invite': return IL.inviteAgain(String(d.sig));
      case 'switch': return T.groups[d.gid] ? IL.toggleSwitch(String(d.gid)) : { ok: false };
      case 'ctl': {
        const c = consist();
        if (!c) return { ok: false, why: 'Состав уже не на станции' };
        if (d.ctl === 'ai' && c.info && c.info.dir) { c.ctl = 'ai'; c.setDir = 0; }
        if (d.ctl === 'manual') c.ctl = 'manual';
        if (d.setDir !== undefined) c.setDir = Math.max(-1, Math.min(1, Number(d.setDir) || 0));
        if (d.setV !== undefined) c.setV = Math.max(0, Math.min(40, Number(d.setV) || 0));
        return { ok: true };
      }
      case 'split': {
        const c = consist();
        if (!c) return { ok: false };
        if (c.v > 0.05) return { ok: false, why: 'Расцепка только после полной остановки' };
        if (c.ctl === 'ai') { c.ctl = 'manual'; c.setDir = 0; }
        const r = C.split(c, Number(d.k));
        if (!r) return { ok: false, why: 'Здесь расцепить нельзя' };
        RS.Log.add('Расцепка: ' + C.label(c) + ' и ' + C.label(r), 'shunt');
        return { ok: true };
      }
      case 'speed': RS.UI.setSpeed(Math.max(0, Math.min(12, Number(d.k) || 0))); return { ok: true };
      case 'mode': if (['schedule', 'random', 'off'].includes(d.mode)) RS.Traffic.setMode(d.mode); RS.UI.syncFlow(); return { ok: true };
      case 'autoRoute': RS.Traffic.settings.autoRoute = !!d.on; RS.UI.syncFlow(); return { ok: true };
      case 'tasks': RS.Tasks.setOn(!!d.on); RS.UI.syncTasks(); return { ok: true };
      case 'faults': RS.Tasks.setFaults(!!d.on); RS.UI.syncTasks(); return { ok: true };
      case 'gap': { const v = Math.max(3, Math.min(15, Number(d.v) || 5)); RS.Traffic.settings.minGap = Math.max(1, v - 2); RS.Traffic.settings.maxGap = v + 3; RS.UI.syncFlow(); return { ok: true }; }
      case 'spawn': {
        const c = RS.Traffic.spawn(d.dir === 'even' ? 'even' : 'odd', RS.Traffic.TYPES[d.cat] ? d.cat : null);
        return c ? { ok: true } : { ok: false, why: 'Участок приближения занят — поезд появится позже' };
      }
      default: return { ok: false };
    }
  }

  // --- игрок (клиент): приём состояния -----------------------------------------------------------
  const pendingCs = {};
  let needT = 0, needCs = new Set(), needSch = false;

  function makeConsist(id, cs) {
    const vehicles = vehDec(cs.veh, id);
    return { id, vehicles, chain: [], frontOff: 0, rearOff: 0, v: 0, move: 0, ctl: 'ai', setDir: 0, setV: 25,
      info: Object.assign({}, cs.info), ai: null, lastSig: null, status: '', waitT: 0,
      length: vehicles.reduce((s, v) => s + v.len, 0), dirty: true };
  }

  function linkPlan(c) {
    const pid = c.info && c.info.planId;
    c.info.plan = pid ? RS.Schedule.entries.find((e) => e.id === pid) || null : null;
  }

  function onState(d) {
    RS.Sim.t = d.t;
    if (RS.Sim.scale !== d.sc) { RS.Sim.scale = d.sc; RS.UI.syncSpeed(); }
    SIGS.forEach((id, i) => { T.signals[id].aspect = ASP_BACK[d.a[i]] || 'R'; });
    Net.secStates = {};
    SECS.forEach((id, i) => { Net.secStates[id] = SEC_BACK[d.s[i]] || 'free'; });
    GRPS.forEach((id, i) => {
      const g = T.groups[id];
      const p = d.w.slice(i * 3, i * 3 + 3);
      g.pos = p[0] === 'm' ? 'minus' : 'plus';
      g.target = p[1] === '-' ? null : p[1] === 'm' ? 'minus' : 'plus';
      const f = Number(p[2]) || 0;
      g.damaged = !!(f & 2);
      g.noCtl = !!(f & 4);
      g.locks = f & 1 ? new Map([[0, g.pos]]) : new Map();
    });
    const seen = new Set();
    for (const row of d.c) {
      const [id, ch, fo, v, move, ctl, setDir, setV, status, lim] = row;
      seen.add(id);
      let c = C.list.find((x) => x.id === id);
      if (!c) {
        if (!pendingCs[id]) { needCs.add(id); continue; }
        c = makeConsist(id, pendingCs[id]);
        delete pendingCs[id];
        linkPlan(c);
        C.list.push(c);
      }
      c.chain = chainDec(ch);
      c.frontOff = fo / 10;
      c.v = v / 100;
      c.move = move;
      c.ctl = ctl === 'a' ? 'ai' : 'manual';
      c.setDir = setDir;
      c.setV = setV;
      c.status = status;
      c.limitV = lim / 100;
      C.fixRear(c);
      c.dirty = true;
    }
    C.list = C.list.filter((c) => seen.has(c.id));
    if (RS.UI.selected && !seen.has(RS.UI.selected)) RS.UI.selected = null;
  }

  function onConsistInfo(d) {
    const c = C.list.find((x) => x.id === d.id);
    if (!c) { pendingCs[d.id] = d; return; }
    const fresh = makeConsist(d.id, d);
    c.vehicles = fresh.vehicles;
    c.length = fresh.length;
    c.info = fresh.info;
    linkPlan(c);
    C.fixRear(c);
    c.dirty = true;
  }

  function onSchedule(rows) {
    const S = RS.Schedule;
    for (const r of rows) {
      const o = Object.fromEntries(SCH_STATIC.map((k, i) => [k, r[i]]));
      const e = S.entries.find((x) => x.id === o.id);
      if (e) Object.assign(e, o);
      else S.entries.push(Object.assign({ state: 'plan', factArr: null, factDep: null, factTrack: null }, o));
    }
    S.entries.sort((a, b) => a.arr - b.arr);
    for (const c of C.list) linkPlan(c);
  }

  function onScheduleState(rows) {
    for (const [id, state, fa, fd, ft, text, cls] of rows) {
      const e = RS.Schedule.entries.find((x) => x.id === id);
      if (!e) { needSch = true; continue; }
      Object.assign(e, { state, factArr: fa, factDep: fd, factTrack: ft, netStatus: { text, cls } });
    }
  }

  function onStat(d) {
    const s = RS.Stats;
    s.passed = d.passed;
    s.arrived = d.arrived;
    s.waitMin = d.wait;
    s.incidents = d.inc.map((i) => ({ t: i.t, text: i.text }));
    s.incN = d.incN;
    Object.assign(RS.Traffic.settings, { mode: d.mode, autoRoute: d.autoRoute, minGap: d.minGap, maxGap: d.minGap + 5 });
    Net.next = d.next || Net.next;
    RS.UI.syncFlow();
  }

  function onLog(d) {
    for (const it of d.items || []) {
      if (RS.Log.items.some((x) => x.t === it.t && x.text === it.text)) continue;
      RS.Log.items.unshift({ t: it.t, text: it.text, type: it.type });
      if (Date.now() - joinedAt > 4000 && (it.type === 'bad' || it.type === 'warn')) RS.UI.toast(it.text, it.type);
    }
    RS.Log.items.sort((a, b) => b.t - a.t);
    RS.Log.items.length = Math.min(RS.Log.items.length, 200);
    RS.Log.dirty = true;
  }

  // --- игрок: команды ведущему ------------------------------------------------------------------
  const pending = {};
  let cmdN = 0;
  Net.cmd = function (op, args, onResult) {
    if (!Net.room) return;
    const cid = Net.since.toString(36) + '-' + ++cmdN;
    if (onResult) pending[cid] = onResult;
    Net.room.emit('cmd', Object.assign({ op, cid, host: Net.hostPeer }, args || {})).catch((e) => {
      delete pending[cid];
      RS.UI.toast(e && e.code === 'not_permitted'
        ? 'Нет прав на управление: владелец страницы может дать доступ «Участник» в меню «Поделиться»'
        : 'Команда не отправлена: нет связи с ведущим', 'warn');
    });
  };

  function onResult(d) {
    if (d.to !== Net.myPeer) return;
    const fn = pending[d.cid];
    delete pending[d.cid];
    if (fn) fn(d);
    else if (!d.ok && d.why) RS.UI.toast(d.why, 'warn');
  }

  // --- выбор ведущего и переходы ------------------------------------------------------------------
  // Подключившись, страница сначала ждёт: если ведущий уже есть, она присоединяется к нему.
  // Ведущим заявляется только при пустой комнате; если заявились двое сразу, ведёт тот,
  // кто подключился раньше.
  let joinedAt = 0;
  let claimed = false;
  function claim() {
    if (Net.mode !== 'solo' && Net.mode !== 'host') return;
    claimed = true;
    Net.since = Date.now();
    Net.room.presence({ host: true, since: Net.since }).catch(() => {});
    Net.mode = Net.others().length ? 'host' : 'solo';
    RS.UI.renderNet();
  }
  function leaderOf(peers) {
    const c = peers.filter((p) => p.presence && p.presence.host === true && typeof p.presence.since === 'number');
    c.sort((a, b) => a.presence.since - b.presence.since || (a.peer < b.peer ? -1 : 1));
    return c[0] || null;
  }

  function becomeClient(peer) {
    Net.mode = 'client';
    Net.hostPeer = peer;
    joinedAt = Date.now();
    Net.room.presence({ host: false }).catch(() => {});
    // своя модель больше не нужна: всё приходит от ведущего
    C.list = [];
    IL.routes = [];
    for (const s of Object.values(T.sections)) { s.lock = null; s.occupied = false; }
    for (const g of Object.values(T.groups)) { g.locks = new Map(); g.target = null; }
    RS.Log.items = [];
    RS.Log.dirty = true;
    RS.Schedule.entries = [];
    RS.UI.selected = null;
    RS.UI.resetSelection();
    RS.Log.add('Подключение к совместной игре: модель станции ведёт ' + Net.nameOf(peer), 'info');
    sayHello();
    RS.UI.renderNet();
  }

  // Подключившийся просит полную картину; если ответ потерялся — просит снова.
  let helloT = 0;
  function sayHello() {
    helloT = 0;
    Net.room.emit('hello', {}).catch(() => {});
  }

  function hostGone() {
    Net.mode = 'gone';
    RS.UI.ask('Ведущий вышел из игры', 'Модель станции шла у другого игрока, и он закрыл страницу. Можно начать свою смену: если кто-то ещё здесь, он подключится к вам.',
      'Начать заново', () => location.reload());
  }

  function onPeers(change) {
    Net.peers = change.peers;
    const me = change.peers.find((p) => p.isMe && p.sameTab);
    if (me) Net.myPeer = me.peer;
    const ids = change.peers.map((p) => p.by).filter(Boolean);
    if (Net.user && ids.length) {
      Net.user.profiles(ids).then((ps) => {
        for (const [id, p] of Object.entries(ps)) Net.names[id] = p;
        RS.UI.renderNet();
      });
    }
    if (Net.mode === 'client') {
      if (!change.peers.some((p) => p.peer === Net.hostPeer)) hostGone();
    } else if (Net.mode === 'solo' || Net.mode === 'host') {
      const leader = leaderOf(change.peers);
      if (leader && !(leader.isMe && leader.sameTab)) becomeClient(leader.peer);
      else {
        Net.mode = claimed && Net.others().length ? 'host' : 'solo';
      }
    }
    RS.UI.renderNet();
  }

  Net.nameOf = function (peerLabel) {
    const p = Net.peers.find((x) => x.peer === peerLabel);
    if (!p) return 'другой игрок';
    if (p.isMe && p.sameTab) return 'вы';
    const prof = p.by && Net.names[p.by];
    if (prof && prof.name) return prof.name;
    return (p.presence && p.presence.nick) || 'Игрок ' + (Net.peers.indexOf(p) + 1);
  };
  Net.colorOf = function (p) {
    const prof = p.by && Net.names[p.by];
    if (prof && prof.color) return prof.color;
    let h = 0;
    for (const ch of p.peer) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };

  Net.setRole = function (role) {
    Net.role = ROLE_TITLE[role] ? role : 'all';
    if (Net.room) Net.room.presence({ role: Net.role }).catch(() => {});
    RS.UI.renderNet();
  };

  // Курсор игрока на табло — в координатах схемы.
  let curT = 0;
  Net.cursor = function (x, y) {
    if (!Net.room || Date.now() - curT < 90) return;
    curT = Date.now();
    Net.room.presence({ cur: x === null ? null : [Math.round(x), Math.round(y)] }).catch(() => {});
  };

  Net.leave = function () {
    try { sessionStorage.setItem(SOLO_KEY, '1'); } catch (e) { /* без хранилища — просто перезагрузка */ }
    location.reload();
  };
  Net.rejoin = function () {
    try { sessionStorage.removeItem(SOLO_KEY); } catch (e) { /* то же */ }
    location.reload();
  };
  Net.optedOut = function () {
    try { return sessionStorage.getItem(SOLO_KEY) === '1'; } catch (e) { return false; }
  };

  // --- такт ----------------------------------------------------------------------------------------
  // Между снимками ведущего составы у игрока продолжают ехать сами — без рывков.
  Net.tick = function (realDt) {
    if (Net.mode === 'host') hostTick(realDt);
    if (Net.mode !== 'client') return;
    const dt = realDt * RS.Sim.scale;
    RS.Sim.t += dt;
    C.ghost = true;
    for (const c of C.list) if (c.v > 0.05 && c.move) C.moveBy(c, c.v * dt * c.move);
    C.ghost = false;
    helloT += realDt;
    if (helloT > 4 && !RS.Schedule.entries.length) sayHello();
    needT += realDt;
    if (needT > 1 && (needCs.size || needSch)) {
      Net.room.emit('need', { cs: [...needCs].slice(0, 20), sch: needSch }).catch(() => {});
      needCs = new Set();
      needSch = false;
      needT = 0;
    }
  };

  Net.init = async function () {
    if (!window.claude || typeof window.claude.use !== 'function' || Net.optedOut()) { RS.UI.renderNet(); return; }
    const room = await window.claude.use('room');
    if (!room) { RS.UI.renderNet(); return; }
    Net.room = room;
    Net.user = await window.claude.use('user');
    const fromHost = (fn) => (m) => { if (Net.mode === 'client' && m.peer === Net.hostPeer) fn(m.data); };
    room.on('st', fromHost(onState));
    room.on('cs', fromHost(onConsistInfo));
    room.on('sch', fromHost(onSchedule));
    room.on('schd', fromHost(onScheduleState));
    room.on('stat', fromHost(onStat));
    room.on('lg', fromHost(onLog));
    room.on('rt', fromHost((d) => { Net.routes = Array.isArray(d) ? d : []; }));
    room.on('tk', fromHost((d) => { if (d && Array.isArray(d.list)) { Net.tasks = d; RS.UI.syncTasks(); } }));
    room.on('res', fromHost(onResult));
    room.on('hello', (m) => { if (Net.mode === 'host' && !m.isMe) sendFullSync(); });
    room.on('need', (m) => {
      if (Net.mode !== 'host' || m.isMe) return;
      const d = m.data || {};
      for (const id of d.cs || []) { const c = C.list.find((x) => x.id === id); if (c) sendConsist(c); }
      if (d.sch) sendSchedule(true);
    });
    room.on('cmd', (m) => {
      if (Net.mode !== 'host' || !m.data || (m.data.host && m.data.host !== Net.myPeer)) return;
      let res;
      try { res = doCommand(m) || { ok: true }; } catch (e) { res = { ok: false, why: 'Команда не выполнена' }; }
      reply(m.peer, m.data.cid, res);
    });
    room.onPeers(onPeers);
    room.presence({ host: false, role: Net.role }).catch(() => {});
    setTimeout(claim, 2000);
    RS.UI.renderNet();
  };

  RS.Net = Net;
})();
