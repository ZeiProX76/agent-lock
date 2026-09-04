# Drive a program inside a real terminal and type into it on a schedule.
#
# usage: python pty-driver.py '<[[delay, keys], ...] as json>' -- <argv...>
# env:   PTY_COLS sets the terminal width (0 = leave it alone)
# out:   everything the program drew, then "[exit N]"
#
# POSIX forks a pty. Windows has no fork and no /dev/pts; it has ConPTY, which pywinpty wraps,
# and PYWINPTY_BLOCK=0 makes the read non-blocking so keys can still be typed on a clock.
import json
import os
import sys
import time

os.environ.setdefault('PYWINPTY_BLOCK', '0')

keys = json.loads(sys.argv[1])
cmd = sys.argv[sys.argv.index('--') + 1:]
cols = int(os.environ.get('PTY_COLS', '0') or 0)
DEADLINE = 40


def schedule(start):
    return (start + keys[0][0]) if keys else None


def posix():
    import fcntl
    import pty
    import select
    import struct
    import termios

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    if cols:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, cols, 0, 0))
    out = b''
    start = time.time()
    ki = 0
    next_at = schedule(start)
    while True:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        if next_at and time.time() >= next_at:
            os.write(fd, keys[ki][1].encode())
            ki += 1
            next_at = time.time() + keys[ki][0] if ki < len(keys) else None
        if time.time() - start > DEADLINE:
            break
    _, status = os.waitpid(pid, 0)
    return out.decode('utf8', 'replace'), os.waitstatus_to_exitcode(status)


def windows():
    from winpty import PtyProcess

    proc = PtyProcess.spawn(cmd, dimensions=(24, cols or 120), env=dict(os.environ))
    out = ''
    start = time.time()
    ki = 0
    next_at = schedule(start)
    while True:
        try:
            chunk = proc.read(65536)
        except EOFError:
            break
        if chunk:
            out += chunk
        else:
            time.sleep(0.02)
        if next_at and time.time() >= next_at:
            proc.write(keys[ki][1])
            ki += 1
            next_at = time.time() + keys[ki][0] if ki < len(keys) else None
        if time.time() - start > DEADLINE:
            break
    while proc.isalive() and time.time() - start < DEADLINE:
        time.sleep(0.05)
    return out, proc.exitstatus if proc.exitstatus is not None else 0


text, code = windows() if sys.platform == 'win32' else posix()
sys.stdout.write(text)
sys.stdout.write('\n[exit %d]\n' % code)
