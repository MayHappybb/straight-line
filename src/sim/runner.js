// Runs one episode: power on, call the controller's setup()/loop(), integrate physics and the IMU,
// and judge how straight the car went. Pure JS, no DOM: runs in a Web Worker or under Node.
//
// The controller is language-agnostic (Python via Pyodide in the app, plain JS in tests,
// sandboxed CPython over a pipe for the leaderboard):
//   begin(hw)        -> error string | null   (compile; hw is the hardware bridge below)
//   setup()          -> error string | null
//   loop(t, sample)  -> error string | null   (sample: Float64Array, see Mpu6050.readSample)
// runEpisode() calls them synchronously, runEpisodeAsync() awaits them.

import { makeCar, makePowerOn, CarSim } from './car.js';
import { Mpu6050 } from './mpu6050.js';
import { Rng, hashSeed } from './rng.js';

export const TRACK_LENGTHS = [2, 4, 8, 16, 32]; // m
export const DEFAULT_TRACK = 4;

/** Rules for a track of the given length. Longer tracks get more time and more room sideways. */
export function makeTask(trackLength = DEFAULT_TRACK) {
  const offTrack = Math.max(1, trackLength / 4); // m sideways before the run is stopped
  return {
    trackLength, // m to the finish line
    timeLimit: 20 + 5 * trackLength, // s from power-on
    offTrack,
    dnfPenaltyCm: offTrack * 100, // what a car that does not finish scores
  };
}

export const DT = 1 / 4000; // physics + IMU front end
export const PWM_STEPS = 1000; // duty resolution of the motor driver
const RECORD_HZ = 100;
const MAX_LOG_LINES = 400;
const MAX_PLOT_POINTS = 50000;
export const MAX_PLOT_CHANNELS = 8;

const PATH_BIN = 0.01; // m: path deviation is sampled every centimetre of forward progress

/** Leaderboard rules: the longest track, realistic noise, many hidden cars. */
export const LEADERBOARD = { trackLength: 32, noise: 1, runs: 30 };

/**
 * Summary over many runs, the same for the Benchmark tab and the leaderboard.
 * pathRmseCm: RMS distance from the line over every centimetre of every run (the ranking index).
 * finishRmseCm: RMS distance from the line at the finish.
 * Not finishing counts as the off-track distance for the rest of the track (and at the finish).
 */
export function aggregate(results) {
  const n = results.length || 1;
  const ms = (f) => Math.sqrt(results.reduce((a, r) => a + f(r) ** 2, 0) / n);
  return {
    runs: results.length,
    finished: results.filter((r) => r.finished).length,
    pathRmseCm: ms((r) => r.pathRmseCm),
    finishRmseCm: ms((r) => r.scoreCm),
  };
}

const TRACE_FIELDS = ['t', 'x', 'y', 'psi', 'v', 'r', 'dutyL', 'dutyR', 'wL', 'wR', 'temp', 'gyroZ', 'vbat', 'caster'];

/**
 * @param {object} opt
 * @param {object} opt.controller   see header comment (runEpisode / runEpisodeAsync only)
 * @param {number} opt.carSeed      which car (manufacturing tolerances)
 * @param {number} opt.runSeed      which power-on (turn-on bias, caster, battery, noise sequence)
 * @param {number} opt.noise        scale of all random noise, 1 = realistic
 * @param {number} opt.trackLength  m
 * @param {boolean} opt.record      keep traces for playback/plots
 */
export function runEpisode(opt) {
  const c = opt.controller;
  const call = (fn) => {
    try {
      const r = fn();
      return typeof r === 'string' ? r : null;
    } catch (e) {
      return errorText(e);
    }
  };
  const gen = episode(opt);
  let step = gen.next();
  while (!step.done) {
    const q = step.value;
    step = gen.next(call(() => (q.op === 'loop' ? c.loop(q.t, q.sample) : q.op === 'setup' ? c.setup() : c.begin(q.hw))));
  }
  return step.value;
}

/** Same as runEpisode, for controllers whose methods return promises. */
export async function runEpisodeAsync(opt) {
  const c = opt.controller;
  const call = async (fn) => {
    try {
      const r = await fn();
      return typeof r === 'string' ? r : null;
    } catch (e) {
      return errorText(e);
    }
  };
  const gen = episode(opt);
  let step = gen.next();
  while (!step.done) {
    const q = step.value;
    step = gen.next(await call(() => (q.op === 'loop' ? c.loop(q.t, q.sample) : q.op === 'setup' ? c.setup() : c.begin(q.hw))));
  }
  return step.value;
}

const errorText = (e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** The episode as a generator: it yields each controller call it needs and receives the error (or null). */
function* episode({ carSeed, runSeed = 0, noise = 1, trackLength = DEFAULT_TRACK, record = true }) {
  const TASK = makeTask(trackLength);
  const car = makeCar(carSeed);
  const powerOn = makePowerOn(car, runSeed);
  const sim = new CarSim(car, new Rng(hashSeed(carSeed, runSeed, 0x51ed)), powerOn, noise);
  const imu = new Mpu6050(car.imu, new Rng(hashSeed(carSeed, runSeed, 0x1a2b)), DT, noise);
  imu.wake(0);

  let t = 0;
  let dutyL = 0;
  let dutyR = 0;
  let loopPeriod = 0.01;
  let badMotorValues = 0;
  const logs = [];
  const plots = {};

  const log = (kind, text) => {
    if (logs.length < MAX_LOG_LINES) logs.push({ t, kind, text: String(text) });
    else if (logs.length === MAX_LOG_LINES) logs.push({ t, kind: 'warn', text: `Output limit reached: only the first ${MAX_LOG_LINES} lines are kept.` });
  };

  const quantise = (v) => {
    v = Number(v);
    if (!Number.isFinite(v)) {
      badMotorValues++;
      return 0;
    }
    return Math.round(Math.max(-1, Math.min(1, v)) * PWM_STEPS) / PWM_STEPS;
  };

  const hw = {
    motor(left, right) {
      dutyL = quantise(left);
      dutyR = quantise(right);
    },
    setLoopRate(hz) {
      loopPeriod = 1 / hz;
    },
    configure(dlpfHz, rateHz, gyroRange, accelRange) {
      const opt = (v) => (v === undefined || v === null || v < 0 ? null : v);
      return imu.configure(
        { dlpfHz: opt(dlpfHz), rateHz: opt(rateHz), gyroRange: opt(gyroRange), accelRange: opt(accelRange) },
        t,
      );
    },
    log,
    plot(name, value) {
      if (!record) return;
      let ch = plots[name];
      if (!ch) {
        if (Object.keys(plots).length >= MAX_PLOT_CHANNELS) return;
        ch = plots[name] = { t: [], v: [] };
      }
      if (ch.t.length < MAX_PLOT_POINTS) {
        ch.t.push(t);
        ch.v.push(Number(value));
      }
    },
  };

  const result = {
    carSeed,
    runSeed,
    noise,
    task: TASK,
    finished: false,
    finishTime: null,
    finishY: null,
    finishHeading: null,
    maxAbsY: 0,
    endReason: '',
    error: null,
  };

  const trace = record ? Object.fromEntries(TRACE_FIELDS.map((k) => [k, []])) : null;
  const fail = (err, where) => {
    result.error = err;
    result.endReason = 'error';
    log('error', where ? `${err}\n(${where})` : err);
  };

  const nBins = Math.round(TASK.trackLength / PATH_BIN);
  let bins = 0;
  let sumSq = 0;

  let err = yield { op: 'begin', hw };
  if (!err) err = yield { op: 'setup' };
  if (err) {
    fail(err, null);
    return finish();
  }

  const sample = new Float64Array(9);
  const recordEvery = Math.round(1 / (RECORD_HZ * DT));
  const steps = Math.round(TASK.timeLimit / DT);
  let nextLoop = 0;
  let prevX = 0;
  let prevY = 0;

  for (let k = 0; k <= steps; k++) {
    t = k * DT;

    if (t + 1e-9 >= nextLoop) {
      nextLoop += loopPeriod;
      imu.readSample(sample);
      err = yield { op: 'loop', t, sample };
      if (err) {
        fail(err, `in loop() at t = ${t.toFixed(3)} s`);
        break;
      }
    }

    if (record && k % recordEvery === 0) {
      trace.t.push(t);
      trace.x.push(sim.x);
      trace.y.push(sim.y);
      trace.psi.push(sim.psi);
      trace.v.push(sim.v);
      trace.r.push(sim.r);
      trace.dutyL.push(dutyL);
      trace.dutyR.push(dutyR);
      trace.wL.push(sim.side[0].w);
      trace.wR.push(sim.side[1].w);
      trace.temp.push(imu.Tdie ?? sim.boardTemp());
      trace.gyroZ.push(imu.seq ? imu.get16(0x47) / imu.gyroLsb : NaN);
      trace.vbat.push(sim.Vbat);
      trace.caster.push(sim.caster);
    }

    prevX = sim.x;
    prevY = sim.y;
    sim.step(DT, dutyL, dutyR);
    imu.update(t + DT, sim.imuInputs(), sim.boardTemp());

    const ay = Math.abs(sim.y);
    if (ay > result.maxAbsY) result.maxAbsY = ay;
    while (bins < nBins && sim.x >= (bins + 1) * PATH_BIN) {
      sumSq += sim.y * sim.y;
      bins++;
    }

    if (sim.x >= TASK.trackLength && prevX < TASK.trackLength) {
      const f = (TASK.trackLength - prevX) / (sim.x - prevX);
      result.finished = true;
      result.finishTime = t + f * DT;
      result.finishY = prevY + f * (sim.y - prevY);
      result.finishHeading = (sim.psi * 180) / Math.PI;
      result.endReason = 'finished';
      break;
    }
    if (ay > TASK.offTrack) {
      result.endReason = 'off track';
      break;
    }
  }
  if (!result.endReason) result.endReason = 'time limit';
  if (badMotorValues) log('warn', `motors.set() got a value that is not a number ${badMotorValues} time(s); those were treated as 0.`);
  return finish();

  function finish() {
    result.scoreCm = result.finished ? Math.abs(result.finishY) * 100 : TASK.dnfPenaltyCm;
    // The part of the track the car never covered counts as being off track.
    const missing = nBins - bins;
    result.pathRmseCm = Math.sqrt((sumSq + missing * TASK.offTrack ** 2) / nBins) * 100;
    result.duration = t;
    if (record) result.powerOn = { ...powerOn, gyroTurnOn: imu.turnOn[2] };
    return { result, logs, plots: record ? plots : null, trace, car: record ? car : null };
  }
}
