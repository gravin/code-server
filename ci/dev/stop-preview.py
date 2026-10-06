#!/usr/bin/env python3
"""Stop only this checkout's preview wrapper, with graceful child cleanup."""
import os
from pathlib import Path
import select
import signal
import sys
import time


def is_preview(args, cache):
    release = str(cache / 'code-server' / 'release')
    profile = str(cache / 'preview' / 'user-data')
    return (
        len(args) > 2
        and args[:2] == [release + '/lib/node', release]
        and '--bind-addr' in args
        and any(args[i:i + 2] == ['--user-data-dir', profile]
                for i in range(2, len(args) - 1))
    )


def main():
    cache = Path(sys.argv[1]).resolve()
    handles = []
    try:
        for proc in Path('/proc').iterdir():
            if not proc.name.isdecimal():
                continue
            handle = None
            try:
                # Pin the process before inspecting it: a reused PID cannot be
                # signalled accidentally. Ubuntu's Python/Linux support pidfds.
                handle = os.pidfd_open(int(proc.name))
                args = os.fsdecode((proc / 'cmdline').read_bytes().rstrip(b'\0')).split('\0')
                if not is_preview(args, cache):
                    continue
                signal.pidfd_send_signal(handle, signal.SIGTERM)
                handles.append(handle)
                handle = None
                print(f'Stopping this checkout\'s code-server preview (PID {proc.name})...')
            except (ProcessLookupError, FileNotFoundError, PermissionError):
                pass
            finally:
                if handle is not None:
                    os.close(handle)
        if not handles:
            print('No running code-server preview found for this checkout.')
            return 0
        deadline = time.monotonic() + 15
        pending = handles.copy()
        while pending and time.monotonic() < deadline:
            exited, _, _ = select.select(pending, [], [], max(0, deadline - time.monotonic()))
            pending = [fd for fd in pending if fd not in exited]
        if pending:
            print('The preview has not exited yet. Check its build.log and try again.', file=sys.stderr)
            return 1
        print('code-server preview stopped. You can run build-and-start.bat again.')
        return 0
    finally:
        for handle in handles:
            os.close(handle)


if __name__ == '__main__':
    sys.exit(main())
