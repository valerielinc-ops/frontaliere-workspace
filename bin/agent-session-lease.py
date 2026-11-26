#!/usr/bin/env python3
"""Supervise one explicitly managed LLM session on a POSIX host."""

import errno
import fcntl
import json
import os
import signal
import stat
import subprocess
import sys
import time
import uuid
from contextlib import ExitStack
from datetime import datetime, timezone


def append_usage(path, record):
    line = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
    if len(line) > 512:
        return
    try:
        fd = os.open(
            path, os.O_APPEND | os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600
        )
        try:
            info = os.fstat(fd)
            if (
                stat.S_ISREG(info.st_mode)
                and info.st_uid == os.getuid()
                and info.st_mode & 0o077 == 0
                and info.st_nlink == 1
            ):
                os.write(fd, line)
        finally:
            os.close(fd)
    except OSError:
        pass


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
    ready_to_forward = False
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
        if not ready_to_forward:
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
        usage_path = os.environ.get("FRONTALIERE_LLM_USAGE_LOG", "")
        provider = os.path.basename(command[0])
        usage = None
        if provider in ("codex", "claude") and os.path.isabs(usage_path):
            try:
                usage = {"version": 1, "event": "started", "id": uuid.uuid4().hex, "provider": provider}
            except OSError:
                pass
        if usage is not None:
            usage["startedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            started_ns = time.monotonic_ns()
        child = subprocess.Popen(command, start_new_session=True, pass_fds=inherited)
        if usage is not None:
            append_usage(usage_path, usage)
        ready_to_forward = True
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
        if usage is not None:
            duration_ms = max(0, (time.monotonic_ns() - started_ns) // 1_000_000)
            append_usage(usage_path, {**usage, "event": "finished", "durationMs": duration_ms})
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
