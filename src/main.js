import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './style.css';

import { createEditor } from './ui/editor.js';
import { ChartGroup, escapeHtml } from './ui/charts.js';
import { TrackView } from './ui/track.js';
import { encodeState, decodeState } from './ui/share.js';
import { EXAMPLES } from './examples.js';
import { makeTask, TRACK_LENGTHS, DEFAULT_TRACK } from './sim/runner.js';
import { NOMINAL, makeCar } from './sim/car.js';

const $ = (id) => document.getElementById(id);
const BENCH_SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const BENCH_POWER_ON = 1; // fixed, so the same code always gets the same score
const STORAGE_KEY = 'straight-line.controller.py';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---- Python engine (Pyodide in a worker) ---------------------------------------------------

class Engine {
  constructor(indexURL, onReady) {
    this.indexURL = indexURL;
    this.onReady = onReady;
    this.nextId = 1;
    this.pending = new Map();
    this.spawn();
  }

  spawn() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.receive(e.data);
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'The Python worker crashed.'));
      this.pending.clear();
    };
    this.ready = this.request('init', {}, { timeoutMs: 120000 }).then((m) => {
      this.onReady?.(m.version);
      return m;
    });
  }

  receive(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.kind === 'progress') {
      p.arm();
      p.onProgress?.(msg);
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.kind === 'fatal') p.reject(new Error(msg.error));
    else p.resolve(msg);
  }

  request(kind, payload, { timeoutMs = 30000, onProgress } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, onProgress, timer: 0 };
      entry.arm = () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          this.restart();
          reject(new Error(`Stopped after ${Math.round(timeoutMs / 1000)} s without an answer. Is there a loop in your code that never ends?`));
        }, timeoutMs);
      };
      entry.arm();
      this.pending.set(id, entry);
      this.worker.postMessage({ id, kind, indexURL: this.indexURL, ...payload });
    });
  }

  restart() {
    this.worker.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('The Python worker was restarted.'));
    }
    this.pending.clear();
    this.spawn();
  }
}

// ---- state & elements ------------------------------------------------------------------------

const els = {
  run: $('run'),
  evaluate: $('evaluate'),
  share: $('share'),
  carSeed: $('carSeed'),
  runSeed: $('runSeed'),
  repeat: $('repeat'),
  powerOnNote: $('powerOnNote'),
  lengths: $('lengths'),
  noise: $('noise'),
  noiseOut: $('noiseOut'),
  example: $('example'),
  console: $('console'),
  tiles: $('tiles'),
  play: $('play'),
  playIcon: $('playIcon'),
  speed: $('speed'),
  scrub: $('scrub'),
  clock: $('clock'),
  zoom: $('zoom'),
  csv: $('csv'),
  evalBody: $('evalBody'),
  carBody: $('carBody'),
};

let engineReady = false;
let busy = false;
let last = null; // last run output
let prevTrace = null;

// ---- test conditions -----------------------------------------------------------------------

els.lengths.innerHTML = TRACK_LENGTHS.map(
  (L) => `<label><input type="radio" name="length" value="${L}"${L === DEFAULT_TRACK ? ' checked' : ''} />${L} m</label>`,
).join('');

const trackLength = () => Number(els.lengths.querySelector('input:checked')?.value) || DEFAULT_TRACK;
const noiseLevel = () => Number(els.noise.value);

function setTrackLength(L) {
  const input = els.lengths.querySelector(`input[value="${L}"]`);
  if (input) input.checked = true;
  track.setLength(trackLength());
}

function updateNoiseLabel() {
  const v = noiseLevel();
  els.noiseOut.textContent = v === 0 ? '0× none' : v === 1 ? '1× realistic' : `${v}×`;
}

function updatePowerOnNote() {
  els.powerOnNote.textContent = els.repeat.checked
    ? els.runSeed.value
      ? `Run replays power-on ${els.runSeed.value} exactly.`
      : 'Type the power-on number to replay.'
    : 'Each run switches the car on afresh.';
}

const randomPowerOn = () => 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 99999);
const powerOnFor = () => {
  if (els.repeat.checked && Number(els.runSeed.value) >= 1) return Math.floor(Number(els.runSeed.value));
  const seed = randomPowerOn();
  els.runSeed.value = seed;
  return seed;
};

els.noise.addEventListener('input', updateNoiseLabel);
els.lengths.addEventListener('change', () => track.setLength(trackLength()));
els.repeat.addEventListener('change', updatePowerOnNote);
els.runSeed.addEventListener('input', () => {
  els.repeat.checked = els.runSeed.value !== '';
  updatePowerOnNote();
});

const track = new TrackView($('track'), DEFAULT_TRACK);
const charts = new ChartGroup($('charts'));
charts.onSeek = (t) => seek(t);

// ---- editor & initial code -----------------------------------------------------------------

let saveTimer = 0;
const editor = createEditor($('editor'), '', {
  onChange(text) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, text);
      } catch {
        /* storage may be unavailable (private mode); nothing to do */
      }
    }, 400);
  },
  onRun: () => run(),
  onEvaluate: () => evaluate(),
});

els.example.innerHTML = `<option value="">Load an example…</option>${EXAMPLES.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')}`;
els.example.addEventListener('change', () => {
  const ex = EXAMPLES.find((e) => e.id === els.example.value);
  els.example.value = '';
  if (!ex) return;
  const current = editor.value.trim();
  const isExample = EXAMPLES.some((e) => e.code.trim() === current);
  if (current && !isExample && !confirm(`Replace your code with "${ex.name}"? Your current code will be lost unless you copied a share link.`)) return;
  editor.value = ex.code;
});

(async () => {
  const shared = await decodeState(location.hash);
  let code = null;
  if (shared) {
    if (shared.carSeed) els.carSeed.value = shared.carSeed;
    if (shared.runSeed) {
      els.runSeed.value = shared.runSeed;
      els.repeat.checked = true;
    }
    if (shared.trackLength) setTrackLength(shared.trackLength);
    if (shared.noise != null) els.noise.value = shared.noise;
    updateNoiseLabel();
    updatePowerOnNote();
    if (shared.code) code = shared.code;
    if (shared.error) toast(shared.error);
  }
  if (code == null) {
    try {
      code = localStorage.getItem(STORAGE_KEY);
    } catch {
      code = null;
    }
  }
  editor.value = code ?? EXAMPLES[0].code;
  renderCarTab();
})();

// ---- engine --------------------------------------------------------------------------------

const engine = new Engine(new URL(`${import.meta.env.BASE_URL}pyodide/`, location.href).href, (version) => {
  engineReady = true;
  setBusy(false);
  sysLine(`Python ${version} is ready. Run tries your controller on car ${carSeed()}.`);
});
engine.ready.catch((e) => {
  els.run.textContent = 'Python failed to load';
  consoleLine('error', `Python could not start: ${e.message}. Reload the page to try again.`);
});

function setBusy(on, label) {
  busy = on;
  els.run.disabled = on || !engineReady;
  els.evaluate.disabled = on || !engineReady;
  els.run.textContent = !engineReady ? 'Loading Python…' : on ? label || 'Running…' : 'Run';
}

const carSeed = () => Math.max(1, Math.floor(Number(els.carSeed.value) || 1));

for (const st of document.querySelectorAll('.stepper')) {
  const input = st.querySelector('input');
  for (const b of st.querySelectorAll('.step')) {
    b.addEventListener('click', () => {
      const v = Math.max(Number(input.min), (Math.floor(Number(input.value)) || 0) + Number(b.dataset.step));
      input.value = v;
      input.dispatchEvent(new Event('change'));
    });
  }
}
els.carSeed.addEventListener('change', renderCarTab);

// ---- run -----------------------------------------------------------------------------------

/** @param powerOn  replay this power-on instead of following the Repeat setting */
async function run(seed = carSeed(), powerOn = null) {
  if (busy || !engineReady) return;
  els.carSeed.value = seed;
  const runSeed = powerOn ?? powerOnFor();
  if (powerOn != null) els.runSeed.value = powerOn;
  updatePowerOnNote();
  const L = trackLength();
  const noise = noiseLevel();
  setBusy(true, 'Running…');
  stopPlayback();
  clearConsole();
  sysLine(`Car ${seed}, power-on ${runSeed}, ${L} m track, noise ${noise}×`);
  try {
    const msg = await engine.request('run', { code: editor.value, carSeed: seed, runSeed, trackLength: L, noise });
    showRun(msg.out);
  } catch (e) {
    consoleLine('error', e.message);
    renderTiles(null, e.message);
  } finally {
    setBusy(false);
  }
}

function showRun(out) {
  for (const l of out.logs) consoleLine(l.kind, l.text, l.t);
  // Compare against the previous run only if it was on the same track.
  if (last?.result?.task?.trackLength !== out.result.task.trackLength) prevTrace = null;
  else if (last?.trace?.t?.length > 1) prevTrace = last.trace;
  last = out;
  renderTiles(out.result);
  renderCarTab();
  if (!out.trace || !out.trace.t.length) {
    els.play.disabled = true;
    els.scrub.disabled = true;
    els.csv.disabled = true;
    charts.set([], 1);
    return;
  }
  track.setRun(out.trace, out.result, out.car);
  renderCharts(out);
  els.play.disabled = false;
  els.scrub.disabled = false;
  els.csv.disabled = false;
  if (reducedMotion.matches) seek(duration());
  else {
    seek(0);
    startPlayback();
  }
}

function fmtSigned(v, digits) {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
}

function renderTiles(r, errorText) {
  if (!r) {
    els.tiles.innerHTML = `<p class="empty">${errorText ? `<span class="status bad">Run failed.</span> ${escapeHtml(errorText)}` : 'Run your controller to see how far from the line it finishes.'}</p>`;
    return;
  }
  const TASK = r.task;
  const cell = (label, value, sub, main = false) =>
    `<div class="cell${main ? ' main' : ''}"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const widest = `${(r.maxAbsY * 100).toFixed(2)}<small>cm</small>`;
  if (r.finished) {
    els.tiles.innerHTML =
      cell('Off the line at the finish', `${fmtSigned(r.finishY * 100, 2)}<small>cm</small>`, `<span class="status good">Finished, car ${r.carSeed}, power-on ${r.runSeed}</span>`, true) +
      cell('Heading at the finish', `${fmtSigned(r.finishHeading, 2)}<small>°</small>`, 'positive is to the left') +
      cell('Widest off the line', widest, 'anywhere on the way') +
      cell('Time to finish', `${r.finishTime.toFixed(2)}<small>s</small>`, `limit ${TASK.timeLimit} s from power-on`);
  } else {
    const why =
      r.endReason === 'off track'
        ? `<span class="status bad">Left the track</span>`
        : r.endReason === 'error'
          ? `<span class="status bad">Stopped by an error</span>`
          : `<span class="status warn">Did not reach the finish in ${TASK.timeLimit} s</span>`;
    const dist = last?.trace?.x?.length ? last.trace.x.at(-1) : 0;
    els.tiles.innerHTML =
      cell('Result', r.endReason === 'off track' ? 'Off track' : r.endReason === 'error' ? 'Error' : 'Too slow', why, true) +
      cell('Distance covered', `${Math.max(0, dist).toFixed(2)}<small>m</small>`, `of ${TASK.trackLength} m`) +
      cell('Widest off the line', widest, '') +
      cell('Benchmark counts it as', `${TASK.dnfPenaltyCm}<small>cm</small>`, 'when a car does not finish');
  }
}

function renderCharts(out) {
  const tr = out.trace;
  const t = tr.t;
  const series = (arr, f = (v) => v) => ({ t, v: arr.map(f) });
  const deg = (r) => (r * 180) / Math.PI;
  const specs = [];

  const offSeries = [{ name: 'this run', color: '--series-1' }];
  const offData = [series(tr.y, (v) => v * 100)];
  if (prevTrace) {
    offSeries.unshift({ name: 'previous run', color: '--series-ghost' });
    offData.unshift({ t: prevTrace.t, v: prevTrace.y.map((v) => v * 100) });
  }
  specs.push({ title: 'Off the line', unit: 'cm', series: offSeries, data: offData });
  specs.push({ title: 'Heading, true', unit: '°', series: [{ name: 'heading', color: '--series-1' }], data: [series(tr.psi, deg)] });

  for (const [name, ch] of Object.entries(out.plots || {})) {
    specs.push({ title: name, unit: 'your plot', series: [{ name, color: '--series-1' }], data: [ch] });
  }

  specs.push({ title: 'Gyro z reading', unit: '°/s', series: [{ name: 'gyro z', color: '--series-1' }], data: [series(tr.gyroZ)] });
  specs.push({
    title: 'Motor duty',
    unit: '',
    series: [
      { name: 'left', color: '--series-1' },
      { name: 'right', color: '--series-2' },
    ],
    data: [series(tr.dutyL), series(tr.dutyR)],
    digits: 3,
  });
  specs.push({
    title: 'Wheel speed',
    unit: 'rad/s',
    series: [
      { name: 'left', color: '--series-1' },
      { name: 'right', color: '--series-2' },
    ],
    data: [series(tr.wL), series(tr.wR)],
  });
  specs.push({ title: 'IMU temperature, true', unit: '°C', series: [{ name: 'die', color: '--series-1' }], data: [series(tr.temp)], digits: 3 });
  specs.push({ title: 'Battery', unit: 'V', series: [{ name: 'battery', color: '--series-1' }], data: [series(tr.vbat)], digits: 3 });

  // Show the previous run too, but don't let a much longer one squash this run.
  const tMax = Math.max(t.at(-1), prevTrace ? Math.min(prevTrace.t.at(-1), t.at(-1) * 2) : 0) || 1;
  charts.set(specs, tMax);
}

// ---- playback ------------------------------------------------------------------------------

let playing = false;
let playTime = 0;
let lastFrame = 0;

const duration = () => (last?.trace?.t?.length ? last.trace.t.at(-1) : 0);

function seek(t) {
  playTime = Math.max(0, Math.min(duration(), t));
  track.setTime(playTime);
  charts.setCursor(playTime);
  els.scrub.value = duration() ? Math.round((playTime / duration()) * 1000) : 0;
  els.clock.textContent = `${playTime.toFixed(2)} s`;
}

function frame(ts) {
  if (!playing) return;
  const dt = lastFrame ? (ts - lastFrame) / 1000 : 0;
  lastFrame = ts;
  seek(playTime + dt * Number(els.speed.value));
  if (playTime >= duration()) {
    stopPlayback();
    return;
  }
  requestAnimationFrame(frame);
}

function startPlayback() {
  if (!duration()) return;
  if (playTime >= duration()) seek(0);
  playing = true;
  lastFrame = 0;
  els.play.setAttribute('aria-label', 'Pause');
  els.playIcon.setAttribute('d', 'M4 2.5h3v11H4zM9 2.5h3v11H9z');
  requestAnimationFrame(frame);
}

function stopPlayback() {
  playing = false;
  els.play.setAttribute('aria-label', 'Play');
  els.playIcon.setAttribute('d', 'M4 2.5v11l9-5.5z');
}

els.play.addEventListener('click', () => (playing ? stopPlayback() : startPlayback()));
els.scrub.addEventListener('input', () => {
  stopPlayback();
  seek((Number(els.scrub.value) / 1000) * duration());
});
els.zoom.addEventListener('change', () => track.setZoom(els.zoom.value));

// ---- benchmark -----------------------------------------------------------------------------

async function evaluate() {
  if (busy || !engineReady) return;
  selectTab('t-eval');
  const L = trackLength();
  const noise = noiseLevel();
  setBusy(true, 'Running…');
  els.evaluate.textContent = 'Evaluating…';
  els.evalBody.innerHTML = `<p>Running your controller on cars 1 to 20, ${L} m track, noise ${noise}×…</p><div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="20" aria-valuenow="0"><i style="width:0%"></i></div>`;
  const bar = els.evalBody.querySelector('.progress');
  try {
    const msg = await engine.request(
      'eval',
      { code: editor.value, seeds: BENCH_SEEDS, runSeed: BENCH_POWER_ON, trackLength: L, noise },
      {
        timeoutMs: 30000,
        onProgress: (p) => {
          bar.setAttribute('aria-valuenow', p.done);
          bar.firstElementChild.style.width = `${(p.done / p.total) * 100}%`;
        },
      },
    );
    renderEval(msg.results);
  } catch (e) {
    els.evalBody.innerHTML = `<p><span class="status bad">Benchmark stopped.</span> ${escapeHtml(e.message)}</p>`;
  } finally {
    setBusy(false);
    els.evaluate.textContent = 'Evaluate 20 cars';
  }
}

function renderEval(results) {
  const { task, noise } = results[0];
  if (results.length && results[0].error && results.length < BENCH_SEEDS.length) {
    els.evalBody.innerHTML = `<p><span class="status bad">Your controller stopped with an error on car ${results[0].carSeed}.</span></p><pre class="console">${escapeHtml(results[0].error)}</pre>`;
    return;
  }
  const scores = results.map((r) => r.scoreCm);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const finished = results.filter((r) => r.finished).length;
  const worst = Math.max(...scores);
  const maxBar = Math.max(worst, 0.01);
  const rows = results
    .map((r) => {
      const status = r.finished ? '' : r.endReason === 'error' ? 'Error' : r.endReason === 'off track' ? 'Off track' : 'Too slow';
      const off = r.finished ? fmtSigned(r.finishY * 100, 2) : '—';
      return `<tr class="clickable" tabindex="0" data-seed="${r.carSeed}">
        <td class="l">Car ${r.carSeed}</td>
        <td class="l">${r.finished ? '<span class="status good">Finished</span>' : `<span class="status bad">${status}</span>`}</td>
        <td>${off}</td>
        <td>${r.finished ? fmtSigned(r.finishHeading, 2) : '—'}</td>
        <td>${r.finished ? r.finishTime.toFixed(2) : '—'}</td>
        <td class="l"><div class="bar-cell"><div class="meter-track"><div class="meter${r.finished ? '' : ' dnf'}" style="width:${Math.max(1, (r.scoreCm / maxBar) * 100)}%"></div></div><span>${r.scoreCm.toFixed(2)}</span></div></td>
      </tr>`;
    })
    .join('');
  els.evalBody.innerHTML = `
    <div class="score">
      <div class="num">${mean.toFixed(2)}<small>cm</small></div>
      <p class="desc">Average distance from the line at the finish over cars 1 to 20 on the ${task.trackLength} m track with noise ${noise}×. Each car gets power-on ${BENCH_POWER_ON}, so the same code always scores the same. A car that does not finish counts as ${task.dnfPenaltyCm} cm. Lower is better.</p>
    </div>
    <div class="score"><div class="facts"><span>Finished <b>${finished} of ${results.length}</b></span><span>Median <b>${median.toFixed(2)} cm</b></span><span>Worst <b>${worst.toFixed(2)} cm</b></span></div></div>
    <table class="data">
      <thead><tr><th class="l">Car</th><th class="l">Result</th><th>Off the line, cm</th><th>Heading, °</th><th>Time, s</th><th class="l">Score, cm</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">Select a car to replay its benchmark run.</p>`;
  for (const tr of els.evalBody.querySelectorAll('tr.clickable')) {
    const go = () => {
      setTrackLength(task.trackLength);
      els.noise.value = noise;
      updateNoiseLabel();
      run(Number(tr.dataset.seed), BENCH_POWER_ON);
    };
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  }
}

// ---- this car ------------------------------------------------------------------------------

function renderCarTab() {
  const c = makeCar(carSeed());
  const mm = (m) => `${(m * 1000).toFixed(2)} mm`;
  const pct = (v, nominal) => `${fmtSigned(((v - nominal) / nominal) * 100, 1)} %`;
  const gz = c.imu.gyro[2];
  const rows = [
    ['Left wheel radius', mm(c.left.r), pct(c.left.r, NOMINAL.wheelRadius)],
    ['Right wheel radius', mm(c.right.r), pct(c.right.r, NOMINAL.wheelRadius)],
    ['Distance between wheels', mm(c.trackWidth), pct(c.trackWidth, NOMINAL.trackWidth)],
    ['Left motor speed constant', `${c.left.Ke.toFixed(4)} V·s/rad`, pct(c.left.Ke, 0.25)],
    ['Right motor speed constant', `${c.right.Ke.toFixed(4)} V·s/rad`, pct(c.right.Ke, 0.25)],
    ['Left gearbox friction', `${(c.left.tauC * 1000).toFixed(1)} mN·m`, pct(c.left.tauC, 0.012)],
    ['Right gearbox friction', `${(c.right.tauC * 1000).toFixed(1)} mN·m`, pct(c.right.tauC, 0.012)],
    ['Battery when fully charged', `${c.battery.vFull.toFixed(2)} V`, ''],
    ['Floor slope', `${((c.slope * 180) / Math.PI).toFixed(2)}° towards ${Math.round((c.slopeDir * 180) / Math.PI)}°`, ''],
    ['Usual room temperature', `${c.thermal.ambient.toFixed(1)} °C`, ''],
    ['Gyro z offset at 25 °C', `${fmtSigned(gz.bias, 3)} °/s`, ''],
    ['Gyro z temperature drift', `${fmtSigned(gz.tempco, 4)} °/s per °C`, ''],
    ['Gyro z shift with motors running', `${fmtSigned(gz.vre, 3)} °/s at full speed`, ''],
    ['Gyro noise density', `${c.imu.gyroNoise.toFixed(4)} °/s/√Hz`, ''],
    ['IMU mounting twist', `${fmtSigned((c.imu.mountYaw * 180) / Math.PI, 2)}°`, ''],
  ];
  els.carBody.innerHTML = `
    <p>Car ${c.seed} as it actually came off the bench. Your controller never sees these numbers, only their effects through the IMU. Look once you have tried.</p>
    <details class="spoiler">
      <summary>Show car ${c.seed}'s real parameters</summary>
      <table class="data">
        <thead><tr><th class="l">Part</th><th>Value</th><th>Off from the parts list</th></tr></thead>
        <tbody>${rows.map(([a, b, d]) => `<tr><td class="l">${a}</td><td>${b}</td><td>${d}</td></tr>`).join('')}</tbody>
      </table>
      ${powerOnTable(c)}
    </details>`;
}

function powerOnTable(c) {
  const p = last?.result?.powerOn;
  if (!p || last.result.carSeed !== c.seed) return '<p class="note">Run this car to see what its last power-on was like.</p>';
  const rows = [
    ['Gyro z turn-on offset', `${fmtSigned(p.gyroTurnOn, 3)} °/s on top of the unit's own offset`],
    ['Caster angle when put down', `${fmtSigned((p.casterAngle * 180) / Math.PI, 0)}°`],
    ['Battery, unloaded', `${p.batteryVoc.toFixed(2)} V`],
    ['Room temperature', `${p.ambient.toFixed(1)} °C`],
  ];
  return `<table class="data" style="margin-top:18px">
      <thead><tr><th class="l">Power-on ${p.runSeed}</th><th>Value</th></tr></thead>
      <tbody>${rows.map(([a, b]) => `<tr><td class="l">${a}</td><td>${b}</td></tr>`).join('')}</tbody>
    </table>`;
}

// ---- console -------------------------------------------------------------------------------

function clearConsole() {
  els.console.replaceChildren();
}

function consoleLine(kind, text, t) {
  const line = document.createElement('div');
  line.className = kind;
  if (t != null) {
    const ts = document.createElement('span');
    ts.className = 't';
    ts.textContent = `${t.toFixed(3).padStart(7)} s  `;
    line.appendChild(ts);
  }
  line.appendChild(document.createTextNode(kind === 'warn' ? `Warning: ${text}` : text));
  els.console.appendChild(line);
  els.console.scrollTop = els.console.scrollHeight;
}

const sysLine = (text) => consoleLine('sys', text);
$('clearConsole').addEventListener('click', clearConsole);

// ---- CSV, share, tabs, keys ----------------------------------------------------------------

els.csv.addEventListener('click', () => {
  const tr = last?.trace;
  if (!tr) return;
  const cols = [
    ['t_s', tr.t],
    ['x_m', tr.x],
    ['y_m', tr.y],
    ['heading_deg', tr.psi.map((v) => (v * 180) / Math.PI)],
    ['speed_m_s', tr.v],
    ['yaw_rate_deg_s', tr.r.map((v) => (v * 180) / Math.PI)],
    ['duty_left', tr.dutyL],
    ['duty_right', tr.dutyR],
    ['wheel_left_rad_s', tr.wL],
    ['wheel_right_rad_s', tr.wR],
    ['gyro_z_reading_deg_s', tr.gyroZ],
    ['imu_temp_true_C', tr.temp],
    ['battery_V', tr.vbat],
  ];
  const lines = [cols.map((c) => c[0]).join(',')];
  for (let i = 0; i < tr.t.length; i++) lines.push(cols.map((c) => (Number.isFinite(c[1][i]) ? +c[1][i].toPrecision(7) : '')).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `straight-line-car${last.result.carSeed}-on${last.result.runSeed}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

els.share.addEventListener('click', async () => {
  const hash = await encodeState({
    code: editor.value,
    carSeed: carSeed(),
    runSeed: els.repeat.checked ? Number(els.runSeed.value) || 0 : 0,
    trackLength: trackLength(),
    noise: noiseLevel(),
  });
  history.replaceState(null, '', hash);
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied. It holds your code, this car and the test conditions.');
  } catch {
    toast('Link is in the address bar. Copy it from there.');
  }
});

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(id) {
  for (const tab of tabs) {
    const on = tab.id === id;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !on;
  }
  if (id === 't-charts') charts.drawAll();
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab.id));
  tab.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(tab);
    const j = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1;
    if (j >= 0) {
      selectTab(tabs[j].id);
      tabs[j].focus();
    }
  });
}

els.run.addEventListener('click', () => run());
els.evaluate.addEventListener('click', () => evaluate());
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) evaluate();
    else run();
  }
});

els.run.title = 'Run on this car (Ctrl/⌘ + Enter)';
els.evaluate.title = 'Run on cars 1 to 20 (Ctrl/⌘ + Shift + Enter)';
renderTiles(null);
updateNoiseLabel();
updatePowerOnNote();
setBusy(false);
