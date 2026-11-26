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


def supports_termination_grace():
    return (
        os.name == "posix"
        and all(hasattr(os, name) for name in ("killpg", "waitid", "P_PID", "WEXITED", "WNOWAIT"))
        and all(hasattr(signal, name) for name in ("setitimer", "ITIMER_REAL", "SIGALRM", "SIGKILL"))
    )


def run(runtime, category, command, grace_ms=None):
    child = None
    pending_signals = []
    stop_request = {}
    forwarding = True
    killed = False

    def send_to_group(signum):
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass

    def kill_group():
        nonlocal killed
        if not killed:
            killed = True
            send_to_group(signal.SIGKILL)

    def on_deadline(_signum, _frame):
        if forwarding:
            kill_group()

    def forward(signum, _frame=None):
        if child is None:
            pending_signals.append(signum)
            return
        if not forwarding:
            return
        # A Python signal handler can interrupt another handler. Claim the
        # timer in one operation so only the first stop request can arm it.
        request = object()
        start_deadline = grace_ms is not None and stop_request.setdefault("first", request) is request
        send_to_group(signum)
        if start_deadline:
            signal.setitimer(signal.ITIMER_REAL, grace_ms / 1000)

    if grace_ms is not None:
        signal.signal(signal.SIGALRM, on_deadline)
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
        if grace_ms is not None:
            # Keep the leader's PID reserved until the last possible group signal.
            os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT)
            forwarding = False
            signal.setitimer(signal.ITIMER_REAL, 0)
            if stop_request:
                kill_group()
        status = child.wait()
        return status if status >= 0 else 128 - status


if __name__ == "__main__":
    try:
        args = sys.argv[1:]
        grace_ms = None
        if args and args[0] == "--termination-grace-ms":
            _, value, *args = args
            grace_ms = int(value)
            if not 1 <= grace_ms <= 30000 or str(grace_ms) != value:
                raise ValueError
            if not supports_termination_grace():
                print("llm-lease: termination grace non supportata", file=sys.stderr)
                sys.exit(1)
        runtime, category, *command = args
        if category not in ("ordinary", "reserve") or not command:
            raise ValueError
        sys.exit(run(runtime, category, command, grace_ms))
    except (OSError, ValueError, subprocess.SubprocessError):
        print("llm-lease: errore del runner", file=sys.stderr)
        sys.exit(1)
