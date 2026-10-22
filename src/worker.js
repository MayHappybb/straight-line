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

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    const py = await python(msg.indexURL);
    if (msg.kind === 'init') {
      self.postMessage({ id: msg.id, kind: 'ready', version: py.version });
    } else if (msg.kind === 'run') {
      const out = runEpisode({ ...conditions(msg), carSeed: msg.carSeed, runSeed: msg.runSeed, controller: py.controller(msg.code), record: true });
      self.postMessage({ id: msg.id, kind: 'run', out });
    } else if (msg.kind === 'eval') {
      const results = [];
      for (const carSeed of msg.seeds) {
        const { result } = runEpisode({ ...conditions(msg), carSeed, runSeed: msg.runSeed, controller: py.controller(msg.code), record: false });
        results.push(result);
        self.postMessage({ id: msg.id, kind: 'progress', done: results.length, total: msg.seeds.length });
        // A program that does not even start will fail the same way on every car.
        if (result.error && result.duration === 0) break;
      }
      self.postMessage({ id: msg.id, kind: 'eval', results });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, kind: 'fatal', error: String(err && err.stack ? err.stack : err) });
  }
};
