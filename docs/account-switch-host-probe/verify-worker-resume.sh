#!/usr/bin/env bash
# Always creates a new host checkout. An optional argument names a local Orca source mirror.
set -euo pipefail
export ORCA_BACKGROUND_LAUNCH=1
here=$(cd "$(dirname "$0")" && pwd)
probe_root=$(mktemp -d "${TMPDIR:-/tmp}/flow-worker-e2e.XXXXXX")
host="$probe_root/orca"
echo "Disposable host and test logs: $probe_root"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch v1.4.272 "${1:-https://github.com/stablyai/orca.git}" "$host"
cd "$host"
[[ $(git rev-parse HEAD) == 6272306c5a5a59ed1c6b604896610bfadde180cc ]]
ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --frozen-lockfile --ignore-scripts >"$probe_root/install.log" 2>&1
pnpm run build:packages >"$probe_root/build.log" 2>&1
mkdir -p src/main/account-switch-e2e
cp "$here/worker-continuity.test.ts.fixture" src/main/account-switch-e2e/worker-continuity.test.ts
echo 'Stock control: both resumed conversations should still have a failed worker assignment'
ORCA_WORKER_E2E_CONTROL=stock node "$here/run-worker-e2e.mjs" "$host" | tee "$probe_root/stock.log"
git apply --check "$here/worker-resume.patch"
git apply "$here/worker-resume.patch"
echo 'Patched host: both conversations should complete the original assignment'
ORCA_WORKER_E2E_CONTROL=patched node "$here/run-worker-e2e.mjs" "$host" | tee "$probe_root/patched.log"
pnpm run typecheck:node >"$probe_root/typecheck.log" 2>&1
pnpm run typecheck:web >>"$probe_root/typecheck.log" 2>&1
node_modules/.bin/vitest run --config config/vitest.config.ts --silent=passed-only \
  src/main/runtime/orchestration/workers/restart-resume src/main/runtime/rpc/methods/orchestration/access \
  src/main/runtime/terminal/lifecycle/coordinator-terminal-exit.test.ts \
  src/main/runtime/orchestration/workers/lifecycle/lifecycle-reconciliation.test.ts \
  src/main/runtime/orchestration/db/runs/run-coordinator-handover.test.ts \
  src/main/persistence/loading-store/terminal-bindings | tee "$probe_root/regressions.log"
