#!/usr/bin/env python3
"""Supervise one explicitly managed LLM session on a POSIX host."""

import errno
import fcntl
import os
import signal
import subprocess
import sys
from contextlib import ExitStack


def acquire(locks, runtime, name):
    fd = os.open(os.path.join(runtime, name), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        os.close(fd)
        if error.errno in (errno.EACCES, errno.EAGAIN):
            return None
        raise
    locks.callback(os.close, fd)
    return fd


def run(runtime, category, command):
    child = None
    pending_signals = []

    def forward(signum, _frame=None):
        if child is None:
            pending_signals.append(signum)
            return
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, forward)

    os.makedirs(runtime, mode=0o700, exist_ok=True)
    with ExitStack() as locks:
        inherited = []
        if category == "reserve":
            fd = acquire(locks, runtime, "llm-reserve.lock")
            if fd is None:
                print("llm-lease refused category=reserve slot=none", file=sys.stderr)
                return 75
            inherited.append(fd)

        for slot in (1, 2):
            fd = acquire(locks, runtime, f"llm-slot-{slot}.lock")
            if fd is not None:
                inherited.append(fd)
                break
        else:
            print(f"llm-lease refused category={category} slot=none", file=sys.stderr)
            return 75

        print(f"llm-lease acquired category={category} slot={slot}", file=sys.stderr)
        child = subprocess.Popen(command, start_new_session=True, pass_fds=inherited)
        for signum in pending_signals:
            forward(signum)
        status = child.wait()
        return status if status >= 0 else 128 - status


if __name__ == "__main__":
    try:
        runtime, category, *command = sys.argv[1:]
        if category not in ("ordinary", "reserve") or not command:
            raise ValueError
        sys.exit(run(runtime, category, command))
    except (OSError, ValueError, subprocess.SubprocessError):
        print("llm-lease: errore del runner", file=sys.stderr)
        sys.exit(1)
