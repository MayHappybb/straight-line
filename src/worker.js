// Runs the student's Python off the main thread: the page stays responsive, the code has no DOM
// access, and a runaway loop can be stopped by terminating the worker.

import { runEpisode } from './sim/runner.js';
import { initPython } from './sim/python.js';
import prelude from './sim/prelude.py?raw';

let pythonReady = null;

function python(indexURL) {
  if (!pythonReady) {
    pythonReady = (async () => {
      const { loadPyodide } = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
      return initPython(loadPyodide, { indexURL }, prelude);
    })();
  }
  return pythonReady;
}

const conditions = (msg) => ({ noise: msg.noise, trackLength: msg.trackLength });

// Built-ins the simulator relies on. Controller code is blocked from importing `js`, but if it
// finds a way in and changes one of these, the physics can no longer be trusted, for this run or
// any later one, so the page restarts the worker.
const WATCHED = [Math, JSON, Object, Array, Number, Array.prototype, Object.prototype, Function.prototype, Float64Array.prototype, Uint8Array.prototype, Map.prototype, Set.prototype, String.prototype, Promise.prototype];
const WATCHED_GLOBALS = ['Math', 'JSON', 'Object', 'Array', 'Number', 'Float64Array', 'Uint8Array', 'Map', 'Set', 'String', 'Promise', 'Error', 'Symbol', 'Reflect'];
let snapshot = null;

function takeSnapshot() {
  const snap = [];
  const value = (o, k) => {
    const d = Object.getOwnPropertyDescriptor(o, k);
    return d ? ('value' in d ? d.value : d.get) : undefined;
  };
  for (const o of WATCHED) for (const k of Reflect.ownKeys(o)) snap.push([o, k, value(o, k)]);
  for (const g of WATCHED_GLOBALS) snap.push([globalThis, g, value(globalThis, g)]);
  return { snap, value };
}

function tampered() {
  return snapshot.snap.some(([o, k, v]) => snapshot.value(o, k) !== v);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    const py = await python(msg.indexURL);
    snapshot ??= takeSnapshot();
    if (msg.kind === 'init') {
      self.postMessage({ id: msg.id, kind: 'ready', version: py.version });
    } else if (msg.kind === 'run') {
      const out = runEpisode({ ...conditions(msg), carSeed: msg.carSeed, runSeed: msg.runSeed, controller: py.controller(msg.code), record: true });
      self.postMessage({ id: msg.id, kind: 'run', out, tampered: tampered() });
    } else if (msg.kind === 'eval') {
      const results = [];
      for (const carSeed of msg.seeds) {
        const { result } = runEpisode({ ...conditions(msg), carSeed, runSeed: msg.runSeed, controller: py.controller(msg.code), record: false });
        results.push(result);
        self.postMessage({ id: msg.id, kind: 'progress', done: results.length, total: msg.seeds.length });
        // A program that does not even start will fail the same way on every car.
        if (result.error && result.duration === 0) break;
      }
      self.postMessage({ id: msg.id, kind: 'eval', results, tampered: tampered() });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, kind: 'fatal', error: String(err && err.stack ? err.stack : err) });
  }
};
