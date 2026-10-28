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
    RS.UI.init();
    RS.Consist.computeOcc();
    RS.IL.update(0);
    RS.Render.update();
    let last = performance.now();
    let acc = 0;
    function frame(now) {
      const real = Math.min(0.25, Math.max(0, (now - last) / 1000));
      last = now;
      acc += real * RS.Sim.scale;
      let n = 0;
      while (acc >= DT && n < 120) {
        step(DT);
        acc -= DT;
        n++;
      }
      if (n >= 120) acc = 0;
      RS.Render.update();
      RS.UI.tick(real);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  RS.step = step;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
