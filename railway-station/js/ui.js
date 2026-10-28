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
    const res = IL.set(c, { invite });
    if (res.ok) {
      resetSel();
      $('#hint').textContent = HINTS[UI.mode];
      return;
    }
    if (res.inviteOk) {
      resetSel();
      UI.ask('Путь ' + T.trackName(c.dest) + ' занят', res.why + ' Замкнуть маршрут ' + IL.title(c) + ' и включить пригласительный сигнал? Машинист проследует светофор со скоростью не более 20 км/ч и остановится перед подвижным составом.',
        'Включить ПС', () => trySet(c, true));
      return;
    }
    UI.toast(res.why, 'warn');
  }

  function clickSignal(id) {
    const sig = T.signals[id];
    const m = UI.mode;
    if (m === 'cancel') {
      const r = IL.routeFrom(id);
      if (!r) return UI.toast('От светофора ' + id + ' маршрут не задан', 'info');
      const res = IL.cancel(r.id);
      if (!res.ok && res.why) UI.toast(res.why, 'warn');
      return;
    }
    if (m === 'switch') return;
    // выбор конечного светофора
    if (UI.start && UI.start !== id) {
      const c = UI.cands.find((x) => x.end.sig === id);
      if (c) return trySet(c, m === 'invite');
    }
    const kind = m === 'shunt' ? 'shunt' : 'train';
    if (m === 'invite' && sig.kind !== 'entry' && sig.kind !== 'exit') return UI.toast('Пригласительный сигнал есть только на входных и выходных светофорах', 'info');
    if (kind === 'train' && !sig.train) return UI.toast('Светофор ' + id + ' не открывается поездным показанием. Для маневров выберите «Маневровый маршрут».', 'info');
    if (kind === 'shunt' && !sig.shunt) return UI.toast('Светофор ' + id + ' не имеет маневрового показания', 'info');
    const ex = IL.routeFrom(id);
    if (ex && m === 'invite' && ex.invite) {
      const r = IL.inviteAgain(id);
      return UI.toast(r.ok ? 'Пригласительный сигнал на ' + id + ' включён повторно' : r.why, r.ok ? 'info' : 'warn');
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
    if (UI.start) return;
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
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      R.zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * 0.0015));
    }, { passive: false });
    svg.addEventListener('contextmenu', (e) => {
      const t = e.target.closest('[data-sig]');
      if (!t) return;
      e.preventDefault();
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
    light: ['Лок', 'c-light'], shunt: ['Манёвр', 'c-shunt'], cut: ['Отцеп', 'c-cut'],
  };

  function where(c) {
    return C.sectionsOf(c).map((s) => (LAY.tracks[s] ? 'путь ' + LAY.tracks[s].name : s)).join(', ');
  }

  function takeControl(c) {
    const sd = C.screenDir(c);
    c.ctl = 'manual';
    c.setDir = c.v > 0.05 ? sd * c.move : 0;
    c.setV = Math.min(40, Math.max(5, Math.round(c.v * 3.6)));
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
    const sig = c.id + '|' + c.ctl + '|' + c.vehicles.length + '|' + (c.info && c.info.cat);
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
    if (info.note) box.append(h('p', { class: 'note' }, info.note));
    if (info.ofTrain) box.append(h('p', { class: 'muted small' }, 'Из состава поезда №' + info.ofTrain));
    box.append(h('div', { class: 'tc-row' },
      h('div', { class: 'gauge' }, h('span', { class: 'tc-speed' }, '0'), h('small', {}, 'км/ч')),
      h('div', { class: 'tc-info' }, h('div', { class: 'tc-where' }, ''), h('div', { class: 'tc-status' }, ''), h('div', { class: 'tc-limit muted small' }, ''))));

    if (C.hasLoco(c)) {
      if (c.ctl === 'ai') {
        box.append(h('div', { class: 'tc-ctl' },
          h('p', { class: 'small' }, 'Автоведение: машинист следует по сигналам, останавливается у платформ и ждёт открытия выходного.'),
          h('button', { class: 'btn primary', onclick: () => takeControl(c) }, 'Взять управление')));
      } else {
        const rng = h('input', { type: 'range', min: 0, max: 40, step: 1, value: c.setV, id: 'spd-' + c.id, 'aria-label': 'Заданная скорость' });
        const out = h('output', { for: 'spd-' + c.id }, c.setV + ' км/ч');
        rng.oninput = () => { c.setV = Number(rng.value); out.textContent = rng.value + ' км/ч'; };
        const dirBtn = (d, label, tip) => h('button', { class: 'btn dir', 'data-dir': d, title: tip, onclick: () => { c.setDir = d; renderTrainCard(); } }, label);
        box.append(h('div', { class: 'tc-ctl' },
          h('div', { class: 'dirs', role: 'group', 'aria-label': 'Направление' }, dirBtn(-1, '◀ Влево', 'Движение влево по схеме'), dirBtn(0, '■ Стоп', 'Остановиться'), dirBtn(1, 'Вправо ▶', 'Движение вправо по схеме')),
          h('label', { class: 'spd', for: 'spd-' + c.id }, 'Скорость', rng, out),
          h('p', { class: 'muted small' }, 'Защита КЛУБ-У остановит состав перед запрещающим сигналом, упором, границей станции и неготовой стрелкой. Сцепление — автоматически при подъезде.'),
          info.dir && !['cut', 'shunt', 'light'].includes(info.cat)
            ? h('button', { class: 'btn ghost', onclick: () => { c.ctl = 'ai'; c.setDir = 0; renderTrainCard(true); } }, 'Вернуть автоведение')
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
      const title = (v.loco ? v.type : (C.VEH[v.type].title || v.type)) + ' №' + v.num + (v.dest === LAY.station ? ' — назначением на ст. ' + LAY.station : '');
      strip.append(h('span', { class: 'vb v-' + v.kind + (v.dest === LAY.station ? ' dest' : ''), role: 'listitem', title, style: 'flex-grow:' + v.len }));
    });
    box.append(h('div', { class: 'strip-wrap' }, h('div', { class: 'strip-cap muted small' }, sd > 0 ? '← хвост · голова →' : '← голова · хвост →'), strip));
    box.append(h('p', { class: 'muted small' }, 'Нажмите на промежуток между вагонами, чтобы расцепить (только на стоянке).'));
  }

  function doSplit(c, k) {
    if (c.v > 0.05) return UI.toast('Расцепка только после полной остановки', 'warn');
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
      const tdir = info.dir === 'odd' ? 1 : -1;
      const p = tdir === C.screenDir(c) ? C.frontPoint(c) : C.rearPoint(c);
      const d = info.dir === 'odd' ? (150 - p[0]) * T.M : (p[0] - 1270) * T.M;
      if (d >= 0) items[info.dir].push({ c, d });
    }
    for (const k of ['odd', 'even']) {
      const box = $(k === 'odd' ? '#apLeft' : '#apRight');
      const entry = LAY.spawns[k].entry;
      const key = items[k].map((i) => i.c.id + ':' + Math.round(i.d / 100) + ':' + Math.round(i.c.v * 3.6)).join('|');
      if (box.dataset.key === key) continue;
      box.dataset.key = key;
      box.innerHTML = '';
      for (const { c, d } of items[k]) {
        const st = c.v < 0.05;
        box.append(h('button', { class: 'ap-chip' + (st ? ' stopped' : ''), title: 'Открыть карточку поезда', onclick: () => select(c.id) },
          h('b', {}, '№' + c.info.num), h('span', { class: 'ap-d' }, (d / 1000).toFixed(1) + ' км до ' + entry),
          h('span', { class: 'ap-s' }, c.info.title + ', ' + Math.round(c.length) + ' м · ' + (st ? 'стоит у закрытого ' + entry : Math.round(c.v * 3.6) + ' км/ч'))));
      }
    }
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

  function renderRoutes() {
    const ul = $('#routeList');
    const key = IL.routes.map((r) => r.id + ':' + routeState(r)[1] + ':' + r.closed).join(',');
    if (ul.dataset.key !== key) {
      ul.dataset.key = key;
      ul.innerHTML = '';
      if (!IL.routes.length) ul.append(h('li', { class: 'muted small empty' }, 'Маршрутов нет. Выберите режим и нажмите светофор начала маршрута.'));
      for (const r of IL.routes) {
        const sw = Object.entries(r.req).map(([g, p]) => g + (p === 'plus' ? '+' : '−')).join(' ');
        ul.append(h('li', { class: 'rrow ' + r.kind, 'data-id': r.id },
          h('div', { class: 'rtitle' }, h('span', { class: 'rk' }, r.kind === 'train' ? 'П' : 'М'), r.title),
          h('div', { class: 'rmeta small' }, h('span', { class: 'rst' }, ''), h('span', { class: 'muted' }, 'стрелки: ' + (sw || '—'))),
          h('div', { class: 'ractions' },
            r.closed && !r.used && !r.cancelT && !r.cancelling ? h('button', { class: 'btn ghost sm', onclick: () => IL.reopen(r.id) }, 'Повторно открыть') : null,
            !r.cancelT && !r.cancelling ? h('button', { class: 'btn ghost sm', onclick: () => { const x = IL.cancel(r.id); if (!x.ok && x.why) UI.toast(x.why, 'warn'); } }, 'Отменить') : null)));
      }
    }
    for (const li of ul.children) {
      const r = IL.byId(Number(li.dataset.id));
      if (!r) continue;
      const [st, cls] = routeState(r);
      const e = li.querySelector('.rst');
      if (e.textContent !== st) e.textContent = st;
      e.className = 'rst ' + cls;
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
    $('#stInc').textContent = s.incidents.length;
    const ul = $('#incList');
    if (ul.childElementCount !== s.incidents.length) {
      ul.innerHTML = '';
      for (const i of s.incidents.slice(-6).reverse()) ul.append(h('li', {}, RS.fmtTime(i.t) + ' — ' + i.text));
    }
    const nx = RS.Traffic.next;
    $('#nextOdd').textContent = RS.Traffic.settings.auto ? Math.max(0, Math.ceil(nx.odd / 60)) + ' мин' : '—';
    $('#nextEven').textContent = RS.Traffic.settings.auto ? Math.max(0, Math.ceil(nx.even / 60)) + ' мин' : '—';
  }

  function bindFlow() {
    const s = RS.Traffic.settings;
    const auto = $('#autoGen');
    auto.checked = s.auto;
    auto.onchange = () => { s.auto = auto.checked; };
    const ar = $('#autoRoute');
    ar.checked = s.autoRoute;
    ar.onchange = () => { s.autoRoute = ar.checked; RS.Log.add('Автодействие по главным путям ' + (ar.checked ? 'включено' : 'выключено'), 'info'); };
    const gap = $('#genGap');
    const out = $('#genGapOut');
    const upd = () => { const v = Number(gap.value); s.minGap = Math.max(1, v - 2); s.maxGap = v + 3; out.textContent = 'каждые ' + s.minGap + '–' + s.maxGap + ' мин'; };
    gap.oninput = upd;
    upd();
    document.querySelectorAll('[data-spawn]').forEach((b) => {
      b.onclick = () => {
        const cat = $('#spawnCat').value || null;
        const c = RS.Traffic.spawn(b.dataset.spawn, cat);
        if (!c) UI.toast('Участок приближения занят — поезд появится позже', 'info');
      };
    });
  }

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
    if (RS.Sim.scale) UI.lastSpeed = RS.Sim.scale;
    RS.Sim.scale = k;
    document.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === k)));
  }

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

  UI.init = function () {
    bindTop();
    bindBoard();
    bindFlow();
    buildHelp();
    setMode('train');
    showTab('trains');
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
    if (UI.tab === 'trains') renderTrainList();
    if (UI.tab === 'routes') renderRoutes();
    if (UI.tab === 'log') renderLog();
    if (UI.tab === 'flow') renderStats();
    renderApproach();
    $('#cntTrains').textContent = C.list.filter((c) => c.ctl === 'ai').length;
    $('#cntRoutes').textContent = IL.routes.length;
  };

  RS.UI = UI;
})();
