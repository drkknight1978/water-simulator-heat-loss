/*
 * renderer.js — draws the container as a cut-away side view on a <canvas>.
 * Colours show temperature: the water, each wall panel and the lid are tinted
 * from blue (cold) to red (hot). Ice grows down from the surface as the water
 * freezes. Steam, condensation drops and heat-flow arrows are drawn on top.
 */
(function (global) {
  'use strict';

  // Temperature → colour stops (°C, [r, g, b])
  const TEMP_STOPS = [
    [0, [40, 70, 190]],
    [20, [59, 130, 246]],
    [40, [139, 92, 246]],
    [60, [236, 72, 153]],
    [80, [239, 68, 68]],
    [100, [185, 28, 28]],
  ];

  function tempRGB(T) {
    if (T <= TEMP_STOPS[0][0]) return TEMP_STOPS[0][1];
    for (let i = 1; i < TEMP_STOPS.length; i++) {
      const [t1, c1] = TEMP_STOPS[i];
      if (T <= t1) {
        const [t0, c0] = TEMP_STOPS[i - 1];
        const f = (T - t0) / (t1 - t0);
        return c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
      }
    }
    return TEMP_STOPS[TEMP_STOPS.length - 1][1];
  }

  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  function hexRGB(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, f) {
    return a.map((v, i) => Math.round(v + (b[i] - v) * f));
  }

  // Ice is pale blue-white, and bluer the colder it gets.
  function iceRGB(T) {
    return mix([214, 240, 255], [120, 175, 245], Math.min(1, Math.max(0, -T / 40)));
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  class SceneRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.particles = [];
      this.time = 0;
      this.showArrows = true;
      this.resize();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.w = rect.width;
      this.h = rect.height;
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /*
     * Work out where everything goes in pixels. The container is scaled to
     * fit the canvas whatever its real size, and walls are drawn at least a
     * few pixels thick so thin metal walls are still visible.
     */
    layout(state, cfg) {
      const geo = state.geo;
      const L = cfg.thickness / 1000;
      const tableY = this.h * 0.84;
      // Leave room either side for the heat-flow labels, more so on a narrow screen
      const fitW = (this.w * (this.w < 500 ? 0.5 : 0.62)) / (geo.width + 2 * L);
      const fitH = (this.h * 0.55) / (geo.height + 2 * L);
      const s = Math.min(fitW, fitH);
      const realWall = L * s;
      const wall = Math.min(28, Math.max(4, realWall));
      const iw = geo.width * s;
      const ih = geo.height * s;
      const cx = this.w / 2;
      return {
        s, wall, exaggerated: wall > realWall + 0.5, tableY, cx, iw, ih,
        x0: cx - iw / 2, x1: cx + iw / 2,
        yTop: tableY - wall - ih, yBot: tableY - wall,
      };
    }

    draw(state, cfg, realDt) {
      const ctx = this.ctx;
      this.time += realDt;
      ctx.clearRect(0, 0, this.w, this.h);
      const lay = this.layout(state, cfg);
      const mat = HeatSim.MATERIALS[cfg.material];

      this.drawBackdrop(lay, cfg);
      if (state.geo.kind === 'sphere') this.drawSphere(state, cfg, lay, mat);
      else this.drawVessel(state, cfg, lay, mat);
      this.updateSteam(state, cfg, lay, realDt);
      if (this.showArrows) this.drawArrows(state, cfg, lay);
      this.drawLabels(state, cfg, lay);
    }

    drawBackdrop(lay, cfg) {
      const ctx = this.ctx;
      // Room air tinted very faintly by its temperature
      const air = tempRGB(cfg.ambient);
      const g = ctx.createLinearGradient(0, 0, 0, lay.tableY);
      g.addColorStop(0, rgba(air, 0.02));
      g.addColorStop(1, rgba(air, 0.10));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, lay.tableY);
      // Table
      ctx.fillStyle = cssVar('--table');
      ctx.fillRect(0, lay.tableY, this.w, this.h - lay.tableY);
      ctx.fillStyle = cssVar('--table-edge');
      ctx.fillRect(0, lay.tableY, this.w, 3);
    }

    // Tint a material colour towards its temperature colour.
    wallFill(mat, T, cfg, startT) {
      const base = hexRGB(mat.color);
      const span = Math.max(1, Math.abs(startT - cfg.ambient));
      const heat = Math.min(1, Math.abs(T - cfg.ambient) / span);
      return rgba(mix(base, tempRGB(T), 0.15 + 0.6 * heat), Math.max(mat.opacity, 0.55));
    }

    waterGradient(T, yTop, yBot) {
      const c = tempRGB(T);
      const g = this.ctx.createLinearGradient(0, yTop, 0, yBot);
      g.addColorStop(0, rgba(mix(c, [255, 255, 255], 0.25), 0.85));
      g.addColorStop(1, rgba(mix(c, [0, 0, 40], 0.25), 0.9));
      return g;
    }

    // Water level as a fraction of the container (condensation can add a little)
    waterLevel(state) {
      return Math.min(1, state.water.mass / state.water.startMass);
    }

    // A block of ice with a few cracks. `h` is how deep the ice reaches below
    // the surface; while only part of the water is frozen, its lower edge is
    // the freezing front.
    drawIceBlock(x, y, w, h, T, partial) {
      if (h < 1) return;
      const ctx = this.ctx;
      const c = iceRGB(T);
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, rgba(mix(c, [255, 255, 255], 0.35), 0.95));
      g.addColorStop(1, rgba(c, 0.92));
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      // Cracks: fixed zig-zags, so they don't flicker from frame to frame
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        let cx = x + w * (0.12 + i * 0.19);
        let cy = y + 2;
        ctx.moveTo(cx, cy);
        while (cy < y + h - 4) {
          cx += (((i * 7 + Math.round(cy)) % 3) - 1) * 5;
          cy += 10 + ((i * 5) % 7);
          ctx.lineTo(Math.min(x + w - 2, Math.max(x + 2, cx)), Math.min(y + h, cy));
        }
      }
      ctx.stroke();
      if (partial) { // slushy, uneven freezing front
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let px = x; px <= x + w; px += 4) {
          const py = y + h + Math.sin(px * 0.35) * 1.5;
          if (px === x) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }

    // Cylinders and boxes: a U-shaped wall, water inside, optional lid.
    drawVessel(state, cfg, lay, mat) {
      const ctx = this.ctx;
      const { x0, x1, yTop, yBot, wall, iw, ih } = lay;
      const startT = state.water.startT;
      const cyl = state.geo.kind === 'cylinder';
      const ellH = cyl ? Math.min(iw * 0.12, 14) : 0;   // perspective of the round rim

      // Water
      const level = this.waterLevel(state);
      const surfY = yBot - ih * level;
      ctx.fillStyle = this.waterGradient(state.water.T, surfY, yBot);
      ctx.fillRect(x0, surfY, iw, yBot - surfY);
      const ice = state.water.ice;
      this.drawIceBlock(x0, surfY, iw, (yBot - surfY) * ice, state.water.T, ice < 1);
      const surfaceColour = ice > 0
        ? rgba(mix(iceRGB(state.water.T), [255, 255, 255], 0.5), 0.95)
        : rgba(mix(tempRGB(state.water.T), [255, 255, 255], 0.45), 0.9);
      ctx.fillStyle = surfaceColour;
      if (cyl) {
        ctx.beginPath();
        ctx.ellipse((x0 + x1) / 2, surfY, iw / 2, ellH, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(x0, surfY - 1, iw, 3);
      }
      // Gentle shimmer on an open liquid surface
      if (!cfg.lidded && ice < 0.05) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = x0 + 4; x <= x1 - 4; x += 4) {
          const y = surfY + Math.sin(x * 0.08 + this.time * 3) * 1.2;
          if (x === x0 + 4) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Walls (side and bottom tinted separately)
      ctx.fillStyle = this.wallFill(mat, state.nodes.side.T, cfg, startT);
      ctx.fillRect(x0 - wall, yTop, wall, ih + wall * 0.5);
      ctx.fillRect(x1, yTop, wall, ih + wall * 0.5);
      ctx.fillStyle = this.wallFill(mat, state.nodes.bottom.T, cfg, startT);
      this.roundRect(x0 - wall, yBot, iw + 2 * wall, wall, [0, 0, 6, 6]);
      ctx.fill();
      // Glossy highlight on cylinder walls
      if (cyl) {
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(x0 - wall + 1, yTop, Math.max(1, wall * 0.35), ih);
      }
      ctx.strokeStyle = cssVar('--outline');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 - wall, yTop); ctx.lineTo(x0 - wall, yBot + wall);
      ctx.lineTo(x1 + wall, yBot + wall); ctx.lineTo(x1 + wall, yTop);
      ctx.moveTo(x0, yTop); ctx.lineTo(x0, yBot); ctx.lineTo(x1, yBot); ctx.lineTo(x1, yTop);
      ctx.stroke();

      if (cfg.lidded) {
        const lidY = yTop - wall;
        this.drawDroplets(state, x0, x1, yTop);
        ctx.fillStyle = this.wallFill(mat, state.nodes.lid.T, cfg, startT);
        this.roundRect(x0 - wall - 3, lidY, iw + 2 * wall + 6, wall, 3);
        ctx.fill();
        ctx.stroke();
        const knobW = Math.max(10, iw * 0.14);
        this.roundRect((x0 + x1) / 2 - knobW / 2, lidY - 8, knobW, 8, [4, 4, 0, 0]);
        ctx.fill();
        ctx.stroke();
      }
      this.steamSource = { xa: x0 + 4, xb: x1 - 4, y: surfY };
    }

    // Sphere: a ring with a gap at the top for the opening.
    drawSphere(state, cfg, lay, mat) {
      const ctx = this.ctx;
      const R = lay.iw / 2;
      const cx = lay.cx;
      const cy = lay.yBot - R;
      const w = lay.wall;
      const phi = Math.asin(state.geo.openWidth / state.geo.width); // half-angle of opening
      const startT = state.water.startT;
      const topY = cy - R * Math.cos(phi);

      // Stand
      ctx.fillStyle = cssVar('--stand');
      this.roundRect(cx - R * 0.5, lay.tableY - w - 4, R, w + 4, 4);
      ctx.fill();

      // Water, clipped to the inside of the sphere
      const level = this.waterLevel(state);
      const surfY = lay.yBot - (lay.yBot - topY) * level;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = this.waterGradient(state.water.T, surfY, lay.yBot);
      ctx.fillRect(cx - R, surfY, 2 * R, lay.yBot - surfY);
      const ice = state.water.ice;
      this.drawIceBlock(cx - R, surfY, 2 * R, (lay.yBot - surfY) * ice, state.water.T, ice < 1);
      ctx.restore();

      // Wall ring with an opening
      const a0 = -Math.PI / 2 + phi;
      const a1 = (3 * Math.PI) / 2 - phi;
      ctx.beginPath();
      ctx.arc(cx, cy, R + w, a0, a1);
      ctx.arc(cx, cy, R, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = this.wallFill(mat, state.nodes.side.T, cfg, startT);
      ctx.fill();
      ctx.strokeStyle = cssVar('--outline');
      ctx.lineWidth = 1;
      ctx.stroke();

      const halfOpen = R * Math.sin(phi);
      if (cfg.lidded) {
        // A stopper sitting in the opening
        ctx.fillStyle = this.wallFill(mat, state.nodes.lid.T, cfg, startT);
        ctx.beginPath();
        ctx.moveTo(cx - halfOpen - w, topY - w - 6);
        ctx.lineTo(cx + halfOpen + w, topY - w - 6);
        ctx.lineTo(cx + halfOpen, topY + 2);
        ctx.lineTo(cx - halfOpen, topY + 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      const surfHalf = Math.sqrt(Math.max(0, R * R - (surfY - cy) ** 2));
      this.steamSource = { xa: cx - Math.min(halfOpen, surfHalf), xb: cx + Math.min(halfOpen, surfHalf), y: surfY, exitY: topY };
    }

    // Condensation under the lid when the water is warmer than the lid.
    drawDroplets(state, x0, x1, yTop) {
      const diff = state.water.T - state.nodes.lid.T;
      if (state.water.T < 35 || diff < 1) return;
      const ctx = this.ctx;
      const alpha = Math.min(0.8, diff / 15);
      ctx.fillStyle = `rgba(220,235,255,${alpha})`;
      const n = Math.floor((x1 - x0) / 9);
      for (let i = 0; i < n; i++) {
        const x = x0 + 5 + i * 9 + ((i * 37) % 5);
        const r = 1.2 + ((i * 53) % 3) * 0.6;
        ctx.beginPath();
        ctx.arc(x, yTop + r + 1, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Steam rises from an open surface, more of it when evaporation is strong.
    updateSteam(state, cfg, lay, realDt) {
      const ctx = this.ctx;
      const src = this.steamSource;
      const top = state.last.top;
      if (!cfg.lidded && src && state.geo.top > 0) {
        const flux = top.evap / state.geo.top; // W/m²
        const rate = Math.max(0, Math.min(60, flux / 60)); // particles per real second (none when condensing)
        this.spawnDebt = (this.spawnDebt || 0) + rate * realDt;
        while (this.spawnDebt >= 1) {
          this.spawnDebt -= 1;
          this.particles.push({
            x: src.xa + Math.random() * (src.xb - src.xa),
            y: src.y - 2,
            vy: -(18 + Math.random() * 22),
            phase: Math.random() * Math.PI * 2,
            r: 3 + Math.random() * 3,
            life: 0,
            maxLife: 2 + Math.random() * 1.5,
          });
        }
      }
      const steam = cssVar('--steam');
      this.particles = this.particles.filter((p) => (p.life += realDt) < p.maxLife);
      for (const p of this.particles) {
        p.y += p.vy * realDt;
        p.x += Math.sin(p.phase + p.life * 2.5) * 12 * realDt;
        p.r += 5 * realDt;
        const a = 0.35 * Math.sin((Math.PI * p.life) / p.maxLife);
        ctx.fillStyle = `rgba(${steam},${a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /*
     * One heat-flow arrow. (x, y) is the end next to the container and (dx, dy)
     * points away from it. Heat leaving draws the arrowhead on the far end;
     * heat arriving (a warm room heating the water) flips it to point inwards.
     */
    arrow(x, y, dx, dy, len, alpha, label, inward = false) {
      const ctx = this.ctx;
      const far = { x: x + dx * len, y: y + dy * len };
      const from = inward ? far : { x, y };
      const to = inward ? { x, y } : far;
      const ux = inward ? -dx : dx, uy = inward ? -dy : dy; // direction of travel
      ctx.strokeStyle = `rgba(249,115,22,${alpha})`;
      ctx.fillStyle = `rgba(249,115,22,${alpha})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      const hx = -uy, hy = ux; // perpendicular
      ctx.beginPath();
      ctx.moveTo(to.x + ux * 7, to.y + uy * 7);
      ctx.lineTo(to.x + hx * 6, to.y + hy * 6);
      ctx.lineTo(to.x - hx * 6, to.y - hy * 6);
      ctx.closePath();
      ctx.fill();
      if (label) {
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.fillStyle = cssVar('--text');
        ctx.textAlign = dx < 0 ? 'right' : dx > 0 ? 'left' : 'center';
        ctx.textBaseline = dy < 0 ? 'bottom' : dy > 0 ? 'top' : 'middle';
        ctx.fillText(label, far.x + dx * 12, far.y + dy * 12);
      }
    }

    /*
     * Arrows show heat flowing between each surface and the room. Length grows
     * with the heat flux (W per m²) so surfaces can be compared at a glance.
     * They point outwards when the water is losing heat and inwards when the
     * room is warming it.
     */
    drawArrows(state, cfg, lay) {
      const f = state.last;
      const len = (q, A) => 10 + Math.min(45, Math.sqrt(Math.abs(q) / A) * 1.2);
      const alpha = (q) => (Math.abs(q) > 0.05 ? 0.9 : 0.25);
      const fmt = (q) => `${Math.abs(q).toFixed(Math.abs(q) < 10 ? 1 : 0)} W`;
      const byKey = Object.fromEntries(f.panels.map((p) => [p.key, p]));
      const midY = (lay.yTop + lay.yBot) / 2;
      const sphere = state.geo.kind === 'sphere';
      const R = lay.iw / 2;

      const side = byKey.side;
      if (side) {
        const l = len(side.qout, side.A);
        const edge = lay.wall + 9;
        const y = sphere ? lay.yBot - R : midY;
        const inward = side.qout < 0;
        this.arrow(lay.x0 - edge, y, -1, 0, l, alpha(side.qout), fmt(side.qout / 2), inward);
        this.arrow(lay.x1 + edge, y, 1, 0, l, alpha(side.qout), fmt(side.qout / 2), inward);
      }
      const topQ = cfg.lidded ? (byKey.lid ? byKey.lid.qout : 0) : f.top.conv + f.top.rad + f.top.evap;
      const topY = sphere ? this.steamSource.exitY - lay.wall - 12 : lay.yTop - lay.wall - 14;
      this.arrow(lay.cx + (sphere ? R * 0.55 : lay.iw * 0.3), topY, 0, -1, len(topQ, state.geo.top), alpha(topQ), fmt(topQ), topQ < 0);
      // The bottom sits on the table, so its heat flow is shown as a label only.
      if (byKey.bottom) this.labelBottom(lay, fmt(byKey.bottom.qout), byKey.bottom.qout < 0);
    }

    labelBottom(lay, label, inward) {
      const ctx = this.ctx;
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = cssVar('--text');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${inward ? '↑' : '↓'} ${label}`, lay.x1 + lay.wall + 8, lay.yBot + lay.wall / 2);
    }

    drawLabels(state, cfg, lay) {
      const ctx = this.ctx;
      const ice = state.water.ice;
      let text = `${state.water.T.toFixed(1)} °C`;
      if (ice >= 1) text += ' · ice';
      else if (ice > 0) text += ` · ${Math.round(ice * 100)}% ice`;
      const cy = state.geo.kind === 'sphere' ? lay.yBot - lay.iw / 2 + lay.iw * 0.15 : (lay.yTop + lay.yBot) / 2 + lay.ih * 0.1;
      ctx.font = '700 16px system-ui, sans-serif';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      this.roundRect(lay.cx - tw / 2 - 8, cy - 13, tw + 16, 26, 13);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, lay.cx, cy + 1);

      // Size caption under the table edge
      const g = state.geo;
      const cm = (m) => (m * 100).toFixed(m < 0.1 ? 1 : 0);
      let dims;
      if (g.kind === 'cylinder') dims = `Ø ${cm(g.width)} cm × ${cm(g.height)} cm tall`;
      else if (g.kind === 'box') dims = `${cm(g.width)} × ${cm(g.width)} × ${cm(g.height)} cm`;
      else dims = `Ø ${cm(g.width)} cm sphere, ${cm(g.openWidth)} cm opening`;
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillStyle = cssVar('--muted');
      ctx.textBaseline = 'top';
      const wallText = `${cfg.thickness} mm ${HeatSim.MATERIALS[cfg.material].name.toLowerCase()} wall`
        + (lay.exaggerated ? ' (drawn thicker than scale)' : '');
      const oneLine = `${dims} · ${wallText}`;
      // Split onto two lines when the canvas is too narrow (phones)
      if (ctx.measureText(oneLine).width < this.w - 24) {
        ctx.fillText(oneLine, this.w / 2, lay.tableY + 12);
      } else {
        ctx.fillText(dims, this.w / 2, lay.tableY + 10);
        ctx.fillText(wallText, this.w / 2, lay.tableY + 28);
      }
    }

    roundRect(x, y, w, h, r) {
      const ctx = this.ctx;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
      else ctx.rect(x, y, w, h);
    }
  }

  global.SceneRenderer = SceneRenderer;
  global.tempRGB = tempRGB;
})(window);
