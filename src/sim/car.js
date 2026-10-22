// Physical model of a two-wheel differential-drive toy car (TT gear motors, L298N-style driver,
// 2S Li-ion pack, swivel caster at the back). Every car built from a seed gets its own
// manufacturing tolerances; the controller only ever sees them through the IMU.
//
// Three layers of variation:
//   makeCar(carSeed)          fixed for a physical car (tolerances, its IMU unit)
//   makePowerOn(car, runSeed) different every time the car is switched on
//   noise scale               amplitude of everything random inside a run

import { Rng, hashSeed } from './rng.js';

const G = 9.81;
const DEG = Math.PI / 180;

/** What the "datasheet" says. This is all a student would know about the car. */
export const NOMINAL = {
  wheelRadius: 0.0325, // m (65 mm wheels)
  trackWidth: 0.13, // m, wheel contact centre to centre
  mass: 0.55, // kg
  gearRatio: 48,
  batteryVoltage: 7.4, // V, 2S Li-ion
  motorRatedVoltage: 6.0, // V
  noLoadRpmAt6V: 200, // wheel rpm
  pwmMax: 1000,
};

/**
 * Build a car with randomised imperfections. Spreads are "cheap hobby parts" level:
 * enough that two identical PWM values never give two identical wheel speeds.
 */
export function makeCar(seed) {
  const rng = new Rng(seed);
  const n = (mu, rel, lim = 3) => rng.truncNormal(mu, mu * rel, mu * rel * lim);

  const motor = () => {
    const tauC = n(0.012, 0.25, 2); // N·m Coulomb friction at the output shaft (gearbox)
    return {
      Ke: n(0.25, 0.025), // V·s/rad back-EMF at the output shaft
      Kt: n(0.1, 0.04), // N·m/A output torque per amp (gearbox losses included)
      R: n(4.5, 0.04), // Ω winding + brushes
      tauC,
      tauS: tauC * rng.uniform(1.25, 1.7), // stiction
      b: n(1.2e-4, 0.2, 2), // N·m·s viscous
      J: n(2.2e-4, 0.05), // kg·m² rotor (reflected through gearbox) + wheel
      driverDrop: n(1.8, 0.05), // V lost in the H-bridge
    };
  };

  const wheel = () => ({
    r: n(NOMINAL.wheelRadius, 0.008),
    ecc: rng.uniform(0, 0.006), // out-of-round, fraction of radius
    eccPhase: rng.uniform(0, 2 * Math.PI),
  });

  const imuTemp = () => ({
    tempco: rng.truncNormal(0, 0.06, 0.2), // °/s per °C (datasheet: ±20 °/s over -40…85 °C)
    vre: rng.truncNormal(0, 0.25, 0.6), // °/s bias shift under full motor vibration (rectification)
  });

  return {
    seed,
    mass: n(NOMINAL.mass, 0.03),
    yawInertia: n(3.2e-3, 0.08),
    trackWidth: n(NOMINAL.trackWidth, 0.012),
    wheelLoadShare: rng.uniform(0.62, 0.75), // rest sits on the caster
    mu: rng.uniform(0.7, 0.95), // tyre/floor friction
    slipVel: 0.012, // m/s, slip speed at which tyre force saturates
    rollResist: rng.uniform(0.02, 0.035), // rolling + caster drag coefficient
    yawScrub: rng.uniform(0.002, 0.006), // N·m·s
    casterArm: 0.11, // m behind the axle
    casterTrail: 0.014, // m
    casterFriction: rng.uniform(0.2, 0.4), // lateral drag coefficient while misaligned
    floorDisturb: rng.uniform(0.0008, 0.002), // N·m yaw disturbance (floor texture, tile seams)
    slope: rng.uniform(0, 0.4) * DEG,
    slopeDir: rng.uniform(0, 2 * Math.PI),
    left: { ...motor(), ...wheel() },
    right: { ...motor(), ...wheel() },
    battery: {
      vFull: rng.uniform(8.05, 8.3), // open-circuit voltage when freshly charged
      rInt: n(0.22, 0.15),
      idle: 0.09, // A drawn by MCU + IMU + LEDs
    },
    thermal: {
      ambient: rng.uniform(19, 30), // °C, typical for the room this car is tested in
      selfHeat: rng.uniform(2, 5), // °C board warm-up after power on
      selfHeatTau: rng.uniform(60, 150), // s
      driverGain: rng.uniform(0.8, 2.0), // °C per W dissipated in the H-bridge (it sits near the IMU)
      driverTau: rng.uniform(25, 60), // s
    },
    imu: {
      // Mounting: the breakout is never perfectly square to the chassis.
      mountYaw: rng.truncNormal(0, 1.5, 4) * DEG,
      mountPitch: rng.truncNormal(0, 1.2, 3) * DEG,
      mountRoll: rng.truncNormal(0, 1.2, 3) * DEG,
      gyro: [0, 1, 2].map(() => ({
        bias: rng.truncNormal(0, 1.5, 5), // °/s zero-rate offset at 25 °C
        turnOn: rng.uniform(0.05, 0.15), // °/s σ of power-on-to-power-on repeatability
        scale: rng.truncNormal(0, 0.012, 0.03), // sensitivity error
        gSens: rng.truncNormal(0, 0.06, 0.15), // °/s per g of acceleration
        biasInstab: rng.uniform(0.003, 0.008), // °/s, Gauss–Markov σ
        biasTau: rng.uniform(30, 120), // s
        ...imuTemp(),
      })),
      gyroCross: [0, 1, 2, 3, 4, 5].map(() => rng.truncNormal(0, 0.008, 0.02)),
      accelCross: [0, 1, 2, 3, 4, 5].map(() => rng.truncNormal(0, 0.006, 0.02)),
      clockErrInternal: rng.truncNormal(0, 0.012, 0.03), // internal oscillator, fraction
      clockErrPll: rng.truncNormal(0, 0.002, 0.005), // gyro PLL, fraction
      gyroNoise: rng.uniform(0.0045, 0.0075), // °/s/√Hz
      accel: [0, 1, 2].map((i) => ({
        offset: rng.truncNormal(0, i === 2 ? 0.05 : 0.03, 0.08), // g
        scale: rng.truncNormal(0, 0.012, 0.03),
        tempco: rng.truncNormal(0, 0.0006, 0.0015), // g per °C
      })),
      accelNoise: rng.uniform(350e-6, 450e-6), // g/√Hz
      tempOffset: rng.truncNormal(0, 1.0, 3), // °C error of the on-die sensor
      vibration: rng.uniform(0.6, 1.4), // how loosely the board is mounted
    },
  };
}

/**
 * Conditions of one switch-on: how the caster was left when the car was put down, how charged
 * the battery is, the room temperature today. (The gyro's turn-on offset is drawn by the IMU.)
 */
export function makePowerOn(car, runSeed) {
  const rng = new Rng(hashSeed(car.seed, runSeed, 0x7a3c));
  return {
    runSeed,
    casterAngle: rng.uniform(-70, 70) * DEG,
    batteryVoc: car.battery.vFull - rng.uniform(0.1, 0.6),
    ambient: car.thermal.ambient + rng.truncNormal(0, 0.8, 2),
  };
}

/** Ornstein–Uhlenbeck helper (first-order coloured noise). */
function ouStep(x, dt, tau, sigma, g) {
  const a = Math.exp(-dt / tau);
  return x * a + sigma * Math.sqrt(1 - a * a) * g;
}

export class CarSim {
  /**
   * @param car      makeCar()
   * @param rng      run-time random stream
   * @param powerOn  makePowerOn()
   * @param noise    scale of the random floor disturbance (1 = realistic)
   */
  constructor(car, rng, powerOn, noise = 1) {
    this.car = car;
    this.rng = rng;
    this.voc = powerOn.batteryVoc;
    this.ambient = powerOn.ambient;
    this.floorDisturb = car.floorDisturb * noise;
    this.t = 0;
    // pose & velocities (world: x along the track, y to the left, psi CCW)
    this.x = 0;
    this.y = 0;
    this.psi = 0;
    this.v = 0;
    this.r = 0;
    this.vDot = 0;
    this.caster = powerOn.casterAngle;
    this.dist = 0;
    this.disturb = 0;
    this.Tdriver = 0;
    this.Vbat = this.voc;
    this.side = [car.left, car.right].map((m, i) => ({
      m,
      sgn: i === 0 ? -1 : 1, // left wheel sits at y = +b/2, so its contact speed is v - r·b/2
      w: 0, // wheel rad/s
      th: rng.uniform(0, 2 * Math.PI),
      I: 0,
      F: 0,
      duty: 0,
    }));
  }

  /** Advance one physics step. dutyL/dutyR in [-1, 1]. */
  step(dt, dutyL, dutyR) {
    const c = this.car;
    const rng = this.rng;
    const s = this.side;
    s[0].duty = dutyL;
    s[1].duty = dutyR;

    const Iload = Math.abs(s[0].I) + Math.abs(s[1].I) + c.battery.idle;
    this.Vbat = this.voc - c.battery.rInt * Iload;

    const halfB = c.trackWidth / 2;
    const Nwheel = (c.mass * G * c.wheelLoadShare) / 2;
    let Fsum = 0;
    let yawTorque = 0;
    let Pdriver = 0;

    for (const k of s) {
      const m = k.m;
      // Motor electrical (inductance ignored: L/R ≈ 1 ms ≪ mechanical time constant).
      if (k.duty === 0) {
        k.I = 0; // driver disabled → coast
      } else {
        const Vapp = k.duty * Math.max(this.Vbat - m.driverDrop, 0);
        k.I = (Vapp - m.Ke * k.w) / m.R;
      }
      Pdriver += Math.abs(k.I) * m.driverDrop;

      // Tyre: longitudinal force from slip, saturating at mu·N.
      const rEff = m.r * (1 + m.ecc * Math.sin(k.th + m.eccPhase));
      const vContact = this.v + k.sgn * this.r * halfB;
      const slip = rEff * k.w - vContact;
      k.F = c.mu * Nwheel * Math.tanh(slip / c.slipVel);
      k.rEff = rEff;

      // Wheel/rotor dynamics with Karnopp stiction.
      let tau = m.Kt * k.I - m.b * k.w - rEff * k.F;
      if (Math.abs(k.w) < 0.05) {
        if (Math.abs(tau) <= m.tauS) {
          k.w = 0;
          tau = 0;
        } else {
          tau -= Math.sign(tau) * m.tauC;
        }
      } else {
        tau -= Math.sign(k.w) * m.tauC;
      }
      k.w += (tau / m.J) * dt;
      k.th += k.w * dt;

      Fsum += k.F;
      yawTorque += k.sgn * k.F * halfB;
    }

    // Swivel caster: while misaligned it drags sideways, then trails into line.
    const Ncaster = c.mass * G * (1 - c.wheelLoadShare);
    const moving = Math.tanh(this.v / 0.01);
    const Fcaster = -c.casterFriction * Ncaster * Math.sin(this.caster) * moving;
    yawTorque += -c.casterArm * Fcaster;
    this.caster += (-(this.v / c.casterTrail) * Math.sin(this.caster) - this.r) * dt;

    // Floor: texture/seams (coloured noise, grows with speed) and a slight slope.
    this.disturb = ouStep(this.disturb, dt, 0.25, this.floorDisturb, rng.gauss());
    yawTorque += this.disturb * Math.min(Math.abs(this.v) / 0.25, 1);
    yawTorque -= c.yawScrub * this.r;

    const aSlope = G * Math.sin(c.slope) * Math.cos(c.slopeDir - this.psi);
    const Froll = c.rollResist * c.mass * G * moving;

    this.vDot = (Fsum - Froll) / c.mass + aSlope;
    this.v += this.vDot * dt;
    this.r += (yawTorque / c.yawInertia) * dt;
    this.psi += this.r * dt;
    this.x += this.v * Math.cos(this.psi) * dt;
    this.y += this.v * Math.sin(this.psi) * dt;
    this.dist += Math.abs(this.v) * dt;

    // H-bridge heating (it sits a few cm from the IMU breakout).
    const th = c.thermal;
    this.Tdriver += ((th.driverGain * Pdriver - this.Tdriver) / th.driverTau) * dt;
    this.t += dt;
  }

  /** Board temperature seen by the IMU die. */
  boardTemp() {
    const th = this.car.thermal;
    return this.ambient + th.selfHeat * (1 - Math.exp(-this.t / th.selfHeatTau)) + this.Tdriver;
  }

  /**
   * Inputs for the IMU, in the chassis frame (x forward, y left, z up):
   * angular rate (rad/s), specific force (g) and motor vibration phases.
   */
  imuInputs() {
    const c = this.car;
    // Gravity seen from the chassis on a gently sloped floor.
    const gx = Math.sin(c.slope) * Math.cos(c.slopeDir - this.psi);
    const gy = Math.sin(c.slope) * Math.sin(c.slopeDir - this.psi);
    const s = this.side;
    return {
      omega: [0, 0, this.r],
      force: [this.vDot / G - gx, (this.v * this.r) / G - gy, Math.cos(c.slope)],
      motorPhase: [s[0].th * NOMINAL.gearRatio, s[1].th * NOMINAL.gearRatio],
      motorSpeed: [s[0].w, s[1].w],
    };
  }
}
