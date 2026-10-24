// The lab floor, seen from above: speckled concrete, a strip of painter's tape as the line,
// tape across the floor at the start and the finish, and two measuring tapes as the axes.
// Sideways offsets are tiny next to 4 m, so the lateral axis can be stretched; the car keeps
// its true length and only its drawn angle follows the stretch.

import { niceTicks } from './charts.js';
import { Rng } from '../sim/rng.js';
import { isDark, onThemeChange } from './theme.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// Sideways stretch for Fit; below 1 the view is squeezed so a wide miss on a long track still fits.
const FIT_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
const FONT = (w, px) => `${w} ${px}px 'Archivo Variable', system-ui, sans-serif`;

export class TrackView {
  constructor(canvas, trackLength) {
    this.canvas = canvas;
    this.L = trackLength;
    this.trace = null;
    this.prev = null;
    this.result = null;
    this.car = null;
    this.zoomSetting = 'auto';
    this.time = 0;
    this.texture = null;
    this.ro = new ResizeObserver(() => {
      this.texture = null;
      this.draw();
    });
    this.ro.observe(canvas);
    onThemeChange(() => {
      this.texture = null;
      this.draw();
    });
    document.fonts?.ready.then(() => this.draw());
  }

  /** Change the track length. Drops the runs shown, since they were on another track. */
  setLength(L) {
    if (L === this.L) return;
    this.L = L;
    this.trace = this.prev = this.result = null;
    this.draw();
  }

  setRun(trace, result, car) {
    if (result.task.trackLength !== this.L) {
      this.L = result.task.trackLength;
      this.prev = null;
    } else if (this.trace) {
      this.prev = this.trace;
    }
    this.trace = trace;
    this.result = result;
    this.car = car;
    this.time = 0;
    this.draw();
  }

  setZoom(z) {
    this.zoomSetting = z;
    this.draw();
  }

  setTime(t) {
    this.time = t;
    this.draw();
  }

  index() {
    const tr = this.trace;
    if (!tr || !tr.t.length) return -1;
    const dt = tr.t.length > 1 ? tr.t[1] - tr.t[0] : 0.01;
    return Math.max(0, Math.min(tr.t.length - 1, Math.round(this.time / dt)));
  }

  /** Speckled concrete, regenerated only when the canvas size or theme changes. */
  floorTexture(W, H, dpr) {
    if (this.texture && this.texture.w === W && this.texture.h === H) return this.texture.c;
    const c = document.createElement('canvas');
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const dark = isDark();
    g.fillStyle = css('--floor');
    g.fillRect(0, 0, W, H);
    const rng = new Rng(1234);
    // broad mottling
    for (let i = 0; i < 26; i++) {
      const x = rng.uniform(0, W);
      const y = rng.uniform(0, H);
      const r = rng.uniform(40, 160);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      const a = rng.uniform(0.02, 0.05);
      const tone = rng.next() < 0.5 ? (dark ? '0,0,0' : '255,255,255') : dark ? '255,255,255' : '90,95,88';
      grad.addColorStop(0, `rgba(${tone},${a})`);
      grad.addColorStop(1, `rgba(${tone},0)`);
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    // aggregate specks
    const n = Math.round((W * H) / 26);
    for (let i = 0; i < n; i++) {
      const x = rng.uniform(0, W);
      const y = rng.uniform(0, H);
      const s = rng.next() < 0.92 ? 1 : 1.8;
      const k = rng.next();
      g.fillStyle = dark
        ? k < 0.5
          ? 'rgba(0,0,0,0.35)'
          : 'rgba(255,255,255,0.06)'
        : k < 0.55
          ? 'rgba(70,74,68,0.16)'
          : 'rgba(255,255,255,0.4)';
      g.fillRect(x, y, s, s);
    }
    this.texture = { w: W, h: H, c };
    return c;
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.floorTexture(W, H, dpr), 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const dark = isDark();
    const ruleW = 46; // lateral measuring tape
    const tapeH = 26; // distance measuring tape
    const x0 = -0.32;
    const x1 = this.L + 0.22;
    const left = ruleW + 8;
    const sx = (W - left - 12) / (x1 - x0);
    const top = 10;
    const bottom = H - tapeH - 6;
    const cy = (top + bottom) / 2;

    let zoom;
    if (this.zoomSetting === 'auto') {
      const maxY = Math.max(this.maxAbsY(this.trace), this.maxAbsY(this.prev), 0.004);
      const room = (bottom - top) / 2 - 14;
      zoom = FIT_STEPS.filter((z) => maxY * sx * z <= room).pop() || FIT_STEPS[0];
    } else {
      zoom = Number(this.zoomSetting);
    }
    this.currentZoom = zoom;
    const X = (x) => left + (x - x0) * sx;
    const Y = (y) => cy - y * sx * zoom;

    // slab joints (a groove: dark line + light line)
    for (let jx = 1.3; jx < this.L; jx += 1.6) {
      const xx = Math.round(X(jx)) + 0.5;
      g.strokeStyle = dark ? 'rgba(0,0,0,0.55)' : 'rgba(60,64,58,0.22)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(xx, 0);
      g.lineTo(xx, H);
      g.stroke();
      g.strokeStyle = dark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.55)';
      g.beginPath();
      g.moveTo(xx + 1, 0);
      g.lineTo(xx + 1, H);
      g.stroke();
    }

    // lateral reference lines, like chalk
    const halfM = (bottom - top) / 2 / (sx * zoom);
    const yt = niceTicks(-halfM * 100, halfM * 100, 4);
    const ticks = yt.ticks.filter((v) => Y(v / 100) > top + 4 && Y(v / 100) < bottom - 4);
    g.strokeStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.6)';
    g.lineWidth = 1;
    for (const v of ticks) {
      if (v === 0) continue;
      const yy = Math.round(Y(v / 100)) + 0.5;
      g.beginPath();
      g.moveTo(left, yy);
      g.lineTo(W, yy);
      g.stroke();
    }

    // painter's tape: the line, the start and the finish
    const tape = css('--tape');
    this.tapeStrip(g, X(-0.26), Y(0) - 5, X(this.L + 0.16) - X(-0.26), 10, tape, false, 7);
    this.tapeStrip(g, X(0) - 5, top - 4, 10, bottom - top + 8, tape, true, 3);
    this.tapeStrip(g, X(this.L) - 5, top - 4, 10, bottom - top + 8, tape, true, 5);
    g.fillStyle = css('--ink-2');
    g.font = FONT(600, 12);
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.fillText('start', X(0) + 9, top);
    g.textAlign = 'right';
    g.fillText('finish', X(this.L) - 9, top);

    // the run(s)
    if (this.prev) this.path(g, this.prev, this.prev.t.length - 1, X, Y, css('--series-ghost'), 2);
    const tr = this.trace;
    let k = -1;
    if (tr && tr.t.length) {
      k = this.index();
      this.path(g, tr, k, X, Y, css('--path'), 2.5);
      this.drawCar(g, tr.x[k], tr.y[k], tr.psi[k], X, Y, sx, zoom, tr.caster[k]);
    } else {
      this.drawCar(g, 0, 0, 0, X, Y, sx, zoom, 0.9);
      g.fillStyle = css('--ink');
      g.font = FONT(600, 15);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('Press Run to switch the car on', (X(0) + X(this.L)) / 2, cy - 34);
    }

    const res = this.result;
    if (res && res.finished && tr && k === tr.t.length - 1) this.finishLabel(g, X(this.L), Y(res.finishY), res.finishY, top, bottom);

    this.lateralRule(g, ruleW, top, bottom, ticks, Y, zoom);
    this.distanceTape(g, X, sx, H - tapeH, tapeH, W);
  }

  tapeStrip(g, x, y, w, h, color, vertical, seed) {
    const rng = new Rng(seed);
    const jag = (n) => Array.from({ length: n }, () => rng.uniform(0, 2.2));
    g.save();
    g.globalAlpha = 0.62;
    g.fillStyle = color;
    g.beginPath();
    if (vertical) {
      const a = jag(5);
      const b = jag(5);
      g.moveTo(x, y + a[0]);
      for (let i = 1; i < 5; i++) g.lineTo(x + (w * i) / 4, y + a[i]);
      g.lineTo(x + w, y + h - b[0]);
      for (let i = 1; i < 5; i++) g.lineTo(x + w - (w * i) / 4, y + h - b[i]);
    } else {
      const a = jag(5);
      const b = jag(5);
      g.moveTo(x + a[0], y);
      g.lineTo(x + w - b[0], y);
      for (let i = 1; i < 5; i++) g.lineTo(x + w - b[i], y + (h * i) / 4);
      g.lineTo(x + a[4], y + h);
      for (let i = 3; i >= 1; i--) g.lineTo(x + a[i], y + (h * i) / 4);
    }
    g.closePath();
    g.fill();
    // a faint crease along the tape
    g.globalAlpha = 0.18;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1;
    g.beginPath();
    if (vertical) {
      g.moveTo(x + w * 0.35, y + 3);
      g.lineTo(x + w * 0.35, y + h - 3);
    } else {
      g.moveTo(x + 4, y + h * 0.35);
      g.lineTo(x + w - 4, y + h * 0.35);
    }
    g.stroke();
    g.restore();
  }

  lateralRule(g, w, top, bottom, ticks, Y, zoom) {
    const x = 6;
    g.fillStyle = css('--measure');
    g.beginPath();
    g.roundRect(x, top - 4, w - 8, bottom - top + 8, 3);
    g.fill();
    g.fillStyle = '#1b1b18';
    g.strokeStyle = '#1b1b18';
    g.lineWidth = 1;
    // Label in metres once the ticks are a metre or more apart.
    const metres = ticks.some((v) => Math.abs(v) >= 100);
    g.font = FONT(700, 11);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const v of ticks) {
      const yy = Math.round(Y(v / 100)) + 0.5;
      g.beginPath();
      g.moveTo(x + w - 8, yy);
      g.lineTo(x + w - 16, yy);
      g.stroke();
      const val = metres ? Math.abs(v) / 100 : Math.abs(v);
      const label = `${v > 0 ? '+' : v < 0 ? '−' : ''}${Number(val.toFixed(2))}`;
      g.fillText(label, x + w - 19, yy);
    }
    g.font = FONT(600, 10);
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillText(metres ? 'm' : 'cm', x + (w - 8) / 2, top);
    g.textBaseline = 'bottom';
    g.fillText(zoom === 1 ? '1:1' : `×${zoom}`, x + (w - 8) / 2, bottom);
  }

  distanceTape(g, X, sx, y, h, W) {
    const x0 = X(0);
    const x1 = Math.min(W - 4, X(this.L + 0.18));
    g.fillStyle = '#9a9c97';
    g.fillRect(x0 - 5, y + 3, 6, h - 8); // the metal hook
    g.fillStyle = css('--measure');
    g.fillRect(x0, y + 1, x1 - x0, h - 4);
    g.strokeStyle = '#1b1b18';
    g.fillStyle = '#1b1b18';
    g.lineWidth = 1;
    g.font = FONT(700, 10.5);
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    // Tick and label spacing that stay readable from a 2 m to a 32 m track.
    const step = [1, 5, 10, 50, 100].find((cm) => (cm / 100) * sx >= 4) ?? 100; // cm
    const every = [50, 100, 200, 500, 1000].find((cm) => (cm / 100) * sx >= 60) ?? 1000;
    const mid = every / 2;
    for (let cm = 0; cm <= (this.L + 0.18) * 100 + 1e-6; cm += step) {
      const xx = Math.round(X(cm / 100)) + 0.5;
      if (xx > x1) break;
      const len = cm % every === 0 ? 11 : cm % mid === 0 || cm % (step * 10) === 0 ? 7 : 4;
      g.beginPath();
      g.moveTo(xx, y + 1);
      g.lineTo(xx, y + 1 + len);
      g.stroke();
      if (cm % every === 0 && cm > 0 && xx + 24 < x1) g.fillText(every >= 100 ? `${cm / 100} m` : String(cm), xx + 2, y + h - 4);
    }
    g.fillStyle = '#d03b3b';
    g.fillRect(Math.round(X(this.L)) - 1, y + 1, 2, h - 4);
  }

  finishLabel(g, px, py, finishY, top, bottom) {
    const txt = `${finishY >= 0 ? '+' : '−'}${Math.abs(finishY * 100).toFixed(2)} cm`;
    g.font = FONT(750, 14);
    const tw = g.measureText(txt).width;
    const bw = tw + 16;
    const bh = 24;
    const above = py - bh - 16 > top;
    const by = Math.max(top, Math.min(bottom - bh, above ? py - bh - 14 : py + 14));
    const bx = px - bw - 18;
    g.strokeStyle = css('--ink');
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(px, py);
    g.lineTo(bx + bw, by + bh / 2);
    g.stroke();
    g.fillStyle = css('--paper');
    g.beginPath();
    g.roundRect(bx, by, bw, bh, 4);
    g.fill();
    g.stroke();
    g.fillStyle = css('--ink');
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(txt, bx + bw / 2, by + bh / 2 + 0.5);
    g.beginPath();
    g.arc(px, py, 4, 0, 2 * Math.PI);
    g.fillStyle = css('--path');
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = css('--paper');
    g.stroke();
  }

  maxAbsY(tr) {
    if (!tr) return 0;
    let m = 0;
    for (const v of tr.y) if (Math.abs(v) > m) m = Math.abs(v);
    return Math.min(m, Math.max(1, this.L / 4) * 1.05);
  }

  path(g, tr, upto, X, Y, color, width) {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i <= upto; i++) {
      const px = X(tr.x[i]);
      const py = Y(tr.y[i]);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
  }

  /** Top view of the car: acrylic plate, yellow TT motors, black wheels, blue GY-521, battery. */
  drawCar(g, x, y, psi, X, Y, sx, zoom, caster) {
    const ang = Math.atan(zoom * Math.tan(psi));
    const b = this.car ? this.car.trackWidth : 0.13;
    const s = Math.max(sx, 54 / 0.24); // keep the glyph legible on narrow screens
    const dark = isDark();
    g.save();
    g.translate(X(x), Y(y));
    g.rotate(-ang);
    g.scale(s, s);
    const px = 1 / s;

    // shadow
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.28)';
    g.shadowBlur = 8;
    g.shadowOffsetY = 2;
    g.fillStyle = 'rgba(0,0,0,0.01)';
    g.beginPath();
    g.roundRect(-0.165, -0.064, 0.225, 0.128, 0.018);
    g.fill();
    g.restore();

    // wheels (axle at the origin)
    g.fillStyle = '#1c1d1c';
    for (const side of [1, -1]) {
      g.beginPath();
      g.roundRect(-0.0325, side * (b / 2) - 0.0135, 0.065, 0.027, 0.007);
      g.fill();
    }
    g.strokeStyle = '#3d3f3d';
    g.lineWidth = 1.2 * px;
    for (const side of [1, -1]) {
      for (let k = -2; k <= 2; k++) {
        g.beginPath();
        g.moveTo(k * 0.012, side * (b / 2) - 0.012);
        g.lineTo(k * 0.012, side * (b / 2) + 0.012);
        g.stroke();
      }
    }

    // acrylic chassis plate
    g.fillStyle = dark ? 'rgba(210,225,218,0.28)' : 'rgba(255,255,255,0.72)';
    g.strokeStyle = dark ? 'rgba(230,240,235,0.55)' : 'rgba(40,46,42,0.55)';
    g.lineWidth = 1.2 * px;
    g.beginPath();
    g.roundRect(-0.165, -0.048, 0.225, 0.096, 0.016);
    g.fill();
    g.stroke();

    // TT gear motors, the yellow ones
    g.fillStyle = '#f2c230';
    for (const side of [1, -1]) {
      g.beginPath();
      g.roundRect(-0.035, side > 0 ? 0.012 : -0.042, 0.07, 0.03, 0.005);
      g.fill();
    }
    // battery pack
    g.fillStyle = dark ? '#4a4e4b' : '#3a3e3b';
    g.beginPath();
    g.roundRect(-0.135, -0.03, 0.07, 0.06, 0.006);
    g.fill();
    // GY-521 breakout with the MPU-6050
    g.fillStyle = '#2f6bd8';
    g.beginPath();
    g.roundRect(0.008, -0.011, 0.021, 0.016, 0.002);
    g.fill();
    g.fillStyle = '#111';
    g.fillRect(0.0155, -0.0045, 0.006, 0.006);

    // caster at the back
    g.save();
    g.translate(-0.15, 0);
    g.rotate(-(caster || 0));
    g.fillStyle = dark ? '#9a9d99' : '#6b6f6b';
    g.beginPath();
    g.roundRect(-0.018, -0.006, 0.02, 0.012, 0.004);
    g.fill();
    g.restore();

    // nose mark
    g.fillStyle = css('--path');
    g.beginPath();
    g.moveTo(0.06, 0);
    g.lineTo(0.046, 0.009);
    g.lineTo(0.046, -0.009);
    g.closePath();
    g.fill();
    g.restore();
  }
}
