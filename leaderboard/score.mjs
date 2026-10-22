// Scores one controller for the leaderboard.
//
// The physics, the cars and the score are computed here, by this trusted process. The submitted
// Python runs in a separate process (a locked-down Docker container in CI) and only exchanges
// IMU samples and motor commands with us over a pipe, so it cannot read the cars, change the
// physics or write its own score. Each run gets a fresh process, so nothing carries over.
//
// Cars and power-ons are derived from LEADERBOARD_SECRET, so every entry is scored on the same
// hidden cars and nobody can tune their code to them.
//
// Usage:
//   node leaderboard/score.mjs --code controller.py [--out result.json] [--runs 30] [--local]
//   --local runs plain python3 without a sandbox (development and tests only).

import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEpisodeAsync, aggregate, LEADERBOARD } from '../src/sim/runner.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || readFileSync(join(here, 'sandbox', 'IMAGE'), 'utf8').trim();
const MAX_CODE_BYTES = 64 * 1024;
const START_TIMEOUT_MS = 60_000; // container start + compile + setup()
const STEP_TIMEOUT_MS = 2_000; // one loop() call
const RUN_BUDGET_MS = 240_000; // wall clock for one whole run

const STEP_BYTES = 1 + 10 * 8;
const FRAME_LEN = { R: 1, D: 1 + 1 + 3 * 8, C: 1 + 4 * 8 };

/** A controller living in another process, spoken to over stdin/stdout (see sandbox/driver.py). */
export class PipeController {
  constructor(command, args, { onClose } = {}) {
    this.command = command;
    this.args = args;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.exited = false;
    this.stderr = '';
    this.stepBuf = Buffer.alloc(STEP_BYTES);
    this.stepBuf.write('S', 0);
    this.deadline = Infinity;
  }

  begin(hw) {
    this.hw = hw;
    this.deadline = Date.now() + RUN_BUDGET_MS;
    const args = [...this.args, String(hw.trackLength), String(hw.timeLimit)];
    const p = (this.proc = spawn(this.command, args, { stdio: ['pipe', 'pipe', 'pipe'] }));
    p.stdout.on('data', (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.pump();
    });
    p.stderr.on('data', (d) => {
      if (this.stderr.length < 4000) this.stderr += d.toString();
    });
    p.stdin.on('error', () => {}); // the process may exit while we write; reported via 'exit'
    p.on('error', (e) => this.fail(`could not start the controller process: ${e.message}`));
    p.on('exit', () => {
      this.exited = true;
      this.fail('the controller process stopped unexpectedly' + (this.stderr ? `:\n${this.stderr.trim().slice(-800)}` : ''));
    });
    return null;
  }

  setup() {
    return this.collect(START_TIMEOUT_MS);
  }

  loop(t, s) {
    if (Date.now() > this.deadline) return `the run took longer than ${RUN_BUDGET_MS / 1000} s of real time; loop() is too slow`;
    const b = this.stepBuf;
    b.writeDoubleLE(t, 1);
    for (let i = 0; i < 9; i++) b.writeDoubleLE(s[i], 9 + 8 * i);
    this.proc.stdin.write(b);
    return this.collect(STEP_TIMEOUT_MS);
  }

  async collect(timeoutMs) {
    for (;;) {
      let f;
      try {
        f = await this.next(timeoutMs);
      } catch (e) {
        return e.message;
      }
      if (f.type === 'E') return f.text;
      if (f.type === 'R') continue;
      if (f.type === 'C') {
        let s;
        try {
          s = this.hw.configure(...f.values);
        } catch (e) {
          return `${e.name}: ${e.message}`;
        }
        const reply = Buffer.alloc(1 + 32);
        reply.write('c', 0);
        [s.dlpf, s.rate, s.gyroRange, s.accelRange].forEach((v, i) => reply.writeDoubleLE(v, 1 + 8 * i));
        this.proc.stdin.write(reply);
        continue;
      }
      // 'D': the step is done.
      if (f.flags & 1) this.hw.motor(f.left, f.right);
      if (f.flags & 2) {
        if (!(f.rate >= 1 && f.rate <= 1000)) return 'ValueError: the loop rate must be between 1 and 1000 Hz';
        this.hw.setLoopRate(f.rate);
      }
      return null;
    }
  }

  /** Parse one frame off the buffer, or return null if it is not complete yet. */
  parse() {
    const b = this.buf;
    if (!b.length) return null;
    const type = String.fromCharCode(b[0]);
    let len = FRAME_LEN[type];
    if (type === 'E') {
      if (b.length < 5) return null;
      len = 5 + Math.min(b.readUInt32LE(1), 4000);
    } else if (!len) {
      throw new Error(`protocol error: unexpected byte ${b[0]} from the controller`);
    }
    if (b.length < len) return null;
    this.buf = b.subarray(len);
    if (type === 'D') return { type, flags: b[1], left: b.readDoubleLE(2), right: b.readDoubleLE(10), rate: b.readDoubleLE(18) };
    if (type === 'C') return { type, values: [0, 1, 2, 3].map((i) => b.readDoubleLE(1 + 8 * i)) };
    if (type === 'E') return { type, text: b.subarray(5, len).toString('utf8') };
    return { type };
  }

  next(timeoutMs) {
    return new Promise((resolve, reject) => {
      let f;
      try {
        f = this.parse();
      } catch (e) {
        return reject(e);
      }
      if (f) return resolve(f);
      if (this.exited) return reject(new Error(this.exitMessage || 'the controller process stopped'));
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`the controller did not answer within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  pump() {
    if (!this.waiter) return;
    let f;
    try {
      f = this.parse();
    } catch (e) {
      return this.fail(e.message);
    }
    if (!f) return;
    const w = this.waiter;
    this.waiter = null;
    clearTimeout(w.timer);
    w.resolve(f);
  }

  fail(message) {
    this.exitMessage ??= message;
    if (!this.waiter) return;
    // Frames that arrived before the exit (e.g. an error report) are still delivered first.
    const w = this.waiter;
    let f = null;
    try {
      f = this.parse();
    } catch {
      f = null;
    }
    this.waiter = null;
    clearTimeout(w.timer);
    if (f) w.resolve(f);
    else w.reject(new Error(message));
  }

  close() {
    if (this.proc && !this.exited) this.proc.kill('SIGKILL');
    this.onClose?.();
  }
}

/** Hidden cars and power-ons for the leaderboard, derived from the secret. */
export function leaderboardRuns(secret, n) {
  return Array.from({ length: n }, (_, i) => {
    const h = createHmac('sha256', secret).update(`run ${i}`).digest();
    return { carSeed: (h.readUInt32LE(0) % 2_000_000_000) + 1000, runSeed: (h.readUInt32LE(4) % 2_000_000_000) + 1 };
  });
}

/** Directory with the driver and the prelude, mounted read-only into the sandbox. */
function appDir() {
  const dir = mkdtempSync(join(tmpdir(), 'lb-app-'));
  copyFileSync(join(here, 'sandbox', 'driver.py'), join(dir, 'driver.py'));
  copyFileSync(join(here, '..', 'src', 'sim', 'prelude.py'), join(dir, 'prelude.py'));
  chmodSync(dir, 0o755);
  return dir;
}

function makeController({ app, codeDir, local }) {
  if (local) {
    return new PipeController('python3', ['-I', join(app, 'driver.py'), join(app, 'prelude.py'), join(codeDir, 'controller.py')]);
  }
  const name = `lb-${randomBytes(6).toString('hex')}`;
  const args = [
    'run', '--rm', '-i', '--name', name,
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '32',
    '--memory', '512m', '--memory-swap', '512m',
    '--cpus', '1',
    '--ulimit', 'nofile=64:64',
    '--user', '65534:65534',
    '-v', `${app}:/app:ro`,
    '-v', `${codeDir}:/sub:ro`,
    SANDBOX_IMAGE,
    'python3', '-I', '/app/driver.py', '/app/prelude.py', '/sub/controller.py',
  ];
  // Killing the docker client does not stop the container; remove it explicitly.
  return new PipeController('docker', args, { onClose: () => spawn('docker', ['rm', '-f', name], { stdio: 'ignore' }) });
}

/**
 * @param code     Python source
 * @param runs     [{carSeed, runSeed}]
 * @param local    use plain python3 instead of the Docker sandbox
 */
export async function score(code, runs, { local = false, parallel = Math.max(1, Math.min(4, availableParallelism())), onRun } = {}) {
  if (Buffer.byteLength(code) > MAX_CODE_BYTES) return { ok: false, error: `controller.py is larger than ${MAX_CODE_BYTES / 1024} KB` };
  const app = appDir();
  const codeDir = mkdtempSync(join(tmpdir(), 'lb-sub-'));
  writeFileSync(join(codeDir, 'controller.py'), code);
  chmodSync(codeDir, 0o755);
  chmodSync(join(codeDir, 'controller.py'), 0o644);

  const started = Date.now();
  const results = new Array(runs.length);
  let next = 0;
  const worker = async () => {
    while (next < runs.length) {
      const i = next++;
      const controller = makeController({ app, codeDir, local });
      try {
        const { result } = await runEpisodeAsync({ controller, ...runs[i], ...LEADERBOARD, record: false });
        results[i] = result;
      } finally {
        controller.close();
      }
      onRun?.(i, results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, runs.length) }, worker));

  const errors = results.filter((r) => r.error);
  const summary = {
    ok: errors.length < results.length,
    rules: LEADERBOARD,
    ...aggregate(results),
    errors: errors.length,
    firstError: errors[0]?.error ?? null,
    elapsedS: Math.round((Date.now() - started) / 100) / 10,
    codeSha256: createHash('sha256').update(code).digest('hex'),
    // Per-run scores without the (hidden) car numbers.
    perRun: results.map((r) => ({
      pathRmseCm: round(r.pathRmseCm),
      finishCm: r.finished ? round(r.finishY * 100) : null,
      endReason: r.endReason,
    })),
  };
  summary.pathRmseCm = round(summary.pathRmseCm);
  summary.finishRmseCm = round(summary.finishRmseCm);
  if (!summary.ok) summary.error = summary.firstError;
  return summary;
}

const round = (v) => Math.round(v * 1000) / 1000;

// ---- command line ----------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const codePath = opt('--code');
  if (!codePath) {
    console.error('usage: node leaderboard/score.mjs --code controller.py [--out result.json] [--runs N] [--local]');
    process.exit(2);
  }
  const secret = process.env.LEADERBOARD_SECRET;
  if (!secret) {
    console.error('LEADERBOARD_SECRET is not set');
    process.exit(2);
  }
  const n = Number(opt('--runs', LEADERBOARD.runs));
  const summary = await score(readFileSync(codePath, 'utf8'), leaderboardRuns(secret, n), {
    local: args.includes('--local'),
    onRun: (i, r) => console.error(`run ${String(i + 1).padStart(2)}: ${r.endReason.padEnd(10)} path RMSE ${r.pathRmseCm.toFixed(2)} cm`),
  });
  const json = JSON.stringify(summary);
  const out = opt('--out');
  if (out) writeFileSync(out, json);
  console.log(JSON.stringify({ ...summary, perRun: undefined }, null, 2));
}
