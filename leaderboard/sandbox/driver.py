# Runs one controller inside the leaderboard sandbox (a locked-down container with no network).
# It loads the same prelude as the browser, but its `_hw` bridge talks to the scoring host over
# stdin/stdout instead of calling JavaScript. The physics, the car and the score all live on the
# host; this process only ever sees IMU samples and answers with motor commands.
#
# Wire format, little-endian:
#   host -> driver   b"S" + 10 doubles (t, sample t, seq, gx, gy, gz, ax, ay, az, temp)
#                    b"c" + 4 doubles  (reply to a configure request: dlpf, rate, gyro range, accel range)
#   driver -> host   b"R"                              setup() finished
#                    b"D" + u8 flags + 3 doubles       loop() finished: bit0 motors set (left, right),
#                                                      bit1 loop rate set (hz)
#                    b"C" + 4 doubles                  configure request (-1 = leave as is)
#                    b"E" + u32 length + utf-8 text    error (begin, setup or loop)
#
# Usage: python3 driver.py PRELUDE CONTROLLER

import struct
import sys
import types

STEP = struct.Struct("<10d")
DONE = struct.Struct("<B3d")
CFG = struct.Struct("<4d")

stdin = sys.stdin.buffer
stdout = sys.stdout.buffer


def read_exact(n):
    buf = stdin.read(n)
    if buf is None or len(buf) != n:
        raise SystemExit(0)  # host went away
    return buf


class Bridge:
    """The `_hw` module the prelude imports. Motor and loop-rate calls are batched per step."""

    def __init__(self):
        self.motor_set = False
        self.left = self.right = 0.0
        self.rate = None

    def motor(self, left, right):
        self.motor_set = True
        self.left, self.right = left, right

    def setLoopRate(self, hz):
        self.rate = hz

    def configure(self, dlpf, rate, gyro_range, accel_range):
        stdout.write(b"C" + CFG.pack(dlpf, rate, gyro_range, accel_range))
        stdout.flush()
        if read_exact(1) != b"c":
            raise SystemExit("protocol error: expected configure reply")
        d, r, g, a = CFG.unpack(read_exact(CFG.size))
        return types.SimpleNamespace(dlpf=int(d), rate=r, gyroRange=int(g), accelRange=int(a))

    def log(self, kind, text):
        pass  # output is not shown on the leaderboard

    def plot(self, name, value):
        pass

    def flush_step(self):
        flags = (1 if self.motor_set else 0) | (2 if self.rate is not None else 0)
        stdout.write(b"D" + DONE.pack(flags, self.left, self.right, self.rate or 0.0))
        stdout.flush()
        self.motor_set = False
        self.rate = None


def send_error(text):
    data = text.encode("utf-8", "replace")[:4000]
    stdout.write(b"E" + struct.pack("<I", len(data)) + data)
    stdout.flush()


def main():
    prelude_path, code_path = sys.argv[1], sys.argv[2]
    bridge = Bridge()
    hw = types.ModuleType("_hw")
    for name in ("motor", "setLoopRate", "configure", "log", "plot"):
        setattr(hw, name, getattr(bridge, name))
    sys.modules["_hw"] = hw

    prelude = {"__name__": "prelude"}
    with open(prelude_path, encoding="utf-8") as f:
        exec(compile(f.read(), "prelude.py", "exec"), prelude)
    with open(code_path, encoding="utf-8") as f:
        code = f.read()

    err = prelude["_begin"](code) or prelude["_setup"]()
    if err:
        send_error(err)
        return
    # setup() may already have set the motors or the loop rate; deliver that with the reply.
    stdout.write(b"R")
    bridge.flush_step()

    step = prelude["_step"]
    while True:
        op = read_exact(1)
        if op != b"S":
            return
        err = step(*STEP.unpack(read_exact(STEP.size)))
        if err:
            send_error(err)
            return
        bridge.flush_step()


if __name__ == "__main__":
    main()
