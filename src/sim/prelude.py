# Python side of the car: the objects your controller.py sees.
# Loaded once into Pyodide; every run gets a fresh namespace (fresh globals, fresh IMU object).

import builtins
import math
import traceback
from collections import namedtuple

import _hw  # JS bridge, provided by the simulator

FILENAME = "controller.py"
DLPF_CHOICES = (256, 188, 98, 42, 20, 10, 5)

Sample = namedtuple("Sample", "t seq gyro accel temp")
Sample.__doc__ = """One MPU-6050 output sample.
t      time the chip produced it (s since power-on)
seq    sample counter, +1 per new sample
gyro   (x, y, z) angular rate in deg/s, z positive = turning left
accel  (x, y, z) specific force in g, x forward, y left, z up
temp   on-die temperature sensor in deg C"""


class IMU:
    """The MPU-6050 on the car. Every read returns the latest sample the chip has produced."""

    def __init__(self):
        self._s = Sample(0.0, 0, (0.0, 0.0, 0.0), (0.0, 0.0, 0.0), 36.53)

    def read(self):
        return self._s

    def gyro(self):
        return self._s.gyro

    def accel(self):
        return self._s.accel

    def temperature(self):
        return self._s.temp

    def configure(self, dlpf=None, rate=None, gyro_range=None, accel_range=None):
        """Set the digital low-pass filter (Hz), output data rate (Hz) and full-scale ranges.
        Returns the settings actually in effect."""
        if dlpf is not None and dlpf not in DLPF_CHOICES:
            raise ValueError(f"dlpf must be one of {DLPF_CHOICES} Hz, got {dlpf!r}")
        if rate is not None and not (3.9 <= float(rate) <= 8000):
            raise ValueError(f"rate must be between 3.9 and 8000 Hz, got {rate!r}")
        if gyro_range is not None and gyro_range not in (250, 500, 1000, 2000):
            raise ValueError(f"gyro_range must be 250, 500, 1000 or 2000 deg/s, got {gyro_range!r}")
        if accel_range is not None and accel_range not in (2, 4, 8, 16):
            raise ValueError(f"accel_range must be 2, 4, 8 or 16 g, got {accel_range!r}")
        opt = lambda v: -1 if v is None else float(v)
        s = _hw.configure(opt(dlpf), opt(rate), opt(gyro_range), opt(accel_range))
        return {"dlpf": s.dlpf, "rate": s.rate, "gyro_range": s.gyroRange, "accel_range": s.accelRange}


class Motors:
    """Two DC motors behind an H-bridge. Duty from -1.0 (full reverse) to 1.0 (full forward)."""

    def set(self, left, right):
        _hw.motor(float(left), float(right))

    def stop(self):
        _hw.motor(0.0, 0.0)


_state = {"t": 0.0, "ns": None, "loop": None, "imu": None}


def now():
    """Seconds since the car was switched on."""
    return _state["t"]


def set_loop_rate(hz):
    """How often loop() is called, 1 to 1000 Hz (default 100)."""
    hz = float(hz)
    if not 1 <= hz <= 1000:
        raise ValueError(f"set_loop_rate: hz must be between 1 and 1000, got {hz:g}")
    _hw.setLoopRate(hz)


def log(*args, sep=" "):
    _hw.log("log", sep.join(str(a) for a in args))


def plot(name, value):
    """Record a value against time. Each name gets its own chart (up to 8)."""
    _hw.plot(str(name), float(value))


def _print(*args, sep=" ", end="\n", file=None, flush=False):
    log(*args, sep=sep)


def _format(e):
    if isinstance(e, SyntaxError) and e.filename == FILENAME:
        src = (e.text or "").strip()
        return f"{type(e).__name__}: {e.msg} (line {e.lineno})" + (f"\n    {src}" if src else "")
    frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == FILENAME]
    msg = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
    if not frames:
        return msg
    lines = [f"  line {f.lineno}, in {f.name}" + (f"\n    {f.line}" if f.line else "") for f in frames]
    return "\n".join(lines + [msg])


def _begin(code):
    imu = IMU()
    ns = {
        "__name__": "__main__",
        "__builtins__": builtins,
        "imu": imu,
        "motors": Motors(),
        "now": now,
        "set_loop_rate": set_loop_rate,
        "log": log,
        "plot": plot,
        "print": _print,
        "math": math,
    }
    _state.update(t=0.0, ns=ns, imu=imu, loop=None)
    try:
        exec(compile(code, FILENAME, "exec"), ns)
    except BaseException as e:
        return _format(e)
    loop = ns.get("loop")
    if not callable(loop):
        return "controller.py needs a loop() function. It is called at the loop rate to read the IMU and set the motors."
    _state["loop"] = loop
    return None


def _setup():
    setup = _state["ns"].get("setup")
    if callable(setup):
        try:
            setup()
        except BaseException as e:
            return _format(e)
    return None


def _step(t, ts, seq, gx, gy, gz, ax, ay, az, temp):
    _state["t"] = t
    _state["imu"]._s = Sample(ts, int(seq), (gx, gy, gz), (ax, ay, az), temp)
    try:
        _state["loop"]()
    except BaseException as e:
        return _format(e)
    return None
