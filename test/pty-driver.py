# Drive a program inside a real terminal and type into it on a schedule.
#
# usage: python pty-driver.py '<[[delay, keys], ...] as json>' -- <argv...>
# env:   PTY_COLS sets the terminal width (0 = leave it alone)
# out:   everything the program drew, then "[exit N] [keys typed/total]"
#
# POSIX forks a pty and polls it. Windows has no fork and no /dev/pts; it has ConPTY, which
# pywinpty wraps, and there the read blocks while a second thread does the typing.
import json
import os
import sys
import time

# Blocking reads on Windows, deliberately. With PYWINPTY_BLOCK=0 pywinpty reports EOF the moment
# the console goes quiet, which for a program sitting on a menu is one blink after it has drawn,
# so a driver that polls walks away before it can type. Blocking read waits for real data; the
# keys are typed from a second thread and a watchdog ends the read by killing the child.
os.environ.setdefault('PYWINPTY_BLOCK', '1')
# Python on Windows writes stdout as cp1252 by default and dies on the first drawn mark.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

keys = json.loads(sys.argv[1])
cmd = sys.argv[sys.argv.index('--') + 1:]
cols = int(os.environ.get('PTY_COLS', '0') or 0)
# Below the 60s the test harness allows, so the driver always gets to print what it captured.
DEADLINE = 25


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
    return out.decode('utf8', 'replace'), os.waitstatus_to_exitcode(status), ki


def windows():
    import threading

    from winpty import PtyProcess

    proc = PtyProcess.spawn(cmd, dimensions=(24, cols or 120), env=dict(os.environ))
    typed = [0]

    def type_keys():
        for delay, text in keys:
            time.sleep(delay)
            try:
                proc.write(text)
            except Exception:
                return
            typed[0] += 1

    def watchdog():
        time.sleep(DEADLINE)
        # Unconditionally: isalive() cannot be trusted to say whether this is needed, and a read
        # left blocking means the harness kills the driver before it prints anything at all.
        try:
            proc.terminate(force=True)
        except Exception:
            pass

    for target in (type_keys, watchdog):
        threading.Thread(target=target, daemon=True).start()

    out = ''
    while True:
        try:
            chunk = proc.read(65536)
        except EOFError:
            break
        except Exception:
            break
        if chunk:
            out += chunk
    proc.isalive()  # refreshes exitstatus
    code = proc.exitstatus
    return out, code if code is not None else -1, typed[0]


text, code, typed = windows() if sys.platform == 'win32' else posix()
sys.stdout.write(text)
sys.stdout.write('\n[exit %d] [keys %d/%d]\n' % (code, typed, len(keys)))
