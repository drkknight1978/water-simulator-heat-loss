/*
 * chart.js — a small hand-drawn line chart of water temperature over time.
 * Shows the current run plus any "kept" runs so setups can be compared.
 */
(function (global) {
  'use strict';

  const PIN_COLORS = ['#0ea5e9', '#22c55e', '#a855f7', '#eab308', '#14b8a6', '#64748b'];

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Pick a "nice" grid step (1, 2 or 5 × 10ⁿ) so there are roughly `target` lines.
  function niceStep(range, target) {
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
  }

  // Time steps that read well on a clock: seconds, minutes, hours.
  const TIME_STEPS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

  function formatAxisTime(s) {
    if (s >= 3600) return `${+(s / 3600).toFixed(1)} h`;
    if (s >= 60) return `${Math.round(s / 60)} min`;
    return `${s} s`;
  }

  class TempChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
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

    draw(state, cfg, pins) {
      const ctx = this.ctx;
      const pad = { l: 46, r: 14, t: 12, b: 30 };
      const pw = this.w - pad.l - pad.r;
      const ph = this.h - pad.t - pad.b;
      ctx.clearRect(0, 0, this.w, this.h);

      // Axis ranges: time grows with the run (at least 10 min); kept runs are
      // clipped to the same window so they line up with the current one.
      const tMax = Math.max(600, state.t * 1.05);
      let lo = Math.min(cfg.ambient, state.water.T);
      let hi = Math.max(state.water.startT, state.water.T, cfg.ambient);
      for (const p of pins) {
        for (const pt of p.history) { lo = Math.min(lo, pt.T); hi = Math.max(hi, pt.T); }
      }
      lo = Math.floor(lo - 2);
      hi = Math.ceil(hi + 2);

      const X = (t) => pad.l + (t / tMax) * pw;
      const Y = (T) => pad.t + (1 - (T - lo) / (hi - lo)) * ph;

      // Grid + labels
      ctx.font = '11px system-ui, sans-serif';
      ctx.strokeStyle = cssVar('--grid');
      ctx.fillStyle = cssVar('--muted');
      ctx.lineWidth = 1;
      const tStep = TIME_STEPS.find((s) => tMax / s <= 7) || 86400;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let t = 0; t <= tMax; t += tStep) {
        ctx.beginPath(); ctx.moveTo(X(t), pad.t); ctx.lineTo(X(t), pad.t + ph); ctx.stroke();
        ctx.fillText(formatAxisTime(t), X(t), pad.t + ph + 8);
      }
      const yStep = niceStep(hi - lo, 5);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let T = Math.ceil(lo / yStep) * yStep; T <= hi; T += yStep) {
        ctx.beginPath(); ctx.moveTo(pad.l, Y(T)); ctx.lineTo(pad.l + pw, Y(T)); ctx.stroke();
        ctx.fillText(`${T}°`, pad.l - 6, Y(T));
      }

      // Reference lines: room temperature and 60 °C "drinkable"
      this.refLine(Y(cfg.ambient), pad, pw, `room ${cfg.ambient}°`, cssVar('--muted'), 'above');
      if (0 > lo && 0 < hi && cfg.ambient !== 0) this.refLine(Y(0), pad, pw, 'freezing 0°', '#38bdf8', 'above');
      if (60 > lo && 60 < hi) this.refLine(Y(60), pad, pw, 'drinkable 60°', '#f59e0b', 'above');

      // Kept runs, then the live one on top
      ctx.save();
      ctx.beginPath();
      ctx.rect(pad.l, pad.t, pw, ph);
      ctx.clip();
      pins.forEach((p) => this.line(p.history, X, Y, p.color, 2, tMax));
      this.line(state.history.concat([{ t: state.t, T: state.water.T }]), X, Y, '#ef4444', 2.5, tMax);
      ctx.restore();

      // Current point
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(X(state.t), Y(state.water.T), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // `side` puts the label above the line, or below it when the line is near
    // the top of the chart (a hot room would otherwise push it off the edge).
    refLine(y, pad, pw, label, color, side) {
      const ctx = this.ctx;
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      const flip = side === 'above' && y - pad.t < 14;
      ctx.textBaseline = flip ? 'top' : 'bottom';
      ctx.fillText(label, pad.l + pw - 4, flip ? y + 2 : y - 2);
    }

    line(points, X, Y, color, width, tMax) {
      const ctx = this.ctx;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (const p of points) {
        if (p.t > tMax) break;
        if (!started) { ctx.moveTo(X(p.t), Y(p.T)); started = true; } else ctx.lineTo(X(p.t), Y(p.T));
      }
      ctx.stroke();
    }
  }

  global.TempChart = TempChart;
  global.PIN_COLORS = PIN_COLORS;
})(window);
