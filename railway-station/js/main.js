/*
 * Запуск: модельное время, цикл симуляции с фиксированным шагом, отрисовка.
 */
(function () {
  const RS = window.RS;
  RS.Sim = { t: 8 * 3600, scale: 1 };
  const DT = 0.1; // шаг модели, с

  function step(dt) {
    const C = RS.Consist;
    C.computeOcc();
    RS.IL.update(dt);
    for (const c of C.list.slice()) C.step(c, dt);
    C.computeOcc();
    RS.Traffic.update(dt);
    RS.Sim.t += dt;
  }

  function boot() {
    RS.Render.init(document.getElementById('map'));
    RS.Schedule.init(RS.Sim.t);
    RS.Traffic.initial();
    RS.Tasks.init();
    RS.UI.init();
    RS.Consist.computeOcc();
    RS.IL.update(0);
    RS.Render.update();
    RS.Net.init();
    let last = performance.now();
    let acc = 0;
    // Модель идёт у ведущего и в одиночной игре; у подключившегося игрока её нет.
    function advance(now) {
      const real = Math.min(document.hidden ? 2 : 0.25, Math.max(0, (now - last) / 1000));
      last = now;
      if (RS.Net.mode === 'solo' || RS.Net.mode === 'host') {
        acc += real * RS.Sim.scale;
        let n = 0;
        while (acc >= DT && n < 240) {
          step(DT);
          acc -= DT;
          n++;
        }
        if (n >= 240) acc = 0;
      }
      RS.Net.tick(real);
      return real;
    }
    function frame(now) {
      const real = advance(now);
      RS.Render.update();
      RS.UI.tick(real);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    // Вкладка ведущего в фоне: кадры не рисуются, но модель и рассылка идут по таймеру.
    setInterval(() => {
      if (document.hidden && RS.Net.mode === 'host') advance(performance.now());
    }, 1000);
  }

  RS.step = step;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
