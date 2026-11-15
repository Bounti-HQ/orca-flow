#!/bin/sh
# Development loop for the sidebar plugin, working around an Orca 1.4.254 hash bug:
# approval hashes the folder without `.orca/`, the worker's start check hashes it with `.orca/`,
# so any `.orca/` present at start fails "content hash mismatch" and Orca marks the plugin errored.
# Keep `.orca/` out of the folder except while type-checking, and keep screenshots elsewhere.
#
#   scripts/dev.sh check   types + tsc + tests, then remove .orca again
#   scripts/dev.sh load    approve what Orca asks for and (re)start the worker
#   scripts/dev.sh shot    screenshot the panel and status bar to $SHOTS (default /tmp/orca-sidebar-shots)
set -eu
cd "$(dirname "$0")/.."
KEY=local.flow
SHOTS=${SHOTS:-/tmp/orca-sidebar-shots}
status() { orca plugin list --json | python3 -c "import json,sys; print(next((p.get('status') for p in json.load(sys.stdin)['result']['plugins'] if p['pluginKey']=='$KEY'), 'absent'))"; }

case "${1:-}" in
  check)
    orca plugin types . --json >/dev/null
    trap 'rm -rf .orca' EXIT
    npx -y -p typescript tsc -p . --noEmit
    # Show the summaries, but fail the script when any test fails.
    out=$(orca plugin test . 2>&1) || { echo "$out" | grep -E '✖|Error|expected|actual' | head -20; echo 'plugin tests FAILED'; exit 1; }
    echo "$out" | tail -1
    out=$(node --test test/*.test.mjs 2>&1) || { echo "$out" | grep -E '✖|Error' | head -20; echo 'orca-flow tests FAILED'; exit 1; }
    echo "$out" | grep -E '(pass|fail) [0-9]'
    ;;
  load)
    fp=$(orca plugin dev load . --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('data',{}).get('approvalFingerprint',''))")
    rm -rf .orca
    orca plugin disable "$KEY" --json >/dev/null 2>&1 || true
    # Orca can answer the first enable with a newer fingerprint; retry once with what it reports.
    enable() { orca plugin enable "$KEY" ${1:+--approve "$1"} --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print('' if d['ok'] else d.get('error',{}).get('data',{}).get('approvalFingerprint','failed'))"; }
    again=$(enable "$fp")
    if [ -n "$again" ]; then fp=$again; [ "$(enable "$fp")" = "" ] || { echo "$KEY: enable failed"; exit 1; }; fi
    sleep 6
    echo "$KEY: $(status)${fp:+ (approved $fp)}"
    ;;
  shot)
    mkdir -p "$SHOTS"
    orca plugin open "$KEY" --panel orca-flow --json >/dev/null
    sleep 3
    orca plugin shot "$KEY" --panel orca-flow --out "$SHOTS/panel.png" --json >/dev/null && echo "$SHOTS/panel.png"
    orca plugin shot "$KEY" --status-bar --out "$SHOTS/status.png" --json >/dev/null && echo "$SHOTS/status.png"
    ;;
  *) sed -n 2,11p "$0"; exit 1 ;;
esac
