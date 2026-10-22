// Small-multiple time-series charts on canvas: one y-axis each, shared time axis,
// synchronised hover crosshair + tooltip, playback cursor, click-to-seek.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1], step: 1 };
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { min: lo, max: hi, ticks, step };
}

function decimals(step) {
  return Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
}

/** Index of the sample nearest to time x (t sorted ascending). */
function nearest(t, x) {
  let lo = 0;
  let hi = t.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(t[lo] - x) <= Math.abs(t[hi] - x) ? lo : hi;
}

class LineChart {
  constructor(group, spec) {
    this.group = group;
    this.spec = spec; // {title, unit, series:[{name, color}], digits}
    this.data = spec.series.map(() => ({ t: [], v: [] }));
    this.el = document.createElement('figure');
    this.el.className = 'chart';
    this.el.style.margin = '0';
    this.pad = { l: 42, r: 6, t: 8, b: 20 };
    const legend =
      spec.series.length > 1
        ? `<span class="legend">${spec.series
            .map((s) => `<span class="key"><i style="background:var(${s.color})"></i>${s.name}</span>`)
            .join('')}</span>`
        : '';
    this.el.innerHTML = `<figcaption class="chart-title"><span>${escapeHtml(spec.title)} <span class="unit">${escapeHtml(spec.unit || '')}</span></span>${legend}</figcaption><canvas role="img"></canvas><div class="tooltip" hidden></div>`;
    this.canvas = this.el.querySelector('canvas');
    this.canvas.setAttribute('aria-label', `${spec.title} over time`);
    this.tip = this.el.querySelector('.tooltip');

    this.canvas.addEventListener('pointermove', (e) => group.hoverAt(this.timeAt(e)));
    this.canvas.addEventListener('pointerleave', () => group.hoverAt(null));
    this.canvas.addEventListener('click', (e) => group.onSeek?.(this.timeAt(e)));
  }

  timeAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width - this.pad.l - this.pad.r;
    const f = (e.clientX - rect.left - this.pad.l) / w;
    return Math.max(0, Math.min(1, f)) * this.group.tMax;
  }

  setData(data) {
    this.data = data;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of data)
      for (const v of s.v)
        if (Number.isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
    this.y = niceTicks(lo, hi, 4);
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
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const { l, r, t: pt, b } = this.pad;
    const pw = W - l - r;
    const ph = H - pt - b;
    const tMax = this.group.tMax || 1;
    const y = this.y || niceTicks(0, 1);
    const X = (tt) => l + (tt / tMax) * pw;
    const Y = (v) => pt + (1 - (v - y.min) / (y.max - y.min)) * ph;
    this.X = X;
    this.Y = Y;

    const grid = css('--grid');
    const axis = css('--axis');
    const muted = css('--text-muted');
    g.font = "450 11px 'Archivo Variable', system-ui, sans-serif";
    g.fillStyle = muted;
    g.lineWidth = 1;

    // y gridlines + ticks
    const yd = decimals(y.step);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const v of y.ticks) {
      const yy = Math.round(Y(v)) + 0.5;
      g.strokeStyle = v === 0 ? axis : grid;
      g.beginPath();
      g.moveTo(l, yy);
      g.lineTo(W - r, yy);
      g.stroke();
      g.fillText(v.toFixed(yd), l - 6, yy);
    }
    // x ticks (seconds)
    const xt = niceTicks(0, tMax, Math.max(2, Math.floor(pw / 70)));
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (const v of xt.ticks) {
      if (v > tMax + 1e-9) continue;
      g.fillText(`${v.toFixed(decimals(xt.step))}${v === 0 ? ' s' : ''}`, X(v), H - b + 5);
    }
    g.strokeStyle = axis;
    g.beginPath();
    g.moveTo(l, H - b + 0.5);
    g.lineTo(W - r, H - b + 0.5);
    g.stroke();

    // series
    g.save();
    g.beginPath();
    g.rect(l, pt - 2, pw, ph + 4);
    g.clip();
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    this.spec.series.forEach((s, i) => {
      const d = this.data[i];
      if (!d || !d.t.length) return;
      g.strokeStyle = css(s.color);
      g.beginPath();
      let pen = false;
      // Min/max per pixel column keeps spikes visible without drawing every sample.
      let col = -1;
      let cmin = 0;
      let cmax = 0;
      let clast = 0;
      const flush = () => {
        if (col < 0) return;
        const x = col + 0.5;
        if (!pen) {
          g.moveTo(x, Y(clast));
          pen = true;
        }
        g.lineTo(x, Y(cmin));
        g.lineTo(x, Y(cmax));
        g.lineTo(x, Y(clast));
      };
      for (let k = 0; k < d.t.length; k++) {
        const v = d.v[k];
        if (!Number.isFinite(v)) {
          flush();
          col = -1;
          pen = false;
          continue;
        }
        const px = Math.floor(X(d.t[k]));
        if (px !== col) {
          flush();
          col = px;
          cmin = cmax = v;
        }
        if (v < cmin) cmin = v;
        if (v > cmax) cmax = v;
        clast = v;
      }
      flush();
      g.stroke();
    });
    g.restore();

    // playback cursor
    const cur = this.group.cursor;
    if (cur != null) {
      g.strokeStyle = muted;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(X(cur)) + 0.5, pt);
      g.lineTo(Math.round(X(cur)) + 0.5, H - b);
      g.stroke();
    }

    this.drawHover(g, H, pt, b);
  }

  drawHover(g, H, pt, b) {
    const ht = this.group.hover;
    if (ht == null) {
      this.tip.hidden = true;
      return;
    }
    const X = this.X;
    const Y = this.Y;
    const surface = css('--surface-1');
    const xx = Math.round(X(ht)) + 0.5;
    g.strokeStyle = css('--text-secondary');
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(xx, pt);
    g.lineTo(xx, H - b);
    g.stroke();

    const rows = [];
    this.spec.series.forEach((s, i) => {
      const d = this.data[i];
      const k = d ? nearest(d.t, ht) : -1;
      if (k < 0 || !Number.isFinite(d.v[k])) return;
      const v = d.v[k];
      g.beginPath();
      g.arc(X(d.t[k]), Y(v), 4, 0, 2 * Math.PI);
      g.fillStyle = css(s.color);
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = surface;
      g.stroke();
      rows.push(`<div class="row"><i style="background:var(${s.color})"></i>${escapeHtml(s.name)}<b>${fmt(v, this.spec.digits)}</b></div>`);
    });
    if (!rows.length) {
      this.tip.hidden = true;
      return;
    }
    this.tip.innerHTML = `<div class="muted">t = ${ht.toFixed(2)} s</div>${rows.join('')}`;
    this.tip.hidden = false;
    const cw = this.canvas.clientWidth;
    const left = this.canvas.offsetLeft + X(ht);
    const tipW = this.tip.offsetWidth;
    this.tip.style.left = `${left + 12 + tipW > cw ? left - tipW - 12 : left + 12}px`;
    this.tip.style.top = `${this.canvas.offsetTop + 6}px`;
  }
}

function fmt(v, digits) {
  if (digits != null) return v.toFixed(digits);
  const a = Math.abs(v);
  return v.toFixed(a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

export class ChartGroup {
  constructor(container) {
    this.container = container;
    this.charts = [];
    this.tMax = 1;
    this.cursor = null;
    this.hover = null;
    this.onSeek = null;
    this.ro = new ResizeObserver(() => this.drawAll());
    this.ro.observe(container);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.drawAll());
  }

  /** specs: [{title, unit, series:[{name,color}], data:[{t,v}], digits}] */
  set(specs, tMax) {
    this.container.replaceChildren();
    this.charts = specs.map((s) => {
      const ch = new LineChart(this, s);
      ch.setData(s.data);
      this.container.appendChild(ch.el);
      return ch;
    });
    this.tMax = tMax || 1;
    this.drawAll();
  }

  hoverAt(t) {
    this.hover = t;
    this.drawAll();
  }

  setCursor(t) {
    this.cursor = t;
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.drawAll();
      });
    }
  }

  drawAll() {
    for (const c of this.charts) c.draw();
  }
}
