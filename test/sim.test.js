import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPyodide } from 'pyodide';

import { runEpisode, makeTask } from '../src/sim/runner.js';
import { makeCar } from '../src/sim/car.js';
import { initPython } from '../src/sim/python.js';
import { EXAMPLES } from '../src/examples.js';

const prelude = readFileSync(new URL('../src/sim/prelude.py', import.meta.url), 'utf8');

/** Minimal JS controller for physics tests. */
const jsController = (loop, setup = () => {}) => {
  let hw;
  return { begin: (h) => void (hw = h), setup: () => setup(hw), loop: (t, s) => loop(hw, t, s) };
};

test('same car + same power-on is deterministic, a new power-on is not', () => {
  const c = () => jsController((hw) => hw.motor(0.6, 0.6));
  const a = runEpisode({ controller: c(), carSeed: 7, runSeed: 0, record: true });
  const b = runEpisode({ controller: c(), carSeed: 7, runSeed: 0, record: true });
  const d = runEpisode({ controller: c(), carSeed: 7, runSeed: 1, record: true });
  assert.deepEqual(a.trace.y, b.trace.y);
  assert.notDeepEqual(a.trace.y, d.trace.y);
});

test('cars differ: open loop curves by a different amount on each car', () => {
  const ends = [1, 2, 3, 4, 5].map((seed) => {
    const { trace } = runEpisode({ controller: jsController((hw) => hw.motor(0.6, 0.6)), carSeed: seed });
    return trace.psi.at(-1);
  });
  assert.equal(new Set(ends.map((v) => v.toFixed(3))).size, 5);
});

test('top speed is plausible for TT motors on 65 mm wheels', () => {
  const { trace } = runEpisode({ controller: jsController((hw) => hw.motor(1, 1)), carSeed: 3 });
  const vmax = Math.max(...trace.v);
  assert.ok(vmax > 0.45 && vmax < 0.9, `vmax ${vmax}`);
});

test('dead band: a small duty does not move the car', () => {
  const { trace } = runEpisode({ controller: jsController((hw) => hw.motor(0.05, 0.05)), carSeed: 2 });
  assert.ok(Math.abs(trace.x.at(-1)) < 0.01, `moved ${trace.x.at(-1)} m`);
});

test('parked gyro reads its bias with realistic noise and warms up', () => {
  const samples = [];
  const temps = [];
  const ctl = jsController(
    (hw, t, s) => {
      if (t > 1 && t < 6) samples.push(s[4]);
      temps.push(s[8]);
    },
    (hw) => hw.configure(42, 1000, -1, -1),
  );
  runEpisode({ controller: ctl, carSeed: 11 });
  const car = makeCar(11);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length);
  assert.ok(Math.abs(mean - car.imu.gyro[2].bias) < 1.0, `mean ${mean} vs bias ${car.imu.gyro[2].bias}`);
  assert.ok(sd > 0.01 && sd < 0.15, `noise sd ${sd}`);
  assert.ok(temps.at(-1) > temps[10] + 0.5, 'board should warm up over 40 s');
  // quantised to 1/131 °/s
  for (const v of samples.slice(0, 50)) assert.ok(Math.abs(v * 131 - Math.round(v * 131)) < 1e-6);
});

test('Python controllers run through Pyodide', async (t) => {
  const py = await initPython(loadPyodide, {}, prelude);

  await t.test('starter example finishes on most cars', () => {
    const starter = EXAMPLES.find((e) => e.id === 'starter').code;
    let finished = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const { result, logs } = runEpisode({ controller: py.controller(starter), carSeed: seed, record: true });
      assert.equal(result.error, null, logs.map((l) => l.text).join('\n'));
      if (result.finished) finished++;
    }
    assert.ok(finished >= 3);
  });

  await t.test('every example runs without errors', () => {
    for (const ex of EXAMPLES) {
      const { result } = runEpisode({ controller: py.controller(ex.code), carSeed: 1, record: false });
      assert.equal(result.error, null, `${ex.id}: ${result.error}`);
    }
  });

  await t.test('runs are isolated: globals do not leak between episodes', () => {
    const code = 'n = 0\ndef loop():\n    global n\n    n += 1\n    plot("n", n)\n';
    const a = runEpisode({ controller: py.controller(code), carSeed: 1 });
    const b = runEpisode({ controller: py.controller(code), carSeed: 1 });
    assert.equal(a.plots.n.v[0], 1);
    assert.equal(b.plots.n.v[0], 1);
  });

  await t.test('errors point at the line in controller.py', () => {
    const syntax = runEpisode({ controller: py.controller('def loop(:\n    pass\n'), carSeed: 1 });
    assert.match(syntax.result.error, /SyntaxError.*line 1/);
    const runtime = runEpisode({
      controller: py.controller('def loop():\n    if now() > 0.05:\n        motors.set(undefined_name, 0)\n'),
      carSeed: 1,
    });
    assert.match(runtime.result.error, /line 3, in loop/);
    assert.match(runtime.result.error, /NameError/);
    const missing = runEpisode({ controller: py.controller('x = 1\n'), carSeed: 1 });
    assert.match(missing.result.error, /needs a loop\(\) function/);
    const badCfg = runEpisode({ controller: py.controller('def setup():\n    imu.configure(dlpf=50)\ndef loop():\n    pass\n'), carSeed: 1 });
    assert.match(badCfg.result.error, /dlpf must be one of/);
  });

  await t.test('a calibrated controller beats the naive one by a wide margin', () => {
    const good = `
bias = 0.0; n = 0; heading = 0.0; integ = 0.0; last = 0.0
def setup():
    set_loop_rate(500)
    imu.configure(dlpf=42, rate=1000)
def loop():
    global bias, n, heading, integ, last
    t = now(); dt = t - last; last = t
    gz = imu.gyro()[2]
    if t < 1.0:
        motors.stop(); return
    if t < 4.0:
        bias += gz; n += 1; motors.stop(); return
    heading += (gz - bias / n) * dt
    e = -heading; integ += e * dt
    base = 0.65 * min(1.0, (t - 4.0) / 0.8)
    u = 0.04 * e + 0.06 * integ
    motors.set(base - u, base + u)
`;
    const score = (code) => {
      let s = 0;
      for (let seed = 1; seed <= 8; seed++) s += runEpisode({ controller: py.controller(code), carSeed: seed, record: false }).result.scoreCm;
      return s / 8;
    };
    const naive = score(EXAMPLES[0].code);
    const better = score(good);
    assert.ok(better < 8, `calibrated mean ${better} cm`);
    assert.ok(naive > better * 3, `naive ${naive} vs calibrated ${better}`);
  });
});

test('a new power-on lands somewhere different; noise 0 removes the randomness inside a power-on', () => {
  // Open loop on the same car: lateral offset after 3 s of driving.
  const yAt3s = (runSeed, noise) =>
    runEpisode({ controller: jsController((hw) => hw.motor(0.6, 0.6)), carSeed: 4, runSeed, noise }).trace.y[300];
  const ys = [1, 2, 3, 4, 5].map((r) => yAt3s(r, 1));
  assert.equal(new Set(ys.map((v) => v.toFixed(4))).size, 5, `each power-on should differ: ${ys}`);
  assert.equal(yAt3s(3, 1), yAt3s(3, 1), 'same power-on replays exactly');
  const quiet = [1, 2, 3].map((r) => yAt3s(r, 0));
  assert.equal(new Set(quiet.map((v) => v.toFixed(4))).size, 3, 'caster and battery still vary per power-on at noise 0');
});

test('noise level scales the gyro noise but keeps the unit offset', () => {
  const stats = (noise) => {
    const v = [];
    const ctl = jsController(
      (hw, t, s) => {
        if (t > 2 && t < 6) v.push(s[4]);
      },
      (hw) => hw.configure(42, 1000, -1, -1),
    );
    runEpisode({ controller: ctl, carSeed: 11, runSeed: 2, noise });
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return { m, sd: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) };
  };
  const quiet = stats(0);
  const real = stats(1);
  const loud = stats(3);
  assert.ok(quiet.sd < 0.006, `noise 0 sd ${quiet.sd} should be only quantisation`);
  assert.ok(loud.sd > real.sd * 2.5, `noise 3 sd ${loud.sd} vs 1 ${real.sd}`);
  assert.ok(Math.abs(quiet.m - makeCar(11).imu.gyro[2].bias) < 0.4, 'offset stays without noise');
});

test('track length sets the finish line and the rules', () => {
  const task = makeTask(16);
  assert.equal(task.timeLimit, 100);
  assert.equal(task.offTrack, 4);
  const { result } = runEpisode({ controller: jsController((hw) => hw.motor(0.7, 0.7)), carSeed: 9, trackLength: 2, record: false });
  assert.equal(result.task.trackLength, 2);
  if (result.finished) assert.ok(result.finishTime < 8);
  assert.equal(makeTask(4).timeLimit, 40);
  assert.equal(makeTask(4).dnfPenaltyCm, 100);
});

test('a parked car stays exactly where it is, even on a sloped floor', () => {
  for (const seed of [1, 2, 17]) {
    const { trace } = runEpisode({ controller: jsController((hw) => hw.motor(0, 0)), carSeed: seed, trackLength: 2 });
    assert.equal(trace.x.at(-1), 0);
    assert.equal(trace.psi.at(-1), 0);
  }
});

test('controllers can read the track length and time limit', async () => {
  const py = await initPython(loadPyodide, {}, prelude);
  const code = 'def setup():\n    print(track_length(), time_limit())\ndef loop():\n    pass\n';
  const { logs } = runEpisode({ controller: py.controller(code), carSeed: 1, trackLength: 16, record: false });
  assert.equal(logs[0].text, '16.0 100.0');
});
