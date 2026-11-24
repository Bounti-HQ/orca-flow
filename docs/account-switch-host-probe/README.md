# Account switch host probe (Orca 1.4.272)

**Can Flow reuse Orca's account switch for one running pane? Not on stock Orca.** Flow's plugin API
can't reach the switch. The only lever it has is the host-wide selection, which moves every later
launch on the host. When Orca itself restarts a supervised worker pane, the stop fails the worker's
Dispatch.

**With a small host change, yes, for Claude terminals.** The host already holds the reusable part:
main's `restartAgentPaneInPlace`, an exact-session resume in the same tab, leaf and folder. The
change adds two things. One spawn can name its managed account, and a pane replaced in place hands
its worker Dispatch to Orca's existing in-place hold. The prototype is 63 added lines in 5 files
([`seam.patch`](seam.patch)). It passes its fixtures, the stock tests around those files, and node
and web typechecks.

Everything below comes from a disposable checkout of `stablyai/orca` at `v1.4.272` (tag object
`0b3df86f`, commit `6272306c5a5a59ed1c6b604896610bfadde180cc`). The checkout lives at
`~/orca/research/`, outside this worktree. Line references are to that commit. The probes use
synthetic managed identities, empty temporary account folders, a fixture `claude` executable and an
in-memory orchestration database. No auth file was read, no default changed, no desktop build
installed and the live app was not patched.

## Contents

| File | What it is |
| --- | --- |
| `run-probe.sh` | Clones the tag into a fresh folder (or reuses a clean one), installs with `--ignore-scripts`, applies `probes.patch`, runs the stock probes, then runs the seam tests against stock, where they fail as expected. It then applies `seam.patch` and runs everything again with the regression tests. `PROBE_TYPECHECK=1` adds node and web typechecks. |
| `probes.patch` | Probe tests only: `src/main/account-switch-probe/*.probe.test.ts` and `src/renderer/src/account-switch-probe/restart-queue.probe.test.ts`. |
| `seam.patch` | The prototype host change (5 source files). |
| `installed-source-match.cjs` | Transpiles three tagged `src/shared` modules and compares them with the installed app's unpacked `out/shared` copies. Read-only. |
| `probe-output.txt` | Output of `PROBE_TYPECHECK=1 docs/account-switch-host-probe/run-probe.sh ~/orca/research/orca-v1.4.272-switch-probe-repro` on a fresh clone. |

## The tag matches the installed app

The probe reads `/Applications/Orca.app` (1.4.272) without changing it.

- The three unpacked shared modules match the tagged source after transpiling and normalizing
  whitespace: `rate-limit-spent-windows.js` (SHA-256 `5eed6448…63d32e2`, the same hash as
  `docs/account-failover.md`), `agent-resume-argv.js` (`8453bc53…`) and
  `claude-shell-function.js` (`d3ec218d…`).
- The bundled `out/main/index.js` has comments stripped. It contains the same code as the tag:
  - the pointer path ``(0,W.join)(e.dataRoot,`claude-profiles`,`selected-host`)``
  - `resumeOnSelectedAccount:!!t.replacesPtyId`
  - `async restartAgentPaneInPlace(e,t,n=()`
  - the stock exit expression `paneRespawning:i.paneRespawning===!0&&a?.connectionId==null`
  - `claimExit(e,r??a?.incarnationId).length>0`
  - the `reason:`lost`,cause:`it was closed in Orca`` worker-exit text
  - `reopensPane:!0` with `identity:{tabId:o,leafId:a.leafId}`

## How the stock switch works

### Choosing the account

**Desktop window (renderer).** After a Usage-menu selection,
`claude-account-switch-sessions.ts:66` queues restarts through
`terminal-restart-state.ts:47`. The queue holds `ptyId → 'claude' | 'codex'` and nothing else. Its
own comments say a queued restart "relaunches under whatever account is selected when it runs"
(`terminal-restart-state.ts:120`, `claude-account-switch-sessions.ts:143`).

**Headless host or panes no window holds (main).**
`claude-running-pane-account-move.ts:56` sends desktop hosts to the window. Elsewhere,
`moveRunningClaudePanes` calls `restartAgentPaneInPlace` (`:303`).

### Which account a spawn uses

There is no account parameter anywhere in the restart path. The account comes from the host
selection at the moment the spawn runs.

**Claude.**
1. Both spawn preflights call `withClaudeProfileTerminalEnv` (`runtime/spawn-preflight.ts:103`,
   `ipc/spawn-preflight.ts:119`). It writes the router's env over the caller's
   (`claude-profile-installed-router.ts:45`).
2. The router keeps one host-wide pointer file, `<data>/claude-profiles/selected-host`
   (`claude-profile-router.ts:74`). It names the host selection's folder (`:97`).
3. Orca's `claude` shell function re-reads that pointer on every launch
   (`claude-shell-function.ts:22`). A pane-level `CLAUDE_CONFIG_DIR` without Orca's injected
   marker overrides it (`:23`).

**Codex.** A spawn with `replacesPtyId` sets `resumeOnSelectedAccount`
(`spawn-env-codex.ts:27` → `spawn-host-env.ts:130`, `useSelectedAccount`). `CODEX_HOME` is then
the selected home (`assembly.ts:248`).

### Building the resume command

- `agent-account-restart-startup.ts:86` builds the plan with `buildAgentResumeStartupPlan`
  (`tui-agent-resume-startup.ts:19` → `agent-resume-argv.ts:9`). The probe prints
  `claude '--resume' 'sess-worker-1'` and `codex '-c' 'disable_paste_burst=true' 'resume' 'thread-1'`.
- Claude refuses when another pane holds the session (`:127`).
- Codex falls back to a fresh launch when it has no resume (`:135`).

### Replacing the terminal

**Main path (`restart-agent-pane-in-place.ts`):**
- a per-pane busy fence (`:57`)
- a resume claim on the conversation (`:79`)
- a "live in another pane" check before and after `stillCurrent` (`:88`)
- the stop is marked `'replaced'` (`:150`)
- the new terminal goes in the same `{ tabId, leafId }` with `reopensPane: true` (`:187`)

Its doc comment says the spawn "applies whatever account is selected now" (`:32`). The only account
"receipt" is inferred afterwards from the selection and an epoch counter
(`claude-running-pane-account-move.ts:317,325`). Nothing reads it from the process.

**Window path.** The renderer restart sends `replacesPtyId` (`use-pane-process-restart.ts:108,119`).
Main's `stopReplacedPanePty` marks the same `'replaced'` kind (`renderer-kill.ts:54`).

### Orchestration bindings

- On exit, every surface of the PTY goes to `failActiveDispatchOnExit`
  (`pty-exit-lifecycle.ts:311-313`). A Dispatch waits only when `paneRespawning` is set, which
  happens only on the daemon-crash path (`absent-pane-owner.ts:47`). An operator stop maps to
  `lost` / "it was closed in Orca" (`pty-exit-worker-observation.ts:120`), then `failDispatch`
  (`worker-exit-observation.ts:64`).
- The in-place hold already exists for daemon crashes: `holdInPlace` and `observePaneAgents`
  (`terminal-worker-restart-resume.ts:68,166`). It binds only the worker's own conversation in its
  own pane. `restartResumedCallerHandle` (`restart-resumed-caller.ts:45`) lets a worker that still
  uses its old `term_` handle act as the new one, but only in the restart-resume stages.
- When the incarnation changes, the replacement registers new handles
  (`pty-registration.ts:98`).

## What the probes show

Every result here comes from running real tagged source, not from reading it.

### Stock host

| Property | Result (stock) | Probe |
| --- | --- | --- |
| Effective account of the restarted pane | Whatever the host pointer names when `claude --resume` runs. With W's spawn env minted under `acct_a`, a switch to `acct_b` makes the restarted pane start with `acct_b`. Switching back before it runs makes it `acct_a`. | `stock-switch-semantics` PROBE A |
| Unrelated concurrent launch under the default | Also moves to `acct_b`. One pointer serves every pane, so the default changes for all later launches on the host. A process already running keeps the env it started with (`acct_a` at start and at exit). | PROBE A |
| Exact provider session | The command is exactly `claude --resume sess-worker-1`. Account folders link one shared `projects` folder (`mergeClaudeProfileDirectory` returned `linked` for both, `claude-profile-history.ts:16`). The transcript file written under `acct_a` can be read under `acct_b`. | PROBE A, B |
| Original worktree | The resume shell starts in the original worktree folder (fixture `cwd`). | PROBE A |
| Worker Dispatch and owner | The `'replaced'` exit takes the Dispatch from `dispatched` to `failed`. Its stage becomes `process_exited`, and the Run gets a `Worker exited without reporting` escalation. The pane gets a new `term_…` handle, the old `term_w` resolves to nothing, and the conversation reporting again doesn't rebind it. | `replaced-pane-orchestration`; `targeted-seam` SEAM B run against stock in step 2 |
| Coordinator Run | Stays bound to its handle and pane through a `'replaced'` exit. | `replaced-pane-orchestration` |
| Unrelated worker | Untouched. | both orchestration probes |
| Duplicate trigger | The renderer queue collapses duplicates (`{ "pty-w1": "claude" }`) and is consumed once. It still names no destination account. | `restart-queue` |
| 100% included with paid credits left | `rateLimitShowsRoom` returns true and `rateLimitSpentUntil` returns undefined. With overage off or empty, the window counts as spent until its reset. | PROBE C |

### With the seam applied

| Property | Result | Probe |
| --- | --- | --- |
| Effective account | `withClaudeProfileTerminalEnv` gets `ORCA_CLAUDE_PINNED_ACCOUNT_ID=acct_b`. It removes that marker and gives pane W its own pointer, `claude-profiles/pinned/acct_b`. W starts on `acct_b` before, during and after host selections a→b→a. | SEAM A |
| Unrelated concurrent launch | Follows the host default (a, b, a). The host pointer still names `acct_a`, so the pin changed no default. The pin marker never reaches the agent process. | SEAM A |
| Exact session and worktree | Argv `--resume sess-worker-1` and the original worktree as cwd. | SEAM A |
| Refusal | An unknown account or a WSL target throws (`claude_pinned_account_unknown`, `claude_pinned_account_unavailable`) instead of falling back to another account. | SEAM A |
| Worker Dispatch | The `'replaced'` exit no longer fails it: the status stays `dispatched` and no mail is sent. The stage is `restart_resumed` with Resume work on restart on, and `restart_offered` with it off. Another conversation reported in the pane is refused, and the assignee stays `term_w`. The worker's own `sess-worker-1` rebinds it to the pane's new handle and incarnation (`pty-w2:inc-w2`). The stale `term_w` caller resolves to the new handle. | SEAM B |
| Replay | A duplicate exit report and a duplicate hook report leave a single hold and a single bind. The unrelated worker's row is unchanged. | SEAM B |
| Dispatch without a recorded resume session | Still fails as on stock. The hold claims only a worker whose terminal resource records its conversation. In step 3 of `probe-output.txt`, the bare `createRootDispatch` worker of `replaced-pane-orchestration` still reaches `failed` with the seam applied. | `replaced-pane-orchestration` under the seam |
| Pin marker on stock | Without the seam, `ORCA_CLAUDE_PINNED_ACCOUNT_ID` passes straight through to the agent process (`pinReachedAgent: "acct_b"` in step 2). The seam removes it (`null`). | step 2 vs 3 |
| Regressions | 77 stock tests in 14 files pass around the patched code: the terminal exit and title tests, restart-resume, orchestration access, `claude-accounts` and `shared/agent-accounts`. `typecheck:node` and `typecheck:web` pass. | `run-probe.sh` steps 4–5 |

## What the fixtures do not prove

- **The account receipt.** The fixture's evidence of the account a process used is the fixture
  `claude` printing its `CLAUDE_CONFIG_DIR`. `resolveClaudePaneFolder` was called on synthetic
  transcript paths, so its `{ kind: 'account', accountId: 'acct_b' }` shows only how Orca would
  read a hook-reported path. It is not a receipt from a real Claude process. Stock Orca's own
  receipt (`restartedClaudePanes`) is computed from the selection, so it is stubbed by design. The
  seam adds no receipt either. A production operation should confirm the account from the new
  process's hook-reported transcript folder before it calls the move done.
- **Provider continuity.** No real Claude CLI ran. The probes show the exact argv and that the
  transcript file can be reached from the other account's folder. They don't show that the provider
  accepts the resume or keeps model, effort or tool state.
- **The PTY spawn.** No real spawn ran. The env pin follows a traced route:
  `restartAgentPaneInPlace` → `createRuntimeOwnedMobileSessionTerminal` → `terminal-create.ts:99`
  → spawn preflight. The probe exercised the preflight function, the router and the real shell
  function, but not a daemon spawn.
- **Desktop panes a window holds.** On a desktop, main leaves these to the renderer
  (`claude-running-pane-account-move.ts:56`). The seam doesn't cover the renderer path,
  `handleRestartPane`. Its startup already carries `env`
  (`agent-account-restart-startup.ts:34`), so the same marker could ride there, but that was not
  prototyped or run.
- **Codex.** Traced only. A targeted Codex move needs the same pin in place of `useSelectedAccount`
  (`spawn-host-env.ts:130`). It also has to refuse the fresh fallback (`:135`), or Codex continuity
  can't be shown.
- **Continue prompt and mid-turn effects.** After the rebind, the stock hold may send a continue
  prompt, depending on presence and Resume work on restart. The probe didn't exercise delivery.
  A restart mid-turn kills the process, so tool effects whose outcome is uncertain still need
  reconciling before any replay.
- **Lead bindings.** A lead's parent assignment, children, open questions and gates were not
  exercised. Only a worker's own Dispatch and a coordinator's Run were.
- **Scope of `'replaced'`.** Main and window restarts share this stop kind. The seam's Dispatch
  hold therefore applies to every in-place restart of a supervised pane, not just account moves.
  If a new process doesn't report the same conversation within the existing 120 s window, today's
  failure follows. A narrower version would mark a distinct kind.

## Stock plugin API, desktop UI and the host change

| Capability | Stock plugin API (Flow today) | Desktop UI (manual) | Local host change (seam) |
| --- | --- | --- | --- |
| Move one running pane to a chosen login | No. `agent.resume` takes workspace, agent and session. It calls `terminal.ensureAgentSession` (`plugin-host-agent-resume-binding.ts:69`), which adopts a live session instead of restarting it, and takes no account. `agent.launch.before` can add env, but resumes and restores are not hooked (`spawn-agent-launch-plugin-hook.ts:35`). A plugin can also only reach a home path by reading Orca's account folders, which Flow deliberately doesn't. | Only host-wide. Usage-menu selection, then Ask/Restart for running Claude terminals. Codex **Restart** chip. Native chat **Switch account**. Every later launch on the host moves. | Yes for Claude terminals on the main path. `restartAgentPaneInPlace(ptyId, session, stillCurrent, { accountId })` pins only that pane. |
| Keep the worker's Dispatch, owner and reply route | No operation exists to call. A host-wide switch followed by a restart fails the Dispatch. | Same failure. The window restart also marks `'replaced'`. | Yes for the worker's own Dispatch, through the stock in-place hold. |
| Leave other launches on the default | No. The only lever is `orca account select`. | No. | Yes (SEAM A). |
| Observe 100% included usage | Readings only. The host itself reads 100% with paid credits as room (PROBE C). | Meters only. | Unchanged. The seam doesn't touch readings. |

Workspace eligibility stays in Flow. The seam takes an Orca managed account ID that Flow has already
chosen from its own eligibility and exclusions (`src/accounts.ts`, `src/settings.ts`). Orca still
owns homes, authentication and the spawn. Flow never sees a home path.

## Holding the next billable request

The trigger in question: included usage at 100% while paid credits remain.

- **CLI terminal sessions: no host gate per request.** The provider CLI sends its own requests from
  inside the PTY.
  - `agent.prompt.before` hooks only prompts Orca submits (launch, orchestration,
    `terminal.send`). "A prompt a person submits is never hooked" (`plugin-hook-payloads.ts:167`).
  - `agent.tool.before` can deny a Claude tool call (`:175`). The denial still goes back to the
    model as another request, so it can't stop billing. For other agents that hook only reports.
  - The best a host can do is act between turns: switch or pause before it submits the next prompt
    itself. A person typing into the pane gets past that. Whether Orca's Claude hook listener could
    block `UserPromptSubmit` was not verified.
- **Structured sessions: a gate per turn, not per request.** The host writes each user turn into
  the stream. `UsageLimitAccountHolds` already holds a due continuation send for a fresh reading
  (`structured-agent-session-usage-limit-account-hold.ts:47`). It decides with
  `rateLimitSpentUntil`, which ignores 100% while paid credits remain
  (`rate-limit-spent-windows.ts:20`). So it would let the send go to paid usage. A host change
  could hold or switch at that boundary with an "included usage spent" predicate. The tool loop
  inside a turn still bills.
- **What only the provider can enforce.** A real "no paid request" guarantee needs the provider
  account or team spending cap. The host can't intercept a request already in flight.
  `docs/account-failover.md` already states this boundary.

## Commands run

All commands ran on 2026-11-24 with Node 26.13.1 and pnpm 12.18.0 (the version the checkout pins).

```sh
git ls-remote https://github.com/stablyai/orca refs/tags/v1.4.272   # 0b3df86f… (tag object)
git clone --depth 1 --branch v1.4.272 https://github.com/stablyai/orca ~/orca/research/orca-v1.4.272-switch-probe
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --ignore-scripts && pnpm run build:packages
npx vitest run --config config/vitest.config.ts --silent=false src/main/account-switch-probe src/renderer/src/account-switch-probe
pnpm run typecheck:node && pnpm run typecheck:web
asar extract /Applications/Orca.app/Contents/Resources/app.asar <scratch>   # read-only, bundle fragments
node docs/account-switch-host-probe/installed-source-match.cjs <checkout> <3 shared modules>
PROBE_TYPECHECK=1 docs/account-switch-host-probe/run-probe.sh ~/orca/research/orca-v1.4.272-switch-probe-repro   # fresh clone → probe-output.txt
```
