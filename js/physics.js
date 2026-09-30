/*
 * physics.js — the heat-loss model. No drawing or DOM code lives here, so it
 * can also be loaded in Node for testing.
 *
 * The model is a small "lumped" thermal network:
 *
 *   water ──► side wall ──► room air
 *         ──► bottom    ──► room air
 *         ──► lid       ──► room air        (when lidded)
 *         ──► room air directly             (when open: convection,
 *                                            radiation and evaporation)
 *
 * The water and each wall panel have one temperature each. Every panel stores
 * heat (so a cold, thick mug soaks up heat at the start) and passes heat on
 * through two half-thicknesses of wall plus a surface film on each side.
 */
(function (global) {
  'use strict';

  const SIGMA = 5.670374e-8;              // Stefan–Boltzmann constant, W/m²K⁴
  const WATER_CP = 4186;                  // specific heat of water, J/kg·K
  const WATER_RHO = 1000;                 // density of water, kg/m³
  const WATER_EPS = 0.95;                 // emissivity of a water surface
  const AIR_RHO_CP = 1.2 * 1007;          // volumetric heat capacity of air, J/m³·K
  const LEWIS_23 = Math.pow(0.85, 2 / 3); // (Lewis number)^(2/3) for water vapour in air
  const RELATIVE_HUMIDITY = 0.5;
  const MAX_DT = 5;                       // largest internal time step, s

  // k: conductivity W/m·K, rho: density kg/m³, cp: J/kg·K, eps: emissivity.
  // color/opacity are only used for drawing.
  const MATERIALS = {
    glass:     { name: 'Glass',                   k: 1.0,   rho: 2500, cp: 840,  eps: 0.92, color: '#b9e2f0', opacity: 0.45 },
    ceramic:   { name: 'Ceramic (porcelain)',     k: 1.5,   rho: 2400, cp: 1085, eps: 0.90, color: '#efe9dc', opacity: 1 },
    plastic:   { name: 'Plastic (polypropylene)', k: 0.22,  rho: 900,  cp: 1900, eps: 0.90, color: '#f3cf5b', opacity: 0.9 },
    steel:     { name: 'Stainless steel',         k: 16,    rho: 8000, cp: 500,  eps: 0.35, color: '#9ea7b1', opacity: 1 },
    aluminium: { name: 'Aluminium',               k: 205,   rho: 2700, cp: 900,  eps: 0.09, color: '#cdd3db', opacity: 1 },
    copper:    { name: 'Copper',                  k: 385,   rho: 8960, cp: 385,  eps: 0.05, color: '#c9804f', opacity: 1 },
    foam:      { name: 'Polystyrene foam',        k: 0.035, rho: 30,   cp: 1300, eps: 0.60, color: '#fbfbf7', opacity: 1 },
    // A vacuum flask wall behaves like a very poor conductor. The density is an
    // "effective" value: two thin steel skins spread over the wall thickness.
    vacuum:    { name: 'Vacuum-insulated steel',  k: 0.002, rho: 1600, cp: 500,  eps: 0.35, color: '#7d8791', opacity: 1 },
  };

  const SHAPES = {
    mug:    { name: 'Cylinder (mug)',       kind: 'cylinder', aspect: 1.2 },
    dish:   { name: 'Wide dish',            kind: 'cylinder', aspect: 0.4 },
    column: { name: 'Tall column',          kind: 'cylinder', aspect: 3.0 },
    cube:   { name: 'Cube (box)',           kind: 'box' },
    sphere: { name: 'Sphere (round flask)', kind: 'sphere' },
  };

  const SPHERE_OPENING = 0.35; // opening radius as a fraction of sphere radius

  /*
   * Work out the inside dimensions and surface areas for a shape holding
   * `volumeL` litres. Areas are the inside (wetted) areas; the wall is treated
   * as thin compared with the container so inside ≈ outside area.
   *   side/bottom/top : areas in m²
   *   Lside/Lhoriz    : characteristic lengths used by the air-convection formulas
   */
  function geometry(shapeKey, volumeL) {
    const shape = SHAPES[shapeKey];
    const V = volumeL / 1000;
    if (shape.kind === 'cylinder') {
      const D = Math.cbrt((4 * V) / (Math.PI * shape.aspect));
      const H = shape.aspect * D;
      const disc = (Math.PI * D * D) / 4;
      return { kind: 'cylinder', width: D, height: H, openWidth: D,
               side: Math.PI * D * H, bottom: disc, top: disc, Lside: H, Lhoriz: D / 4 };
    }
    if (shape.kind === 'box') {
      const s = Math.cbrt(V);
      return { kind: 'box', width: s, height: s, openWidth: s,
               side: 4 * s * s, bottom: s * s, top: s * s, Lside: s, Lhoriz: s / 4 };
    }
    // Sphere with a round opening at the top. It has no separate "bottom".
    const R = Math.cbrt((3 * V) / (4 * Math.PI));
    const r = SPHERE_OPENING * R;
    const top = Math.PI * r * r;
    return { kind: 'sphere', width: 2 * R, height: 2 * R, openWidth: 2 * r,
             side: 4 * Math.PI * R * R - top, bottom: 0, top, Lside: 2 * R, Lhoriz: r / 2 };
  }

  // ---- Heat-transfer helpers -------------------------------------------------

  const kelvin = (c) => c + 273.15;

  // Natural convection to still air (simplified laminar correlations), W/m²K.
  function hAir(orientation, dT, L) {
    const d = Math.abs(dT);
    if (d < 1e-9) return 0;
    const x = Math.pow(d / L, 0.25);
    if (orientation === 'vertical') return 1.42 * x;
    if (orientation === 'up') return 1.32 * x;   // warm surface facing up
    return 0.59 * x;                              // warm surface facing down
  }

  // Radiation, linearised into a heat-transfer coefficient, W/m²K.
  function hRad(TsC, TaC, eps) {
    const Ts = kelvin(TsC), Ta = kelvin(TaC);
    return eps * SIGMA * (Ts * Ts + Ta * Ta) * (Ts + Ta);
  }

  // Water moving past the inside wall (natural convection in water), W/m²K.
  function hWater(dT) {
    return Math.max(50, 110 * Math.cbrt(Math.abs(dT)));
  }

  // Saturation vapour pressure (Magnus formula), Pa.
  function pSat(TC) {
    return 610.94 * Math.exp((17.625 * TC) / (TC + 243.04));
  }

  // Mass of water vapour per m³ of saturated air, kg/m³.
  function vapourDensity(TC, rh = 1) {
    return (rh * pSat(TC) * 0.018015) / (8.314 * kelvin(TC));
  }

  // Energy needed to evaporate 1 kg of water, J/kg.
  function latentHeat(TC) {
    return 2.501e6 - 2370 * TC;
  }

  /*
   * Heat flux (W/m²) from the water surface up to the underside of a lid that
   * sits at temperature Ts. Three things carry heat across the trapped air:
   * convection, radiation, and — the big one — water evaporating from the
   * surface and condensing on the lid (that's why lids steam up and get hot).
   */
  function lidGapFlux(Tw, Ts, lidEps, L) {
    const dT = Tw - Ts;
    const hc = Math.max(2, hAir('up', dT, L));
    const hm = hc / (AIR_RHO_CP * LEWIS_23);   // mass-transfer coefficient, m/s
    const effEps = 1 / (1 / WATER_EPS + 1 / lidEps - 1);
    const conv = hc * dT;
    const rad = effEps * SIGMA * (Math.pow(kelvin(Tw), 4) - Math.pow(kelvin(Ts), 4));
    const evap = hm * latentHeat(Tw) * (vapourDensity(Tw) - vapourDensity(Ts));
    return conv + rad + evap;
  }

  function lidGapH(Tw, Ts, lidEps, L) {
    const dT = Tw - Ts;
    if (Math.abs(dT) < 0.1) return lidGapFlux(Tw, Tw - 0.1, lidEps, L) / 0.1;
    return lidGapFlux(Tw, Ts, lidEps, L) / dT;
  }

  // ---- Simulation state -----------------------------------------------------

  function panelDefs(geo, lidded) {
    const defs = [{ key: 'side', A: geo.side, inner: 'water', outer: 'vertical', L: geo.Lside }];
    if (geo.bottom > 0) defs.push({ key: 'bottom', A: geo.bottom, inner: 'water', outer: 'down', L: geo.Lhoriz });
    if (lidded) defs.push({ key: 'lid', A: geo.top, inner: 'gap', outer: 'up', L: geo.Lhoriz });
    return defs;
  }

  function freshNode(T) {
    // T = middle of the wall, Tsi/Tso = inner and outer surface temperatures
    return { T, Tsi: T, Tso: T };
  }

  /*
   * cfg = { waterTemp, ambient, shape, volume (L), material,
   *         thickness (mm), lidded, preheat }
   */
  function createState(cfg) {
    const geo = geometry(cfg.shape, cfg.volume);
    const mass = (cfg.volume / 1000) * WATER_RHO;
    const wallStart = cfg.preheat ? cfg.waterTemp : cfg.ambient;
    const state = {
      t: 0,
      geo,
      water: { T: cfg.waterTemp, mass, startMass: mass, startT: cfg.waterTemp },
      nodes: { side: freshNode(wallStart), bottom: freshNode(wallStart), lid: freshNode(wallStart) },
      energyLost: 0,   // J that have left the water
      evaporated: 0,   // kg of water gone as vapour
      milestones: {},  // time (s) at which the water first dropped below 60 °C, 40 °C
      history: [{ t: 0, T: cfg.waterTemp }],
      sampleEvery: 2,  // seconds of sim time between stored graph points
      nextSample: 2,
      last: null,      // most recent heat flows, for the readouts
    };
    state.last = computeFlows(state, cfg);
    return state;
  }

  // Putting a lid on mid-run: the lid starts at room temperature.
  function placeLid(state, cfg) {
    state.nodes.lid = freshNode(cfg.ambient);
  }

  /*
   * Work out every heat flow for the current temperatures. Returns watts for
   * each panel (qin = from water into the panel, qout = panel to room) and for
   * the open water surface.
   */
  function computeFlows(state, cfg) {
    const geo = state.geo;
    const mat = MATERIALS[cfg.material];
    const L = cfg.thickness / 1000;
    const halfWall = L / 2 / mat.k;  // thermal resistance of half the wall, m²K/W
    const Ta = cfg.ambient;
    const Tw = state.water.T;

    const panels = [];
    for (const p of panelDefs(geo, cfg.lidded)) {
      const n = state.nodes[p.key];
      const hin = p.inner === 'water' ? hWater(Tw - n.Tsi) : lidGapH(Tw, n.Tsi, mat.eps, p.L);
      const hout = Math.max(0.5, hAir(p.outer, n.Tso - Ta, p.L) + hRad(n.Tso, Ta, mat.eps));
      // Conductances (W/K): film + half wall in series, on each side of the node
      const Gin = p.A / (1 / hin + halfWall);
      const Gout = p.A / (halfWall + 1 / hout);
      panels.push({
        key: p.key, A: p.A, hin, hout, Gin, Gout,
        C: p.A * L * mat.rho * mat.cp,          // heat capacity of the panel, J/K
        qin: Gin * (Tw - n.T),
        qout: Gout * (n.T - Ta),
      });
    }

    const top = { conv: 0, rad: 0, evap: 0, mdot: 0 };
    if (!cfg.lidded) {
      const A = geo.top;
      const dT = Tw - Ta;
      const hc = hAir('up', dT, geo.Lhoriz);
      top.conv = hc * A * dT;
      top.rad = WATER_EPS * SIGMA * A * (Math.pow(kelvin(Tw), 4) - Math.pow(kelvin(Ta), 4));
      // Evaporation: vapour diffuses from saturated air at the surface into
      // the room (which is only partly humid). Even room-temperature water
      // evaporates a little, so it can cool slightly below the room.
      const hm = Math.max(2, hc) / (AIR_RHO_CP * LEWIS_23);
      top.mdot = Math.max(0, hm * A * (vapourDensity(Tw) - vapourDensity(Ta, RELATIVE_HUMIDITY)));
      top.evap = top.mdot * latentHeat(Tw);
    }

    const walls = panels.reduce((s, p) => s + p.qin, 0);
    const total = walls + top.conv + top.rad + top.evap;
    return { panels, top, total, toRoom: panels.reduce((s, p) => s + p.qout, 0) + top.conv + top.rad + top.evap };
  }

  function recordHistory(state) {
    if (state.t < state.nextSample) return;
    state.history.push({ t: state.t, T: state.water.T });
    state.nextSample = state.t + state.sampleEvery;
    // Keep the history small: when it gets long, drop every other point and
    // sample half as often from now on.
    if (state.history.length > 1500) {
      state.history = state.history.filter((_, i) => i % 2 === 0);
      state.sampleEvery *= 2;
    }
  }

  function checkMilestones(state, before, after) {
    for (const mark of [60, 40]) {
      if (state.milestones[mark] === undefined && before > mark && after <= mark) {
        state.milestones[mark] = state.t;
      }
    }
  }

  /*
   * Move the simulation forward by `seconds` of simulated time. It is split
   * into small steps (explicit Euler). A thin metal wall reacts in a few
   * seconds, so the step is limited by how fast the quickest panel responds.
   */
  function advance(state, cfg, seconds) {
    let remaining = seconds;
    let guard = 0;
    while (remaining > 1e-9 && guard++ < 50000) {
      const f = computeFlows(state, cfg);
      let dt = Math.min(remaining, MAX_DT);
      for (const p of f.panels) dt = Math.min(dt, (0.4 * p.C) / (p.Gin + p.Gout));

      const water = state.water;
      const Tw = water.T;
      for (const p of f.panels) {
        const n = state.nodes[p.key];
        n.T += (dt * (p.qin - p.qout)) / p.C;
        n.Tsi = Tw - p.qin / (p.hin * p.A);
        n.Tso = cfg.ambient + p.qout / (p.hout * p.A);
      }
      const qLeaving = f.total;
      water.T -= (dt * qLeaving) / (water.mass * WATER_CP);
      water.mass = Math.max(water.startMass * 0.02, water.mass - f.top.mdot * dt);

      state.energyLost += qLeaving * dt;
      state.evaporated += f.top.mdot * dt;
      state.t += dt;
      remaining -= dt;
      checkMilestones(state, Tw, water.T);
      recordHistory(state);
      state.last = f;
    }
    state.last = computeFlows(state, cfg);
  }

  const api = {
    MATERIALS, SHAPES, geometry, createState, advance, placeLid, computeFlows,
    constants: { WATER_CP, RELATIVE_HUMIDITY },
  };
  global.HeatSim = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
