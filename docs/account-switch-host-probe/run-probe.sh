#!/usr/bin/env bash
# Reproduces the account-switch host probe on a disposable checkout of stablyai/orca v1.4.272.
# Synthetic identities, temp homes, a fixture `claude` executable and in-memory orchestration only:
# nothing reads real auth files, changes Orca settings, installs a desktop build or touches the
# installed app (the optional source match only reads its unpacked JS).
#
#   docs/account-switch-host-probe/run-probe.sh [checkout-dir]
#
# The checkout dir must be outside the Flow worktree; it is created when missing.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CHECKOUT=${1:-$HOME/orca/research/orca-v1.4.272-switch-probe-repro}
TAG=v1.4.272
COMMIT=6272306c5a5a59ed1c6b604896610bfadde180cc
INSTALLED=/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/shared
LOG=$(mktemp -t orca-switch-probe)

if [ ! -d "$CHECKOUT/.git" ]; then
  git clone --quiet --depth 1 --branch "$TAG" https://github.com/stablyai/orca "$CHECKOUT"
fi
cd "$CHECKOUT"
[ "$(git rev-parse HEAD)" = "$COMMIT" ] || { echo "checkout is not $TAG ($COMMIT)"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "checkout is not clean; use a fresh directory"; exit 1; }

echo "== setup: $TAG at $COMMIT in $CHECKOUT"
ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  pnpm install --frozen-lockfile --ignore-scripts >"$LOG" 2>&1
pnpm run build:packages >>"$LOG" 2>&1

if [ -d "$INSTALLED" ]; then
  echo "== 0. installed 1.4.272 unpacked modules vs tagged source (read-only)"
  node "$HERE/installed-source-match.cjs" "$CHECKOUT" \
    agent-usage/rate-limits/rate-limit-spent-windows \
    agent-launch/startup/agent-resume-argv \
    shell/launch/agents/claude-shell-function
fi

git apply "$HERE/probes.patch"
vt() { npx vitest run --config config/vitest.config.ts --silent=false "$@" 2>&1 | tee -a "$LOG" |
  grep -E '\[probe\]|Test Files|Tests |✓|×' || true; }

echo "== 1. stock host: switch semantics, orchestration through a replaced pane, restart queue"
vt src/main/account-switch-probe/stock-switch-semantics.probe.test.ts \
  src/main/account-switch-probe/replaced-pane-orchestration.probe.test.ts \
  src/renderer/src/account-switch-probe/restart-queue.probe.test.ts

echo "== 2. seam expectations against the stock host (these are expected to FAIL)"
vt src/main/account-switch-probe/targeted-seam.probe.test.ts

git apply "$HERE/seam.patch"
echo "== 3. with the targeted seam applied"
vt src/main/account-switch-probe

echo "== 4. stock tests around the patched files, with the seam applied"
vt src/main/runtime/terminal/title/runtime-terminal-names.test.ts \
  src/main/runtime/terminal/input/dispatch-submit-withhold.test.ts \
  src/main/runtime/terminal/output/headless-snapshot-stream-position.test.ts \
  src/main/runtime/terminal/output/terminal-query-responder.test.ts \
  src/main/runtime/terminal/lifecycle/coordinator-terminal-exit.test.ts \
  src/main/runtime/orchestration/workers/restart-resume \
  src/main/runtime/rpc/methods/orchestration/access \
  src/main/claude-accounts src/shared/agent-accounts

if [ "${PROBE_TYPECHECK:-0}" = 1 ]; then
  echo "== 5. typecheck (node, web) with seam and probes"
  pnpm run typecheck:node >>"$LOG" 2>&1 && echo "typecheck:node ok"
  pnpm run typecheck:web >>"$LOG" 2>&1 && echo "typecheck:web ok"
fi
echo "full log: $LOG"
