/*
 * Интерфейс АРМ ДСП: режимы набора маршрутов, работа с табло,
 * управление составами, списки маршрутов, журнал, генерация поездов.
 */
(function () {
  const RS = window.RS;
  const T = RS.Track;
  const C = RS.Consist;
  const IL = RS.IL;
  const R = RS.Render;
  const LAY = RS.LAYOUT;
  const $ = (s) => document.querySelector(s);

  // Совместная игра: у подключившегося игрока действия уходят ведущему командами,
  // а роль (ДСП или машинист) ограничивает, какие органы управления ему доступны.
  const remote = () => !!(RS.Net && RS.Net.isClient());
  function allowed(what) {
    if (!RS.Net || RS.Net.allowed(what)) return true;
    UI.toast(RS.Net.denyText(what), 'info');
    return false;
  }
  const routeFromAny = (sig) => (remote() ? RS.Net.routes.find((r) => r.start === sig) || null : IL.routeFrom(sig));

  const UI = { mode: 'train', start: null, cands: [], selected: null, tab: 'trains' };

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : String(k));
    return e;
  }

  const HINTS = {
    train: 'Поездной маршрут: нажмите входной или выходной светофор, затем путь приёма (или светофор в конце маршрута).',
    shunt: 'Маневровый маршрут: нажмите выходной или маневровый светофор (М1, М2, М4), затем путь назначения.',
    cancel: 'Отмена: нажмите светофор начала маршрута или замкнутую (зелёную/белую) секцию.',
    switch: 'Перевод стрелок: нажмите номер стрелки. Замкнутые в маршруте и занятые стрелки не переводятся.',
    invite: 'Пригласительный сигнал: нажмите входной/выходной светофор и путь — маршрут замкнётся, светофор покажет красный и лунно-белый мигающий.',
  };

  // --- уведомления и окна ------------------------------------------------------------
  UI.toast = function (text, type) {
    const box = $('#toasts');
    if (!box) return;
    const t = h('div', { class: 'toast ' + (type || 'info'), role: 'status' }, text);
    box.prepend(t);
    while (box.children.length > 4) box.lastChild.remove();
    setTimeout(() => t.classList.add('out'), 4200);
    setTimeout(() => t.remove(), 4800);
  };

  UI.ask = function (title, text, okLabel, onOk) {
    const m = $('#modal');
    m.innerHTML = '';
    const close = () => { m.hidden = true; };
    m.append(h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true' },
      h('h3', {}, title), h('p', {}, text),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: close }, 'Отмена'),
        h('button', { class: 'btn primary', onclick: () => { close(); onOk(); } }, okLabel))));
    m.hidden = false;
  };

  // --- режимы и набор маршрутов ------------------------------------------------------
  function setMode(m) {
    UI.mode = m;
    resetSel();
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    $('#hint').textContent = HINTS[m];
  }

  function resetSel() {
    UI.start = null;
    UI.cands = [];
    R.highlight(null);
  }

  function trySet(c, invite) {
    if (!allowed('routes')) return;
    if (remote()) {
      resetSel();
      $('#hint').textContent = HINTS[UI.mode];
      RS.Net.cmd('route', { start: c.start, kind: c.kind, key: c.end.sig || c.end.node, invite: !!invite }, (res) => routeResult(c, res));
      return;
    }
    routeResult(c, IL.set(c, { invite }));
  }

  function routeResult(c, res) {
    if (res.ok) {
      resetSel();
      $('#hint').textContent = HINTS[UI.mode];
      return;
    }
    if (res.inviteOk) {
      resetSel();
      UI.ask(res.title || 'Путь ' + T.trackName(c.dest) + ' занят', res.why + ' Замкнуть маршрут ' + IL.title(c) + ' и включить пригласительный сигнал? Машинист проследует светофор со скоростью не более 20 км/ч и остановится перед подвижным составом.',
        'Включить ПС', () => trySet(c, true));
      return;
    }
    UI.toast(res.why, 'warn');
  }

  function clickSignal(id) {
    const sig = T.signals[id];
    const m = UI.mode;
    if (m === 'switch') return;
    if (!allowed('routes')) return;
    if (m === 'cancel') {
      const r = routeFromAny(id);
      if (!r) return UI.toast('От светофора ' + id + ' маршрут не задан', 'info');
      if (remote()) return RS.Net.cmd('cancelSig', { sig: id });
      const res = IL.cancel(r.id);
      if (!res.ok && res.why) UI.toast(res.why, 'warn');
      return;
    }
    // выбор конечного светофора
    if (UI.start && UI.start !== id) {
      const c = UI.cands.find((x) => x.end.sig === id);
      if (c) return trySet(c, m === 'invite');
    }
    const kind = m === 'shunt' ? 'shunt' : 'train';
    if (m === 'invite' && sig.kind !== 'entry' && sig.kind !== 'exit') return UI.toast('Пригласительный сигнал есть только на входных и выходных светофорах', 'info');
    if (kind === 'train' && !sig.train) return UI.toast('Светофор ' + id + ' не открывается поездным показанием. Для маневров выберите «Маневровый маршрут».', 'info');
    if (kind === 'shunt' && !sig.shunt) return UI.toast('Светофор ' + id + ' не имеет маневрового показания', 'info');
    const ex = routeFromAny(id);
    if (ex && m === 'invite' && ex.invite) {
      const told = (r) => UI.toast(r.ok ? 'Пригласительный сигнал на ' + id + ' включён повторно' : r.why, r.ok ? 'info' : 'warn');
      if (remote()) return RS.Net.cmd('invite', { sig: id }, told);
      return told(IL.inviteAgain(id));
    }
    if (ex) return UI.toast('От светофора ' + id + ' уже задан маршрут ' + ex.title + '. Сначала отмените его.', 'info');
    const cands = IL.findRoutes(id, kind);
    if (!cands.length) return UI.toast('От светофора ' + id + ' нет возможных ' + (kind === 'train' ? 'поездных' : 'маневровых') + ' маршрутов', 'info');
    if (cands.length === 1 && !(m === 'invite')) return trySet(cands[0], false);
    UI.start = id;
    UI.cands = cands;
    R.highlight(id, cands);
    $('#hint').textContent = 'Начало: ' + id + '. Выберите конец маршрута — подсвеченный путь или светофор (Esc — сброс).';
  }

  function clickSegment(segId) {
    const sec = T.segs[segId].sec;
    if (UI.mode === 'cancel') {
      if (!allowed('routes')) return;
      if (remote()) return RS.Net.cmd('cancelSec', { sec });
      const s = T.sections[sec];
      if (s.lock) {
        const res = IL.cancel(s.lock);
        if (!res.ok && res.why) UI.toast(res.why, 'warn');
      }
      return;
    }
    if (UI.start) {
      const c = UI.cands.find((x) => x.dest === sec);
      if (c) return trySet(c, UI.mode === 'invite');
      resetSel();
      $('#hint').textContent = HINTS[UI.mode];
    }
  }

  function clickSwitch(gid) {
    if (UI.start || !allowed('routes')) return;
    if (remote()) return RS.Net.cmd('switch', { gid });
    const res = IL.toggleSwitch(gid);
    if (!res.ok) UI.toast(res.why, 'warn');
  }

  // --- табло: клики, панорама, масштаб --------------------------------------------------
  function bindBoard() {
    const svg = $('#map');
    const ptrs = new Map();
    let moved = 0, pinch = 0;
    svg.addEventListener('pointerdown', (e) => {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0;
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (RS.Net && RS.Net.room) {
        const w = R.toWorld(e.clientX, e.clientY);
        RS.Net.cursor(w.x, w.y);
      }
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      if (ptrs.size === 2) {
        p.x = e.clientX; p.y = e.clientY;
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) R.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch / d);
        pinch = d;
        moved = 99;
        return;
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 5) {
        svg.setPointerCapture && !svg.hasPointerCapture(e.pointerId) && svg.setPointerCapture(e.pointerId);
        svg.classList.add('panning');
        R.panBy(dx, dy);
      }
      p.x = e.clientX; p.y = e.clientY;
    });
    const end = (e) => {
      const wasClick = moved <= 5 && ptrs.size === 1;
      ptrs.delete(e.pointerId);
      svg.classList.remove('panning');
      if (wasClick && e.type === 'pointerup') boardClick(e);
      if (ptrs.size < 2) pinch = 0;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', () => { if (RS.Net && RS.Net.room) RS.Net.cursor(null); });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      R.zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * 0.0015));
    }, { passive: false });
    svg.addEventListener('contextmenu', (e) => {
      const t = e.target.closest('[data-sig]');
      if (!t) return;
      e.preventDefault();
      if (!allowed('routes')) return;
      if (remote()) return RS.Net.cmd('cancelSig', { sig: t.dataset.sig });
      const r = IL.routeFrom(t.dataset.sig);
      if (r) IL.cancel(r.id);
    });
    $('#zoomIn').onclick = () => { const b = svg.getBoundingClientRect(); R.zoomAt(b.left + b.width / 2, b.top + b.height / 2, 0.8); };
    $('#zoomOut').onclick = () => { const b = svg.getBoundingClientRect(); R.zoomAt(b.left + b.width / 2, b.top + b.height / 2, 1.25); };
    $('#zoomFit').onclick = () => R.fit();
  }

  function boardClick(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const t = el && el.closest('[data-sig],[data-sw],[data-c],[data-seg]');
    if (!t) {
      if (UI.start) { resetSel(); $('#hint').textContent = HINTS[UI.mode]; }
      return;
    }
    if (t.dataset.sig) return clickSignal(t.dataset.sig);
    if (t.dataset.sw) return clickSwitch(t.dataset.sw);
    if (t.dataset.c) {
      if (UI.start) {
        const c = C.list.find((x) => x.id === t.dataset.c);
        const sec = c && C.sectionsOf(c).find((s) => UI.cands.some((x) => x.dest === s));
        if (sec) return clickSegment(T.sections[sec].segs[0]);
      }
      select(t.dataset.c);
      return;
    }
    if (t.dataset.seg) return clickSegment(t.dataset.seg);
  }

  // --- составы --------------------------------------------------------------------------
  function select(id) {
    UI.selected = id;
    UI.tab = 'trains';
    showTab('trains');
    renderTrainCard(true);
  }
  UI.select = select;

  const CAT_CHIP = {
    pass: ['Пасс', 'c-pass'], subur: ['Приг', 'c-subur'], freight: ['Груз', 'c-freight'], local: ['Сборн', 'c-local'],
    light: ['Лок', 'c-light'], shunt: ['Манёвр', 'c-shunt'], cut: ['Отцеп', 'c-cut'], pickup: ['Вывоз', 'c-local'],
  };

  function where(c) {
    return C.sectionsOf(c).map((s) => (LAY.tracks[s] ? 'путь ' + LAY.tracks[s].name : s)).join(', ');
  }

  function takeControl(c) {
    if (!allowed('trains')) return;
    const sd = C.screenDir(c);
    c.ctl = 'manual';
    c.setDir = c.v > 0.05 ? sd * c.move : 0;
    c.setV = Math.min(40, Math.max(5, Math.round(c.v * 3.6)));
    if (remote()) RS.Net.cmd('ctl', { id: c.id, ctl: 'manual', setDir: c.setDir, setV: c.setV });
    renderTrainCard(true);
  }

  function setDir(c, d) {
    if (!allowed('trains')) return;
    c.setDir = d;
    if (remote()) RS.Net.cmd('ctl', { id: c.id, setDir: d });
    renderTrainCard();
  }

  let vTimer = null;
  function setV(c, v) {
    c.setV = v;
    if (!remote()) return;
    clearTimeout(vTimer);
    vTimer = setTimeout(() => RS.Net.cmd('ctl', { id: c.id, setV: v }), 150);
  }

  function returnAi(c) {
    if (!allowed('trains')) return;
    c.ctl = 'ai';
    c.setDir = 0;
    if (remote()) RS.Net.cmd('ctl', { id: c.id, ctl: 'ai' });
    renderTrainCard(true);
  }

  function renderTrainCard(force) {
    const box = $('#trainCard');
    const c = C.list.find((x) => x.id === UI.selected);
    if (!c) {
      if (box.dataset.id) { box.innerHTML = ''; box.dataset.id = ''; }
      if (!box.firstChild) box.append(h('p', { class: 'muted small' }, 'Нажмите на состав на табло или в списке, чтобы управлять им: локомотив можно вести вручную, расцеплять и сцеплять вагоны.'));
      return;
    }
    const sig = c.id + '|' + c.ctl + '|' + c.vehicles.length + '|' + (c.info && c.info.cat) + '|' + c.vehicles.map((v) => v.st || '').join('');
    if (force || box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.dataset.id = c.id;
      box.innerHTML = '';
      buildTrainCard(box, c);
    }
    // живые значения
    const v = Math.round(c.v * 3.6);
    const lim = c.limitV !== undefined ? Math.round(c.limitV * 3.6) : 0;
    const q = (s) => box.querySelector(s);
    if (q('.tc-speed')) q('.tc-speed').textContent = v;
    if (q('.tc-limit')) q('.tc-limit').textContent = C.hasLoco(c) ? 'допустимая ' + lim + ' км/ч' : '';
    if (q('.tc-status')) q('.tc-status').textContent = c.status || '';
    if (q('.tc-where')) q('.tc-where').textContent = where(c);
    const pl = q('.tc-plan-live');
    if (pl && c.info.plan) {
      const st = RS.Schedule.status(c.info.plan, RS.Sim.t);
      if (pl.textContent !== st.text) pl.textContent = st.text;
      pl.className = 'tc-plan-live small s-' + st.cls;
    }
    box.querySelectorAll('[data-dir]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.dir) === c.setDir)));
    box.querySelectorAll('.gapbtn').forEach((b) => (b.disabled = c.v > 0.05));
  }

  function buildTrainCard(box, c) {
    const info = c.info || {};
    const chip = CAT_CHIP[info.cat] || ['', ''];
    const title = info.cat === 'cut' ? 'Отцеп, ' + C.carCount(c) + ' ваг.' : info.cat === 'shunt' ? info.num : info.cat === 'light' ? 'Локомотив ' + info.num : 'Поезд №' + info.num;
    box.append(h('div', { class: 'tc-head' },
      h('span', { class: 'chip ' + chip[1] }, chip[0]),
      h('h3', {}, title),
      h('button', { class: 'btn ghost sm', title: 'Показать на схеме', onclick: () => { const p = C.frontPoint(c); R.centerOn(p[0], p[1]); } }, 'На схеме')));
    const meta = [];
    if (info.title && info.cat !== 'cut') meta.push(info.title);
    if (info.from && info.to) meta.push(info.from + ' → ' + info.to);
    meta.push(c.vehicles.length + ' ед., ' + Math.round(c.length) + ' м');
    box.append(h('p', { class: 'muted small' }, meta.join(' · ')));
    if (info.plan) {
      const p = info.plan;
      const H = RS.Schedule.hm;
      const line = p.kind === 'pass'
        ? 'Проследование в ' + H(p.arr) + ' по пути ' + T.trackName(p.track) + ', без остановки'
        : 'Прибытие ' + H(p.arr) + ', отправление ' + H(p.dep) + ', путь ' + T.trackName(p.track) + ' — ' + p.reason;
      box.append(h('div', { class: 'plan' }, h('span', { class: 'plan-cap' }, 'По графику'), h('div', {}, line), h('div', { class: 'tc-plan-live small' }, '')));
    }
    if (info.note) box.append(h('p', { class: 'note' }, info.note));
    if (info.ofTrain) box.append(h('p', { class: 'muted small' }, 'Из состава поезда №' + info.ofTrain));
    box.append(h('div', { class: 'tc-row' },
      h('div', { class: 'gauge' }, h('span', { class: 'tc-speed' }, '0'), h('small', {}, 'км/ч')),
      h('div', { class: 'tc-info' }, h('div', { class: 'tc-where' }, ''), h('div', { class: 'tc-status' }, ''), h('div', { class: 'tc-limit muted small' }, ''))));

    if (C.hasLoco(c)) {
      if (c.ctl === 'ai') {
        box.append(h('div', { class: 'tc-ctl' },
          h('p', { class: 'small' }, 'Автоведение: машинист следует по сигналам, делает плановые остановки и отправляется не раньше времени по графику, когда открыт выходной.'),
          h('button', { class: 'btn primary', onclick: () => takeControl(c) }, 'Взять управление')));
      } else {
        const rng = h('input', { type: 'range', min: 0, max: 40, step: 1, value: c.setV, id: 'spd-' + c.id, 'aria-label': 'Заданная скорость' });
        const out = h('output', { for: 'spd-' + c.id }, c.setV + ' км/ч');
        rng.oninput = () => {
          if (!allowed('trains')) { rng.value = c.setV; return; }
          out.textContent = rng.value + ' км/ч';
          setV(c, Number(rng.value));
        };
        const dirBtn = (d, label, tip) => h('button', { class: 'btn dir', 'data-dir': d, title: tip, onclick: () => setDir(c, d) }, label);
        box.append(h('div', { class: 'tc-ctl' },
          h('div', { class: 'dirs', role: 'group', 'aria-label': 'Направление' }, dirBtn(-1, '◀ Влево', 'Движение влево по схеме'), dirBtn(0, '■ Стоп', 'Остановиться'), dirBtn(1, 'Вправо ▶', 'Движение вправо по схеме')),
          h('label', { class: 'spd', for: 'spd-' + c.id }, 'Скорость', rng, out),
          h('p', { class: 'muted small' }, 'Защита КЛУБ-У остановит состав перед запрещающим сигналом, упором, границей станции и неготовой стрелкой. Сцепление — автоматически при подъезде.'),
          info.dir && !['cut', 'shunt', 'light'].includes(info.cat)
            ? h('button', { class: 'btn ghost', onclick: () => returnAi(c) }, 'Вернуть автоведение')
            : null));
      }
    }
    // состав: схема вагонов, разрезы между ними — кнопки расцепки
    const sd = C.screenDir(c);
    const order = c.vehicles.map((v, i) => i);
    if (sd < 0) order.reverse();
    const strip = h('div', { class: 'strip', role: 'list', 'aria-label': 'Состав' });
    order.forEach((i, j) => {
      if (j > 0) {
        const k = sd > 0 ? i : i + 1;
        const ok = C.canSplit(c, k);
        strip.append(h('button', {
          class: 'gapbtn', disabled: !ok || c.v > 0.05, title: ok ? 'Расцепить здесь' : 'Неразъёмное соединение секций',
          'aria-label': 'Расцепить между ' + (j) + ' и ' + (j + 1) + ' единицей',
          onclick: () => doSplit(c, k),
        }));
      }
      const v = c.vehicles[i];
      const title = (v.loco ? v.type : (C.VEH[v.type].title || v.type)) + (v.num ? ' №' + v.num : '') +
        (ST_TITLE[v.st] || (v.dest === LAY.station ? ' — назначением на ст. ' + LAY.station : ''));
      strip.append(h('span', { class: vbClass(v), role: 'listitem', title, style: 'flex-grow:' + v.len }));
    });
    box.append(h('div', { class: 'strip-wrap' }, h('div', { class: 'strip-cap muted small' }, sd > 0 ? '← хвост · голова →' : '← голова · хвост →'), strip));
    box.append(h('p', { class: 'muted small' }, 'Нажмите на промежуток между вагонами, чтобы расцепить (только на стоянке).'));
  }

  // Вагоны станции в грузовой работе: обводка как на табло.
  const ST_TITLE = { wait: ' — ждёт подачи на грузовой фронт', task: ' — по нему есть маневровое задание', op: ' — под грузовой операцией', ready: ' — готов к отправке' };
  const vbClass = (v) => 'vb v-' + v.kind + (v.st === 'op' ? ' op' : v.st === 'ready' ? ' ready'
    : v.dest === LAY.station || v.st === 'wait' || v.st === 'task' ? ' dest' : '');

  function doSplit(c, k) {
    if (!allowed('trains')) return;
    if (c.v > 0.05) return UI.toast('Расцепка только после полной остановки', 'warn');
    if (remote()) return RS.Net.cmd('split', { id: c.id, k });
    if (c.ctl === 'ai') { c.ctl = 'manual'; c.setDir = 0; }
    const r = C.split(c, k);
    if (!r) return UI.toast('Здесь расцепить нельзя', 'warn');
    const loc = [c, r].find((x) => x.info.cat === 'shunt') || (C.hasLoco(c) ? c : C.hasLoco(r) ? r : c);
    RS.Log.add('Расцепка: ' + C.label(c) + ' и ' + C.label(r), 'shunt');
    UI.selected = loc.id;
    renderTrainCard(true);
  }

  function consistName(c) {
    const info = c.info || {};
    return info.cat === 'cut' ? C.carCount(c) + ' ваг.' : info.cat === 'shunt' || info.cat === 'light' ? info.num : '№' + info.num;
  }

  function renderTrainList() {
    const ul = $('#trainList');
    const items = C.list.slice().sort((a, b) => (a.info.cat === 'cut') - (b.info.cat === 'cut'));
    const key = items.map((c) => c.id + ':' + c.info.cat).join(',') + '|' + UI.selected;
    if (ul.dataset.key !== key) {
      ul.dataset.key = key;
      ul.innerHTML = '';
      for (const c of items) {
        const chip = CAT_CHIP[c.info.cat] || ['', ''];
        ul.append(h('li', { 'data-id': c.id },
          h('button', { class: 'trow' + (UI.selected === c.id ? ' on' : ''), onclick: () => select(c.id) },
            h('span', { class: 'chip ' + chip[1] }, chip[0]),
            h('span', { class: 'tname' }, ''), h('span', { class: 'twhere' }, ''),
            h('span', { class: 'tspd' }, ''), h('span', { class: 'tstat' }, ''))));
      }
    }
    for (const li of ul.children) {
      const c = C.list.find((x) => x.id === li.dataset.id);
      if (!c) continue;
      const set = (cls, v) => { const e = li.querySelector(cls); if (e.textContent !== v) e.textContent = v; };
      set('.tname', consistName(c));
      set('.twhere', where(c));
      set('.tspd', C.hasLoco(c) ? Math.round(c.v * 3.6) + ' км/ч' : '');
      set('.tstat', c.ctl === 'ai' ? c.status || '' : C.hasLoco(c) ? 'ручное · ' + (c.status || '') : 'закреплён');
    }
  }

  // Поезда на участках приближения — плашки по краям табло.
  function renderApproach() {
    const items = { odd: [], even: [] };
    for (const c of C.list) {
      const info = c.info || {};
      if (!info.dir) continue;
      const appr = LAY.spawns[info.dir].approach;
      if (!C.sectionsOf(c).some((s) => appr.includes(s))) continue;
      const d = RS.Traffic.distToEntry(c);
      if (d !== null) items[info.dir].push({ c, d });
    }
    for (const k of ['odd', 'even']) {
      const box = $(k === 'odd' ? '#apLeft' : '#apRight');
      const entry = LAY.spawns[k].entry;
      items[k].sort((a, b) => a.d - b.d);
      const key = items[k].map((i) => i.c.id + ':' + Math.round(i.d / 100) + ':' + Math.round(i.c.v * 3.6)).join('|') + ':' + Math.floor(RS.Sim.t / 60);
      if (box.dataset.key === key) continue;
      box.dataset.key = key;
      box.innerHTML = '';
      // три ближайших к станции поезда; остальные видны на перегоне
      for (const { c, d } of items[k].slice(0, 3)) {
        const st = c.v < 0.05;
        const m = /Закрыт светофор (\S+)/.exec(c.status || '');
        const held = m && m[1] !== entry ? 'стоит у светофора ' + m[1] : 'стоит у входного ' + entry;
        box.append(h('button', { class: 'ap-chip' + (st ? ' stopped' : ''), title: 'Открыть карточку поезда', onclick: () => select(c.id) },
          h('b', {}, '№' + c.info.num), h('span', { class: 'ap-d' }, (d / 1000).toFixed(1).replace('.', ',') + ' км до ' + entry),
          h('span', { class: 'ap-s' }, c.info.title + ', ' + Math.round(c.length) + ' м · ' + (st ? held : Math.round(c.v * 3.6) + ' км/ч')),
          c.info.plan ? h('span', { class: 'ap-s ap-plan' }, planChip(c.info.plan)) : null));
      }
      if (items[k].length > 3) box.append(h('span', { class: 'ap-more' }, 'и ещё ' + (items[k].length - 3) + ' на перегоне'));
    }
  }

  function planChip(p) {
    const H = RS.Schedule.hm;
    const late = RS.Schedule.deviation(p, RS.Sim.t);
    return (p.kind === 'pass' ? 'проследование ' + H(p.arr) : 'прибытие ' + H(p.arr) + ', стоянка') +
      ' · путь ' + T.trackName(p.track) + (late > 0 ? ' · опаздывает +' + late + ' мин' : '');
  }

  // --- расписание --------------------------------------------------------------------------------
  function renderSchedule() {
    const S = RS.Schedule;
    const now = RS.Sim.t;
    const H = S.hm;
    const sum = S.summary();
    const sumEl = $('#schedSum');
    const sumTxt = sum.done
      ? 'Выполнено ' + sum.done + ' поездов, по графику ' + sum.onTime + ', сумма опозданий ' + sum.late + ' мин'
      : 'Смена началась: выполненных поездов пока нет';
    if (sumEl.textContent !== sumTxt) sumEl.textContent = sumTxt;
    const all = $('#schedDone').checked;
    const list = S.entries.filter((e) => e.state !== 'cancelled' && e.arr < now + 2.5 * 3600 &&
      (all || e.state !== 'gone' || e.factDep > now - 12 * 60));
    const ul = $('#schedList');
    const key = list.map((e) => e.id + ':' + e.state).join(',');
    if (ul.dataset.key !== key) {
      ul.dataset.key = key;
      ul.innerHTML = '';
      for (const e of list) {
        const chip = CAT_CHIP[e.cat] || ['', ''];
        const stop = e.kind === 'stop';
        const mins = Math.round((e.dep - e.arr) / 60);
        ul.append(h('li', { 'data-id': e.id },
          h('button', { class: 'srow' + (e.state === 'gone' ? ' done' : '') + (e.state === 'approach' || e.state === 'station' ? ' active' : ''), onclick: () => openPlan(e) },
            h('span', { class: 's-time' }, h('b', {}, H(e.arr)), h('small', { title: stop ? 'отправление' : 'без остановки' }, stop ? H(e.dep) : '—')),
            h('span', { class: 's-main' },
              h('span', { class: 's-title' }, h('span', { class: 'chip ' + chip[1] }, chip[0]), h('b', {}, '№' + e.num),
                h('span', { class: 'muted' }, e.from + ' → ' + e.to)),
              h('span', { class: 's-desc' }, (stop ? 'стоянка ' + mins + ' мин · ' : 'проследование · ') + 'путь ' + T.trackName(e.track) +
                (stop ? ' · ' + e.reason : '') + (e.title === 'Скорый' ? ' · скорый' : '')),
              h('span', { class: 's-fact' }, ''),
              h('span', { class: 's-state' }, '')))));
      }
    }
    for (const li of ul.children) {
      const e = S.entries.find((x) => x.id === li.dataset.id);
      if (!e) continue;
      const st = S.status(e, now);
      const se = li.querySelector('.s-state');
      if (se.textContent !== st.text) se.textContent = st.text;
      se.className = 's-state s-' + st.cls;
      const fact = [];
      if (e.factArr && e.kind === 'stop') fact.push('прибыл ' + H(e.factArr) + ' · ' + S.devText(Math.trunc((e.factArr - e.arr) / 60)));
      if (e.factTrack && e.factTrack !== e.track) fact.push('путь ' + T.trackName(e.factTrack) + ' — не по плану');
      const fe = li.querySelector('.s-fact');
      const ft = fact.join(' · ');
      if (fe.textContent !== ft) fe.textContent = ft;
      fe.hidden = !ft;
    }
  }

  function openPlan(e) {
    const c = RS.Schedule.consistOf(e);
    if (c) return select(c.id);
    if (e.state === 'plan') return UI.toast('Поезд №' + e.num + ' ещё не вышел на участок приближения: по графику он появится на подходе около ' + RS.Schedule.hm(e.spawnAt), 'info');
    UI.toast('Поезд №' + e.num + ' уже за пределами станции', 'info');
  }

  // --- грузовая работа: задания, фронты, отказы -----------------------------------------------
  const TASK_KIND = { deliver: 'Подача', remove: 'Уборка', attach: 'Прицепка' };
  // У ведущего и в одиночной игре — из модели, у подключившегося игрока — от ведущего.
  const taskView = () => (remote() ? RS.Net.tasks : RS.Tasks.view());
  UI.taskView = taskView;

  const setText = (el, txt) => { if (el && el.textContent !== txt) el.textContent = txt; };
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);

  function taskDue(t, now) {
    const H = RS.Schedule.hm;
    if (t.kind === 'attach') return t.ready ? 'вагоны в составе — отправляйте поезд' : 'до отправления поезда №' + t.train + ' в ' + H(t.due);
    const left = Math.ceil((t.due - now) / 60);
    return 'срок ' + H(t.due) + (left > 0 ? ' · осталось ' + left + ' мин' : ' · срок истёк');
  }

  function taskProgress(t) {
    if (t.kind === 'attach') return 'прицеплено ' + t.n + ' из ' + t.total + ' ваг.';
    return 'на месте ' + t.n + ' из ' + t.total + ' ваг.';
  }

  function renderTasks() {
    const v = taskView();
    const ul = $('#taskList');
    if (!v) {
      setText($('#taskSum'), 'Ожидание данных от ведущего…');
      return;
    }
    const now = RS.Sim.t;
    const sc = v.score;
    setText($('#taskSum'), 'Баллы смены: ' + sc.total + ' — задания ' + signed(sc.tasks) + ', поезда по графику ' + signed(sc.onTime) +
      ', опоздания ' + signed(sc.late) + ', нарушения ' + signed(sc.inc) + '. Выполнено заданий: ' + v.done + ', сорвано: ' + v.failed + '.');
    const active = v.list.filter((t) => t.state === 'active');
    const ended = v.list.filter((t) => t.state !== 'active').sort((a, b) => b.ended - a.ended).slice(0, 5);
    const key = active.map((t) => t.id + ':' + t.n + ':' + t.ready).join(',') + '|' + ended.map((t) => t.id + t.state).join(',') + '|' + v.on;
    if (ul.dataset.key !== key) {
      ul.dataset.key = key;
      ul.innerHTML = '';
      if (!active.length) {
        ul.append(h('li', { class: 'muted small empty' }, v.on
          ? 'Активных заданий нет. Новые появятся, когда на станции будут вагоны для подачи, после грузовых операций и с прибытием сборного или вывозного поезда.'
          : 'Маневровые задания выключены — включите их в настройках ниже.'));
      }
      for (const t of active) {
        ul.append(h('li', { class: 'kitem k-' + t.kind + (t.ready ? ' ready' : ''), 'data-id': t.id },
          h('div', { class: 'k-head' }, h('span', { class: 'chip k-chip' }, TASK_KIND[t.kind]), h('b', { class: 'k-title' }, t.title),
            h('span', { class: 'k-pts' }, '+' + t.reward)),
          h('p', { class: 'k-text small' }, t.text),
          t.kind === 'deliver' && RS.Tasks.HINT[t.target]
            ? h('details', { class: 'k-hint small' }, h('summary', {}, 'Как подать'), h('p', {}, RS.Tasks.HINT[t.target]))
            : null,
          h('div', { class: 'k-foot small' }, h('span', { class: 'k-prog' }, taskProgress(t)), h('span', { class: 'k-due' }, ''),
            h('button', { class: 'btn ghost sm', onclick: () => showTask(t) }, 'Показать'))));
      }
      for (const t of ended) {
        const ok = t.state === 'done';
        ul.append(h('li', { class: 'kitem ended ' + (ok ? 'k-ok' : 'k-fail') },
          h('span', { class: 'k-mark', 'aria-hidden': 'true' }, ok ? '✓' : '✕'), h('span', { class: 'k-title' }, t.title),
          h('span', { class: 'k-pts' }, ok ? '+' + t.reward : '−10')));
      }
    }
    for (const li of ul.querySelectorAll('[data-id]')) {
      const t = active.find((x) => x.id === li.dataset.id);
      if (!t) continue;
      const due = li.querySelector('.k-due');
      setText(due, taskDue(t, now));
      due.classList.toggle('late', t.kind !== 'attach' && t.due - now < 5 * 60);
    }
    // фронты и отказы
    const H = RS.Schedule.hm;
    const fl = $('#frontList');
    const fronts = v.fronts.map((f) => {
      const name = 'Путь ' + T.trackName(f.track) + ' · ' + f.name;
      const st = f.st === 'op' ? f.what + ' ' + f.n + ' ваг. до ' + H(f.until)
        : f.st === 'ready' ? f.n + ' ваг., есть готовые к уборке' : f.st === 'busy' ? 'занят: ' + f.n + ' ваг.' : 'свободен';
      return [name, st, f.st];
    });
    const faults = v.faults.map((f) => [f.kind === 'occ' ? 'Ложная занятость ' + f.id : 'Стрелка ' + f.id + ' без контроля положения',
      'восстановление около ' + H(f.until), 'fault']);
    if (!faults.length) faults.push([v.faultsOn ? 'Отказов нет' : 'Отказы выключены', v.faultsOn ? 'устройства исправны' : 'включаются в настройках ниже', 'free']);
    for (const [box, rows] of [[fl, fronts], [$('#faultList'), faults]]) {
      const k = JSON.stringify(rows);
      if (box.dataset.key === k) continue;
      box.dataset.key = k;
      box.innerHTML = '';
      for (const [a, b, cls] of rows) box.append(h('li', { class: 'f-' + cls }, h('b', {}, a), h('span', {}, b)));
    }
    UI.syncTasks();
  }

  function showTask(t) {
    if (!t.cs.length || !R.showConsists(t.cs)) UI.toast('Вагоны задания сейчас не на станции', 'info');
  }

  // Счёт смены вверху и число активных заданий на вкладке.
  function renderScore() {
    const v = taskView();
    setText($('#score'), v ? String(v.score.total) : '—');
    setText($('#cntTasks'), v ? String(v.list.filter((t) => t.state === 'active').length) : '0');
  }

  UI.syncTasks = function () {
    const v = taskView();
    if (!v) return;
    $('#tasksOn').checked = !!v.on;
    $('#faultsOn').checked = !!v.faultsOn;
  };

  function bindTasks() {
    const on = $('#tasksOn'), f = $('#faultsOn');
    on.onchange = () => {
      if (!allowed('flow')) return UI.syncTasks();
      if (remote()) return RS.Net.cmd('tasks', { on: on.checked });
      RS.Tasks.setOn(on.checked);
    };
    f.onchange = () => {
      if (!allowed('flow')) return UI.syncTasks();
      if (remote()) return RS.Net.cmd('faults', { on: f.checked });
      RS.Tasks.setFaults(f.checked);
    };
    $('#scoreBtn').onclick = () => showTab('tasks');
  }

  // --- маршруты, журнал, поток ----------------------------------------------------------------
  function routeState(r) {
    if (r.cancelT > 0) return ['Искусственное размыкание · ' + Math.ceil(r.cancelT) + ' с', 'st-cancel'];
    if (r.cancelling) return ['Размыкается', 'st-cancel'];
    if (r.used) return ['Занят составом', 'st-used'];
    const ready = Object.entries(r.req).every(([g, p]) => T.groups[g].pos === p && !T.groups[g].target);
    if (!ready) return ['Перевод стрелок', 'st-set'];
    if (r.invite) return [T.signals[r.start].invite > 0 ? 'Пригласительный · ' + Math.ceil(T.signals[r.start].invite) + ' с' : 'Замкнут, ПС погашен', 'st-inv'];
    if (r.closed) return ['Светофор перекрыт', 'st-closed'];
    if (r.open) return ['Светофор открыт', 'st-open'];
    return ['Проверка условий', 'st-set'];
  }

  // Строки вкладки «Маршруты»: у подключившегося игрока — от ведущего.
  function routeRows() {
    if (remote()) return RS.Net.routes;
    return IL.routes.map((r) => {
      const [st, cls] = routeState(r);
      return { id: r.id, start: r.start, title: r.title, kind: r.kind, st, cls, closed: r.closed, used: r.used, invite: r.invite,
        busy: r.cancelT > 0 || r.cancelling, sw: Object.entries(r.req).map(([g, p]) => g + (p === 'plus' ? '+' : '−')).join(' ') };
    });
  }
  UI.routeRows = routeRows;

  function routeAction(op, id) {
    if (!allowed('routes')) return;
    if (remote()) return RS.Net.cmd(op, { rid: id });
    const x = op === 'cancel' ? IL.cancel(id) : IL.reopen(id);
    if (!x.ok && x.why) UI.toast(x.why, 'warn');
  }

  function renderRoutes() {
    const ul = $('#routeList');
    const rows = routeRows();
    const key = rows.map((r) => r.id + ':' + r.cls + ':' + r.closed + ':' + r.busy).join(',');
    if (ul.dataset.key !== key) {
      ul.dataset.key = key;
      ul.innerHTML = '';
      if (!rows.length) ul.append(h('li', { class: 'muted small empty' }, 'Маршрутов нет. Выберите режим и нажмите светофор начала маршрута.'));
      for (const r of rows) {
        ul.append(h('li', { class: 'rrow ' + r.kind, 'data-id': r.id },
          h('div', { class: 'rtitle' }, h('span', { class: 'rk' }, r.kind === 'train' ? 'П' : 'М'), r.title),
          h('div', { class: 'rmeta small' }, h('span', { class: 'rst' }, ''), h('span', { class: 'muted' }, 'стрелки: ' + (r.sw || '—'))),
          h('div', { class: 'ractions' },
            r.closed && !r.used && !r.busy ? h('button', { class: 'btn ghost sm', onclick: () => routeAction('reopen', r.id) }, 'Повторно открыть') : null,
            !r.busy ? h('button', { class: 'btn ghost sm', onclick: () => routeAction('cancel', r.id) }, 'Отменить') : null)));
      }
    }
    for (const li of ul.children) {
      const r = rows.find((x) => String(x.id) === li.dataset.id);
      if (!r) continue;
      const e = li.querySelector('.rst');
      if (e.textContent !== r.st) e.textContent = r.st;
      e.className = 'rst ' + r.cls;
    }
  }

  function renderLog() {
    if (!RS.Log.dirty) return;
    RS.Log.dirty = false;
    const ol = $('#logList');
    ol.innerHTML = '';
    for (const it of RS.Log.items.slice(0, 120)) {
      ol.append(h('li', { class: 'log-' + it.type }, h('time', {}, RS.fmtTime(it.t)), h('span', {}, it.text)));
    }
  }

  function renderStats() {
    const s = RS.Stats;
    $('#stPassed').textContent = s.passed;
    $('#stArrived').textContent = s.arrived;
    $('#stWait').textContent = Math.round(s.waitMin);
    $('#stInc').textContent = s.incN !== undefined ? s.incN : s.incidents.length;
    const tv = taskView();
    $('#stScore').textContent = tv ? tv.score.total : '—';
    $('#stTasks').textContent = tv ? tv.done : '—';
    const ul = $('#incList');
    if (ul.childElementCount !== s.incidents.length) {
      ul.innerHTML = '';
      for (const i of s.incidents.slice(-6).reverse()) ul.append(h('li', {}, RS.fmtTime(i.t) + ' — ' + i.text));
    }
    for (const k of ['odd', 'even']) {
      const txt = UI.nextText(k);
      const el = $(k === 'odd' ? '#nextOdd' : '#nextEven');
      if (el.textContent !== txt) el.textContent = txt;
    }
  }

  // Ближайший поезд с каждой стороны — для вкладки «Движение».
  UI.nextText = function (k) {
    if (remote()) return RS.Net.next[k] || '—';
    const mode = RS.Traffic.settings.mode;
    if (mode === 'random') return 'через ' + Math.max(0, Math.ceil(RS.Traffic.next[k] / 60)) + ' мин';
    if (mode === 'schedule') {
      const e = RS.Schedule.entries.find((x) => x.dir === k && x.state === 'plan');
      if (e) return '№' + e.num + ', ' + (e.kind === 'pass' ? 'проследование ' : 'прибытие ') + RS.Schedule.hm(e.arr);
    }
    return '—';
  };

  function bindFlow() {
    const s = RS.Traffic.settings;
    const gap = $('#genGap');
    document.querySelectorAll('input[name="genMode"]').forEach((r) => {
      r.onchange = () => {
        if (!r.checked) return;
        if (!allowed('flow')) return UI.syncFlow();
        if (remote()) RS.Net.cmd('mode', { mode: r.value });
        else RS.Traffic.setMode(r.value);
        gap.disabled = r.value !== 'random';
      };
    });
    const ar = $('#autoRoute');
    ar.onchange = () => {
      if (!allowed('flow')) return UI.syncFlow();
      if (remote()) return RS.Net.cmd('autoRoute', { on: ar.checked });
      s.autoRoute = ar.checked;
      RS.Log.add('Автодействие ' + (ar.checked ? 'включено' : 'выключено'), 'info');
    };
    gap.oninput = () => {
      if (!allowed('flow')) return UI.syncFlow();
      const v = Number(gap.value);
      s.minGap = Math.max(1, v - 2);
      s.maxGap = v + 3;
      UI.syncFlow();
      if (remote()) RS.Net.cmd('gap', { v });
    };
    document.querySelectorAll('[data-spawn]').forEach((b) => {
      b.onclick = () => {
        if (!allowed('flow')) return;
        const cat = $('#spawnCat').value || null;
        if (remote()) return RS.Net.cmd('spawn', { dir: b.dataset.spawn, cat });
        const c = RS.Traffic.spawn(b.dataset.spawn, cat);
        if (!c) UI.toast('Участок приближения занят — поезд появится позже', 'info');
      };
    });
    UI.syncFlow();
  }

  // Органы управления вкладки «Движение» показывают настройки той модели, что идёт сейчас.
  UI.syncFlow = function () {
    const s = RS.Traffic.settings;
    document.querySelectorAll('input[name="genMode"]').forEach((r) => (r.checked = r.value === s.mode));
    $('#autoRoute').checked = !!s.autoRoute;
    const gap = $('#genGap');
    gap.disabled = s.mode !== 'random';
    if (document.activeElement !== gap) gap.value = s.minGap + 2;
    $('#genGapOut').textContent = 'каждые ' + s.minGap + '–' + s.maxGap + ' мин';
  };

  // --- вкладки, время, справка ------------------------------------------------------------------
  function showTab(t) {
    UI.tab = t;
    document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    document.querySelectorAll('.tab').forEach((p) => (p.hidden = p.id !== 'tab-' + t));
  }

  function bindTop() {
    document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
    document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
    document.querySelectorAll('[data-speed]').forEach((b) => (b.onclick = () => setSpeed(Number(b.dataset.speed))));
    $('#btnHelp').onclick = () => { $('#help').hidden = false; };
    $('#btnPanel').onclick = () => {
      const wide = $('.main').classList.toggle('no-side');
      $('#btnPanel').setAttribute('aria-pressed', String(wide));
      $('#btnPanel').textContent = wide ? 'Показать панель' : 'Табло шире';
    };
    $('#helpClose').onclick = () => { $('#help').hidden = true; };
    $('#help').addEventListener('click', (e) => { if (e.target.id === 'help') $('#help').hidden = true; });
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) return;
      if (e.key === 'Escape') { resetSel(); $('#hint').textContent = HINTS[UI.mode]; $('#help').hidden = true; $('#modal').hidden = true; }
      const modes = { 1: 'train', 2: 'shunt', 3: 'cancel', 4: 'switch', 5: 'invite' };
      if (modes[e.key]) setMode(modes[e.key]);
      if (e.key === ' ') { e.preventDefault(); setSpeed(RS.Sim.scale ? 0 : UI.lastSpeed || 1); }
    });
  }

  function setSpeed(k) {
    if (!allowed('flow')) return;
    if (remote()) return RS.Net.cmd('speed', { k });
    if (RS.Sim.scale) UI.lastSpeed = RS.Sim.scale;
    RS.Sim.scale = k;
    UI.syncSpeed();
  }
  UI.setSpeed = setSpeed;
  UI.syncSpeed = function () {
    if (RS.Sim.scale) UI.lastSpeed = RS.Sim.scale;
    document.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === RS.Sim.scale)));
  };

  // --- совместная игра: панель игроков -----------------------------------------------------------
  UI.renderNet = function () {
    const N = RS.Net;
    const btn = $('#btnNet');
    if (!btn || !N) return;
    const room = !!N.room;
    const people = room ? N.peers.length || 1 : 1;
    btn.textContent = !room ? 'Одиночная игра' : people > 1 ? 'Игроков: ' + people : 'Совместная игра';
    btn.classList.toggle('live', room && people > 1);
    const status = $('#netStatus');
    let txt;
    if (!room) {
      txt = N.optedOut()
        ? 'Вы играете отдельно от остальных, кто открыл эту страницу.'
        : 'Совместная игра работает на странице, опубликованной в claude.ai. В локальном файле — только одиночная.';
    } else if (N.mode === 'client') txt = 'Модель станции ведёт ' + N.nameOf(N.hostPeer) + '. Ваши действия выполняются у него, все видят одно и то же.';
    else if (N.mode === 'host') txt = 'Модель станции идёт у вас, остальные видят её и управляют вместе с вами. Не закрывайте вкладку.';
    else txt = 'Пока вы одни. Кто откроет эту страницу, подключится к вашей смене.';
    status.textContent = txt;
    const ul = $('#netList');
    ul.innerHTML = '';
    for (const p of room ? N.peers : []) {
      const me = p.isMe && p.sameTab;
      const host = p.peer === N.hostPeer || (me && N.mode !== 'client');
      const role = (p.presence && p.presence.role) || 'all';
      ul.append(h('li', {},
        h('i', { class: 'np-dot', style: 'background:' + N.colorOf(p) }),
        h('span', { class: 'np-name' }, me ? 'Вы' : N.nameOf(p.peer)),
        h('span', { class: 'np-role muted' }, N.roleTitle(role)),
        host ? h('span', { class: 'chip np-host' }, 'ведущий') : null));
    }
    $('#netRole').value = N.role;
    $('#netRoleRow').hidden = !room;
    $('#netLeave').hidden = !room;
    $('#netRejoin').hidden = room || !N.optedOut();
  };

  // Справка: показания по ИСИ с изображением ламп.
  function buildHelp() {
    const list = $('#aspectList');
    const rows = [
      ['entry', 'G'], ['entry', 'YF'], ['entry', 'Y'], ['entry', 'YFY'], ['entry', 'YY'], ['entry', 'R'], ['entry', 'RW'],
      ['exit', 'W'], ['shunt', 'W'], ['shunt', 'B'],
    ];
    const cls = { R: 'l-red', G: 'l-grn', Y1: 'l-yel', Y2: 'l-yel', W: 'l-wht', B: 'l-blu' };
    for (const [kind, a] of rows) {
      const lamps = R.LAMPS[kind];
      const lit = R.LIT[a];
      const head = h('span', { class: 'mini-head' + (kind === 'shunt' ? ' short' : '') });
      for (const l of lamps) head.append(h('i', { class: lit[l] ? 'on ' + cls[l] + (lit[l] === 2 ? ' blink' : '') : '' }));
      list.append(h('li', {}, head, h('span', {}, IL.ASPECTS[a])));
    }
  }

  function bindNet() {
    const panel = $('#netPanel');
    const btn = $('#btnNet');
    btn.onclick = () => {
      panel.hidden = !panel.hidden;
      btn.setAttribute('aria-expanded', String(!panel.hidden));
      UI.renderNet();
    };
    $('#netClose').onclick = () => { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    $('#netRole').onchange = () => RS.Net.setRole($('#netRole').value);
    $('#netLeave').onclick = () => UI.ask('Играть отдельно?', 'Страница перезагрузится, и вы начнёте свою смену, не видя остальных. Вернуться можно кнопкой в этой же панели.', 'Играть отдельно', () => RS.Net.leave());
    $('#netRejoin').onclick = () => RS.Net.rejoin();
  }

  UI.init = function () {
    bindTop();
    bindNet();
    bindBoard();
    bindFlow();
    bindTasks();
    buildHelp();
    setMode('train');
    showTab('sched');
    setSpeed(1);
    renderTrainCard(true);
  };

  let acc = 0;
  UI.tick = function (dt) {
    acc += dt;
    $('#clock').textContent = RS.fmtTime(RS.Sim.t);
    renderTrainCard();
    if (acc < 0.25) return;
    acc = 0;
    if (UI.tab === 'sched') renderSchedule();
    if (UI.tab === 'tasks') renderTasks();
    if (UI.tab === 'trains') renderTrainList();
    if (UI.tab === 'routes') renderRoutes();
    if (UI.tab === 'log') renderLog();
    if (UI.tab === 'flow') renderStats();
    renderApproach();
    renderScore();
    $('#cntTrains').textContent = C.list.filter((c) => c.ctl === 'ai').length;
    $('#cntRoutes').textContent = remote() ? RS.Net.routes.length : IL.routes.length;
  };

  UI.routeState = routeState;
  UI.resetSelection = function () {
    resetSel();
    $('#hint').textContent = HINTS[UI.mode];
  };

  RS.UI = UI;
})();
