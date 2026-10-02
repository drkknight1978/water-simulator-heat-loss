/*
 * molecules.js — a small "molecular view" of the water.
 *
 * Each H₂O molecule is drawn as an oxygen atom with two hydrogens. Temperature
 * sets how fast they zoom about and what colour they are (blue = cold,
 * red = hot). When the water freezes, molecules lock into a regular lattice
 * that grows down from the top (ice floats), and unlock again when it melts.
 *
 * The speeds on screen are exaggerated so that cold and hot are easy to tell
 * apart. Real molecules in 5 °C water move at ~570 m/s and in 95 °C water at
 * ~650 m/s, which would be hard to see side by side.
 */
(function (global) {
  'use strict';

  const COLS = 7;
  const ROWS = 6;
  const N = COLS * ROWS;
  const O_R = 5.5;                              // oxygen radius, px
  const H_R = 3.2;                              // hydrogen radius, px
  const H_DIST = 6.8;                           // oxygen–hydrogen distance, px
  const HALF_ANGLE = (52.25 * Math.PI) / 180;   // half of the 104.5° H–O–H angle
  const HIT_R = 8;                              // collision radius, px
  const PAD = 18;

  const BOLTZMANN = 1.380649e-23;
  const WATER_MOLECULE_MASS = 2.99e-26;         // kg

  // Speed on screen (px/s) for a temperature (°C). Frozen at −30, fast by 100.
  function visualSpeed(T) {
    const s = Math.min(1, Math.max(0, (T + 30) / 130));
    return 10 + 190 * Math.pow(s, 1.2);
  }

  // Real mean molecular speed, m/s (kinetic theory: √(8kT / πm)).
  function realSpeed(T) {
    return Math.sqrt((8 * BOLTZMANN * (T + 273.15)) / (Math.PI * WATER_MOLECULE_MASS));
  }

  const mix = (a, b, f) => a.map((v, i) => Math.round(v + (b[i] - v) * f));
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  class MoleculeView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.time = 0;
      this.molecules = [];
      this.resize();
      this.seed();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.w = rect.width;
      this.h = rect.height;
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.layoutSites();
    }

    // Lattice sites, filled from the top row down; odd rows are shifted half a
    // step so each molecule has six neighbours (like the hexagons in ice).
    layoutSites() {
      const dx = (this.w - 2 * PAD) / (COLS - 0.5);
      const dy = (this.h - 2 * PAD) / (ROWS - 1);
      this.dy = dy;
      this.sites = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          this.sites.push({ x: PAD + c * dx + (r % 2) * (dx / 2), y: PAD + r * dy, r, c });
        }
      }
    }

    seed() {
      for (let i = 0; i < N; i++) {
        const angle = Math.random() * Math.PI * 2;
        this.molecules.push({
          x: PAD + Math.random() * (this.w - 2 * PAD),
          y: PAD + Math.random() * (this.h - 2 * PAD),
          vx: Math.cos(angle) * 40, vy: Math.sin(angle) * 40,
          a: Math.random() * Math.PI * 2,         // orientation
          spin: Math.random() < 0.5 ? -1 : 1,
          phase: Math.random() * Math.PI * 2,     // for the vibration in ice
          crystal: false,
        });
      }
    }

    // Move every molecule forward by dt real seconds.
    step(dt, T, ice) {
      const locked = Math.round(ice * N);
      const target = ice >= 1 ? 0 : visualSpeed(T);
      // Free molecules stay below the crystal; the front sits just under the
      // last occupied lattice row.
      const front = locked > 0 ? this.sites[locked - 1].y + this.dy * 0.55 : 0;
      const mols = this.molecules;

      let speedSum = 0;
      let freeCount = 0;
      mols.forEach((m, i) => {
        const wasCrystal = m.crystal;
        m.crystal = i < locked;
        if (m.crystal) {
          // Glide to this molecule's lattice site and stop
          const s = this.sites[i];
          const pull = Math.min(1, dt * 4);
          m.x += (s.x - m.x) * pull;
          m.y += (s.y - m.y) * pull;
          m.vx *= Math.max(0, 1 - dt * 6);
          m.vy *= Math.max(0, 1 - dt * 6);
          return;
        }
        if (wasCrystal) { // just melted: break free in a random direction
          const angle = Math.random() * Math.PI * 2;
          m.vx = Math.cos(angle) * target;
          m.vy = Math.sin(angle) * target;
        }
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        m.a += m.spin * Math.hypot(m.vx, m.vy) * 0.03 * dt;
        speedSum += Math.hypot(m.vx, m.vy);
        freeCount++;
      });

      // Ease the free molecules' average speed towards the target so that
      // heating and cooling visibly speed up and slow down the whole crowd.
      if (freeCount) {
        const mean = speedSum / freeCount;
        const ease = Math.min(1, dt * 2.5);
        if (mean < 1) {
          for (const m of mols) {
            if (m.crystal) continue;
            const angle = Math.random() * Math.PI * 2;
            m.vx = Math.cos(angle) * target * 0.5;
            m.vy = Math.sin(angle) * target * 0.5;
          }
        } else {
          const k = 1 + (target / mean - 1) * ease;
          for (const m of mols) {
            if (m.crystal) continue;
            m.vx *= k;
            m.vy *= k;
          }
        }
      }

      // Walls and the crystal front
      const lo = PAD * 0.5, right = this.w - PAD * 0.5, bottom = this.h - PAD * 0.5;
      for (const m of mols) {
        if (m.crystal) continue;
        const top = Math.max(lo, front + HIT_R);
        if (m.x < lo) { m.x = lo; m.vx = Math.abs(m.vx); }
        if (m.x > right) { m.x = right; m.vx = -Math.abs(m.vx); }
        if (m.y > bottom) { m.y = bottom; m.vy = -Math.abs(m.vy); }
        if (m.y < top) {
          m.vy = Math.abs(m.vy);
          m.y = Math.min(top, m.y + 140 * dt); // drift down out of the crystal region
        }
      }

      this.collide();
    }

    // Elastic collisions between free molecules; locked molecules act as fixed walls.
    collide() {
      const mols = this.molecules;
      const min = 2 * HIT_R;
      for (let i = 0; i < mols.length; i++) {
        for (let j = i + 1; j < mols.length; j++) {
          const a = mols[i], b = mols[j];
          if (a.crystal && b.crystal) continue;
          let dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min || d2 === 0) continue;
          const d = Math.sqrt(d2);
          dx /= d; dy /= d; // unit vector from a to b
          const overlap = min - d;
          if (a.crystal || b.crystal) {
            const free = a.crystal ? b : a;
            const nx = a.crystal ? dx : -dx; // pointing from the locked one to the free one
            const ny = a.crystal ? dy : -dy;
            free.x += nx * overlap;
            free.y += ny * overlap;
            const vn = free.vx * nx + free.vy * ny;
            if (vn < 0) { free.vx -= 2 * vn * nx; free.vy -= 2 * vn * ny; }
          } else {
            a.x -= (dx * overlap) / 2; a.y -= (dy * overlap) / 2;
            b.x += (dx * overlap) / 2; b.y += (dy * overlap) / 2;
            const p = (b.vx - a.vx) * dx + (b.vy - a.vy) * dy; // < 0 when approaching
            if (p < 0) {
              a.vx += p * dx; a.vy += p * dy;
              b.vx -= p * dx; b.vy -= p * dy;
            }
          }
        }
      }
    }

    drawMolecule(m, oxygen, hydrogen, vibration) {
      const ctx = this.ctx;
      let x = m.x, y = m.y;
      if (m.crystal) { // jiggle on the spot; colder ice jiggles less
        x += vibration * Math.sin(this.time * 18 + m.phase);
        y += vibration * Math.cos(this.time * 15 + m.phase * 1.7);
      }
      const a = m.crystal ? Math.PI / 2 + (m.phase % 0.3) : m.a;
      ctx.fillStyle = hydrogen;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(x + H_DIST * Math.cos(a + side * HALF_ANGLE), y + H_DIST * Math.sin(a + side * HALF_ANGLE), H_R, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = oxygen;
      ctx.beginPath();
      ctx.arc(x, y, O_R, 0, Math.PI * 2);
      ctx.fill();
    }

    draw(T, ice) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.fillStyle = '#0c1424';
      ctx.fillRect(0, 0, this.w, this.h);

      const base = tempRGB(T);
      const free = { oxygen: rgba(base, 1), hydrogen: rgba(mix(base, [255, 255, 255], 0.65), 1) };
      const icy = mix(base, [205, 238, 255], 0.55);
      const crystal = { oxygen: rgba(icy, 1), hydrogen: rgba(mix(icy, [255, 255, 255], 0.6), 1) };
      const vibration = 0.6 + 1.6 * Math.min(1, Math.max(0, (T + 40) / 40));

      // Hydrogen bonds holding the crystal together. Each site links to its
      // right-hand neighbour and the two sites below it (odd rows are shifted
      // half a step, so which columns are "below" depends on the row).
      const locked = Math.round(ice * N);
      if (locked > 1) {
        ctx.strokeStyle = 'rgba(190, 230, 255, 0.35)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < locked; i++) {
          const { r, c } = this.sites[i];
          const odd = r % 2 === 1;
          const links = [];
          if (c < COLS - 1) links.push(i + 1);
          if (r < ROWS - 1) {
            const downLeft = odd ? i + COLS : c > 0 ? i + COLS - 1 : -1;
            const downRight = odd ? (c < COLS - 1 ? i + COLS + 1 : -1) : i + COLS;
            links.push(downLeft, downRight);
          }
          for (const j of links) {
            if (j < 0 || j >= locked) continue;
            ctx.moveTo(this.sites[i].x, this.sites[i].y);
            ctx.lineTo(this.sites[j].x, this.sites[j].y);
          }
        }
        ctx.stroke();
      }

      // Motion trails make speed easy to see, then the molecules themselves
      ctx.lineCap = 'round';
      ctx.lineWidth = 5;
      ctx.strokeStyle = rgba(base, 0.28);
      ctx.beginPath();
      for (const m of this.molecules) {
        if (m.crystal) continue;
        ctx.moveTo(m.x - m.vx * 0.07, m.y - m.vy * 0.07);
        ctx.lineTo(m.x, m.y);
      }
      ctx.stroke();
      for (const m of this.molecules) {
        const colours = m.crystal ? crystal : free;
        this.drawMolecule(m, colours.oxygen, colours.hydrogen, vibration);
      }
    }

    update(dt, state) {
      const step = Math.min(0.05, dt);
      this.time += step;
      this.step(step, state.water.T, state.water.ice);
      this.draw(state.water.T, state.water.ice);
    }
  }

  global.MoleculeView = MoleculeView;
  global.moleculeRealSpeed = realSpeed;
})(window);
