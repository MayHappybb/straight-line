// Register-level model of an InvenSense MPU-6050 (GY-521 breakout) on I2C address 0x68.
//
// Modelled: power-on sleep, WHO_AM_I, SMPLRT_DIV, DLPF (CONFIG), full-scale ranges,
// 16-bit big-endian two's-complement outputs with saturation, DATA_RDY in INT_STATUS,
// internal sample clock error, wake-up transient, per-unit zero-rate offset, power-on
// repeatability, temperature coefficient, bias instability, white noise density,
// scale/cross-axis errors, g-sensitivity, mounting misalignment and motor vibration
// (which aliases if you pick a wide DLPF and sample slowly, and shifts the gyro bias while the
// motors run — so a bias measured standing still is not quite the bias while driving).

export const MPU_ADDR = 0x68;

export const REG = {
  SMPLRT_DIV: 0x19,
  CONFIG: 0x1a,
  GYRO_CONFIG: 0x1b,
  ACCEL_CONFIG: 0x1c,
  INT_ENABLE: 0x38,
  INT_STATUS: 0x3a,
  ACCEL_XOUT_H: 0x3b,
  TEMP_OUT_H: 0x41,
  GYRO_XOUT_H: 0x43,
  PWR_MGMT_1: 0x6b,
  PWR_MGMT_2: 0x6c,
  WHO_AM_I: 0x75,
};

// DLPF_CFG → [accel bandwidth Hz, gyro bandwidth Hz, gyro output rate Hz] (datasheet table 4.3)
const DLPF = [
  [260, 256, 8000],
  [184, 188, 1000],
  [94, 98, 1000],
  [44, 42, 1000],
  [21, 20, 1000],
  [10, 10, 1000],
  [5, 5, 1000],
  [260, 256, 8000], // 7 is reserved; behaves like 0 here
];

export const DLPF_CHOICES = [256, 188, 98, 42, 20, 10, 5];
const RAD2DEG = 180 / Math.PI;
const STARTUP_S = 0.03; // gyro start-up time from sleep

/** 2nd-order Butterworth low-pass, transposed direct form II. */
class Biquad {
  constructor() {
    this.z1 = 0;
    this.z2 = 0;
    this.set(100, 4000);
  }
  set(fc, fs) {
    const f = Math.min(fc, fs * 0.45);
    const K = Math.tan((Math.PI * f) / fs);
    const norm = 1 / (1 + Math.SQRT2 * K + K * K);
    this.b0 = K * K * norm;
    this.b1 = 2 * this.b0;
    this.b2 = this.b0;
    this.a1 = 2 * (K * K - 1) * norm;
    this.a2 = (1 - Math.SQRT2 * K + K * K) * norm;
  }
  /** Put the filter in steady state for a constant input. */
  prime(x) {
    this.z1 = x * (1 - this.b0);
    this.z2 = x * (this.b2 - this.a2);
  }
  step(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Sensor-frame matrix: (I + scale/cross-axis errors) · Rᵀ(mounting). */
function sensorMatrix(mount, scale, cross) {
  const { mountYaw: a, mountPitch: b, mountRoll: c } = mount;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cc = Math.cos(c), sc = Math.sin(c);
  // R = Rz(a)·Ry(b)·Rx(c): sensor axes expressed in the chassis frame.
  const R = [
    [ca * cb, ca * sb * sc - sa * cc, ca * sb * cc + sa * sc],
    [sa * cb, sa * sb * sc + ca * cc, sa * sb * cc - ca * sc],
    [-sb, cb * sc, cb * cc],
  ];
  const S = [
    [1 + scale[0], cross[0], cross[1]],
    [cross[2], 1 + scale[1], cross[3]],
    [cross[4], cross[5], 1 + scale[2]],
  ];
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) M[i][j] += S[i][k] * R[j][k]; // S · Rᵀ
  return M;
}

function mul3(M, v) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

export class Mpu6050 {
  /**
   * @param p   car.imu parameters (fixed for this physical unit)
   * @param rng run-time noise stream (differs per power cycle)
   * @param dt  simulation step, s
   * @param noise scale of every random component (1 = realistic, 0 = none). The unit's fixed
   *              errors (offset, temperature coefficient, scale, mounting) are not noise and stay.
   */
  constructor(p, rng, dt, noise = 1) {
    this.noise = noise;
    this.p = p;
    this.rng = rng;
    this.dt = dt;
    this.fs = 1 / dt;
    this.Mg = sensorMatrix(p, p.gyro.map((g) => g.scale), p.gyroCross);
    this.Ma = sensorMatrix(p, p.accel.map((a) => a.scale), p.accelCross);
    // Things that change every time the board is powered up.
    this.turnOn = p.gyro.map((g) => rng.normal(0, g.turnOn) * noise);
    this.wakeKick = [0, 1, 2].map(() => rng.normal(0, 0.4) * noise); // °/s, decays after wake
    this.gm = p.gyro.map((g) => rng.normal(0, g.biasInstab) * noise);
    this.clockErrInternal = p.clockErrInternal;
    this.clockErrPll = p.clockErrPll;
    this.vibPhase = [0, 1, 2, 3, 4, 5].map(() => rng.uniform(0, 2 * Math.PI));
    this.gFilt = [new Biquad(), new Biquad(), new Biquad()];
    this.aFilt = [new Biquad(), new Biquad(), new Biquad()];
    this.gmTick = 0;
    this.reset(0);
  }

  reset(t) {
    this.regs = new Uint8Array(128);
    this.regs[REG.PWR_MGMT_1] = 0x40; // SLEEP set at power-on
    this.regs[REG.WHO_AM_I] = 0x68;
    this.awakeSince = null;
    this.primed = false;
    this.nextSample = 0;
    this.seq = 0;
    this.sampleTime = 0;
    this.applyConfig();
  }

  /** What a typical driver does at boot: leave sleep mode with the gyro PLL as clock. */
  wake(t) {
    this.write(REG.PWR_MGMT_1, 0x01, t);
  }

  /**
   * Driver-level configuration. Unspecified (null) values are left alone.
   * @returns the settings actually in effect (the sample rate is rounded to what the divider can do)
   */
  configure({ dlpfHz = null, rateHz = null, gyroRange = null, accelRange = null }, t) {
    if (dlpfHz !== null) {
      const cfg = DLPF.findIndex((row) => row[1] === dlpfHz);
      if (cfg < 0) throw new RangeError(`dlpf must be one of ${DLPF_CHOICES.join(', ')} Hz`);
      this.write(REG.CONFIG, cfg, t);
    }
    if (rateHz !== null) {
      const base = DLPF[this.regs[REG.CONFIG] & 7][2];
      const div = Math.max(0, Math.min(255, Math.round(base / rateHz - 1)));
      this.write(REG.SMPLRT_DIV, div, t);
    }
    if (gyroRange !== null) {
      const fs = [250, 500, 1000, 2000].indexOf(gyroRange);
      if (fs < 0) throw new RangeError('gyro_range must be 250, 500, 1000 or 2000 °/s');
      this.write(REG.GYRO_CONFIG, fs << 3, t);
    }
    if (accelRange !== null) {
      const fs = [2, 4, 8, 16].indexOf(accelRange);
      if (fs < 0) throw new RangeError('accel_range must be 2, 4, 8 or 16 g');
      this.write(REG.ACCEL_CONFIG, fs << 3, t);
    }
    return this.settings();
  }

  settings() {
    const cfg = this.regs[REG.CONFIG] & 7;
    const nominalRate = DLPF[cfg][2] / (1 + this.regs[REG.SMPLRT_DIV]);
    return {
      dlpf: DLPF[cfg][1],
      rate: nominalRate,
      gyroRange: 250 << ((this.regs[REG.GYRO_CONFIG] >> 3) & 3),
      accelRange: 2 << ((this.regs[REG.ACCEL_CONFIG] >> 3) & 3),
    };
  }

  get16(reg) {
    const v = (this.regs[reg] << 8) | this.regs[reg + 1];
    return v >= 0x8000 ? v - 0x10000 : v;
  }

  /**
   * Latest output sample decoded the way a driver would: [t, seq, gx, gy, gz, ax, ay, az, temp]
   * in s, count, °/s, g, °C. Before the first sample everything reads 0 (temp 36.53 °C).
   */
  readSample(out) {
    out[0] = this.sampleTime;
    out[1] = this.seq;
    for (let i = 0; i < 3; i++) {
      out[2 + i] = this.get16(REG.GYRO_XOUT_H + 2 * i) / this.gyroLsb;
      out[5 + i] = this.get16(REG.ACCEL_XOUT_H + 2 * i) / this.accelLsb;
    }
    out[8] = this.get16(REG.TEMP_OUT_H) / 340 + 36.53;
    return out;
  }

  applyConfig() {
    const cfg = this.regs[REG.CONFIG] & 7;
    const [aBw, gBw, gRate] = DLPF[cfg];
    for (const f of this.gFilt) f.set(gBw, this.fs);
    for (const f of this.aFilt) f.set(aBw, this.fs);
    const clk = this.regs[REG.PWR_MGMT_1] & 7;
    const err = clk >= 1 && clk <= 3 ? this.clockErrPll : this.clockErrInternal;
    this.sampleRate = (gRate * (1 + err)) / (1 + this.regs[REG.SMPLRT_DIV]);
    this.gyroLsb = 131 / (1 << ((this.regs[REG.GYRO_CONFIG] >> 3) & 3)); // LSB per °/s
    this.accelLsb = 16384 / (1 << ((this.regs[REG.ACCEL_CONFIG] >> 3) & 3)); // LSB per g
  }

  get asleep() {
    return (this.regs[REG.PWR_MGMT_1] & 0x40) !== 0;
  }

  // ---- I2C register interface -------------------------------------------------------------

  write(reg, value, t) {
    reg &= 0x7f;
    value &= 0xff;
    if (reg === REG.PWR_MGMT_1) {
      if (value & 0x80) {
        this.reset(t); // DEVICE_RESET
        return;
      }
      const wasAsleep = this.asleep;
      this.regs[reg] = value;
      if (wasAsleep && !this.asleep) {
        this.awakeSince = t;
        this.primed = false;
      } else if (!wasAsleep && this.asleep) {
        this.awakeSince = null;
      }
      this.applyConfig();
      return;
    }
    // Read-only: sensor outputs, INT_STATUS, WHO_AM_I.
    if ((reg >= 0x3a && reg <= 0x60) || reg === REG.WHO_AM_I) return;
    this.regs[reg] = value;
    if (reg === REG.CONFIG || reg === REG.SMPLRT_DIV || reg === REG.GYRO_CONFIG || reg === REG.ACCEL_CONFIG) {
      this.applyConfig();
    }
  }

  read(reg) {
    reg &= 0x7f;
    const v = this.regs[reg];
    if (reg === REG.INT_STATUS) this.regs[reg] = 0; // cleared on read
    return v;
  }

  // ---- analogue front end, called every simulation step -------------------------------------

  /**
   * @param t       time, s
   * @param inp     CarSim.imuInputs()
   * @param Tboard  board temperature, °C
   */
  update(t, inp, Tboard) {
    const p = this.p;
    const rng = this.rng;
    const dt = this.dt;

    // Bias instability (Gauss–Markov), updated at 100 Hz to keep it cheap.
    if (++this.gmTick >= Math.round(0.01 / dt)) {
      this.gmTick = 0;
      for (let i = 0; i < 3; i++) {
        const g = p.gyro[i];
        const a = Math.exp(-0.01 / g.biasTau);
        this.gm[i] = this.gm[i] * a + this.noise * g.biasInstab * Math.sqrt(1 - a * a) * rng.gauss();
      }
    }

    if (this.asleep || this.awakeSince === null) return;
    const sinceWake = t - this.awakeSince;
    if (sinceWake < STARTUP_S) return;

    const Tdie = Tboard + 0.6 * (1 - Math.exp(-sinceWake / 20)); // the die itself warms a little
    this.Tdie = Tdie;
    const dT = Tdie - 25;

    // Motor vibration: a tone at each motor's shaft speed plus broadband rattle.
    const sp0 = Math.min(Math.abs(inp.motorSpeed[0]) / 20, 1.5);
    const sp1 = Math.min(Math.abs(inp.motorSpeed[1]) / 20, 1.5);
    const vib = p.vibration;
    const tone0 = Math.sin(inp.motorPhase[0] + this.vibPhase[0]) * sp0 * vib;
    const tone1 = Math.sin(inp.motorPhase[1] + this.vibPhase[1]) * sp1 * vib;
    const rattle = 1 + 2.5 * vib * Math.max(sp0, sp1);
    const vibPower = ((sp0 * sp0 + sp1 * sp1) / 2) * vib * vib; // drives vibration rectification

    const omegaDeg = [inp.omega[0] * RAD2DEG, inp.omega[1] * RAD2DEG, inp.omega[2] * RAD2DEG];
    const ws = mul3(this.Mg, omegaDeg);
    const fsens = mul3(this.Ma, inp.force);

    const gSig = this.noise * Math.sqrt(this.fs / 2) * p.gyroNoise * rattle;
    const aSig = this.noise * Math.sqrt(this.fs / 2) * p.accelNoise * rattle;
    const kick = Math.exp(-sinceWake / 0.35);
    const vibGyro = [1.6, 1.2, 0.35]; // °/s per axis at full speed
    const vibAcc = [0.05, 0.03, 0.08]; // g per axis at full speed

    const gyro = [0, 0, 0];
    const acc = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const g = p.gyro[i];
      const toneMix = i === 1 ? tone0 - tone1 : tone0 + tone1;
      gyro[i] =
        ws[i] +
        g.bias +
        this.turnOn[i] +
        g.tempco * dT +
        g.vre * vibPower +
        this.gm[i] +
        this.wakeKick[i] * kick +
        g.gSens * (fsens[2] - 1) +
        vibGyro[i] * toneMix +
        gSig * rng.gauss();
      const a = p.accel[i];
      acc[i] = fsens[i] + a.offset + a.tempco * dT + vibAcc[i] * (tone0 + tone1) + aSig * rng.gauss();
    }

    if (!this.primed) {
      for (let i = 0; i < 3; i++) {
        this.gFilt[i].prime(gyro[i]);
        this.aFilt[i].prime(acc[i]);
      }
      this.primed = true;
      this.nextSample = t;
    }
    for (let i = 0; i < 3; i++) {
      gyro[i] = this.gFilt[i].step(gyro[i]);
      acc[i] = this.aFilt[i].step(acc[i]);
    }

    // Latch into the output registers at the configured sample rate.
    if (t >= this.nextSample) {
      this.nextSample += 1 / this.sampleRate;
      if (this.nextSample < t) this.nextSample = t + 1 / this.sampleRate;
      this.lastGyroDps = gyro;
      for (let i = 0; i < 3; i++) {
        this.put16(REG.ACCEL_XOUT_H + 2 * i, acc[i] * this.accelLsb);
        this.put16(REG.GYRO_XOUT_H + 2 * i, gyro[i] * this.gyroLsb);
      }
      if (!(this.regs[REG.PWR_MGMT_1] & 0x08)) {
        const Tread = Tdie + p.tempOffset + this.noise * 0.04 * rng.gauss();
        this.put16(REG.TEMP_OUT_H, (Tread - 36.53) * 340);
      }
      this.regs[REG.INT_STATUS] |= 0x01; // DATA_RDY_INT
      this.seq++;
      this.sampleTime = t;
    }
  }

  put16(reg, value) {
    let v = Math.round(value);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    v &= 0xffff;
    this.regs[reg] = v >> 8;
    this.regs[reg + 1] = v & 0xff;
  }
}
