// Bridges Pyodide to the simulator's controller interface (see runner.js).

/**
 * @param loadPyodide  pyodide's loader
 * @param options      passed to loadPyodide (indexURL etc.)
 * @param preludeSrc   text of prelude.py
 */
export async function initPython(loadPyodide, options, preludeSrc) {
  const py = await loadPyodide(options);
  const bridge = { hw: null };
  py.registerJsModule('_hw', {
    motor: (l, r) => bridge.hw.motor(l, r),
    setLoopRate: (hz) => bridge.hw.setLoopRate(hz),
    configure: (a, b, c, d) => bridge.hw.configure(a, b, c, d),
    log: (kind, text) => bridge.hw.log(kind, text),
    plot: (name, v) => bridge.hw.plot(name, v),
  });
  py.runPython(preludeSrc);
  const fBegin = py.globals.get('_begin');
  const fSetup = py.globals.get('_setup');
  const fStep = py.globals.get('_step');

  return {
    version: py.version,
    controller(code) {
      return {
        begin(hw) {
          bridge.hw = hw;
          return fBegin(code) ?? null;
        },
        setup: () => fSetup() ?? null,
        loop: (t, s) => fStep(t, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8]) ?? null,
      };
    },
  };
}
