"""Run one sandboxed fixture CLI in a private controlling terminal and hold it at rest."""
import json
import os
import pty
import select
import signal
import sys
import time

# After the turn completes the shell stays in this PTY, as it would between commands.
# Never interpolate argv into shell code. The per-turn result and log are disposable files.
out, err, status, *command = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    script = ('test -t 0 && test -t 1 || exit 125; '
              'out=$1; err=$2; status=$3; shift 3; '
              '"$@" </dev/null >"$out" 2>"$err"; rc=$?; '
              'echo "$rc" >"$status.tmp"; /bin/mv "$status.tmp" "$status"; '
              'IFS= read -r _')
    os.execv('/bin/sh', ['sh', '-c', script, 'fixture', out, err, status, *command])

print(json.dumps({'ptyId': 'fixture-pty-' + str(pid)}), flush=True)
try:
    # Closing the master hangs up the shell. Wait for an explicit release or a disconnected driver.
    readable, _, _ = select.select([sys.stdin], [], [], 110)
    if readable:
        sys.stdin.readline()
finally:
    os.close(master)
    deadline = time.monotonic() + 3
    while not os.waitpid(pid, os.WNOHANG)[0]:
        if time.monotonic() > deadline:
            os.killpg(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            break
        time.sleep(0.01)
