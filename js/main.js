/*
 * main.js — connects the controls to the simulation and runs the animation
 * loop. Each frame advances the physics by (real seconds × speed), then
 * redraws the container and the molecular view; readouts and the chart
 * refresh 10 times a second.
 */
(function () {
  'use strict';

  const { MATERIALS, SHAPES } = HeatSim;
  const $ = (id) => document.getElementById(id);

  const SPEEDS = [
    { value: 1, label: '1×' },
    { value: 10, label: '10×' },
    { value: 60, label: '1 min/s' },
    { value: 600, label: '10 min/s' },
    { value: 3600, label: '1 h/s' },
    { value: 10800, label: '3 h/s' },
  ];

  // The size slider is logarithmic: 0 → 50 mL, 100 → 20 L.
  const MIN_L = 0.05, MAX_L = 20;
  function sliderToLitres(v) {
    const raw = MIN_L * Math.pow(MAX_L / MIN_L, v / 100);
    const digits = Math.pow(10, Math.floor(Math.log10(raw)) - 1); // 2 significant figures
    return Math.round(raw / digits) * digits;
  }

  const fmtVolume = (L) => (L < 1 ? `${Math.round(L * 1000)} mL` : `${+L.toFixed(1)} L`);

  function fmtClock(s) {
    s = Math.floor(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function fmtDuration(s) {
    if (s === undefined) return '—';
    if (s < 60) return `${Math.round(s)} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
    return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  }

  // ---- Populate the dropdowns ----
  for (const [key, s] of Object.entries(SHAPES)) $('shape').add(new Option(s.name, key));
  for (const [key, m] of Object.entries(MATERIALS)) $('material').add(new Option(m.name, key));
  $('material').value = 'ceramic';

  // ---- Read the controls into a config object ----
  function readConfig() {
    return {
      waterTemp: +$('waterTemp').value,
      ambient: +$('ambient').value,
      shape: $('shape').value,
      volume: sliderToLitres(+$('size').value),
      material: $('material').value,
      thickness: +$('thickness').value,
      lidded: $('lidded').checked,
      preheat: $('preheat').checked,
    };
  }

  function updateOutputs() {
    $('waterTempOut').textContent = `${$('waterTemp').value} °C${cfg.waterTemp < 0 ? ' (ice)' : ''}`;
    $('ambientOut').textContent = `${$('ambient').value} °C`;
    $('sizeOut').textContent = fmtVolume(cfg.volume);
    $('thicknessOut').textContent = `${$('thickness').value} mm`;
  }

  let cfg = readConfig();
  let state = HeatSim.createState(cfg);
  let playing = false;
  let speed = 60;
  const pins = [];

  const scene = new SceneRenderer($('scene'));
  const chart = new TempChart($('graph'));
  const molecules = new MoleculeView($('mol'));

  function restart() {
    cfg = readConfig();
    state = HeatSim.createState(cfg);
    scene.particles = [];
    updateOutputs();
    refreshUI();
  }

  // Settings that define the starting situation restart the run...
  for (const id of ['waterTemp', 'shape', 'size', 'material', 'thickness', 'preheat']) {
    $(id).addEventListener('input', restart);
  }
  // ...while these can change mid-run.
  $('ambient').addEventListener('input', () => {
    cfg.ambient = +$('ambient').value;
    updateOutputs();
    refreshUI();
  });
  $('lidded').addEventListener('change', () => {
    cfg.lidded = $('lidded').checked;
    if (cfg.lidded) HeatSim.placeLid(state, cfg);
    state.last = HeatSim.computeFlows(state, cfg);
    refreshUI();
  });

  // ---- Time controls ----
  function setPlaying(on) {
    playing = on;
    $('playPause').textContent = on ? '⏸ Pause' : '▶ Play';
  }
  $('playPause').addEventListener('click', () => setPlaying(!playing));
  $('reset').addEventListener('click', () => { restart(); setPlaying(false); });

  for (const s of SPEEDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.label;
    b.title = `${s.value}× real time`;
    b.setAttribute('aria-pressed', String(s.value === speed));
    b.addEventListener('click', () => {
      speed = s.value;
      for (const other of $('speeds').children) other.setAttribute('aria-pressed', String(other === b));
    });
    $('speeds').appendChild(b);
  }

  for (const b of document.querySelectorAll('[data-skip]')) {
    b.addEventListener('click', () => {
      HeatSim.advance(state, cfg, +b.dataset.skip);
      refreshUI();
    });
  }

  $('showArrows').addEventListener('change', (e) => { scene.showArrows = e.target.checked; });

  // ---- Kept curves for comparison ----
  function describe(c) {
    return `${SHAPES[c.shape].name.split(' (')[0]}, ${fmtVolume(c.volume)}, ${MATERIALS[c.material].name.split(' (')[0].toLowerCase()} ${c.thickness} mm, ${c.lidded ? 'lid' : 'open'}, from ${c.waterTemp}°C in a ${c.ambient}°C room`;
  }

  function renderPins() {
    const list = $('pinList');
    list.innerHTML = '';
    const live = document.createElement('li');
    live.className = 'live';
    live.innerHTML = `<span class="swatch"></span>`;
    live.append(`Current: ${describe(cfg)}`);
    list.appendChild(live);
    for (const p of pins) {
      const li = document.createElement('li');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = p.color;
      li.append(sw, p.label);
      list.appendChild(li);
    }
  }

  $('pin').addEventListener('click', () => {
    if (pins.length >= PIN_COLORS.length) pins.shift();
    const used = new Set(pins.map((p) => p.color));
    const color = PIN_COLORS.find((c) => !used.has(c));
    pins.push({
      color,
      label: describe(cfg),
      history: state.history.concat([{ t: state.t, T: state.water.T }]),
    });
    refreshUI();
  });
  $('clearPins').addEventListener('click', () => { pins.length = 0; refreshUI(); });

  // ---- Readouts ----
  const BREAKDOWN_COLORS = {
    side: '#3b82f6', bottom: '#8b5cf6', lid: '#14b8a6',
    evap: '#f97316', conv: '#eab308', rad: '#ef4444',
  };

  function breakdownItems() {
    const f = state.last;
    const names = { side: 'Side walls', bottom: 'Bottom', lid: 'Through the lid' };
    const items = f.panels.map((p) => ({ key: p.key, label: names[p.key], w: p.qin }));
    if (!cfg.lidded) {
      items.push({ key: 'evap', label: f.top.evap >= 0 ? 'Evaporation (steam)' : 'Condensation on surface', w: f.top.evap });
      items.push({ key: 'conv', label: 'Air convection at surface', w: f.top.conv });
      items.push({ key: 'rad', label: 'Radiation at surface', w: f.top.rad });
    }
    return items;
  }

  function phaseText() {
    const w = state.water;
    if (w.ice >= 1) return `Solid ice (${w.T.toFixed(1)} °C)`;
    if (w.ice > 0) return `${state.last.total >= 0 ? 'Freezing' : 'Melting'}: ${Math.round(w.ice * 100)}% ice`;
    return 'Liquid water';
  }

  // Rows for freezing and thawing only appear when they matter.
  function showRows(name, visible) {
    for (const el of document.querySelectorAll(`[data-row="${name}"]`)) el.hidden = !visible;
  }

  function moleculeCaption() {
    const w = state.water;
    const pct = Math.round(w.ice * 100);
    const speed = Math.round(moleculeRealSpeed(w.T));
    if (w.ice >= 1) return '<strong>Frozen:</strong> the molecules are locked into a crystal and can only vibrate on the spot.';
    if (w.ice > 0) return `<strong>${state.last.total >= 0 ? 'Freezing' : 'Melting'}:</strong> ${pct}% of the molecules are locked into the crystal. The rest still average about ${speed} m/s.`;
    return `Average speed about <strong>${speed} m/s</strong>. On screen the speeds are exaggerated so the difference between hot and cold is easy to see.`;
  }

  function refreshUI() {
    const f = state.last;
    const w = state.water;
    const ms = state.milestones;
    $('clock').textContent = fmtClock(state.t);
    $('tWater').textContent = w.T.toFixed(1);
    $('phase').textContent = phaseText();

    // While the water sits at 0 °C, heat goes into freezing or melting, not temperature.
    const C = HeatSim.heatCapacity(w);
    if (C === null) {
      $('rate').textContent = 'holding at 0 °C';
    } else {
      const change = (-f.total / C) * 60; // °C per minute
      $('rate').textContent = `${change < 0 ? '−' : '+'}${Math.abs(change).toFixed(Math.abs(change) < 0.1 ? 3 : 2)} °C/min`;
    }
    $('powerLabel').textContent = f.total >= 0 ? 'Heat leaving water' : 'Heat entering water';
    $('power').textContent = `${Math.abs(f.total).toFixed(Math.abs(f.total) < 10 ? 2 : 1)} W`;
    $('tWall').textContent = `${state.nodes.side.T.toFixed(1)} °C`;
    $('tLid').textContent = cfg.lidded ? `${state.nodes.lid.T.toFixed(1)} °C` : 'no lid';
    $('energyLabel').textContent = state.energyLost >= 0 ? 'Energy lost' : 'Energy gained';
    $('energy').textContent = `${(Math.abs(state.energyLost) / 1000).toFixed(1)} kJ`;
    $('evapLabel').textContent = state.evaporated >= 0 ? 'Water evaporated' : 'Water condensed';
    $('evap').textContent = `${Math.abs(state.evaporated * 1000).toFixed(1)} g`;

    $('m60').textContent = fmtDuration(ms[60]);
    $('m40').textContent = fmtDuration(ms[40]);
    const freezing = cfg.ambient < 0 || w.ice > 0 || ms.freezeStart !== undefined || ms.frozen !== undefined;
    showRows('freeze', freezing);
    showRows('thaw', w.ice > 0 || ms.thawed !== undefined);
    $('mFreeze').textContent = fmtDuration(ms.freezeStart);
    $('mFrozen').textContent = w.startT < 0 ? 'started frozen' : fmtDuration(ms.frozen);
    $('mThawed').textContent = fmtDuration(ms.thawed);

    // Heat breakdown. Items are signed relative to the overall direction of
    // flow, so a flow working against it (e.g. evaporation cooling water that
    // the room is warming) shows as negative and is left out of the bar.
    const dir = f.total >= 0 ? 1 : -1;
    $('breakdownTitle').textContent = dir > 0 ? 'Where the heat is going' : 'Where the heat is coming from';
    const items = breakdownItems().map((i) => ({ ...i, w: i.w * dir }));
    const sum = items.reduce((t, i) => t + Math.max(0, i.w), 0) || 1;
    $('breakdownBar').innerHTML = items
      .map((i) => `<span style="width:${(Math.max(0, i.w) / sum) * 100}%;background:${BREAKDOWN_COLORS[i.key]}" title="${i.label}"></span>`)
      .join('');
    $('breakdownLegend').innerHTML = items
      .map((i) => `<li><span class="dot" style="background:${BREAKDOWN_COLORS[i.key]}"></span>${i.label}<span class="val">${i.w < 0 ? '−' : ''}${Math.abs(i.w).toFixed(1)} W${i.w > 0 ? ` · ${Math.round((i.w / sum) * 100)}%` : ''}</span></li>`)
      .join('');

    $('molCaption').innerHTML = moleculeCaption();
    chart.draw(state, cfg, pins);
    renderPins();
  }

  // ---- Animation loop ----
  let lastFrame = performance.now();
  let lastUI = 0;
  function frame(now) {
    const realDt = Math.min(0.1, (now - lastFrame) / 1000); // cap to avoid huge jumps after a tab switch
    lastFrame = now;
    if (playing) HeatSim.advance(state, cfg, realDt * speed);
    scene.draw(state, cfg, realDt);
    molecules.update(realDt, state);
    if (now - lastUI > 100) {
      refreshUI();
      lastUI = now;
    }
    requestAnimationFrame(frame);
  }

  new ResizeObserver(() => {
    scene.resize();
    chart.resize();
    molecules.resize();
    refreshUI();
  }).observe(document.querySelector('.layout'));

  updateOutputs();
  refreshUI();
  requestAnimationFrame(frame);
})();
