// Starter programs. Deliberately naive: they show the API, not the answer.

export const EXAMPLES = [
  {
    id: 'starter',
    name: 'Starter: naive gyro P-control',
    code: `# Integrate gyro z into a heading, P-steer back to 0.
# It drives, but it trusts the raw gyro.
# Run it on a few cars and see what goes wrong.

KP = 0.02        # duty per degree of heading error
BASE = 0.6       # forward duty (0..1)

heading = 0.0    # degrees, integrated from gyro z
last_t = 0.0


def setup():
    set_loop_rate(200)            # call loop() at 200 Hz
    # low-pass the gyro at 42 Hz, sample it at 1 kHz
    print(imu.configure(dlpf=42, rate=1000))


def loop():
    global heading, last_t
    t = now()
    dt = t - last_t
    last_t = t

    gx, gy, gz = imu.gyro()       # deg/s
    heading += gz * dt

    u = KP * (0.0 - heading)      # positive u turns left
    motors.set(BASE - u, BASE + u)

    plot("heading estimate (deg)", heading)
`,
  },
  {
    id: 'open-loop',
    name: 'Open loop: same duty both sides',
    code: `# Identical duty on both motors, no sensor at all.
# Mismatched motors and wheels make every car curve
# its own way.

def setup():
    set_loop_rate(50)


def loop():
    motors.set(0.6, 0.6)
`,
  },
  {
    id: 'imu-logger',
    name: 'Parked: log the IMU',
    code: `# Leave the car parked and watch what the IMU reports
# when nothing moves. The run lasts the full 40 s.
# Compare gyro z with the temperature chart.

def setup():
    set_loop_rate(100)
    imu.configure(dlpf=20, rate=200)


def loop():
    s = imu.read()          # Sample(t, seq, gyro, accel, temp)
    plot("gyro z (deg/s)", s.gyro[2])
    plot("accel x (g)", s.accel[0])
    plot("imu temperature (C)", s.temp)
    motors.stop()
`,
  },
];
